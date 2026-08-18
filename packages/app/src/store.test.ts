import {
  applyMove,
  applyMoves,
  cloneState,
  createSolvedState,
  parseMoves,
  statesEqual,
  type CubeState,
  type Move,
} from '@rubcube/cube-core';
import {
  CommitDispatcher,
  type DragCommitProvenance,
  type CommandEnd,
  type CommitBatch,
  type CommitProvenance,
  type CubeStateChange,
  type MoveTransportBackend,
  type MoveTransportBackendSink,
  type QueuedMove,
} from '@rubcube/cube-render/transport';
import { describe, expect, it } from 'vitest';

import { replayHistory } from './history.js';
import { createCubeStore } from './store.js';

function moveBatch(
  start: CubeState,
  moves: readonly Move[],
  provenance: CommitProvenance,
  batchId: number,
): CommitBatch {
  let state = cloneState(start);
  const changes: CubeStateChange[] = [];
  for (const move of moves) {
    state = applyMove(state, move);
    changes.push({
      state: cloneState(state),
      move: { face: move.face, turns: move.turns },
      provenance: { ...provenance },
    });
  }
  return { batchId, changes, finalState: cloneState(state) };
}

function replaceBatch(state: CubeState, batchId: number): CommitBatch {
  return {
    batchId,
    changes: [{ state: cloneState(state), move: null }],
    finalState: cloneState(state),
  };
}

class StoreTestBackend implements MoveTransportBackend {
  private state: CubeState;
  private readonly pending: QueuedMove[] = [];

  constructor(
    initialState: CubeState,
    private readonly sink: MoveTransportBackendSink,
  ) {
    this.state = cloneState(initialState);
  }

  get isBusy(): boolean {
    return this.pending.length > 0;
  }

  enqueue(moves: readonly QueuedMove[]): void {
    this.pending.push(...moves);
  }

  beginInteractive(
    _face: Move['face'],
    _provenance: DragCommitProvenance,
  ): boolean {
    return false;
  }

  replaceState(state: CubeState): void {
    this.state = cloneState(state);
    this.sink.commit(
      [{ state: cloneState(this.state), move: null }],
      cloneState(this.state),
    );
  }

  cancelPlayback(_reason: string): void {
    this.pending.length = 0;
  }

  pump(): void {}

  commitNext(): void {
    const queued = this.pending.shift();
    if (queued === undefined) throw new Error('No queued move to commit');
    this.state = applyMove(this.state, queued.move);
    this.sink.commit(
      [
        {
          state: cloneState(this.state),
          move: { face: queued.move.face, turns: queued.move.turns },
          provenance: { ...queued.provenance },
        },
      ],
      cloneState(this.state),
    );
  }
}

function createStoreDispatcher(
  store: ReturnType<typeof createCubeStore>,
  initialState: CubeState = store.getState().cube,
): { readonly dispatcher: CommitDispatcher; readonly backend: StoreTestBackend } {
  let backend!: StoreTestBackend;
  let dispatcher!: CommitDispatcher;
  dispatcher = new CommitDispatcher({
    initialState,
    initialRevision: store.getState().commandRevision,
    createBackend: (sink) => {
      backend = new StoreTestBackend(initialState, sink);
      return backend;
    },
    onRevisionChange: (commandRevision) => {
      store.getState().syncTransportStatus({
        isBusy: dispatcher.isBusy,
        isFatal: dispatcher.isFatal,
        commandRevision,
      });
    },
    onBusyChange: (isBusy) => {
      store.getState().syncTransportStatus({
        isBusy,
        isFatal: dispatcher.isFatal,
        commandRevision: dispatcher.commandRevision,
      });
    },
    onDispatch: (event) => store.getState().handleDispatchEvent(event),
    onDispatchError: (event, error, latestState) => {
      store.getState().enterDispatchFatal(event, latestState, error);
    },
  });
  return { dispatcher, backend };
}

describe('cube store history transactions', () => {
  it('publishes a complete multi-change batch exactly once', () => {
    const store = createCubeStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const batch = moveBatch(
      store.getState().cube,
      parseMoves('R L'),
      { commandId: 'formula-1', intent: 'forward', origin: 'formula' },
      1,
    );

    store.getState().commitBatch(batch);
    unsubscribe();

    const state = store.getState();
    expect(notifications).toBe(1);
    expect(state.history.entries.map((entry) => entry.move)).toEqual(parseMoves('R L'));
    expect(statesEqual(state.cube, batch.finalState)).toBe(true);
    expect(statesEqual(replayHistory(state.history), state.cube)).toBe(true);
  });

  it('does not publish or modify state when a later batch change fails validation', () => {
    const store = createCubeStore();
    const before = store.getState();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const valid = moveBatch(
      before.cube,
      parseMoves('U D'),
      { commandId: 'formula-invalid', intent: 'forward', origin: 'formula' },
      2,
    );
    const invalid: CommitBatch = {
      ...valid,
      changes: [
        valid.changes[0]!,
        { ...valid.changes[1]!, state: cloneState(valid.changes[0]!.state) },
      ],
    };

    expect(() => store.getState().commitBatch(invalid)).toThrow(
      /does not match baseState \+ committed entries/,
    );
    unsubscribe();

    expect(notifications).toBe(0);
    expect(store.getState()).toBe(before);
    expect(store.getState().history.entries).toEqual([]);
    expect(statesEqual(store.getState().cube, createSolvedState())).toBe(true);
  });

  it('allows a defensive checkpoint copy only while the store is bootstrapping', () => {
    const store = createCubeStore();
    const replacement = applyMoves(createSolvedState(), 'F2 D L');
    store.getState().setCube(replacement);
    replacement.cp[0] = 7;

    const state = store.getState();
    const expected = applyMoves(createSolvedState(), 'F2 D L');
    expect(state.history.entries).toEqual([]);
    expect(state.history.truncated).toBe(false);
    expect(statesEqual(state.cube, expected)).toBe(true);
    expect(statesEqual(state.history.baseState, expected)).toBe(true);
    expect(state.cube.cp).not.toBe(state.history.baseState.cp);
  });

  it('seals the direct checkpoint path once runtime transport state exists', () => {
    const store = createCubeStore();
    store.getState().setRenderMode('webgl');

    expect(() =>
      store.getState().setCube(applyMoves(createSolvedState(), 'R U')),
    ).toThrow(/bootstrap-only/);

    // A StrictMode-style transition back through booting must not reopen it.
    store.getState().setRenderMode('booting');
    expect(() => store.getState().setCube(createSolvedState())).toThrow(/bootstrap-only/);

    const idleTransportStore = createCubeStore();
    idleTransportStore.getState().syncTransportStatus({
      isBusy: false,
      isFatal: false,
      commandRevision: 0,
    });
    expect(() => idleTransportStore.getState().setCube(createSolvedState())).toThrow(
      /bootstrap-only/,
    );
  });
});

describe('dispatch fatal state', () => {
  it('checkpoints a newer committed transport state in one publication', () => {
    const store = createCubeStore();
    store.getState().commitBatch(
      moveBatch(
        store.getState().cube,
        parseMoves('R'),
        { commandId: 'manual-before-fatal', intent: 'forward', origin: 'manual' },
        1,
      ),
    );
    store.getState().syncTransportStatus({
      isBusy: true,
      isFatal: false,
      commandRevision: 4,
    });

    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const latestState = applyMove(store.getState().cube, { face: 'U', turns: 1 });
    const expected = cloneState(latestState);
    const error = new Error('authoritative batch reducer failed');

    const failedBatch = moveBatch(
      store.getState().cube,
      [{ face: 'U', turns: 1 }],
      { commandId: 'failed-batch', intent: 'forward', origin: 'manual' },
      2,
    );
    store.getState().enterDispatchFatal(failedBatch, latestState, error);
    unsubscribe();
    latestState.ep[0] = 11;
    error.message = 'mutated later';

    const state = store.getState();
    expect(notifications).toBe(1);
    expect(statesEqual(state.cube, expected)).toBe(true);
    expect(statesEqual(state.history.baseState, expected)).toBe(true);
    expect(state.history.entries).toEqual([]);
    expect(state.history.truncated).toBe(false);
    expect(state.fatalInvariant).toEqual({
      name: 'Error',
      message: 'authoritative batch reducer failed',
    });
    expect(state.transportBusy).toBe(false);
    expect(state.commandRevision).toBe(4);
  });

  it('preserves valid history when a CommandEnd handler fails on the current state', () => {
    const store = createCubeStore();
    store.getState().commitBatch(
      moveBatch(
        store.getState().cube,
        parseMoves('R'),
        { commandId: 'manual-before-end-fatal', intent: 'forward', origin: 'manual' },
        1,
      ),
    );
    const latest = cloneState(store.getState().cube);

    store.getState().enterDispatchFatal(
      {
        commandId: 'manual-before-end-fatal',
        status: 'completed',
        committedMoves: 1,
      },
      latest,
      new Error('command end failed'),
    );

    expect(store.getState().history.entries.map((entry) => entry.move)).toEqual(
      parseMoves('R'),
    );
    expect(statesEqual(replayHistory(store.getState().history), store.getState().cube)).toBe(
      true,
    );
    expect(store.getState().fatalInvariant?.message).toBe('command end failed');
  });

  it('clears fatal state only after a valid explicit replace batch commits', () => {
    const store = createCubeStore();
    const latest = applyMoves(createSolvedState(), 'R U');
    store.getState().enterDispatchFatal(
      replaceBatch(latest, 8),
      latest,
      new Error('broken invariant'),
    );
    expect(store.getState().fatalInvariant).not.toBeNull();
    store.getState().recordCommandEnd({
      commandId: 'cancelled-before-reset',
      status: 'cancelled',
      committedMoves: 1,
    });
    expect(store.getState().lastCommandEnd).not.toBeNull();

    const replacement = applyMoves(createSolvedState(), 'F2 L');
    store.getState().commitBatch(replaceBatch(replacement, 9));

    expect(store.getState().fatalInvariant).toBeNull();
    expect(store.getState().lastCommandEnd).toBeNull();
    expect(store.getState().history.entries).toEqual([]);
    expect(statesEqual(replayHistory(store.getState().history), replacement)).toBe(true);
  });
});

describe('command and transport status', () => {
  it('mirrors real dispatcher revision and busy edges through completion', () => {
    const store = createCubeStore();
    const { dispatcher, backend } = createStoreDispatcher(store);

    expect(
      dispatcher.enqueue(
        parseMoves('R'),
        { commandId: 'integrated-manual', intent: 'forward', origin: 'manual' },
      ),
    ).toBe(true);
    expect(store.getState()).toMatchObject({
      commandRevision: 1,
      transportBusy: true,
    });

    backend.commitNext();

    expect(store.getState()).toMatchObject({
      commandRevision: 1,
      transportBusy: false,
      lastCommandEnd: {
        commandId: 'integrated-manual',
        status: 'completed',
        committedMoves: 1,
      },
    });
    expect(store.getState().history.entries.map((entry) => entry.move)).toEqual(
      parseMoves('R'),
    );
    expect(statesEqual(replayHistory(store.getState().history), store.getState().cube)).toBe(
      true,
    );
    expect(() => store.getState().setCube(createSolvedState())).toThrow(/bootstrap-only/);
  });

  it('checkpoints the dispatcher final state when the store reducer fails', () => {
    const transportInitial = createSolvedState();
    const store = createCubeStore();
    store.getState().commitBatch(
      moveBatch(
        store.getState().cube,
        parseMoves('U'),
        { commandId: 'out-of-band-setup', intent: 'forward', origin: 'manual' },
        41,
      ),
    );
    const { dispatcher, backend } = createStoreDispatcher(store, transportInitial);

    dispatcher.enqueue(
      parseMoves('R'),
      { commandId: 'fatal-integrated', intent: 'forward', origin: 'manual' },
    );
    expect(() => backend.commitNext()).not.toThrow();

    const expected = applyMoves(transportInitial, 'R');
    expect(dispatcher.isFatal).toBe(true);
    expect(store.getState().fatalInvariant?.message).toMatch(
      /does not match baseState \+ committed entries/,
    );
    expect(store.getState().transportBusy).toBe(false);
    expect(statesEqual(store.getState().cube, expected)).toBe(true);
    expect(statesEqual(store.getState().history.baseState, expected)).toBe(true);
    expect(store.getState().history.entries).toEqual([]);
    expect(store.getState().lastCommandEnd).toMatchObject({
      commandId: 'fatal-integrated',
      status: 'failed',
      committedMoves: 1,
    });
  });

  it('defensively copies CommandEnd delivered through the canonical event handler', () => {
    const store = createCubeStore();
    const event: CommandEnd = {
      commandId: 'formula-complete',
      status: 'completed',
      committedMoves: 3,
      reason: 'done',
    };
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.getState().handleDispatchEvent(event);
    unsubscribe();
    const mutable = event as {
      commandId: string;
      status: CommandEnd['status'];
      committedMoves: number;
      reason?: string;
    };
    mutable.commandId = 'changed';
    mutable.status = 'failed';
    mutable.committedMoves = 99;
    mutable.reason = 'changed later';

    expect(notifications).toBe(1);
    expect(store.getState().lastCommandEnd).toEqual({
      commandId: 'formula-complete',
      status: 'completed',
      committedMoves: 3,
      reason: 'done',
    });
    expect(store.getState().lastCommandEnd).not.toBe(event);
  });

  it('syncs transport status once and ignores an identical repeat', () => {
    const store = createCubeStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.getState().syncTransportStatus({
      isBusy: true,
      isFatal: false,
      commandRevision: 12,
    });
    store.getState().syncTransportStatus({
      isBusy: true,
      isFatal: false,
      commandRevision: 12,
    });
    unsubscribe();

    expect(notifications).toBe(1);
    expect(store.getState().transportBusy).toBe(true);
    expect(store.getState().commandRevision).toBe(12);
  });

  it('never regresses the revision used to reject stale async work', () => {
    const store = createCubeStore();
    store.getState().syncTransportStatus({
      isBusy: true,
      isFatal: false,
      commandRevision: 12,
    });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.getState().syncTransportStatus({
      isBusy: false,
      isFatal: false,
      commandRevision: 11,
    });
    unsubscribe();

    expect(notifications).toBe(0);
    expect(store.getState().transportBusy).toBe(true);
    expect(store.getState().commandRevision).toBe(12);
  });

  it('survives hostile Error diagnostics without losing the fatal checkpoint', () => {
    const store = createCubeStore();
    const latest = applyMoves(createSolvedState(), 'R U');
    const hostile = new Error('hidden');
    Object.defineProperty(hostile, 'message', {
      get: () => {
        throw new Error('message getter exploded');
      },
    });

    expect(() =>
      store.getState().enterDispatchFatal(
        replaceBatch(latest, 99),
        latest,
        hostile,
      ),
    ).not.toThrow();
    expect(store.getState().fatalInvariant).toEqual({
      name: 'Error',
      message: 'Unknown dispatch failure',
    });
    expect(statesEqual(store.getState().cube, latest)).toBe(true);
  });
});
