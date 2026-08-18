import {
  applyMove,
  cloneState,
  createSolvedState,
  type CubeState,
  type Face,
} from '@rubcube/cube-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CommitDispatcher,
  type CubeStateChange,
  type DispatchEvent,
  type DragCommitProvenance,
  type EnqueueCommitProvenance,
  type MoveTransportBackend,
  type MoveTransportBackendSink,
  type QueuedMove,
} from '../src/transport.js';

function command(commandId: string): EnqueueCommitProvenance {
  return { commandId, intent: 'forward', origin: 'manual' };
}

function drag(commandId: string): DragCommitProvenance {
  return { commandId, intent: 'forward', origin: 'drag' };
}

function label(event: DispatchEvent): string {
  if ('status' in event) {
    return `end:${event.commandId}:${event.status}`;
  }
  const first = event.changes[0]!;
  return first.move === null
    ? 'batch:replace'
    : `batch:${first.provenance.commandId}`;
}

class RecordingBackend implements MoveTransportBackend {
  readonly enqueueCommandIds: string[] = [];
  readonly pending: QueuedMove[] = [];
  state: CubeState;
  dragActive = false;

  constructor(
    initialState: CubeState,
    private readonly sink: MoveTransportBackendSink,
    private readonly timeline: string[],
  ) {
    this.state = cloneState(initialState);
  }

  get isBusy(): boolean {
    return this.dragActive || this.pending.length > 0;
  }

  enqueue(moves: readonly QueuedMove[]): void {
    this.enqueueCommandIds.push(...moves.map((move) => move.provenance.commandId));
    this.timeline.push(`backend:enqueue:${moves[0]!.provenance.commandId}`);
    this.pending.push(...moves);
  }

  beginInteractive(face: Face, provenance: DragCommitProvenance): boolean {
    this.timeline.push(`backend:begin:${face}:${provenance.commandId}`);
    this.dragActive = true;
    return true;
  }

  replaceState(state: CubeState): void {
    this.state = cloneState(state);
    this.sink.commit(
      [{ state: cloneState(state), move: null }],
      cloneState(state),
    );
  }

  cancelPlayback(reason: string): void {
    this.timeline.push(`backend:cancel:${reason}`);
    this.dragActive = false;
    this.pending.length = 0;
  }

  pump(): void {}

  commitNext(): void {
    const queued = this.pending.shift();
    if (queued === undefined) throw new Error('No queued move to commit');
    this.state = applyMove(this.state, queued.move);
    const change: CubeStateChange = {
      state: cloneState(this.state),
      move: { ...queued.move },
      provenance: { ...queued.provenance },
    };
    this.sink.commit([change], cloneState(this.state));
  }
}

describe('CommitDispatcher revision observation', () => {
  it('continues a supplied app-wide revision instead of restarting at zero', () => {
    const initialState = createSolvedState();
    const timeline: string[] = [];
    const revisions: number[] = [];
    let backend!: RecordingBackend;
    const dispatcher = new CommitDispatcher({
      initialState,
      initialRevision: 12,
      createBackend: (sink) => {
        backend = new RecordingBackend(initialState, sink, timeline);
        return backend;
      },
      onRevisionChange: (revision) => revisions.push(revision),
    });

    expect(dispatcher.commandRevision).toBe(12);
    dispatcher.enqueue([{ face: 'R', turns: 1 }], command('continued'));
    expect(dispatcher.commandRevision).toBe(13);
    expect(revisions).toEqual([13]);
    expect(backend.enqueueCommandIds).toEqual(['continued']);

    expect(() =>
      new CommitDispatcher({
        initialState,
        initialRevision: -1,
        createBackend: (sink) => new RecordingBackend(initialState, sink, []),
      }),
    ).toThrow(/initialRevision/iu);
  });

  it('reports drag acceptance synchronously before backend begin or any event', () => {
    const initialState = createSolvedState();
    const timeline: string[] = [];
    const onDispatch = vi.fn();
    let backend!: RecordingBackend;
    let dispatcher!: CommitDispatcher;
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new RecordingBackend(initialState, sink, timeline);
        return backend;
      },
      onRevisionChange: (revision) => {
        timeline.push(`revision:${revision}`);
        expect(dispatcher.commandRevision).toBe(revision);
      },
      onDispatch,
    });

    expect(dispatcher.beginInteractive('R', drag('drag-a'))).toBe(true);

    expect(timeline).toEqual(['revision:1', 'backend:begin:R:drag-a']);
    expect(dispatcher.commandRevision).toBe(1);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('isolates revision-listener failures and preserves reentrant FIFO order', () => {
    const initialState = createSolvedState();
    const timeline: string[] = [];
    let backend!: RecordingBackend;
    let dispatcher!: CommitDispatcher;
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new RecordingBackend(initialState, sink, timeline);
        return backend;
      },
      onRevisionChange: (revision) => {
        timeline.push(`revision:${revision}`);
        if (revision === 1) {
          dispatcher.enqueue([{ face: 'U', turns: 1 }], command('b'));
          throw new Error('revision observer failed');
        }
      },
    });

    expect(() =>
      dispatcher.enqueue([{ face: 'R', turns: 1 }], command('a')),
    ).not.toThrow();

    expect(timeline).toEqual([
      'revision:1',
      'revision:2',
      'backend:enqueue:a',
      'backend:enqueue:b',
    ]);
    expect(backend.enqueueCommandIds).toEqual(['a', 'b']);
  });
});

describe('CommitDispatcher busy observation', () => {
  it('publishes acceptance and idle edges around the complete event lifecycle', () => {
    const initialState = createSolvedState();
    const timeline: string[] = [];
    let backend!: RecordingBackend;
    let dispatcher!: CommitDispatcher;
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new RecordingBackend(initialState, sink, timeline);
        return backend;
      },
      onRevisionChange: (revision) => timeline.push(`revision:${revision}`),
      onBusyChange: (isBusy) => timeline.push(`busy:${String(isBusy)}`),
      onDispatch: (event) => {
        expect(dispatcher.isBusy).toBe(true);
        timeline.push(`event:${label(event)}`);
      },
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], command('a'));
    expect(timeline).toEqual([
      'revision:1',
      'busy:true',
      'backend:enqueue:a',
    ]);

    backend.commitNext();
    expect(timeline).toEqual([
      'revision:1',
      'busy:true',
      'backend:enqueue:a',
      'event:batch:a',
      'event:end:a:completed',
      'busy:false',
    ]);
  });

  it('serializes work accepted by a false-edge callback without nesting busy events', () => {
    const initialState = createSolvedState();
    const timeline: string[] = [];
    let backend!: RecordingBackend;
    let dispatcher!: CommitDispatcher;
    let depth = 0;
    let maximumDepth = 0;
    let spawned = false;
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new RecordingBackend(initialState, sink, timeline);
        return backend;
      },
      onRevisionChange: (revision) => timeline.push(`revision:${revision}`),
      onBusyChange: (isBusy) => {
        depth += 1;
        maximumDepth = Math.max(maximumDepth, depth);
        timeline.push(`busy:${String(isBusy)}`);
        if (!isBusy && !spawned) {
          spawned = true;
          dispatcher.enqueue([{ face: 'U', turns: 1 }], command('b'));
        }
        depth -= 1;
      },
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], command('a'));
    backend.commitNext();

    expect(maximumDepth).toBe(1);
    expect(timeline).toEqual([
      'revision:1',
      'busy:true',
      'backend:enqueue:a',
      'busy:false',
      'revision:2',
      'busy:true',
      'backend:enqueue:b',
    ]);

    backend.commitNext();
    expect(timeline.at(-1)).toBe('busy:false');
    expect(dispatcher.isBusy).toBe(false);
  });
});

describe('CommitDispatcher fatal fact delivery', () => {
  it('delivers a committed batch to observers before failed ends and drops deferred work', () => {
    const initialState = createSolvedState();
    const timeline: string[] = [];
    const observerLabels: string[] = [];
    let backend!: RecordingBackend;
    let dispatcher!: CommitDispatcher;
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        backend = new RecordingBackend(initialState, sink, timeline);
        return backend;
      },
      onDispatch: (event) => {
        if ('changes' in event) throw new Error('authoritative reducer failed');
      },
    });
    dispatcher.subscribe((event) => {
      observerLabels.push(label(event));
      if (label(event) === 'batch:a') {
        dispatcher.enqueue([{ face: 'U', turns: 1 }], command('b'));
      }
    });

    dispatcher.enqueue([{ face: 'R', turns: 1 }], command('a'));
    backend.commitNext();

    expect(observerLabels).toEqual([
      'batch:a',
      'end:a:failed',
      'end:b:failed',
    ]);
    expect(backend.enqueueCommandIds).toEqual(['a']);
    expect(dispatcher.isFatal).toBe(true);
  });
});
