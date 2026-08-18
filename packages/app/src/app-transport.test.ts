import {
  applyMoves,
  cloneState,
  createSolvedState,
  statesEqual,
} from '@rubcube/cube-core';
import type {
  CubeStateChange,
  MoveTransportBackend,
  MoveTransportBackendSink,
} from '@rubcube/cube-render/transport';
import { describe, expect, it } from 'vitest';

import { createAppDispatcher } from './app-transport.js';
import {
  FallbackMoveTransportBackend,
  type ScheduleFallbackMacrotask,
} from './fallback-transport.js';
import { createCubeStore } from './store.js';

describe('app dispatcher binding', () => {
  it('mirrors acceptance through terminal idle without making observer errors fatal', () => {
    const initialState = createSolvedState();
    const store = createCubeStore(initialState);
    let pendingTask: (() => void) | null = null;
    const scheduleMacrotask: ScheduleFallbackMacrotask = (task) => {
      pendingTask = task;
      return () => {
        pendingTask = null;
      };
    };

    const dispatcher = createAppDispatcher({
      initialState,
      initialRevision: 0,
      store,
      createBackend: (sink) =>
        new FallbackMoveTransportBackend({
          initialState,
          sink,
          scheduleMacrotask,
        }),
    });
    dispatcher.subscribe(() => {
      throw new Error('non-authoritative activity observer failed');
    });

    expect(
      dispatcher.enqueue(
        [{ face: 'R', turns: 1 }],
        { commandId: 'manual-1', intent: 'forward', origin: 'manual' },
      ),
    ).toBe(true);
    expect(store.getState().transportBusy).toBe(true);
    expect(store.getState().commandRevision).toBe(1);
    expect(pendingTask).not.toBeNull();

    const run = pendingTask as unknown as () => void;
    pendingTask = null;
    run();

    const state = store.getState();
    expect(state.transportBusy).toBe(false);
    expect(state.commandRevision).toBe(1);
    expect(state.fatalInvariant).toBeNull();
    expect(state.lastCommandEnd).toEqual({
      commandId: 'manual-1',
      status: 'completed',
      committedMoves: 1,
    });
    expect(statesEqual(state.cube, applyMoves(initialState, 'R'))).toBe(true);
    expect(state.history.entries).toEqual([
      {
        move: { face: 'R', turns: 1 },
        origin: 'manual',
        commandId: 'manual-1',
      },
    ]);
  });

  it('ignores same-revision callbacks from a backend that lost ownership', () => {
    const initialState = createSolvedState();
    const store = createCubeStore(initialState);
    let oldTask: (() => void) | null = null;
    let oldIsCurrent = true;

    const oldDispatcher = createAppDispatcher({
      initialState,
      initialRevision: 0,
      store,
      isCurrent: () => oldIsCurrent,
      createBackend: (sink) =>
        new FallbackMoveTransportBackend({
          initialState,
          sink,
          scheduleMacrotask: (task) => {
            oldTask = task;
            // Deliberately leave a physically uncancellable task behind. The
            // app generation guard still has to reject its dispatcher edges.
            return () => undefined;
          },
        }),
    });
    oldDispatcher.enqueue(
      [{ face: 'R', turns: 1 }],
      { commandId: 'old-renderer', intent: 'forward', origin: 'manual' },
    );
    expect(store.getState().transportBusy).toBe(true);

    oldIsCurrent = false;
    createAppDispatcher({
      initialState: store.getState().cube,
      initialRevision: store.getState().commandRevision,
      store,
      createBackend: (sink) =>
        new FallbackMoveTransportBackend({
          initialState: store.getState().cube,
          sink,
        }),
    });
    expect(store.getState().transportBusy).toBe(false);

    const runOld = oldTask as unknown as () => void;
    oldTask = null;
    runOld();

    expect(store.getState().transportBusy).toBe(false);
    expect(store.getState().commandRevision).toBe(1);
    expect(store.getState().history.entries).toEqual([]);
    expect(statesEqual(store.getState().cube, initialState)).toBe(true);
  });

  it('mirrors a backend pump failure and allows an explicit replace to recover', () => {
    const initialState = createSolvedState();
    const store = createCubeStore(initialState);
    const dispatcher = createAppDispatcher({
      initialState,
      initialRevision: 0,
      store,
      createBackend: (sink) =>
        new FallbackMoveTransportBackend({
          initialState,
          sink,
          scheduleMacrotask: () => {
            throw new Error('scheduler unavailable');
          },
        }),
    });

    expect(
      dispatcher.enqueue(
        [{ face: 'R', turns: 1 }],
        { commandId: 'broken-pump', intent: 'forward', origin: 'manual' },
      ),
    ).toBe(true);
    expect(dispatcher.isFatal).toBe(true);
    expect(store.getState()).toMatchObject({
      transportBusy: false,
      transportFatal: true,
      commandRevision: 1,
      lastCommandEnd: {
        commandId: 'broken-pump',
        status: 'failed',
        committedMoves: 0,
      },
    });
    expect(store.getState().fatalInvariant).toBeNull();

    dispatcher.replaceState(initialState);

    expect(dispatcher.isFatal).toBe(false);
    expect(store.getState()).toMatchObject({
      transportBusy: false,
      transportFatal: false,
      commandRevision: 2,
      lastCommandEnd: null,
    });
  });

  it('keeps a protocol-invalid replace visibly fatal after publishing its fact', () => {
    const initialState = createSolvedState();
    const requested = applyMoves(initialState, 'U');
    const backendState = applyMoves(initialState, 'R');
    const store = createCubeStore(initialState);
    let sink!: MoveTransportBackendSink;
    const backend: MoveTransportBackend = {
      get isBusy() {
        return false;
      },
      enqueue: () => undefined,
      beginInteractive: () => false,
      replaceState: () => {
        sink.commit(
          [{ state: cloneState(backendState), move: null }],
          cloneState(backendState),
        );
      },
      cancelPlayback: () => undefined,
      pump: () => undefined,
    };
    const dispatcher = createAppDispatcher({
      initialState,
      initialRevision: 0,
      store,
      createBackend: (createdSink) => {
        sink = createdSink;
        return backend;
      },
    });

    dispatcher.replaceState(requested);

    expect(dispatcher.isFatal).toBe(true);
    expect(store.getState().transportFatal).toBe(true);
    expect(store.getState().fatalInvariant).not.toBeNull();
    expect(statesEqual(store.getState().cube, backendState)).toBe(true);
    expect(statesEqual(store.getState().history.baseState, backendState)).toBe(true);
    expect(store.getState().history.entries).toEqual([]);
  });

  it('checkpoints a valid backend finalState when committed detail is malformed', () => {
    const initialState = createSolvedState();
    const committedState = applyMoves(initialState, 'R');
    const store = createCubeStore(initialState);
    let sink!: MoveTransportBackendSink;
    let backendBusy = false;
    const backend: MoveTransportBackend = {
      get isBusy() {
        return backendBusy;
      },
      enqueue: () => {
        backendBusy = true;
      },
      beginInteractive: () => false,
      replaceState: () => undefined,
      cancelPlayback: () => {
        backendBusy = false;
      },
      pump: () => undefined,
    };
    const dispatcher = createAppDispatcher({
      initialState,
      initialRevision: 0,
      store,
      createBackend: (createdSink) => {
        sink = createdSink;
        return backend;
      },
    });
    dispatcher.enqueue(
      [{ face: 'R', turns: 1 }],
      {
        commandId: 'malformed-detail',
        intent: 'forward',
        origin: 'manual',
      },
    );

    backendBusy = false;
    sink.commit(
      [
        {
          state: cloneState(committedState),
          move: { face: 'R', turns: 1 },
          provenance: {
            commandId: 'malformed-detail',
            intent: 'forward',
            origin: 'history',
          },
        } as unknown as CubeStateChange,
      ],
      committedState,
    );

    const state = store.getState();
    expect(dispatcher.isFatal).toBe(true);
    expect(state.transportFatal).toBe(true);
    expect(state.fatalInvariant).not.toBeNull();
    expect(statesEqual(state.cube, committedState)).toBe(true);
    expect(statesEqual(state.history.baseState, committedState)).toBe(true);
    expect(state.history.entries).toEqual([]);
    expect(state.lastCommandEnd).toEqual(
      expect.objectContaining({
        commandId: 'malformed-detail',
        status: 'failed',
        committedMoves: 0,
      }),
    );
  });
});
