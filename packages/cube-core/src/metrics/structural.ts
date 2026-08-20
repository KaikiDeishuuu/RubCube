import {
  CENTER_COUNT,
  CORNER_COUNT,
  EDGE_COUNT,
  createSolvedState,
  type CubeState,
} from '../state.js';

import { clampProgress } from './score.js';

/**
 * `progress_score`, second version: how much of the cube is actually solved.
 *
 * The first version divided two Kociemba solution lengths, and M3d rejected it
 * (DESIGN-SOLVING.md, "M3d 实测"): the length saturates, so a fourteen-move
 * cube and an eighteen-move one both read 21. The deeper reason was not the
 * search but the shape - almost every state in the group sits at seventeen or
 * eighteen moves, so a distance ratio has nearly no range to work with however
 * exactly the distance is computed.
 *
 * Counting solved cubies has the range instead: 20 when solved, and about 0.83
 * on a uniform random cube, because a cubie lands home by chance roughly once
 * in twenty-four. It is not a distance and does not pretend to be one - it says
 * how much verifiable structure exists, which is the thing partial credit was
 * always meant to be for.
 *
 * The definition of "a cubie is correct" is deliberately the same one T1's
 * `cubie_accuracy` uses: position and orientation both right. One notion of
 * correctness across the report beats two that nearly agree.
 */

/** Report provenance: which metric version produced a score. */
export const PROGRESS_METRIC_VERSION = 'structural-cubies-v1';

/** Eight corners and twelve edges. Centres are not scored; see below. */
export const SOLVED_CUBIE_COUNT = CORNER_COUNT + EDGE_COUNT;

const SOLVED = createSolvedState();

/**
 * Rejects a cube that has been turned as a whole.
 *
 * Evaluation allows the eighteen face turns only, so centres can never move,
 * and a cube whose centres have moved did not come from a scored run. It has to
 * be refused rather than scored: `isSolved` is centre-relative and would call a
 * rotated solved cube solved, while counting cubies against the canonical
 * solved state would call it completely unsolved. Silent disagreement between
 * the two is exactly what an assertion is for.
 */
function assertHomeCentres(state: CubeState): void {
  for (let face = 0; face < CENTER_COUNT; face += 1) {
    if (state.centers[face] !== face) {
      throw new RangeError('Structural progress needs a cube whose centres are home');
    }
  }
}

/** The three ways of being right, counted separately for diagnosis. */
export interface CubieCorrectness {
  /** Position and orientation both match: the headline count. */
  readonly placed: number;
  /** In the right slot, orientation ignored. */
  readonly positioned: number;
  /** Correctly oriented for whichever slot it currently occupies. */
  readonly oriented: number;
}

/**
 * Compares two cubes cubie by cubie.
 *
 * Takes a reference rather than assuming the solved state so T1's state
 * prediction task can reuse it: there the reference is the true cube, not the
 * goal. Neither cube is assumed to have its centres home, because a prediction
 * may legitimately be any cube at all.
 */
export function cubieCorrectness(
  state: CubeState,
  reference: CubeState = SOLVED,
): CubieCorrectness {
  let placed = 0;
  let positioned = 0;
  let oriented = 0;

  for (let slot = 0; slot < CORNER_COUNT; slot += 1) {
    const samePiece = state.cp[slot] === reference.cp[slot];
    const sameTwist = state.co[slot] === reference.co[slot];
    if (samePiece) positioned += 1;
    if (sameTwist) oriented += 1;
    if (samePiece && sameTwist) placed += 1;
  }
  for (let slot = 0; slot < EDGE_COUNT; slot += 1) {
    const samePiece = state.ep[slot] === reference.ep[slot];
    const sameFlip = state.eo[slot] === reference.eo[slot];
    if (samePiece) positioned += 1;
    if (sameFlip) oriented += 1;
    if (samePiece && sameFlip) placed += 1;
  }

  return Object.freeze({ placed, positioned, oriented });
}

/**
 * How many of the twenty cubies are home, in position and orientation.
 *
 * 20 exactly when the cube is solved, given centres that are home - which is
 * why the check above is not optional.
 */
export function placedCubies(state: CubeState): number {
  assertHomeCentres(state);
  return cubieCorrectness(state).placed;
}

/**
 * The fraction of a task's remaining work that got done.
 *
 * Relative to the task's own start, exactly as the first version was: a corpus
 * state may already have a cubie or two home by chance, and a model should be
 * credited for what it fixed rather than for what it was handed. Null when the
 * task started solved, because there was no work to do a fraction of.
 */
export function structuralProgress(
  initial: CubeState,
  final: CubeState,
): number | null {
  const start = placedCubies(initial);
  if (start === SOLVED_CUBIE_COUNT) return null;
  const reached = placedCubies(final);
  return clampProgress((reached - start) / (SOLVED_CUBIE_COUNT - start));
}

/**
 * The most cubies a single face turn can disturb.
 *
 * A quarter turn cycles four corners and four edges; a half turn swaps two
 * pairs of each. So `|placed(s) - placed(s . m)| <= 8` holds at every distance,
 * with no oracle needed, and it is the local-consistency bound this metric is
 * held to.
 */
export const MAX_CUBIES_PER_MOVE = 8;
