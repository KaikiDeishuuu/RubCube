import type { CommitBatch, MoveOrigin } from '@rubcube/cube-render/transport';

/**
 * Turn sounds, synthesised rather than sampled.
 *
 * A cube's clack is a broadband transient: a noise burst shaped by two
 * resonances — the sharp plastic click and the lower body thunk — under a fast
 * decay. That is six Web Audio nodes and zero asset bytes, which matters for a
 * static deploy: no fetch, no decode, and no cache policy for one 40ms sound.
 *
 * `<audio>` elements are not an option at this density. A queued turn is 54ms
 * (DESIGN.md 4.3), so a 25-move scramble asks for ~18 sounds per second, and a
 * single element can neither overlap itself nor start that promptly.
 */

/** Peak resonances of the two bands, in Hz. */
const CLICK_FREQUENCY = 2_400;
const BODY_FREQUENCY = 190;
const CLICK_Q = 1.4;
const BODY_Q = 2.2;

/** Envelope decay per band, in seconds. The click leads, the body rings on. */
const CLICK_DECAY = 0.05;
const BODY_DECAY = 0.1;
const CLICK_PEAK = 1;
const BODY_PEAK = 0.55;

/** exponentialRampToValueAtTime cannot target zero. */
const SILENCE = 0.0001;

/** Source buffer length. Only the envelope's leading edge is ever audible. */
const NOISE_SECONDS = 0.12;

/**
 * Per-voice pitch and level jitter.
 *
 * Without it every turn is the same 40ms sample and a scramble sounds like a
 * machine gun rather than a cube. A real one never clacks twice alike.
 */
const DETUNE_SPREAD = 0.12;
const LEVEL_SPREAD = 0.1;

/**
 * Floor on the gap between voices, in seconds.
 *
 * Two paths commit faster than turns can be told apart: reduced motion collapses
 * every turn to a zero-length animation and commits one per rendered frame
 * (~16ms), and the 2D fallback commits one per macrotask with no animation at
 * all. Both are below the rate at which separate clacks stay legible, so the
 * overflow is dropped rather than layered. The queued animation cadence is
 * 54ms at its fastest (DESIGN.md 4.3), so nothing an animation shows is lost.
 */
const MIN_INTERVAL_SECONDS = 0.03;

/**
 * Level per provenance.
 *
 * A scramble is a 25-move burst the player did not perform, so it sits well
 * back; a drag is the one turn they are physically doing, so it leads.
 */
const ORIGIN_GAIN: Readonly<Record<MoveOrigin, number>> = Object.freeze({
  drag: 1,
  manual: 1,
  formula: 0.9,
  tutorial: 0.8,
  'auto-solve': 0.7,
  history: 0.75,
  scramble: 0.5,
});

/**
 * Level bump when an animation group commits two layers at once.
 *
 * Two layers seating simultaneously is one louder event, not two clacks: the
 * ear cannot separate them, and playing two voices only sounds like clipping.
 */
const CONCURRENT_GAIN = 1.15;

/**
 * Master level.
 *
 * Measured, not guessed: rendering a drag-level voice offline peaks at 0.402 of
 * this value once the two bandpasses have taken their share, so 0.55 puts a
 * turn at roughly -13 dBFS — present, and still well under the level a UI
 * sound has to sit at to avoid being the loudest thing on the page.
 */
const DEFAULT_VOLUME = 0.55;

export interface TurnAudioOptions {
  /** Test seam; production constructs a real AudioContext on first unlock. */
  readonly createContext?: () => AudioContext;
  readonly muted?: boolean;
  readonly volume?: number;
}

type AudioContextConstructor = new () => AudioContext;

function defaultCreateContext(): AudioContext {
  const globalWithAudio = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor =
    globalWithAudio.AudioContext ?? globalWithAudio.webkitAudioContext;
  if (Constructor === undefined) {
    throw new Error('Web Audio is unavailable in this browser');
  }
  return new Constructor();
}

function jitter(spread: number): number {
  return 1 + (Math.random() * 2 - 1) * spread;
}

/** The origin and layer count of a batch, or null when nothing turned. */
function describeBatch(
  batch: CommitBatch,
): { readonly origin: MoveOrigin; readonly layers: number } | null {
  let origin: MoveOrigin | null = null;
  let layers = 0;
  for (const change of batch.changes) {
    // A replace snapshot carries move: null. Loading a checkpoint or resetting
    // to solved rearranges the cube without anything having been turned.
    if (change.move === null) continue;
    origin = change.provenance.origin;
    layers += 1;
  }
  return origin === null ? null : { origin, layers };
}

export class TurnAudio {
  private readonly createContext: () => AudioContext;
  private readonly volume: number;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastVoiceTime = Number.NEGATIVE_INFINITY;
  private mutedFlag: boolean;
  private disposed = false;

  constructor(options: TurnAudioOptions = {}) {
    this.createContext = options.createContext ?? defaultCreateContext;
    this.volume = options.volume ?? DEFAULT_VOLUME;
    this.mutedFlag = options.muted ?? false;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  setMuted(muted: boolean): void {
    this.mutedFlag = muted;
    if (!muted) {
      this.unlock();
      return;
    }
    // Suspending releases the output device rather than leaving a running
    // context idling for a player who has said they want silence. Unmuting
    // resumes the same context, so nothing is rebuilt.
    const context = this.context;
    if (context === null || context.state !== 'running') return;
    void context.suspend().catch(() => undefined);
  }

  /**
   * Create or resume the context. Must be reached from a user gesture.
   *
   * Autoplay policy starts every AudioContext suspended, and a context created
   * outside a gesture stays that way. Constructing it lazily here means a
   * player who never touches the cube never pays for an audio device at all.
   */
  unlock(): void {
    if (this.disposed || this.mutedFlag) return;
    const context = this.ensureContext();
    if (context === null) return;
    if (context.state === 'suspended') {
      // Rejection means the call did not come from a qualifying gesture. The
      // next one will; a failed unlock must not surface as an error.
      void context.resume().catch(() => undefined);
    }
  }

  /** One clack per committed animation group. */
  playBatch(batch: CommitBatch): void {
    if (this.disposed || this.mutedFlag) return;
    const described = describeBatch(batch);
    if (described === null) return;

    const context = this.context;
    const master = this.master;
    const noise = this.noise;
    // Staying silent until a gesture has unlocked the context is deliberate:
    // creating one here would produce a suspended context whose queued voices
    // all fire at once the moment it later resumes.
    if (context === null || master === null || noise === null) return;
    if (context.state !== 'running') return;

    const start = context.currentTime;
    if (start - this.lastVoiceTime < MIN_INTERVAL_SECONDS) return;
    this.lastVoiceTime = start;

    const level =
      (ORIGIN_GAIN[described.origin] ?? 0.8) *
      (described.layers > 1 ? CONCURRENT_GAIN : 1) *
      jitter(LEVEL_SPREAD);

    this.playVoice(context, master, noise, start, level);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noise = null;
    if (context === null) return;
    try {
      void context.close();
    } catch {
      // A context already closed by the page lifecycle is not a failure worth
      // propagating out of teardown.
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context !== null) return this.context;
    let context: AudioContext;
    try {
      context = this.createContext();
    } catch {
      // No Web Audio, or the device refused one. Sound is an enhancement, so
      // the app keeps working silently rather than reporting a failure.
      return null;
    }

    const master = context.createGain();
    master.gain.value = this.volume;
    master.connect(context.destination);

    const frames = Math.max(1, Math.ceil(context.sampleRate * NOISE_SECONDS));
    const noise = context.createBuffer(1, frames, context.sampleRate);
    const channel = noise.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }

    this.context = context;
    this.master = master;
    this.noise = noise;
    return context;
  }

  private playVoice(
    context: AudioContext,
    master: GainNode,
    noise: AudioBuffer,
    start: number,
    level: number,
  ): void {
    const source = context.createBufferSource();
    source.buffer = noise;

    const voice = context.createGain();
    voice.gain.value = level;
    voice.connect(master);

    const pitch = jitter(DETUNE_SPREAD);
    this.band(
      context,
      source,
      voice,
      CLICK_FREQUENCY * pitch,
      CLICK_Q,
      CLICK_PEAK,
      CLICK_DECAY,
      start,
    );
    this.band(
      context,
      source,
      voice,
      BODY_FREQUENCY * pitch,
      BODY_Q,
      BODY_PEAK,
      BODY_DECAY,
      start,
    );

    const tail = Math.max(CLICK_DECAY, BODY_DECAY);
    source.onended = () => {
      // Detaching the voice from master orphans the whole subgraph above it,
      // so one handler is enough to let six nodes per turn be collected.
      voice.disconnect();
    };
    source.start(start);
    source.stop(start + tail);
  }

  private band(
    context: AudioContext,
    source: AudioBufferSourceNode,
    voice: GainNode,
    frequency: number,
    q: number,
    peak: number,
    decay: number,
    start: number,
  ): void {
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(peak, start);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, start + decay);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(voice);
  }
}
