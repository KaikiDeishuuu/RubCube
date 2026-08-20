import type { CubeState } from '@rubcube/cube-core';
import type { SolveResult } from '@rubcube/cube-core/solver';

import type {
  ReadyProgress,
  SolverRequest,
  SolverResponse,
  WireSolveOptions,
} from './protocol.js';

/**
 * Main-thread half of the solver.
 *
 * Owns request ids, keeps at most one search in flight, and makes a superseded
 * request settle rather than disappear — the caller is awaiting it either way.
 */

/** The part of `Worker` this needs, so tests can stand in for one. */
export interface SolverWorkerLike {
  postMessage(message: SolverRequest): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  terminate(): void;
}

export class SolverTransportError extends Error {
  readonly requestId: number;

  constructor(message: string, requestId: number) {
    super(message);
    this.name = 'SolverTransportError';
    this.requestId = requestId;
  }
}

export class SolverError extends Error {
  readonly requestId: number;

  constructor(name: string, message: string, requestId: number) {
    super(message);
    this.name = name;
    this.requestId = requestId;
  }
}

export interface SolverClientOptions {
  /** Test seam; production builds the bundled worker module. */
  readonly createWorker?: () => SolverWorkerLike;
}

interface Pending {
  readonly resolve: (result: SolveResult) => void;
  readonly reject: (error: unknown) => void;
  readonly kind: 'solve';
}

interface PendingReady {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly onProgress: ((progress: ReadyProgress) => void) | undefined;
  readonly kind: 'ready';
}

function defaultWorker(): SolverWorkerLike {
  // The URL form is what lets the bundler emit the worker as its own chunk;
  // a string path would be left to the browser to resolve at runtime.
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'rubcube-solver',
  }) as unknown as SolverWorkerLike;
}

export class SolverClient {
  private readonly worker: SolverWorkerLike;
  private readonly pending = new Map<number, Pending | PendingReady>();
  private nextRequestId = 1;
  private inFlightSolve: number | null = null;
  private disposed = false;

  constructor(options: SolverClientOptions = {}) {
    this.worker = (options.createWorker ?? defaultWorker)();
    this.worker.addEventListener('message', ((event: MessageEvent<SolverResponse>) => {
      this.receive(event.data);
    }) as (event: never) => void);
    // A worker that dies takes every outstanding request with it. Leaving them
    // pending would hang whatever is awaiting them for the life of the page.
    this.worker.addEventListener('error', (() => {
      this.failAll('Solver worker failed');
    }) as (event: never) => void);
    this.worker.addEventListener('messageerror', (() => {
      this.failAll('Solver worker sent a message that could not be read');
    }) as (event: never) => void);
  }

  /**
   * Loads or generates the tables.
   *
   * Separate from `solve` because it is neither fast nor charged to a search's
   * budget: the caller needs to be able to show that something is happening.
   */
  ready(onProgress?: (progress: ReadyProgress) => void): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Solver client is disposed'));
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { kind: 'ready', resolve, reject, onProgress });
      this.worker.postMessage({ type: 'ready', requestId });
    });
  }

  /**
   * Solves one cube.
   *
   * Starting a second search settles the first as cancelled rather than leaving
   * it hanging. The state's arrays are cloned by `postMessage` and never
   * transferred, so the store's authoritative buffers stay attached.
   */
  solve(state: CubeState, options: WireSolveOptions = {}): Promise<SolveResult> {
    if (this.disposed) return Promise.reject(new Error('Solver client is disposed'));
    const requestId = this.nextRequestId++;
    this.inFlightSolve = requestId;
    return new Promise<SolveResult>((resolve, reject) => {
      this.pending.set(requestId, { kind: 'solve', resolve, reject });
      this.worker.postMessage({
        type: 'solve',
        requestId,
        state: {
          cp: state.cp,
          co: state.co,
          ep: state.ep,
          eo: state.eo,
          centers: state.centers,
        },
        options,
      });
    });
  }

  /** Stops the search in flight, if there is one. */
  cancel(): void {
    const requestId = this.inFlightSolve;
    if (this.disposed || requestId === null) return;
    this.worker.postMessage({ type: 'cancel', requestId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll('Solver client is disposed');
    try {
      this.worker.terminate();
    } catch {
      // Teardown is best effort; a worker that has already died is not a
      // failure worth propagating out of a React cleanup.
    }
  }

  private receive(message: SolverResponse): void {
    const entry = this.pending.get(message.requestId);
    if (entry === undefined) return;

    switch (message.type) {
      case 'progress':
        if (entry.kind === 'ready') entry.onProgress?.(message.progress);
        return;
      case 'ready':
        this.pending.delete(message.requestId);
        if (entry.kind === 'ready') entry.resolve();
        return;
      case 'result':
        this.pending.delete(message.requestId);
        if (this.inFlightSolve === message.requestId) this.inFlightSolve = null;
        if (entry.kind === 'solve') entry.resolve(message.result);
        return;
      case 'error':
        this.pending.delete(message.requestId);
        if (this.inFlightSolve === message.requestId) this.inFlightSolve = null;
        entry.reject(new SolverError(message.name, message.message, message.requestId));
        return;
      default:
        return;
    }
  }

  private failAll(reason: string): void {
    const outstanding = [...this.pending.entries()];
    this.pending.clear();
    this.inFlightSolve = null;
    for (const [requestId, entry] of outstanding) {
      entry.reject(new SolverTransportError(reason, requestId));
    }
  }
}

export function createSolverClient(options?: SolverClientOptions): SolverClient {
  return new SolverClient(options);
}
