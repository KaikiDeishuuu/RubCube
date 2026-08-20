import { cpus, platform, release } from 'node:os';

import {
  ALL_HTM_MOVES,
  CORNER_COUNT,
  EDGE_COUNT,
  applyMoves,
  assertValidState,
  createSolvedState,
  isSolved,
  mulberry32,
} from '../dist/index.js';
import { generateRandomMoves, generateRandomState } from '../dist/scramble.js';
import { generateSolverTables, solve } from '../dist/solver/index.js';
import {
  DISTANCE_PROXY_PROFILE,
  M3D_STRUCTURAL_CORPUS,
  M3D_STRUCTURAL_FINGERPRINT,
  M3D_STRUCTURAL_LEVELS,
  M3D_STRUCTURAL_THRESHOLDS,
  PROGRESS_METRIC_VERSION,
  RANDOM_STATE_PLACED_MEAN,
  SOLVED_CUBIE_COUNT,
  TRAJECTORY_SURROGATE,
  bestProgress,
  cubieCorrectness,
  lipschitzViolations,
  placedCubies,
  readProxy,
  spearmanRho,
  structuralProgress,
} from '../dist/metrics/index.js';

/**
 * M3d round two: the structural metric that replaced the rejected proxy.
 *
 * Round one asked an empirical question - does a two-phase solution length
 * track the true distance - and the answer was no. This round asks a different
 * kind of question, and the manifest says so rather than pretending otherwise:
 * most of what a solved-cubie count does follows from its definition. Two of
 * the six gates carry real risk. One checks a closed-form prediction about
 * uniform random cubes. The other requires this metric to order the structural
 * levels better than the metric it replaced, measured on the same states in
 * the same run - because a replacement that also saturates would be no gain.
 *
 * A no-go exit is the experiment answering "no", not the script failing.
 */

const SCALE = Number(process.env.RUBCUBE_M3D_SCALE ?? 1);
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  throw new RangeError('RUBCUBE_M3D_SCALE must be a positive number');
}

function scaled(count) {
  return Math.max(1, Math.round(count * SCALE));
}

function round(value, digits = 4) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function randomMove(random) {
  return ALL_HTM_MOVES[Math.floor(random() * ALL_HTM_MOVES.length)];
}

const tables = generateSolverTables();

/**
 * Every state this run scores passes through here.
 *
 * `placed === 20` and `isSolved` must agree on every single cube. They are
 * computed from different things - one counts cubies against the canonical
 * solved state, the other compares all 48 stickers to their centres - so an
 * agreement across tens of thousands of states is worth more than the two
 * one-line proofs that they should.
 */
let exactSolvedExceptions = 0;
let statesObserved = 0;

function observe(state) {
  const placed = placedCubies(state);
  statesObserved += 1;
  if ((placed === SOLVED_CUBIE_COUNT) !== isSolved(state)) exactSolvedExceptions += 1;
  return placed;
}

// ---------------------------------------------------------------------------
// Structural levels
// ---------------------------------------------------------------------------

const ALL_CORNERS = Array.from({ length: CORNER_COUNT }, (_, index) => index);
const ALL_EDGES = Array.from({ length: EDGE_COUNT }, (_, index) => index);
const DOWN_CORNERS = [4, 5, 6, 7];
const DOWN_EDGES = [4, 5, 6, 7];
const MIDDLE_EDGES = [8, 9, 10, 11];

/**
 * The milestones a person would name, as sets of cubies that are already home.
 *
 * Taken from the stage ladder in DESIGN-SOLVING.md section 3.2 so the levels
 * mean the same thing here as they will in the tutorial. `orientAll` is the
 * OLL step: every remaining piece is correctly oriented for the slot it sits
 * in, but not yet in its own slot.
 */
const LEVEL_SPECS = {
  scrambled: { corners: [], edges: [], orientAll: false },
  cross: { corners: [], edges: DOWN_EDGES, orientAll: false },
  'first-layer': { corners: DOWN_CORNERS, edges: DOWN_EDGES, orientAll: false },
  f2l: { corners: DOWN_CORNERS, edges: [...DOWN_EDGES, ...MIDDLE_EDGES], orientAll: false },
  oriented: { corners: DOWN_CORNERS, edges: [...DOWN_EDGES, ...MIDDLE_EDGES], orientAll: true },
  solved: { corners: ALL_CORNERS, edges: ALL_EDGES, orientAll: true },
};

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
}

/** Inversion parity, which for a permutation equals its cycle parity. */
function permutationParity(order) {
  let parity = 0;
  for (let left = 0; left < order.length; left += 1) {
    for (let right = left + 1; right < order.length; right += 1) {
      if (order[left] > order[right]) parity ^= 1;
    }
  }
  return parity;
}

/**
 * A cube with a chosen set of cubies home and everything else randomised.
 *
 * Built at the cubie level rather than by solving, because no solver here can
 * produce "first two layers done, last layer arbitrary" - that is what M3.5
 * will be for. The three validity constraints are restored the same way
 * `generateRandomState` restores them: orientations get their last free slot
 * chosen to close the sum, and a mismatched permutation parity is fixed with
 * one transposition among free pieces.
 */
function buildLevelState(random, spec) {
  const homeCorners = new Set(spec.corners);
  const homeEdges = new Set(spec.edges);
  const freeCorners = ALL_CORNERS.filter((slot) => !homeCorners.has(slot));
  const freeEdges = ALL_EDGES.filter((slot) => !homeEdges.has(slot));

  const cp = Uint8Array.from(ALL_CORNERS);
  const ep = Uint8Array.from(ALL_EDGES);
  const co = new Uint8Array(CORNER_COUNT);
  const eo = new Uint8Array(EDGE_COUNT);

  const cornerPieces = [...freeCorners];
  shuffle(cornerPieces, random);
  freeCorners.forEach((slot, index) => { cp[slot] = cornerPieces[index]; });
  const edgePieces = [...freeEdges];
  shuffle(edgePieces, random);
  freeEdges.forEach((slot, index) => { ep[slot] = edgePieces[index]; });

  if (!spec.orientAll) {
    let twist = 0;
    for (let index = 0; index < freeCorners.length - 1; index += 1) {
      const value = Math.floor(random() * 3);
      co[freeCorners[index]] = value;
      twist += value;
    }
    if (freeCorners.length > 0) {
      co[freeCorners[freeCorners.length - 1]] = (3 - (twist % 3)) % 3;
    }
    let flip = 0;
    for (let index = 0; index < freeEdges.length - 1; index += 1) {
      const value = Math.floor(random() * 2);
      eo[freeEdges[index]] = value;
      flip ^= value;
    }
    if (freeEdges.length > 0) eo[freeEdges[freeEdges.length - 1]] = flip;
  }

  if (permutationParity(cp) !== permutationParity(ep)) {
    if (freeCorners.length >= 2) {
      const [first, second] = freeCorners;
      [cp[first], cp[second]] = [cp[second], cp[first]];
    } else if (freeEdges.length >= 2) {
      const [first, second] = freeEdges;
      [ep[first], ep[second]] = [ep[second], ep[first]];
    } else {
      throw new Error('No free pair left to fix permutation parity with');
    }
  }

  const state = {
    cp,
    co,
    ep,
    eo,
    centers: Uint8Array.from({ length: 6 }, (_, index) => index),
  };

  // Checked against the spec directly, never against the metric under test.
  assertValidState(state);
  for (const slot of spec.corners) {
    if (cp[slot] !== slot || co[slot] !== 0) throw new Error(`Corner ${slot} is not home`);
  }
  for (const slot of spec.edges) {
    if (ep[slot] !== slot || eo[slot] !== 0) throw new Error(`Edge ${slot} is not home`);
  }
  if (spec.orientAll && (co.some((value) => value !== 0) || eo.some((value) => value !== 0))) {
    throw new Error('An oriented level came out misoriented');
  }
  return state;
}

function proxyLengthOf(state) {
  return readProxy(solve(state, tables, DISTANCE_PROXY_PROFILE)).length;
}

/**
 * The levels, scored by both metrics on the same states.
 *
 * The side-by-side is the point: round one died of saturation, so a
 * replacement has to be shown not to saturate on the very corpus that makes
 * saturation visible.
 */
function levelClass() {
  const random = mulberry32(M3D_STRUCTURAL_CORPUS.seed);
  const perLevel = scaled(M3D_STRUCTURAL_CORPUS.perLevel);
  const levelIndex = [];
  const placedValues = [];
  const proxyDirection = [];
  const byLevel = {};

  for (const [index, name] of M3D_STRUCTURAL_LEVELS.entries()) {
    const placed = [];
    const positioned = [];
    const oriented = [];
    const proxies = [];
    for (let sample = 0; sample < perLevel; sample += 1) {
      const state = buildLevelState(random, LEVEL_SPECS[name]);
      const counts = cubieCorrectness(state);
      observe(state);
      placed.push(counts.placed);
      positioned.push(counts.positioned);
      oriented.push(counts.oriented);

      const proxy = proxyLengthOf(state);
      if (proxy !== null) {
        proxies.push(proxy);
        // Negated so both metrics point the same way: more progress, larger
        // value. Spearman is invariant under that, so the two rhos compare.
        levelIndex.push(index);
        placedValues.push(counts.placed);
        proxyDirection.push(-proxy);
      }
    }
    byLevel[name] = {
      samples: placed.length,
      meanPlaced: round(mean(placed), 2),
      meanPositioned: round(mean(positioned), 2),
      meanOriented: round(mean(oriented), 2),
      score: round(mean(placed) / SOLVED_CUBIE_COUNT, 3),
      meanProxyLength: round(mean(proxies), 2),
    };
  }

  const means = M3D_STRUCTURAL_LEVELS.map((name) => byLevel[name].meanPlaced);
  let monotone = true;
  for (let index = 1; index < means.length; index += 1) {
    if (!(means[index] > means[index - 1])) monotone = false;
  }

  return {
    perLevel,
    byLevel,
    monotone,
    structuralSpearman: round(spearmanRho(levelIndex, placedValues)),
    proxySpearman: round(spearmanRho(levelIndex, proxyDirection)),
  };
}

/** The closed-form check: a uniform random cube should hold 20/24 of a cubie. */
function randomStateClass() {
  const random = mulberry32(M3D_STRUCTURAL_CORPUS.seed + 1);
  const samples = scaled(M3D_STRUCTURAL_CORPUS.randomStates);
  const placed = [];
  const histogram = {};
  for (let index = 0; index < samples; index += 1) {
    const value = observe(generateRandomState(random));
    placed.push(value);
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  const measured = mean(placed);
  return {
    samples,
    meanPlaced: round(measured, 4),
    predicted: round(RANDOM_STATE_PLACED_MEAN, 4),
    deviation: round(Math.abs(measured - RANDOM_STATE_PLACED_MEAN), 4),
    maxPlaced: Math.max(...placed),
    histogram,
  };
}

/**
 * One move disturbs at most four corners and four edges.
 *
 * Unlike round one's Lipschitz line this is a theorem about the move set, not
 * a hope about a search, so the tolerance is zero violations.
 */
function adjacentClass() {
  const random = mulberry32(M3D_STRUCTURAL_CORPUS.seed + 2);
  const perClass = scaled(M3D_STRUCTURAL_CORPUS.adjacent.basesPerClass);
  const { movesPerBase } = M3D_STRUCTURAL_CORPUS.adjacent;
  const pooled = [];
  const byBase = {};

  for (const base of M3D_STRUCTURAL_CORPUS.adjacent.bases) {
    const deltas = [];
    for (let index = 0; index < perClass; index += 1) {
      const state =
        base === null
          ? generateRandomState(random)
          : applyMoves(createSolvedState(), generateRandomMoves(base, random));
      const placed = observe(state);
      for (let turn = 0; turn < movesPerBase; turn += 1) {
        deltas.push(observe(applyMoves(state, [randomMove(random)])) - placed);
      }
    }
    pooled.push(...deltas);
    byBase[base === null ? 'uniform' : `scramble-${base}`] = {
      pairs: deltas.length,
      meanAbsoluteDelta: round(mean(deltas.map(Math.abs)), 3),
      bound: lipschitzViolations(deltas, M3D_STRUCTURAL_THRESHOLDS.maxCubiesPerMove),
    };
  }

  return {
    pairs: pooled.length,
    bound: lipschitzViolations(pooled, M3D_STRUCTURAL_THRESHOLDS.maxCubiesPerMove),
    byBase,
  };
}

/**
 * The same surrogate trajectories round one used, scored the new way.
 *
 * Reported, not gated, and the manifest says so up front. The surrogate walks a
 * Kociemba solution, along which almost nothing is structurally solved until
 * the very end - so this metric reads near zero for most of the walk. That is
 * the metric working as defined rather than failing: an opaque path that has
 * not yet restored any cubie has not produced anything a judge can verify.
 * What it does mean is that this class cannot corroborate the metric until
 * M3.5 can generate a layer-by-layer solve to walk instead.
 */
function trajectoryClass() {
  const random = mulberry32(M3D_STRUCTURAL_CORPUS.seed + 3);
  const tasks = scaled(M3D_STRUCTURAL_CORPUS.trajectory.tasks);
  const { maxSteps, slipRate } = M3D_STRUCTURAL_CORPUS.trajectory;

  const finals = [];
  const bests = [];
  let solvedTasks = 0;
  let lostGround = 0;
  let stillZeroAtHalfway = 0;

  for (let task = 0; task < tasks; task += 1) {
    const start = generateRandomState(random);
    observe(start);
    let current = start;
    let result = solve(current, tables, DISTANCE_PROXY_PROFILE);
    const scores = [structuralProgress(start, current)];

    for (let step = 0; step < maxSteps; step += 1) {
      if (isSolved(current)) break;
      const slip = random() < slipRate;
      const guide =
        result.status === 'solved' && result.moves.length > 0 ? result.moves[0] : null;
      current = applyMoves(current, [slip || guide === null ? randomMove(random) : guide]);
      observe(current);
      scores.push(structuralProgress(start, current));
      result = solve(current, tables, DISTANCE_PROXY_PROFILE);
    }

    if (isSolved(current)) solvedTasks += 1;
    const halfway = scores[Math.floor((scores.length - 1) / 2)];
    if (halfway === 0) stillZeroAtHalfway += 1;
    const final = scores[scores.length - 1];
    const best = bestProgress(scores);
    if (final !== null) finals.push(final);
    if (best.value !== null) {
      bests.push(best.value);
      if (final !== null && best.value > final + 1e-9) lostGround += 1;
    }
  }

  return {
    tasks,
    solvedTasks,
    meanFinalProgress: round(mean(finals), 3),
    meanBestProgress: round(mean(bests), 3),
    tasksThatLostGround: lostGround,
    tasksStillZeroAtHalfway: stillZeroAtHalfway,
  };
}

/** Control: how fast an undirected walk out of solved gives the structure back. */
function controlWalk() {
  const random = mulberry32(M3D_STRUCTURAL_CORPUS.seed + 4);
  const walks = scaled(M3D_STRUCTURAL_CORPUS.control.walks);
  const { steps } = M3D_STRUCTURAL_CORPUS.control;
  const byStep = Array.from({ length: steps + 1 }, () => []);

  for (let walk = 0; walk < walks; walk += 1) {
    let current = createSolvedState();
    byStep[0].push(observe(current));
    for (let step = 1; step <= steps; step += 1) {
      current = applyMoves(current, [randomMove(random)]);
      byStep[step].push(observe(current));
    }
  }

  return {
    walks,
    steps,
    meanPlacedByStep: byStep.map((values) => round(mean(values), 2)),
  };
}

/** How much a score costs, next to the 28 ms the rejected proxy cost. */
function costPerScore() {
  const random = mulberry32(M3D_STRUCTURAL_CORPUS.seed + 5);
  const states = Array.from({ length: 1_000 }, () => generateRandomState(random));
  const startedAt = performance.now();
  for (const state of states) placedCubies(state);
  return Number(((performance.now() - startedAt) / states.length).toFixed(5));
}

function gate(name, kind, passed, detail) {
  return { name, kind, passed, ...detail };
}

const startedAt = performance.now();
const levels = levelClass();
const randomStates = randomStateClass();
const adjacent = adjacentClass();
const trajectory = trajectoryClass();
const control = controlWalk();
const microsecondsPerScore = costPerScore();

const gates = [
  gate('exactSolved', 'regression', exactSolvedExceptions === 0, {
    exceptions: exactSolvedExceptions,
    states: statesObserved,
  }),
  gate('levelMonotone', 'regression', levels.monotone, {
    means: M3D_STRUCTURAL_LEVELS.map((name) => levels.byLevel[name].meanPlaced),
  }),
  gate(
    'levelSpearman',
    'regression',
    levels.structuralSpearman !== null &&
      levels.structuralSpearman >= M3D_STRUCTURAL_THRESHOLDS.minLevelSpearman,
    { value: levels.structuralSpearman, threshold: M3D_STRUCTURAL_THRESHOLDS.minLevelSpearman },
  ),
  gate(
    'randomStateMean',
    'prediction',
    randomStates.deviation <= M3D_STRUCTURAL_THRESHOLDS.randomStateTolerance,
    {
      value: randomStates.meanPlaced,
      predicted: randomStates.predicted,
      tolerance: M3D_STRUCTURAL_THRESHOLDS.randomStateTolerance,
    },
  ),
  gate('moveBound', 'regression', adjacent.bound.violations === 0, {
    violations: adjacent.bound.violations,
    pairs: adjacent.bound.pairs,
    maxDelta: adjacent.bound.maxDelta,
    bound: M3D_STRUCTURAL_THRESHOLDS.maxCubiesPerMove,
  }),
  gate(
    'beatsProxy',
    'comparison',
    levels.structuralSpearman !== null &&
      levels.proxySpearman !== null &&
      levels.structuralSpearman > levels.proxySpearman,
    { structural: levels.structuralSpearman, proxy: levels.proxySpearman },
  ),
];
const verdict = gates.every((entry) => entry.passed) ? 'go' : 'no-go';

console.log(
  JSON.stringify(
    {
      milestone: 'M3d round 2',
      metric: PROGRESS_METRIC_VERSION,
      manifestFingerprint: M3D_STRUCTURAL_FINGERPRINT,
      manifestHonoured: SCALE === 1,
      scale: SCALE,
      comparisonProfile: DISTANCE_PROXY_PROFILE,
      surrogate: TRAJECTORY_SURROGATE,
      host: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
      },
      levels,
      randomStates,
      adjacent,
      trajectory,
      control,
      millisecondsPerScore: microsecondsPerScore,
      gates,
      verdict,
      elapsedS: Number(((performance.now() - startedAt) / 1_000).toFixed(1)),
    },
    null,
    2,
  ),
);

process.exitCode = verdict === 'go' ? 0 : 1;
