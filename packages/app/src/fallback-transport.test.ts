import {
  applyMoves,
  createSolvedState,
  statesEqual,
  type CubeState,
} from '@rubcube/cube-core';
import {
  CommitDispatcher,
  type CommitBatch,
  type CommitProvenance,
  type DispatchEvent,
  type EnqueueCommitProvenance,
  type MoveTransportBackendSink,
  type QueuedMove,
} from '@rubcube/cube-render/transport';
import { describe, expect, it, vi } from 'vitest';

import {
  FallbackMoveTransportBackend,
  type ScheduleFallbackMacrotask,
} from './fallback-transport.js';

class ManualMacrotasks {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void>();

  readonly schedule: ScheduleFallbackMacrotask = (task) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, task);
    return () => this.tasks.delete(id);
  };

  get size(): number {
    return this.tasks.size;
  }

  runNext(): void {
    const next = this.tasks.entries().next().value as
      | readonly [number, () => void]
      | undefined;
    if (next === undefined) throw new Error('No fallback macrotask is pending');
    this.tasks.delete(next[0]);
    next[1]();
  }
}

function command(
  commandId: string,
  overrides: Partial<Omit<EnqueueCommitProvenance, 'commandId'>> = {},
): EnqueueCommitProvenance {
  return {
    commandId,
    intent: overrides.intent ?? 'forward',
    origin: overrides.origin ?? 'manual',
  } as EnqueueCommitProvenance;
}

function label(event: DispatchEvent): string {
  if ('status' in event) {
    return `end:${event.commandId}:${event.status}:${event.committedMoves}`;
  }
  const change = event.changes[0]!;
  return change.move === null
    ? 'batch:replace'
    : `batch:${change.provenance.commandId}:${change.move.face}${change.move.turns}`;
}

interface Harness {
  readonly dispatcher: CommitDispatcher;
  readonly backend: FallbackMoveTransportBackend;
  readonly scheduler: ManualMacrotasks;
  readonly events: DispatchEvent[];
}

function createHarness(
  onDispatch?: (event: DispatchEvent, dispatcher: CommitDispatcher) => void,
): Harness {
  const initialState = createSolvedState();
  const scheduler = new ManualMacrotasks();
  const events: DispatchEvent[] = [];
  let backend!: FallbackMoveTransportBackend;
  let dispatcher!: CommitDispatcher;
  dispatcher = new CommitDispatcher({
    initialState,
    createBackend: (sink) => {
      backend = new FallbackMoveTransportBackend({
        initialState,
        sink,
        scheduleMacrotask: scheduler.schedule,
      });
      return backend;
    },
    onDispatch: (event) => {
      events.push(event);
      onDispatch?.(event, dispatcher);
    },
  });
  return { dispatcher, backend, scheduler, events };
}

describe('FallbackMoveTransportBackend playback', () => {
  it('commits one move per macrotask with ordered snapshots and finalState', async () => {
    const { dispatcher, backend, scheduler, events } = createHarness();
    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 3 },
        { face: 'F', turns: 2 },
      ],
      command('formula', { origin: 'formula' }),
    );

    expect(scheduler.size).toBe(1);
    expect(events).toEqual([]);
    expect(statesEqual(backend.state, createSolvedState())).toBe(true);
    await Promise.resolve();
    expect(events).toEqual([]);

    scheduler.runNext();
    expect(events.map(label)).toEqual(['batch:formula:R1']);
    expect(scheduler.size).toBe(1);

    scheduler.runNext();
    expect(events.map(label)).toEqual([
      'batch:formula:R1',
      'batch:formula:U3',
    ]);
    expect(scheduler.size).toBe(1);

    scheduler.runNext();
    expect(events.map(label)).toEqual([
      'batch:formula:R1',
      'batch:formula:U3',
      'batch:formula:F2',
      'end:formula:completed:3',
    ]);
    expect(scheduler.size).toBe(0);
    expect(dispatcher.isBusy).toBe(false);

    const expected = applyMoves(createSolvedState(), "R U' F2");
    expect(statesEqual(dispatcher.state, expected)).toBe(true);
    expect(statesEqual(backend.finalState, expected)).toBe(true);
    for (const event of events.filter(
      (candidate): candidate is CommitBatch => 'changes' in candidate,
    )) {
      expect(event.changes).toHaveLength(1);
      expect(statesEqual(event.changes[0]!.state, event.finalState)).toBe(true);
    }
  });

  it('preserves command FIFO and every move provenance across queued commands', () => {
    const { dispatcher, scheduler, events } = createHarness();
    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'L', turns: 3 },
      ],
      command('first', { origin: 'tutorial' }),
    );
    dispatcher.enqueue(
      [{ face: 'D', turns: 2 }],
      command('second', { origin: 'scramble' }),
    );

    scheduler.runNext();
    scheduler.runNext();
    scheduler.runNext();

    expect(events.map(label)).toEqual([
      'batch:first:R1',
      'batch:first:L3',
      'end:first:completed:2',
      'batch:second:D2',
      'end:second:completed:1',
    ]);
    const batches = events.filter(
      (event): event is CommitBatch => 'changes' in event,
    );
    expect(batches.map((batch) => batch.changes[0]!.provenance)).toEqual([
      command('first', { origin: 'tutorial' }),
      command('first', { origin: 'tutorial' }),
      command('second', { origin: 'scramble' }),
    ]);
  });

  it('cancels before the first task with zero commits and no stale callback', () => {
    const { dispatcher, backend, scheduler, events } = createHarness();
    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ],
      command('cancel-before'),
    );

    dispatcher.cancelPlayback('user cancelled');

    expect(events.map(label)).toEqual(['end:cancel-before:cancelled:0']);
    expect(scheduler.size).toBe(0);
    expect(backend.isBusy).toBe(false);
    expect(statesEqual(dispatcher.state, createSolvedState())).toBe(true);
  });

  it('keeps a committed prefix when cancellation is requested in a batch callback', () => {
    let requested = false;
    const { dispatcher, backend, scheduler, events } = createHarness(
      (event, transport) => {
        if (!requested && 'changes' in event) {
          requested = true;
          transport.cancelPlayback('stop after prefix');
        }
      },
    );
    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ],
      command('prefix'),
    );

    scheduler.runNext();

    expect(events.map(label)).toEqual([
      'batch:prefix:R1',
      'end:prefix:cancelled:1',
    ]);
    expect(scheduler.size).toBe(0);
    expect(
      statesEqual(dispatcher.state, applyMoves(createSolvedState(), 'R')),
    ).toBe(true);
    expect(statesEqual(backend.state, dispatcher.state)).toBe(true);
  });

  it('replace cancels queued work and synchronously publishes its exact state', () => {
    const { dispatcher, backend, scheduler, events } = createHarness();
    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ],
      command('replaced'),
    );
    const replacement = applyMoves(createSolvedState(), "F2 D L'");

    dispatcher.replaceState(replacement);

    expect(events.map(label)).toEqual([
      'end:replaced:cancelled:0',
      'batch:replace',
    ]);
    expect(scheduler.size).toBe(0);
    expect(statesEqual(dispatcher.state, replacement)).toBe(true);
    expect(statesEqual(backend.finalState, replacement)).toBe(true);
    replacement.cp[0] = 7;
    expect(statesEqual(backend.finalState, dispatcher.state)).toBe(true);
  });

  it('rejects interactive drag admission without scheduling fallback work', () => {
    const { dispatcher, scheduler, events } = createHarness();

    expect(
      dispatcher.beginInteractive('U', {
        commandId: 'fallback-drag',
        intent: 'forward',
        origin: 'drag',
      }),
    ).toBe(false);
    expect(events.map(label)).toEqual(['end:fallback-drag:failed:0']);
    expect(scheduler.size).toBe(0);
    expect(dispatcher.isFatal).toBe(false);
  });

  it('dispose preserves a prefix and fails every unfinished command once', () => {
    const { dispatcher, backend, scheduler, events } = createHarness();
    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ],
      command('dispose-a'),
    );
    dispatcher.enqueue(
      [{ face: 'F', turns: 1 }],
      command('dispose-b'),
    );

    scheduler.runNext();
    backend.dispose();
    backend.dispose();

    expect(events.map(label)).toEqual([
      'batch:dispose-a:R1',
      'end:dispose-a:failed:1',
      'end:dispose-b:failed:0',
    ]);
    expect(scheduler.size).toBe(0);
    expect(backend.isBusy).toBe(false);
    expect(dispatcher.isFatal).toBe(true);
    expect(
      statesEqual(dispatcher.state, applyMoves(createSolvedState(), 'R')),
    ).toBe(true);
    expect(() => backend.pump()).toThrow(/disposed/iu);
  });
});

describe('FallbackMoveTransportBackend defensive protocol checks', () => {
  function directBackend(
    scheduler: ManualMacrotasks,
    commit = vi.fn(),
  ): {
    readonly backend: FallbackMoveTransportBackend;
    readonly commit: typeof commit;
    readonly fail: ReturnType<typeof vi.fn>;
  } {
    const fail = vi.fn();
    const sink: MoveTransportBackendSink = {
      commit,
      endCommand: vi.fn(),
      fail,
    };
    return {
      backend: new FallbackMoveTransportBackend({
        initialState: createSolvedState(),
        sink,
        scheduleMacrotask: scheduler.schedule,
      }),
      commit,
      fail,
    };
  }

  it('copies input and rejects mixed, drag, duplicate, and invalid provenance atomically', () => {
    const scheduler = new ManualMacrotasks();
    const { backend, commit } = directBackend(scheduler);
    const queued: QueuedMove = {
      move: { face: 'R', turns: 1 },
      provenance: command('copied', { origin: 'auto-solve' }),
    };
    backend.enqueue([queued]);
    (queued.move as { face: string }).face = 'U';
    (queued.provenance as { commandId: string }).commandId = 'mutated';
    backend.pump();
    scheduler.runNext();

    expect(commit).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          move: { face: 'R', turns: 1 },
          provenance: command('copied', { origin: 'auto-solve' }),
        }),
      ],
      expect.any(Object),
    );
    expect(() =>
      backend.enqueue([
        {
          move: { face: 'U', turns: 1 },
          provenance: command('copied'),
        },
      ]),
    ).toThrow(/already been queued/iu);

    const mixed: QueuedMove[] = [
      {
        move: { face: 'U', turns: 1 },
        provenance: command('mixed'),
      },
      {
        move: { face: 'D', turns: 1 },
        provenance: command('other'),
      },
    ];
    expect(() => backend.enqueue(mixed)).toThrow(/one command provenance/iu);
    expect(() =>
      backend.enqueue([
        {
          move: { face: 'F', turns: 1 },
          provenance: {
            commandId: 'drag-not-queued',
            intent: 'forward',
            origin: 'drag',
          },
        },
      ]),
    ).toThrow(/intent\/origin provenance/iu);
    expect(() =>
      backend.enqueue([
        {
          move: { face: 'B', turns: 1 },
          provenance: {
            commandId: 'bad-history',
            intent: 'forward',
            origin: 'history',
          } as unknown as CommitProvenance,
        },
      ]),
    ).toThrow(/intent\/origin provenance/iu);
    expect(backend.isBusy).toBe(false);
  });

  it('invalidates even an uncancellable stale task on cancel and replace', () => {
    const staleTasks: Array<() => void> = [];
    const schedule: ScheduleFallbackMacrotask = (task) => {
      staleTasks.push(task);
      return () => undefined;
    };
    const commit = vi.fn();
    const sink: MoveTransportBackendSink = {
      commit,
      endCommand: vi.fn(),
      fail: vi.fn(),
    };
    const backend = new FallbackMoveTransportBackend({
      initialState: createSolvedState(),
      sink,
      scheduleMacrotask: schedule,
    });
    backend.enqueue([
      {
        move: { face: 'R', turns: 1 },
        provenance: command('stale-cancel'),
      },
    ]);
    backend.pump();
    backend.cancelPlayback('cancel');
    staleTasks.shift()!();
    expect(commit).not.toHaveBeenCalled();

    backend.enqueue([
      {
        move: { face: 'U', turns: 1 },
        provenance: command('stale-replace'),
      },
    ]);
    backend.pump();
    const replacement = applyMoves(createSolvedState(), 'L2');
    backend.replaceState(replacement);
    expect(commit).toHaveBeenCalledTimes(1);
    staleTasks.shift()!();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(statesEqual(backend.state, replacement)).toBe(true);
  });

  it('isolates sink failures from the macrotask and reports them through fail', () => {
    const scheduler = new ManualMacrotasks();
    const commit = vi.fn(() => {
      throw new Error('foreign sink failed');
    });
    const { backend, fail } = directBackend(scheduler, commit);
    backend.enqueue([
      {
        move: { face: 'R', turns: 1 },
        provenance: command('sink-failure'),
      },
    ]);
    backend.pump();

    expect(() => scheduler.runNext()).not.toThrow();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'foreign sink failed' }),
    );
    expect(backend.isBusy).toBe(false);
  });

  it('never exposes its mutable state buffers', () => {
    const scheduler = new ManualMacrotasks();
    const { backend } = directBackend(scheduler);
    const leaked: CubeState = backend.state;
    leaked.cp[0] = 7;
    const leakedFinal: CubeState = backend.finalState;
    leakedFinal.ep[0] = 11;

    expect(statesEqual(backend.state, createSolvedState())).toBe(true);
  });
});
