import { describe, expect, it } from 'vitest';

import * as rootApi from '../src/index.js';
import {
  CANONICAL_OPPOSITE_PAIRS,
  COORDINATE_RANKING_VERSION,
  COORDINATE_SIZES,
  HTM_V1_INVERSE_MOVE_INDEX,
  HTM_V1_MOVE_ORDER,
  isCanonicalFaceSuccessor,
  MOVE_TABLE_BYTE_LENGTH,
  MOVE_TABLE_SPECS,
  NODE_COUNTING_VERSION,
  PDB_PACKING_VERSION,
  PHASE2_MOVE_ORDER,
  PHASE2_TO_HTM_MOVE_INDEX,
  PRUNING_TABLE_BYTE_LENGTH,
  PRUNING_TABLE_SPECS,
  SOLVER_FINGERPRINT,
  SOLVER_FINGERPRINT_MANIFEST,
  SOLVER_TABLE_BYTE_LENGTH,
  TABLE_ARTIFACT_BYTE_ORDER,
  TABLE_ARTIFACT_FORMAT_VERSION,
  TABLE_ARTIFACT_MAGIC,
  TABLE_CHECKSUM_VERSION,
  TABLE_FINGERPRINT,
  TABLE_FINGERPRINT_MANIFEST,
  TABLE_GENERATOR_VERSION,
} from '../src/solver/index.js';
import { serializeMoves } from '../src/moves.js';
import type { Face } from '../src/moves.js';

// A self-reference exercises package.json's development-condition subpath.
import { COORDINATE_SIZES as EXPORTED_COORDINATE_SIZES } from '@rubcube/cube-core/solver';

interface CryptoSubset {
  readonly subtle: {
    digest(algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer>;
  };
}

async function sha256(value: string): Promise<string> {
  const runtimeCrypto = (globalThis as unknown as { crypto: CryptoSubset }).crypto;
  const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
  const digest = await runtimeCrypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hex}`;
}

describe('solver package boundary', () => {
  it('resolves the dedicated package subpath', () => {
    expect(EXPORTED_COORDINATE_SIZES).toBe(COORDINATE_SIZES);
  });

  it('does not leak solver capability through the root barrel', () => {
    expect(rootApi).not.toHaveProperty('COORDINATE_SIZES');
    expect(rootApi).not.toHaveProperty('HTM_V1_MOVE_ORDER');
    expect(rootApi).not.toHaveProperty('rankCornerOrientation');
    expect(rootApi).not.toHaveProperty('SOLVER_FINGERPRINT');
  });
});

describe('deterministic solver profile constants', () => {
  it('pins both move orders byte-for-byte', () => {
    expect(serializeMoves(HTM_V1_MOVE_ORDER)).toBe(
      "U U' U2 D D' D2 L L' L2 R R' R2 F F' F2 B B' B2",
    );
    expect(serializeMoves(PHASE2_MOVE_ORDER)).toBe(
      "U U' U2 D D' D2 L2 R2 F2 B2",
    );
    expect(HTM_V1_MOVE_ORDER).toHaveLength(18);
    expect(PHASE2_MOVE_ORDER).toHaveLength(10);
    expect(PHASE2_TO_HTM_MOVE_INDEX).toEqual([
      0, 1, 2, 3, 4, 5, 8, 11, 14, 17,
    ]);
    expect(HTM_V1_INVERSE_MOVE_INDEX).toEqual([
      1, 0, 2, 4, 3, 5, 7, 6, 8, 10, 9, 11, 13, 12, 14, 16, 15, 17,
    ]);
    for (let index = 0; index < HTM_V1_MOVE_ORDER.length; index += 1) {
      const inverse = HTM_V1_INVERSE_MOVE_INDEX[index]!;
      expect(HTM_V1_INVERSE_MOVE_INDEX[inverse]).toBe(index);
    }
    expect(Object.isFrozen(HTM_V1_MOVE_ORDER)).toBe(true);
    expect(Object.isFrozen(PHASE2_MOVE_ORDER)).toBe(true);
    expect(HTM_V1_MOVE_ORDER.every(Object.isFrozen)).toBe(true);
    expect(PHASE2_MOVE_ORDER.every(Object.isFrozen)).toBe(true);
  });

  it('retains only the designed direction for commuting opposite faces', () => {
    expect(CANONICAL_OPPOSITE_PAIRS).toEqual([
      { first: 'U', second: 'D' },
      { first: 'R', second: 'L' },
      { first: 'F', second: 'B' },
    ]);

    const faces = ['U', 'D', 'L', 'R', 'F', 'B'] as const;
    for (const face of faces) {
      expect(isCanonicalFaceSuccessor(null, face)).toBe(true);
      expect(isCanonicalFaceSuccessor(face, face)).toBe(false);
    }

    const retained = new Set(['UD', 'RL', 'FB']);
    const opposite = new Set(['UD', 'DU', 'LR', 'RL', 'FB', 'BF']);
    for (const previous of faces) {
      for (const next of faces) {
        if (previous === next) continue;
        const pair = `${previous}${next}`;
        const expected = !opposite.has(pair) || retained.has(pair);
        expect(isCanonicalFaceSuccessor(previous, next)).toBe(expected);
      }
    }
  });

  it('pins coordinate cardinalities and algorithm versions', () => {
    expect(COORDINATE_SIZES).toEqual({
      CO: 2_187,
      EO: 2_048,
      UDSlice: 495,
      CP: 40_320,
      UDEdgePerm: 40_320,
      SlicePerm: 24,
    });
    expect(Object.isFrozen(COORDINATE_SIZES)).toBe(true);
    expect(NODE_COUNTING_VERSION).toBe('dfs-expanded-v1');
    expect(PDB_PACKING_VERSION).toBe('nibble-v1');
    expect(COORDINATE_RANKING_VERSION).toBe('cubie-coordinate-rank-v1');
    expect(TABLE_GENERATOR_VERSION).toBe('pair-bfs-v1');
    expect(TABLE_ARTIFACT_MAGIC).toBe('RBCT');
    expect(TABLE_ARTIFACT_FORMAT_VERSION).toBe(1);
    expect(TABLE_ARTIFACT_BYTE_ORDER).toBe('LE');
    expect(TABLE_CHECKSUM_VERSION).toBe('crc32-v1');
  });

  it('pins all move-table sizes and storage', () => {
    expect(MOVE_TABLE_SPECS).toEqual([
      {
        name: 'co',
        coordinate: 'CO',
        moveSet: 'phase1',
        coordinateCount: 2_187,
        moveCount: 18,
        entryCount: 39_366,
        elementEncoding: 'uint16',
        byteLength: 78_732,
      },
      {
        name: 'eo',
        coordinate: 'EO',
        moveSet: 'phase1',
        coordinateCount: 2_048,
        moveCount: 18,
        entryCount: 36_864,
        elementEncoding: 'uint16',
        byteLength: 73_728,
      },
      {
        name: 'ud-slice',
        coordinate: 'UDSlice',
        moveSet: 'phase1',
        coordinateCount: 495,
        moveCount: 18,
        entryCount: 8_910,
        elementEncoding: 'uint16',
        byteLength: 17_820,
      },
      {
        name: 'cp',
        coordinate: 'CP',
        moveSet: 'phase2',
        coordinateCount: 40_320,
        moveCount: 10,
        entryCount: 403_200,
        elementEncoding: 'uint16',
        byteLength: 806_400,
      },
      {
        name: 'ud-edge-perm',
        coordinate: 'UDEdgePerm',
        moveSet: 'phase2',
        coordinateCount: 40_320,
        moveCount: 10,
        entryCount: 403_200,
        elementEncoding: 'uint16',
        byteLength: 806_400,
      },
      {
        name: 'slice-perm',
        coordinate: 'SlicePerm',
        moveSet: 'phase2',
        coordinateCount: 24,
        moveCount: 10,
        entryCount: 240,
        elementEncoding: 'uint16',
        byteLength: 480,
      },
    ]);
    expect(MOVE_TABLE_SPECS.every(Object.isFrozen)).toBe(true);
    expect(MOVE_TABLE_BYTE_LENGTH).toBe(1_783_560);
  });

  it('pins all pruning-table sizes, packing, and projected diameters', () => {
    expect(PRUNING_TABLE_SPECS).toEqual([
      {
        name: 'co-ud-slice',
        phase: 1,
        firstCoordinate: 'CO',
        secondCoordinate: 'UDSlice',
        entryCount: 1_082_565,
        maximumDepth: 9,
        elementEncoding: 'nibble',
        byteLength: 541_283,
      },
      {
        name: 'eo-ud-slice',
        phase: 1,
        firstCoordinate: 'EO',
        secondCoordinate: 'UDSlice',
        entryCount: 1_013_760,
        maximumDepth: 9,
        elementEncoding: 'nibble',
        byteLength: 506_880,
      },
      {
        name: 'cp-slice-perm',
        phase: 2,
        firstCoordinate: 'CP',
        secondCoordinate: 'SlicePerm',
        entryCount: 967_680,
        maximumDepth: 14,
        elementEncoding: 'nibble',
        byteLength: 483_840,
      },
      {
        name: 'ud-edge-perm-slice-perm',
        phase: 2,
        firstCoordinate: 'UDEdgePerm',
        secondCoordinate: 'SlicePerm',
        entryCount: 967_680,
        maximumDepth: 12,
        elementEncoding: 'nibble',
        byteLength: 483_840,
      },
    ]);
    expect(PRUNING_TABLE_SPECS.every(Object.isFrozen)).toBe(true);
    expect(PRUNING_TABLE_BYTE_LENGTH).toBe(2_015_843);
    expect(SOLVER_TABLE_BYTE_LENGTH).toBe(3_799_403);
  });

  it('keeps fingerprints equal to the SHA-256 of their canonical manifests', async () => {
    expect(SOLVER_FINGERPRINT).toBe(await sha256(SOLVER_FINGERPRINT_MANIFEST));
    expect(TABLE_FINGERPRINT).toBe(await sha256(TABLE_FINGERPRINT_MANIFEST));
  });
});
