import { CORNER_COUNT, EDGE_COUNT } from '../state.js';

import { COORDINATE_SIZES } from './constants.js';

const SLICE_EDGE_FIRST = 8;
const SLICE_EDGE_COUNT = 4;
const UD_EDGE_COUNT = EDGE_COUNT - SLICE_EDGE_COUNT;

const FACTORIALS = Object.freeze([1, 1, 2, 6, 24, 120, 720, 5_040, 40_320]);

function assertCoordinateIndex(
  index: number,
  size: number,
  coordinate: string,
): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= size) {
    throw new RangeError(
      `${coordinate} coordinate must be an integer in [0, ${size - 1}]`,
    );
  }
}

function assertLength(
  values: ArrayLike<number>,
  length: number,
  name: string,
): void {
  if (values.length !== length) {
    throw new RangeError(`${name} must contain exactly ${length} values`);
  }
}

function assertOrientation(
  values: ArrayLike<number>,
  length: number,
  base: number,
  name: string,
): void {
  assertLength(values, length, name);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (
      !Number.isInteger(value) ||
      value === undefined ||
      value < 0 ||
      value >= base
    ) {
      throw new RangeError(
        `${name}[${index}] must be an integer in [0, ${base - 1}]`,
      );
    }
    sum += value;
  }
  if (sum % base !== 0) {
    throw new RangeError(`${name} orientation sum must be divisible by ${base}`);
  }
}

function rankOrientation(
  values: ArrayLike<number>,
  length: number,
  base: number,
  name: string,
): number {
  assertOrientation(values, length, base, name);
  let coordinate = 0;
  for (let index = 0; index < length - 1; index += 1) {
    coordinate = coordinate * base + values[index]!;
  }
  return coordinate;
}

function unrankOrientation(
  coordinate: number,
  length: number,
  base: number,
  size: number,
  name: string,
): Uint8Array {
  assertCoordinateIndex(coordinate, size, name);
  const values = new Uint8Array(length);
  let remainder = coordinate;
  let sum = 0;
  for (let index = length - 2; index >= 0; index -= 1) {
    const value = remainder % base;
    values[index] = value;
    sum += value;
    remainder = Math.floor(remainder / base);
  }
  values[length - 1] = (base - (sum % base)) % base;
  return values;
}

function assertPermutation(
  values: ArrayLike<number>,
  length: number,
  firstValue: number,
  name: string,
): void {
  assertLength(values, length, name);
  let seen = 0;
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (
      !Number.isInteger(value) ||
      value === undefined ||
      value < firstValue ||
      value >= firstValue + length
    ) {
      throw new RangeError(
        `${name}[${index}] must be an integer in [${firstValue}, ${firstValue + length - 1}]`,
      );
    }
    const bit = 1 << (value - firstValue);
    if ((seen & bit) !== 0) {
      throw new RangeError(`${name} must not contain duplicate values`);
    }
    seen |= bit;
  }
}

function rankPermutation(
  values: ArrayLike<number>,
  length: number,
  firstValue: number,
  name: string,
): number {
  assertPermutation(values, length, firstValue, name);
  let coordinate = 0;
  for (let left = 0; left < length - 1; left += 1) {
    let smallerToRight = 0;
    for (let right = left + 1; right < length; right += 1) {
      if (values[right]! < values[left]!) smallerToRight += 1;
    }
    coordinate += smallerToRight * FACTORIALS[length - left - 1]!;
  }
  return coordinate;
}

function unrankPermutation(
  coordinate: number,
  length: number,
  firstValue: number,
  size: number,
  name: string,
): Uint8Array {
  assertCoordinateIndex(coordinate, size, name);
  const available = Array.from({ length }, (_unused, index) => firstValue + index);
  const values = new Uint8Array(length);
  let remainder = coordinate;

  for (let position = 0; position < length; position += 1) {
    const placeValue = FACTORIALS[length - position - 1]!;
    const availableIndex = Math.floor(remainder / placeValue);
    remainder %= placeValue;
    values[position] = available.splice(availableIndex, 1)[0]!;
  }
  return values;
}

function binomial(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  if (k === 0 || n === k) return 1;
  const smallerK = Math.min(k, n - k);
  let result = 1;
  for (let factor = 1; factor <= smallerK; factor += 1) {
    result = (result * (n - smallerK + factor)) / factor;
  }
  return result;
}

/** Rank all eight corner orientations; the eighth is the parity digit. */
export function rankCornerOrientation(orientations: ArrayLike<number>): number {
  return rankOrientation(orientations, CORNER_COUNT, 3, 'corner orientations');
}

/** Decode a CO coordinate into all eight orientations. */
export function unrankCornerOrientation(coordinate: number): Uint8Array {
  return unrankOrientation(
    coordinate,
    CORNER_COUNT,
    3,
    COORDINATE_SIZES.CO,
    'CO',
  );
}

/** Rank all twelve edge orientations; the twelfth is the parity digit. */
export function rankEdgeOrientation(orientations: ArrayLike<number>): number {
  return rankOrientation(orientations, EDGE_COUNT, 2, 'edge orientations');
}

/** Decode an EO coordinate into all twelve orientations. */
export function unrankEdgeOrientation(coordinate: number): Uint8Array {
  return unrankOrientation(
    coordinate,
    EDGE_COUNT,
    2,
    COORDINATE_SIZES.EO,
    'EO',
  );
}

/**
 * Rank which four edge positions contain the FR/FL/BL/BR cubies. Their order
 * is deliberately ignored. The solved placement maps to zero.
 */
export function rankUDSlice(edgePermutation: ArrayLike<number>): number {
  assertPermutation(edgePermutation, EDGE_COUNT, 0, 'edge permutation');
  let coordinate = 0;
  let selected = 0;
  for (let position = EDGE_COUNT - 1; position >= 0; position -= 1) {
    if (edgePermutation[position]! >= SLICE_EDGE_FIRST) {
      selected += 1;
      coordinate += binomial(EDGE_COUNT - 1 - position, selected);
    }
  }
  return coordinate;
}

/**
 * Decode UDSlice to a canonical full edge permutation. Cubies within the two
 * groups are ascending; only their four occupied positions carry meaning.
 */
export function unrankUDSlice(coordinate: number): Uint8Array {
  assertCoordinateIndex(coordinate, COORDINATE_SIZES.UDSlice, 'UDSlice');
  const isSlicePosition = new Uint8Array(EDGE_COUNT);
  let remainder = coordinate;
  let maximumTransformedPosition = EDGE_COUNT - 1;

  for (let selected = SLICE_EDGE_COUNT; selected >= 1; selected -= 1) {
    let transformedPosition = maximumTransformedPosition;
    while (binomial(transformedPosition, selected) > remainder) {
      transformedPosition -= 1;
    }
    remainder -= binomial(transformedPosition, selected);
    isSlicePosition[EDGE_COUNT - 1 - transformedPosition] = 1;
    maximumTransformedPosition = transformedPosition - 1;
  }

  const permutation = new Uint8Array(EDGE_COUNT);
  let nextUDEdge = 0;
  let nextSliceEdge = SLICE_EDGE_FIRST;
  for (let position = 0; position < EDGE_COUNT; position += 1) {
    if (isSlicePosition[position] === 1) {
      permutation[position] = nextSliceEdge;
      nextSliceEdge += 1;
    } else {
      permutation[position] = nextUDEdge;
      nextUDEdge += 1;
    }
  }
  return permutation;
}

/** Rank the complete eight-corner permutation lexicographically. */
export function rankCornerPermutation(permutation: ArrayLike<number>): number {
  return rankPermutation(permutation, CORNER_COUNT, 0, 'corner permutation');
}

/** Decode CP into a complete eight-corner permutation. */
export function unrankCornerPermutation(coordinate: number): Uint8Array {
  return unrankPermutation(
    coordinate,
    CORNER_COUNT,
    0,
    COORDINATE_SIZES.CP,
    'CP',
  );
}

function assertPhase2EdgePermutation(edgePermutation: ArrayLike<number>): void {
  assertPermutation(edgePermutation, EDGE_COUNT, 0, 'phase-2 edge permutation');
  for (let position = 0; position < UD_EDGE_COUNT; position += 1) {
    if (edgePermutation[position]! >= SLICE_EDGE_FIRST) {
      throw new RangeError(
        'phase-2 U/D positions must contain only U/D edge cubies',
      );
    }
  }
}

/** Rank the U/D-layer eight-edge permutation of a phase-2 state. */
export function rankUDEdgePermutation(edgePermutation: ArrayLike<number>): number {
  assertPhase2EdgePermutation(edgePermutation);
  const udEdges = new Uint8Array(UD_EDGE_COUNT);
  for (let index = 0; index < UD_EDGE_COUNT; index += 1) {
    udEdges[index] = edgePermutation[index]!;
  }
  return rankPermutation(
    udEdges,
    UD_EDGE_COUNT,
    0,
    'U/D edge permutation',
  );
}

/** Decode UDEdgePerm with a solved slice permutation as its canonical companion. */
export function unrankUDEdgePermutation(coordinate: number): Uint8Array {
  const udEdges = unrankPermutation(
    coordinate,
    UD_EDGE_COUNT,
    0,
    COORDINATE_SIZES.UDEdgePerm,
    'UDEdgePerm',
  );
  const edgePermutation = new Uint8Array(EDGE_COUNT);
  edgePermutation.set(udEdges);
  for (let position = UD_EDGE_COUNT; position < EDGE_COUNT; position += 1) {
    edgePermutation[position] = position;
  }
  return edgePermutation;
}

/** Rank the four slice-edge cubies in the slice positions of a phase-2 state. */
export function rankSlicePermutation(edgePermutation: ArrayLike<number>): number {
  assertPhase2EdgePermutation(edgePermutation);
  const sliceEdges = new Uint8Array(SLICE_EDGE_COUNT);
  for (let index = 0; index < SLICE_EDGE_COUNT; index += 1) {
    sliceEdges[index] = edgePermutation[UD_EDGE_COUNT + index]!;
  }
  return rankPermutation(
    sliceEdges,
    SLICE_EDGE_COUNT,
    SLICE_EDGE_FIRST,
    'slice edge permutation',
  );
}

/** Decode SlicePerm with solved U/D edges as its canonical companion. */
export function unrankSlicePermutation(coordinate: number): Uint8Array {
  const sliceEdges = unrankPermutation(
    coordinate,
    SLICE_EDGE_COUNT,
    SLICE_EDGE_FIRST,
    COORDINATE_SIZES.SlicePerm,
    'SlicePerm',
  );
  const edgePermutation = new Uint8Array(EDGE_COUNT);
  for (let position = 0; position < UD_EDGE_COUNT; position += 1) {
    edgePermutation[position] = position;
  }
  edgePermutation.set(sliceEdges, UD_EDGE_COUNT);
  return edgePermutation;
}
