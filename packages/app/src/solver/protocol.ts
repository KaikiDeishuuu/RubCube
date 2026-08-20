import type { SolveResult, TableGenerationProgress } from '@rubcube/cube-core/solver';

/**
 * The worker wire format.
 *
 * Shared by both sides so a change to one is a type error in the other. Every
 * message carries the id of the request it belongs to: the worker runs one
 * search at a time and a newer request supersedes the running one, so a reply
 * arriving without an id could not be told from a stale one.
 */

/** What `ready` is doing. Table work is not part of any solve's budget. */
export type ReadyStage = 'loading-cache' | 'generating' | 'saving' | 'ready';

export interface ReadyProgress {
  readonly stage: ReadyStage;
  /** Present while generating: which table, and how far through it. */
  readonly table?: TableGenerationProgress['table'];
  readonly completed?: number;
  readonly total?: number;
}

/**
 * A cube state on the wire.
 *
 * Plain typed arrays, structured-cloned. Deliberately never transferred: the
 * arrays a caller hands over are the authoritative ones held by the store and
 * the renderer, and transferring would detach them.
 */
export interface WireCubeState {
  readonly cp: Uint8Array;
  readonly co: Uint8Array;
  readonly ep: Uint8Array;
  readonly eo: Uint8Array;
  readonly centers: Uint8Array;
}

export interface WireSolveOptions {
  readonly hardMax?: number;
  readonly targetLength?: number;
  readonly maxNodes?: number;
  readonly budgetMs?: number;
}

export type SolverRequest =
  | { readonly type: 'ready'; readonly requestId: number }
  | {
      readonly type: 'solve';
      readonly requestId: number;
      readonly state: WireCubeState;
      readonly options: WireSolveOptions;
    }
  | { readonly type: 'cancel'; readonly requestId: number };

export type SolverResponse =
  | { readonly type: 'progress'; readonly requestId: number; readonly progress: ReadyProgress }
  | { readonly type: 'ready'; readonly requestId: number }
  | { readonly type: 'result'; readonly requestId: number; readonly result: SolveResult }
  | {
      readonly type: 'error';
      readonly requestId: number;
      readonly name: string;
      readonly message: string;
    };
