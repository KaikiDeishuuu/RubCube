import { solve, type SolveOptions, type SolveResult } from '../solver/search.js';
import type { SolverTables } from '../solver/tables.js';
import type { CubeState } from '../state.js';

import { DISTANCE_PROXY_PROFILE } from './manifest.js';
import { clampProgress } from './score.js';

/**
 * The distance proxy, and the metrics that survived it (DESIGN.md section 6.5).
 *
 * `progress_score` needed a number for "how far from solved is this cube", and
 * the true distance is out of reach past nine moves. The candidate stand-in was
 * the length of a two-phase solution under one fixed profile - an upper bound,
 * not the distance. **M3d ran the validation profile and rejected it**: see
 * `scripts/validate-distance-proxy.mjs` and DESIGN-SOLVING.md, "M3d 实测". The
 * proxy saturates, so a fourteen-move cube and an eighteen-move one read the
 * same. `structural.ts` carries the replacement.
 *
 * What stays here, and why:
 *
 * - {@link proxyProgressScore} is kept as the rejected definition, so the
 *   validation script still has the thing it rejects to run against. It must
 *   not be used for scoring.
 * - {@link kociembaRatio} is unaffected. It divides by the reference solver's
 *   solution length for one fixed starting cube, and none of the failures were
 *   about a single fixed denominator - they were about comparing the proxy
 *   across states and across single moves.
 * - {@link optimalityRatio} never touched the proxy at all; its denominator is
 *   the true optimum from the k<=9 bidirectional search.
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
 * `1 - proxyLen(s_final) / proxyLen(s_0)`, clipped to [0, 1]. **Rejected.**
 *
 * Kept so the M3d script can keep measuring the thing it rejected, and named
 * apart from the metric that replaced it so no caller reaches for it by
 * accident. Null when either side is missing, and also when the task started
 * solved: a ratio against a zero baseline has no meaning, and clipping it would
 * report a model that did nothing as having made no progress on a cube it was
 * never asked to solve.
 */
export function proxyProgressScore(
  initial: ProxyReading,
  final: ProxyReading,
): number | null {
  if (initial.length === null || final.length === null) return null;
  if (initial.length === 0) return null;
  return clampProgress(1 - final.length / initial.length);
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
