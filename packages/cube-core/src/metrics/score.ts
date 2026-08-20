/**
 * The shape a progress score has, independent of what produces the number.
 *
 * Two metric versions now share this: the rejected distance proxy and the
 * structural measure that replaced it. Keeping the clipping, the trajectory
 * maximum and the coverage accounting in one place is what makes the two
 * comparable - a change of metric must not quietly become a change of how
 * missing samples are counted.
 */

/** Clips a raw score into [0, 1]; a model that made things worse scores 0. */
export function clampProgress(raw: number): number {
  return Math.min(1, Math.max(0, raw));
}

/** The best point of a trajectory, with the coverage that produced it. */
export interface BestProgress {
  /** Highest score over the trajectory, or null if no point scored. */
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
export function bestProgress(scores: readonly (number | null)[]): BestProgress {
  let value: number | null = null;
  let validPoints = 0;
  for (const score of scores) {
    if (score === null) continue;
    validPoints += 1;
    if (value === null || score > value) value = score;
  }
  return Object.freeze({ value, validPoints, eligiblePoints: scores.length });
}

/** How much of a sample the metric actually answered for. */
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
