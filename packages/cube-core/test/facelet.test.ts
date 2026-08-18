import { describe, expect, it } from 'vitest';

import {
  FACELET_COUNT,
  FACELET_ORDER,
  SOLVED_FACELETS,
  fromFacelets,
  toFacelets,
} from '../src/facelet.js';
import { createSolvedState, type CubeState } from '../src/state.js';

const SOLVED = SOLVED_FACELETS;

describe('facelet codec', () => {
  it('publishes the external encoding contract', () => {
    expect(FACELET_COUNT).toBe(54);
    expect(FACELET_ORDER).toBe('URFDLB');
    expect(SOLVED_FACELETS).toHaveLength(FACELET_COUNT);
  });

  it('encodes and decodes the canonical solved string', () => {
    expect(toFacelets(createSolvedState())).toBe(SOLVED);
    expect(toComparableState(fromFacelets(SOLVED))).toEqual(toComparableState(createSolvedState()));
  });

  it('round-trips a non-trivial valid cubie state', () => {
    const state: CubeState = {
      cp: new Uint8Array([1, 2, 0, 3, 4, 5, 6, 7]),
      co: new Uint8Array([1, 2, 0, 0, 0, 0, 0, 0]),
      ep: new Uint8Array([1, 2, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      eo: new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };

    const encoded = toFacelets(state);
    const decoded = fromFacelets(encoded);

    expect(toComparableState(decoded)).toEqual(toComparableState(state));
    expect(toFacelets(decoded)).toBe(encoded);
  });

  it('rejects a string whose length is not exactly 54', () => {
    expect(() => fromFacelets(SOLVED.slice(0, -1))).toThrow(/length/i);
    expect(() => fromFacelets(`${SOLVED}U`)).toThrow(/length/i);
  });

  it('rejects characters outside URFDLB', () => {
    expect(() => fromFacelets(`X${SOLVED.slice(1)}`)).toThrow(/character/i);
    expect(() => fromFacelets(`u${SOLVED.slice(1)}`)).toThrow(/character/i);
  });

  it('requires exactly nine stickers of each color', () => {
    expect(() => fromFacelets(`R${SOLVED.slice(1)}`)).toThrow(/exactly 9/i);
  });

  it('requires the six fixed centers', () => {
    const swappedCenters = swapCharacters(SOLVED, 4, 13);
    expect(() => fromFacelets(swappedCenters)).toThrow(/center/i);
  });

  it('rejects a single twisted corner', () => {
    const facelets = SOLVED.split('');
    [facelets[8], facelets[9], facelets[20]] = [facelets[9]!, facelets[20]!, facelets[8]!];

    expect(() => fromFacelets(facelets.join(''))).toThrow(/not reachable/i);
  });

  it('rejects a single flipped edge', () => {
    const facelets = swapCharacters(SOLVED, 5, 10);
    expect(() => fromFacelets(facelets)).toThrow(/not reachable/i);
  });

  it('rejects a corner-only odd permutation', () => {
    const facelets = SOLVED.split('');
    const firstCorner: [string, string, string] = [facelets[8]!, facelets[9]!, facelets[20]!];
    const secondCorner: [string, string, string] = [
      facelets[6]!,
      facelets[18]!,
      facelets[38]!,
    ];
    [facelets[8], facelets[9], facelets[20]] = secondCorner;
    [facelets[6], facelets[18], facelets[38]] = firstCorner;

    expect(() => fromFacelets(facelets.join(''))).toThrow(/not reachable/i);
  });

  it('rejects U/D stickers placed on the wrong corner cubies', () => {
    // The two side colors still identify URF and DFR, so this specifically
    // verifies the U/D sticker instead of relying only on cubie invariants.
    const facelets = swapCharacters(SOLVED, 8, 29);
    expect(() => fromFacelets(facelets)).toThrow(/inconsistent/i);
  });

  it('refuses to encode an invalid cubie state', () => {
    const state = createSolvedState();
    state.co[0] = 1;
    expect(() => toFacelets(state)).toThrow(/invalid cube state/i);
  });
});

function swapCharacters(value: string, first: number, second: number): string {
  const characters = value.split('');
  [characters[first], characters[second]] = [characters[second]!, characters[first]!];
  return characters.join('');
}

function toComparableState(state: CubeState): Record<keyof CubeState, number[]> {
  return {
    cp: Array.from(state.cp),
    co: Array.from(state.co),
    ep: Array.from(state.ep),
    eo: Array.from(state.eo),
  };
}
