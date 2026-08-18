import { ALL_HTM_MOVES, layerAxis, type FaceMove } from './moves.js';
import {
  mulberry32,
  randomInt,
  type RandomSource,
  type SeedOrRandomSource,
} from './rng.js';
import {
  CENTER_COUNT,
  CORNER_COUNT,
  EDGE_COUNT,
  type CubeState,
} from './state.js';

export const DEFAULT_RANDOM_MOVE_COUNT = 25;

function toRandomSource(seedOrRandom: SeedOrRandomSource): RandomSource {
  return typeof seedOrRandom === 'function'
    ? seedOrRandom
    : mulberry32(seedOrRandom);
}

function isAllowedNextMove(moves: readonly FaceMove[], candidate: FaceMove): boolean {
  const previous = moves[moves.length - 1];

  // Combining two adjacent turns of one face would make the scramble longer
  // without adding a state that a single HTM move could not reach.
  if (previous?.face === candidate.face) {
    return false;
  }

  const twoBack = moves[moves.length - 2];
  if (previous !== undefined && twoBack !== undefined) {
    const axis = layerAxis(candidate.face);

    // Forbid patterns such as R L R. Two opposite-face moves are fine, but a
    // third move on that axis is an avoidable reorder of commuting moves.
    if (layerAxis(previous.face) === axis && layerAxis(twoBack.face) === axis) {
      return false;
    }
  }

  return true;
}

function randomPermutation(length: number, random: RandomSource): Uint8Array {
  const permutation = Uint8Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    const other = randomInt(random, index + 1);
    const value = permutation[index]!;
    permutation[index] = permutation[other]!;
    permutation[other] = value;
  }
  return permutation;
}

function permutationParity(permutation: Uint8Array): 0 | 1 {
  let parity = 0;
  for (let left = 0; left < permutation.length - 1; left += 1) {
    for (let right = left + 1; right < permutation.length; right += 1) {
      if (permutation[left]! > permutation[right]!) parity ^= 1;
    }
  }
  return parity as 0 | 1;
}

function randomOrientations(
  length: number,
  modulus: 2 | 3,
  random: RandomSource,
): Uint8Array {
  const orientations = new Uint8Array(length);
  let sum = 0;
  for (let index = 0; index < length - 1; index += 1) {
    const orientation = randomInt(random, modulus);
    orientations[index] = orientation;
    sum += orientation;
  }
  orientations[length - 1] = (modulus - (sum % modulus)) % modulus;
  return orientations;
}

/**
 * Generate a uniformly sampled reachable cubie state.
 *
 * This is the state-sampling half of a WCA-style scramble. Once the two-phase
 * solver lands in M3, solving this state and inverting that solution will
 * produce the displayable scramble sequence.
 */
export function generateRandomState(
  seedOrRandom: SeedOrRandomSource = Math.random,
): CubeState {
  const random = toRandomSource(seedOrRandom);
  const cp = randomPermutation(CORNER_COUNT, random);
  const ep = randomPermutation(EDGE_COUNT, random);

  // Exactly half of all corner/edge permutation pairs have matching parity.
  // Map the other half bijectively into that set with one fixed transposition.
  if (permutationParity(cp) !== permutationParity(ep)) {
    const first = ep[0]!;
    ep[0] = ep[1]!;
    ep[1] = first;
  }

  return {
    cp,
    co: randomOrientations(CORNER_COUNT, 3, random),
    ep,
    eo: randomOrientations(EDGE_COUNT, 2, random),
    // Random-state scrambles stay in the canonical orientation. Rotating the
    // whole cube adds no difficulty, and a scramble the solver cannot consume
    // would be worse than useless.
    centers: Uint8Array.from({ length: CENTER_COUNT }, (_, index) => index),
  };
}

/**
 * Generate a random `length`-move HTM scramble.
 *
 * A numeric source is interpreted with mulberry32's uint32 seed semantics. An
 * injected PRNG must return values in [0, 1). The generated sequence never has
 * adjacent moves on one face or three consecutive moves on one axis.
 */
export function generateRandomMoves(
  length: number = DEFAULT_RANDOM_MOVE_COUNT,
  seedOrRandom: SeedOrRandomSource = Math.random,
): FaceMove[] {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('length must be a non-negative safe integer');
  }

  const random = toRandomSource(seedOrRandom);
  const moves: FaceMove[] = [];

  while (moves.length < length) {
    const candidates = ALL_HTM_MOVES.filter((candidate) =>
      isAllowedNextMove(moves, candidate),
    );
    const selected = candidates[randomInt(random, candidates.length)];

    // The constraints always leave moves from at least two axes. Keep this
    // guard so a future change to the move set fails loudly rather than
    // returning a short scramble.
    if (selected === undefined) {
      throw new Error('HTM move set has no valid next scramble move');
    }

    moves.push({ face: selected.face, turns: selected.turns });
  }

  return moves;
}

/** Explicit alias distinguishing random-move scrambles from random-state ones. */
export const randomMoveScramble = generateRandomMoves;
