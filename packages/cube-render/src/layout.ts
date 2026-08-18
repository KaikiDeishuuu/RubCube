import {
  assertValidState,
  CORNER_NAMES,
  EDGE_NAMES,
  type CubeState,
  type Face,
} from '@rubcube/cube-core';
import { Matrix4, Quaternion, Vector3 } from 'three';

import type {
  CubieDescriptor,
  CubieKind,
  CubiePose,
  GridCoordinate,
  GridPosition,
} from './types.js';

type PositionFaces = readonly Face[];
type DiscreteVector = Readonly<GridPosition>;

const FACE_NORMALS: Readonly<Record<Face, DiscreteVector>> = Object.freeze({
  U: Object.freeze([0, 1, 0] as const),
  D: Object.freeze([0, -1, 0] as const),
  L: Object.freeze([-1, 0, 0] as const),
  R: Object.freeze([1, 0, 0] as const),
  F: Object.freeze([0, 0, 1] as const),
  B: Object.freeze([0, 0, -1] as const),
});

/** Kociemba corner positions and sticker order: URF UFL ULB UBR DFR DLF DBL DRB. */
export const CORNER_POSITION_FACES: readonly PositionFaces[] = Object.freeze([
  Object.freeze(['U', 'R', 'F'] as const),
  Object.freeze(['U', 'F', 'L'] as const),
  Object.freeze(['U', 'L', 'B'] as const),
  Object.freeze(['U', 'B', 'R'] as const),
  Object.freeze(['D', 'F', 'R'] as const),
  Object.freeze(['D', 'L', 'F'] as const),
  Object.freeze(['D', 'B', 'L'] as const),
  Object.freeze(['D', 'R', 'B'] as const),
]);

/** Kociemba edge positions and sticker order: UR UF UL UB DR DF DL DB FR FL BL BR. */
export const EDGE_POSITION_FACES: readonly PositionFaces[] = Object.freeze([
  Object.freeze(['U', 'R'] as const),
  Object.freeze(['U', 'F'] as const),
  Object.freeze(['U', 'L'] as const),
  Object.freeze(['U', 'B'] as const),
  Object.freeze(['D', 'R'] as const),
  Object.freeze(['D', 'F'] as const),
  Object.freeze(['D', 'L'] as const),
  Object.freeze(['D', 'B'] as const),
  Object.freeze(['F', 'R'] as const),
  Object.freeze(['F', 'L'] as const),
  Object.freeze(['B', 'L'] as const),
  Object.freeze(['B', 'R'] as const),
]);

/** Center identities follow the external facelet convention rather than move-axis order. */
export const CENTER_FACES = Object.freeze(['U', 'R', 'F', 'D', 'L', 'B'] as const);

function asGridCoordinate(value: number): GridCoordinate {
  if (value === -1 || value === 0 || value === 1) return value;
  throw new Error(`Cubie layout produced an invalid grid coordinate: ${value}`);
}

function gridPositionForFaces(faces: PositionFaces): DiscreteVector {
  let x = 0;
  let y = 0;
  let z = 0;

  for (const face of faces) {
    const normal = FACE_NORMALS[face];
    x += normal[0];
    y += normal[1];
    z += normal[2];
  }

  return Object.freeze([
    asGridCoordinate(x),
    asGridCoordinate(y),
    asGridCoordinate(z),
  ] as const);
}

const CORNER_GRID_POSITIONS = Object.freeze(CORNER_POSITION_FACES.map(gridPositionForFaces));
const EDGE_GRID_POSITIONS = Object.freeze(EDGE_POSITION_FACES.map(gridPositionForFaces));
const CENTER_GRID_POSITIONS = Object.freeze(
  CENTER_FACES.map((face) => gridPositionForFaces([face])),
);

function makeDescriptor(
  kind: CubieKind,
  index: number,
  name: string,
  homePosition: DiscreteVector,
  stickerFaces: PositionFaces,
): CubieDescriptor {
  return Object.freeze({
    id: `${kind}:${name}`,
    kind,
    index,
    homePosition,
    stickerFaces,
  });
}

const CORNER_DESCRIPTORS = Object.freeze(
  CORNER_NAMES.map((name, index) =>
    makeDescriptor(
      'corner',
      index,
      name,
      CORNER_GRID_POSITIONS[index]!,
      CORNER_POSITION_FACES[index]!,
    ),
  ),
);

const EDGE_DESCRIPTORS = Object.freeze(
  EDGE_NAMES.map((name, index) =>
    makeDescriptor(
      'edge',
      index,
      name,
      EDGE_GRID_POSITIONS[index]!,
      EDGE_POSITION_FACES[index]!,
    ),
  ),
);

const CENTER_DESCRIPTORS = Object.freeze(
  CENTER_FACES.map((face, index) =>
    makeDescriptor(
      'center',
      index,
      face,
      CENTER_GRID_POSITIONS[index]!,
      Object.freeze([face]),
    ),
  ),
);

/**
 * All 26 visible cubies in stable identity order: Kociemba corners, Kociemba
 * edges, then centers in URFDLB order.
 */
export const CUBIE_DESCRIPTORS: readonly CubieDescriptor[] = Object.freeze([
  ...CORNER_DESCRIPTORS,
  ...EDGE_DESCRIPTORS,
  ...CENTER_DESCRIPTORS,
]);

interface DiscreteRotation {
  /** Images of the local +X, +Y, and +Z axes. */
  readonly basis: readonly [DiscreteVector, DiscreteVector, DiscreteVector];
  readonly quaternion: Quaternion;
}

const AXIS_DIRECTIONS: readonly DiscreteVector[] = Object.freeze([
  FACE_NORMALS.R,
  FACE_NORMALS.L,
  FACE_NORMALS.U,
  FACE_NORMALS.D,
  FACE_NORMALS.F,
  FACE_NORMALS.B,
]);

function dot(left: DiscreteVector, right: DiscreteVector): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: DiscreteVector, right: DiscreteVector): DiscreteVector {
  return Object.freeze([
    asGridCoordinate(left[1] * right[2] - left[2] * right[1]),
    asGridCoordinate(left[2] * right[0] - left[0] * right[2]),
    asGridCoordinate(left[0] * right[1] - left[1] * right[0]),
  ] as const);
}

function toVector3(vector: DiscreteVector): Vector3 {
  return new Vector3(vector[0], vector[1], vector[2]);
}

function enumerateRotations(): readonly DiscreteRotation[] {
  const rotations: DiscreteRotation[] = [];

  for (const xAxis of AXIS_DIRECTIONS) {
    for (const yAxis of AXIS_DIRECTIONS) {
      if (dot(xAxis, yAxis) !== 0) continue;

      // z = x cross y makes every enumerated matrix right-handed (det = +1).
      const zAxis = cross(xAxis, yAxis);
      const matrix = new Matrix4().makeBasis(
        toVector3(xAxis),
        toVector3(yAxis),
        toVector3(zAxis),
      );
      rotations.push({
        basis: Object.freeze([xAxis, yAxis, zAxis]),
        quaternion: new Quaternion().setFromRotationMatrix(matrix).normalize(),
      });
    }
  }

  if (rotations.length !== 24) {
    throw new Error(`Expected 24 proper cube rotations, got ${rotations.length}`);
  }
  return Object.freeze(rotations);
}

const CUBE_ROTATIONS = enumerateRotations();

/** Whether `rotation` carries `vector` exactly onto `expected`, without allocating. */
function rotatesVectorOnto(
  rotation: DiscreteRotation,
  vector: DiscreteVector,
  expected: DiscreteVector,
): boolean {
  const [xAxis, yAxis, zAxis] = rotation.basis;
  return (
    vector[0] * xAxis[0] + vector[1] * yAxis[0] + vector[2] * zAxis[0] === expected[0] &&
    vector[0] * xAxis[1] + vector[1] * yAxis[1] + vector[2] * zAxis[1] === expected[1] &&
    vector[0] * xAxis[2] + vector[1] * yAxis[2] + vector[2] * zAxis[2] === expected[2]
  );
}

function rotationIndexFor(
  sourceFaces: PositionFaces,
  positionFaces: PositionFaces,
  orientation: number,
): number {
  const index = CUBE_ROTATIONS.findIndex((candidate) =>
    sourceFaces.every((sourceFace, sticker) =>
      rotatesVectorOnto(
        candidate,
        FACE_NORMALS[sourceFace],
        FACE_NORMALS[positionFaces[(sticker + orientation) % positionFaces.length]!],
      ),
    ),
  );

  if (index < 0) {
    throw new Error(
      `No proper cubie rotation maps ${sourceFaces.join('')} to ${positionFaces.join(
        '',
      )} with orientation ${orientation}`,
    );
  }
  return index;
}

/**
 * Precomputed rotation index for every (cubie, position, orientation) triple.
 *
 * The pose of a cubie depends on nothing else, and there are only 8*8*3 corner
 * and 12*12*2 edge combinations, so resolving them once at load turns each
 * render sync from 20 linear searches over 24 rotations into 20 array reads.
 * Building the whole table eagerly also proves at import time that every
 * combination is reachable by a proper rotation.
 */
function buildRotationTable(
  descriptors: readonly CubieDescriptor[],
  positionFaces: readonly PositionFaces[],
  orientations: number,
): Uint8Array {
  const table = new Uint8Array(descriptors.length * positionFaces.length * orientations);

  for (let cubie = 0; cubie < descriptors.length; cubie += 1) {
    const sourceFaces = descriptors[cubie]!.stickerFaces;
    for (let position = 0; position < positionFaces.length; position += 1) {
      for (let orientation = 0; orientation < orientations; orientation += 1) {
        const slot = (cubie * positionFaces.length + position) * orientations + orientation;
        table[slot] = rotationIndexFor(sourceFaces, positionFaces[position]!, orientation);
      }
    }
  }
  return table;
}

const CORNER_ORIENTATIONS = 3;
const EDGE_ORIENTATIONS = 2;
const CORNER_ROTATION_INDEX = buildRotationTable(
  CORNER_DESCRIPTORS,
  CORNER_POSITION_FACES,
  CORNER_ORIENTATIONS,
);
const EDGE_ROTATION_INDEX = buildRotationTable(
  EDGE_DESCRIPTORS,
  EDGE_POSITION_FACES,
  EDGE_ORIENTATIONS,
);

function cornerQuaternion(cubie: number, position: number, orientation: number): Quaternion {
  const slot =
    (cubie * CORNER_POSITION_FACES.length + position) * CORNER_ORIENTATIONS + orientation;
  return CUBE_ROTATIONS[CORNER_ROTATION_INDEX[slot]!]!.quaternion.clone();
}

function edgeQuaternion(cubie: number, position: number, orientation: number): Quaternion {
  const slot =
    (cubie * EDGE_POSITION_FACES.length + position) * EDGE_ORIENTATIONS + orientation;
  return CUBE_ROTATIONS[EDGE_ROTATION_INDEX[slot]!]!.quaternion.clone();
}

/** Return a fresh Three.js normal in the x=R, y=U, z=F coordinate system. */
export function faceNormal(face: Face): Vector3 {
  return toVector3(FACE_NORMALS[face]);
}

/**
 * Convert a core state into render poses. The result is always ordered by
 * stable cubie identity, never by the positions currently occupied.
 */
export function getCubiePoses(state: CubeState): CubiePose[] {
  assertValidState(state);
  const poses = new Array<CubiePose>(CUBIE_DESCRIPTORS.length);

  for (let position = 0; position < CORNER_POSITION_FACES.length; position += 1) {
    const cubie = state.cp[position]!;
    const descriptor = CORNER_DESCRIPTORS[cubie]!;
    poses[cubie] = {
      descriptor,
      gridPosition: CORNER_GRID_POSITIONS[position]!,
      quaternion: cornerQuaternion(cubie, position, state.co[position]!),
    };
  }

  const edgeOffset = CORNER_DESCRIPTORS.length;
  for (let position = 0; position < EDGE_POSITION_FACES.length; position += 1) {
    const cubie = state.ep[position]!;
    const descriptor = EDGE_DESCRIPTORS[cubie]!;
    poses[edgeOffset + cubie] = {
      descriptor,
      gridPosition: EDGE_GRID_POSITIONS[position]!,
      quaternion: edgeQuaternion(cubie, position, state.eo[position]!),
    };
  }

  const centerOffset = edgeOffset + EDGE_DESCRIPTORS.length;
  for (let center = 0; center < CENTER_DESCRIPTORS.length; center += 1) {
    const descriptor = CENTER_DESCRIPTORS[center]!;
    poses[centerOffset + center] = {
      descriptor,
      gridPosition: descriptor.homePosition,
      quaternion: new Quaternion(),
    };
  }

  return poses;
}
