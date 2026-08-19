/**
 * WCA-shaped solve timer, as a pure state machine.
 *
 * No clock of its own: every transition takes the caller's timestamp. The
 * source of truth is `performance.now()` read at the event that caused the
 * transition — a commit, a key edge — while the display samples it from rAF.
 * Deriving elapsed time from the frame timestamp instead would quantise every
 * result to the refresh interval and drift with a dropped frame.
 *
 * DESIGN.md 5.2 stops the timer on any key, which is the rule for a physical
 * timer where the keyboard is the timer. Here the keyboard turns the cube, so
 * that rule would make the first move of a solve stop the clock. The stop
 * condition is the cube reaching a solved state instead, which `isSolved`
 * judges free of orientation: a solve that ends rotated still counts.
 */

export const TIMER_PHASES = Object.freeze([
  'idle',
  'inspecting',
  'holding',
  'armed',
  'running',
  'stopped',
] as const);

export type TimerPhase = (typeof TIMER_PHASES)[number];

export const PENALTIES = Object.freeze(['none', 'plus2', 'dnf'] as const);

export type Penalty = (typeof PENALTIES)[number];

export interface TimerConfig {
  /** How long the hold must last before a solve may start. */
  readonly holdMs: number;
  readonly inspection: boolean;
  readonly inspectionMs: number;
  /** Seconds past inspection that cost +2 before the attempt becomes a DNF. */
  readonly inspectionGraceMs: number;
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = Object.freeze({
  holdMs: 550,
  inspection: false,
  inspectionMs: 15_000,
  inspectionGraceMs: 2_000,
});

export interface TimerState {
  readonly phase: TimerPhase;
  readonly holdStartedAt: number | null;
  readonly inspectionStartedAt: number | null;
  readonly runStartedAt: number | null;
  readonly stoppedAt: number | null;
  readonly penalty: Penalty;
}

export const IDLE_TIMER: TimerState = Object.freeze({
  phase: 'idle',
  holdStartedAt: null,
  inspectionStartedAt: null,
  runStartedAt: null,
  stoppedAt: null,
  penalty: 'none',
});

export type TimerEvent =
  | { readonly type: 'hold-start'; readonly at: number }
  | { readonly type: 'hold-end'; readonly at: number }
  /** Advances phases that depend only on the passage of time. */
  | { readonly type: 'tick'; readonly at: number }
  | { readonly type: 'solved'; readonly at: number }
  /** Gives up on the attempt: a pop, a misscramble, a change of mind. */
  | { readonly type: 'abort'; readonly at: number }
  | { readonly type: 'reset'; readonly at: number };

function assertTimestamp(at: number): void {
  if (!Number.isFinite(at)) {
    throw new TypeError('Timer events need a finite timestamp');
  }
}

/** The penalty a solve starting now would carry, from its inspection length. */
function inspectionPenalty(
  state: TimerState,
  at: number,
  config: TimerConfig,
): Penalty {
  if (state.inspectionStartedAt === null) return 'none';
  const elapsed = at - state.inspectionStartedAt;
  if (elapsed > config.inspectionMs + config.inspectionGraceMs) return 'dnf';
  if (elapsed > config.inspectionMs) return 'plus2';
  return 'none';
}

function begin(state: TimerState, at: number, config: TimerConfig): TimerState {
  if (!config.inspection) {
    return { ...IDLE_TIMER, phase: 'holding', holdStartedAt: at };
  }
  return { ...IDLE_TIMER, phase: 'inspecting', inspectionStartedAt: at };
}

export function reduceTimer(
  state: TimerState,
  event: TimerEvent,
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
): TimerState {
  assertTimestamp(event.at);

  if (event.type === 'reset') return IDLE_TIMER;

  if (event.type === 'abort') {
    // Only a live attempt can be abandoned. Aborting from idle would otherwise
    // manufacture a DNF for a solve that was never started.
    if (state.phase === 'idle' || state.phase === 'stopped') return state;
    if (state.phase !== 'running') return IDLE_TIMER;
    return {
      ...state,
      phase: 'stopped',
      stoppedAt: event.at,
      penalty: 'dnf',
    };
  }

  switch (state.phase) {
    case 'idle':
    case 'stopped':
      if (event.type === 'hold-start') return begin(state, event.at, config);
      return state;

    case 'inspecting':
      // Only a fresh press advances. The release of the press that opened
      // inspection lands here too, and ignoring every hold-end is exactly what
      // makes it harmless: a charge is only ever started by a hold-start.
      if (event.type === 'hold-start') {
        return { ...state, phase: 'holding', holdStartedAt: event.at };
      }
      return state;

    case 'holding': {
      if (event.type === 'hold-end') {
        // Released before the charge completed. Inspection, if any, keeps
        // running: a false start does not buy more time to look at the cube.
        return state.inspectionStartedAt === null
          ? IDLE_TIMER
          : { ...state, phase: 'inspecting', holdStartedAt: null };
      }
      if (event.type !== 'tick') return state;
      const held = state.holdStartedAt === null ? 0 : event.at - state.holdStartedAt;
      return held >= config.holdMs ? { ...state, phase: 'armed' } : state;
    }

    case 'armed':
      if (event.type === 'hold-end') {
        return {
          ...IDLE_TIMER,
          phase: 'running',
          runStartedAt: event.at,
          penalty: inspectionPenalty(state, event.at, config),
        };
      }
      return state;

    case 'running':
      if (event.type === 'solved') {
        return { ...state, phase: 'stopped', stoppedAt: event.at };
      }
      return state;

    default: {
      const exhaustive: never = state.phase;
      throw new Error(`Unhandled timer phase ${String(exhaustive)}`);
    }
  }
}

/** Raw solve length, before any penalty. Null until an attempt has run. */
export function rawDurationMs(state: TimerState): number | null {
  if (state.runStartedAt === null) return null;
  if (state.stoppedAt === null) return null;
  return Math.max(0, state.stoppedAt - state.runStartedAt);
}

/**
 * What the readout should show.
 *
 * A discriminated shape rather than one number: inspection counts down and a
 * solve counts up, and collapsing both into "milliseconds" leaves the caller
 * guessing which direction it is looking at.
 */
export type TimerReadout =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'inspection';
      /** Negative once inspection has overrun; the penalty says by how much. */
      readonly remainingMs: number;
      readonly penalty: Penalty;
    }
  | { readonly kind: 'running'; readonly elapsedMs: number }
  | { readonly kind: 'result'; readonly rawMs: number; readonly penalty: Penalty };

export function readTimer(
  state: TimerState,
  now: number,
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
): TimerReadout {
  switch (state.phase) {
    case 'inspecting':
    case 'holding':
    case 'armed': {
      if (state.inspectionStartedAt === null) return { kind: 'idle' };
      return {
        kind: 'inspection',
        remainingMs: config.inspectionMs - (now - state.inspectionStartedAt),
        // Reported live so the readout can warn before the cost is locked in,
        // rather than only revealing it once the solve has already started.
        penalty: inspectionPenalty(state, now, config),
      };
    }
    case 'running':
      return {
        kind: 'running',
        elapsedMs:
          state.runStartedAt === null ? 0 : Math.max(0, now - state.runStartedAt),
      };
    case 'stopped':
      return { kind: 'result', rawMs: rawDurationMs(state) ?? 0, penalty: state.penalty };
    default:
      return { kind: 'idle' };
  }
}

/** True once the hold has charged long enough for a release to start a solve. */
export function isArmed(state: TimerState): boolean {
  return state.phase === 'armed';
}

/** Effective time including penalty, or null for a DNF. */
export function effectiveMs(raw: number, penalty: Penalty): number | null {
  if (penalty === 'dnf') return null;
  return penalty === 'plus2' ? raw + 2_000 : raw;
}

const MS_PER_MINUTE = 60_000;

/** csTimer's rendering: seconds under a minute, m:ss.SS above it. */
export function formatMs(value: number): string {
  const total = Math.max(0, Math.round(value));
  const centis = Math.floor((total % 1_000) / 10);
  const seconds = Math.floor(total / 1_000) % 60;
  const minutes = Math.floor(total / MS_PER_MINUTE);
  const fraction = centis.toString().padStart(2, '0');
  if (minutes === 0) return `${seconds}.${fraction}`;
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${fraction}`;
}

/** How a finished attempt reads, penalty included. */
export function formatResult(raw: number, penalty: Penalty): string {
  if (penalty === 'dnf') return `DNF(${formatMs(raw)})`;
  const effective = effectiveMs(raw, penalty);
  return penalty === 'plus2'
    ? `${formatMs(effective ?? raw)}+`
    : formatMs(effective ?? raw);
}
