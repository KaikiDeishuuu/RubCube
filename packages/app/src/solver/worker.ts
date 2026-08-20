/// <reference lib="webworker" />
import { assertValidState, type CubeState } from '@rubcube/cube-core';
import {
  beginSolve,
  loadTables,
  type SolveSession,
  type SolverTables,
} from '@rubcube/cube-core/solver';

import { createTableCache } from './table-cache.js';
import type {
  ReadyProgress,
  SolverRequest,
  SolverResponse,
  WireCubeState,
} from './protocol.js';

/**
 * The solver's worker.
 *
 * DESIGN.md 1.1 promises a steady 60fps, and a search is tens to hundreds of
 * milliseconds of straight-line work, so none of it may happen on the main
 * thread.
 *
 * A CPU-bound worker cannot receive `postMessage` while it is busy, so a
 * `solve()` that ran to completion in one go could not be cancelled no matter
 * what the protocol said. The search is therefore driven a chunk at a time and
 * the loop hands the event loop back between chunks, which is the only point a
 * cancel or a newer request can arrive.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Nodes per chunk.
 *
 * At roughly 24M nodes a second this is about four milliseconds — short enough
 * that a cancel is acted on promptly, long enough that the hand-off is not
 * where the time goes.
 */
const CHUNK_NODES = 100_000;

let tables: SolverTables | null = null;
let readying: Promise<SolverTables> | null = null;

interface RunningSearch {
  readonly requestId: number;
  readonly session: SolveSession;
  cancelled: boolean;
}

let running: RunningSearch | null = null;

function post(message: SolverResponse): void {
  scope.postMessage(message);
}

function fail(requestId: number, error: unknown): void {
  const asError = error instanceof Error ? error : new Error(String(error));
  post({
    type: 'error',
    requestId,
    name: asError.name,
    message: asError.message,
  });
}

const yieldChannel = new MessageChannel();
const yieldWaiters: (() => void)[] = [];
yieldChannel.port1.onmessage = () => {
  yieldWaiters.shift()?.();
};
yieldChannel.port1.start();

/**
 * Hands the event loop back.
 *
 * A macrotask, not a microtask: a queued message is a task, so resolving a
 * promise would run the continuation before the incoming message ever got a
 * turn and the worker would still be uncancellable.
 *
 * A channel message rather than `setTimeout(0)`, which is clamped. A search
 * yields once per chunk — sixty times for a six-million-node search — and with
 * the clamp that was adding more latency than the chunk boundary was worth.
 * Measured round-trip P99 in a headless browser: 484ms clamped against a 251ms
 * pure solve, and 271ms once the clamp was out of the way.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    yieldWaiters.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

function toCubeState(wire: WireCubeState): CubeState {
  // Copied out of the cloned message, so the search cannot be handed anything
  // that another message is still holding a reference to.
  const state: CubeState = {
    cp: Uint8Array.from(wire.cp),
    co: Uint8Array.from(wire.co),
    ep: Uint8Array.from(wire.ep),
    eo: Uint8Array.from(wire.eo),
    centers: Uint8Array.from(wire.centers),
  };
  assertValidState(state);
  return state;
}

async function ensureTables(requestId: number): Promise<SolverTables> {
  if (tables !== null) return tables;

  readying ??= loadTables(createTableCache(), {
    onProgress: (progress) => {
      const message: ReadyProgress = {
        stage: 'generating',
        table: progress.table,
        completed: progress.completed,
        total: progress.total,
      };
      post({ type: 'progress', requestId, progress: message });
    },
  });

  post({ type: 'progress', requestId, progress: { stage: 'loading-cache' } });
  tables = await readying;
  return tables;
}

async function runSolve(request: Extract<SolverRequest, { type: 'solve' }>): Promise<void> {
  // A newer request supersedes the running one, which reports cancelled rather
  // than vanishing: the caller is awaiting a reply for that id.
  if (running !== null) cancelRunning();

  let state: CubeState;
  try {
    state = toCubeState(request.state);
  } catch (error) {
    fail(request.requestId, error);
    return;
  }

  let ready: SolverTables;
  try {
    ready = await ensureTables(request.requestId);
  } catch (error) {
    fail(request.requestId, error);
    return;
  }

  let session: SolveSession;
  try {
    // Table work happens before this point on purpose: loading or generating
    // must not be charged to the search's node or time budget.
    session = beginSolve(state, ready, request.options);
  } catch (error) {
    fail(request.requestId, error);
    return;
  }

  const search: RunningSearch = { requestId: request.requestId, session, cancelled: false };
  running = search;

  for (;;) {
    if (search.cancelled) return;
    let outcome;
    try {
      outcome = session.step(CHUNK_NODES);
    } catch (error) {
      if (running === search) running = null;
      fail(request.requestId, error);
      return;
    }
    if (outcome !== null) {
      if (running === search) running = null;
      post({ type: 'result', requestId: request.requestId, result: outcome });
      return;
    }
    await yieldToEventLoop();
  }
}

function cancelRunning(): void {
  const search = running;
  if (search === null) return;
  running = null;
  search.cancelled = true;
  post({
    type: 'result',
    requestId: search.requestId,
    result: search.session.cancel(),
  });
}

scope.addEventListener('message', (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'ready':
      ensureTables(request.requestId).then(
        () => post({ type: 'ready', requestId: request.requestId }),
        (error: unknown) => fail(request.requestId, error),
      );
      return;
    case 'solve':
      void runSolve(request);
      return;
    case 'cancel':
      // The id names the request being cancelled; a stale one is ignored rather
      // than allowed to stop whatever is running now.
      if (running !== null && running.requestId === request.requestId) cancelRunning();
      return;
    default:
      fail(0, new Error(`Unknown solver request ${String((request as { type: string }).type)}`));
  }
});
