import { describe, expect, it } from 'vitest';

import { fromFacelets, toFacelets } from '../src/facelet.js';
import {
  ALL_HTM_MOVES,
  applyMove,
  applyMoves,
  isFaceMove,
  isMove,
  layerAxis,
  layersAreDisjoint,
  parseMoves,
  serializeMoves,
  SLICES,
  type Layer,
} from '../src/moves.js';
import {
  createSolvedState,
  isSolved,
  statesEqual,
  validateState,
  type CubeState,
} from '../src/state.js';

/** True when all six faces are a single colour, whatever colour that is. */
function facesAreUniform(state: CubeState): boolean {
  const facelets = toFacelets(state);
  for (let face = 0; face < 6; face += 1) {
    const block = facelets.slice(face * 9, face * 9 + 9);
    if ([...block].some((sticker) => sticker !== block[0])) return false;
  }
  return true;
}

describe('slice notation', () => {
  it('parses and serialises every slice turn', () => {
    const moves = parseMoves("M E2 S'");
    expect(moves).toEqual([
      { face: 'M', turns: 1 },
      { face: 'E', turns: 2 },
      { face: 'S', turns: 3 },
    ]);
    expect(serializeMoves(moves)).toBe("M E2 S'");
  });

  it('accepts slices as moves but not as face moves', () => {
    expect(isMove({ face: 'M', turns: 1 })).toBe(true);
    expect(isFaceMove({ face: 'M', turns: 1 })).toBe(false);
    expect(isFaceMove({ face: 'R', turns: 1 })).toBe(true);
  });

  it('keeps slices out of the face-turn move set', () => {
    // The solver coordinates and the scramble grammar are both defined over
    // these 18 moves; a slice reaching either would be a silent corruption.
    expect(ALL_HTM_MOVES).toHaveLength(18);
    expect(ALL_HTM_MOVES.every((move) => isFaceMove(move))).toBe(true);
  });

  it('puts each slice on the axis of the face it follows', () => {
    expect(layerAxis('M')).toBe('LR');
    expect(layerAxis('E')).toBe('UD');
    expect(layerAxis('S')).toBe('FB');
  });

  it('treats every distinct layer on one axis as concurrent-safe', () => {
    // R, M and L are pairwise disjoint, so an axis now carries three at once.
    expect(layersAreDisjoint('R', 'M')).toBe(true);
    expect(layersAreDisjoint('M', 'L')).toBe(true);
    expect(layersAreDisjoint('R', 'L')).toBe(true);
    expect(layersAreDisjoint('R', 'R')).toBe(false);
    expect(layersAreDisjoint('R', 'U')).toBe(false);
    expect(layersAreDisjoint('M', 'E')).toBe(false);
  });
});

describe('slice move application', () => {
  it.each([...SLICES])('%s four times is identity', (slice) => {
    const result = applyMoves(createSolvedState(), `${slice} ${slice} ${slice} ${slice}`);
    expect(isSolved(result)).toBe(true);
  });

  it.each([...SLICES])('%s leaves every corner untouched', (slice) => {
    const solved = createSolvedState();
    const turned = applyMove(solved, { face: slice, turns: 1 });
    expect(Array.from(turned.cp)).toEqual(Array.from(solved.cp));
    expect(Array.from(turned.co)).toEqual(Array.from(solved.co));
  });

  it.each([...SLICES])('%s moves exactly four edges and four centres', (slice) => {
    const solved = createSolvedState();
    const turned = applyMove(solved, { face: slice, turns: 1 });
    const movedEdges = [...turned.ep].filter((cubie, index) => cubie !== index);
    const movedCentres = [...turned.centers].filter((cubie, index) => cubie !== index);
    expect(movedEdges).toHaveLength(4);
    expect(movedCentres).toHaveLength(4);
  });

  it('leaves a single slice turn unsolved, and unsolvable by face turns', () => {
    const turned = applyMove(createSolvedState(), { face: 'M', turns: 1 });
    expect(isSolved(turned)).toBe(false);
    expect(facesAreUniform(turned)).toBe(false);
    // No face turn moves a centre, so the rotated centres are permanent until
    // another slice turn undoes them.
    for (const move of ALL_HTM_MOVES) {
      expect(Array.from(applyMove(turned, move).centers)).toEqual(
        Array.from(turned.centers),
      );
    }
  });

  it('inverts a slice turn back to solved', () => {
    const state = applyMoves(createSolvedState(), "M E S S' E' M'");
    expect(isSolved(state)).toBe(true);
  });
});

describe('slice and face turns agree on whole-cube rotations', () => {
  // x = R M' L', y = U E' D', z = F S B'. Each is a rotation of the entire
  // cube, so it must leave every face uniform while moving the centres. This
  // checks the derived slice tables against the long-standing face tables
  // through a law neither was fitted to.
  it.each([
    ['x', "R M' L'"],
    ['y', "U E' D'"],
    ['z', "F S B'"],
  ])('%s is a whole-cube rotation', (_name, sequence) => {
    const rotated = applyMoves(createSolvedState(), sequence);
    expect(facesAreUniform(rotated)).toBe(true);
    expect(isSolved(rotated)).toBe(false);
    expect(Array.from(rotated.centers)).not.toEqual([0, 1, 2, 3, 4, 5]);
  });

  it.each([
    ['x', "R M' L'"],
    ['y', "U E' D'"],
    ['z', "F S B'"],
  ])('%s has order four', (_name, sequence) => {
    const four = [sequence, sequence, sequence, sequence].join(' ');
    expect(isSolved(applyMoves(createSolvedState(), four))).toBe(true);
  });

  it('reaches all 24 orientations from the three rotations', () => {
    const seen = new Set<string>();
    const frontier = [createSolvedState()];
    seen.add(Array.from(frontier[0]!.centers).join(''));
    while (frontier.length > 0) {
      const state = frontier.pop()!;
      for (const sequence of ["R M' L'", "U E' D'", "F S B'"]) {
        const next = applyMoves(state, sequence);
        const key = Array.from(next.centers).join('');
        if (seen.has(key)) continue;
        seen.add(key);
        frontier.push(next);
      }
    }
    expect(seen.size).toBe(24);
  });
});

describe('facelets carry the centre arrangement', () => {
  it('round-trips a state whose centres have been rotated', () => {
    const state = applyMoves(createSolvedState(), "M E' S2 R U'");
    const encoded = toFacelets(state);
    expect(statesEqual(fromFacelets(encoded), state)).toBe(true);
    expect(toFacelets(fromFacelets(encoded))).toBe(encoded);
  });

  it('shows a rotated centre in the middle of the face', () => {
    // M follows L, so the U centre is replaced by the one from B.
    const turned = applyMove(createSolvedState(), { face: 'M', turns: 1 });
    expect(toFacelets(turned)[4]).toBe('B');
  });

  it('rejects a mirrored centre arrangement that no move can reach', () => {
    const state = createSolvedState();
    // Swap the R and F centres: still a permutation, opposites still opposite,
    // but the axes are now left-handed.
    state.centers.set([0, 2, 1, 3, 5, 4]);
    const codes = validateState(state).map((issue) => issue.code);
    expect(codes).toContain('INVALID_CENTER_ROTATION');
  });

  it('rejects centres that break the opposite-face pairing', () => {
    const state = createSolvedState();
    state.centers.set([1, 0, 2, 3, 4, 5]);
    expect(validateState(state).map((issue) => issue.code)).toContain(
      'INVALID_CENTER_ROTATION',
    );
  });
});
