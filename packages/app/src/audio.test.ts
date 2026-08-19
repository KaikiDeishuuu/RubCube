import { createSolvedState, type CubeState } from '@rubcube/cube-core';
import type {
  CommitBatch,
  CubeStateChange,
  MoveOrigin,
} from '@rubcube/cube-render/transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TurnAudio } from './audio.js';

/**
 * The smallest Web Audio graph the module actually drives.
 *
 * Nodes record who they were connected to rather than only that they were
 * created, because the assertions that matter are about level: the per-voice
 * gain is identified as the one node wired into master, not by creation order.
 */
interface FakeParam {
  value: number;
  readonly ramps: number[];
  setValueAtTime(next: number): FakeParam;
  exponentialRampToValueAtTime(next: number): FakeParam;
}

function createParam(value = 1): FakeParam {
  const param: FakeParam = {
    value,
    ramps: [],
    setValueAtTime(next) {
      param.value = next;
      return param;
    },
    exponentialRampToValueAtTime(next) {
      param.ramps.push(next);
      return param;
    },
  };
  return param;
}

interface FakeNode {
  outputs: FakeNode[];
  disconnected: boolean;
  connect(target: FakeNode): FakeNode;
  disconnect(): void;
}

interface FakeGain extends FakeNode {
  readonly gain: FakeParam;
}

interface FakeFilter extends FakeNode {
  type: string;
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
}

interface FakeSource extends FakeNode {
  buffer: unknown;
  onended: (() => void) | null;
  started: number | null;
  stopped: number | null;
  start(when: number): void;
  stop(when: number): void;
}

/**
 * Graph bookkeeping, mixed into an object the caller already owns.
 *
 * The methods close over `self`, so they must be installed on the final object
 * rather than spread off a shared base: a spread copy would keep routing into
 * the original's `outputs` and every voice would look connected to nothing.
 */
function connectable<T extends object>(self: T): T & FakeNode {
  const node = self as T & FakeNode;
  node.outputs = [];
  node.disconnected = false;
  node.connect = (target) => {
    node.outputs.push(target);
    return target;
  };
  node.disconnect = () => {
    node.disconnected = true;
  };
  return node;
}

class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 48_000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination: FakeNode = connectable({});
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  readonly filters: FakeFilter[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;

  /**
   * Both transitions settle a microtask later, as the real ones do. Flipping
   * `state` synchronously would hide the window in which a context has been
   * asked to change but has not yet changed — the window the muted flag and the
   * running-state guard both exist to cover.
   */
  resume(): Promise<void> {
    this.resumeCalls += 1;
    return Promise.resolve().then(() => {
      if (this.state === 'suspended') this.state = 'running';
    });
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    return Promise.resolve().then(() => {
      if (this.state === 'running') this.state = 'suspended';
    });
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    return Promise.resolve();
  }

  createGain(): FakeGain {
    const gain = connectable({ gain: createParam() });
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter(): FakeFilter {
    const filter = connectable({
      type: 'lowpass',
      frequency: createParam(350),
      Q: createParam(1),
    });
    this.filters.push(filter);
    return filter;
  }

  createBufferSource(): FakeSource {
    const source = connectable({
      buffer: null as unknown,
      onended: null as (() => void) | null,
      started: null as number | null,
      stopped: null as number | null,
      start(when: number) {
        source.started = when;
      },
      stop(when: number) {
        source.stopped = when;
      },
    });
    this.sources.push(source);
    return source;
  }

  createBuffer(
    channels: number,
    length: number,
  ): { getChannelData(): Float32Array } {
    const data = new Float32Array(length * channels);
    return { getChannelData: () => data };
  }

  /** The master gain is the only node wired straight to the destination. */
  get master(): FakeGain | undefined {
    return this.gains.find((gain) => gain.outputs.includes(this.destination));
  }

  /** One entry per audible turn: the voice gains feeding master. */
  get voiceLevels(): number[] {
    const master = this.master;
    if (master === undefined) return [];
    return this.gains
      .filter((gain) => gain !== master && gain.outputs.includes(master))
      .map((gain) => gain.gain.value);
  }
}

const SOLVED: CubeState = createSolvedState();

function moveChange(origin: MoveOrigin): CubeStateChange {
  return {
    state: SOLVED,
    move: { face: 'R', turns: 1 },
    provenance:
      origin === 'history'
        ? { commandId: 'c', intent: 'undo', origin: 'history' }
        : { commandId: 'c', intent: 'forward', origin },
  } as CubeStateChange;
}

function batch(...origins: readonly MoveOrigin[]): CommitBatch {
  return {
    batchId: 1,
    changes: origins.map(moveChange),
    finalState: SOLVED,
  };
}

const REPLACE_BATCH: CommitBatch = {
  batchId: 2,
  changes: [{ state: SOLVED, move: null }],
  finalState: SOLVED,
};

function setup(muted = false): {
  audio: TurnAudio;
  context: FakeAudioContext;
  createContext: ReturnType<typeof vi.fn>;
} {
  const context = new FakeAudioContext();
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const audio = new TurnAudio({ createContext, muted });
  return { audio, context, createContext };
}

/** Lets a pending resume/suspend settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Neutralises the per-voice jitter so levels are exactly the tabled values. */
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TurnAudio', () => {
  it('opens no audio device until a gesture unlocks it', () => {
    const { audio, createContext } = setup();
    audio.playBatch(batch('drag'));
    expect(createContext).not.toHaveBeenCalled();
  });

  it('stays silent while a context has been asked to resume but has not', () => {
    const { audio, context } = setup();
    audio.unlock();
    // Scheduling a voice here would not play early, it would play late: every
    // voice queued against a suspended context fires the instant it resumes.
    audio.playBatch(batch('drag'));
    expect(context.state).toBe('suspended');
    expect(context.voiceLevels).toEqual([]);
  });

  it('stays silent when the gesture never qualified', async () => {
    const context = new FakeAudioContext();
    // A resume that leaves the context suspended is what an unqualified gesture
    // produces: no error, no sound, and the next real gesture tries again.
    context.resume = () => Promise.resolve();
    const audio = new TurnAudio({
      createContext: () => context as unknown as AudioContext,
    });
    audio.unlock();
    await flush();
    audio.playBatch(batch('drag'));
    expect(context.voiceLevels).toEqual([]);
  });

  it('resumes a suspended context on unlock and then plays', async () => {
    const { audio, context } = setup();
    audio.unlock();
    expect(context.resumeCalls).toBe(1);
    await flush();
    expect(context.state).toBe('running');

    audio.playBatch(batch('drag'));
    expect(context.voiceLevels).toHaveLength(1);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.started).toBe(0);
  });

  it('creates no device at all while muted', () => {
    const { audio, createContext } = setup(true);
    audio.unlock();
    audio.playBatch(batch('drag'));
    expect(createContext).not.toHaveBeenCalled();
  });

  it('unmuting unlocks, because the toggle click is itself the gesture', async () => {
    const { audio, context } = setup(true);
    audio.setMuted(false);
    await flush();
    expect(context.state).toBe('running');
    audio.playBatch(batch('drag'));
    expect(context.voiceLevels).toHaveLength(1);
  });

  it('goes quiet when muted mid-session and releases the device', async () => {
    const { audio, context } = setup();
    audio.unlock();
    await flush();
    audio.playBatch(batch('drag'));
    expect(context.voiceLevels).toHaveLength(1);

    // The context is already running here, so muting has to be checked on the
    // play path as well; suspending alone would still let a queued voice through
    // on a context that has not yet reached the suspended state.
    // The suspend has not settled yet, so the context is still running here:
    // only the muted flag can keep this turn silent.
    audio.setMuted(true);
    context.currentTime = 1;
    audio.playBatch(batch('drag'));
    expect(context.state).toBe('running');
    expect(context.voiceLevels).toHaveLength(1);
    await flush();
    expect(context.suspendCalls).toBe(1);
    expect(context.state).toBe('suspended');

    audio.setMuted(false);
    await flush();
    context.currentTime = 2;
    audio.playBatch(batch('drag'));
    expect(context.voiceLevels).toHaveLength(2);
  });

  it('stays silent for a replace snapshot', async () => {
    const { audio, context } = setup();
    audio.unlock();
    await flush();
    // Resetting to solved or loading a checkpoint rearranges the cube without
    // anything having been turned, so there is nothing to hear.
    audio.playBatch(REPLACE_BATCH);
    expect(context.voiceLevels).toEqual([]);
  });

  it('plays one louder voice for a concurrent pair, not two voices', async () => {
    const { audio, context } = setup();
    audio.unlock();
    await flush();
    audio.playBatch(batch('drag', 'drag'));

    const [pair] = context.voiceLevels;
    expect(context.voiceLevels).toHaveLength(1);

    context.currentTime = 1;
    audio.playBatch(batch('drag'));
    const [, single] = context.voiceLevels;
    expect(pair).toBeGreaterThan(single ?? 0);
  });

  it('places a scramble behind a drag', async () => {
    const { audio, context } = setup();
    audio.unlock();
    await flush();
    audio.playBatch(batch('drag'));
    context.currentTime = 1;
    audio.playBatch(batch('scramble'));

    const [drag, scramble] = context.voiceLevels;
    expect(scramble).toBeLessThan(drag ?? 0);
  });

  it('drops voices that arrive faster than they can be told apart', async () => {
    const { audio, context } = setup();
    audio.unlock();
    await flush();
    // Reduced motion commits one turn per rendered frame, which is ~16ms.
    audio.playBatch(batch('formula'));
    context.currentTime = 0.016;
    audio.playBatch(batch('formula'));
    expect(context.voiceLevels).toHaveLength(1);

    context.currentTime = 0.05;
    audio.playBatch(batch('formula'));
    expect(context.voiceLevels).toHaveLength(2);
  });

  it('detaches a finished voice from master', async () => {
    const { audio, context } = setup();
    audio.unlock();
    await flush();
    audio.playBatch(batch('manual'));

    const source = context.sources[0];
    expect(source?.stopped).toBeGreaterThan(source?.started ?? 0);
    source?.onended?.();
    const master = context.master;
    const voice = context.gains.find(
      (gain) => gain !== master && master !== undefined && gain.outputs.includes(master),
    );
    expect(voice?.disconnected).toBe(true);
  });

  it('closes the device on dispose and stays silent afterwards', async () => {
    const { audio, context, createContext } = setup();
    audio.unlock();
    await flush();
    audio.dispose();
    expect(context.closeCalls).toBe(1);

    audio.dispose();
    expect(context.closeCalls).toBe(1);

    context.currentTime = 5;
    audio.playBatch(batch('drag'));
    expect(context.voiceLevels).toEqual([]);

    // A late gesture must not resurrect a disposed instance: the listeners are
    // removed in the same cleanup, but a queued event can still land after it,
    // and building a second device there would leak one per remount.
    audio.unlock();
    audio.setMuted(false);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('survives a browser that refuses to build a context', () => {
    const audio = new TurnAudio({
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    expect(() => audio.unlock()).not.toThrow();
    expect(() => audio.playBatch(batch('drag'))).not.toThrow();
  });
});
