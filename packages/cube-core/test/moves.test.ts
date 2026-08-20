import { describe, expect, it } from 'vitest';

import {
  ALL_HTM_MOVES,
  MoveParseError,
  applyMove,
  applyMoves,
  applyMovesInPlace,
  assertMove,
  cancelMoves,
  layerAxis,
  invertMove,
  invertMoves,
  isMove,
  oppositeFace,
  parseMove,
  parseMoves,
  serializeMove,
  serializeMoves,
} from '../src/moves.js';
import { generateRandomMoves } from '../src/scramble.js';
import {
  assertValidState,
  cloneState,
  createSolvedState,
  cubeStatesEqual,
  isSolved,
} from '../src/state.js';

describe('HTM notation', () => {
  it('round-trips all 18 permitted moves', () => {
    expect(ALL_HTM_MOVES).toHaveLength(18);
    expect(Object.isFrozen(ALL_HTM_MOVES)).toBe(true);
    for (const move of ALL_HTM_MOVES) {
      expect(Object.isFrozen(move)).toBe(true);
      expect(parseMove(serializeMove(move))).toEqual(move);
    }
  });

  it('parses whitespace-separated sequences strictly', () => {
    const moves = parseMoves("  R\tU2\nF'  ");
    expect(moves).toEqual([
      { face: 'R', turns: 1 },
      { face: 'U', turns: 2 },
      { face: 'F', turns: 3 },
    ]);
    expect(serializeMoves(moves)).toBe("R U2 F'");
    expect(parseMoves('   ')).toEqual([]);
  });

  it.each(['r', 'U3', "R2'", 'm', 'Uw', 'x', 'R,U', 'R’'])(
    'rejects invalid token %s',
    (token) => {
      expect(() => parseMoves(`U ${token}`)).toThrow(MoveParseError);
      try {
        parseMoves(`U ${token}`);
      } catch (error) {
        expect(error).toMatchObject({ token, tokenIndex: 1 });
      }
    },
  );

  it('rejects malformed runtime move values', () => {
    expect(isMove({ face: 'R', turns: 1 })).toBe(true);
    expect(isMove({ face: 'X', turns: 1 })).toBe(false);
    expect(isMove(null)).toBe(false);
    expect(() => assertMove({ face: 'R', turns: 4 })).toThrow(TypeError);
    expect(() => serializeMove({ face: 'R', turns: 4 } as never)).toThrow(TypeError);
    expect(() => parseMoves(null as never)).toThrow(TypeError);
  });
});

describe('move helpers', () => {
  it('maps axes and opposite faces', () => {
    expect(layerAxis('U')).toBe('UD');
    expect(layerAxis('R')).toBe('LR');
    expect(layerAxis('B')).toBe('FB');
    expect(oppositeFace('U')).toBe('D');
    expect(oppositeFace('L')).toBe('R');
    expect(oppositeFace('F')).toBe('B');
  });

  it('inverts single moves and sequences', () => {
    expect(invertMove({ face: 'U', turns: 1 })).toEqual({ face: 'U', turns: 3 });
    expect(invertMove({ face: 'R', turns: 2 })).toEqual({ face: 'R', turns: 2 });
    expect(serializeMoves(invertMoves(parseMoves("R U2 F'")))).toBe('F U2 R\'');
  });
});

describe('cubie move application', () => {
  it.each(['U', 'D', 'L', 'R', 'F', 'B'])('%s four times is identity', (face) => {
    const result = applyMoves(createSolvedState(), `${face} ${face} ${face} ${face}`);
    expect(isSolved(result)).toBe(true);
  });

  it('a sequence followed by its inverse is identity', () => {
    const sequence = parseMoves("R U R' U' F2 D L2 B'");
    const moved = applyMoves(createSolvedState(), sequence);
    const restored = applyMoves(moved, invertMoves(sequence));
    expect(isSolved(restored)).toBe(true);
  });

  it("the sexy move has order six", () => {
    const result = applyMoves(createSolvedState(), Array(6).fill("R U R' U'").join(' '));
    expect(isSolved(result)).toBe(true);
  });

  it('keeps the input immutable and the output legal', () => {
    const original = createSolvedState();
    const snapshot = cloneState(original);
    const moved = applyMove(original, { face: 'F', turns: 1 });
    expect(cubeStatesEqual(original, snapshot)).toBe(true);
    expect(cubeStatesEqual(moved, original)).toBe(false);
    expect(() => assertValidState(moved)).not.toThrow();
  });

  it('offers an explicit in-place path', () => {
    const state = createSolvedState();
    expect(applyMovesInPlace(state, "R R'")).toBe(state);
    expect(isSolved(state)).toBe(true);
  });

  it('does not partially apply an invalid parsed string', () => {
    const state = createSolvedState();
    expect(() => applyMovesInPlace(state, 'R nope U')).toThrow(MoveParseError);
    expect(isSolved(state)).toBe(true);
  });

  it('validates an entire move array before mutating', () => {
    const state = createSolvedState();
    const moves = [{ face: 'R', turns: 1 }, { face: 'U', turns: 9 }] as never;
    expect(() => applyMovesInPlace(state, moves)).toThrow(TypeError);
    expect(isSolved(state)).toBe(true);
  });

  it('composes every half and counter-clockwise table from its quarter turn', () => {
    // The 18 tables are composed once at load. Repeating the `turns: 1` table
    // uses only the hand-verified quarter turn, so this pins the derived ones
    // to it. A scrambled base keeps the orientation deltas observable.
    const base = applyMoves(createSolvedState(), "R U F' L2 D B R'");

    for (const move of ALL_HTM_MOVES) {
      const repeated = applyMoves(
        base,
        Array.from({ length: move.turns }, () => ({ face: move.face, turns: 1 } as const)),
      );
      expect(cubeStatesEqual(applyMove(base, move), repeated)).toBe(true);
    }
  });

  it('lands in-place results in the caller arrays for odd and even lengths', () => {
    // applyMovesInPlace ping-pongs through one scratch state; an odd move count
    // is the case that has to be copied back into the caller's buffers.
    for (const sequence of ['R', 'R U', 'R U F', "R U F D'"]) {
      const state = createSolvedState();
      const buffers = [state.cp, state.co, state.ep, state.eo];

      expect(applyMovesInPlace(state, sequence)).toBe(state);
      expect([state.cp, state.co, state.ep, state.eo]).toEqual(buffers);
      expect(cubeStatesEqual(state, applyMoves(createSolvedState(), sequence))).toBe(true);
    }
  });

  it('returns a state independent of its input for every sequence length', () => {
    const base = applyMoves(createSolvedState(), 'R U');

    for (const sequence of ['', 'F', "F D'", "F D' L B2"]) {
      const snapshot = cloneState(base);
      const result = applyMoves(base, sequence);

      expect(cubeStatesEqual(base, snapshot)).toBe(true);
      expect(result.cp).not.toBe(base.cp);
      expect(result.eo).not.toBe(base.eo);
      expect(() => assertValidState(result)).not.toThrow();
    }
  });
});


describe('cancelMoves', () => {
  const solved = createSolvedState();

  /** Reduction must preserve the cube, which is the only thing that matters. */
  function expectSameCube(notation: string): ReturnType<typeof parseMoves> {
    const moves = parseMoves(notation);
    const reduced = cancelMoves(moves);
    expect(
      cubeStatesEqual(applyMoves(solved, moves), applyMoves(solved, reduced)),
    ).toBe(true);
    return reduced;
  }

  it('leaves a sequence with nothing to collapse alone', () => {
    expect(serializeMoves(expectSameCube("R U R' U'"))).toBe("R U R' U'");
    expect(cancelMoves([])).toEqual([]);
  });

  it('merges adjacent turns of the same layer', () => {
    // The case a two-phase solver produces: one phase ends on R, the next
    // begins on R2, and together they are a single quarter turn.
    expect(serializeMoves(expectSameCube('R R2'))).toBe("R'");
    expect(serializeMoves(expectSameCube("R R'"))).toBe('');
    expect(serializeMoves(expectSameCube('R2 R2'))).toBe('');
    expect(serializeMoves(expectSameCube('R R R'))).toBe("R'");
  });

  it('reaches back past layers that commute with it', () => {
    // U and D share an axis and never touch the same cubie, so the U turns meet
    // through the D between them.
    expect(serializeMoves(expectSameCube('U D U2'))).toBe("U' D");
    expect(serializeMoves(expectSameCube('R M L R'))).toBe('R2 M L');
    // Three layers of one axis are all mutually transparent.
    expect(serializeMoves(expectSameCube("R M L R'"))).toBe('M L');
  });

  it('will not reach past a layer on another axis', () => {
    expect(serializeMoves(expectSameCube('R U R'))).toBe('R U R');
    expect(serializeMoves(expectSameCube('U R U'))).toBe('U R U');
  });

  it('collapses what a removal exposes', () => {
    // R and R' vanish, which puts the two U turns next to each other.
    expect(serializeMoves(expectSameCube("U R R' U"))).toBe('U2');
    expect(serializeMoves(expectSameCube("R U U' R'"))).toBe('');
  });

  it('returns moves of its own rather than the caller\'s', () => {
    const moves = parseMoves('R R2 U');
    const before = serializeMoves(moves);
    const reduced = cancelMoves(moves);
    expect(serializeMoves(moves)).toBe(before);
    // Every other move helper hands back fresh objects; a result that aliased
    // its input would be the one place a caller could not hold on to safely.
    for (const move of reduced) expect(moves).not.toContain(move);
  });

  it('rejects anything that is not a move', () => {
    expect(() => cancelMoves([{ face: 'X', turns: 1 }] as never)).toThrow(TypeError);
  });

  it('preserves the cube across long random sequences', () => {
    // Property rather than example: any reduction that changes the cube is a
    // bug no matter how plausible the output looks.
    for (let seed = 0; seed < 200; seed += 1) {
      const moves = generateRandomMoves(20, seed);
      const reduced = cancelMoves(moves);
      expect(reduced.length).toBeLessThanOrEqual(moves.length);
      expect(
        cubeStatesEqual(applyMoves(solved, moves), applyMoves(solved, reduced)),
      ).toBe(true);
    }
  });
});
