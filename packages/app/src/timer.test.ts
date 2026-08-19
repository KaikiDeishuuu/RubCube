import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMER_CONFIG,
  IDLE_TIMER,
  PENALTIES,
  TIMER_PHASES,
  effectiveMs,
  formatMs,
  formatResult,
  isArmed,
  rawDurationMs,
  readTimer,
  reduceTimer,
  type Penalty,
  type TimerConfig,
  type TimerEvent,
  type TimerPhase,
  type TimerState,
} from './timer.js';

const WITH_INSPECTION: TimerConfig = { ...DEFAULT_TIMER_CONFIG, inspection: true };

/** Feeds a script of events, so a test reads as the gesture it describes. */
function play(
  events: readonly TimerEvent[],
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
  from: TimerState = IDLE_TIMER,
): TimerState {
  return events.reduce((state, event) => reduceTimer(state, event, config), from);
}

const hold = (at: number): TimerEvent => ({ type: 'hold-start', at });
const release = (at: number): TimerEvent => ({ type: 'hold-end', at });
const tick = (at: number): TimerEvent => ({ type: 'tick', at });

/** The shortest script that reaches a running solve, starting at `at`. */
function startSolve(at: number): readonly TimerEvent[] {
  return [hold(at), tick(at + DEFAULT_TIMER_CONFIG.holdMs), release(at + 600)];
}

describe('hold to start', () => {
  it('will not start from a press alone', () => {
    // The whole point of the hold is that a stray keypress cannot start a solve.
    expect(play([hold(0), release(10)]).phase).toBe('idle');
  });

  it('stays uncharged until the hold has lasted long enough', () => {
    const nearly = play([hold(0), tick(DEFAULT_TIMER_CONFIG.holdMs - 1)]);
    expect(nearly.phase).toBe('holding');
    expect(isArmed(nearly)).toBe(false);

    const charged = reduceTimer(nearly, tick(DEFAULT_TIMER_CONFIG.holdMs));
    expect(charged.phase).toBe('armed');
    expect(isArmed(charged)).toBe(true);
  });

  it('starts the solve on release, not on the charge', () => {
    const armed = play([hold(0), tick(600)]);
    expect(armed.runStartedAt).toBeNull();

    const running = reduceTimer(armed, release(742));
    expect(running.phase).toBe('running');
    // The clock starts when the hands leave, which is the release.
    expect(running.runStartedAt).toBe(742);
    // A running attempt anchors on nothing but its own start: leftover hold and
    // inspection anchors are what a later attempt would read by mistake.
    expect(running.holdStartedAt).toBeNull();
    expect(running.inspectionStartedAt).toBeNull();
    expect(running.stoppedAt).toBeNull();
  });

  it('drops the charge when released early', () => {
    expect(play([hold(0), tick(400), release(410)])).toEqual(IDLE_TIMER);
  });
});

describe('stopping', () => {
  it('stops when the cube is solved', () => {
    const stopped = play([...startSolve(0), { type: 'solved', at: 12_340 }]);
    expect(stopped.phase).toBe('stopped');
    expect(rawDurationMs(stopped)).toBe(12_340 - 600);
    expect(stopped.penalty).toBe('none');
  });

  it('ignores a solved cube outside a running attempt', () => {
    // Loading a solved checkpoint, or resetting, must not record an attempt.
    for (const state of [IDLE_TIMER, play([hold(0), tick(600)])]) {
      expect(reduceTimer(state, { type: 'solved', at: 9_000 }).phase).not.toBe('stopped');
    }
  });

  it('records an abort as a DNF with the time it had reached', () => {
    const aborted = play([...startSolve(0), { type: 'abort', at: 8_000 }]);
    expect(aborted.phase).toBe('stopped');
    expect(aborted.penalty).toBe('dnf');
    expect(rawDurationMs(aborted)).toBe(7_400);
  });

  it('abandons a charge without inventing a result', () => {
    // Abort during the hold means "never mind", not "I failed a solve".
    expect(play([hold(0), tick(600), { type: 'abort', at: 700 }])).toEqual(IDLE_TIMER);
    expect(reduceTimer(IDLE_TIMER, { type: 'abort', at: 1 })).toBe(IDLE_TIMER);
  });

  it('leaves a finished attempt alone, by identity', () => {
    const stopped = play([...startSolve(0), { type: 'solved', at: 5_000 }]);
    for (const event of [{ type: 'solved', at: 9_000 }, { type: 'abort', at: 9_000 }] as const) {
      // Identity, not equality: the store tells "nothing happened" from "the
      // same thing happened again" by comparing the returned object, and that
      // is what stops a repeated solved event recording the solve twice.
      expect(reduceTimer(stopped, event)).toBe(stopped);
    }
  });

  it('starts the next attempt straight from a finished one', () => {
    const stopped = play([...startSolve(0), { type: 'solved', at: 5_000 }]);
    const next = play(startSolve(6_000), DEFAULT_TIMER_CONFIG, stopped);
    expect(next.phase).toBe('running');
    expect(next.runStartedAt).toBe(6_600);
    // Nothing of the previous attempt may leak into this one's result.
    expect(next.stoppedAt).toBeNull();
    expect(next.penalty).toBe('none');
  });
});

describe('inspection', () => {
  it('opens on the press and does not read that press as a start', () => {
    const opened = play([hold(0)], WITH_INSPECTION);
    expect(opened.phase).toBe('inspecting');
    expect(opened.inspectionStartedAt).toBe(0);

    // Releasing the press that opened inspection must not start the solve.
    const released = reduceTimer(opened, release(90), WITH_INSPECTION);
    expect(released.phase).toBe('inspecting');
    expect(released.runStartedAt).toBeNull();
  });

  it('charges on a second hold and starts on its release', () => {
    const running = play(
      [hold(0), release(90), hold(3_000), tick(3_600), release(3_650)],
      WITH_INSPECTION,
    );
    expect(running.phase).toBe('running');
    expect(running.runStartedAt).toBe(3_650);
    expect(running.penalty).toBe('none');
  });

  it('keeps inspection running through a false start', () => {
    // Letting go early is not a way to buy more time to look at the cube.
    const back = play([hold(0), release(90), hold(3_000), release(3_100)], WITH_INSPECTION);
    expect(back.phase).toBe('inspecting');
    expect(back.inspectionStartedAt).toBe(0);
    expect(back.holdStartedAt).toBeNull();
  });

  it.each([
    ['inside 15s', 14_900, 'none'],
    ['exactly 15s', 15_000, 'none'],
    ['just past 15s', 15_001, 'plus2'],
    ['inside the grace window', 17_000, 'plus2'],
    ['past the grace window', 17_001, 'dnf'],
  ] as const)('charges %s as %s', (_label, startAt, expected: Penalty) => {
    const running = play(
      [hold(0), release(90), hold(startAt - 700), tick(startAt - 100), release(startAt)],
      WITH_INSPECTION,
    );
    expect(running.phase).toBe('running');
    expect(running.penalty).toBe(expected);
  });

  it('keeps the inspection penalty on the finished result', () => {
    const done = play(
      [
        hold(0),
        release(90),
        hold(15_400),
        tick(16_000),
        release(16_100),
        { type: 'solved', at: 30_000 },
      ],
      WITH_INSPECTION,
    );
    expect(done.penalty).toBe('plus2');
    expect(rawDurationMs(done)).toBe(13_900);
  });

  it('is skipped entirely when disabled', () => {
    const holding = play([hold(0)]);
    expect(holding.phase).toBe('holding');
    expect(holding.inspectionStartedAt).toBeNull();
  });
});

describe('readout', () => {
  it('is idle before anything happens', () => {
    expect(readTimer(IDLE_TIMER, 1_000)).toEqual({ kind: 'idle' });
  });

  it('counts inspection down and warns before the cost is locked in', () => {
    const inspecting = play([hold(0)], WITH_INSPECTION);
    expect(readTimer(inspecting, 3_000, WITH_INSPECTION)).toEqual({
      kind: 'inspection',
      remainingMs: 12_000,
      penalty: 'none',
    });
    // The warning has to arrive while the player can still act on it.
    expect(readTimer(inspecting, 16_000, WITH_INSPECTION)).toMatchObject({ penalty: 'plus2' });
    expect(readTimer(inspecting, 18_000, WITH_INSPECTION)).toMatchObject({ penalty: 'dnf' });
  });

  it('shows a ready zero while charging without inspection', () => {
    expect(readTimer(play([hold(0), tick(600)]), 900)).toEqual({ kind: 'idle' });
  });

  it('counts a running solve up', () => {
    const running = play(startSolve(0));
    expect(readTimer(running, 4_100)).toEqual({ kind: 'running', elapsedMs: 3_500 });
  });

  it('freezes on the final time once stopped', () => {
    const stopped = play([...startSolve(0), { type: 'solved', at: 9_600 }]);
    const frozen = { kind: 'result', rawMs: 9_000, penalty: 'none' };
    expect(readTimer(stopped, 9_600)).toEqual(frozen);
    // A late frame must not keep the number climbing after the cube is done.
    expect(readTimer(stopped, 50_000)).toEqual(frozen);
  });
});

describe('formatting', () => {
  it.each([
    [0, '0.00'],
    [9, '0.00'],
    [10, '0.01'],
    [999, '0.99'],
    [1_000, '1.00'],
    [12_345, '12.34'],
    [59_999, '59.99'],
    [60_000, '1:00.00'],
    [83_456, '1:23.45'],
    [3_600_000, '60:00.00'],
  ])('renders %ims as %s', (value, expected) => {
    expect(formatMs(value)).toBe(expected);
  });

  it('adds the penalty to the number a +2 actually scores', () => {
    // A +2 is two seconds on the clock, not an annotation beside it.
    expect(effectiveMs(12_340, 'plus2')).toBe(14_340);
    expect(formatResult(12_340, 'plus2')).toBe('14.34+');
  });

  it('keeps a DNF unranked but still shows what was reached', () => {
    expect(effectiveMs(12_340, 'dnf')).toBeNull();
    expect(formatResult(12_340, 'dnf')).toBe('DNF(12.34)');
  });

  it('leaves a clean solve alone', () => {
    expect(effectiveMs(12_340, 'none')).toBe(12_340);
    expect(formatResult(12_340, 'none')).toBe('12.34');
  });
});

describe('robustness', () => {
  it('rejects a timestamp that cannot order events', () => {
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reduceTimer(IDLE_TIMER, hold(at))).toThrow(TypeError);
    }
  });

  it('returns to idle from every phase on reset', () => {
    const reached: Partial<Record<TimerPhase, TimerState>> = {
      idle: IDLE_TIMER,
      inspecting: play([hold(0)], WITH_INSPECTION),
      holding: play([hold(0)]),
      armed: play([hold(0), tick(600)]),
      running: play(startSolve(0)),
      stopped: play([...startSolve(0), { type: 'solved', at: 5_000 }]),
    };
    // Derived from the exported vocabulary: a new phase must be listed here
    // rather than quietly skip the check.
    expect(Object.keys(reached).sort()).toEqual([...TIMER_PHASES].sort());
    for (const state of Object.values(reached)) {
      expect(reduceTimer(state, { type: 'reset', at: 99 })).toEqual(IDLE_TIMER);
    }
  });

  it('never reports a negative duration', () => {
    // A clock that steps backwards is a monotonicity bug elsewhere, but it must
    // not surface here as a negative solve.
    const skewed = play([...startSolve(1_000), { type: 'solved', at: 0 }]);
    expect(rawDurationMs(skewed)).toBe(0);
    expect(readTimer(play(startSolve(1_000)), 0)).toEqual({ kind: 'running', elapsedMs: 0 });
  });

  it('covers every declared penalty', () => {
    expect([...PENALTIES]).toEqual(['none', 'plus2', 'dnf']);
    for (const penalty of PENALTIES) {
      expect(typeof formatResult(1_234, penalty)).toBe('string');
    }
  });
});
