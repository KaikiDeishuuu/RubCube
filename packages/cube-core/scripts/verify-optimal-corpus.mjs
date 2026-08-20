import { cpus, platform, release } from 'node:os';

import {
  applyMoves,
  cloneState,
  createSolvedState,
  generateRandomMoves,
  generateRandomState,
  isSolved,
  mulberry32,
  statesEqual,
} from '../dist/index.js';
import {
  HTM_BALL_SIZES,
  MAX_OPTIMAL_DISTANCE,
  buildSolvedBall,
  solveOptimal,
} from '../dist/optimal/index.js';

/**
 * The optimal-solver corpus (DESIGN-SOLVING.md 2.9, row 最优解).
 *
 * Four claims, in the order they have to hold:
 *
 * 1. The ball reproduces the published layer sizes. Everything else stands on
 *    that table, so it is checked first and the run stops if it is wrong.
 * 2. Equal-sized corpora at every scramble length 1..9 all solve, the solution
 *    reproduces a solved cube, and it is never longer than the scramble.
 * 3. Cubes past the module's reach are refused rather than mis-answered.
 * 4. Both ball radii return the same distance for every corpus state. They are
 *    two ways of splitting the same nine moves, so a disagreement means one of
 *    them is wrong.
 *
 * Per-example optimality against an independent oracle lives in the test suite:
 * DESIGN-SOLVING.md scopes that oracle to tests, and confirming one nine-move
 * answer with it costs about two seconds. What this script adds is volume, the
 * cross-radius check, and the measurement profile.
 */
const CORPUS_SEED = 0x4f_50_54_31;
const PER_LENGTH = Number(process.env.RUBCUBE_OPTIMAL_N ?? 200);
const BEYOND_REACH_SAMPLES = Number(process.env.RUBCUBE_OPTIMAL_FAR_N ?? 50);

/** Exactly how many states sit at each distance, from DESIGN-SOLVING.md 2.8. */
const LAYER_SIZES = [1, 18, 243, 3_240, 43_239, 574_908];

/** The two splits worth measuring: a small ball with a deep reverse, and back. */
const MEASURED_RADII = [4, 5];

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function report(values, digits = 0) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(digits)),
    p95: Number(percentile(values, 0.95).toFixed(digits)),
    max: Number(Math.max(...values).toFixed(digits)),
  };
}

const failures = [];

/** Claim 1. */
const ballBuild = [];
const measured = new Map();
for (let radius = 0; radius < LAYER_SIZES.length; radius += 1) {
  const startedAt = performance.now();
  const ball = buildSolvedBall(radius);
  const buildMs = performance.now() - startedAt;

  const expected = LAYER_SIZES.slice(0, radius + 1);
  const actual = [...ball.layerSizes];
  if (actual.join(',') !== expected.join(',')) {
    failures.push({ stage: 'ball', radius, reason: `layers ${actual} != ${expected}` });
  }
  if (ball.size !== HTM_BALL_SIZES[radius]) {
    failures.push({ stage: 'ball', radius, reason: `size ${ball.size}` });
  }

  ballBuild.push({ radius, size: ball.size, buildMs: Number(buildMs.toFixed(1)) });
  if (MEASURED_RADII.includes(radius)) measured.set(radius, ball);
}

if (failures.length > 0) {
  console.log(JSON.stringify({ failures }, null, 2));
  process.exit(1);
}

/** Claims 2 and 3, plus the per-state distances claim 4 compares. */
function runCorpus(ball) {
  const byLength = {};
  const distances = [];

  for (let scrambleLength = 1; scrambleLength <= MAX_OPTIMAL_DISTANCE; scrambleLength += 1) {
    const solveMs = [];
    const nodes = [];
    const found = [];

    for (let index = 0; index < PER_LENGTH; index += 1) {
      const scramble = generateRandomMoves(
        scrambleLength,
        CORPUS_SEED + scrambleLength * 100_000 + index,
      );
      const cube = applyMoves(createSolvedState(), scramble);
      const before = cloneState(cube);
      const where = { stage: 'corpus', radius: ball.radius, scrambleLength, index };

      const startedAt = performance.now();
      const result = solveOptimal(cube, { ball });
      solveMs.push(performance.now() - startedAt);

      if (result.status !== 'optimal') {
        failures.push({ ...where, reason: result.status });
        continue;
      }
      if (!isSolved(applyMoves(cube, result.moves))) {
        failures.push({ ...where, reason: 'does not solve' });
        continue;
      }
      if (result.moves.length > scrambleLength) {
        failures.push({ ...where, reason: `length ${result.moves.length} exceeds scramble` });
        continue;
      }
      if (!statesEqual(cube, before)) {
        failures.push({ ...where, reason: 'mutated input' });
        continue;
      }

      nodes.push(result.nodes);
      found.push(result.moves.length);
      distances.push(result.moves.length);
    }

    byLength[scrambleLength] = {
      solved: found.length,
      // The scramble length only bounds the distance: a nine-move scramble can
      // land two moves from solved, so these are reported, not asserted.
      distance: found.length === 0 ? null : report(found),
      nodes: nodes.length === 0 ? null : report(nodes),
      solveMs: solveMs.length === 0 ? null : report(solveMs, 2),
    };
  }

  const farMs = [];
  let refused = 0;
  const random = mulberry32(CORPUS_SEED);
  for (let index = 0; index < BEYOND_REACH_SAMPLES; index += 1) {
    const cube = generateRandomState(random);
    const startedAt = performance.now();
    const result = solveOptimal(cube, { ball });
    farMs.push(performance.now() - startedAt);
    if (result.status === 'beyond-reach' && result.limit === MAX_OPTIMAL_DISTANCE) {
      refused += 1;
    } else {
      failures.push({ stage: 'beyond-reach', radius: ball.radius, index, reason: result.status });
    }
  }

  return {
    byLength,
    beyondReach: { samples: BEYOND_REACH_SAMPLES, refused, solveMs: report(farMs, 2) },
    distances,
  };
}

const runs = {};
let reference = null;
for (const radius of MEASURED_RADII) {
  const { distances, ...rest } = runCorpus(measured.get(radius));
  runs[`radius${radius}`] = {
    ballSize: HTM_BALL_SIZES[radius],
    ballBuildMs: ballBuild[radius].buildMs,
    reverseDepth: MAX_OPTIMAL_DISTANCE - radius,
    ...rest,
  };

  /** Claim 4. */
  if (reference === null) {
    reference = distances;
  } else if (distances.length !== reference.length) {
    failures.push({ stage: 'cross-radius', reason: 'corpora differ in size' });
  } else {
    for (let index = 0; index < reference.length; index += 1) {
      if (distances[index] !== reference[index]) {
        failures.push({
          stage: 'cross-radius',
          index,
          reason: `${reference[index]} != ${distances[index]}`,
        });
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      corpus: {
        perLength: PER_LENGTH,
        scrambleLengths: `1..${MAX_OPTIMAL_DISTANCE}`,
        beyondReachSamples: BEYOND_REACH_SAMPLES,
        seed: `0x${CORPUS_SEED.toString(16)}`,
      },
      ballBuild,
      host: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
      },
      runs,
      failures: failures.slice(0, 20),
      failureCount: failures.length,
    },
    null,
    2,
  ),
);

process.exitCode = failures.length === 0 ? 0 : 1;
