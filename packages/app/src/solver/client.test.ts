import { createSolvedState } from '@rubcube/cube-core';
import type { SolveResult } from '@rubcube/cube-core/solver';
import { describe, expect, it, vi } from 'vitest';

import {
  SolverError,
  SolverTransportError,
  createSolverClient,
  type SolverWorkerLike,
} from './client.js';
import type { SolverRequest, SolverResponse } from './protocol.js';

/** Records what the client sends and lets a test answer it. */
class FakeWorker implements SolverWorkerLike {
  readonly sent: SolverRequest[] = [];
  /** Every argument of each postMessage call, to prove nothing is transferred. */
  readonly postArgumentCounts: number[] = [];
  terminated = 0;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  postMessage(...args: [SolverRequest, ...unknown[]]): void {
    this.postArgumentCounts.push(args.length);
    this.sent.push(args[0]);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  terminate(): void {
    this.terminated += 1;
  }

  reply(message: SolverResponse): void {
    this.emit('message', { data: message });
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (value: unknown) => void)(event);
    }
  }
}

function setup(): { client: ReturnType<typeof createSolverClient>; worker: FakeWorker } {
  const worker = new FakeWorker();
  return { client: createSolverClient({ createWorker: () => worker }), worker };
}

const SOLVED_RESULT: SolveResult = {
  status: 'solved',
  moves: [{ face: 'R', turns: 1 }],
  targetMet: true,
  nodes: 12,
  elapsedMs: 1,
};

const CANCELLED_RESULT: SolveResult = { status: 'cancelled', nodes: 3, elapsedMs: 1 };

describe('solver client', () => {
  it('reports table progress while getting ready', async () => {
    const { client, worker } = setup();
    const seen: string[] = [];
    const ready = client.ready((progress) => seen.push(progress.stage));

    const requestId = worker.sent[0]!.requestId;
    worker.reply({ type: 'progress', requestId, progress: { stage: 'loading-cache' } });
    worker.reply({
      type: 'progress',
      requestId,
      progress: { stage: 'generating', table: 'co', completed: 1, total: 2 },
    });
    worker.reply({ type: 'ready', requestId });

    await expect(ready).resolves.toBeUndefined();
    expect(seen).toEqual(['loading-cache', 'generating']);
  });

  it('never transfers the caller\'s buffers', async () => {
    const { client, worker } = setup();
    const state = createSolvedState();
    const solving = client.solve(state);

    // A transfer list would be a second argument, and would detach the arrays
    // the store and the renderer are still holding.
    expect(worker.postArgumentCounts).toEqual([1]);
    const sent = worker.sent[0]!;
    expect(sent.type).toBe('solve');
    expect(state.cp.length).toBe(8);

    worker.reply({ type: 'result', requestId: sent.requestId, result: SOLVED_RESULT });
    await expect(solving).resolves.toEqual(SOLVED_RESULT);
  });

  it('settles a superseded search instead of leaving it hanging', async () => {
    const { client, worker } = setup();
    const first = client.solve(createSolvedState());
    const second = client.solve(createSolvedState());

    const [firstRequest, secondRequest] = worker.sent;
    // The worker cancels the older search; the client's job is only to route
    // that reply to the request that is waiting for it.
    worker.reply({
      type: 'result',
      requestId: firstRequest!.requestId,
      result: CANCELLED_RESULT,
    });
    worker.reply({
      type: 'result',
      requestId: secondRequest!.requestId,
      result: SOLVED_RESULT,
    });

    await expect(first).resolves.toEqual(CANCELLED_RESULT);
    await expect(second).resolves.toEqual(SOLVED_RESULT);
  });

  it('cancels the search that is actually in flight', () => {
    const { client, worker } = setup();
    void client.solve(createSolvedState()).catch(() => undefined);
    const solveId = worker.sent[0]!.requestId;

    client.cancel();
    expect(worker.sent.at(-1)).toEqual({ type: 'cancel', requestId: solveId });
  });

  it('does not send a cancel when nothing is running', () => {
    const { client, worker } = setup();
    client.cancel();
    expect(worker.sent).toEqual([]);
  });

  it('rejects with the worker\'s own error rather than a generic one', async () => {
    const { client, worker } = setup();
    const solving = client.solve(createSolvedState());
    worker.reply({
      type: 'error',
      requestId: worker.sent[0]!.requestId,
      name: 'CubeStateValidationError',
      message: 'corner permutation is not a permutation',
    });

    await expect(solving).rejects.toBeInstanceOf(SolverError);
    await expect(solving).rejects.toMatchObject({
      name: 'CubeStateValidationError',
      message: 'corner permutation is not a permutation',
    });
  });

  it('fails everything outstanding when the worker dies', async () => {
    const { client, worker } = setup();
    const ready = client.ready();
    const solving = client.solve(createSolvedState());

    // Leaving these pending would hang the caller for the life of the page.
    worker.emit('error', { message: 'worker died' });
    await expect(ready).rejects.toBeInstanceOf(SolverTransportError);
    await expect(solving).rejects.toBeInstanceOf(SolverTransportError);
  });

  it('fails outstanding work when a message cannot be read', async () => {
    const { client, worker } = setup();
    const solving = client.solve(createSolvedState());
    worker.emit('messageerror', {});
    await expect(solving).rejects.toBeInstanceOf(SolverTransportError);
  });

  it('ignores a reply for a request it is no longer waiting on', async () => {
    const { client, worker } = setup();
    const solving = client.solve(createSolvedState());
    const requestId = worker.sent[0]!.requestId;

    worker.reply({ type: 'result', requestId, result: SOLVED_RESULT });
    await expect(solving).resolves.toEqual(SOLVED_RESULT);
    // A late duplicate must not throw or resolve anything a second time.
    expect(() =>
      worker.reply({ type: 'result', requestId, result: CANCELLED_RESULT }),
    ).not.toThrow();
    expect(() =>
      worker.reply({ type: 'result', requestId: 9_999, result: SOLVED_RESULT }),
    ).not.toThrow();
  });

  it('terminates the worker and refuses further work once disposed', async () => {
    const { client, worker } = setup();
    const solving = client.solve(createSolvedState());
    client.dispose();

    await expect(solving).rejects.toBeInstanceOf(SolverTransportError);
    expect(worker.terminated).toBe(1);
    await expect(client.ready()).rejects.toThrow();
    await expect(client.solve(createSolvedState())).rejects.toThrow();

    client.dispose();
    expect(worker.terminated).toBe(1);
  });

  it('gives every request its own id', () => {
    const { client, worker } = setup();
    void client.ready().catch(() => undefined);
    void client.solve(createSolvedState()).catch(() => undefined);
    void client.solve(createSolvedState()).catch(() => undefined);
    const ids = worker.sent.map((message) => message.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe('worker construction', () => {
  it('builds one worker and only one', () => {
    const createWorker = vi.fn(() => new FakeWorker());
    const client = createSolverClient({ createWorker });
    void client.ready().catch(() => undefined);
    void client.solve(createSolvedState()).catch(() => undefined);
    expect(createWorker).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
