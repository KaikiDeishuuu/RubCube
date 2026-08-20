/**
 * The statistics the M3d verdict is read off.
 *
 * These live in the package rather than in the validation script because a
 * wrong correlation is indistinguishable from a wrong proxy in the output, and
 * only one of the two is testable against known answers. The aggregate report
 * in `bench` needs the same four numbers.
 */

function requirePairs(left: readonly number[], right: readonly number[]): void {
  if (left.length !== right.length) {
    throw new RangeError('Paired samples must have the same length');
  }
}

/**
 * One-based ranks, with tied values sharing the average of the block they fill.
 *
 * Ties are not incidental here: the proxy is integer-valued over a range of
 * about twenty, so a corpus of hundreds is nothing but ties. Ranking them by
 * position instead would invent an ordering the data does not have and inflate
 * the correlation.
 */
function averageRanks(values: readonly number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start + 1;
    while (end < order.length && order[end]!.value === order[start]!.value) end += 1;
    const shared = (start + end + 1) / 2;
    for (let index = start; index < end; index += 1) {
      ranks[order[index]!.index] = shared;
    }
    start = end;
  }
  return ranks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const count = xs.length;
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    meanX += xs[index]!;
    meanY += ys[index]!;
  }
  meanX /= count;
  meanY /= count;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = xs[index]! - meanX;
    const dy = ys[index]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  // A constant column has no ordering to correlate with, which is a failed
  // measurement rather than a correlation of zero.
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/** Spearman's rho: Pearson correlation of the tie-corrected ranks. */
export function spearmanRho(
  reference: readonly number[],
  candidate: readonly number[],
): number | null {
  requirePairs(reference, candidate);
  if (reference.length < 2) return null;
  return pearson(averageRanks(reference), averageRanks(candidate));
}

export function meanAbsoluteError(
  reference: readonly number[],
  candidate: readonly number[],
): number | null {
  requirePairs(reference, candidate);
  if (reference.length === 0) return null;
  let total = 0;
  for (let index = 0; index < reference.length; index += 1) {
    total += Math.abs(candidate[index]! - reference[index]!);
  }
  return total / reference.length;
}

/** Mean of `candidate - reference`; separates bias from scatter. */
export function meanSignedError(
  reference: readonly number[],
  candidate: readonly number[],
): number | null {
  requirePairs(reference, candidate);
  if (reference.length === 0) return null;
  let total = 0;
  for (let index = 0; index < reference.length; index += 1) {
    total += candidate[index]! - reference[index]!;
  }
  return total / reference.length;
}

export interface OrderComparison {
  /** Pairs the reference actually orders; equal references decide nothing. */
  readonly comparable: number;
  readonly concordant: number;
  readonly discordant: number;
  /** Ordered by the reference, tied by the candidate. */
  readonly tied: number;
  readonly inversionRate: number | null;
}

/**
 * Counts how often the candidate ranks a pair the wrong way round.
 *
 * Ties in the candidate are counted separately rather than being charged as
 * inversions, so the rate stays a statement about wrong orderings. That leaves
 * a constant candidate with an inversion rate of zero, which is why the verdict
 * also gates on the correlation, where a constant column is null.
 */
export function compareOrder(
  reference: readonly number[],
  candidate: readonly number[],
): OrderComparison {
  requirePairs(reference, candidate);
  let comparable = 0;
  let concordant = 0;
  let discordant = 0;
  let tied = 0;

  for (let left = 0; left < reference.length; left += 1) {
    for (let right = left + 1; right < reference.length; right += 1) {
      const referenceOrder = Math.sign(reference[left]! - reference[right]!);
      if (referenceOrder === 0) continue;
      comparable += 1;
      const candidateOrder = Math.sign(candidate[left]! - candidate[right]!);
      if (candidateOrder === 0) tied += 1;
      else if (candidateOrder === referenceOrder) concordant += 1;
      else discordant += 1;
    }
  }

  return Object.freeze({
    comparable,
    concordant,
    discordant,
    tied,
    inversionRate: comparable === 0 ? null : discordant / comparable,
  });
}

export interface ViolationReport {
  readonly pairs: number;
  readonly violations: number;
  readonly rate: number | null;
  readonly maxDelta: number | null;
}

/**
 * How often a one-move step moved the proxy by more than one.
 *
 * The reference needs no oracle: a single face turn changes the true distance
 * by exactly one, at every distance. That makes this the only local-consistency
 * evidence available past the optimal solver's nine-move horizon.
 */
export function lipschitzViolations(
  deltas: readonly number[],
  bound = 1,
): ViolationReport {
  let violations = 0;
  let maxDelta: number | null = null;
  for (const delta of deltas) {
    const size = Math.abs(delta);
    if (size > bound) violations += 1;
    if (maxDelta === null || size > maxDelta) maxDelta = size;
  }
  return Object.freeze({
    pairs: deltas.length,
    violations,
    rate: deltas.length === 0 ? null : violations / deltas.length,
    maxDelta,
  });
}

/** Fraction of observations that agreed; null for an empty sample. */
export function agreementRate(flags: readonly boolean[]): number | null {
  if (flags.length === 0) return null;
  let agreed = 0;
  for (const flag of flags) if (flag) agreed += 1;
  return agreed / flags.length;
}
