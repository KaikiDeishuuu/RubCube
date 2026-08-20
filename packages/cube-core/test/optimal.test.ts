import { describe, expect, it } from 'vitest';

import {
  ALL_HTM_MOVES,
  CubeStateValidationError,
  applyMoves,
  cloneState,
  createSolvedState,
  generateRandomMoves,
  generateRandomState,
  isSolved,
  statesEqual,
  type CubeState,
  type FaceMove,
} from '../src/index.js';
import {
  DEFAULT_BALL_RADIUS,
  HTM_BALL_SIZES,
  MAX_OPTIMAL_DISTANCE,
  RotatedCubeError,
  buildSolvedBall,
  solveOptimal,
  solvedBall,
  type SolvedBall,
} from '../src/optimal/index.js';
import { buildOptimalOracle, scrambleFrom } from './helpers/optimal-oracle.js';

/** Exactly how many states sit at each distance, from DESIGN-SOLVING.md 2.8. */
const LAYER_SIZES = [1, 18, 243, 3_240, 43_239, 574_908];

/**
 * One environment variable, read the way cube-core reaches every host global.
 *
 * The package carries no Node type library on purpose — the same source runs in
 * a browser, a worker and a bench process — so `process` is reached through
 * `globalThis` rather than declared.
 */
function environment(name: string): string | undefined {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env?.[name];
}

const CORPUS_SEED = 0x4f_50_54_31;
/**
 * States per scramble length, equal across lengths as the criterion requires.
 *
 * Small on purpose: confirming one nine-move answer costs the oracle a
 * two-second depth-five sweep. Raise it with RUBCUBE_OPTIMAL_N to widen the
 * check; volume without the oracle lives in scripts/verify-optimal-corpus.mjs.
 */
const PER_LENGTH = Number(environment('RUBCUBE_OPTIMAL_N') ?? 3);

/**
 * The oracle's own radius, deliberately not the module's.
 *
 * A radius-five oracle would answer a nine-move query in 150 ms instead of two
 * seconds, but its `Map` of 621,649 states costs about 900 MB, which is more
 * than a test worker should hold. Four costs 162 MB and pushes the work into
 * the reverse sweep, which only the longest scrambles pay for.
 */
const ORACLE_RADIUS = 4;

let sharedOracle: ReturnType<typeof buildOptimalOracle> | null = null;

/** Built on first use: the corpus cases are the only callers, and each is slow. */
function oracle(): ReturnType<typeof buildOptimalOracle> {
  sharedOracle ??= buildOptimalOracle(ORACLE_RADIUS);
  return sharedOracle;
}

describe('solved ball', () => {
  it('reproduces the published layer sizes', () => {
    // The oracle for every claim below it: a wrong move table or a lossy state
    // key changes these counts before it changes any solution.
    const ball = buildSolvedBall(5);
    expect([...ball.layerSizes]).toEqual(LAYER_SIZES);
    expect(ball.size).toBe(HTM_BALL_SIZES[5]);
    expect(ball.size).toBe(LAYER_SIZES.reduce((sum, count) => sum + count, 0));
  });

  it.each([0, 1, 2, 3, 4])('holds exactly the states within %i moves', (radius) => {
    const ball = buildSolvedBall(radius);
    expect([...ball.layerSizes]).toEqual(LAYER_SIZES.slice(0, radius + 1));
    expect(ball.size).toBe(HTM_BALL_SIZES[radius]);
    expect(ball.radius).toBe(radius);
  });

  it.each([-1, 1.5, 6, Number.NaN])('rejects radius %s', (radius) => {
    expect(() => buildSolvedBall(radius)).toThrow(RangeError);
  });

  it('returns a shortest path to every state it holds', () => {
    const ball = buildSolvedBall(3);
    const oracle = buildOptimalOracle(3);

    // Walk the ball the same way it was built, so every entry gets checked
    // rather than a sample of them.
    const stateKey = (state: CubeState): string =>
      String.fromCharCode(...state.cp, ...state.co, ...state.ep, ...state.eo);
    const solved = createSolvedState();
    const seen = new Set<string>([stateKey(solved)]);
    const frontier: CubeState[] = [solved];
    let checked = 0;

    while (frontier.length > 0) {
      const state = frontier.pop()!;
      const path = ball.pathTo(state);
      expect(path).not.toBeNull();
      expect(applyMoves(createSolvedState(), path!)).toEqual(state);
      expect(path!.length).toBe(oracle.distanceWithin(state));
      checked += 1;

      if (path!.length >= ball.radius) continue;
      for (const move of ALL_HTM_MOVES) {
        const child = applyMoves(state, [move]);
        const childKey = stateKey(child);
        if (seen.has(childKey)) continue;
        seen.add(childKey);
        frontier.push(child);
      }
    }
    expect(checked).toBe(HTM_BALL_SIZES[3]);
  });

  /**
   * Near misses for the state key: cubes that agree with a ball member on
   * everything but one component.
   *
   * Every one of these is far outside the ball — flipping two edges in place
   * takes well over twenty moves — so a key that dropped a component would
   * hand back the neighbour's path for a cube the ball has never seen. No
   * corpus finds that: two states this close in the key and this far apart on
   * the cube do not both turn up in a scramble. The collision has to be built.
   */
  it.each([
    ['edge orientation', (state: CubeState) => {
      state.eo[0] = state.eo[0]! ^ 1;
      state.eo[1] = state.eo[1]! ^ 1;
    }],
    ['corner orientation', (state: CubeState) => {
      state.co[0] = (state.co[0]! + 1) % 3;
      state.co[1] = (state.co[1]! + 2) % 3;
    }],
    ['permutation', (state: CubeState) => {
      [state.ep[0], state.ep[1]] = [state.ep[1]!, state.ep[0]!];
      [state.cp[0], state.cp[1]] = [state.cp[1]!, state.cp[0]!];
    }],
  ])('does not confuse a ball member with a cube differing only in %s', (_label, disturb) => {
    const ball = buildSolvedBall(2);
    const member = applyMoves(createSolvedState(), 'R U');
    expect(ball.pathTo(member)).not.toBeNull();

    const nearMiss = cloneState(member);
    disturb(nearMiss);
    expect(statesEqual(nearMiss, member)).toBe(false);
    expect(ball.pathTo(nearMiss)).toBeNull();
  });

  it('reports states outside its radius as absent', () => {
    const ball = buildSolvedBall(2);
    expect(ball.pathTo(applyMoves(createSolvedState(), 'R U'))).not.toBeNull();
    expect(ball.pathTo(applyMoves(createSolvedState(), 'R U F'))).toBeNull();
  });

  it('caches the shared default-radius ball', () => {
    const first = solvedBall();
    expect(solvedBall()).toBe(first);
    expect(first.radius).toBe(DEFAULT_BALL_RADIUS);
  });
});

interface CorpusEntry {
  readonly length: number;
  readonly scramble: readonly FaceMove[];
  readonly state: CubeState;
}

/** Equal counts per scramble length, from one seed, generated once. */
function buildCorpus(perLength: number): CorpusEntry[] {
  const corpus: CorpusEntry[] = [];
  for (let length = 1; length <= MAX_OPTIMAL_DISTANCE; length += 1) {
    for (let index = 0; index < perLength; index += 1) {
      const scramble = generateRandomMoves(length, CORPUS_SEED + length * 1_000 + index);
      corpus.push({ length, scramble, state: scrambleFrom(scramble) });
    }
  }
  return corpus;
}

describe('optimal solver', () => {
  const ball = buildSolvedBall(DEFAULT_BALL_RADIUS);

  it('returns the empty solution for a cube already solved', () => {
    const result = solveOptimal(createSolvedState(), { ball });
    expect(result.status).toBe('optimal');
    expect(result.status === 'optimal' && result.moves).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
    'is optimal on every %i-move scramble in the corpus',
    (length) => {
      const entries = buildCorpus(PER_LENGTH).filter((entry) => entry.length === length);
      expect(entries).toHaveLength(PER_LENGTH);

      for (const entry of entries) {
        const result = solveOptimal(entry.state, { ball });
        expect(result.status).toBe('optimal');
        if (result.status !== 'optimal') continue;

        expect(isSolved(applyMoves(entry.state, result.moves))).toBe(true);
        expect(result.moves.length).toBeLessThanOrEqual(length);

        // d <= length, so a reverse sweep that deep is enough for the oracle.
        const expected = oracle().distance(entry.state, Math.max(0, length - ORACLE_RADIUS));
        expect(result.moves.length).toBe(expected);
      }
    },
    120_000,
  );

  it('leaves the caller\'s arrays untouched', () => {
    const state = scrambleFrom(generateRandomMoves(7, CORPUS_SEED));
    const before = cloneState(state);
    const arrays = [state.cp, state.co, state.ep, state.eo, state.centers];

    solveOptimal(state, { ball });

    expect(statesEqual(state, before)).toBe(true);
    expect([state.cp, state.co, state.ep, state.eo, state.centers]).toEqual(arrays);
  });

  it('repeats itself exactly', () => {
    const state = scrambleFrom(generateRandomMoves(8, CORPUS_SEED + 7));
    const first = solveOptimal(state, { ball });
    const second = solveOptimal(state, { ball });
    expect(first.status).toBe('optimal');
    expect(second).toEqual({ ...first, elapsedMs: second.elapsedMs });
  });

  it('reaches the same length out of a wider ball', () => {
    const wide = buildSolvedBall(5);
    for (const entry of buildCorpus(2)) {
      const narrow = solveOptimal(entry.state, { ball });
      const broad = solveOptimal(entry.state, { ball: wide });
      expect(narrow.status).toBe('optimal');
      expect(broad.status).toBe('optimal');
      if (narrow.status !== 'optimal' || broad.status !== 'optimal') continue;
      expect(broad.moves.length).toBe(narrow.moves.length);
      expect(isSolved(applyMoves(entry.state, broad.moves))).toBe(true);
    }
  }, 120_000);

  it('refuses a cube further away than it reaches', () => {
    // A uniform random cube is about eighteen moves out; nine is unreachable.
    const result = solveOptimal(generateRandomState(CORPUS_SEED), { ball });
    expect(result.status).toBe('beyond-reach');
    expect(result.status === 'beyond-reach' && result.limit).toBe(MAX_OPTIMAL_DISTANCE);
  });

  it('never returns an empty solution for an unsolved cube', () => {
    // The two ways of finding nothing must stay distinguishable: an empty
    // move list means solved, and only that.
    const far = solveOptimal(generateRandomState(CORPUS_SEED + 1), { ball });
    expect(far.status).toBe('beyond-reach');
    expect('moves' in far).toBe(false);
  });

  it('reports work done even when it finds nothing', () => {
    const result = solveOptimal(generateRandomState(CORPUS_SEED + 2), { ball });
    expect(result.nodes).toBeGreaterThan(1_000);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('takes an injected clock', () => {
    let reading = 100;
    const result = solveOptimal(createSolvedState(), { ball, now: () => (reading += 5) });
    expect(result.elapsedMs).toBe(5);
  });

  it('declines a rotated cube rather than solving a different one', () => {
    // Face turns cannot move a centre, so this cube's target is not the
    // canonical solved state and its shortest solution is a different question.
    // "U E' D'" is the y rotation; parseMoves has no separate notation for one.
    const rotated = applyMoves(createSolvedState(), "U E' D' R");
    expect(() => solveOptimal(rotated, { ball })).toThrow(RotatedCubeError);
  });

  it('rejects an invalid cube', () => {
    const broken = createSolvedState();
    broken.co[0] = 1;
    expect(() => solveOptimal(broken, { ball })).toThrow(CubeStateValidationError);
  });

  it('uses the shared ball when none is given', () => {
    const state = applyMoves(createSolvedState(), "R U R' F");
    const result = solveOptimal(state);
    expect(result.status).toBe('optimal');
    expect(result.status === 'optimal' && result.moves.length).toBe(4);
  });
});
