import { solve, type SolveOptions, type SolveResult } from '../solver/search.js';
import type { SolverTables } from '../solver/tables.js';
import type { CubeState } from '../state.js';

import { DISTANCE_PROXY_PROFILE } from './manifest.js';

/**
 * The distance proxy and the metrics built on it (DESIGN.md section 6.5).
 *
 * `progress_score` needs a number for "how far from solved is this cube", and
 * the true distance is out of reach for anything past nine moves. The candidate
 * stand-in is the length of a two-phase solution under one fixed profile. It is
 * an upper bound, not the distance, and whether the gap is small and orderly
 * enough is what the M3d profile in `scripts/validate-distance-proxy.mjs`
 * decides.
 *
 * Every function here returns `null` rather than a filled-in number when the
 * proxy is unavailable. That is the whole design: a missing distance has to
 * stay missing all the way into the report, where it shows up as coverage,
 * because a zero or a substituted value would look like a score.
 */

/** One proxy measurement, including what the search did to produce it. */
export interface ProxyReading {
  /** The proxy distance, or null when this search produced no usable length. */
  readonly length: number | null;
  readonly status: SolveResult['status'];
  /** Which budget ran out, for `budget-exhausted` readings only. */
  readonly reason: 'max-nodes' | 'deadline' | null;
  readonly nodes: number;
}

/**
 * The null semantics, as a pure function of a search result.
 *
 * Split out from {@link measureProxy} so all five branches are reachable in a
 * test without arranging for a real search to exhaust a budget or be cancelled.
 */
export function readProxy(result: SolveResult): ProxyReading {
  switch (result.status) {
    case 'solved':
      return Object.freeze({
        length: result.moves.length,
        status: result.status,
        reason: null,
        nodes: result.nodes,
      });
    case 'budget-exhausted':
      // A budget that ran out after a first solution still leaves a real upper
      // bound behind; one that ran out before leaves nothing to report.
      return Object.freeze({
        length: result.best === null ? null : result.best.length,
        status: result.status,
        reason: result.reason,
        nodes: result.nodes,
      });
    default:
      return Object.freeze({
        length: null,
        status: result.status,
        reason: null,
        nodes: result.nodes,
      });
  }
}

/**
 * Measures one cube under the pre-registered profile.
 *
 * `budgetMs` is refused rather than ignored. A wall-clock fuse turns the search
 * into an anytime algorithm whose answer depends on CPU, load and JIT state,
 * and DESIGN.md section 6.5 rules those out of scoring; accepting one silently
 * here would make two runs of the same corpus disagree for no visible reason.
 */
export function measureProxy(
  state: CubeState,
  tables: SolverTables,
  options: SolveOptions = DISTANCE_PROXY_PROFILE,
): ProxyReading {
  if (options.budgetMs !== undefined) {
    throw new RangeError('A scoring profile may not carry budgetMs');
  }
  return readProxy(solve(state, tables, options));
}

/**
 * `1 - proxyLen(s_final) / proxyLen(s_0)`, clipped to [0, 1].
 *
 * Null when either side is missing, and also when the task started solved: a
 * ratio against a zero baseline has no meaning, and clipping it would report a
 * model that did nothing as having made no progress on a cube it was never
 * asked to solve.
 */
export function progressScore(
  initial: ProxyReading,
  final: ProxyReading,
): number | null {
  if (initial.length === null || final.length === null) return null;
  if (initial.length === 0) return null;
  const raw = 1 - final.length / initial.length;
  return Math.min(1, Math.max(0, raw));
}

/** The best point of a trajectory, with the coverage that produced it. */
export interface BestProgress {
  /** Highest `progress_score` over the trajectory, or null if none scored. */
  readonly value: number | null;
  readonly validPoints: number;
  readonly eligiblePoints: number;
}

/**
 * Separates "came close and lost it" from "never got anywhere".
 *
 * The maximum is taken over scored points only, never over a run that quietly
 * substituted zero for the unscored ones, which is why the counts travel with
 * the value instead of being recoverable from it.
 */
export function bestProgress(
  initial: ProxyReading,
  trajectory: readonly ProxyReading[],
): BestProgress {
  let value: number | null = null;
  let validPoints = 0;
  for (const point of trajectory) {
    const score = progressScore(initial, point);
    if (score === null) continue;
    validPoints += 1;
    if (value === null || score > value) value = score;
  }
  return Object.freeze({ value, validPoints, eligiblePoints: trajectory.length });
}

function ratio(numerator: number, denominator: number | null): number | null {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError('htmCount must be a non-negative safe integer');
  }
  if (denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * `htm_count / optimal_len`, for the k<=9 tasks where the true distance exists.
 *
 * Always at least 1, and 1 exactly when the model matched the optimum.
 */
export function optimalityRatio(
  htmCount: number,
  optimalLength: number | null,
): number | null {
  return ratio(htmCount, optimalLength);
}

/**
 * `htm_count / proxyLen(s_0)`, for tasks past the optimal solver's reach.
 *
 * The denominator is a non-optimal baseline, so this can come out below 1. It
 * is efficiency against the reference solver, and calling it an optimality rate
 * would claim something it does not measure.
 */
export function kociembaRatio(
  htmCount: number,
  baseline: ProxyReading,
): number | null {
  return ratio(htmCount, baseline.length);
}

/** How much of a sample the proxy actually answered for. */
export interface Coverage {
  readonly covered: number;
  readonly total: number;
  /** Null for an empty sample: zero of zero is not full coverage. */
  readonly ratio: number | null;
}

export function coverageOf(values: readonly (number | null)[]): Coverage {
  let covered = 0;
  for (const value of values) if (value !== null) covered += 1;
  return Object.freeze({
    covered,
    total: values.length,
    ratio: values.length === 0 ? null : covered / values.length,
  });
}
