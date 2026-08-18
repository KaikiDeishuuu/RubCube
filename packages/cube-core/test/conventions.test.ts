import { describe, expect, it } from 'vitest';

import { fromFacelets, toFacelets } from '../src/facelet.js';
import { applyMove, type Face } from '../src/moves.js';

const URFDLB = ['U', 'R', 'F', 'D', 'L', 'B'] as const;

type FaceletNet = Readonly<Record<(typeof URFDLB)[number], string>>;

/** Join six slash-separated 3x3 grids in Kociemba's URFDLB string order. */
function facelets(net: FaceletNet): string {
  return URFDLB.map((face) => net[face].replaceAll('/', '')).join('');
}

// Independent sticker-level known answer for the position after R U F B L D.
// Keeping every face non-uniform makes the face's own clockwise rotation, the
// adjacent strip direction, and cubie orientation observable in every case.
const START = facelets({
  U: 'LRR/LUU/LLD',
  R: 'FBB/FRD/LDR',
  F: 'BFR/UFR/BDD',
  D: 'DFF/LDR/LBU',
  L: 'UUU/LLF/BBR',
  B: 'UUF/BBD/FRD',
});

const CLOCKWISE_GOLDENS = [
  [
    'U',
    facelets({
      U: 'LLL/LUR/DUR',
      R: 'UUF/FRD/LDR',
      F: 'FBB/UFR/BDD',
      D: 'DFF/LDR/LBU',
      L: 'BFR/LLF/BBR',
      B: 'UUU/BBD/FRD',
    }),
  ],
  [
    'D',
    facelets({
      U: 'LRR/LUU/LLD',
      R: 'FBB/FRD/BDD',
      F: 'BFR/UFR/BBR',
      D: 'LLD/BDF/URF',
      L: 'UUU/LLF/FRD',
      B: 'UUF/BBD/LDR',
    }),
  ],
  [
    'L',
    facelets({
      U: 'DRR/DUU/FLD',
      R: 'FBB/FRD/LDR',
      F: 'LFR/LFR/LDD',
      D: 'BFF/UDR/BBU',
      L: 'BLU/BLU/RFU',
      B: 'UUL/BBL/FRD',
    }),
  ],
  [
    'R',
    facelets({
      U: 'LRR/LUR/LLD',
      R: 'LFF/DRB/RDB',
      F: 'BFF/UFR/BDU',
      D: 'DFF/LDB/LBU',
      L: 'UUU/LLF/BBR',
      B: 'DUF/UBD/RRD',
    }),
  ],
  [
    'F',
    facelets({
      U: 'LRR/LUU/RFU',
      R: 'LBB/LRD/DDR',
      F: 'BUB/DFF/DRR',
      D: 'LFF/LDR/LBU',
      L: 'UUD/LLF/BBF',
      B: 'UUF/BBD/FRD',
    }),
  ],
  [
    'B',
    facelets({
      U: 'BDR/LUU/LLD',
      R: 'FBU/FRB/LDL',
      F: 'BFR/UFR/BDD',
      D: 'DFF/LDR/ULB',
      L: 'RUU/RLF/LBR',
      B: 'FBU/RBU/DDF',
    }),
  ],
] as const satisfies readonly (readonly [Face, string])[];

describe('standard Kociemba/Singmaster conventions', () => {
  it.each(CLOCKWISE_GOLDENS)(
    '%s turns clockwise when viewed from outside that face',
    (face, expected) => {
      const actual = toFacelets(applyMove(fromFacelets(START), { face, turns: 1 }));
      expect(actual).toBe(expected);
    },
  );

  it('rejects color-balanced stickers that duplicate physical edge cubies', () => {
    const solved = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
    const impossible = solved.split('');

    // Swapping R8 and F2 preserves all six counts and all centers, but creates
    // two UR edges and two DF edges while removing UF and DR.
    [impossible[16], impossible[19]] = [impossible[19]!, impossible[16]!];

    expect(() => fromFacelets(impossible.join(''))).toThrow(/ep must be a permutation/i);
  });
});
