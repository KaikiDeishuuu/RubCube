import type { CubeState, Face, Move } from '@rubcube/cube-core';
import type { Object3D, Quaternion } from 'three';

export type GridCoordinate = -1 | 0 | 1;
export type GridPosition = [GridCoordinate, GridCoordinate, GridCoordinate];
export type CubieKind = 'corner' | 'edge' | 'center';

export interface CubieDescriptor {
  /** Stable identity such as `corner:URF`, independent of current position. */
  readonly id: string;
  readonly kind: CubieKind;
  readonly index: number;
  readonly homePosition: Readonly<GridPosition>;
  readonly stickerFaces: readonly Face[];
}

export interface CubiePose {
  readonly descriptor: CubieDescriptor;
  readonly gridPosition: Readonly<GridPosition>;
  readonly quaternion: Quaternion;
}

export interface CubieVisual {
  readonly descriptor: CubieDescriptor;
  readonly object: Object3D;
  /**
   * Reassigned on every sync, but never mutated in place: the layout module
   * hands out shared frozen tuples, so copying each one per sync would be pure
   * allocation churn in the render loop.
   */
  gridPosition: Readonly<GridPosition>;
}

export interface CubeStateChange {
  readonly state: CubeState;
  readonly move: Move | null;
  readonly source: 'queue' | 'drag' | 'replace';
}

export type CubeStateChangeListener = (change: CubeStateChange) => void;
