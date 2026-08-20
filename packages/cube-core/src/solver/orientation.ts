import {
  applyMoves,
  parseMoves,
  type Face,
  type FaceMove,
  type Move,
} from '../moves.js';
import {
  CENTER_COUNT,
  CENTER_NAMES,
  composeStates,
  createSolvedState,
  invertState,
  type CubeState,
} from '../state.js';

/**
 * Whole-cube orientation, and how to get rid of it before searching.
 *
 * The solver's vocabulary is the eighteen face turns, and a face turn never
 * moves a centre. Once a player has used M/E/S the centres can sit in any of
 * the 24 whole-cube orientations, and from there no face-turn sequence reaches
 * the standard solved state at all — so an unrotated search would be looking
 * for something that does not exist.
 *
 * DESIGN-SOLVING.md 2.0: rotate the state back to standard, search there, and
 * relabel the solution's faces on the way out. The alternative — searching for
 * a rotated goal — would mean re-indexing the pruning tables, which costs far
 * more than two relabelings.
 */

/**
 * The three axis rotations, written with the slice moves the engine already
 * applies. Reusing `applyMoves` here means the rotation group is expressed in
 * terms the move layer has already been tested against, rather than a second
 * hand-written permutation table that could disagree with it.
 */
const ROTATION_GENERATORS: readonly (readonly Move[])[] = Object.freeze([
  Object.freeze(parseMoves("R M' L'")), // x
  Object.freeze(parseMoves("R' M L")), // x'
  Object.freeze(parseMoves("U E' D'")), // y
  Object.freeze(parseMoves("U' E D")), // y'
  Object.freeze(parseMoves("F S B'")), // z
  Object.freeze(parseMoves("F' S' B")), // z'
]);

const CENTER_INDEX_OF_FACE: Readonly<Record<Face, number>> = Object.freeze(
  Object.fromEntries(
    CENTER_NAMES.map((face, index) => [face, index]),
  ) as Record<Face, number>,
);

export interface CubeOrientation {
  /** The centre arrangement this orientation shows, in CENTER_NAMES order. */
  readonly centers: Uint8Array;
  /** Moves that rotate a cube in this orientation back to the standard one. */
  readonly toStandard: readonly Move[];
  /**
   * Standard-frame centre index -> the centre index it is called here.
   *
   * `centers[position] = cubie` says position `position` shows colour `cubie`,
   * so rotating to standard sends position `p` to position `centers[p]`. Going
   * the other way — naming a standard-frame face in the player's frame — is
   * therefore the inverse of that permutation.
   */
  readonly faceRelabel: Uint8Array;
}

function centersKey(centers: ArrayLike<number>): string {
  let key = '';
  for (let index = 0; index < CENTER_COUNT; index += 1) {
    key += String.fromCharCode(centers[index]!);
  }
  return key;
}

function invertPermutation(permutation: Uint8Array): Uint8Array {
  const inverse = new Uint8Array(permutation.length);
  for (let index = 0; index < permutation.length; index += 1) {
    inverse[permutation[index]!] = index;
  }
  return inverse;
}

let orientationTable: ReadonlyMap<string, CubeOrientation> | null = null;

/**
 * Every whole-cube orientation, found by walking the rotation group.
 *
 * Enumerated rather than tabulated: the 24 arrangements and the sequence that
 * produces each one both come out of the same `applyMoves` the rest of the
 * engine uses, so a table transcription error is not possible.
 */
function buildOrientations(): ReadonlyMap<string, CubeOrientation> {
  const solved = createSolvedState();
  const table = new Map<string, CubeOrientation>();
  const start: readonly Move[] = [];
  const queue: { state: CubeState; path: readonly Move[] }[] = [
    { state: solved, path: start },
  ];
  table.set(centersKey(solved.centers), {
    centers: solved.centers.slice(),
    toStandard: start,
    faceRelabel: invertPermutation(solved.centers.slice()),
  });

  for (let head = 0; head < queue.length; head += 1) {
    const { state, path } = queue[head]!;
    for (const generator of ROTATION_GENERATORS) {
      const next = applyMoves(state, generator);
      const key = centersKey(next.centers);
      if (table.has(key)) continue;
      // The path reaches this orientation from standard, so walking it
      // backwards is what returns a cube here to standard.
      const toStandard = Object.freeze(
        [...path, ...generator].reverse().map((move) => ({
          face: move.face,
          turns: (4 - move.turns) as 1 | 2 | 3,
        })),
      );
      const centers = next.centers.slice();
      table.set(key, {
        centers,
        toStandard,
        faceRelabel: invertPermutation(centers),
      });
      queue.push({ state: next, path: [...path, ...generator] });
    }
  }

  if (table.size !== 24) {
    throw new Error(
      `Rotation group must have 24 orientations, walked ${table.size}`,
    );
  }
  return table;
}

function orientations(): ReadonlyMap<string, CubeOrientation> {
  orientationTable ??= buildOrientations();
  return orientationTable;
}

/** The whole-cube orientation a state's centres are sitting in. */
export function orientationOf(state: CubeState): CubeOrientation {
  const found = orientations().get(centersKey(state.centers));
  if (found === undefined) {
    // validateState already rejects centre arrangements that are not rotations,
    // so reaching this means the caller bypassed it.
    throw new RangeError('Cube centres are not in any whole-cube orientation');
  }
  return found;
}

export interface StandardOrientation {
  /** The same cube, rotated so its centres are home. */
  readonly state: CubeState;
  readonly orientation: CubeOrientation;
}

/**
 * Rotates a state into the standard orientation the search expects.
 *
 * The returned state is a fresh object; the caller's arrays are never touched,
 * which the worker protocol depends on.
 */
export function toStandardOrientation(state: CubeState): StandardOrientation {
  const orientation = orientationOf(state);
  return {
    state: applyMoves(state, orientation.toStandard),
    orientation,
  };
}

/**
 * Renames a standard-frame solution into the player's frame.
 *
 * A whole-cube rotation is a proper rotation, so a face keeps its handedness
 * and only its name changes; the turn counts carry over untouched.
 */
export function relabelFaceMoves(
  moves: readonly FaceMove[],
  orientation: CubeOrientation,
): FaceMove[] {
  return moves.map((move) => {
    const standardIndex = CENTER_INDEX_OF_FACE[move.face];
    const playerIndex = orientation.faceRelabel[standardIndex]!;
    return { face: CENTER_NAMES[playerIndex]!, turns: move.turns };
  });
}


/**
 * A change of axis for the search to work in.
 *
 * Phase 1's coordinates are defined against the U/D axis: corner and edge
 * orientation and which edges belong in the middle slice all mean "relative to
 * up and down". So the same cube is an easier or harder phase-1 problem
 * depending on which physical axis is playing that role, and by a lot — the
 * hardest states measured here took 428ms in one frame and 27ms in another.
 *
 * Rotating the cube would not do it: the search puts the centres back before it
 * starts, undoing exactly that. The frame has to be a *relabelling*, which is
 * conjugation by the rotation rather than composition with it.
 */
export interface AxisFrame {
  readonly name: string;
  /** Rewrites a standard-orientation state into this frame. */
  conjugate(state: CubeState): CubeState;
  /** Renames a solution found in this frame back into the standard one. */
  readonly toStandard: CubeOrientation;
}

function axisFrame(name: string, notation: string): AxisFrame {
  const rotation = applyMoves(createSolvedState(), parseMoves(notation));
  const inverse = invertState(rotation);
  return Object.freeze({
    name,
    conjugate: (state: CubeState) =>
      composeStates(composeStates(inverse, state), rotation),
    toStandard: orientationOf(inverse),
  });
}

let axisFrames: readonly AxisFrame[] | null = null;

/**
 * The frames worth searching besides the standard one.
 *
 * `x` and `z` hand the U/D role to the other two axes. A `y` frame is missing
 * on purpose: it turns about the U/D axis itself, so it leaves phase 1 looking
 * at the same problem — measured at 423ms against a 428ms baseline, which is
 * noise, while `x` and `z` came in at 46ms and 34ms.
 */
export function searchAxisFrames(): readonly AxisFrame[] {
  axisFrames ??= Object.freeze([
    axisFrame('x', "R M' L'"),
    axisFrame('z', "F S B'"),
  ]);
  return axisFrames;
}
