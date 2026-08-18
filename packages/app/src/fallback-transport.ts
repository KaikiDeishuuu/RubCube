import {
  applyMove,
  assertMove,
  assertValidState,
  cloneState,
  type CubeState,
  type Face,
} from '@rubcube/cube-core';
import type {
  CommitProvenance,
  DragCommitProvenance,
  MoveTransportBackend,
  MoveTransportBackendSink,
  QueuedMove,
} from '@rubcube/cube-render/transport';

export type CancelFallbackMacrotask = () => void;
export type ScheduleFallbackMacrotask = (
  task: () => void,
) => CancelFallbackMacrotask;

export interface FallbackMoveTransportBackendOptions {
  readonly initialState: CubeState;
  readonly sink: MoveTransportBackendSink;
  /** Injectable for deterministic tests; production defaults to setTimeout(0). */
  readonly scheduleMacrotask?: ScheduleFallbackMacrotask;
}

const FORWARD_ORIGINS: ReadonlySet<string> = new Set([
  'manual',
  'formula',
  'scramble',
  'tutorial',
  'auto-solve',
]);

function defaultScheduleMacrotask(task: () => void): CancelFallbackMacrotask {
  const handle = globalThis.setTimeout(task, 0);
  return () => globalThis.clearTimeout(handle);
}

function cloneProvenance(value: unknown): CommitProvenance {
  const candidate = value as Partial<{
    readonly commandId: unknown;
    readonly intent: unknown;
    readonly origin: unknown;
  }> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.commandId !== 'string' ||
    candidate.commandId.trim().length === 0
  ) {
    throw new TypeError('Fallback queued move has an invalid commandId');
  }

  if (
    candidate.intent === 'forward' &&
    typeof candidate.origin === 'string' &&
    FORWARD_ORIGINS.has(candidate.origin)
  ) {
    return {
      commandId: candidate.commandId,
      intent: 'forward',
      origin: candidate.origin as Exclude<
        CommitProvenance['origin'],
        'drag' | 'history'
      >,
    };
  }
  if (
    (candidate.intent === 'undo' || candidate.intent === 'rewind') &&
    candidate.origin === 'history'
  ) {
    return {
      commandId: candidate.commandId,
      intent: candidate.intent,
      origin: 'history',
    };
  }
  throw new TypeError('Fallback queued move has invalid intent/origin provenance');
}

function sameProvenance(
  left: CommitProvenance,
  right: CommitProvenance,
): boolean {
  return (
    left.commandId === right.commandId &&
    left.intent === right.intent &&
    left.origin === right.origin
  );
}

function cloneQueuedMoves(moves: readonly QueuedMove[]): QueuedMove[] {
  if (!Array.isArray(moves)) {
    throw new TypeError('Fallback backend moves must be an array');
  }
  const copies = moves.map((queued): QueuedMove => {
    if (typeof queued !== 'object' || queued === null) {
      throw new TypeError('Fallback backend received an invalid queued move');
    }
    assertMove(queued.move);
    return {
      move: { face: queued.move.face, turns: queued.move.turns },
      provenance: cloneProvenance(queued.provenance),
    };
  });

  const first = copies[0];
  if (
    first !== undefined &&
    copies.some((queued) => !sameProvenance(queued.provenance, first.provenance))
  ) {
    throw new Error('One fallback enqueue must contain exactly one command provenance');
  }
  if (first?.provenance.intent === 'undo' && copies.length !== 1) {
    throw new RangeError('A fallback undo command must contain exactly one move');
  }
  return copies;
}

/**
 * Animation-free MoveTransportBackend for the app's 2D facelet fallback.
 *
 * It deliberately commits at most one move per scheduled macrotask. The
 * dispatcher remains the sole owner of command completion, cancellation and
 * event ordering.
 */
export class FallbackMoveTransportBackend implements MoveTransportBackend {
  private readonly sink: MoveTransportBackendSink;
  private readonly scheduleMacrotask: ScheduleFallbackMacrotask;
  private readonly pending: QueuedMove[] = [];
  private readonly admittedCommandIds = new Set<string>();

  private currentState: CubeState;
  private cancelScheduledTask: CancelFallbackMacrotask | null = null;
  private scheduleGeneration = 0;
  private disposed = false;

  constructor(options: FallbackMoveTransportBackendOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('Fallback backend options are required');
    }
    assertValidState(options.initialState);
    if (
      typeof options.sink !== 'object' ||
      options.sink === null ||
      typeof options.sink.commit !== 'function' ||
      typeof options.sink.endCommand !== 'function' ||
      typeof options.sink.fail !== 'function'
    ) {
      throw new TypeError('Fallback backend requires a transport sink');
    }
    if (
      options.scheduleMacrotask !== undefined &&
      typeof options.scheduleMacrotask !== 'function'
    ) {
      throw new TypeError('scheduleMacrotask must be a function');
    }

    this.currentState = cloneState(options.initialState);
    this.sink = options.sink;
    this.scheduleMacrotask =
      options.scheduleMacrotask ?? defaultScheduleMacrotask;
  }

  get state(): CubeState {
    return cloneState(this.currentState);
  }

  get finalState(): CubeState {
    return cloneState(this.currentState);
  }

  get isBusy(): boolean {
    return this.pending.length > 0 || this.cancelScheduledTask !== null;
  }

  enqueue(moves: readonly QueuedMove[]): void {
    this.assertNotDisposed();
    const copies = cloneQueuedMoves(moves);
    if (copies.length === 0) return;

    const commandId = copies[0]!.provenance.commandId;
    if (this.admittedCommandIds.has(commandId)) {
      throw new Error(
        `Fallback backend commandId has already been queued: ${commandId}`,
      );
    }
    this.admittedCommandIds.add(commandId);
    this.pending.push(...copies);
  }

  beginInteractive(
    _face: Face,
    _provenance: DragCommitProvenance,
  ): boolean {
    this.assertNotDisposed();
    return false;
  }

  replaceState(state: CubeState): void {
    this.assertNotDisposed();
    assertValidState(state);
    const replacement = cloneState(state);
    this.discardPending();
    this.currentState = replacement;
    this.sink.commit(
      [{ state: cloneState(replacement), move: null }],
      cloneState(replacement),
    );
  }

  cancelPlayback(_reason: string): void {
    this.discardPending();
  }

  pump(): void {
    this.assertNotDisposed();
    if (this.pending.length === 0 || this.cancelScheduledTask !== null) return;

    const generation = this.scheduleGeneration;
    let schedulerReturned = false;
    let ranSynchronously = false;
    const cancel = this.scheduleMacrotask(() => {
      if (!schedulerReturned) {
        ranSynchronously = true;
        return;
      }
      if (generation !== this.scheduleGeneration) return;
      this.cancelScheduledTask = null;
      this.commitHead();
    });
    schedulerReturned = true;

    if (typeof cancel !== 'function') {
      this.scheduleGeneration += 1;
      throw new TypeError('scheduleMacrotask must return a cancellation function');
    }
    if (ranSynchronously) {
      this.scheduleGeneration += 1;
      cancel();
      throw new Error('Fallback scheduler must defer work to a macrotask');
    }
    this.cancelScheduledTask = cancel;
  }

  /** Idempotent React cleanup; unfinished commands fail through the dispatcher. */
  dispose(): void {
    if (this.disposed) return;
    const hadUnfinishedCommand = this.isBusy;
    this.disposed = true;
    let failure: unknown = new Error('Fallback backend disposed during playback');
    try {
      this.discardPending();
    } catch (error) {
      failure = error;
    }

    if (!hadUnfinishedCommand) return;
    try {
      this.sink.fail(failure);
    } catch {
      // Cleanup remains idempotent even for a foreign sink. CommitDispatcher's
      // sink does not throw and will deliver the command's unique failed end.
    }
  }

  private commitHead(): void {
    const queued = this.pending.shift();
    if (queued === undefined) return;

    try {
      this.currentState = applyMove(this.currentState, queued.move);
      const committedState = cloneState(this.currentState);
      this.sink.commit(
        [
          {
            state: committedState,
            move: { face: queued.move.face, turns: queued.move.turns },
            provenance: { ...queued.provenance },
          },
        ],
        cloneState(this.currentState),
      );
    } catch (error) {
      this.discardPending();
      try {
        this.sink.fail(error);
      } catch {
        // The shared dispatcher sink never throws. A foreign sink cannot be
        // allowed to leak an exception out of the scheduled macrotask.
      }
    }
  }

  private discardPending(): void {
    this.pending.length = 0;
    this.scheduleGeneration += 1;
    const cancel = this.cancelScheduledTask;
    this.cancelScheduledTask = null;
    cancel?.();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Fallback backend is disposed');
  }
}
