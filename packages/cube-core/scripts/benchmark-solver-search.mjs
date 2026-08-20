import { cpus, platform, release } from 'node:os';

import {
  applyMoves,
  createSolvedState,
  generateRandomMoves,
  isSolved,
} from '../dist/index.js';
import {
  SOLVER_FINGERPRINT,
  TABLE_FINGERPRINT,
  generateSolverTables,
  solve,
} from '../dist/solver/index.js';

/**
 * Hot-path profile for the two-phase search (DESIGN-SOLVING.md 2.9).
 *
 * The corpus, the seed and every search parameter are fixed here rather than
 * passed in, so a run cannot be tuned after seeing its own numbers. Only the
 * corpus size is adjustable, and only downward from the committed default for a
 * quick check — a smaller run is reported as such.
 */
const CORPUS_SIZE = Number(process.env.RUBCUBE_BENCH_N ?? 1_000);
const SCRAMBLE_LENGTH = 25;
const WARMUP = 50;
const WARMUP_SEED_BASE = 900_000;

/**
 * The profiles. Fixed inputs; the wall clock is measured, never an input.
 *
 * Each carries its own corpus size, because the cost of a profile is not a
 * property of the search but of the target: at 21 the search stops on its first
 * good solution, and below that it has to keep going long after it has one. A
 * single corpus size would either make the tight targets take hours or make the
 * headline profile's percentiles too noisy to mean anything.
 */
const PROFILES = Object.freeze([
  { targetLength: 21, hardMax: 30, corpus: CORPUS_SIZE },
  { targetLength: 20, hardMax: 30, corpus: Math.min(CORPUS_SIZE, 100) },
  { targetLength: 19, hardMax: 30, corpus: Math.min(CORPUS_SIZE, 40) },
]);

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
const corpus = Array.from({ length: CORPUS_SIZE }, (_unused, seed) =>
  applyMoves(createSolvedState(), generateRandomMoves(SCRAMBLE_LENGTH, seed)),
);

// The criteria call for a warmed JIT; measuring the first fifty solves in a
// fresh isolate would report compilation, not search.
for (let index = 0; index < WARMUP; index += 1) {
  solve(
    applyMoves(
      createSolvedState(),
      generateRandomMoves(SCRAMBLE_LENGTH, WARMUP_SEED_BASE + index),
    ),
    tables,
    {},
  );
}

const results = PROFILES.map(({ corpus: size, ...profile }) => {
  const lengths = [];
  const times = [];
  const nodes = [];
  let targetMet = 0;
  let solved = 0;

  for (const state of corpus.slice(0, size)) {
    const startedAt = performance.now();
    const result = solve(state, tables, profile);
    times.push(performance.now() - startedAt);
    if (result.status !== 'solved') {
      throw new Error(`Corpus state returned ${result.status}`);
    }
    if (!isSolved(applyMoves(state, result.moves))) {
      throw new Error('Returned solution does not solve the cube');
    }
    solved += 1;
    if (result.targetMet) targetMet += 1;
    lengths.push(result.moves.length);
    nodes.push(result.nodes);
  }

  return {
    profile,
    corpus: size,
    solved,
    targetMetRatio: Number((targetMet / size).toFixed(4)),
    length: report(lengths),
    solveMs: report(times, 1),
    nodes: report(nodes),
  };
});

console.log(
  JSON.stringify(
    {
      corpus: {
        size: CORPUS_SIZE,
        scrambleLength: SCRAMBLE_LENGTH,
        seeds: `0..${CORPUS_SIZE - 1}`,
        warmup: WARMUP,
      },
      solverFingerprint: SOLVER_FINGERPRINT,
      tableFingerprint: TABLE_FINGERPRINT,
      host: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
      },
      results,
    },
    null,
    2,
  ),
);
