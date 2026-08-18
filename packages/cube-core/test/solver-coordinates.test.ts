import { describe, expect, it } from 'vitest';

import {
  COORDINATE_SIZES,
  rankCornerOrientation,
  rankCornerPermutation,
  rankEdgeOrientation,
  rankSlicePermutation,
  rankUDEdgePermutation,
  rankUDSlice,
  unrankCornerOrientation,
  unrankCornerPermutation,
  unrankEdgeOrientation,
  unrankSlicePermutation,
  unrankUDEdgePermutation,
  unrankUDSlice,
} from '../src/solver/index.js';

function assertPermutation(
  values: Uint8Array,
  expectedLength: number,
  firstValue = 0,
): void {
  if (values.length !== expectedLength) {
    throw new Error(`expected permutation length ${expectedLength}, got ${values.length}`);
  }
  const seen = new Uint8Array(expectedLength);
  for (const value of values) {
    const normalized = value - firstValue;
    if (normalized < 0 || normalized >= expectedLength || seen[normalized] !== 0) {
      throw new Error(`invalid permutation value ${value}`);
    }
    seen[normalized] = 1;
  }
}

function assertExhaustiveRoundTrip(
  size: number,
  unrank: (coordinate: number) => Uint8Array,
  rank: (decoded: Uint8Array) => number,
  validate: (decoded: Uint8Array) => void,
): void {
  for (let coordinate = 0; coordinate < size; coordinate += 1) {
    const decoded = unrank(coordinate);
    validate(decoded);
    const encoded = rank(decoded);
    if (encoded !== coordinate) {
      throw new Error(`coordinate ${coordinate} round-tripped as ${encoded}`);
    }
  }
}

describe('solver coordinate conventions', () => {
  it('uses zero for all solved coordinates and documents digit order', () => {
    const solvedCorners = Uint8Array.from({ length: 8 }, (_unused, index) => index);
    const solvedEdges = Uint8Array.from({ length: 12 }, (_unused, index) => index);

    expect(rankCornerOrientation(new Uint8Array(8))).toBe(0);
    expect(rankEdgeOrientation(new Uint8Array(12))).toBe(0);
    expect(rankUDSlice(solvedEdges)).toBe(0);
    expect(rankCornerPermutation(solvedCorners)).toBe(0);
    expect(rankUDEdgePermutation(solvedEdges)).toBe(0);
    expect(rankSlicePermutation(solvedEdges)).toBe(0);

    expect(unrankCornerOrientation(729)).toEqual(
      Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 2),
    );
    expect(unrankEdgeOrientation(1_024)).toEqual(
      Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
    );

    expect(rankCornerPermutation(Uint8Array.of(0, 2, 1, 3, 4, 5, 6, 7))).toBe(
      720,
    );
    expect(
      rankUDEdgePermutation(Uint8Array.of(0, 2, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
    ).toBe(720);
    expect(
      rankSlicePermutation(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 9, 11)),
    ).toBe(2);
    expect(
      rankUDSlice(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 8, 7, 9, 10, 11)),
    ).toBe(1);
  });

  it('maps reverse permutations and the opposite slice placement to the maxima', () => {
    expect(rankCornerPermutation(Uint8Array.of(7, 6, 5, 4, 3, 2, 1, 0))).toBe(
      COORDINATE_SIZES.CP - 1,
    );
    expect(
      rankUDEdgePermutation(Uint8Array.of(7, 6, 5, 4, 3, 2, 1, 0, 8, 9, 10, 11)),
    ).toBe(COORDINATE_SIZES.UDEdgePerm - 1);
    expect(
      rankSlicePermutation(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 11, 10, 9, 8)),
    ).toBe(COORDINATE_SIZES.SlicePerm - 1);
    expect(
      rankUDSlice(Uint8Array.of(8, 9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7)),
    ).toBe(COORDINATE_SIZES.UDSlice - 1);
  });
});

describe('exhaustive coordinate rank/unrank round trips', () => {
  it('covers every CO value', () => {
    assertExhaustiveRoundTrip(
      COORDINATE_SIZES.CO,
      unrankCornerOrientation,
      rankCornerOrientation,
      (orientations) => {
        if (orientations.length !== 8) throw new Error('CO must decode to 8 values');
        let sum = 0;
        for (const value of orientations) {
          if (value > 2) throw new Error(`invalid corner orientation ${value}`);
          sum += value;
        }
        if (sum % 3 !== 0) throw new Error('invalid corner orientation sum');
      },
    );
  });

  it('covers every EO value', () => {
    assertExhaustiveRoundTrip(
      COORDINATE_SIZES.EO,
      unrankEdgeOrientation,
      rankEdgeOrientation,
      (orientations) => {
        if (orientations.length !== 12) throw new Error('EO must decode to 12 values');
        let sum = 0;
        for (const value of orientations) {
          if (value > 1) throw new Error(`invalid edge orientation ${value}`);
          sum += value;
        }
        if (sum % 2 !== 0) throw new Error('invalid edge orientation sum');
      },
    );
  });

  it('covers every UDSlice value', () => {
    assertExhaustiveRoundTrip(
      COORDINATE_SIZES.UDSlice,
      unrankUDSlice,
      rankUDSlice,
      (edgePermutation) => {
        assertPermutation(edgePermutation, 12);
        let sliceEdges = 0;
        for (const edge of edgePermutation) {
          if (edge >= 8) sliceEdges += 1;
        }
        if (sliceEdges !== 4) throw new Error('UDSlice must select four positions');
      },
    );
  });

  it('covers every CP value', () => {
    assertExhaustiveRoundTrip(
      COORDINATE_SIZES.CP,
      unrankCornerPermutation,
      rankCornerPermutation,
      (permutation) => assertPermutation(permutation, 8),
    );
  });

  it('covers every UDEdgePerm value', () => {
    assertExhaustiveRoundTrip(
      COORDINATE_SIZES.UDEdgePerm,
      unrankUDEdgePermutation,
      rankUDEdgePermutation,
      (permutation) => {
        assertPermutation(permutation, 12);
        for (let position = 0; position < 8; position += 1) {
          if (permutation[position]! >= 8) {
            throw new Error('slice edge escaped into a U/D position');
          }
        }
      },
    );
  });

  it('covers every SlicePerm value', () => {
    assertExhaustiveRoundTrip(
      COORDINATE_SIZES.SlicePerm,
      unrankSlicePermutation,
      rankSlicePermutation,
      (permutation) => assertPermutation(permutation, 12),
    );
  });
});

describe('coordinate input validation', () => {
  it('rejects malformed orientation components', () => {
    expect(() => rankCornerOrientation(new Uint8Array(7))).toThrow(/8 values/);
    expect(() => rankCornerOrientation(Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 0))).toThrow(
      /\[0, 2\]/,
    );
    expect(() => rankCornerOrientation(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toThrow(
      /sum/,
    );
    expect(() => rankEdgeOrientation(new Uint8Array(11))).toThrow(/12 values/);
    expect(() => rankEdgeOrientation(Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(
      /\[0, 1\]/,
    );
    expect(() => rankEdgeOrientation(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(
      /sum/,
    );
  });

  it('rejects malformed permutations and non-phase-2 edge placement', () => {
    expect(() => rankCornerPermutation(Uint8Array.of(0, 0, 2, 3, 4, 5, 6, 7))).toThrow(
      /duplicate/,
    );
    expect(() => rankUDSlice(Uint8Array.of(0, 1, 2))).toThrow(/12 values/);
    expect(() =>
      rankUDEdgePermutation(Uint8Array.of(8, 1, 2, 3, 4, 5, 6, 7, 0, 9, 10, 11)),
    ).toThrow(/U\/D positions/);
    expect(() =>
      rankSlicePermutation(Uint8Array.of(8, 1, 2, 3, 4, 5, 6, 7, 0, 9, 10, 11)),
    ).toThrow(/U\/D positions/);
  });

  it.each([
    [-1, unrankCornerOrientation],
    [COORDINATE_SIZES.CO, unrankCornerOrientation],
    [0.5, unrankEdgeOrientation],
    [Number.NaN, unrankUDSlice],
    [COORDINATE_SIZES.CP, unrankCornerPermutation],
    [COORDINATE_SIZES.UDEdgePerm, unrankUDEdgePermutation],
    [COORDINATE_SIZES.SlicePerm, unrankSlicePermutation],
  ] as const)('rejects out-of-range coordinate %s', (coordinate, unrank) => {
    expect(() => unrank(coordinate)).toThrow(RangeError);
  });
});
