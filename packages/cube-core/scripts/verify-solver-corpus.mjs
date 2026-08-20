import { cpus, platform, release } from 'node:os';

import {
  applyMoves,
  cloneState,
  isSolved,
  mulberry32,
  statesEqual,
} from '../dist/index.js';
import { generateRandomState } from '../dist/scramble.js';
import {
  BENCH_SOLVER_NODE_BUDGET,
  SOLVER_FINGERPRINT,
  TABLE_FINGERPRINT,
  generateSolverTables,
  solve,
} from '../dist/solver/index.js';

/**
 * The correctness and solution-length corpus (DESIGN-SOLVING.md 2.9).
 *
 * Uniform random states rather than random-move scrambles: a 25-move scramble
 * is not a uniform sample of the group, and the criterion is about the group.
 * Seed, size and every search parameter are fixed here so a run cannot be
 * retuned after seeing its own numbers.
 */
const CORPUS_SEED = 0x52554243;
const CORPUS_SIZE = Number(process.env.RUBCUBE_CORPUS_N ?? 10_000);

/** No `budgetMs`: a wall-clock fuse would make the run unreproducible. */
const PROFILE = Object.freeze({
  hardMax: 30,
  targetLength: 21,
  maxNodes: BENCH_SOLVER_NODE_BUDGET,
});

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function report(values, digits = 0) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(digits)),
    p95: Number(percentile(values, 0.95).toFixed(digits)),
    p99: Number(percentile(values, 0.99).toFixed(digits)),
    max: Number(Math.max(...values).toFixed(digits)),
  };
}

const tables = generateSolverTables();
const random = mulberry32(CORPUS_SEED);

const lengths = [];
const nodes = [];
const times = [];
const failures = [];
let targetMet = 0;

for (let index = 0; index < CORPUS_SIZE; index += 1) {
  const state = generateRandomState(random);
  const before = cloneState(state);

  const startedAt = performance.now();
  const result = solve(state, tables, PROFILE);
  times.push(performance.now() - startedAt);

  if (result.status !== 'solved') {
    failures.push({ index, reason: `status ${result.status}`, nodes: result.nodes });
    continue;
  }
  if (!isSolved(applyMoves(state, result.moves))) {
    failures.push({ index, reason: 'solution does not solve the cube' });
    continue;
  }
  // The worker hands a caller's own arrays across; a search that wrote to them
  // would corrupt the store the solve was requested from.
  if (!statesEqual(state, before)) {
    failures.push({ index, reason: 'search mutated the input state' });
    continue;
  }

  if (result.targetMet) targetMet += 1;
  lengths.push(result.moves.length);
  nodes.push(result.nodes);
}

const solved = CORPUS_SIZE - failures.length;
console.log(
  JSON.stringify(
    {
      corpus: {
        size: CORPUS_SIZE,
        seed: `0x${CORPUS_SEED.toString(16)}`,
        sampling: 'uniform random state',
      },
      profile: PROFILE,
      solverFingerprint: SOLVER_FINGERPRINT,
      tableFingerprint: TABLE_FINGERPRINT,
      host: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
      },
      solved,
      // Reported over the whole corpus, never over the solved subset alone.
      targetMetRatio: Number((targetMet / CORPUS_SIZE).toFixed(4)),
      length: lengths.length === 0 ? null : report(lengths),
      nodes: nodes.length === 0 ? null : report(nodes),
      solveMs: times.length === 0 ? null : report(times, 1),
      failures: failures.slice(0, 20),
      failureCount: failures.length,
    },
    null,
    2,
  ),
);

process.exitCode = failures.length === 0 ? 0 : 1;
