import { assertValidState, CENTER_COUNT, type CubeState } from './state.js';

export type FaceletColor = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';

export const FACELET_COUNT = 54;
export const FACELET_ORDER = 'URFDLB' as const;
export const SOLVED_FACELETS =
  'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB' as const;

/**
 * Kociemba corner order: URF, UFL, ULB, UBR, DFR, DLF, DBL, DRB.
 * Each tuple lists the three sticker indices in orientation order.
 */
const CORNER_FACELETS = [
  [8, 9, 20],
  [6, 18, 38],
  [0, 36, 47],
  [2, 45, 11],
  [29, 26, 15],
  [27, 44, 24],
  [33, 53, 42],
  [35, 17, 51],
] as const;

const CORNER_COLORS = [
  ['U', 'R', 'F'],
  ['U', 'F', 'L'],
  ['U', 'L', 'B'],
  ['U', 'B', 'R'],
  ['D', 'F', 'R'],
  ['D', 'L', 'F'],
  ['D', 'B', 'L'],
  ['D', 'R', 'B'],
] as const satisfies readonly (readonly FaceletColor[])[];

/**
 * Kociemba edge order: UR, UF, UL, UB, DR, DF, DL, DB, FR, FL, BL, BR.
 */
const EDGE_FACELETS = [
  [5, 10],
  [7, 19],
  [3, 37],
  [1, 46],
  [32, 16],
  [28, 25],
  [30, 43],
  [34, 52],
  [23, 12],
  [21, 41],
  [50, 39],
  [48, 14],
] as const;

const EDGE_COLORS = [
  ['U', 'R'],
  ['U', 'F'],
  ['U', 'L'],
  ['U', 'B'],
  ['D', 'R'],
  ['D', 'F'],
  ['D', 'L'],
  ['D', 'B'],
  ['F', 'R'],
  ['F', 'L'],
  ['B', 'L'],
  ['B', 'R'],
] as const satisfies readonly (readonly FaceletColor[])[];

const CENTERS = [
  [4, 'U'],
  [13, 'R'],
  [22, 'F'],
  [31, 'D'],
  [40, 'L'],
  [49, 'B'],
] as const satisfies readonly (readonly [number, FaceletColor])[];

const FACELET_COLORS = ['U', 'R', 'F', 'D', 'L', 'B'] as const;

/** Convert a valid cubie state to a Kociemba-order URFDLB facelet string. */
export function toFacelets(state: CubeState): string {
  assertValidState(state);
  return encodeFacelets(state);
}

/** Encoding half of {@link toFacelets}, for callers that already validated. */
function encodeFacelets(state: CubeState): string {
  const facelets = new Array<string>(FACELET_COUNT);
  // Centers are state, not a constant: slice moves rotate four of them at a
  // time, so which colour sits in the middle of a face is a fact about the
  // cube rather than about the notation.
  for (let position = 0; position < CENTER_COUNT; position += 1) {
    facelets[CENTERS[position]![0]] = FACELET_COLORS[state.centers[position]!]!;
  }

  for (let position = 0; position < CORNER_FACELETS.length; position += 1) {
    const cubie = state.cp[position]!;
    const orientation = state.co[position]!;
    const positionFacelets = CORNER_FACELETS[position]!;
    const cubieColors = CORNER_COLORS[cubie]!;

    for (let sticker = 0; sticker < 3; sticker += 1) {
      const facelet = positionFacelets[(sticker + orientation) % 3]!;
      facelets[facelet] = cubieColors[sticker]!;
    }
  }

  for (let position = 0; position < EDGE_FACELETS.length; position += 1) {
    const cubie = state.ep[position]!;
    const orientation = state.eo[position]!;
    const positionFacelets = EDGE_FACELETS[position]!;
    const cubieColors = EDGE_COLORS[cubie]!;

    for (let sticker = 0; sticker < 2; sticker += 1) {
      const facelet = positionFacelets[(sticker + orientation) % 2]!;
      facelets[facelet] = cubieColors[sticker]!;
    }
  }

  return facelets.join('');
}

/** Parse and validate a Kociemba-order URFDLB facelet string. */
export function fromFacelets(facelets: string): CubeState {
  validateFaceletText(facelets);

  const cp = new Uint8Array(CORNER_FACELETS.length);
  const co = new Uint8Array(CORNER_FACELETS.length);
  const ep = new Uint8Array(EDGE_FACELETS.length);
  const eo = new Uint8Array(EDGE_FACELETS.length);
  const centers = new Uint8Array(CENTER_COUNT);

  for (let position = 0; position < CENTER_COUNT; position += 1) {
    const color = facelets[CENTERS[position]![0]] as FaceletColor;
    centers[position] = FACELET_COLORS.indexOf(color);
  }

  for (let position = 0; position < CORNER_FACELETS.length; position += 1) {
    const positionFacelets = CORNER_FACELETS[position]!;
    let orientation = -1;

    for (let sticker = 0; sticker < 3; sticker += 1) {
      const color = facelets[positionFacelets[sticker]!]!;
      if (color === 'U' || color === 'D') {
        orientation = sticker;
        break;
      }
    }

    if (orientation < 0) {
      throw new Error(`Invalid facelet string: corner position ${position} has no U/D sticker`);
    }

    const secondColor = facelets[positionFacelets[(orientation + 1) % 3]!]!;
    const thirdColor = facelets[positionFacelets[(orientation + 2) % 3]!]!;
    let cubie = -1;

    for (let candidate = 0; candidate < CORNER_COLORS.length; candidate += 1) {
      const candidateColors = CORNER_COLORS[candidate]!;
      if (candidateColors[1] === secondColor && candidateColors[2] === thirdColor) {
        cubie = candidate;
        break;
      }
    }

    if (cubie < 0) {
      throw new Error(`Invalid facelet string: unrecognized corner at position ${position}`);
    }

    cp[position] = cubie;
    co[position] = orientation;
  }

  for (let position = 0; position < EDGE_FACELETS.length; position += 1) {
    const positionFacelets = EDGE_FACELETS[position]!;
    const firstColor = facelets[positionFacelets[0]]!;
    const secondColor = facelets[positionFacelets[1]]!;
    let cubie = -1;
    let orientation = -1;

    for (let candidate = 0; candidate < EDGE_COLORS.length; candidate += 1) {
      const candidateColors = EDGE_COLORS[candidate]!;
      if (candidateColors[0] === firstColor && candidateColors[1] === secondColor) {
        cubie = candidate;
        orientation = 0;
        break;
      }
      if (candidateColors[0] === secondColor && candidateColors[1] === firstColor) {
        cubie = candidate;
        orientation = 1;
        break;
      }
    }

    if (cubie < 0) {
      throw new Error(`Invalid facelet string: unrecognized edge at position ${position}`);
    }

    ep[position] = cubie;
    eo[position] = orientation;
  }

  const state: CubeState = { cp, co, ep, eo, centers };
  try {
    assertValidState(state);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid facelet string: cubie state is not reachable (${detail})`);
  }

  // Corner identification uses the two non-U/D stickers, as in Kociemba's
  // codec. Comparing the canonical reconstruction also proves that the U/D
  // sticker itself was the right one rather than merely one of the two axes.
  if (encodeFacelets(state) !== facelets) {
    throw new Error('Invalid facelet string: stickers are inconsistent with the decoded cubies');
  }

  return state;
}

function validateFaceletText(facelets: string): void {
  if (typeof facelets !== 'string') {
    throw new TypeError('Facelet value must be a string');
  }
  if (facelets.length !== FACELET_COUNT) {
    throw new Error(`Invalid facelet string length: expected ${FACELET_COUNT}, got ${facelets.length}`);
  }

  const invalidIndex = facelets.search(/[^URFDLB]/);
  if (invalidIndex !== -1) {
    throw new Error(
      `Invalid facelet character ${JSON.stringify(facelets[invalidIndex])} at index ${invalidIndex}`,
    );
  }

  const counts: Record<FaceletColor, number> = { U: 0, R: 0, F: 0, D: 0, L: 0, B: 0 };
  for (const character of facelets) {
    const color = character as FaceletColor;
    counts[color] += 1;
  }
  for (const color of FACELET_COLORS) {
    if (counts[color] !== 9) {
      throw new Error(`Invalid facelet color count: ${color} must occur exactly 9 times`);
    }
  }

  // Which colour sits on which face is now free, but the six centers still
  // have to be six different colours. Whether that arrangement is one a real
  // cube can reach is settled later, by assertValidState.
  const seenCenters = new Set<string>();
  for (const [index] of CENTERS) {
    const color = facelets[index]!;
    if (seenCenters.has(color)) {
      throw new Error(`Invalid facelet centers: ${color} appears on two faces`);
    }
    seenCenters.add(color);
  }
}
