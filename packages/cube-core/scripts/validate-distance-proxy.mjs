import { cpus, platform, release } from 'node:os';

import {
  ALL_HTM_MOVES,
  applyMoves,
  createSolvedState,
  isSolved,
  mulberry32,
} from '../dist/index.js';
import { generateRandomMoves, generateRandomState } from '../dist/scramble.js';
import { generateSolverTables, solve } from '../dist/solver/index.js';
import { solvedBall, solveOptimal } from '../dist/optimal/index.js';
import {
  DISTANCE_PROXY_PROFILE,
  M3D_PROXY_CORPUS,
  M3D_PROXY_FINGERPRINT,
  M3D_PROXY_THRESHOLDS,
  TRAJECTORY_SURROGATE,
  agreementRate,
  bestProgress,
  compareOrder,
  coverageOf,
  lipschitzViolations,
  meanAbsoluteError,
  meanSignedError,
  measureProxy,
  proxyProgressScore,
  readProxy,
  spearmanRho,
} from '../dist/metrics/index.js';

/**
 * The M3d distance-proxy validation profile (DESIGN.md section 9, item 1).
 *
 * Decides whether the two-phase solution length is a good enough stand-in for
 * the true distance to carry `progress_score`. Every corpus, seed, threshold
 * and solver parameter comes from the manifest in `src/metrics/manifest.ts`,
 * which was committed before this ran; nothing here may be retuned after
 * seeing the numbers.
 *
 * A no-go exit is the experiment answering "no", not the script failing. The
 * three classes are separate because they answer different questions:
 *
 *   A  known distance (k<=9)   ground truth exists, from the M3c solver
 *   B  trajectories            where the score is actually read; surrogate
 *   C  adjacent pairs          one move changes the true distance by one,
 *                              at any distance, so this needs no oracle
 */

const SCALE = Number(process.env.RUBCUBE_M3D_SCALE ?? 1);
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  throw new RangeError('RUBCUBE_M3D_SCALE must be a positive number');
}

/** Shrinks a corpus for a smoke run; a scaled run is reported as off-manifest. */
function scaled(count) {
  return Math.max(1, Math.round(count * SCALE));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function spread(values, digits = 0) {
  if (values.length === 0) return null;
  return {
    p50: Number(percentile(values, 0.5).toFixed(digits)),
    p95: Number(percentile(values, 0.95).toFixed(digits)),
    max: Number(Math.max(...values).toFixed(digits)),
  };
}

function round(value, digits = 4) {
  return value === null ? null : Number(value.toFixed(digits));
}

function randomMove(random) {
  return ALL_HTM_MOVES[Math.floor(random() * ALL_HTM_MOVES.length)];
}

const tables = generateSolverTables();
const ball = solvedBall();

/** Both readings and the solved-status move list, from one search. */
function probe(state) {
  const result = solve(state, tables, DISTANCE_PROXY_PROFILE);
  return { reading: readProxy(result), result };
}

/**
 * Class A: states whose true distance the M3c solver can produce.
 *
 * Also the only place the "one shortest move must look like progress" check can
 * run, because it needs a move that is known to lower the true distance.
 */
function knownDistanceClass() {
  const { minLength, maxLength } = M3D_PROXY_CORPUS.knownDistance;
  const perLength = scaled(M3D_PROXY_CORPUS.knownDistance.perLength);
  const truth = [];
  const proxy = [];
  const lengths = [];
  const nodes = [];
  const direction = [];
  const errorsByDistance = new Map();
  let worst = null;

  for (let length = minLength; length <= maxLength; length += 1) {
    for (let index = 0; index < perLength; index += 1) {
      const scramble = generateRandomMoves(
        length,
        M3D_PROXY_CORPUS.seed + length * 1_000 + index,
      );
      const state = applyMoves(createSolvedState(), scramble);
      const optimal = solveOptimal(state, { ball });
      if (optimal.status !== 'optimal') {
        throw new Error(`No true distance for a ${length}-move scramble`);
      }

      const { reading } = probe(state);
      lengths.push(reading.length);
      nodes.push(reading.nodes);
      if (reading.length !== null) {
        const distance = optimal.moves.length;
        truth.push(distance);
        proxy.push(reading.length);
        const error = reading.length - distance;
        const bucket = errorsByDistance.get(distance) ?? [];
        bucket.push(error);
        errorsByDistance.set(distance, bucket);
        if (worst === null || error > worst.error) {
          worst = { error, distance, proxy: reading.length };
        }
      }

      // One move along a shortest solution lowers the true distance by exactly
      // one. A proxy that does not notice cannot report progress.
      if (optimal.moves.length > 0) {
        const next = probe(applyMoves(state, [optimal.moves[0]])).reading;
        if (reading.length !== null && next.length !== null) {
          direction.push(next.length < reading.length);
        }
      }
    }
  }

  const byDistance = {};
  for (const [distance, errors] of [...errorsByDistance].sort((a, b) => a[0] - b[0])) {
    byDistance[distance] = {
      samples: errors.length,
      meanError: round(errors.reduce((sum, error) => sum + error, 0) / errors.length, 3),
      maxError: Math.max(...errors),
    };
  }

  return {
    samples: lengths.length,
    coverage: coverageOf(lengths),
    spearman: round(spearmanRho(truth, proxy)),
    meanAbsoluteError: round(meanAbsoluteError(truth, proxy), 3),
    meanSignedError: round(meanSignedError(truth, proxy), 3),
    order: compareOrder(truth, proxy),
    directionAgreement: round(agreementRate(direction)),
    directionSamples: direction.length,
    worstOverestimate: worst,
    byDistance,
    nodes: spread(nodes),
  };
}

/**
 * Class B: partly-competent descents, the shape a benchmark trajectory has.
 *
 * Not model traces - M4 does not exist yet - so this is the declared surrogate
 * from the manifest: walk the first move of a real solution, and at `slipRate`
 * take a random move instead. The tail of each walk drifts inside the optimal
 * solver's reach, which is the only place a trajectory point has ground truth.
 */
function trajectoryClass() {
  const random = mulberry32(M3D_PROXY_CORPUS.seed + 1);
  const tasks = scaled(M3D_PROXY_CORPUS.trajectory.tasks);
  const { maxSteps, slipRate } = M3D_PROXY_CORPUS.trajectory;

  const allLengths = [];
  const guidedDescents = [];
  const slipDescents = [];
  const finalScores = [];
  const bestScores = [];
  const tailTruth = [];
  const tailProxy = [];
  let solvedTasks = 0;
  let validBest = 0;
  let eligibleBest = 0;
  let lostGround = 0;

  for (let task = 0; task < tasks; task += 1) {
    const start = generateRandomState(random);
    let current = start;
    const initial = probe(start);
    const points = [initial.reading];
    const states = [start];
    allLengths.push(initial.reading.length);

    let previous = initial;
    for (let step = 0; step < maxSteps; step += 1) {
      if (isSolved(current)) break;
      const slip = random() < slipRate;
      const guide =
        previous.result.status === 'solved' && previous.result.moves.length > 0
          ? previous.result.moves[0]
          : null;
      const move = slip || guide === null ? randomMove(random) : guide;

      current = applyMoves(current, [move]);
      const next = probe(current);
      points.push(next.reading);
      states.push(current);
      allLengths.push(next.reading.length);

      if (previous.reading.length !== null && next.reading.length !== null) {
        const descended = next.reading.length < previous.reading.length;
        if (slip || guide === null) slipDescents.push(descended);
        else guidedDescents.push(descended);
      }
      previous = next;
    }

    if (isSolved(current)) solvedTasks += 1;

    const final = points[points.length - 1];
    const score = proxyProgressScore(initial.reading, final);
    if (score !== null) finalScores.push(score);
    const best = bestProgress(points.map((point) => proxyProgressScore(initial.reading, point)));
    validBest += best.validPoints;
    eligibleBest += best.eligiblePoints;
    if (best.value !== null) {
      bestScores.push(best.value);
      if (score !== null && best.value > score + 1e-9) lostGround += 1;
    }

    // Ground truth wherever the walk came within the optimal solver's reach.
    // Anything further out returns `beyond-reach`, which is not a failure - it
    // is the horizon this whole experiment exists because of.
    for (let index = 0; index < points.length; index += 1) {
      const reading = points[index];
      if (reading.length === null) continue;
      const optimal = solveOptimal(states[index], { ball });
      if (optimal.status !== 'optimal') continue;
      tailTruth.push(optimal.moves.length);
      tailProxy.push(reading.length);
    }
  }

  return {
    tasks,
    points: allLengths.length,
    coverage: coverageOf(allLengths),
    solvedTasks,
    guidedDescentRate: round(agreementRate(guidedDescents)),
    guidedSteps: guidedDescents.length,
    slipDescentRate: round(agreementRate(slipDescents)),
    slipSteps: slipDescents.length,
    finalProgress: spread(finalScores, 3),
    bestProgress: spread(bestScores, 3),
    bestProgressCoverage: {
      covered: validBest,
      total: eligibleBest,
      ratio: eligibleBest === 0 ? null : round(validBest / eligibleBest),
    },
    tasksThatLostGround: lostGround,
    tailSamples: tailTruth.length,
    tailSpearman: round(spearmanRho(tailTruth, tailProxy)),
    tailMeanAbsoluteError: round(meanAbsoluteError(tailTruth, tailProxy), 3),
  };
}

/**
 * Class C: one move apart, where the true distance is known to differ by one.
 *
 * The only local-consistency evidence available past nine moves, and therefore
 * the only evidence at all in the 10-to-21 band the benchmark lives in.
 */
function adjacentClass() {
  const random = mulberry32(M3D_PROXY_CORPUS.seed + 2);
  const perClass = scaled(M3D_PROXY_CORPUS.adjacent.basesPerClass);
  const { movesPerBase } = M3D_PROXY_CORPUS.adjacent;

  const byBase = {};
  const pooledDeltas = [];
  const pooledLengths = [];

  for (const base of M3D_PROXY_CORPUS.adjacent.bases) {
    const deltas = [];
    const lengths = [];
    const histogram = {};
    for (let index = 0; index < perClass; index += 1) {
      const state =
        base === null
          ? generateRandomState(random)
          : applyMoves(createSolvedState(), generateRandomMoves(base, random));
      const reading = measureProxy(state, tables, DISTANCE_PROXY_PROFILE);
      lengths.push(reading.length);
      for (let turn = 0; turn < movesPerBase; turn += 1) {
        const neighbour = measureProxy(
          applyMoves(state, [randomMove(random)]),
          tables,
          DISTANCE_PROXY_PROFILE,
        );
        lengths.push(neighbour.length);
        if (reading.length === null || neighbour.length === null) continue;
        const delta = neighbour.length - reading.length;
        deltas.push(delta);
        const size = Math.abs(delta);
        histogram[size] = (histogram[size] ?? 0) + 1;
      }
    }
    pooledDeltas.push(...deltas);
    pooledLengths.push(...lengths);
    byBase[base === null ? 'uniform' : `scramble-${base}`] = {
      lipschitz: lipschitzViolations(deltas),
      absoluteDeltas: histogram,
      proxy: spread(lengths.filter((length) => length !== null)),
    };
  }

  return {
    pairs: pooledDeltas.length,
    coverage: coverageOf(pooledLengths),
    lipschitz: lipschitzViolations(pooledDeltas),
    byBase,
  };
}

/**
 * The control: an undirected walk out of the solved state.
 *
 * Required to be nothing in particular. It is here so the descent seen in class
 * B can be told apart from a proxy that simply wanders, and it doubles as a
 * check that the proxy tracks distance while distance is small and saturates
 * once the walk is far enough out that everything is about twenty moves away.
 */
function controlWalk() {
  const random = mulberry32(M3D_PROXY_CORPUS.seed + 3);
  const walks = scaled(M3D_PROXY_CORPUS.control.walks);
  const { steps } = M3D_PROXY_CORPUS.control;

  const byStep = Array.from({ length: steps + 1 }, () => []);
  const stepIndex = [];
  const stepProxy = [];
  let rose = 0;
  let fell = 0;
  let held = 0;

  for (let walk = 0; walk < walks; walk += 1) {
    let current = createSolvedState();
    let previous = measureProxy(current, tables, DISTANCE_PROXY_PROFILE);
    byStep[0].push(previous.length);
    for (let step = 1; step <= steps; step += 1) {
      // Uniform over all eighteen moves, with no filter at all: an undirected
      // walk is allowed to undo itself, which is exactly what makes it a
      // control rather than a scramble.
      current = applyMoves(current, [randomMove(random)]);
      const reading = measureProxy(current, tables, DISTANCE_PROXY_PROFILE);
      byStep[step].push(reading.length);
      if (previous.length !== null && reading.length !== null) {
        if (reading.length > previous.length) rose += 1;
        else if (reading.length < previous.length) fell += 1;
        else held += 1;
        stepIndex.push(step);
        stepProxy.push(reading.length);
      }
      previous = reading;
    }
  }

  const meanByStep = byStep.map((readings) => {
    const present = readings.filter((length) => length !== null);
    return present.length === 0
      ? null
      : round(present.reduce((sum, length) => sum + length, 0) / present.length, 2);
  });

  return {
    walks,
    steps,
    meanProxyByStep: meanByStep,
    spearmanWithStepIndex: round(spearmanRho(stepIndex, stepProxy)),
    rose,
    fell,
    held,
  };
}

function gate(name, value, comparison, threshold) {
  const passed =
    value !== null && (comparison === '>=' ? value >= threshold : value <= threshold);
  return { name, value, comparison, threshold, passed };
}

const startedAt = performance.now();
const classA = knownDistanceClass();
const classB = trajectoryClass();
const classC = adjacentClass();
const control = controlWalk();

const gates = [
  gate('coverage.knownDistance', round(classA.coverage.ratio), '>=', M3D_PROXY_THRESHOLDS.minCoverage),
  gate('coverage.trajectory', round(classB.coverage.ratio), '>=', M3D_PROXY_THRESHOLDS.minCoverage),
  gate('coverage.adjacent', round(classC.coverage.ratio), '>=', M3D_PROXY_THRESHOLDS.minCoverage),
  gate('spearman', classA.spearman, '>=', M3D_PROXY_THRESHOLDS.minSpearman),
  gate('meanAbsoluteError', classA.meanAbsoluteError, '<=', M3D_PROXY_THRESHOLDS.maxMeanAbsoluteError),
  gate('inversionRate', round(classA.order.inversionRate), '<=', M3D_PROXY_THRESHOLDS.maxInversionRate),
  gate('directionAgreement', classA.directionAgreement, '>=', M3D_PROXY_THRESHOLDS.minDirectionAgreement),
  gate('lipschitzViolationRate', round(classC.lipschitz.rate), '<=', M3D_PROXY_THRESHOLDS.maxLipschitzViolationRate),
];
const verdict = gates.every((entry) => entry.passed) ? 'go' : 'no-go';

console.log(
  JSON.stringify(
    {
      milestone: 'M3d',
      manifestFingerprint: M3D_PROXY_FINGERPRINT,
      manifestHonoured: SCALE === 1,
      scale: SCALE,
      profile: DISTANCE_PROXY_PROFILE,
      surrogate: TRAJECTORY_SURROGATE,
      host: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
      },
      knownDistance: classA,
      trajectory: classB,
      adjacent: classC,
      control,
      gates,
      verdict,
      elapsedS: Number(((performance.now() - startedAt) / 1_000).toFixed(1)),
    },
    null,
    2,
  ),
);

process.exitCode = verdict === 'go' ? 0 : 1;
