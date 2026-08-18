/** A source of uniformly distributed values in the half-open interval [0, 1). */
export type RandomSource = () => number;

/** Either a uint32-compatible seed or an already-created random source. */
export type SeedOrRandomSource = number | RandomSource;

export const UINT32_MODULUS = 0x1_0000_0000;
export const UINT32_MAX = UINT32_MODULUS - 1;

/**
 * Normalize a JavaScript integer to its unsigned 32-bit representation.
 *
 * Seeds are safe integers with modulo-2^32 semantics. For example, -1 and
 * 0xffff_ffff select the same stream, as do `seed` and `seed + 2 ** 32`.
 * Fractions, non-finite numbers, and unsafe integers are rejected instead of
 * being silently truncated by JavaScript's bitwise operators.
 */
export function normalizeSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError('seed must be a safe integer');
  }

  return seed >>> 0;
}

/**
 * Create the canonical mulberry32 pseudo-random number generator.
 *
 * The returned generator is deterministic and emits values in [0, 1). Its
 * entire state is one uint32, so streams repeat after at most 2^32 samples.
 */
export function mulberry32(seed: number): RandomSource {
  let state = normalizeSeed(seed);

  return (): number => {
    state = (state + 0x6d2b_79f5) >>> 0;

    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / UINT32_MODULUS;
  };
}

/** Sample an integer uniformly from `[0, maxExclusive)`. */
export function randomInt(random: RandomSource, maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('maxExclusive must be a positive safe integer');
  }

  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('random source must return a finite number in [0, 1)');
  }

  return Math.floor(sample * maxExclusive);
}

