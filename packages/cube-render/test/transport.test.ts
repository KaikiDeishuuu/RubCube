import {
  applyMove,
  applyMoves,
  cloneState,
  createSolvedState,
  statesEqual,
  type CubeState,
  type Face,
  type Move,
} from '@rubcube/cube-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CommitDispatcher,
  type CommandEnd,
  type CommitBatch,
  type CubeStateChange,
  type DispatchEvent,
  type DragCommitProvenance,
  type EnqueueCommitProvenance,
  type MoveTransportBackend,
  type MoveTransportBackendSink,
  RETAINED_COMMAND_IDS,
  type QueuedMove,
} from '../src/transport.js';

function provenance(
  commandId: string,
  overrides: Partial<Omit<EnqueueCommitProvenance, 'commandId'>> = {},
): EnqueueCommitProvenance {
  return {
    commandId,
    intent: overrides.intent ?? 'forward',
    origin: overrides.origin ?? 'manual',
  } as EnqueueCommitProvenance;
}

function isBatch(event: DispatchEvent): event is CommitBatch {
  return 'changes' in event;
}

function isEnd(event: DispatchEvent): event is CommandEnd {
  return 'status' in event;
}

function eventLabel(event: DispatchEvent): string {
  if (isEnd(event)) return `end:${event.commandId}:${event.status}`;
  const change = event.changes[0]!;
  return change.move === null
    ? 'batch:replace'
    : `batch:${change.provenance.commandId}`;
}

class FakeBackend implements MoveTransportBackend {
  readonly pending: QueuedMove[] = [];
  readonly enqueueCalls: QueuedMove[][] = [];
  readonly interactiveCalls: Array<{
    readonly face: Face;
    readonly provenance: DragCommitProvenance;
  }> = [];
  readonly cancelReasons: string[] = [];
  pumpCalls = 0;
  pumpAction: (() => void) | null = null;
  interactiveAcceptance = true;
  state: CubeState;
  replacementOverride: CubeState | null = null;
  activeDrag: {
    readonly face: Face;
    readonly provenance: DragCommitProvenance;
  } | null = null;

  constructor(
    initialState: CubeState,
    private readonly sink: MoveTransportBackendSink,
  ) {
    this.state = cloneState(initialState);
  }

  get isBusy(): boolean {
    return this.pending.length > 0 || this.activeDrag !== null;
  }

  enqueue(moves: readonly QueuedMove[]): void {
    const copies = moves.map((queued): QueuedMove => ({
      move: { face: queued.move.face, turns: queued.move.turns },
      provenance: { ...queued.provenance },
    }));
    this.enqueueCalls.push(copies);
    this.pending.push(...copies);
  }

  beginInteractive(face: Face, provenance: DragCommitProvenance): boolean {
    const copy = {
      face,
      provenance: { ...provenance },
    };
    this.interactiveCalls.push(copy);
    if (!this.interactiveAcceptance) return false;
    this.activeDrag = copy;
    return true;
  }

  replaceState(state: CubeState): void {
    this.pending.length = 0;
    this.activeDrag = null;
    this.state = cloneState(this.replacementOverride ?? state);
    this.replacementOverride = null;
    this.sink.commit(
      [{ state: cloneState(this.state), move: null }],
      cloneState(this.state),
    );
  }

  cancelPlayback(reason: string): void {
    this.cancelReasons.push(reason);
    this.pending.length = 0;
    this.activeDrag = null;
  }

  pump(): void {
    this.pumpCalls += 1;
    this.pumpAction?.();
  }

  commitNext(count = 1): void {
    const selected = this.pending.splice(0, count);
    if (selected.length !== count) {
      throw new Error(`Fake backend only had ${selected.length} queued moves`);
    }
    const changes: CubeStateChange[] = [];
    for (const queued of selected) {
      this.state = applyMove(this.state, queued.move);
      changes.push({
        state: cloneState(this.state),
        move: { ...queued.move },
        provenance: { ...queued.provenance },
      });
    }
    this.sink.commit(changes, cloneState(this.state));
  }

  commitDrag(turns: Move['turns'], face?: Face): void {
    const active = this.activeDrag;
    if (active === null) throw new Error('Fake backend has no active drag');
    const move: Move = { face: face ?? active.face, turns };
    this.activeDrag = null;
    this.state = applyMove(this.state, move);
    this.sink.commit(
      [
        {
          state: cloneState(this.state),
          move,
          provenance: { ...active.provenance },
        },
      ],
      cloneState(this.state),
    );
  }

  endDrag(status: 'completed' | 'cancelled' | 'failed', reason?: string): void {
    const active = this.activeDrag;
    if (active === null) throw new Error('Fake backend has no active drag');
    this.activeDrag = null;
    this.sink.endCommand(active.provenance.commandId, status, reason);
  }

  emitCommit(changes: readonly CubeStateChange[], finalState: CubeState): void {
    this.state = cloneState(finalState);
    this.sink.commit(changes, finalState);
  }

  endCommand(
    commandId: string,
    status: 'completed' | 'cancelled' | 'failed',
    reason?: string,
  ): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]!.provenance.commandId === commandId) {
        this.pending.splice(index, 1);
      }
    }
    this.sink.endCommand(commandId, status, reason);
  }

  fail(reason: unknown): void {
    this.sink.fail(reason);
  }
}

interface HarnessOptions {
  readonly initialState?: CubeState;
  readonly onDispatch?: (event: DispatchEvent) => void;
  readonly onDispatchError?: (
    event: DispatchEvent,
    error: unknown,
    latestState: CubeState,
  ) => void;
}

interface Harness {
  readonly dispatcher: CommitDispatcher;
  readonly backend: FakeBackend;
  readonly events: DispatchEvent[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const initialState = options.initialState ?? createSolvedState();
  const events: DispatchEvent[] = [];
  let backend!: FakeBackend;
  const dispatcher = new CommitDispatcher({
    initialState,
    createBackend: (sink) => {
      backend = new FakeBackend(initialState, sink);
      return backend;
    },
    onDispatch: options.onDispatch ?? ((event) => events.push(event)),
    ...(options.onDispatchError === undefined
      ? {}
      : { onDispatchError: options.onDispatchError }),
  });
  return { dispatcher, backend, events };
}

describe('CommitDispatcher start gate', () => {
  it('reopens the gate for work staged from inside pump', () => {
    // pump is the sole start gate, so anything that reaches backend.enqueue
    // must still get a pump. Draining once after pump left work handed over but
    // never started until some unrelated later drain came along.
    const { dispatcher, backend } = createHarness();
    backend.pumpAction = () => {
      backend.pumpAction = null;
      dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('staged-from-pump'));
    };

    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('first'));

    expect(backend.enqueueCalls.map((call) => call[0]!.provenance.commandId)).toEqual([
      'first',
      'staged-from-pump',
    ]);
    // Two gate openings: one for the original command, one for what pump staged.
    expect(backend.pumpCalls).toBeGreaterThanOrEqual(2);
    expect(backend.pending).toHaveLength(2);

    backend.commitNext();
    backend.commitNext();
    expect(dispatcher.isBusy).toBe(false);
    expect(dispatcher.isFatal).toBe(false);
  });

  it('still converts a synchronous commit from pump into a protocol failure', () => {
    // Reopening the gate must not weaken the guard that makes committing from
    // inside pump a protocol error.
    const { dispatcher, backend, events } = createHarness();
    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('sync-commit'));
    backend.pumpAction = () => {
      backend.pumpAction = null;
      backend.commitNext();
    };
    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('second'));

    expect(dispatcher.isFatal).toBe(true);
    expect(events.filter(isEnd).map((end) => end.status)).toContain('failed');
  });
});

describe('CommitDispatcher command id retention', () => {
  it('retires old ids but never a live one', () => {
    const { dispatcher, backend } = createHarness();

    // Accepted and never ended, so it stays live for the whole run.
    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('long-lived'));
    // Retired without committing, so each one becomes evictable immediately.
    for (let index = 0; index < RETAINED_COMMAND_IDS + 16; index += 1) {
      dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance(`bulk-${index}`));
      backend.endCommand(`bulk-${index}`, 'cancelled');
    }
    expect(dispatcher.isFatal).toBe(false);

    // Live ids are skipped by eviction no matter how much traffic passes them.
    expect(() =>
      dispatcher.enqueue([{ face: 'F', turns: 1 }], provenance('long-lived')),
    ).toThrow(/already been used/);

    // A just-retired id is still recognised, so a late end stays tolerated.
    backend.endCommand(`bulk-${RETAINED_COMMAND_IDS + 15}`, 'cancelled');
    expect(dispatcher.isFatal).toBe(false);

    // The documented trade-off: an id retired more than the cap ago is no
    // longer recognised, so a late end for it reads as a protocol error.
    backend.endCommand('bulk-0', 'cancelled');
    expect(dispatcher.isFatal).toBe(true);
  });
});

describe('CommitDispatcher command acceptance', () => {
  it('treats an empty enqueue as a strict no-op and copies accepted input', () => {
    const { dispatcher, backend, events } = createHarness();
    expect(
      dispatcher.enqueue([], {
        commandId: '',
        intent: 'not-an-intent',
        origin: 'not-an-origin',
      } as unknown as EnqueueCommitProvenance),
    ).toBe(false);
    expect(dispatcher.commandRevision).toBe(0);
    expect(dispatcher.isBusy).toBe(false);

    const move = { face: 'R' as const, turns: 1 as const };
    const metadata = {
      commandId: 'command-a',
      intent: 'forward' as const,
      origin: 'formula' as const,
    };
    expect(dispatcher.enqueue([move], metadata)).toBe(true);
    expect(dispatcher.commandRevision).toBe(1);
    expect(dispatcher.isBusy).toBe(true);

    (move as { face: string }).face = 'U';
    (metadata as { commandId: string }).commandId = 'mutated';
    expect(backend.pending).toEqual([
      {
        move: { face: 'R', turns: 1 },
        provenance: {
          commandId: 'command-a',
          intent: 'forward',
          origin: 'formula',
        },
      },
    ]);

    backend.commitNext();
    expect(events.map(eventLabel)).toEqual([
      'batch:command-a',
      'end:command-a:completed',
    ]);
    expect((events[0] as CommitBatch).batchId).toBe(1);
    expect((events[1] as CommandEnd).committedMoves).toBe(1);
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(createSolvedState(), { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(dispatcher.isBusy).toBe(false);

    expect(() =>
      dispatcher.enqueue([{ face: 'F', turns: 1 }], provenance('command-a')),
    ).toThrow(/already been used/iu);
    expect(dispatcher.commandRevision).toBe(1);
  });

  it('validates a command completely before registering or incrementing revision', () => {
    const { dispatcher, backend } = createHarness();
    expect(() =>
      dispatcher.enqueue(
        [{ face: 'X', turns: 1 } as unknown as Move],
        provenance('invalid-move'),
      ),
    ).toThrow(/Move must/iu);
    expect(() =>
      dispatcher.enqueue([{ face: 'U', turns: 1 }], {
        ...provenance(' '),
      }),
    ).toThrow(/provenance/iu);
    expect(() =>
      dispatcher.enqueue(
        [{ face: 'U', turns: 1 }],
        {
          commandId: 'forward-history',
          intent: 'forward',
          origin: 'history',
        } as unknown as EnqueueCommitProvenance,
      ),
    ).toThrow(/provenance/iu);
    expect(() =>
      dispatcher.enqueue(
        [{ face: 'U', turns: 1 }],
        {
          commandId: 'undo-manual',
          intent: 'undo',
          origin: 'manual',
        } as unknown as EnqueueCommitProvenance,
      ),
    ).toThrow(/provenance/iu);
    expect(() =>
      dispatcher.enqueue(
        [{ face: 'U', turns: 1 }],
        {
          commandId: 'queued-drag',
          intent: 'forward',
          origin: 'drag',
        } as unknown as EnqueueCommitProvenance,
      ),
    ).toThrow(/drag.*beginInteractive/iu);
    expect(() =>
      dispatcher.enqueue(
        [
          { face: 'U', turns: 3 },
          { face: 'R', turns: 3 },
        ],
        { commandId: 'multi-undo', intent: 'undo', origin: 'history' },
      ),
    ).toThrow(/undo.*exactly one/iu);
    expect(dispatcher.commandRevision).toBe(0);
    expect(backend.pending).toHaveLength(0);

    expect(
      dispatcher.enqueue(
        [{ face: 'U', turns: 3 }],
        { commandId: 'valid-undo', intent: 'undo', origin: 'history' },
      ),
    ).toBe(true);
    backend.commitNext();
    expect(dispatcher.commandRevision).toBe(1);
  });

  it('keeps isBusy true throughout batch and terminal callbacks', () => {
    const samples: boolean[] = [];
    let dispatcher!: CommitDispatcher;
    let backend!: FakeBackend;
    const initialState = createSolvedState();
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: () => samples.push(dispatcher.isBusy),
    });

    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('busy'));
    backend.commitNext();
    expect(samples).toEqual([true, true]);
    expect(dispatcher.isBusy).toBe(false);
  });

  it('increments revision for idle cancel/replace but not for an invalid replace', () => {
    const { dispatcher, backend, events } = createHarness();
    dispatcher.cancelPlayback('nothing queued');
    expect(dispatcher.commandRevision).toBe(1);
    expect(backend.cancelReasons).toEqual(['nothing queued']);
    expect(events).toHaveLength(0);

    const invalid = createSolvedState();
    invalid.cp[0] = invalid.cp[1]!;
    expect(() => dispatcher.replaceState(invalid)).toThrow(/invalid cube state/iu);
    expect(dispatcher.commandRevision).toBe(1);

    const replacement = applyMove(createSolvedState(), { face: 'B', turns: 2 });
    dispatcher.replaceState(replacement);
    replacement.cp[0] = 7;
    expect(dispatcher.commandRevision).toBe(2);
    expect(events.map(eventLabel)).toEqual(['batch:replace']);
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(createSolvedState(), { face: 'B', turns: 2 }),
      ),
    ).toBe(true);
  });
});

describe('CommitDispatcher interactive command lifecycle', () => {
  it('copies an accepted drag and makes a busy rejection a strict no-op', () => {
    const { dispatcher, backend, events } = createHarness();
    const metadata: DragCommitProvenance = {
      commandId: 'drag-a',
      intent: 'forward',
      origin: 'drag',
    };

    expect(dispatcher.beginInteractive('U', metadata)).toBe(true);
    expect(dispatcher.commandRevision).toBe(1);
    expect(backend.interactiveCalls).toEqual([
      { face: 'U', provenance: metadata },
    ]);

    (metadata as { commandId: string }).commandId = 'mutated';
    const blocked: DragCommitProvenance = {
      commandId: 'drag-b',
      intent: 'forward',
      origin: 'drag',
    };
    expect(dispatcher.beginInteractive('F', blocked)).toBe(false);
    expect(dispatcher.commandRevision).toBe(1);
    expect(backend.interactiveCalls).toHaveLength(1);

    backend.endDrag('cancelled', 'pointer released before a turn');
    expect(events).toEqual([
      expect.objectContaining({
        commandId: 'drag-a',
        status: 'cancelled',
        committedMoves: 0,
      }),
    ]);

    // A busy rejection did not reserve drag-b's ID.
    expect(dispatcher.beginInteractive('F', blocked)).toBe(true);
    expect(dispatcher.commandRevision).toBe(2);
    backend.endDrag('cancelled');
  });

  it('reports a backend admission refusal as one failed accepted command', () => {
    const { dispatcher, backend, events } = createHarness();
    backend.interactiveAcceptance = false;

    expect(
      dispatcher.beginInteractive('R', {
        commandId: 'rejected-drag',
        intent: 'forward',
        origin: 'drag',
      }),
    ).toBe(false);

    expect(dispatcher.commandRevision).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        commandId: 'rejected-drag',
        status: 'failed',
        committedMoves: 0,
      }),
    ]);
    expect(dispatcher.isFatal).toBe(false);
    expect(() =>
      dispatcher.beginInteractive('R', {
        commandId: 'rejected-drag',
        intent: 'forward',
        origin: 'drag',
      }),
    ).toThrow(/already been used/iu);
  });

  it('commits one quarter turn with provenance and completes exactly once', () => {
    const { dispatcher, backend, events } = createHarness();
    const metadata: DragCommitProvenance = {
      commandId: 'committed-drag',
      intent: 'forward',
      origin: 'drag',
    };

    expect(dispatcher.beginInteractive('L', metadata)).toBe(true);
    backend.commitDrag(3);
    backend.endCommand('committed-drag', 'completed', 'duplicate backend end');

    expect(events.map(eventLabel)).toEqual([
      'batch:committed-drag',
      'end:committed-drag:completed',
    ]);
    const batch = events[0] as CommitBatch;
    expect(batch.changes).toEqual([
      expect.objectContaining({
        move: { face: 'L', turns: 3 },
        provenance: metadata,
      }),
    ]);
    expect(events[1]).toMatchObject({ committedMoves: 1 });
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(createSolvedState(), { face: 'L', turns: 3 }),
      ),
    ).toBe(true);
    expect(dispatcher.isFatal).toBe(false);
  });

  it('uses cancelled/0 for rollback and rejects completed/0', () => {
    const rollback = createHarness();
    rollback.dispatcher.beginInteractive('B', {
      commandId: 'rollback',
      intent: 'forward',
      origin: 'drag',
    });
    rollback.backend.endDrag('cancelled', 'below snap threshold');
    expect(rollback.events).toEqual([
      expect.objectContaining({
        commandId: 'rollback',
        status: 'cancelled',
        committedMoves: 0,
      }),
    ]);
    expect(statesEqual(rollback.dispatcher.state, createSolvedState())).toBe(true);

    const premature = createHarness();
    premature.dispatcher.beginInteractive('B', {
      commandId: 'premature',
      intent: 'forward',
      origin: 'drag',
    });
    premature.backend.endDrag('completed');
    expect(premature.events).toEqual([
      expect.objectContaining({
        commandId: 'premature',
        status: 'failed',
        committedMoves: 0,
      }),
    ]);
    expect(premature.dispatcher.isFatal).toBe(true);
  });

  it.each([
    ['a half turn', 2 as const, 'U' as const],
    ['a different face', 1 as const, 'R' as const],
  ])('rejects %s reported for a drag', (_label, turns, face) => {
    const { dispatcher, backend, events } = createHarness();
    dispatcher.beginInteractive('U', {
      commandId: `invalid-drag-${turns}-${face}`,
      intent: 'forward',
      origin: 'drag',
    });

    backend.commitDrag(turns, face);

    expect(dispatcher.isFatal).toBe(true);
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(createSolvedState(), { face, turns }),
      ),
    ).toBe(true);
    expect(events.map(eventLabel)).toEqual([
      `batch:invalid-drag-${turns}-${face}`,
      `end:invalid-drag-${turns}-${face}:failed`,
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({ status: 'failed', committedMoves: 0 }),
    );
  });
});

describe('CommitDispatcher batch delivery', () => {
  it('delivers one ordered batch and gives every listener defensive state copies', () => {
    const initialState = createSolvedState();
    const authoritative: DispatchEvent[] = [];
    const observed: DispatchEvent[] = [];
    const errors: Array<{ event: DispatchEvent; latest: CubeState }> = [];
    let backend!: FakeBackend;
    const dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        authoritative.push(event);
        if (isBatch(event)) event.changes[0]!.state.cp[0] = 7;
      },
      onDispatchError: (event, _error, latest) => {
        errors.push({ event, latest: cloneState(latest) });
        latest.cp[0] = 6;
      },
    });

    dispatcher.subscribe((event) => {
      if (!isBatch(event)) return;
      event.finalState.cp[0] = 5;
      throw new Error('broken observer');
    });
    dispatcher.subscribe((event) => observed.push(event));

    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'L', turns: 3 },
      ],
      provenance('pair', { origin: 'formula' }),
    );
    backend.commitNext(2);

    expect(authoritative.map(eventLabel)).toEqual([
      'batch:pair',
      'end:pair:completed',
    ]);
    expect(observed.map(eventLabel)).toEqual([
      'batch:pair',
      'end:pair:completed',
    ]);
    const batch = observed[0] as CommitBatch;
    expect(batch.changes).toHaveLength(2);
    expect(
      statesEqual(
        batch.changes[0]!.state,
        applyMove(initialState, { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(
      statesEqual(batch.finalState, applyMoves(initialState, "R L'")),
    ).toBe(true);
    expect(errors).toHaveLength(1);
    expect(isBatch(errors[0]!.event)).toBe(true);
    expect(statesEqual(errors[0]!.latest, applyMoves(initialState, "R L'"))).toBe(
      true,
    );
    // Mutating the error hook's snapshot, the authoritative event, and another
    // observer's event cannot touch the dispatcher's state.
    expect(statesEqual(dispatcher.state, applyMoves(initialState, "R L'"))).toBe(
      true,
    );
    expect(dispatcher.isFatal).toBe(false);
  });

  it('isolates an observer exception and continues all later observers and events', () => {
    const failures = vi.fn();
    const { dispatcher, backend } = createHarness({
      onDispatchError: failures,
    });
    const later = vi.fn();
    dispatcher.subscribe(() => {
      throw new Error('observer failed');
    });
    dispatcher.subscribe(later);

    dispatcher.enqueue([{ face: 'F', turns: 1 }], provenance('observer'));
    backend.commitNext();

    expect(failures).toHaveBeenCalledTimes(2);
    expect(failures.mock.calls.map((call) => call[3])).toEqual([
      'observer',
      'observer',
    ]);
    expect(later).toHaveBeenCalledTimes(2);
    expect(dispatcher.isFatal).toBe(false);
  });
});

describe('CommitDispatcher deferred FIFO', () => {
  it('completes the current command before deferred enqueue then replace', () => {
    const replacement = applyMoves(createSolvedState(), 'F2 D');
    const labels: string[] = [];
    let depth = 0;
    let maximumDepth = 0;
    let dispatcher!: CommitDispatcher;
    let backend!: FakeBackend;
    const initialState = createSolvedState();
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        depth += 1;
        maximumDepth = Math.max(maximumDepth, depth);
        labels.push(eventLabel(event));
        if (isBatch(event) && eventLabel(event) === 'batch:a') {
          dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('b'));
          dispatcher.replaceState(replacement);
        }
        depth -= 1;
      },
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('a'));
    backend.commitNext();

    expect(labels).toEqual([
      'batch:a',
      'end:a:completed',
      'end:b:cancelled',
      'batch:replace',
    ]);
    expect(maximumDepth).toBe(1);
    expect(dispatcher.commandRevision).toBe(3);
    expect(statesEqual(dispatcher.state, replacement)).toBe(true);
    expect(backend.pending).toHaveLength(0);
    expect(dispatcher.isBusy).toBe(false);
  });

  it('plays a deferred enqueue from the replacement state when replace comes first', () => {
    const replacement = applyMove(createSolvedState(), { face: 'F', turns: 2 });
    const labels: string[] = [];
    let dispatcher!: CommitDispatcher;
    let backend!: FakeBackend;
    const initialState = createSolvedState();
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        labels.push(eventLabel(event));
        if (eventLabel(event) === 'batch:a') {
          dispatcher.replaceState(replacement);
          dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('b'));
        }
      },
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('a'));
    backend.commitNext();
    expect(backend.pending.map((queued) => queued.provenance.commandId)).toEqual([
      'b',
    ]);
    backend.commitNext();

    expect(labels).toEqual([
      'batch:a',
      'end:a:completed',
      'batch:replace',
      'batch:b',
      'end:b:completed',
    ]);
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(replacement, { face: 'U', turns: 1 }),
      ),
    ).toBe(true);
  });

  it('keeps a committed prefix and cancels only the uncommitted suffix', () => {
    const labels: string[] = [];
    const ends: CommandEnd[] = [];
    let dispatcher!: CommitDispatcher;
    let backend!: FakeBackend;
    const initialState = createSolvedState();
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        labels.push(eventLabel(event));
        if (isEnd(event)) ends.push(event);
        if (eventLabel(event) === 'batch:long') {
          dispatcher.cancelPlayback('user stopped playback');
        }
      },
    });

    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
        { face: 'F', turns: 1 },
      ],
      provenance('long'),
    );
    backend.commitNext();

    expect(labels).toEqual(['batch:long', 'end:long:cancelled']);
    expect(ends[0]).toMatchObject({
      commandId: 'long',
      status: 'cancelled',
      committedMoves: 1,
      reason: 'user stopped playback',
    });
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(initialState, { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(backend.pending).toHaveLength(0);
    expect(dispatcher.commandRevision).toBe(2);
  });
});

describe('CommitDispatcher backend protocol boundaries', () => {
  it('checkpoints a valid finalState when committed move detail is malformed', () => {
    const errors = vi.fn();
    const { dispatcher, backend, events } = createHarness({
      onDispatchError: errors,
    });
    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('malformed-detail'));

    const committedState = applyMove(createSolvedState(), {
      face: 'R',
      turns: 1,
    });
    backend.emitCommit(
      [
        {
          state: cloneState(committedState),
          move: { face: 'R', turns: 1 },
          // This impossible intent/origin pair fails while the sink defensively
          // clones detail, after the backend has already advanced finalState.
          provenance: {
            commandId: 'malformed-detail',
            intent: 'forward',
            origin: 'history',
          },
        } as unknown as CubeStateChange,
      ],
      committedState,
    );

    expect(dispatcher.isFatal).toBe(true);
    expect(statesEqual(dispatcher.state, committedState)).toBe(true);
    expect(statesEqual(dispatcher.state, backend.state)).toBe(true);
    expect(events.map(eventLabel)).toEqual([
      'batch:replace',
      'end:malformed-detail:failed',
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        commandId: 'malformed-detail',
        status: 'failed',
        committedMoves: 0,
      }),
    );
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[3]).toBe('transport');
  });

  it('rejects a commit from a later accepted command before the FIFO head', () => {
    const errors = vi.fn();
    const { dispatcher, backend, events } = createHarness({
      onDispatchError: errors,
    });
    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('first'));
    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('second'));

    const outOfOrderState = applyMove(createSolvedState(), {
      face: 'U',
      turns: 1,
    });
    backend.emitCommit(
      [
        {
          state: cloneState(outOfOrderState),
          move: { face: 'U', turns: 1 },
          provenance: provenance('second'),
        },
      ],
      outOfOrderState,
    );

    expect(dispatcher.isFatal).toBe(true);
    expect(statesEqual(dispatcher.state, outOfOrderState)).toBe(true);
    expect(events.map(eventLabel)).toEqual([
      'batch:second',
      'end:first:failed',
      'end:second:failed',
    ]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/before first/iu) }),
    );
  });

  it.each([
    {
      label: 'non-opposite layers',
      moves: [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ] as const,
      count: 2,
      error: /opposite layers/iu,
    },
    {
      label: 'more than two changes',
      moves: [
        { face: 'R', turns: 1 },
        { face: 'L', turns: 1 },
        { face: 'U', turns: 1 },
      ] as const,
      count: 3,
      error: /at most two/iu,
    },
  ])('rejects a move batch containing $label', ({ moves, count, error }) => {
    const failures = vi.fn();
    const { dispatcher, backend, events } = createHarness({
      onDispatchError: failures,
    });
    dispatcher.enqueue(moves, provenance(`invalid-batch-${count}`));

    backend.commitNext(count);

    expect(dispatcher.isFatal).toBe(true);
    expect(statesEqual(dispatcher.state, applyMoves(createSolvedState(), moves))).toBe(
      true,
    );
    expect(events.map(eventLabel)).toEqual([
      `batch:invalid-batch-${count}`,
      `end:invalid-batch-${count}:failed`,
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({ status: 'failed', committedMoves: 0 }),
    );
    expect(failures.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ message: expect.stringMatching(error) }),
    );
  });

  it('turns a synchronous sink call from pump into a fatal protocol error', () => {
    const { dispatcher, backend, events } = createHarness();
    backend.pumpAction = () => backend.commitNext();

    expect(
      dispatcher.enqueue([{ face: 'F', turns: 1 }], provenance('sync-pump')),
    ).toBe(true);

    const committedState = applyMove(createSolvedState(), {
      face: 'F',
      turns: 1,
    });
    expect(dispatcher.isFatal).toBe(true);
    expect(statesEqual(dispatcher.state, committedState)).toBe(true);
    expect(statesEqual(dispatcher.state, backend.state)).toBe(true);
    expect(events.map(eventLabel)).toEqual([
      'batch:sync-pump',
      'end:sync-pump:failed',
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        commandId: 'sync-pump',
        status: 'failed',
        committedMoves: 1,
        reason: expect.stringMatching(/synchronously committed from pump/iu),
      }),
    );
  });
});

describe('CommitDispatcher terminal and fatal handling', () => {
  it('delivers a backend terminal report at most once', () => {
    const { dispatcher, backend, events } = createHarness();
    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('terminal'));

    backend.endCommand('terminal', 'cancelled', 'drag rolled back');
    backend.endCommand('terminal', 'cancelled', 'duplicate');

    expect(events).toEqual([
      expect.objectContaining({
        commandId: 'terminal',
        status: 'cancelled',
        committedMoves: 0,
        reason: 'drag rolled back',
      }),
    ]);
    expect(dispatcher.isBusy).toBe(false);
  });

  it('treats an early completed or unknown backend end as a fatal protocol error', () => {
    const early = createHarness();
    early.dispatcher.enqueue(
      [{ face: 'U', turns: 1 }],
      provenance('early'),
    );
    early.backend.endCommand('early', 'completed');
    expect(early.dispatcher.isFatal).toBe(true);
    expect(early.events).toEqual([
      expect.objectContaining({
        commandId: 'early',
        status: 'failed',
        committedMoves: 0,
      }),
    ]);

    const unknown = createHarness();
    unknown.backend.endCommand('never-accepted', 'cancelled');
    expect(unknown.dispatcher.isFatal).toBe(true);
    expect(unknown.events).toHaveLength(0);
  });

  it('fails every unfinished command when the authoritative batch reducer throws', () => {
    const initialState = createSolvedState();
    const seen: DispatchEvent[] = [];
    const errors: Array<{ event: DispatchEvent; latest: CubeState }> = [];
    let throwOnBatch = true;
    let backend!: FakeBackend;
    const dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        seen.push(event);
        if (throwOnBatch && isBatch(event)) throw new Error('history invariant');
      },
      onDispatchError: (event, _error, latest) => {
        errors.push({ event, latest: cloneState(latest) });
        latest.cp[0] = 7;
      },
    });

    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ],
      provenance('a'),
    );
    dispatcher.enqueue([{ face: 'F', turns: 1 }], provenance('b'));
    backend.commitNext();

    const ends = seen.filter(isEnd);
    expect(ends).toEqual([
      expect.objectContaining({
        commandId: 'a',
        status: 'failed',
        committedMoves: 1,
      }),
      expect.objectContaining({
        commandId: 'b',
        status: 'failed',
        committedMoves: 0,
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(
      statesEqual(
        errors[0]!.latest,
        applyMove(initialState, { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(initialState, { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(dispatcher.isFatal).toBe(true);
    expect(dispatcher.enqueue([{ face: 'D', turns: 1 }], provenance('c'))).toBe(
      false,
    );
    expect(dispatcher.commandRevision).toBe(2);

    // A later explicit valid replace is the sole in-process fatal recovery.
    throwOnBatch = false;
    const recovery = applyMove(initialState, { face: 'L', turns: 2 });
    dispatcher.replaceState(recovery);
    expect(dispatcher.isFatal).toBe(false);
    expect(statesEqual(dispatcher.state, recovery)).toBe(true);
    expect(dispatcher.commandRevision).toBe(3);
    expect(() =>
      dispatcher.enqueue([{ face: 'D', turns: 1 }], provenance('a')),
    ).toThrow(/already been used/iu);
  });

  it('never sends a second end when the command-end reducer itself throws', () => {
    const seen: DispatchEvent[] = [];
    const errors = vi.fn();
    let backend!: FakeBackend;
    const initialState = createSolvedState();
    const dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        seen.push(event);
        if (isEnd(event) && event.commandId === 'a') {
          throw new Error('end reducer failed');
        }
      },
      onDispatchError: errors,
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('a'));
    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('b'));
    backend.commitNext();

    const aEnds = seen.filter(
      (event): event is CommandEnd => isEnd(event) && event.commandId === 'a',
    );
    const bEnds = seen.filter(
      (event): event is CommandEnd => isEnd(event) && event.commandId === 'b',
    );
    expect(aEnds).toEqual([
      expect.objectContaining({ status: 'completed', committedMoves: 1 }),
    ]);
    expect(bEnds).toEqual([
      expect.objectContaining({ status: 'failed', committedMoves: 0 }),
    ]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(dispatcher.isFatal).toBe(true);
  });

  it('keeps a command-end observer enqueue ordered when the later replace reducer fails', () => {
    const replacement = applyMove(createSolvedState(), { face: 'F', turns: 2 });
    const authoritativeEvents: DispatchEvent[] = [];
    const observedEnds: CommandEnd[] = [];
    let backend!: FakeBackend;
    let dispatcher!: CommitDispatcher;
    const initialState = createSolvedState();
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new FakeBackend(initialState, sink);
        return backend;
      },
      onDispatch: (event) => {
        authoritativeEvents.push(event);
        if (isBatch(event) && event.changes[0]!.move === null) {
          throw new Error('replace reducer failed');
        }
      },
    });
    dispatcher.subscribe((event) => {
      if (!isEnd(event)) return;
      observedEnds.push(event);
      if (event.commandId === 'a') {
        dispatcher.replaceState(replacement);
        dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('b'));
      }
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('a'));
    backend.commitNext();

    expect(authoritativeEvents.map(eventLabel)).toEqual([
      'batch:a',
      'end:a:completed',
      'batch:replace',
      'end:b:failed',
    ]);
    expect(observedEnds).toEqual([
      expect.objectContaining({ commandId: 'a', status: 'completed' }),
      expect.objectContaining({
        commandId: 'b',
        status: 'failed',
        committedMoves: 0,
      }),
    ]);
    expect(
      observedEnds.filter((event) => event.commandId === 'b'),
    ).toHaveLength(1);
    expect(statesEqual(dispatcher.state, replacement)).toBe(true);
    expect(dispatcher.isFatal).toBe(true);
  });

  it('enters fatal mode on a backend timeline violation and preserves its last state', () => {
    const errors = vi.fn();
    const { dispatcher, backend, events } = createHarness({
      onDispatchError: errors,
    });
    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('expected'));

    const wrongState = applyMove(createSolvedState(), { face: 'U', turns: 1 });
    backend.emitCommit(
      [
        {
          state: wrongState,
          move: { face: 'U', turns: 1 },
          provenance: provenance('expected'),
        },
      ],
      wrongState,
    );

    expect(dispatcher.isFatal).toBe(true);
    expect(statesEqual(dispatcher.state, wrongState)).toBe(true);
    expect(events.map(eventLabel)).toEqual([
      'batch:expected',
      'end:expected:failed',
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        commandId: 'expected',
        status: 'failed',
        committedMoves: 0,
      }),
    );
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid replacement state that differs from the requested target', () => {
    const errors = vi.fn();
    const { dispatcher, backend } = createHarness({ onDispatchError: errors });
    const backendReplacement = applyMove(createSolvedState(), {
      face: 'D',
      turns: 1,
    });
    backend.replacementOverride = backendReplacement;

    dispatcher.replaceState(
      applyMove(createSolvedState(), { face: 'U', turns: 1 }),
    );

    expect(dispatcher.isFatal).toBe(true);
    expect(statesEqual(dispatcher.state, backendReplacement)).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('fails all live commands when the backend reports a fatal failure', () => {
    const { dispatcher, backend, events } = createHarness();
    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('a'));
    dispatcher.enqueue([{ face: 'U', turns: 1 }], provenance('b'));

    backend.fail(new Error('context lost'));

    expect(events).toEqual([
      expect.objectContaining({ commandId: 'a', status: 'failed' }),
      expect.objectContaining({ commandId: 'b', status: 'failed' }),
    ]);
    expect(dispatcher.isFatal).toBe(true);
    expect(backend.cancelReasons.at(-1)).toContain('context lost');
  });

  it('finishes fatal cleanup when an Error message getter is hostile', () => {
    const { dispatcher, backend, events } = createHarness();
    dispatcher.enqueue([{ face: 'R', turns: 1 }], provenance('hostile-error'));
    const hostile = new Error('hidden');
    Object.defineProperty(hostile, 'message', {
      get: () => {
        throw new Error('message getter exploded');
      },
    });

    expect(() => backend.fail(hostile)).not.toThrow();
    expect(dispatcher.isFatal).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        commandId: 'hostile-error',
        status: 'failed',
        reason: 'Move transport failed',
      }),
    ]);
  });
});
