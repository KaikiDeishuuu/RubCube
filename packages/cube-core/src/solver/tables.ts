import { applyMove, type Move } from '../moves.js';
import { createSolvedState } from '../state.js';

import {
  COORDINATE_SIZES,
  HTM_V1_MOVE_ORDER,
  PHASE2_MOVE_ORDER,
  PRUNING_TABLE_SPECS,
} from './constants.js';
import {
  rankCornerOrientation,
  rankCornerPermutation,
  rankEdgeOrientation,
  rankSlicePermutation,
  rankUDEdgePermutation,
  rankUDSlice,
  unrankCornerOrientation,
  unrankCornerPermutation,
  unrankEdgeOrientation,
  unrankSlicePermutation,
  unrankUDEdgePermutation,
  unrankUDSlice,
} from './coordinates.js';

export interface SolverMoveTables {
  /** Solver-owned lookup storage. Consumers must treat every array as immutable. */
  readonly co: Uint16Array;
  readonly eo: Uint16Array;
  readonly udSlice: Uint16Array;
  readonly cp: Uint16Array;
  readonly udEdgePerm: Uint16Array;
  readonly slicePerm: Uint16Array;
}

export interface SolverPruningTables {
  /** Solver-owned lookup storage. Consumers must treat every array as immutable. */
  readonly coUDSlice: Uint8Array;
  readonly eoUDSlice: Uint8Array;
  readonly cpSlicePerm: Uint8Array;
  readonly udEdgePermSlicePerm: Uint8Array;
}

export interface SolverTables {
  readonly moveTables: SolverMoveTables;
  readonly pruningTables: SolverPruningTables;
}

export type TableGenerationStage = 'move-tables' | 'pruning-tables';
export type TableGenerationName =
  | keyof SolverMoveTables
  | keyof SolverPruningTables;

export interface TableGenerationProgress {
  readonly stage: TableGenerationStage;
  readonly table: TableGenerationName;
  /** Rows processed for a move table, or pair-coordinate nodes expanded for a PDB. */
  readonly completed: number;
  readonly total: number;
}

export interface TableGenerationOptions {
  /** Observational only: callback failures never abort or alter table generation. */
  readonly onProgress?: (progress: TableGenerationProgress) => void;
}

type ProgressListener = (progress: TableGenerationProgress) => void;

interface ProjectedMoveTransform {
  /** Destination position -> source position, extracted by moving the solved cube. */
  readonly cp: Uint8Array;
  readonly co: Uint8Array;
  readonly ep: Uint8Array;
  readonly eo: Uint8Array;
}

interface CoordinateTableDefinition {
  readonly name: keyof SolverMoveTables;
  readonly coordinateCount: number;
  readonly moves: readonly Readonly<Move>[];
  readonly transforms: readonly ProjectedMoveTransform[];
  readonly unrank: (coordinate: number) => Uint8Array;
  readonly applyTransform: (
    source: Uint8Array,
    target: Uint8Array,
    transform: ProjectedMoveTransform,
  ) => void;
  readonly rank: (projection: Uint8Array) => number;
}

interface PairPruningDefinition {
  readonly name: keyof SolverPruningTables;
  readonly specName: string;
  readonly firstCount: number;
  readonly secondCount: number;
  readonly moveCount: number;
  readonly firstMoves: Uint16Array;
  readonly secondMoves: Uint16Array;
}

const UNVISITED_NIBBLE = 0x0f;
const MOVE_PROGRESS_ROW_INTERVAL = 1_024;
const PRUNING_PROGRESS_NODE_INTERVAL = 16_384;

function progressListener(options: TableGenerationOptions | undefined): ProgressListener | null {
  if (options === undefined) return null;
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Table generation options must be an object');
  }
  if (options.onProgress === undefined) return null;
  if (typeof options.onProgress !== 'function') {
    throw new TypeError('onProgress must be a function');
  }
  return options.onProgress;
}

function reportProgress(
  listener: ProgressListener | null,
  progress: TableGenerationProgress,
): void {
  if (listener === null) return;
  try {
    listener(Object.freeze({ ...progress }));
  } catch {
    // Progress is advisory. A UI/telemetry bug cannot corrupt deterministic data.
  }
}

function extractTransforms(
  moves: readonly Readonly<Move>[],
): readonly ProjectedMoveTransform[] {
  const solved = createSolvedState();
  return moves.map((move) => {
    const transformed = applyMove(solved, move);
    return {
      cp: transformed.cp,
      co: transformed.co,
      ep: transformed.ep,
      eo: transformed.eo,
    };
  });
}

function applyCornerOrientation(
  source: Uint8Array,
  target: Uint8Array,
  transform: ProjectedMoveTransform,
): void {
  for (let position = 0; position < transform.cp.length; position += 1) {
    const from = transform.cp[position]!;
    target[position] = (source[from]! + transform.co[position]!) % 3;
  }
}

function applyEdgeOrientation(
  source: Uint8Array,
  target: Uint8Array,
  transform: ProjectedMoveTransform,
): void {
  for (let position = 0; position < transform.ep.length; position += 1) {
    const from = transform.ep[position]!;
    target[position] = (source[from]! + transform.eo[position]!) % 2;
  }
}

function applyCornerPermutation(
  source: Uint8Array,
  target: Uint8Array,
  transform: ProjectedMoveTransform,
): void {
  for (let position = 0; position < transform.cp.length; position += 1) {
    target[position] = source[transform.cp[position]!]!;
  }
}

function applyEdgePermutation(
  source: Uint8Array,
  target: Uint8Array,
  transform: ProjectedMoveTransform,
): void {
  for (let position = 0; position < transform.ep.length; position += 1) {
    target[position] = source[transform.ep[position]!]!;
  }
}

function generateCoordinateMoveTable(
  definition: CoordinateTableDefinition,
  listener: ProgressListener | null,
): Uint16Array {
  const moveCount = definition.moves.length;
  if (moveCount !== definition.transforms.length) {
    throw new Error(`${definition.name} move/transform count mismatch`);
  }

  const table = new Uint16Array(definition.coordinateCount * moveCount);
  reportProgress(listener, {
    stage: 'move-tables',
    table: definition.name,
    completed: 0,
    total: definition.coordinateCount,
  });

  for (let coordinate = 0; coordinate < definition.coordinateCount; coordinate += 1) {
    const source = definition.unrank(coordinate);
    const target = new Uint8Array(source.length);
    const rowOffset = coordinate * moveCount;

    for (let moveIndex = 0; moveIndex < moveCount; moveIndex += 1) {
      definition.applyTransform(source, target, definition.transforms[moveIndex]!);
      const nextCoordinate = definition.rank(target);
      if (nextCoordinate < 0 || nextCoordinate >= definition.coordinateCount) {
        throw new Error(
          `${definition.name} transition escaped its coordinate range`,
        );
      }
      table[rowOffset + moveIndex] = nextCoordinate;
    }

    const completed = coordinate + 1;
    if (
      completed === definition.coordinateCount ||
      completed % MOVE_PROGRESS_ROW_INTERVAL === 0
    ) {
      reportProgress(listener, {
        stage: 'move-tables',
        table: definition.name,
        completed,
        total: definition.coordinateCount,
      });
    }
  }

  return table;
}

function generateMoveTablesWithListener(
  listener: ProgressListener | null,
): SolverMoveTables {
  const phase1Transforms = extractTransforms(HTM_V1_MOVE_ORDER);
  const phase2Transforms = extractTransforms(PHASE2_MOVE_ORDER);

  return Object.freeze({
    co: generateCoordinateMoveTable(
      {
        name: 'co',
        coordinateCount: COORDINATE_SIZES.CO,
        moves: HTM_V1_MOVE_ORDER,
        transforms: phase1Transforms,
        unrank: unrankCornerOrientation,
        applyTransform: applyCornerOrientation,
        rank: rankCornerOrientation,
      },
      listener,
    ),
    eo: generateCoordinateMoveTable(
      {
        name: 'eo',
        coordinateCount: COORDINATE_SIZES.EO,
        moves: HTM_V1_MOVE_ORDER,
        transforms: phase1Transforms,
        unrank: unrankEdgeOrientation,
        applyTransform: applyEdgeOrientation,
        rank: rankEdgeOrientation,
      },
      listener,
    ),
    udSlice: generateCoordinateMoveTable(
      {
        name: 'udSlice',
        coordinateCount: COORDINATE_SIZES.UDSlice,
        moves: HTM_V1_MOVE_ORDER,
        transforms: phase1Transforms,
        unrank: unrankUDSlice,
        applyTransform: applyEdgePermutation,
        rank: rankUDSlice,
      },
      listener,
    ),
    cp: generateCoordinateMoveTable(
      {
        name: 'cp',
        coordinateCount: COORDINATE_SIZES.CP,
        moves: PHASE2_MOVE_ORDER,
        transforms: phase2Transforms,
        unrank: unrankCornerPermutation,
        applyTransform: applyCornerPermutation,
        rank: rankCornerPermutation,
      },
      listener,
    ),
    udEdgePerm: generateCoordinateMoveTable(
      {
        name: 'udEdgePerm',
        coordinateCount: COORDINATE_SIZES.UDEdgePerm,
        moves: PHASE2_MOVE_ORDER,
        transforms: phase2Transforms,
        unrank: unrankUDEdgePermutation,
        applyTransform: applyEdgePermutation,
        rank: rankUDEdgePermutation,
      },
      listener,
    ),
    slicePerm: generateCoordinateMoveTable(
      {
        name: 'slicePerm',
        coordinateCount: COORDINATE_SIZES.SlicePerm,
        moves: PHASE2_MOVE_ORDER,
        transforms: phase2Transforms,
        unrank: unrankSlicePermutation,
        applyTransform: applyEdgePermutation,
        rank: rankSlicePermutation,
      },
      listener,
    ),
  });
}

function assertMoveTable(
  table: Uint16Array,
  name: keyof SolverMoveTables,
  coordinateCount: number,
  moveCount: number,
): void {
  if (!(table instanceof Uint16Array)) {
    throw new TypeError(`${name} must be a Uint16Array`);
  }
  const expectedLength = coordinateCount * moveCount;
  if (table.length !== expectedLength) {
    throw new RangeError(
      `${name} must contain exactly ${expectedLength} transitions`,
    );
  }
  for (const coordinate of table) {
    if (coordinate >= coordinateCount) {
      throw new RangeError(`${name} contains an out-of-range transition`);
    }
  }
}

function validateMoveTables(moveTables: SolverMoveTables): void {
  if (typeof moveTables !== 'object' || moveTables === null) {
    throw new TypeError('moveTables must be an object');
  }
  assertMoveTable(
    moveTables.co,
    'co',
    COORDINATE_SIZES.CO,
    HTM_V1_MOVE_ORDER.length,
  );
  assertMoveTable(
    moveTables.eo,
    'eo',
    COORDINATE_SIZES.EO,
    HTM_V1_MOVE_ORDER.length,
  );
  assertMoveTable(
    moveTables.udSlice,
    'udSlice',
    COORDINATE_SIZES.UDSlice,
    HTM_V1_MOVE_ORDER.length,
  );
  assertMoveTable(
    moveTables.cp,
    'cp',
    COORDINATE_SIZES.CP,
    PHASE2_MOVE_ORDER.length,
  );
  assertMoveTable(
    moveTables.udEdgePerm,
    'udEdgePerm',
    COORDINATE_SIZES.UDEdgePerm,
    PHASE2_MOVE_ORDER.length,
  );
  assertMoveTable(
    moveTables.slicePerm,
    'slicePerm',
    COORDINATE_SIZES.SlicePerm,
    PHASE2_MOVE_ORDER.length,
  );
}

/**
 * Read one packed four-bit distance. Even indices occupy the low nibble.
 * `entryCount` is explicit because an odd-sized table's final high nibble is
 * padding rather than a readable coordinate.
 */
export function readPruningDistance(
  table: Uint8Array,
  index: number,
  entryCount: number,
): number {
  if (!(table instanceof Uint8Array)) {
    throw new TypeError('Pruning table must be a Uint8Array');
  }
  if (
    !Number.isSafeInteger(entryCount) ||
    entryCount < 0 ||
    Math.ceil(entryCount / 2) !== table.length
  ) {
    throw new RangeError('Pruning-table entry count does not match its storage');
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= entryCount) {
    throw new RangeError('Pruning-table index is out of range');
  }
  return readPruningDistanceUnchecked(table, index);
}

function readPruningDistanceUnchecked(table: Uint8Array, index: number): number {
  const packed = table[index >>> 1]!;
  return (index & 1) === 0 ? packed & 0x0f : packed >>> 4;
}

function writePruningDistanceUnchecked(
  table: Uint8Array,
  index: number,
  distance: number,
): void {
  const byteIndex = index >>> 1;
  const packed = table[byteIndex]!;
  table[byteIndex] = (index & 1) === 0
    ? (packed & 0xf0) | distance
    : (packed & 0x0f) | (distance << 4);
}

function expectedPruningDepth(specName: string): number {
  const spec = PRUNING_TABLE_SPECS.find((candidate) => candidate.name === specName);
  if (spec === undefined) {
    throw new Error(`Missing pruning-table specification: ${specName}`);
  }
  return spec.maximumDepth;
}

function generatePairPruningTable(
  definition: PairPruningDefinition,
  listener: ProgressListener | null,
  queue: Uint32Array,
): Uint8Array {
  const entryCount = definition.firstCount * definition.secondCount;
  if (queue.length < entryCount) {
    throw new RangeError(`${definition.name} queue is smaller than its state space`);
  }
  const distances = new Uint8Array(Math.ceil(entryCount / 2));
  distances.fill(0xff);
  let head = 0;
  let tail = 1;
  let maximumDepth = 0;
  queue[0] = 0;
  writePruningDistanceUnchecked(distances, 0, 0);

  reportProgress(listener, {
    stage: 'pruning-tables',
    table: definition.name,
    completed: 0,
    total: entryCount,
  });

  while (head < tail) {
    const pair = queue[head]!;
    head += 1;
    const first = Math.floor(pair / definition.secondCount);
    const second = pair - first * definition.secondCount;
    const depth = readPruningDistanceUnchecked(distances, pair);
    const nextDepth = depth + 1;
    const firstRow = first * definition.moveCount;
    const secondRow = second * definition.moveCount;

    for (let moveIndex = 0; moveIndex < definition.moveCount; moveIndex += 1) {
      const nextFirst = definition.firstMoves[firstRow + moveIndex]!;
      const nextSecond = definition.secondMoves[secondRow + moveIndex]!;
      const nextPair = nextFirst * definition.secondCount + nextSecond;
      if (
        readPruningDistanceUnchecked(distances, nextPair) !==
        UNVISITED_NIBBLE
      ) {
        continue;
      }
      if (nextDepth >= UNVISITED_NIBBLE) {
        throw new Error(`${definition.name} depth collides with the unvisited nibble`);
      }
      writePruningDistanceUnchecked(distances, nextPair, nextDepth);
      queue[tail] = nextPair;
      tail += 1;
      if (nextDepth > maximumDepth) maximumDepth = nextDepth;
    }

    if (head === entryCount || head % PRUNING_PROGRESS_NODE_INTERVAL === 0) {
      reportProgress(listener, {
        stage: 'pruning-tables',
        table: definition.name,
        completed: head,
        total: entryCount,
      });
    }
  }

  if (tail !== entryCount) {
    throw new Error(
      `${definition.name} visited ${tail} of ${entryCount} pair coordinates`,
    );
  }
  const expectedDepth = expectedPruningDepth(definition.specName);
  if (maximumDepth !== expectedDepth) {
    throw new Error(
      `${definition.name} diameter ${maximumDepth} does not match ${expectedDepth}`,
    );
  }

  return distances;
}

function generatePruningTablesWithListener(
  moveTables: SolverMoveTables,
  listener: ProgressListener | null,
): SolverPruningTables {
  validateMoveTables(moveTables);
  const phase1MoveCount = HTM_V1_MOVE_ORDER.length;
  const phase2MoveCount = PHASE2_MOVE_ORDER.length;
  const queue = new Uint32Array(
    Math.max(...PRUNING_TABLE_SPECS.map((spec) => spec.entryCount)),
  );

  return Object.freeze({
    coUDSlice: generatePairPruningTable(
      {
        name: 'coUDSlice',
        specName: 'co-ud-slice',
        firstCount: COORDINATE_SIZES.CO,
        secondCount: COORDINATE_SIZES.UDSlice,
        moveCount: phase1MoveCount,
        firstMoves: moveTables.co,
        secondMoves: moveTables.udSlice,
      },
      listener,
      queue,
    ),
    eoUDSlice: generatePairPruningTable(
      {
        name: 'eoUDSlice',
        specName: 'eo-ud-slice',
        firstCount: COORDINATE_SIZES.EO,
        secondCount: COORDINATE_SIZES.UDSlice,
        moveCount: phase1MoveCount,
        firstMoves: moveTables.eo,
        secondMoves: moveTables.udSlice,
      },
      listener,
      queue,
    ),
    cpSlicePerm: generatePairPruningTable(
      {
        name: 'cpSlicePerm',
        specName: 'cp-slice-perm',
        firstCount: COORDINATE_SIZES.CP,
        secondCount: COORDINATE_SIZES.SlicePerm,
        moveCount: phase2MoveCount,
        firstMoves: moveTables.cp,
        secondMoves: moveTables.slicePerm,
      },
      listener,
      queue,
    ),
    udEdgePermSlicePerm: generatePairPruningTable(
      {
        name: 'udEdgePermSlicePerm',
        specName: 'ud-edge-perm-slice-perm',
        firstCount: COORDINATE_SIZES.UDEdgePerm,
        secondCount: COORDINATE_SIZES.SlicePerm,
        moveCount: phase2MoveCount,
        firstMoves: moveTables.udEdgePerm,
        secondMoves: moveTables.slicePerm,
      },
      listener,
      queue,
    ),
  });
}

/** Generate all six coordinate-major transition tables. */
export function generateMoveTables(
  options?: TableGenerationOptions,
): SolverMoveTables {
  return generateMoveTablesWithListener(progressListener(options));
}

/** Generate all four low-nibble-first pair-coordinate pruning tables. */
export function generatePruningTables(
  moveTables: SolverMoveTables,
  options?: TableGenerationOptions,
): SolverPruningTables {
  return generatePruningTablesWithListener(moveTables, progressListener(options));
}

/** Generate the complete decoded M3a table set synchronously. */
export function generateSolverTables(
  options?: TableGenerationOptions,
): SolverTables {
  const listener = progressListener(options);
  const moveTables = generateMoveTablesWithListener(listener);
  return Object.freeze({
    moveTables,
    pruningTables: generatePruningTablesWithListener(moveTables, listener),
  });
}
