import { describe, expect, it } from 'vitest';

import {
  applyMoves,
  invertMoves,
  parseMoves,
  serializeMoves,
  type FaceMove,
  type Move,
} from '../src/moves.js';
import {
  createSolvedState,
  isSolved,
  isValidState,
  statesEqual,
} from '../src/state.js';
import {
  orientationOf,
  relabelFaceMoves,
  searchAxisFrames,
  toStandardOrientation,
} from '../src/solver/orientation.js';

/** Axis rotations spelled out in the move vocabulary the engine accepts. */
const ROTATIONS: Readonly<Record<string, string>> = Object.freeze({
  x: "R M' L'",
  "x'": "R' M L",
  x2: 'R2 M2 L2',
  y: "U E' D'",
  "y'": "U' E D",
  y2: 'U2 E2 D2',
  z: "F S B'",
  "z'": "F' S' B",
  z2: 'F2 S2 B2',
});

function rotation(notation: string): Move[] {
  return parseMoves(
    notation
      .split(' ')
      .map((token) => ROTATIONS[token] ?? token)
      .join(' '),
  );
}

const SAMPLE_ROTATIONS: readonly string[] = Object.freeze([
  '',
  'x',
  "x'",
  'x2',
  'y',
  "y'",
  'y2',
  'z',
  "z'",
  'z2',
  'x y',
  "x2 y'",
  'y z x',
  "z' x' y2",
  'x y z x y z',
]);

const SOLVED = createSolvedState();
const IDENTITY_CENTERS = [0, 1, 2, 3, 4, 5];

describe('whole-cube orientation', () => {
  it('walks all 24 orientations and no more', () => {
    const seen = new Set<string>();
    for (const notation of SAMPLE_ROTATIONS) {
      const state = applyMoves(SOLVED, rotation(notation));
      seen.add(orientationOf(state).centers.join(','));
    }
    // The samples only need to land inside the group; the walk that built it
    // already asserts the count, so this checks the lookup agrees with it.
    for (const notation of SAMPLE_ROTATIONS) {
      const orientation = orientationOf(applyMoves(SOLVED, rotation(notation)));
      expect(orientation.centers).toHaveLength(6);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rotates any orientation back to centres at home', () => {
    for (const notation of SAMPLE_ROTATIONS) {
      const rotated = applyMoves(SOLVED, rotation(notation));
      const standard = toStandardOrientation(rotated);
      expect([...standard.state.centers]).toEqual(IDENTITY_CENTERS);
      expect(isValidState(standard.state)).toBe(true);
    }
  });

  it('leaves a standard cube exactly as it found it', () => {
    const scrambled = applyMoves(SOLVED, parseMoves("R U R' U' F2 L D"));
    const standard = toStandardOrientation(scrambled);
    expect(statesEqual(standard.state, scrambled)).toBe(true);
    expect(standard.orientation.toStandard).toEqual([]);
  });

  it('never touches the caller state', () => {
    const rotated = applyMoves(SOLVED, rotation('y z x'));
    const before = {
      cp: [...rotated.cp],
      co: [...rotated.co],
      ep: [...rotated.ep],
      eo: [...rotated.eo],
      centers: [...rotated.centers],
    };
    toStandardOrientation(rotated);
    expect([...rotated.cp]).toEqual(before.cp);
    expect([...rotated.co]).toEqual(before.co);
    expect([...rotated.ep]).toEqual(before.ep);
    expect([...rotated.eo]).toEqual(before.eo);
    expect([...rotated.centers]).toEqual(before.centers);
  });

  it('renames a standard-frame solution into the frame it will be played in', () => {
    // This is the property the whole orientation layer exists for: a solution
    // found after rotating to standard has to solve the cube the player is
    // actually looking at, without moving a centre to get there.
    const solution = parseMoves("R U R' U' F2 L D B'") as FaceMove[];
    const standardScramble = applyMoves(SOLVED, invertMoves(solution));

    for (const notation of SAMPLE_ROTATIONS) {
      const player = applyMoves(standardScramble, rotation(notation));
      const orientation = orientationOf(player);
      const replayed = relabelFaceMoves(solution, orientation);

      expect(isSolved(applyMoves(player, replayed))).toBe(true);
      // Same length and same turn counts: only the names change.
      expect(replayed).toHaveLength(solution.length);
      expect(replayed.map((move) => move.turns)).toEqual(
        solution.map((move) => move.turns),
      );
    }
  });

  it('is a no-op relabel in the standard orientation', () => {
    const solution = parseMoves("R U R' U' F2") as FaceMove[];
    const orientation = orientationOf(SOLVED);
    expect(serializeMoves(relabelFaceMoves(solution, orientation))).toBe(
      serializeMoves(solution),
    );
  });

  it('recovers the same orientation after the state is scrambled inside it', () => {
    // Face turns cannot move a centre, so scrambling must not change which
    // orientation the cube is in.
    for (const notation of SAMPLE_ROTATIONS) {
      const rotated = applyMoves(SOLVED, rotation(notation));
      const scrambled = applyMoves(rotated, parseMoves("R U2 F' L D B"));
      expect([...orientationOf(scrambled).centers]).toEqual([
        ...orientationOf(rotated).centers,
      ]);
    }
  });

  it('rejects centres that are not a whole-cube orientation', () => {
    const broken = { ...SOLVED, centers: Uint8Array.from([0, 1, 2, 3, 5, 4]) };
    expect(() => orientationOf(broken)).toThrow(RangeError);
  });
});


describe('axis frames', () => {
  it('hands the U/D role to the other two axes and nothing else', () => {
    // A `y` frame would turn about the U/D axis itself and leave phase 1 with
    // the same problem, which is why there are two of these and not three.
    expect(searchAxisFrames().map((frame) => frame.name)).toEqual(['x', 'z']);
  });

  it('keeps the centres home, so the search still starts from standard', () => {
    for (const frame of searchAxisFrames()) {
      const state = applyMoves(SOLVED, parseMoves("R U R' U' F2 L D"));
      const conjugated = frame.conjugate(state);
      expect([...conjugated.centers]).toEqual(IDENTITY_CENTERS);
      expect(isValidState(conjugated)).toBe(true);
    }
  });

  it('leaves the solved cube solved', () => {
    for (const frame of searchAxisFrames()) {
      expect(statesEqual(frame.conjugate(SOLVED), SOLVED)).toBe(true);
    }
  });

  it('is a bijection on states, so no frame loses information', () => {
    // Conjugation by a rotation is invertible; two states cannot collapse onto
    // one, or a solution found in the frame would not name a single cube.
    const seen = new Set<string>();
    const scrambles = ["R U2 F' L D B", "D2 R' D' F2 B", 'U R', "M2 E' S"];
    for (const frame of searchAxisFrames()) {
      for (const scramble of scrambles) {
        const state = applyMoves(SOLVED, parseMoves(scramble));
        const conjugated = frame.conjugate(state);
        const key = `${frame.name}|${[...conjugated.cp, ...conjugated.ep].join(',')}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
