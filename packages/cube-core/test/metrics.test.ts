import { beforeAll, describe, expect, it } from 'vitest';

import * as rootApi from '../src/index.js';
import {
  ALL_HTM_MOVES,
  applyMoves,
  createSolvedState,
  generateRandomMoves,
  generateRandomState,
  isSolved,
  mulberry32,
  type CubeState,
  type FaceMove,
} from '../src/index.js';
import { generateSolverTables, type SolverTables } from '../src/solver/tables.js';
import { SOLVER_FINGERPRINT, TABLE_FINGERPRINT } from '../src/solver/constants.js';
import { BENCH_SOLVER_NODE_BUDGET, type SolveResult } from '../src/solver/search.js';
import {
  DISTANCE_PROXY_PROFILE,
  M3D_STRUCTURAL_CORPUS,
  M3D_STRUCTURAL_FINGERPRINT,
  M3D_STRUCTURAL_LEVELS,
  M3D_STRUCTURAL_MANIFEST,
  M3D_STRUCTURAL_THRESHOLDS,
  MAX_CUBIES_PER_MOVE,
  PROGRESS_METRIC_VERSION,
  RANDOM_STATE_PLACED_MEAN,
  SOLVED_CUBIE_COUNT,
  cubieCorrectness,
  placedCubies,
  structuralProgress,
  M3D_PROXY_CORPUS,
  M3D_PROXY_FINGERPRINT,
  M3D_PROXY_MANIFEST,
  M3D_PROXY_THRESHOLDS,
  agreementRate,
  bestProgress,
  compareOrder,
  coverageOf,
  kociembaRatio,
  lipschitzViolations,
  meanAbsoluteError,
  meanSignedError,
  measureProxy,
  optimalityRatio,
  proxyProgressScore,
  readProxy,
  spearmanRho,
  type ProxyReading,
} from '../src/metrics/index.js';

// A self-reference exercises package.json's development-condition subpath.
import { DISTANCE_PROXY_PROFILE as EXPORTED_PROFILE } from '@rubcube/cube-core/metrics';

interface CryptoSubset {
  readonly subtle: {
    digest(algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer>;
  };
}

async function sha256(value: string): Promise<string> {
  const runtimeCrypto = (globalThis as unknown as { crypto: CryptoSubset }).crypto;
  const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
  const digest = await runtimeCrypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hex}`;
}

function reading(length: number | null): ProxyReading {
  return Object.freeze({
    length,
    status: length === null ? 'cancelled' : 'solved',
    reason: null,
    nodes: 0,
  });
}

describe('metrics package boundary', () => {
  it('resolves the dedicated package subpath', () => {
    expect(EXPORTED_PROFILE).toBe(DISTANCE_PROXY_PROFILE);
  });

  it('does not leak the judge\'s metrics through the root barrel', () => {
    // Track B hands its tools to the model being measured; a progress score
    // reachable from the default entry point is a solver hint in disguise.
    expect(rootApi).not.toHaveProperty('proxyProgressScore');
    expect(rootApi).not.toHaveProperty('structuralProgress');
    expect(rootApi).not.toHaveProperty('placedCubies');
    expect(rootApi).not.toHaveProperty('measureProxy');
    expect(rootApi).not.toHaveProperty('DISTANCE_PROXY_PROFILE');
    expect(rootApi).not.toHaveProperty('M3D_PROXY_FINGERPRINT');
  });
});

describe('the pre-registered M3d manifest', () => {
  it('keeps its fingerprint equal to the SHA-256 of its canonical text', async () => {
    expect(M3D_PROXY_FINGERPRINT).toBe(await sha256(M3D_PROXY_MANIFEST));
  });

  it('scores under a profile with no wall clock in it', () => {
    // The one parameter that would make two runs of the same corpus disagree.
    expect(DISTANCE_PROXY_PROFILE).not.toHaveProperty('budgetMs');
    expect(DISTANCE_PROXY_PROFILE.hardMax).toBe(30);
    expect(DISTANCE_PROXY_PROFILE.targetLength).toBe(21);
    expect(DISTANCE_PROXY_PROFILE.maxNodes).toBe(BENCH_SOLVER_NODE_BUDGET);
  });

  it('pins the search it validated, not just the corpus', () => {
    // A proxy measured under one search says nothing about another, so both
    // fingerprints have to travel inside the hashed text.
    expect(M3D_PROXY_MANIFEST).toContain(`solver-fingerprint=${SOLVER_FINGERPRINT}`);
    expect(M3D_PROXY_MANIFEST).toContain(`table-fingerprint=${TABLE_FINGERPRINT}`);
    expect(M3D_PROXY_MANIFEST).toContain('budgetMs:none');
    expect(M3D_PROXY_MANIFEST).toContain(`corpus-seed=0x${M3D_PROXY_CORPUS.seed.toString(16)}`);
  });

  it('states every go/no-go threshold in the hashed text', () => {
    // A threshold that lived only in code could be edited after a run without
    // the fingerprint noticing, which is the one thing pre-registration is for.
    expect(M3D_PROXY_MANIFEST).toContain(`gate-coverage>=${M3D_PROXY_THRESHOLDS.minCoverage}`);
    expect(M3D_PROXY_MANIFEST).toContain(`gate-spearman>=${M3D_PROXY_THRESHOLDS.minSpearman}`);
    expect(M3D_PROXY_MANIFEST).toContain(`gate-mae<=${M3D_PROXY_THRESHOLDS.maxMeanAbsoluteError}`);
    expect(M3D_PROXY_MANIFEST).toContain(`gate-inversion<=${M3D_PROXY_THRESHOLDS.maxInversionRate}`);
    expect(M3D_PROXY_MANIFEST).toContain(`gate-direction>=${M3D_PROXY_THRESHOLDS.minDirectionAgreement}`);
    expect(M3D_PROXY_MANIFEST).toContain(
      `gate-lipschitz<=${M3D_PROXY_THRESHOLDS.maxLipschitzViolationRate}`,
    );
  });
});

describe('proxy readings', () => {
  it('takes the solution length when the search solved', () => {
    const result: SolveResult = {
      status: 'solved',
      moves: [{ face: 'R', turns: 1 }, { face: 'U', turns: 2 }] as FaceMove[],
      targetMet: true,
      nodes: 42,
      elapsedMs: 1,
    };
    expect(readProxy(result)).toEqual({
      length: 2,
      status: 'solved',
      reason: null,
      nodes: 42,
    });
  });

  it.each([
    ['max-nodes' as const],
    ['deadline' as const],
  ])('keeps the best solution a %s exhaustion left behind', (reason) => {
    const result: SolveResult = {
      status: 'budget-exhausted',
      best: [{ face: 'R', turns: 1 }] as FaceMove[],
      reason,
      nodes: 7,
      elapsedMs: 1,
    };
    expect(readProxy(result)).toEqual({ length: 1, status: 'budget-exhausted', reason, nodes: 7 });
  });

  it('reports nothing when the budget ran out before any solution', () => {
    const result: SolveResult = {
      status: 'budget-exhausted',
      best: null,
      reason: 'max-nodes',
      nodes: 9,
      elapsedMs: 1,
    };
    expect(readProxy(result).length).toBeNull();
    expect(readProxy(result).nodes).toBe(9);
  });

  it.each([
    ['no-solution-within-hard-max' as const],
    ['cancelled' as const],
  ])('reports nothing for %s', (status) => {
    const result = { status, nodes: 3, elapsedMs: 1 } as SolveResult;
    expect(readProxy(result)).toEqual({ length: null, status, reason: null, nodes: 3 });
  });
});

describe('measured against a real search', () => {
  let tables: SolverTables;

  beforeAll(() => {
    tables = generateSolverTables();
  }, 120_000);

  it('reads zero for a solved cube', () => {
    expect(measureProxy(createSolvedState(), tables).length).toBe(0);
  });

  it('never reports a length the moves do not back up', () => {
    const state: CubeState = applyMoves(createSolvedState(), generateRandomMoves(9, 0x4d3344));
    const value = measureProxy(state, tables);
    expect(value.status).toBe('solved');
    expect(value.length).toBeGreaterThan(0);
    expect(value.length!).toBeLessThanOrEqual(DISTANCE_PROXY_PROFILE.hardMax);
  });

  it('refuses a wall-clock fuse instead of quietly scoring under one', () => {
    // An anytime answer makes the same cube score differently on a busy
    // machine, which DESIGN.md 6.5 rules out of benchmark scoring.
    expect(() =>
      measureProxy(createSolvedState(), tables, {
        ...DISTANCE_PROXY_PROFILE,
        budgetMs: 100,
      }),
    ).toThrow(RangeError);
  });

  it('repeats itself exactly under the fixed profile', () => {
    const state = applyMoves(createSolvedState(), generateRandomMoves(20, 0x4d3345));
    expect(measureProxy(state, tables)).toEqual(measureProxy(state, tables));
  });
});

describe('progress score', () => {
  it('is the fraction of the baseline distance removed', () => {
    expect(proxyProgressScore(reading(20), reading(5))).toBeCloseTo(0.75, 10);
    expect(proxyProgressScore(reading(21), reading(0))).toBe(1);
    expect(proxyProgressScore(reading(18), reading(18))).toBe(0);
  });

  it('clips a cube the model made worse to zero rather than going negative', () => {
    expect(proxyProgressScore(reading(10), reading(25))).toBe(0);
  });

  it.each([
    ['the start', reading(null), reading(4)],
    ['the end', reading(12), reading(null)],
    ['both ends', reading(null), reading(null)],
  ])('is null when the proxy is missing at %s', (_label, initial, final) => {
    // A dropped sample has to stay dropped: substituting zero would read as a
    // model that made no progress, which is a score, not a gap.
    expect(proxyProgressScore(initial, final)).toBeNull();
  });

  it('is undefined for a task that started solved', () => {
    expect(proxyProgressScore(reading(0), reading(0))).toBeNull();
  });
});

describe('best progress', () => {
  it('finds the high-water mark and the coverage behind it', () => {
    const best = bestProgress([0, 0.75, null, 0.25]);
    expect(best.value).toBeCloseTo(0.75, 10);
    expect(best.validPoints).toBe(3);
    expect(best.eligiblePoints).toBe(4);
  });

  it('separates came-close-and-lost-it from never-got-anywhere', () => {
    // Same endpoint, different histories: one touched 0.8 on the way.
    expect(bestProgress([0.8, 0]).value).toBeCloseTo(0.8, 10);
    expect(bestProgress([0, 0]).value).toBe(0);
  });

  it('is null with no scored point, and says how many it looked at', () => {
    const none = bestProgress([null, null]);
    expect(none.value).toBeNull();
    expect(none.validPoints).toBe(0);
    expect(none.eligiblePoints).toBe(2);
  });

  it('reports an empty trajectory as null rather than zero', () => {
    expect(bestProgress([])).toEqual({
      value: null,
      validPoints: 0,
      eligiblePoints: 0,
    });
  });
});

describe('efficiency ratios', () => {
  it('measures a solve against the true optimum', () => {
    expect(optimalityRatio(12, 8)).toBeCloseTo(1.5, 10);
    expect(optimalityRatio(8, 8)).toBe(1);
  });

  it('lets the Kociemba ratio fall below one, because the baseline is not optimal', () => {
    expect(kociembaRatio(18, reading(21))).toBeCloseTo(18 / 21, 10);
  });

  it.each([
    ['missing', null],
    ['zero', 0],
  ])('is null for a %s denominator', (_label, denominator) => {
    expect(optimalityRatio(15, denominator)).toBeNull();
    expect(kociembaRatio(15, reading(denominator))).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN])('rejects an htm count of %s', (count) => {
    expect(() => optimalityRatio(count, 9)).toThrow(RangeError);
    expect(() => kociembaRatio(count, reading(9))).toThrow(RangeError);
  });
});

describe('coverage', () => {
  it('counts the samples the proxy answered for', () => {
    expect(coverageOf([1, null, 3, null])).toEqual({ covered: 2, total: 4, ratio: 0.5 });
  });

  it('calls an empty sample null rather than fully covered', () => {
    expect(coverageOf([])).toEqual({ covered: 0, total: 0, ratio: null });
  });

  it('counts a zero-length proxy as covered', () => {
    // A solved cube reads 0, which is an answer and not a missing one.
    expect(coverageOf([0, 0]).ratio).toBe(1);
  });
});

describe('rank statistics', () => {
  it('is one for a perfectly ordered pair and minus one for a reversed one', () => {
    expect(spearmanRho([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearmanRho([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
  });

  it('shares ranks across ties instead of ordering by position', () => {
    // Ranks of [5,6,7,8,7] are [1,2,3.5,5,3.5]; ranking by position would give
    // 1 here and quietly overstate every correlation the verdict rests on.
    expect(spearmanRho([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(0.8207826817, 9);
  });

  it('is null when a column is constant or a sample is too small', () => {
    expect(spearmanRho([1, 2, 3], [7, 7, 7])).toBeNull();
    expect(spearmanRho([1], [2])).toBeNull();
    expect(spearmanRho([], [])).toBeNull();
  });

  it('refuses unpaired samples', () => {
    expect(() => spearmanRho([1, 2], [1])).toThrow(RangeError);
    expect(() => meanAbsoluteError([1, 2], [1])).toThrow(RangeError);
    expect(() => meanSignedError([1, 2], [1])).toThrow(RangeError);
    expect(() => compareOrder([1, 2], [1])).toThrow(RangeError);
  });
});

describe('error statistics', () => {
  it('separates scatter from bias', () => {
    // Same absolute error, opposite signs: a proxy that only ever overshoots
    // and one that misses both ways are different problems.
    expect(meanAbsoluteError([5, 5], [7, 3])).toBe(2);
    expect(meanSignedError([5, 5], [7, 3])).toBe(0);
    expect(meanSignedError([5, 5], [7, 7])).toBe(2);
  });

  it('is null for an empty sample', () => {
    expect(meanAbsoluteError([], [])).toBeNull();
    expect(meanSignedError([], [])).toBeNull();
  });
});

describe('order comparison', () => {
  it('counts only the pairs the reference actually orders', () => {
    const comparison = compareOrder([1, 1, 2], [9, 3, 5]);
    // The (0,1) pair is tied in the reference, so it decides nothing.
    expect(comparison.comparable).toBe(2);
    expect(comparison.concordant).toBe(1);
    expect(comparison.discordant).toBe(1);
    expect(comparison.inversionRate).toBe(0.5);
  });

  it('books a candidate tie as a tie, not as an inversion', () => {
    const comparison = compareOrder([1, 2, 3], [4, 4, 4]);
    expect(comparison.tied).toBe(3);
    expect(comparison.discordant).toBe(0);
    // A constant candidate therefore scores a perfect inversion rate, which is
    // why the verdict also gates on the correlation, where it is null.
    expect(comparison.inversionRate).toBe(0);
    expect(spearmanRho([1, 2, 3], [4, 4, 4])).toBeNull();
  });

  it('is null when the reference orders nothing', () => {
    expect(compareOrder([2, 2], [1, 5]).inversionRate).toBeNull();
  });
});

describe('local consistency', () => {
  it('counts a step that moved the proxy by more than one', () => {
    const report = lipschitzViolations([0, 1, -1, 2, -5]);
    expect(report.pairs).toBe(5);
    expect(report.violations).toBe(2);
    expect(report.rate).toBeCloseTo(0.4, 10);
    expect(report.maxDelta).toBe(5);
  });

  it('takes a wider bound when asked', () => {
    expect(lipschitzViolations([2, -2], 2).violations).toBe(0);
  });

  it('is null for an empty sample', () => {
    expect(lipschitzViolations([])).toEqual({
      pairs: 0,
      violations: 0,
      rate: null,
      maxDelta: null,
    });
  });
});

describe('agreement rate', () => {
  it('is the fraction that agreed', () => {
    expect(agreementRate([true, true, false, true])).toBe(0.75);
    expect(agreementRate([])).toBeNull();
  });
});

describe('the pre-registered round-two manifest', () => {
  it('keeps its fingerprint equal to the SHA-256 of its canonical text', async () => {
    expect(M3D_STRUCTURAL_FINGERPRINT).toBe(await sha256(M3D_STRUCTURAL_MANIFEST));
  });

  it('records which pre-registration it replaces, by fingerprint', () => {
    // A metric version that cannot name the one it superseded loses the reason
    // it exists the first time someone reads only the newer file.
    expect(M3D_STRUCTURAL_MANIFEST).toContain(`round1=${M3D_PROXY_FINGERPRINT}`);
    expect(M3D_STRUCTURAL_MANIFEST).toContain(`metric=${PROGRESS_METRIC_VERSION}`);
  });

  it('states its gates and the level ladder in the hashed text', () => {
    expect(M3D_STRUCTURAL_MANIFEST).toContain(
      `gate-level-spearman>=${M3D_STRUCTURAL_THRESHOLDS.minLevelSpearman}`,
    );
    expect(M3D_STRUCTURAL_MANIFEST).toContain(
      `gate-random-mean=20/24+-${M3D_STRUCTURAL_THRESHOLDS.randomStateTolerance}`,
    );
    expect(M3D_STRUCTURAL_MANIFEST).toContain(
      `gate-move-bound=|delta-placed|<=${MAX_CUBIES_PER_MOVE}:0-violations`,
    );
    expect(M3D_STRUCTURAL_MANIFEST).toContain('gate-beats-proxy');
    expect(M3D_STRUCTURAL_MANIFEST).toContain(M3D_STRUCTURAL_LEVELS.join('/'));
  });

  it('declares the trajectory class as reported rather than gated', () => {
    // It walks a Kociemba solution, along which this metric reads zero until
    // the end. Declaring that up front is what keeps it from being quietly
    // dropped once the run shows it.
    expect(M3D_STRUCTURAL_MANIFEST).toContain('reported-not-gated');
    expect(M3D_STRUCTURAL_CORPUS.trajectory.slipRate).toBe(0.25);
  });
});

describe('solved cubies', () => {
  it('counts all twenty on a solved cube and none of the centres', () => {
    expect(SOLVED_CUBIE_COUNT).toBe(20);
    expect(placedCubies(createSolvedState())).toBe(20);
  });

  it.each(['U', 'R', 'F', 'U2', "R'"])('loses exactly eight cubies to a %s turn', (move) => {
    // A quarter turn cycles four corners and four edges; a half turn swaps two
    // pairs of each. Either way eight cubies leave home and twelve stay.
    const state = applyMoves(createSolvedState(), move);
    expect(placedCubies(state)).toBe(12);
  });

  it('separates being in the right slot from being the right way up', () => {
    // U moves four corners and four edges without twisting or flipping
    // anything, so every orientation still matches while eight positions do
    // not. A count that could not tell those apart would report 20 here.
    const turned = applyMoves(createSolvedState(), 'U');
    expect(cubieCorrectness(turned)).toEqual({ placed: 12, positioned: 12, oriented: 20 });
  });

  it('compares against any reference, not only the solved state', () => {
    // T1 scores a predicted cube against the true one, where the reference is
    // whatever the task landed on.
    const state = applyMoves(createSolvedState(), "R U R'");
    expect(cubieCorrectness(state, state)).toEqual({
      placed: 20,
      positioned: 20,
      oriented: 20,
    });
    expect(cubieCorrectness(state, createSolvedState()).placed).toBe(
      cubieCorrectness(createSolvedState(), state).placed,
    );
  });

  it('refuses a cube that has been turned as a whole', () => {
    // isSolved is centre-relative and would call this solved; counting cubies
    // against the canonical solved state would call it untouched. Neither
    // answer is wrong, which is why the disagreement has to be refused rather
    // than resolved. "U E' D'" is the y rotation.
    const rotated = applyMoves(createSolvedState(), "U E' D'");
    expect(isSolved(rotated)).toBe(true);
    expect(() => placedCubies(rotated)).toThrow(RangeError);
  });

  it('never moves more than eight cubies for one turn', () => {
    const state = applyMoves(createSolvedState(), generateRandomMoves(12, 0x4d3346));
    const before = placedCubies(state);
    for (const move of ALL_HTM_MOVES) {
      const delta = Math.abs(placedCubies(applyMoves(state, [move])) - before);
      expect(delta).toBeLessThanOrEqual(MAX_CUBIES_PER_MOVE);
    }
  });

  it('sits near 20/24 on a uniform random cube', () => {
    // The closed form the round-two prediction gate checks: a corner is home
    // with probability 1/24 and so is an edge, over eight and twelve of them.
    const random = mulberry32(0x4d3347);
    let total = 0;
    const samples = 2_000;
    for (let index = 0; index < samples; index += 1) {
      total += placedCubies(generateRandomState(random));
    }
    expect(RANDOM_STATE_PLACED_MEAN).toBeCloseTo(0.8333, 4);
    expect(total / samples).toBeCloseTo(RANDOM_STATE_PLACED_MEAN, 1);
  });
});

describe('structural progress', () => {
  const scrambled = applyMoves(createSolvedState(), generateRandomMoves(20, 0x4d3348));

  it('is one exactly when the cube ends solved', () => {
    expect(structuralProgress(scrambled, createSolvedState())).toBe(1);
  });

  it('is zero for a cube left where it started', () => {
    expect(structuralProgress(scrambled, scrambled)).toBe(0);
  });

  it('clips a model that made things worse rather than going negative', () => {
    const better = applyMoves(createSolvedState(), 'R');
    const worse = applyMoves(createSolvedState(), generateRandomMoves(20, 0x4d3349));
    expect(structuralProgress(better, worse)).toBe(0);
  });

  it('is the fraction of the remaining cubies that got fixed', () => {
    // R leaves twelve home, so eight are outstanding; undoing it fixes all of
    // them, and undoing half the damage would score half.
    const start = applyMoves(createSolvedState(), 'R');
    expect(placedCubies(start)).toBe(12);
    expect(structuralProgress(start, createSolvedState())).toBe(1);
    expect(structuralProgress(start, start)).toBe(0);
  });

  it('is undefined for a task that started solved', () => {
    // Nothing to do a fraction of, exactly as with the rejected proxy.
    expect(structuralProgress(createSolvedState(), createSolvedState())).toBeNull();
  });

  it('refuses a rotated cube on either side', () => {
    const rotated = applyMoves(createSolvedState(), "U E' D'");
    expect(() => structuralProgress(rotated, createSolvedState())).toThrow(RangeError);
    expect(() => structuralProgress(scrambled, rotated)).toThrow(RangeError);
  });

  it('needs no solver and no tables', () => {
    // The whole reason it can be read at every trajectory point: the rejected
    // proxy cost about 28 ms a state, this is a loop over forty bytes.
    expect(PROGRESS_METRIC_VERSION).toBe('structural-cubies-v1');
    expect(M3D_STRUCTURAL_LEVELS).toHaveLength(6);
  });
});
