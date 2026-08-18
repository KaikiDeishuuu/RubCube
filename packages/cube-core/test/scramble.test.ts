import { describe, expect, it } from 'vitest';

import { layerAxis, serializeMoves } from '../src/moves.js';
import { fromFacelets, toFacelets } from '../src/facelet.js';
import { mulberry32, normalizeSeed, randomInt } from '../src/rng.js';
import {
  DEFAULT_RANDOM_MOVE_COUNT,
  generateRandomMoves,
  generateRandomState,
  randomMoveScramble,
} from '../src/scramble.js';
import {
  assertValidState,
  isSolved,
  statesEqual,
} from '../src/state.js';

describe('mulberry32', () => {
  it('matches the canonical mulberry32 stream', () => {
    const random = mulberry32(1);

    expect(Array.from({ length: 5 }, random)).toEqual([
      0.6270739405881613,
      0.002735721180215478,
      0.5274470399599522,
      0.9810509674716741,
      0.9683778982143849,
    ]);
  });

  it('replays the same stream for the same seed', () => {
    const first = mulberry32(0x1234_5678);
    const second = mulberry32(0x1234_5678);

    expect(Array.from({ length: 16 }, first)).toEqual(
      Array.from({ length: 16 }, second),
    );
  });

  it('uses explicit modulo-2^32 seed semantics', () => {
    expect(normalizeSeed(-1)).toBe(0xffff_ffff);
    expect(normalizeSeed(0x1_0000_0001)).toBe(1);

    const wrappedNegative = mulberry32(-1);
    const uint32 = mulberry32(0xffff_ffff);
    expect(Array.from({ length: 8 }, wrappedNegative)).toEqual(
      Array.from({ length: 8 }, uint32),
    );

    const wrappedLarge = mulberry32(0x1_0000_0001);
    const one = mulberry32(1);
    expect(Array.from({ length: 8 }, wrappedLarge)).toEqual(
      Array.from({ length: 8 }, one),
    );
  });

  it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid seed %s',
    (seed) => {
      expect(() => mulberry32(seed)).toThrow(RangeError);
    },
  );
});

describe('randomInt', () => {
  it('samples inside the requested half-open integer range', () => {
    expect(randomInt(() => 0, 18)).toBe(0);
    expect(randomInt(() => 0.999_999, 18)).toBe(17);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid upper bound %s',
    (maxExclusive) => {
      expect(() => randomInt(() => 0, maxExclusive)).toThrow(RangeError);
    },
  );

  it.each([-0.01, 1, NaN, Infinity])(
    'rejects invalid PRNG result %s',
    (sample) => {
      expect(() => randomInt(() => sample, 18)).toThrow(RangeError);
    },
  );
});

describe('generateRandomMoves', () => {
  it('is reproducible from a numeric seed', () => {
    const first = generateRandomMoves(40, 20260817);
    const second = generateRandomMoves(40, 20260817);

    expect(serializeMoves(first)).toBe(serializeMoves(second));
  });

  it('normally produces different scrambles for different seeds', () => {
    const first = serializeMoves(generateRandomMoves(40, 11));
    const second = serializeMoves(generateRandomMoves(40, 12));

    expect(first).not.toBe(second);
  });

  it('accepts an injected PRNG as well as a seed', () => {
    const fromSeed = generateRandomMoves(50, 73);
    const fromGenerator = generateRandomMoves(50, mulberry32(73));

    expect(fromGenerator).toEqual(fromSeed);
  });

  it('never repeats a face or uses one axis three times in a row', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const moves = generateRandomMoves(100, seed);

      for (let index = 1; index < moves.length; index += 1) {
        expect(moves[index]?.face).not.toBe(moves[index - 1]?.face);

        if (index >= 2) {
          const currentAxis = layerAxis(moves[index]!.face);
          const previousAxis = layerAxis(moves[index - 1]!.face);
          const twoBackAxis = layerAxis(moves[index - 2]!.face);
          expect(
            currentAxis === previousAxis && previousAxis === twoBackAxis,
          ).toBe(false);
        }
      }
    }
  });

  it('handles zero and the default length', () => {
    expect(generateRandomMoves(0, 1)).toEqual([]);
    expect(generateRandomMoves(undefined, 1)).toHaveLength(
      DEFAULT_RANDOM_MOVE_COUNT,
    );
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid length %s',
    (length) => {
      expect(() => generateRandomMoves(length, 1)).toThrow(RangeError);
    },
  );

  it('validates values returned by an injected PRNG', () => {
    expect(() => generateRandomMoves(1, () => 1)).toThrow(RangeError);
  });

  it('keeps the random-move-specific alias deterministic', () => {
    expect(randomMoveScramble(20, 99)).toEqual(generateRandomMoves(20, 99));
  });
});

describe('generateRandomState', () => {
  it('is reproducible without sharing mutable arrays', () => {
    const first = generateRandomState(20260817);
    const second = generateRandomState(20260817);

    expect(statesEqual(first, second)).toBe(true);
    expect(first.cp).not.toBe(second.cp);
    expect(first.co).not.toBe(second.co);
    expect(first.ep).not.toBe(second.ep);
    expect(first.eo).not.toBe(second.eo);
  });

  it('normally returns different states for different seeds', () => {
    expect(statesEqual(generateRandomState(11), generateRandomState(12))).toBe(false);
  });

  it('produces only reachable states across a broad seed sample', () => {
    let solvedCount = 0;
    for (let seed = 0; seed < 512; seed += 1) {
      const state = generateRandomState(seed);
      expect(() => assertValidState(state)).not.toThrow();
      if (isSolved(state)) solvedCount += 1;
    }
    expect(solvedCount).toBe(0);
  });

  it('round-trips through the public facelet representation', () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const state = generateRandomState(seed);
      expect(statesEqual(fromFacelets(toFacelets(state)), state)).toBe(true);
    }
  });

  it('accepts an injected PRNG and validates its samples', () => {
    expect(statesEqual(generateRandomState(73), generateRandomState(mulberry32(73)))).toBe(true);
    expect(() => generateRandomState(() => 1)).toThrow(RangeError);
  });
});
