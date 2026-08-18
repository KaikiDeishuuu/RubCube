import type { Face } from '../moves.js';

/** The six coordinates used by RubCube's two-phase solver tables. */
export type SolverCoordinate =
  | 'CO'
  | 'EO'
  | 'UDSlice'
  | 'CP'
  | 'UDEdgePerm'
  | 'SlicePerm';

export type SolverMoveSet = 'phase1' | 'phase2';

/** Stable metadata for a coordinate transition table. */
export interface MoveTableSpec {
  readonly name: string;
  readonly coordinate: SolverCoordinate;
  readonly moveSet: SolverMoveSet;
  readonly coordinateCount: number;
  readonly moveCount: number;
  readonly entryCount: number;
  readonly elementEncoding: 'uint16';
  readonly byteLength: number;
}

/** Stable metadata for a packed pair-coordinate pruning table. */
export interface PruningTableSpec {
  readonly name: string;
  readonly phase: 1 | 2;
  readonly firstCoordinate: SolverCoordinate;
  readonly secondCoordinate: SolverCoordinate;
  readonly entryCount: number;
  readonly maximumDepth: number;
  readonly elementEncoding: 'nibble';
  readonly byteLength: number;
}

/**
 * Versioned, environment-neutral representation shared by bundled assets and
 * runtime caches. Decoders must validate every metadata field before use.
 */
export interface TableArtifact {
  readonly formatVersion: number;
  /**
   * Must equal `TABLE_FINGERPRINT`. The wire name is retained from the design
   * contract, but this field versions coordinate ranking/table generation,
   * not the independent search-profile `SOLVER_FINGERPRINT`.
   */
  readonly solverFingerprint: string;
  readonly byteOrder: 'LE';
  readonly byteLength: number;
  readonly checksum: string;
  readonly bytes: Uint8Array;
}

/** Persistence is injected so cube-core never imports IndexedDB or Node fs. */
export interface TableStore {
  /** Adapters must reject on their own timeout; a never-settling load blocks ready(). */
  load(key: string): Promise<TableArtifact | null>;
  /** Atomically replace `key`, and reject on timeout rather than staying pending. */
  save(key: string, artifact: TableArtifact): Promise<void>;
}

/** The directed opposite-face pairs retained by the canonical search filter. */
export interface CanonicalOppositePair {
  readonly first: Face;
  readonly second: Face;
}
