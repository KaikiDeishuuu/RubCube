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
import { IDLE_TIMER, type TimerEvent } from './timer.js';

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


describe('solve results', () => {
  /** Drives the machine to a finished attempt of `durationMs`. */
  function solve(
    store: ReturnType<typeof createCubeStore>,
    durationMs: number,
    at = 0,
  ): void {
    const script: readonly TimerEvent[] = [
      { type: 'hold-start', at },
      { type: 'tick', at: at + 600 },
      { type: 'hold-end', at: at + 700 },
      { type: 'solved', at: at + 700 + durationMs },
    ];
    for (const event of script) store.getState().dispatchTimer(event);
  }

  it('records one result on the edge into stopped, not on every event', () => {
    const store = createCubeStore();
    store.getState().setScramble("R U R' U'", 4_242);
    solve(store, 12_340);

    expect(store.getState().results).toHaveLength(1);
    expect(store.getState().results[0]).toMatchObject({
      rawMs: 12_340,
      penalty: 'none',
      scramble: "R U R' U'",
      scrambleSeed: 4_242,
    });

    // Further events on a finished attempt must not append a second copy.
    store.getState().dispatchTimer({ type: 'solved', at: 99_000 });
    store.getState().dispatchTimer({ type: 'abort', at: 99_000 });
    expect(store.getState().results).toHaveLength(1);
  });

  it('records an abandoned attempt as a DNF rather than losing it', () => {
    const store = createCubeStore();
    store.getState().dispatchTimer({ type: 'hold-start', at: 0 });
    store.getState().dispatchTimer({ type: 'tick', at: 600 });
    store.getState().dispatchTimer({ type: 'hold-end', at: 700 });
    store.getState().dispatchTimer({ type: 'abort', at: 5_700 });

    expect(store.getState().results).toEqual([
      expect.objectContaining({ rawMs: 5_000, penalty: 'dnf' }),
    ]);
  });

  it('records nothing for an attempt that never started', () => {
    const store = createCubeStore();
    store.getState().dispatchTimer({ type: 'hold-start', at: 0 });
    store.getState().dispatchTimer({ type: 'hold-end', at: 100 });
    store.getState().dispatchTimer({ type: 'reset', at: 200 });
    expect(store.getState().results).toEqual([]);
    expect(store.getState().timer).toEqual(IDLE_TIMER);
  });

  it('keeps ids rising across a cleared session', () => {
    const store = createCubeStore();
    solve(store, 1_000);
    const first = store.getState().results[0]!.id;

    store.getState().clearResults();
    solve(store, 2_000, 10_000);
    const second = store.getState().results[0]!.id;

    // A penalty edit aimed at the cleared solve must not land on the new one,
    // which is exactly what a reused id would allow.
    expect(second).toBeGreaterThan(first);
    store.getState().setResultPenalty(first, 'dnf');
    expect(store.getState().results[0]!.penalty).toBe('none');
  });

  it('edits and drops results by id', () => {
    const store = createCubeStore();
    solve(store, 1_000);
    solve(store, 2_000, 10_000);
    const [a, b] = store.getState().results;

    store.getState().setResultPenalty(b!.id, 'plus2');
    expect(store.getState().results.map((r) => r.penalty)).toEqual(['none', 'plus2']);

    store.getState().deleteResult(a!.id);
    expect(store.getState().results).toEqual([
      expect.objectContaining({ id: b!.id, penalty: 'plus2' }),
    ]);
  });

  it('leaves state identical for edits that change nothing', () => {
    const store = createCubeStore();
    solve(store, 1_000);
    const before = store.getState().results;

    store.getState().setResultPenalty(before[0]!.id, 'none');
    store.getState().setResultPenalty(9_999, 'dnf');
    store.getState().deleteResult(9_999);
    // Identity, not equality: a new array here would rerender every consumer.
    expect(store.getState().results).toBe(before);

    store.getState().clearResults();
    const empty = store.getState().results;
    store.getState().clearResults();
    expect(store.getState().results).toBe(empty);
  });

  it('abandons a live attempt when the inspection rule changes under it', () => {
    const store = createCubeStore();
    store.getState().dispatchTimer({ type: 'hold-start', at: 0 });
    store.getState().dispatchTimer({ type: 'tick', at: 600 });
    store.getState().dispatchTimer({ type: 'hold-end', at: 700 });
    expect(store.getState().timer.phase).toBe('running');

    // Scoring this attempt under a rule it was not run to would be worse than
    // losing it, and it has not been recorded, so nothing is destroyed.
    store.getState().setInspection(true);
    expect(store.getState().timer).toEqual(IDLE_TIMER);
    expect(store.getState().results).toEqual([]);
    expect(store.getState().timerConfig.inspection).toBe(true);
  });

  it('leaves an idle timer alone when the rule changes', () => {
    const store = createCubeStore();
    const before = store.getState().timer;
    store.getState().setInspection(true);
    expect(store.getState().timer).toBe(before);

    // Setting the value it already has must not disturb anything either.
    solve(store, 0);
    const running = store.getState().timer;
    store.getState().setInspection(true);
    expect(store.getState().timer).toBe(running);
  });
});


describe('restoring a session', () => {
  function stored(id: number, rawMs: number) {
    return {
      id,
      recordedAt: 1_000 + id,
      rawMs,
      penalty: 'none' as const,
      scramble: "R U R' U'",
      scrambleSeed: 1,
    };
  }

  /** Drives the machine to a finished attempt of `durationMs`. */
  function solve(store: ReturnType<typeof createCubeStore>, durationMs: number, at = 0): void {
    const script: readonly TimerEvent[] = [
      { type: 'hold-start', at },
      { type: 'tick', at: at + 600 },
      { type: 'hold-end', at: at + 700 },
      { type: 'solved', at: at + 700 + durationMs },
    ];
    for (const event of script) store.getState().dispatchTimer(event);
  }

  it('restores a stored session', () => {
    const store = createCubeStore();
    store.getState().hydrateResults([stored(7, 9_000), stored(8, 10_000)]);
    expect(store.getState().results.map((r) => r.id)).toEqual([7, 8]);
  });

  it('numbers new solves above everything it restored', () => {
    const store = createCubeStore();
    store.getState().hydrateResults([stored(7, 9_000), stored(8, 10_000)]);
    solve(store, 11_000);

    const ids = store.getState().results.map((r) => r.id);
    expect(ids).toEqual([7, 8, 9]);
    // An id counter that restarted at zero would let this solve collide with a
    // restored one, and a penalty edit would then land on both.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps a solve that finished while the restore was still in flight', () => {
    const store = createCubeStore();
    solve(store, 5_000);
    const raced = store.getState().results[0]!;
    expect(raced.id).toBe(1);

    store.getState().hydrateResults([stored(7, 9_000), stored(8, 10_000)]);
    const results = store.getState().results;
    // It keeps its place at the end of the session, renumbered clear of the
    // restored ids it was about to collide with.
    expect(results.map((r) => r.rawMs)).toEqual([9_000, 10_000, 5_000]);
    expect(results.map((r) => r.id)).toEqual([7, 8, 9]);
  });

  it('restores once, so a late second load cannot duplicate the session', () => {
    const store = createCubeStore();
    store.getState().hydrateResults([stored(7, 9_000)]);
    solve(store, 11_000);
    const after = store.getState().results;

    store.getState().hydrateResults([stored(7, 9_000)]);
    expect(store.getState().results).toBe(after);
  });

  it('does not churn state when there is nothing to restore', () => {
    const store = createCubeStore();
    const before = store.getState().results;
    store.getState().hydrateResults([]);
    expect(store.getState().results).toBe(before);
  });
});
