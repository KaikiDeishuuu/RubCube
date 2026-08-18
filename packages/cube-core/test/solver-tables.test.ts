import { beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMove, type Move } from '../src/moves.js';
import { mulberry32, randomInt } from '../src/rng.js';
import { generateRandomState } from '../src/scramble.js';
import {
  COORDINATE_SIZES,
  createTableArtifact,
  decodeTableArtifact,
  generateMoveTables,
  generatePruningTables,
  generateSolverTables,
  HTM_V1_INVERSE_MOVE_INDEX,
  HTM_V1_MOVE_ORDER,
  MOVE_TABLE_BYTE_LENGTH,
  PHASE2_MOVE_ORDER,
  PHASE2_TO_HTM_MOVE_INDEX,
  rankCornerOrientation,
  rankCornerPermutation,
  rankEdgeOrientation,
  rankSlicePermutation,
  rankUDEdgePermutation,
  rankUDSlice,
  readPruningDistance,
  TABLE_ARTIFACT_BYTE_ORDER,
  TABLE_ARTIFACT_FORMAT_VERSION,
  TABLE_ARTIFACT_MAGIC,
  TABLE_FINGERPRINT,
  unrankCornerOrientation,
  unrankCornerPermutation,
  unrankEdgeOrientation,
  unrankSlicePermutation,
  unrankUDEdgePermutation,
  unrankUDSlice,
  type LoadTablesOptions,
  type SolverMoveTables,
  type SolverPruningTables,
  type SolverTables,
  type TableArtifact,
  type TableGenerationProgress,
  type TableStore,
} from '../src/solver/index.js';
import {
  assertValidState,
  createSolvedState,
  type CubeState,
} from '../src/state.js';

const TEST_TIMEOUT = 120_000;
const UINT32_MAX = 0xffff_ffff;

interface MoveTableCase {
  readonly name: keyof SolverMoveTables;
  readonly coordinateCount: number;
  readonly moves: readonly Readonly<Move>[];
  readonly inverseMoveIndices: readonly number[];
  readonly rank: (state: CubeState) => number;
}

interface PruningTableCase {
  readonly name: keyof SolverPruningTables;
  readonly firstCount: number;
  readonly secondCount: number;
  readonly firstMoves: keyof SolverMoveTables;
  readonly secondMoves: keyof SolverMoveTables;
  readonly moveCount: number;
  readonly maximumDepth: number;
  readonly histogram: readonly number[];
}

const PHASE2_INVERSE_MOVE_INDEX = Object.freeze(
  PHASE2_TO_HTM_MOVE_INDEX.map((htmMoveIndex) => {
    const inverseHTMMoveIndex = HTM_V1_INVERSE_MOVE_INDEX[htmMoveIndex]!;
    const phase2MoveIndex = PHASE2_TO_HTM_MOVE_INDEX.indexOf(inverseHTMMoveIndex);
    if (phase2MoveIndex < 0) {
      throw new Error(`phase-2 move ${htmMoveIndex} has no phase-2 inverse`);
    }
    return phase2MoveIndex;
  }),
);

const PHASE1_MOVE_TABLES: readonly MoveTableCase[] = [
  {
    name: 'co',
    coordinateCount: COORDINATE_SIZES.CO,
    moves: HTM_V1_MOVE_ORDER,
    inverseMoveIndices: HTM_V1_INVERSE_MOVE_INDEX,
    rank: (state) => rankCornerOrientation(state.co),
  },
  {
    name: 'eo',
    coordinateCount: COORDINATE_SIZES.EO,
    moves: HTM_V1_MOVE_ORDER,
    inverseMoveIndices: HTM_V1_INVERSE_MOVE_INDEX,
    rank: (state) => rankEdgeOrientation(state.eo),
  },
  {
    name: 'udSlice',
    coordinateCount: COORDINATE_SIZES.UDSlice,
    moves: HTM_V1_MOVE_ORDER,
    inverseMoveIndices: HTM_V1_INVERSE_MOVE_INDEX,
    rank: (state) => rankUDSlice(state.ep),
  },
];

const PHASE2_MOVE_TABLES: readonly MoveTableCase[] = [
  {
    name: 'cp',
    coordinateCount: COORDINATE_SIZES.CP,
    moves: PHASE2_MOVE_ORDER,
    inverseMoveIndices: PHASE2_INVERSE_MOVE_INDEX,
    rank: (state) => rankCornerPermutation(state.cp),
  },
  {
    name: 'udEdgePerm',
    coordinateCount: COORDINATE_SIZES.UDEdgePerm,
    moves: PHASE2_MOVE_ORDER,
    inverseMoveIndices: PHASE2_INVERSE_MOVE_INDEX,
    rank: (state) => rankUDEdgePermutation(state.ep),
  },
  {
    name: 'slicePerm',
    coordinateCount: COORDINATE_SIZES.SlicePerm,
    moves: PHASE2_MOVE_ORDER,
    inverseMoveIndices: PHASE2_INVERSE_MOVE_INDEX,
    rank: (state) => rankSlicePermutation(state.ep),
  },
];

const ALL_MOVE_TABLES = [...PHASE1_MOVE_TABLES, ...PHASE2_MOVE_TABLES];

const PRUNING_TABLES: readonly PruningTableCase[] = [
  {
    name: 'coUDSlice',
    firstCount: COORDINATE_SIZES.CO,
    secondCount: COORDINATE_SIZES.UDSlice,
    firstMoves: 'co',
    secondMoves: 'udSlice',
    moveCount: HTM_V1_MOVE_ORDER.length,
    maximumDepth: 9,
    histogram: [1, 4, 50, 586, 6_184, 54_066, 296_322, 582_492, 142_520, 340],
  },
  {
    name: 'eoUDSlice',
    firstCount: COORDINATE_SIZES.EO,
    secondCount: COORDINATE_SIZES.UDSlice,
    firstMoves: 'eo',
    secondMoves: 'udSlice',
    moveCount: HTM_V1_MOVE_ORDER.length,
    maximumDepth: 9,
    histogram: [1, 4, 50, 532, 4_804, 41_832, 238_263, 555_636, 172_314, 324],
  },
  {
    name: 'cpSlicePerm',
    firstCount: COORDINATE_SIZES.CP,
    secondCount: COORDINATE_SIZES.SlicePerm,
    firstMoves: 'cp',
    secondMoves: 'slicePerm',
    moveCount: PHASE2_MOVE_ORDER.length,
    maximumDepth: 14,
    histogram: [
      1,
      10,
      67,
      404,
      2_023,
      8_504,
      28_545,
      69_734,
      127_540,
      179_700,
      189_120,
      199_200,
      116_112,
      44_416,
      2_304,
    ],
  },
  {
    name: 'udEdgePermSlicePerm',
    firstCount: COORDINATE_SIZES.UDEdgePerm,
    secondCount: COORDINATE_SIZES.SlicePerm,
    firstMoves: 'udEdgePerm',
    secondMoves: 'slicePerm',
    moveCount: PHASE2_MOVE_ORDER.length,
    maximumDepth: 12,
    histogram: [
      1,
      10,
      67,
      456,
      3_063,
      18_202,
      86_691,
      290_812,
      434_814,
      120_488,
      11_818,
      1_114,
      144,
    ],
  },
];

let tables: SolverTables;
let artifact: TableArtifact;
const progressEvents: TableGenerationProgress[] = [];

beforeAll(() => {
  tables = generateSolverTables({
    onProgress(progress) {
      progressEvents.push(progress);
    },
  });
  artifact = createTableArtifact(tables);
}, TEST_TIMEOUT);

function permutationParity(permutation: Uint8Array): 0 | 1 {
  let parity = 0;
  for (let left = 0; left < permutation.length; left += 1) {
    for (let right = left + 1; right < permutation.length; right += 1) {
      if (permutation[left]! > permutation[right]!) parity ^= 1;
    }
  }
  return parity as 0 | 1;
}

function swap(values: Uint8Array, first: number, second: number): void {
  const held = values[first]!;
  values[first] = values[second]!;
  values[second] = held;
}

/**
 * Canonical coordinate decoders do not always form a reachable complete cube:
 * omitted permutations may have the opposite parity. Repair only an omitted
 * component so the coordinate under test remains unchanged.
 */
function legalRepresentative(name: keyof SolverMoveTables, coordinate: number): CubeState {
  const state = createSolvedState();
  switch (name) {
    case 'co':
      state.co = unrankCornerOrientation(coordinate);
      break;
    case 'eo':
      state.eo = unrankEdgeOrientation(coordinate);
      break;
    case 'udSlice':
      state.ep = unrankUDSlice(coordinate);
      if (permutationParity(state.ep) !== 0) swap(state.cp, 0, 1);
      break;
    case 'cp':
      state.cp = unrankCornerPermutation(coordinate);
      if (permutationParity(state.cp) !== 0) swap(state.ep, 8, 9);
      break;
    case 'udEdgePerm':
      state.ep = unrankUDEdgePermutation(coordinate);
      if (permutationParity(state.ep) !== 0) swap(state.cp, 0, 1);
      break;
    case 'slicePerm':
      state.ep = unrankSlicePermutation(coordinate);
      if (permutationParity(state.ep) !== 0) swap(state.cp, 0, 1);
      break;
  }
  assertValidState(state);
  return state;
}

function assertTableTransition(
  definition: MoveTableCase,
  state: CubeState,
  moveIndex: number,
): CubeState {
  const coordinate = definition.rank(state);
  const moved = applyMove(state, definition.moves[moveIndex]!);
  const expected = definition.rank(moved);
  const actual = tables.moveTables[definition.name][
    coordinate * definition.moves.length + moveIndex
  ];
  if (actual !== expected) {
    throw new Error(
      `${definition.name}[${coordinate}, ${moveIndex}] is ${actual}, expected ${expected}`,
    );
  }
  return moved;
}

function packedDistance(table: Uint8Array, index: number): number {
  const packed = table[index >>> 1]!;
  return (index & 1) === 0 ? packed & 0x0f : packed >>> 4;
}

function assertArrayEqual(
  actual: Uint8Array | Uint16Array,
  expected: Uint8Array | Uint16Array,
  label: string,
): void {
  if (actual.constructor !== expected.constructor) {
    throw new Error(`${label} changed typed-array representation`);
  }
  if (actual.length !== expected.length) {
    throw new Error(`${label} length ${actual.length}, expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `${label}[${index}] is ${actual[index]}, expected ${expected[index]}`,
      );
    }
  }
}

function assertSolverTablesEqual(actual: SolverTables, expected: SolverTables): void {
  for (const definition of ALL_MOVE_TABLES) {
    assertArrayEqual(
      actual.moveTables[definition.name],
      expected.moveTables[definition.name],
      definition.name,
    );
  }
  for (const definition of PRUNING_TABLES) {
    assertArrayEqual(
      actual.pruningTables[definition.name],
      expected.pruningTables[definition.name],
      definition.name,
    );
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder =
        (remainder & 1) === 0
          ? remainder >>> 1
          : 0xedb8_8320 ^ (remainder >>> 1);
    }
    table[value] = remainder >>> 0;
  }
  return table;
})();

function checksum(bytes: Uint8Array): string {
  let value = UINT32_MAX;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return `crc32:${((value ^ UINT32_MAX) >>> 0).toString(16).padStart(8, '0')}`;
}

function artifactWithBytes(bytes: Uint8Array): TableArtifact {
  return {
    ...artifact,
    byteLength: bytes.byteLength,
    checksum: checksum(bytes),
    bytes,
  };
}

function patchedArtifact(patch: (bytes: Uint8Array) => void): TableArtifact {
  const bytes = artifact.bytes.slice();
  patch(bytes);
  return artifactWithBytes(bytes);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]!);
  }
  return value;
}

async function importFreshArtifactModule(
  generator: (options?: LoadTablesOptions) => SolverTables,
): Promise<typeof import('../src/solver/artifact.js')> {
  vi.resetModules();
  vi.doMock('../src/solver/tables.js', () => ({ generateSolverTables: generator }));
  return import('../src/solver/artifact.js');
}

function restoreArtifactModule(): void {
  vi.doUnmock('../src/solver/tables.js');
  vi.resetModules();
}

describe('solver move tables', () => {
  it('reports bounded progress from zero through every completed table', () => {
    for (const definition of ALL_MOVE_TABLES) {
      const events = progressEvents.filter(
        (event) => event.stage === 'move-tables' && event.table === definition.name,
      );
      expect(events[0]).toEqual({
        stage: 'move-tables',
        table: definition.name,
        completed: 0,
        total: definition.coordinateCount,
      });
      expect(events.at(-1)?.completed).toBe(definition.coordinateCount);
      expect(events.every(Object.isFrozen)).toBe(true);
    }
    for (const definition of PRUNING_TABLES) {
      const entryCount = definition.firstCount * definition.secondCount;
      const events = progressEvents.filter(
        (event) => event.stage === 'pruning-tables' && event.table === definition.name,
      );
      expect(events[0]).toEqual({
        stage: 'pruning-tables',
        table: definition.name,
        completed: 0,
        total: entryCount,
      });
      expect(events.at(-1)?.completed).toBe(entryCount);
      expect(events.every(Object.isFrozen)).toBe(true);
    }
  });

  it(
    'uses coordinate-major rows and matches cubie moves for every table entry',
    () => {
      for (const definition of ALL_MOVE_TABLES) {
        const table = tables.moveTables[definition.name];
        expect(table).toBeInstanceOf(Uint16Array);
        expect(table).toHaveLength(
          definition.coordinateCount * definition.moves.length,
        );

        for (let coordinate = 0; coordinate < definition.coordinateCount; coordinate += 1) {
          const representative = legalRepresentative(definition.name, coordinate);
          if (definition.rank(representative) !== coordinate) {
            throw new Error(`${definition.name} representative changed coordinate ${coordinate}`);
          }
          for (let moveIndex = 0; moveIndex < definition.moves.length; moveIndex += 1) {
            assertTableTransition(definition, representative, moveIndex);
          }
        }
      }
    },
    TEST_TIMEOUT,
  );

  it('tracks all phase-1 coordinates through ordinary reachable states', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      let state = generateRandomState(seed ^ 0x5255_4243);
      const random = mulberry32(seed ^ 0xa35c_91e7);
      for (let step = 0; step < 32; step += 1) {
        const moveIndex = randomInt(random, HTM_V1_MOVE_ORDER.length);
        for (const definition of PHASE1_MOVE_TABLES) {
          assertTableTransition(definition, state, moveIndex);
        }
        state = applyMove(state, HTM_V1_MOVE_ORDER[moveIndex]!);
      }
    }
  });

  it('tracks all phase-2 coordinates through the phase-2 subgroup', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      let state = createSolvedState();
      const random = mulberry32(seed ^ 0x7068_6173);
      for (let step = 0; step < 64; step += 1) {
        const moveIndex = randomInt(random, PHASE2_MOVE_ORDER.length);
        for (const definition of PHASE2_MOVE_TABLES) {
          assertTableTransition(definition, state, moveIndex);
        }
        state = applyMove(state, PHASE2_MOVE_ORDER[moveIndex]!);
      }
    }
  });

  it('closes every transition under its inverse move', () => {
    for (const definition of ALL_MOVE_TABLES) {
      const table = tables.moveTables[definition.name];
      const moveCount = definition.moves.length;
      for (let coordinate = 0; coordinate < definition.coordinateCount; coordinate += 1) {
        const row = coordinate * moveCount;
        for (let moveIndex = 0; moveIndex < moveCount; moveIndex += 1) {
          const moved = table[row + moveIndex]!;
          const inverseMoveIndex = definition.inverseMoveIndices[moveIndex]!;
          const restored = table[moved * moveCount + inverseMoveIndex];
          if (restored !== coordinate) {
            throw new Error(
              `${definition.name}[${coordinate}, ${moveIndex}] restored to ${restored}`,
            );
          }
        }
      }
    }
  });

  it(
    'keeps progress observational and validates public table inputs',
    () => {
      const withoutProgress = generateMoveTables();
      const throwingProgress = generateMoveTables({
        onProgress() {
          throw new Error('observer failure');
        },
      });
      for (const definition of ALL_MOVE_TABLES) {
        assertArrayEqual(
          withoutProgress[definition.name],
          tables.moveTables[definition.name],
          `${definition.name} without progress`,
        );
        assertArrayEqual(
          throwingProgress[definition.name],
          tables.moveTables[definition.name],
          `${definition.name} with throwing progress`,
        );
      }

      expect(() =>
        generateMoveTables(null as unknown as LoadTablesOptions),
      ).toThrow(/options/i);
      expect(() =>
        generateMoveTables({ onProgress: 1 } as unknown as LoadTablesOptions),
      ).toThrow(/onProgress/i);
      expect(() =>
        generatePruningTables(null as unknown as SolverMoveTables),
      ).toThrow(/moveTables/i);

      const wrongType = {
        ...tables.moveTables,
        co: new Uint8Array(tables.moveTables.co.length),
      } as unknown as SolverMoveTables;
      expect(() => generatePruningTables(wrongType)).toThrow(/Uint16Array/i);

      const wrongLength = {
        ...tables.moveTables,
        co: tables.moveTables.co.slice(1),
      };
      expect(() => generatePruningTables(wrongLength)).toThrow(/exactly/i);

      const escaped = tables.moveTables.co.slice();
      escaped[0] = COORDINATE_SIZES.CO;
      expect(() =>
        generatePruningTables({ ...tables.moveTables, co: escaped }),
      ).toThrow(/out-of-range/i);

      expect(() =>
        readPruningDistance(
          new Uint16Array(1) as unknown as Uint8Array,
          0,
          2,
        ),
      ).toThrow(/Uint8Array/i);
      expect(() => readPruningDistance(new Uint8Array(1), -1, 2)).toThrow(
        RangeError,
      );
      expect(() => readPruningDistance(new Uint8Array(1), 0.5, 2)).toThrow(
        RangeError,
      );
      expect(() => readPruningDistance(new Uint8Array(1), 2, 2)).toThrow(
        RangeError,
      );
      expect(() => readPruningDistance(new Uint8Array(1), 0, 3)).toThrow(
        /entry count/i,
      );
    },
    TEST_TIMEOUT,
  );
});

describe('solver pruning tables', () => {
  it(
    'visits every pair, pins each histogram, and gives every node a descending edge',
    () => {
      for (const definition of PRUNING_TABLES) {
        const table = tables.pruningTables[definition.name];
        const firstMoves = tables.moveTables[definition.firstMoves];
        const secondMoves = tables.moveTables[definition.secondMoves];
        const entryCount = definition.firstCount * definition.secondCount;
        const histogram = new Array<number>(definition.maximumDepth + 1).fill(0);
        let maximumDepth = 0;

        expect(table).toBeInstanceOf(Uint8Array);
        expect(table).toHaveLength(Math.ceil(entryCount / 2));
        expect(readPruningDistance(table, 0, entryCount)).toBe(0);

        for (let pair = 0; pair < entryCount; pair += 1) {
          const depth = readPruningDistance(table, pair, entryCount);
          if (depth === 0x0f || depth > definition.maximumDepth) {
            throw new Error(`${definition.name}[${pair}] has invalid depth ${depth}`);
          }
          histogram[depth] = histogram[depth]! + 1;
          if (depth > maximumDepth) maximumDepth = depth;
          if (depth === 0) continue;

          const first = Math.floor(pair / definition.secondCount);
          const second = pair - first * definition.secondCount;
          const firstRow = first * definition.moveCount;
          const secondRow = second * definition.moveCount;
          let hasDescendingMove = false;
          for (let moveIndex = 0; moveIndex < definition.moveCount; moveIndex += 1) {
            const nextFirst = firstMoves[firstRow + moveIndex]!;
            const nextSecond = secondMoves[secondRow + moveIndex]!;
            const nextPair = nextFirst * definition.secondCount + nextSecond;
            if (packedDistance(table, nextPair) === depth - 1) {
              hasDescendingMove = true;
              break;
            }
          }
          if (!hasDescendingMove) {
            throw new Error(
              `${definition.name}[${pair}] at depth ${depth} has no depth-${depth - 1} neighbor`,
            );
          }
        }

        expect(histogram).toEqual(definition.histogram);
        expect(maximumDepth).toBe(definition.maximumDepth);
      }
    },
    TEST_TIMEOUT,
  );

  it('keeps the unused high nibble marked unvisited in the odd-sized table', () => {
    const entryCount = COORDINATE_SIZES.CO * COORDINATE_SIZES.UDSlice;
    expect(entryCount % 2).toBe(1);
    expect(tables.pruningTables.coUDSlice.at(-1)! >>> 4).toBe(0x0f);
    expect(
      tables.pruningTables.coUDSlice.at(-1)! & 0x0f,
    ).toBe(
      readPruningDistance(
        tables.pruningTables.coUDSlice,
        entryCount - 1,
        entryCount,
      ),
    );
    expect(() =>
      readPruningDistance(tables.pruningTables.coUDSlice, entryCount, entryCount),
    ).toThrow(RangeError);
  });
});

describe('solver table artifact', () => {
  it('round-trips every byte and pins the platform-neutral header and LE payload', () => {
    expect(artifact.formatVersion).toBe(TABLE_ARTIFACT_FORMAT_VERSION);
    expect(artifact.solverFingerprint).toBe(TABLE_FINGERPRINT);
    expect(artifact.byteOrder).toBe(TABLE_ARTIFACT_BYTE_ORDER);
    expect(artifact.byteLength).toBe(artifact.bytes.byteLength);
    expect(artifact.checksum).toBe(checksum(artifact.bytes));
    expect(ascii(artifact.bytes, 0, 4)).toBe(TABLE_ARTIFACT_MAGIC);

    const view = new DataView(
      artifact.bytes.buffer,
      artifact.bytes.byteOffset,
      artifact.bytes.byteLength,
    );
    expect(view.getUint32(4, true)).toBe(TABLE_ARTIFACT_FORMAT_VERSION);
    expect(ascii(artifact.bytes, 8, 2)).toBe(TABLE_ARTIFACT_BYTE_ORDER);
    expect(view.getUint32(24, true)).toBe(artifact.byteLength);

    const payloadOffset = view.getUint32(20, true);
    for (const index of [0, 1, 17, 18, tables.moveTables.co.length - 1]) {
      expect(view.getUint16(payloadOffset + index * 2, true)).toBe(
        tables.moveTables.co[index],
      );
    }

    assertSolverTablesEqual(decodeTableArtifact(artifact), tables);
  });

  it('rejects wrong envelope metadata and checksum corruption', () => {
    expect(() =>
      decodeTableArtifact(null as unknown as TableArtifact),
    ).toThrow(/artifact/i);
    expect(() =>
      decodeTableArtifact({
        ...artifact,
        formatVersion: TABLE_ARTIFACT_FORMAT_VERSION + 1,
      }),
    ).toThrow(/version/i);
    expect(() =>
      decodeTableArtifact({
        ...artifact,
        solverFingerprint: `${TABLE_FINGERPRINT}-wrong`,
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      decodeTableArtifact({ ...artifact, byteOrder: 'BE' as 'LE' }),
    ).toThrow(/byte order/i);
    expect(() =>
      decodeTableArtifact({
        ...artifact,
        bytes: new Uint16Array(1) as unknown as Uint8Array,
      }),
    ).toThrow(/Uint8Array/i);
    expect(() =>
      decodeTableArtifact({ ...artifact, byteLength: artifact.byteLength - 1 }),
    ).toThrow(/byteLength/i);
    expect(() =>
      decodeTableArtifact({ ...artifact, byteLength: Number.NaN }),
    ).toThrow(/byteLength/i);
    expect(() =>
      decodeTableArtifact({ ...artifact, checksum: 'sha256:not-crc32' }),
    ).toThrow(/checksum/i);
    expect(() =>
      decodeTableArtifact({ ...artifact, checksum: 'crc32:00000000' }),
    ).toThrow(/checksum/i);

    const corruptedPayload = artifact.bytes.slice();
    corruptedPayload[corruptedPayload.length - 1] =
      corruptedPayload[corruptedPayload.length - 1]! ^ 0x01;
    expect(() =>
      decodeTableArtifact({ ...artifact, bytes: corruptedPayload }),
    ).toThrow(/checksum/i);
  });

  it('rejects rechecksummed magic, version, fingerprint, length, and truncation damage', () => {
    expect(() =>
      decodeTableArtifact(
        patchedArtifact((bytes) => {
          bytes[0] = bytes[0]! ^ 0x01;
        }),
      ),
    ).toThrow(/magic/i);
    expect(() =>
      decodeTableArtifact(
        patchedArtifact((bytes) => {
          new DataView(bytes.buffer).setUint32(
            4,
            TABLE_ARTIFACT_FORMAT_VERSION + 1,
            true,
          );
        }),
      ),
    ).toThrow(/version/i);
    expect(() =>
      decodeTableArtifact(
        patchedArtifact((bytes) => {
          bytes[28] = bytes[28]! ^ 0x01;
        }),
      ),
    ).toThrow(/fingerprint/i);
    expect(() =>
      decodeTableArtifact(
        patchedArtifact((bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint32(24, view.getUint32(24, true) - 1, true);
        }),
      ),
    ).toThrow(/length/i);

    const truncated = artifactWithBytes(artifact.bytes.slice(0, -31));
    expect(() => decodeTableArtifact(truncated)).toThrow(/length|truncat/i);
    expect(() => decodeTableArtifact(artifactWithBytes(new Uint8Array(0)))).toThrow(
      /length|truncat/i,
    );
  });

  it('rejects rechecksummed header and section-descriptor damage', () => {
    const headerCases: readonly [
      label: string,
      expected: RegExp,
      patch: (bytes: Uint8Array) => void,
    ][] = [
      [
        'byte order',
        /byte order/i,
        (bytes) => {
          bytes[8] = 'B'.charCodeAt(0);
        },
      ],
      [
        'section count',
        /section count/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint16(10, view.getUint16(10, true) - 1, true);
        },
      ],
      [
        'header reserved bits',
        /reserved/i,
        (bytes) => {
          new DataView(bytes.buffer).setUint16(14, 1, true);
        },
      ],
      [
        'fingerprint length',
        /fingerprint length/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint16(12, view.getUint16(12, true) + 1, true);
        },
      ],
      [
        'descriptor offset',
        /descriptor offset/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint32(16, view.getUint32(16, true) + 1, true);
        },
      ],
      [
        'non-ASCII fingerprint',
        /ASCII/i,
        (bytes) => {
          bytes[28] = 0xff;
        },
      ],
      [
        'payload offset',
        /payload offset/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint32(20, view.getUint32(20, true) + 1, true);
        },
      ],
    ];

    for (const [label, expected, patch] of headerCases) {
      expect(
        () => decodeTableArtifact(patchedArtifact(patch)),
        label,
      ).toThrow(expected);
    }

    const descriptorOffset = new DataView(
      artifact.bytes.buffer,
      artifact.bytes.byteOffset,
      artifact.bytes.byteLength,
    ).getUint32(16, true);
    const descriptorCases: readonly [
      label: string,
      expected: RegExp,
      patch: (bytes: Uint8Array) => void,
    ][] = [
      [
        'name length',
        /name length/i,
        (bytes) => {
          bytes[descriptorOffset] = bytes[descriptorOffset]! + 1;
        },
      ],
      [
        'section name',
        /Expected table section/i,
        (bytes) => {
          bytes[descriptorOffset + 16] = 'x'.charCodeAt(0);
        },
      ],
      [
        'element width',
        /element width/i,
        (bytes) => {
          bytes[descriptorOffset + 1] = 8;
        },
      ],
      [
        'descriptor reserved bits',
        /reserved/i,
        (bytes) => {
          new DataView(bytes.buffer).setUint16(descriptorOffset + 2, 1, true);
        },
      ],
      [
        'entry count',
        /entry count/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint32(
            descriptorOffset + 4,
            view.getUint32(descriptorOffset + 4, true) - 1,
            true,
          );
        },
      ],
      [
        'data offset',
        /data bounds/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint32(
            descriptorOffset + 8,
            view.getUint32(descriptorOffset + 8, true) + 1,
            true,
          );
        },
      ],
      [
        'data length',
        /data bounds/i,
        (bytes) => {
          const view = new DataView(bytes.buffer);
          view.setUint32(
            descriptorOffset + 12,
            view.getUint32(descriptorOffset + 12, true) - 1,
            true,
          );
        },
      ],
    ];

    for (const [label, expected, patch] of descriptorCases) {
      expect(
        () => decodeTableArtifact(patchedArtifact(patch)),
        label,
      ).toThrow(expected);
    }
  });

  it('rejects malformed decoded table sets before encoding', () => {
    expect(() =>
      createTableArtifact(null as unknown as SolverTables),
    ).toThrow(/tables/i);
    expect(() =>
      createTableArtifact({} as SolverTables),
    ).toThrow(/moveTables and pruningTables/i);

    expect(() =>
      createTableArtifact({
        ...tables,
        moveTables: {
          ...tables.moveTables,
          co: new Uint8Array(tables.moveTables.co.length) as unknown as Uint16Array,
        },
      }),
    ).toThrow(/co.*Uint16Array/i);
    expect(() =>
      createTableArtifact({
        ...tables,
        moveTables: {
          ...tables.moveTables,
          co: tables.moveTables.co.slice(1),
        },
      }),
    ).toThrow(/co.*entries/i);
    const escapedMoveTable = tables.moveTables.co.slice();
    escapedMoveTable[0] = COORDINATE_SIZES.CO;
    expect(() =>
      createTableArtifact({
        ...tables,
        moveTables: { ...tables.moveTables, co: escapedMoveTable },
      }),
    ).toThrow(/co.*out-of-range/i);
    expect(() =>
      createTableArtifact({
        ...tables,
        pruningTables: {
          ...tables.pruningTables,
          coUDSlice: new Uint16Array(0) as unknown as Uint8Array,
        },
      }),
    ).toThrow(/co-ud-slice.*Uint8Array/i);
    expect(() =>
      createTableArtifact({
        ...tables,
        pruningTables: {
          ...tables.pruningTables,
          coUDSlice: tables.pruningTables.coUDSlice.slice(1),
        },
      }),
    ).toThrow(/co-ud-slice.*bytes/i);

    const unvisitedTarget = tables.pruningTables.coUDSlice.slice();
    unvisitedTarget[0] = (unvisitedTarget[0]! & 0xf0) | 0x0f;
    expect(() =>
      createTableArtifact({
        ...tables,
        pruningTables: {
          ...tables.pruningTables,
          coUDSlice: unvisitedTarget,
        },
      }),
    ).toThrow(/co-ud-slice.*pruning distance/i);

    const nonEmptyPadding = tables.pruningTables.coUDSlice.slice();
    const paddingByteIndex = nonEmptyPadding.length - 1;
    nonEmptyPadding[paddingByteIndex] = nonEmptyPadding[paddingByteIndex]! & 0x0f;
    expect(() =>
      createTableArtifact({
        ...tables,
        pruningTables: {
          ...tables.pruningTables,
          coUDSlice: nonEmptyPadding,
        },
      }),
    ).toThrow(/co-ud-slice.*padding/i);
  });

  it('rejects rechecksummed payload values that violate table semantics', () => {
    const payloadOffset = new DataView(
      artifact.bytes.buffer,
      artifact.bytes.byteOffset,
      artifact.bytes.byteLength,
    ).getUint32(20, true);
    expect(() =>
      decodeTableArtifact(
        patchedArtifact((bytes) => {
          new DataView(bytes.buffer).setUint16(
            payloadOffset,
            COORDINATE_SIZES.CO,
            true,
          );
        }),
      ),
    ).toThrow(/co.*out-of-range/i);

    const coUDSliceByteLength = Math.ceil(
      (COORDINATE_SIZES.CO * COORDINATE_SIZES.UDSlice) / 2,
    );
    const paddingByteOffset =
      payloadOffset + MOVE_TABLE_BYTE_LENGTH + coUDSliceByteLength - 1;
    expect(() =>
      decodeTableArtifact(
        patchedArtifact((bytes) => {
          bytes[paddingByteOffset] = bytes[paddingByteOffset]! & 0x0f;
        }),
      ),
    ).toThrow(/co-ud-slice.*padding/i);
  });
});

describe('loadTables cache behavior', () => {
  it('rejects malformed stores synchronously', async () => {
    const generate = vi.fn(() => tables);
    const module = await importFreshArtifactModule(generate);
    try {
      expect(() =>
        module.loadTables(null as unknown as TableStore),
      ).toThrow(/load and save/i);
      expect(() =>
        module.loadTables({ load: async () => null } as unknown as TableStore),
      ).toThrow(/load and save/i);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      restoreArtifactModule();
    }
  });

  it('loads a valid artifact from an injected store without generating or saving', async () => {
    const generate = vi.fn((): SolverTables => {
      throw new Error('cache hit unexpectedly generated tables');
    });
    const module = await importFreshArtifactModule(generate);
    let loadCalls = 0;
    let saveCalls = 0;
    let loadedKey: string | undefined;
    const store: TableStore = {
      async load(key) {
        loadCalls += 1;
        loadedKey = key;
        return artifact;
      },
      async save() {
        saveCalls += 1;
      },
    };

    try {
      const loaded = await module.loadTables(store);
      expect(loadCalls).toBe(1);
      expect(loadedKey).toBe(TABLE_FINGERPRINT);
      expect(saveCalls).toBe(0);
      expect(generate).not.toHaveBeenCalled();
      assertSolverTablesEqual(loaded, tables);
    } finally {
      restoreArtifactModule();
    }
  });

  it('merges concurrent loads, rebuilds a half-written cache, and ignores save failure', async () => {
    const generate = vi.fn((_options?: LoadTablesOptions) => tables);
    const module = await importFreshArtifactModule(generate);
    let resolveCache!: (value: TableArtifact | null) => void;
    const pendingCache = new Promise<TableArtifact | null>((resolve) => {
      resolveCache = resolve;
    });
    let loadCalls = 0;
    let saveCalls = 0;
    let savedKey: string | undefined;
    let savedArtifact: TableArtifact | undefined;
    const store: TableStore = {
      async load(key) {
        loadCalls += 1;
        expect(key).toBe(TABLE_FINGERPRINT);
        return pendingCache;
      },
      async save(key, value) {
        saveCalls += 1;
        savedKey = key;
        savedArtifact = value;
        throw new Error('simulated persistence failure');
      },
    };

    try {
      const first = module.loadTables(store);
      const second = module.loadTables(undefined);
      expect(second).toBe(first);

      await Promise.resolve();
      expect(loadCalls).toBe(1);
      resolveCache(artifactWithBytes(artifact.bytes.slice(0, -31)));

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(tables);
      expect(secondResult).toBe(tables);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(saveCalls).toBe(1);
      expect(savedKey).toBe(TABLE_FINGERPRINT);
      if (savedArtifact === undefined) {
        throw new Error('loadTables did not attempt to persist rebuilt tables');
      }
      assertSolverTablesEqual(decodeTableArtifact(savedArtifact), tables);
      expect(module.loadTables()).toBe(first);
    } finally {
      restoreArtifactModule();
    }
  });

  it('evicts a failed in-flight generation so the next call can retry', async () => {
    const generate = vi.fn((): SolverTables => {
      throw new Error('simulated generation failure');
    });
    const module = await importFreshArtifactModule(generate);
    try {
      const first = module.loadTables();
      await expect(first).rejects.toThrow(/generation failure/i);
      const second = module.loadTables();
      expect(second).not.toBe(first);
      await expect(second).rejects.toThrow(/generation failure/i);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      restoreArtifactModule();
    }
  });
});
