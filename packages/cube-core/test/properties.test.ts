import { describe, expect, it } from 'vitest';

import { fromFacelets, toFacelets } from '../src/facelet.js';
import { applyMoves, invertMoves } from '../src/moves.js';
import { generateRandomMoves, generateRandomState } from '../src/scramble.js';
import {
  assertValidState,
  createSolvedState,
  statesEqual,
} from '../src/state.js';

describe('seeded M0 properties', () => {
  it('preserves reachability, codec identity, and inverse identity', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const initial = generateRandomState(seed);
      const moves = generateRandomMoves(40, seed ^ 0x5f37_59df);
      const moved = applyMoves(initial, moves);

      expect(() => assertValidState(moved)).not.toThrow();
      expect(statesEqual(fromFacelets(toFacelets(moved)), moved)).toBe(true);
      expect(statesEqual(applyMoves(moved, invertMoves(moves)), initial)).toBe(true);
    }
  });

  it('keeps every face turn in the legal cube group', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const moves = generateRandomMoves(100, seed);
      const moved = applyMoves(createSolvedState(), moves);
      expect(() => assertValidState(moved)).not.toThrow();
    }
  });
});
