import {
  applyMoves,
  createSolvedState,
  generateRandomMoves,
  generateRandomState,
  type CubeState,
  type Face,
} from '@rubcube/cube-core';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import {
  CENTER_FACES,
  CORNER_POSITION_FACES,
  CUBIE_DESCRIPTORS,
  EDGE_POSITION_FACES,
  faceNormal,
  getCubiePoses,
} from '../src/layout.js';
import type { CubiePose, GridPosition } from '../src/types.js';

const EXPECTED_IDS = [
  'corner:URF',
  'corner:UFL',
  'corner:ULB',
  'corner:UBR',
  'corner:DFR',
  'corner:DLF',
  'corner:DBL',
  'corner:DRB',
  'edge:UR',
  'edge:UF',
  'edge:UL',
  'edge:UB',
  'edge:DR',
  'edge:DF',
  'edge:DL',
  'edge:DB',
  'edge:FR',
  'edge:FL',
  'edge:BL',
  'edge:BR',
  'center:U',
  'center:R',
  'center:F',
  'center:D',
  'center:L',
  'center:B',
] as const;

function positionKey(position: Readonly<GridPosition>): string {
  return position.join(',');
}

function expectVector(actual: Vector3, expected: Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.z).toBeCloseTo(expected.z, 12);
}

function positionForFaces(faces: readonly Face[]): Vector3 {
  return faces.reduce((position, face) => position.add(faceNormal(face)), new Vector3());
}

function findPosition(permutation: Uint8Array, cubie: number): number {
  const position = permutation.indexOf(cubie);
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

function expectStickerMapping(state: CubeState, poses: readonly CubiePose[]): void {
  for (let cubie = 0; cubie < 8; cubie += 1) {
    const pose = poses[cubie]!;
    const position = findPosition(state.cp, cubie);
    const targetFaces = CORNER_POSITION_FACES[position]!;
    const orientation = state.co[position]!;

    expectVector(
      new Vector3(...pose.gridPosition),
      positionForFaces(targetFaces),
    );
    pose.descriptor.stickerFaces.forEach((sourceFace, sticker) => {
      const targetFace = targetFaces[(sticker + orientation) % 3]!;
      expectVector(faceNormal(sourceFace).applyQuaternion(pose.quaternion), faceNormal(targetFace));
    });
  }

  for (let cubie = 0; cubie < 12; cubie += 1) {
    const pose = poses[8 + cubie]!;
    const position = findPosition(state.ep, cubie);
    const targetFaces = EDGE_POSITION_FACES[position]!;
    const orientation = state.eo[position]!;

    expectVector(
      new Vector3(...pose.gridPosition),
      positionForFaces(targetFaces),
    );
    pose.descriptor.stickerFaces.forEach((sourceFace, sticker) => {
      const targetFace = targetFaces[(sticker + orientation) % 2]!;
      expectVector(faceNormal(sourceFace).applyQuaternion(pose.quaternion), faceNormal(targetFace));
    });
  }

  CENTER_FACES.forEach((face, center) => {
    const pose = poses[20 + center]!;
    expectVector(new Vector3(...pose.gridPosition), faceNormal(face));
    expectVector(faceNormal(face).applyQuaternion(pose.quaternion), faceNormal(face));
  });
}

describe('cubie descriptors', () => {
  it('publishes 26 immutable identities in Kociemba/URFDLB order', () => {
    expect(CUBIE_DESCRIPTORS.map(({ id }) => id)).toEqual(EXPECTED_IDS);
    expect(new Set(CUBIE_DESCRIPTORS.map(({ id }) => id)).size).toBe(26);
    expect(CUBIE_DESCRIPTORS.every(Object.isFrozen)).toBe(true);
    expect(CUBIE_DESCRIPTORS.every(({ homePosition }) => Object.isFrozen(homePosition))).toBe(
      true,
    );
    expect(CUBIE_DESCRIPTORS.every(({ stickerFaces }) => Object.isFrozen(stickerFaces))).toBe(true);
  });

  it('uses x=R, y=U, z=F and returns independent normal vectors', () => {
    const expected: Readonly<Record<Face, readonly [number, number, number]>> = {
      U: [0, 1, 0],
      D: [0, -1, 0],
      L: [-1, 0, 0],
      R: [1, 0, 0],
      F: [0, 0, 1],
      B: [0, 0, -1],
    };

    for (const [face, normal] of Object.entries(expected) as [Face, typeof expected[Face]][]) {
      expect(faceNormal(face).toArray()).toEqual(normal);
    }
    const first = faceNormal('R');
    first.set(9, 9, 9);
    expect(faceNormal('R').toArray()).toEqual([1, 0, 0]);
  });
});

describe('getCubiePoses', () => {
  it('maps solved cubies to all 26 shell cells with identity rotations', () => {
    const poses = getCubiePoses(createSolvedState());

    expect(poses).toHaveLength(26);
    expect(poses.map(({ descriptor }) => descriptor)).toEqual(CUBIE_DESCRIPTORS);
    expect(new Set(poses.map(({ gridPosition }) => positionKey(gridPosition))).size).toBe(26);
    expect(poses.every(({ quaternion }) => quaternion.equals(new Quaternion()))).toBe(true);
    expectStickerMapping(createSolvedState(), poses);
  });

  it.each(['U', 'D', 'L', 'R', 'F', 'B'] as const)(
    'returns to identity after four %s quarter turns',
    (face) => {
      const state = applyMoves(createSolvedState(), `${face} ${face} ${face} ${face}`);
      const poses = getCubiePoses(state);

      expect(poses.map(({ gridPosition }) => positionKey(gridPosition))).toEqual(
        CUBIE_DESCRIPTORS.map(({ homePosition }) => positionKey(homePosition)),
      );
      expect(poses.every(({ quaternion }) => quaternion.equals(new Quaternion()))).toBe(true);
      expectStickerMapping(state, poses);
    },
  );

  it('tracks every sticker through a non-trivial random move sequence', () => {
    const moves = generateRandomMoves(100, 0x5eedc0de);
    const state = applyMoves(createSolvedState(), moves);
    const poses = getCubiePoses(state);

    expect(new Set(poses.map(({ gridPosition }) => positionKey(gridPosition))).size).toBe(26);
    expectStickerMapping(state, poses);
  });

  it('maps uniformly sampled reachable states without duplicate positions', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const state = generateRandomState(seed);
      const poses = getCubiePoses(state);

      expect(new Set(poses.map(({ gridPosition }) => positionKey(gridPosition))).size).toBe(26);
      expect(poses.every(({ quaternion }) => Math.abs(quaternion.length() - 1) < 1e-12)).toBe(
        true,
      );
      expectStickerMapping(state, poses);
    }
  });

  it('rejects malformed or unreachable core states', () => {
    const invalid = createSolvedState();
    invalid.cp[0] = invalid.cp[1]!;
    expect(() => getCubiePoses(invalid)).toThrow(/invalid cube state/i);
  });
});
