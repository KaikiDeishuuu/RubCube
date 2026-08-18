import {
  applyMove,
  assertMove,
  assertValidState,
  cloneState,
  isFace,
  oppositeFace,
  statesEqual,
  type CubeState,
  type Face,
  type Move,
} from '@rubcube/cube-core';

/**
 * Single source of truth for the command vocabulary.
 *
 * The types are derived from these arrays rather than declared alongside them,
 * so adding a value updates the type, every runtime allowlist, and the
 * exhaustiveness of both at once. Declaring the union separately let the two
 * drift silently: a new origin type-checked everywhere while all three runtime
 * allowlists still rejected it.
 */
export const COMMAND_INTENTS = Object.freeze([
  'forward',
  'undo',
  'rewind',
] as const);

export const MOVE_ORIGINS = Object.freeze([
  'manual',
  'drag',
  'formula',
  'scramble',
  'tutorial',
  'auto-solve',
  'history',
] as const);

export type CommandIntent = (typeof COMMAND_INTENTS)[number];

export type MoveOrigin = (typeof MOVE_ORIGINS)[number];

export type ForwardMoveOrigin = Exclude<MoveOrigin, 'history'>;

const COMMAND_INTENT_SET: ReadonlySet<string> = new Set<string>(COMMAND_INTENTS);
const MOVE_ORIGIN_SET: ReadonlySet<string> = new Set<string>(MOVE_ORIGINS);

export function isCommandIntent(value: unknown): value is CommandIntent {
  return typeof value === 'string' && COMMAND_INTENT_SET.has(value);
}

export function isMoveOrigin(value: unknown): value is MoveOrigin {
  return typeof value === 'string' && MOVE_ORIGIN_SET.has(value);
}

/** Every origin except `history`, which is reserved for undo/rewind intents. */
export function isForwardMoveOrigin(value: unknown): value is ForwardMoveOrigin {
  return isMoveOrigin(value) && value !== 'history';
}
export type EnqueueMoveOrigin = Exclude<ForwardMoveOrigin, 'drag'>;

export interface ForwardCommitProvenance {
  readonly commandId: string;
  readonly intent: 'forward';
  readonly origin: ForwardMoveOrigin;
}

export interface HistoryCommitProvenance {
  readonly commandId: string;
  readonly intent: 'undo' | 'rewind';
  readonly origin: 'history';
}

/** Provenance accepted by queued playback; pointer drags use beginInteractive. */
export type EnqueueCommitProvenance =
  | (ForwardCommitProvenance & { readonly origin: EnqueueMoveOrigin })
  | HistoryCommitProvenance;

/** Invalid intent/origin combinations are unrepresentable and rejected at runtime. */
export type CommitProvenance =
  | ForwardCommitProvenance
  | HistoryCommitProvenance;

export interface DragCommitProvenance {
  readonly commandId: string;
  readonly intent: 'forward';
  readonly origin: 'drag';
}

export interface QueuedMove {
  readonly move: Move;
  readonly provenance: CommitProvenance;
}

export interface MoveCubeStateChange {
  readonly state: CubeState;
  readonly move: Move;
  readonly provenance: CommitProvenance;
}

export interface ReplaceCubeStateChange {
  readonly state: CubeState;
  readonly move: null;
  readonly provenance?: never;
}

/** A move snapshot always has provenance; a replace snapshot never does. */
export type CubeStateChange = MoveCubeStateChange | ReplaceCubeStateChange;

export interface CommitBatch {
  readonly batchId: number;
  /** Ordered snapshots after each logical move, or one move:null replace snapshot. */
  readonly changes: readonly CubeStateChange[];
  readonly finalState: CubeState;
}

export type CommandEndStatus = 'completed' | 'cancelled' | 'failed';

export interface CommandEnd {
  readonly commandId: string;
  readonly status: CommandEndStatus;
  readonly committedMoves: number;
  readonly reason?: string;
}

export type DispatchEvent = CommitBatch | CommandEnd;

export type DispatchEventListener = (event: DispatchEvent) => void;

export type DispatchErrorSource =
  | 'authoritative'
  | 'observer'
  | 'transport';

export type DispatchErrorListener = (
  event: DispatchEvent,
  error: unknown,
  latestCommittedState: CubeState,
  source: DispatchErrorSource,
) => void;

export type RevisionChangeListener = (revision: number) => void;
export type BusyChangeListener = (isBusy: boolean) => void;

/** Public, renderer-independent playback surface used by the app. */
export interface MoveTransport {
  readonly isBusy: boolean;
  readonly commandRevision: number;
  enqueue(moves: readonly Move[], provenance: EnqueueCommitProvenance): boolean;
  beginInteractive(face: Face, provenance: DragCommitProvenance): boolean;
  replaceState(state: CubeState): void;
  cancelPlayback(reason: string): void;
}

/**
 * Facts reported by a concrete WebGL or fallback backend.
 *
 * The backend must update its own integer state before `commit`, and it must not
 * start or commit work from `enqueue`. `pump` is the sole start gate: the
 * dispatcher calls it only after its event/deferred FIFO is empty. `pump` may
 * start animation or schedule a macrotask, but must never synchronously call
 * `commit`, `endCommand`, or `fail` on its own stack.
 *
 * A zero-commit drag terminates through `endCommand(cancelled|failed)`. A
 * committed drag reports one move batch and is completed by the dispatcher;
 * an unknown ID is always a fatal backend protocol error.
 */
export interface MoveTransportBackendSink {
  commit(changes: readonly CubeStateChange[], finalState: CubeState): void;
  endCommand(commandId: string, status: CommandEndStatus, reason?: string): void;
  fail(reason: unknown): void;
}

/**
 * Adapter implemented by TurnAnimator and the 2D fallback in the next layer.
 *
 * `replaceState` must synchronously report exactly one move:null commit. Calls
 * made by the dispatcher to replace/cancel must not echo command-end events;
 * the dispatcher owns those terminal events and guarantees exactly-once delivery.
 * The factory must return the backend before that backend reports any sink event.
 */
export interface MoveTransportBackend {
  readonly isBusy: boolean;
  enqueue(moves: readonly QueuedMove[]): void;
  /** Admit but do not start the drag; `pump` remains the sole start gate. */
  beginInteractive(face: Face, provenance: DragCommitProvenance): boolean;
  replaceState(state: CubeState): void;
  cancelPlayback(reason: string): void;
  pump(): void;
}

export type MoveTransportBackendFactory = (
  sink: MoveTransportBackendSink,
) => MoveTransportBackend;

export interface CommitDispatcherOptions {
  readonly initialState: CubeState;
  /** Continue the app-wide timeline when rebuilding or switching backends. */
  readonly initialRevision?: number;
  readonly createBackend: MoveTransportBackendFactory;
  /** Reports externally observable busy edges; listener failures are isolated. */
  readonly onBusyChange?: BusyChangeListener;
  /**
   * Synchronously observes accepted operations before the backend can run.
   *
   * Listener failures are isolated. Reentrant operations are appended after
   * the operation whose revision is being reported, so this hook cannot
   * reorder the transport transaction FIFO.
   */
  readonly onRevisionChange?: RevisionChangeListener;
  /** The app's authoritative, atomic reducer. Throwing enters fatal mode. */
  readonly onDispatch?: DispatchEventListener;
  /** Diagnostics for authoritative and non-authoritative listener failures. */
  readonly onDispatchError?: DispatchErrorListener;
}

interface CommandRecord {
  readonly kind: 'queue' | 'drag';
  readonly provenance: CommitProvenance;
  readonly moves: readonly Move[];
  readonly dragFace: Face | null;
  readonly acceptedRevision: number;
  committedMoves: number;
  terminalScheduled: boolean;
  ended: boolean;
}

interface EnqueueOperation {
  readonly kind: 'enqueue';
  readonly commandId: string;
}

interface BeginInteractiveOperation {
  readonly kind: 'begin-interactive';
  readonly commandId: string;
}

interface ReplaceOperation {
  readonly kind: 'replace';
  readonly state: CubeState;
  readonly acceptedRevision: number;
}

interface CancelOperation {
  readonly kind: 'cancel';
  readonly reason: string;
  readonly acceptedRevision: number;
}

type DeferredOperation =
  | EnqueueOperation
  | BeginInteractiveOperation
  | ReplaceOperation
  | CancelOperation;

interface BatchWork {
  readonly kind: 'batch';
  readonly batch: CommitBatch;
}

interface CommittedFailureWork {
  readonly kind: 'committed-failure';
  readonly batch: CommitBatch;
  readonly reason: unknown;
}

interface CheckpointFailureWork {
  readonly kind: 'checkpoint-failure';
  readonly batch: CommitBatch;
  readonly reason: unknown;
}

interface EndWork {
  readonly kind: 'end';
  readonly commandId: string;
  readonly status: CommandEndStatus;
  readonly reason: string | undefined;
}

interface FailureWork {
  readonly kind: 'failure';
  readonly reason: unknown;
}

type WorkItem =
  | DeferredOperation
  | BatchWork
  | CommittedFailureWork
  | CheckpointFailureWork
  | EndWork
  | FailureWork;

function assertProvenance(value: unknown): asserts value is CommitProvenance {
  const candidate = value as Partial<{
    readonly commandId: unknown;
    readonly intent: unknown;
    readonly origin: unknown;
  }> | null;
  const validPair =
    (candidate?.intent === 'forward' && isForwardMoveOrigin(candidate.origin)) ||
    ((candidate?.intent === 'undo' || candidate?.intent === 'rewind') &&
      candidate.origin === 'history');
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.commandId !== 'string' ||
    candidate.commandId.trim().length === 0 ||
    !isCommandIntent(candidate.intent) ||
    !isMoveOrigin(candidate.origin) ||
    !validPair
  ) {
    throw new TypeError('Commit provenance has an invalid commandId, intent, or origin');
  }
}

function cloneMove(move: Move): Move {
  assertMove(move);
  return Object.freeze({ face: move.face, turns: move.turns });
}

function movesEqual(left: Move, right: Move): boolean {
  return left.face === right.face && left.turns === right.turns;
}

function cloneProvenance(provenance: CommitProvenance): CommitProvenance {
  assertProvenance(provenance);
  if (provenance.intent === 'forward') {
    return Object.freeze({
      commandId: provenance.commandId,
      intent: provenance.intent,
      origin: provenance.origin,
    });
  }
  return Object.freeze({
    commandId: provenance.commandId,
    intent: provenance.intent,
    origin: provenance.origin,
  });
}

function cloneDragProvenance(
  provenance: DragCommitProvenance,
): DragCommitProvenance {
  assertProvenance(provenance);
  if (provenance.intent !== 'forward' || provenance.origin !== 'drag') {
    throw new TypeError('Interactive provenance must be forward/drag');
  }
  return Object.freeze({
    commandId: provenance.commandId,
    intent: 'forward',
    origin: 'drag',
  });
}

function provenanceEqual(
  left: CommitProvenance,
  right: CommitProvenance,
): boolean {
  return (
    left.commandId === right.commandId &&
    left.intent === right.intent &&
    left.origin === right.origin
  );
}

function cloneChange(change: CubeStateChange): CubeStateChange {
  assertValidState(change.state);
  if (change.move === null) {
    if ('provenance' in change && change.provenance !== undefined) {
      throw new TypeError('A replace change cannot carry provenance');
    }
    return { state: cloneState(change.state), move: null };
  }

  return {
    state: cloneState(change.state),
    move: cloneMove(change.move),
    provenance: cloneProvenance(change.provenance),
  };
}

function cloneBatch(batch: CommitBatch): CommitBatch {
  return {
    batchId: batch.batchId,
    changes: batch.changes.map(cloneChange),
    finalState: cloneState(batch.finalState),
  };
}

function isCommitBatch(event: DispatchEvent): event is CommitBatch {
  return 'changes' in event;
}

function cloneEvent(event: DispatchEvent): DispatchEvent {
  if (isCommitBatch(event)) return cloneBatch(event);
  return event.reason === undefined
    ? {
        commandId: event.commandId,
        status: event.status,
        committedMoves: event.committedMoves,
      }
    : {
        commandId: event.commandId,
        status: event.status,
        committedMoves: event.committedMoves,
        reason: event.reason,
      };
}

function errorMessage(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const message: unknown = reason.message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  } catch {
    // Hostile Error subclasses/proxies may throw from prototype or property
    // access. Fatal cleanup must still finish and emit every terminal event.
  }
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'Move transport failed';
}

/**
 * Shared transaction coordinator for WebGL and fallback backends.
 *
 * It owns command identity, revision, event ordering, defensive delivery and
 * terminal status. A backend only reports committed facts through its sink.
 */
export class CommitDispatcher implements MoveTransport {
  private readonly backend: MoveTransportBackend;
  private readonly busyChangeListener: BusyChangeListener | undefined;
  private readonly revisionChangeListener: RevisionChangeListener | undefined;
  private readonly authoritativeListener: DispatchEventListener | undefined;
  private readonly dispatchErrorListener: DispatchErrorListener | undefined;
  private readonly observers = new Set<DispatchEventListener>();
  private readonly knownCommandIds = new Set<string>();
  private readonly liveCommands = new Map<string, CommandRecord>();
  private readonly workQueue: WorkItem[] = [];
  private readonly expectedReplacements: CubeState[] = [];

  private latestCommittedState: CubeState;
  private deferredDuringEvent: DeferredOperation[] | null = null;
  private nextBatchId = 1;
  private revision = 0;
  private draining = false;
  private dispatchingEvent = false;
  private fatal = false;
  private fatalCleaning = false;
  private pumping = false;
  private backendCommitSerial = 0;
  private revisionNotificationDepth = 0;
  private publishedBusy = false;
  private notifyingBusy = false;
  private requestedFatal: { readonly reason: unknown } | null = null;

  constructor(options: CommitDispatcherOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('CommitDispatcher options are required');
    }
    assertValidState(options.initialState);
    if (
      options.initialRevision !== undefined &&
      (!Number.isSafeInteger(options.initialRevision) || options.initialRevision < 0)
    ) {
      throw new RangeError('initialRevision must be a non-negative safe integer');
    }
    if (typeof options.createBackend !== 'function') {
      throw new TypeError('CommitDispatcher requires a backend factory');
    }
    if (
      options.onBusyChange !== undefined &&
      typeof options.onBusyChange !== 'function'
    ) {
      throw new TypeError('onBusyChange must be a function');
    }
    if (options.onDispatch !== undefined && typeof options.onDispatch !== 'function') {
      throw new TypeError('onDispatch must be a function');
    }
    if (
      options.onRevisionChange !== undefined &&
      typeof options.onRevisionChange !== 'function'
    ) {
      throw new TypeError('onRevisionChange must be a function');
    }
    if (
      options.onDispatchError !== undefined &&
      typeof options.onDispatchError !== 'function'
    ) {
      throw new TypeError('onDispatchError must be a function');
    }

    this.latestCommittedState = cloneState(options.initialState);
    this.revision = options.initialRevision ?? 0;
    this.busyChangeListener = options.onBusyChange;
    this.revisionChangeListener = options.onRevisionChange;
    this.authoritativeListener = options.onDispatch;
    this.dispatchErrorListener = options.onDispatchError;
    this.backend = options.createBackend(this.backendSink);
    if (
      typeof this.backend !== 'object' ||
      this.backend === null ||
      typeof this.backend.enqueue !== 'function' ||
      typeof this.backend.beginInteractive !== 'function' ||
      typeof this.backend.replaceState !== 'function' ||
      typeof this.backend.cancelPlayback !== 'function' ||
      typeof this.backend.pump !== 'function'
    ) {
      throw new TypeError('Backend factory returned an invalid move transport backend');
    }
  }

  get state(): CubeState {
    return cloneState(this.latestCommittedState);
  }

  get commandRevision(): number {
    return this.revision;
  }

  get isFatal(): boolean {
    return this.fatal;
  }

  get isBusy(): boolean {
    return this.computeBusy();
  }

  private computeBusy(): boolean {
    return (
      this.draining ||
      this.dispatchingEvent ||
      this.deferredDuringEvent !== null ||
      this.workQueue.length > 0 ||
      this.liveCommands.size > 0 ||
      this.backend.isBusy
    );
  }

  enqueue(
    moves: readonly Move[],
    provenance: EnqueueCommitProvenance,
  ): boolean {
    if (this.fatal) return false;
    if (!Array.isArray(moves)) throw new TypeError('moves must be an array');
    if (moves.length === 0) return false;

    const copiedMoves = Object.freeze(moves.map(cloneMove));
    const copiedProvenance = cloneProvenance(provenance);
    if (copiedProvenance.origin === 'drag') {
      throw new TypeError('Drag commands must use beginInteractive');
    }
    if (copiedProvenance.intent === 'undo' && copiedMoves.length !== 1) {
      throw new RangeError('An undo command must contain exactly one move');
    }
    if (this.knownCommandIds.has(copiedProvenance.commandId)) {
      throw new Error(`commandId has already been used: ${copiedProvenance.commandId}`);
    }

    const acceptedRevision = this.incrementRevision();
    const record: CommandRecord = {
      kind: 'queue',
      provenance: copiedProvenance,
      moves: copiedMoves,
      dragFace: null,
      acceptedRevision,
      committedMoves: 0,
      terminalScheduled: false,
      ended: false,
    };
    this.knownCommandIds.add(copiedProvenance.commandId);
    this.liveCommands.set(copiedProvenance.commandId, record);
    this.acceptOperation(
      { kind: 'enqueue', commandId: copiedProvenance.commandId },
      acceptedRevision,
    );
    return true;
  }

  beginInteractive(
    face: Face,
    provenance: DragCommitProvenance,
  ): boolean {
    // A physical pointer drag cannot wait behind playback or an event barrier.
    // Busy rejection is a true no-op: no ID reservation, revision, or end event.
    if (this.fatal || this.isBusy) return false;
    if (!isFace(face)) {
      throw new TypeError('Interactive face must be U, D, L, R, F, or B');
    }
    const copiedProvenance = cloneDragProvenance(provenance);
    if (this.knownCommandIds.has(copiedProvenance.commandId)) {
      throw new Error(`commandId has already been used: ${copiedProvenance.commandId}`);
    }

    const acceptedRevision = this.incrementRevision();
    const record: CommandRecord = {
      kind: 'drag',
      provenance: copiedProvenance,
      moves: Object.freeze([]),
      dragFace: face,
      acceptedRevision,
      committedMoves: 0,
      terminalScheduled: false,
      ended: false,
    };
    this.knownCommandIds.add(copiedProvenance.commandId);
    this.liveCommands.set(copiedProvenance.commandId, record);
    this.acceptOperation(
      {
        kind: 'begin-interactive',
        commandId: copiedProvenance.commandId,
      },
      acceptedRevision,
    );
    // The idle backend call runs synchronously. A backend refusal/throw is a
    // protocol failure and has already ended this accepted command as failed.
    return !record.ended && !this.fatal;
  }

  replaceState(state: CubeState): void {
    if (this.fatalCleaning) return;
    assertValidState(state);
    const replacement = cloneState(state);

    // An explicit valid replace is the only in-process recovery from fatal mode.
    if (this.fatal) this.fatal = false;
    const acceptedRevision = this.incrementRevision();
    this.acceptOperation(
      { kind: 'replace', state: replacement, acceptedRevision },
      acceptedRevision,
    );
  }

  cancelPlayback(reason: string): void {
    if (this.fatal) return;
    if (typeof reason !== 'string') throw new TypeError('cancel reason must be a string');
    const acceptedRevision = this.incrementRevision();
    this.acceptOperation(
      { kind: 'cancel', reason, acceptedRevision },
      acceptedRevision,
    );
  }

  /** Add a non-authoritative observer. Its errors are isolated and reported. */
  subscribe(observer: DispatchEventListener): () => void {
    if (typeof observer !== 'function') throw new TypeError('observer must be a function');
    this.observers.add(observer);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.observers.delete(observer);
    };
  }

  private readonly backendSink: MoveTransportBackendSink = {
    commit: (changes, finalState) => {
      if (this.fatal || this.fatalCleaning) return;
      let committedFinalState: CubeState | null = null;
      try {
        assertValidState(finalState);
        committedFinalState = cloneState(finalState);
        if (!Array.isArray(changes) || changes.length === 0) {
          throw new Error('A backend commit must contain at least one change');
        }
        const batch: CommitBatch = {
          batchId: this.nextBatchId,
          changes: changes.map(cloneChange),
          finalState: cloneState(committedFinalState),
        };
        this.nextBatchId += 1;
        this.backendCommitSerial += 1;
        this.enqueueWork(
          this.pumping
            ? {
                kind: 'committed-failure',
                batch,
                reason: new Error('Backend synchronously committed from pump'),
              }
            : { kind: 'batch', batch },
        );
      } catch (error) {
        if (committedFinalState === null) {
          this.enqueueWork({ kind: 'failure', reason: error });
          return;
        }

        // The backend has already advanced its integer timeline, but malformed
        // detail means we cannot safely attribute that state to logical moves.
        // Publish a diagnostic checkpoint before entering fatal mode so the app
        // and any replacement backend resume from the actual committed fact.
        const batch: CommitBatch = {
          batchId: this.nextBatchId,
          changes: [
            { state: cloneState(committedFinalState), move: null },
          ],
          finalState: cloneState(committedFinalState),
        };
        this.nextBatchId += 1;
        this.backendCommitSerial += 1;
        this.enqueueWork({ kind: 'checkpoint-failure', batch, reason: error });
      }
    },
    endCommand: (commandId, status, reason) => {
      if (this.fatal || this.fatalCleaning) return;
      if (this.pumping) {
        this.enqueueWork({
          kind: 'failure',
          reason: new Error('Backend synchronously ended a command from pump'),
        });
        return;
      }
      if (
        status !== 'completed' &&
        status !== 'cancelled' &&
        status !== 'failed'
      ) {
        this.enqueueWork({
          kind: 'failure',
          reason: new Error(`Backend reported invalid command status: ${String(status)}`),
        });
        return;
      }
      this.enqueueWork({ kind: 'end', commandId, status, reason });
    },
    fail: (reason) => {
      if (this.fatal || this.fatalCleaning) return;
      if (this.pumping) {
        this.enqueueWork({
          kind: 'failure',
          reason: new Error('Backend synchronously failed from pump'),
        });
        return;
      }
      this.enqueueWork({ kind: 'failure', reason });
    },
  };

  private incrementRevision(): number {
    if (this.revision >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('commandRevision exhausted the safe integer range');
    }
    this.revision += 1;
    return this.revision;
  }

  private acceptOperation(
    operation: DeferredOperation,
    acceptedRevision: number,
  ): void {
    if (this.dispatchingEvent) {
      if (this.deferredDuringEvent === null) {
        throw new Error('Dispatcher event barrier is not initialized');
      }
      this.deferredDuringEvent.push(operation);
    } else {
      // Stage the triggering operation before notifying. Reentrant operations
      // therefore append after it, but none can reach the backend until the
      // outermost synchronous revision notification has returned.
      this.workQueue.push(operation);
    }

    this.notifyRevisionChange(acceptedRevision);
    this.notifyBusyChange();
    if (
      !this.dispatchingEvent &&
      this.revisionNotificationDepth === 0 &&
      !this.notifyingBusy
    ) {
      this.drain();
    }
  }

  private notifyRevisionChange(revision: number): void {
    if (this.revisionChangeListener === undefined) return;
    this.revisionNotificationDepth += 1;
    try {
      try {
        this.revisionChangeListener(revision);
      } catch {
        // Revision observation is advisory and must not abort or reorder an
        // already accepted transport operation.
      }
    } finally {
      this.revisionNotificationDepth -= 1;
    }
  }

  private enqueueWork(work: WorkItem): void {
    this.workQueue.push(work);
    this.notifyBusyChange();
    if (
      !this.dispatchingEvent &&
      this.revisionNotificationDepth === 0 &&
      !this.notifyingBusy
    ) {
      this.drain();
    }
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.fatal && this.workQueue.length > 0) {
        const work = this.workQueue.shift()!;
        this.processWork(work);
      }

      if (!this.fatal) {
        try {
          this.pumping = true;
          this.backend.pump();
        } catch (error) {
          this.performFatalCleanup(error);
        } finally {
          this.pumping = false;
        }
        // A queued item here can only be a protocol failure reported by the
        // sink guard above; legitimate backend work resumes from a later tick/task.
        while (!this.fatal && this.workQueue.length > 0) {
          const work = this.workQueue.shift()!;
          this.processWork(work);
        }
      }
    } finally {
      this.draining = false;
    }
    this.notifyBusyChange();
    // A false-edge listener may synchronously accept another operation. It was
    // staged while notification was active, so start it only after the callback
    // and its resulting true edge have both returned.
    if (
      !this.fatal &&
      !this.dispatchingEvent &&
      this.revisionNotificationDepth === 0 &&
      !this.notifyingBusy &&
      this.workQueue.length > 0
    ) {
      this.drain();
    }
  }

  private notifyBusyChange(): void {
    if (this.busyChangeListener === undefined || this.notifyingBusy) return;
    this.notifyingBusy = true;
    try {
      // A listener may stage work. Recompute only after it returns so busy
      // callbacks never nest and every visible edge stays ordered.
      while (true) {
        const nextBusy = this.computeBusy();
        if (nextBusy === this.publishedBusy) break;
        this.publishedBusy = nextBusy;
        try {
          this.busyChangeListener(nextBusy);
        } catch {
          // Status mirroring is advisory and cannot abort accepted work.
        }
      }
    } finally {
      this.notifyingBusy = false;
    }
  }

  private processWork(work: WorkItem): void {
    switch (work.kind) {
      case 'enqueue':
        this.processEnqueue(work);
        return;
      case 'begin-interactive':
        this.processBeginInteractive(work);
        return;
      case 'replace':
        this.processReplace(work);
        return;
      case 'cancel':
        this.processCancel(work);
        return;
      case 'batch':
        this.processBatch(work.batch);
        return;
      case 'committed-failure':
        this.processBatch(work.batch, work.reason);
        return;
      case 'checkpoint-failure':
        this.processCheckpointFailure(work.batch, work.reason);
        return;
      case 'end':
        this.processEnd(work.commandId, work.status, work.reason);
        return;
      case 'failure':
        this.performFatalCleanup(work.reason);
    }
  }

  private processEnqueue(operation: EnqueueOperation): void {
    const record = this.liveCommands.get(operation.commandId);
    if (record === undefined || record.ended || record.terminalScheduled) return;
    const queued = record.moves.map((move): QueuedMove => ({
      move: cloneMove(move),
      provenance: cloneProvenance(record.provenance),
    }));
    try {
      this.backend.enqueue(queued);
    } catch (error) {
      this.performFatalCleanup(error);
    }
  }

  private processBeginInteractive(operation: BeginInteractiveOperation): void {
    const record = this.liveCommands.get(operation.commandId);
    if (
      record === undefined ||
      record.kind !== 'drag' ||
      record.dragFace === null ||
      record.ended ||
      record.terminalScheduled
    ) {
      return;
    }
    try {
      const accepted = this.backend.beginInteractive(
        record.dragFace,
        cloneDragProvenance(record.provenance as DragCommitProvenance),
      );
      if (!accepted) {
        record.terminalScheduled = true;
        this.workQueue.push({
          kind: 'end',
          commandId: operation.commandId,
          status: 'failed',
          reason: 'Backend rejected an accepted interactive command',
        });
      }
    } catch (error) {
      this.performFatalCleanup(error);
    }
  }

  private processReplace(operation: ReplaceOperation): void {
    this.scheduleCommandsThroughRevision(
      operation.acceptedRevision,
      'cancelled',
      'State replaced',
    );
    const commitSerial = this.backendCommitSerial;
    this.expectedReplacements.push(cloneState(operation.state));
    try {
      this.backend.replaceState(cloneState(operation.state));
      if (this.backendCommitSerial === commitSerial) {
        throw new Error('Backend replaceState did not synchronously report a replace batch');
      }
    } catch (error) {
      this.performFatalCleanup(error);
    }
  }

  private processCancel(operation: CancelOperation): void {
    try {
      this.backend.cancelPlayback(operation.reason);
    } catch (error) {
      this.performFatalCleanup(error);
      return;
    }
    this.scheduleCommandsThroughRevision(
      operation.acceptedRevision,
      'cancelled',
      operation.reason,
    );
  }

  private scheduleCommandsThroughRevision(
    revision: number,
    status: CommandEndStatus,
    reason: string,
  ): void {
    for (const [commandId, record] of this.liveCommands) {
      if (
        record.ended ||
        record.terminalScheduled ||
        record.acceptedRevision >= revision
      ) {
        continue;
      }
      record.terminalScheduled = true;
      this.workQueue.push({ kind: 'end', commandId, status, reason });
    }
  }

  private processBatch(
    batch: CommitBatch,
    committedProtocolFailure: unknown | null = null,
  ): void {
    let completedCommandId: string | null;
    let fatalReason = committedProtocolFailure;
    let transportErrorToReport: unknown | null = null;
    try {
      completedCommandId = this.acceptCommittedBatch(batch);
    } catch (error) {
      // The backend reports only after its integer state has committed. Even a
      // malformed transaction cannot be rolled back, so fatal diagnostics must
      // checkpoint the actual backend final state rather than the prior prefix.
      this.latestCommittedState = cloneState(batch.finalState);
      transportErrorToReport = error;
      completedCommandId = null;
      fatalReason = error;
    }

    if (
      committedProtocolFailure !== null &&
      fatalReason === committedProtocolFailure
    ) {
      transportErrorToReport = committedProtocolFailure;
    }

    const deferred: DeferredOperation[] = [];
    this.deferredDuringEvent = deferred;
    const delivered = this.deliverEvent(batch, false);
    // Publish the committed fact first, then surface its protocol failure. In
    // particular, a structurally valid but wrong replace batch must not clear
    // the fatal checkpoint that this diagnostic establishes.
    if (transportErrorToReport !== null) {
      this.reportDispatchError(batch, transportErrorToReport, 'transport');
    }
    // A committed protocol failure publishes the batch fact but deliberately
    // suppresses completed; fatal cleanup owns this command's unique failed end.
    if (fatalReason === null && delivered && completedCommandId !== null) {
      this.dispatchEndNow(completedCommandId, 'completed', undefined, false);
    }
    this.deferredDuringEvent = null;

    if (fatalReason !== null || !delivered || this.requestedFatal !== null) {
      const dispatchFailure = this.requestedFatal === null
        ? null
        : this.takeRequestedFatal();
      this.performFatalCleanup(fatalReason ?? dispatchFailure);
      return;
    }
    if (this.fatal) return;
    this.workQueue.push(...deferred);
  }

  /**
   * Preserve a backend's valid final integer state when its per-move detail is
   * too malformed to validate or publish. The synthetic replace is diagnostic:
   * it deliberately resets provenance history to a consistent checkpoint, then
   * the transport error makes the dispatcher unusable until explicit recovery.
   */
  private processCheckpointFailure(batch: CommitBatch, reason: unknown): void {
    this.latestCommittedState = cloneState(batch.finalState);

    const deferred: DeferredOperation[] = [];
    this.deferredDuringEvent = deferred;
    this.deliverEvent(batch, false);
    this.reportDispatchError(batch, reason, 'transport');
    this.deferredDuringEvent = null;

    // Clear a requested authoritative failure as well. The transport protocol
    // error remains the root cause, while all commands accepted by either the
    // batch or diagnostic callbacks still receive their unique failed end.
    if (this.requestedFatal !== null) this.takeRequestedFatal();
    this.performFatalCleanup(reason);
  }

  /**
   * Validate the backend's report against the accepted command stream, then
   * atomically advance dispatcher state and counters. Returns a completed ID.
   */
  private acceptCommittedBatch(batch: CommitBatch): string | null {
    if (batch.changes.length === 0) {
      throw new Error('CommitBatch cannot be empty');
    }
    assertValidState(batch.finalState);

    const replace = batch.changes[0]!.move === null;
    if (replace) {
      if (batch.changes.length !== 1 || batch.changes[0]!.move !== null) {
        throw new Error('A replace batch must contain exactly one move:null change');
      }
      const change = batch.changes[0]!;
      assertValidState(change.state);
      if (!statesEqual(change.state, batch.finalState)) {
        throw new Error('Replace batch finalState does not equal its change state');
      }
      const expectedReplacement = this.expectedReplacements.shift();
      if (
        expectedReplacement === undefined ||
        !statesEqual(expectedReplacement, batch.finalState)
      ) {
        throw new Error('Backend replace batch does not match the requested state');
      }
      this.latestCommittedState = cloneState(batch.finalState);
      return null;
    }

    if (batch.changes.some((change) => change.move === null)) {
      throw new Error('A move batch cannot mix move and replace changes');
    }

    const moveChanges = batch.changes as readonly MoveCubeStateChange[];
    if (moveChanges.length > 2) {
      throw new Error('A move CommitBatch can contain at most two changes');
    }
    const commandId = moveChanges[0]!.provenance.commandId;
    const record = this.liveCommands.get(commandId);
    if (record === undefined || record.ended || record.terminalScheduled) {
      throw new Error(`Backend committed an unknown or ended command: ${commandId}`);
    }
    if (moveChanges.some((change) => change.provenance.commandId !== commandId)) {
      throw new Error('One CommitBatch cannot contain multiple commandIds');
    }
    const oldestCommandId = this.liveCommands.keys().next().value as
      | string
      | undefined;
    if (oldestCommandId !== commandId) {
      throw new Error(
        `Backend committed command ${commandId} before ${String(oldestCommandId)}`,
      );
    }
    if (
      moveChanges.length === 2 &&
      oppositeFace(moveChanges[0]!.move.face) !== moveChanges[1]!.move.face
    ) {
      throw new Error('A two-move CommitBatch must contain opposite layers');
    }
    if (record.kind === 'drag') {
      if (
        moveChanges.length !== 1 ||
        record.committedMoves !== 0 ||
        moveChanges[0]!.move.face !== record.dragFace ||
        moveChanges[0]!.move.turns === 2
      ) {
        throw new Error(`Backend reported an invalid drag commit: ${commandId}`);
      }
    } else if (record.committedMoves + moveChanges.length > record.moves.length) {
      throw new Error(`Backend over-committed command: ${commandId}`);
    }

    let expectedState = cloneState(this.latestCommittedState);
    for (let index = 0; index < moveChanges.length; index += 1) {
      const change = moveChanges[index]!;
      assertValidState(change.state);
      assertProvenance(change.provenance);
      assertMove(change.move);
      const expectedMove = record.kind === 'drag'
        ? change.move
        : record.moves[record.committedMoves + index]!;
      if (
        (record.kind === 'queue' && !movesEqual(change.move, expectedMove)) ||
        !provenanceEqual(change.provenance, record.provenance)
      ) {
        throw new Error(`Backend commit does not match accepted command: ${commandId}`);
      }
      expectedState = applyMove(expectedState, expectedMove);
      if (!statesEqual(expectedState, change.state)) {
        throw new Error(`Backend reported an invalid state snapshot for command: ${commandId}`);
      }
    }
    if (!statesEqual(expectedState, batch.finalState)) {
      throw new Error(`CommitBatch finalState is invalid for command: ${commandId}`);
    }

    record.committedMoves += moveChanges.length;
    this.latestCommittedState = cloneState(batch.finalState);
    return this.commandIsComplete(record) ? commandId : null;
  }

  private processEnd(
    commandId: string,
    status: CommandEndStatus,
    reason: string | undefined,
  ): void {
    const record = this.liveCommands.get(commandId);
    if (record === undefined) {
      if (!this.knownCommandIds.has(commandId)) {
        this.performFatalCleanup(
          new Error(`Backend ended an unknown command: ${commandId}`),
        );
      }
      return;
    }
    if (record.ended) return;
    if (status === 'completed' && !this.commandIsComplete(record)) {
      this.performFatalCleanup(
        new Error(`Backend completed command before all moves committed: ${commandId}`),
      );
      return;
    }

    const deferred: DeferredOperation[] = [];
    this.deferredDuringEvent = deferred;
    this.dispatchEndNow(commandId, status, reason, false);
    this.deferredDuringEvent = null;
    if (this.requestedFatal !== null) {
      this.performFatalCleanup(this.takeRequestedFatal());
      return;
    }
    if (this.fatal) return;
    this.workQueue.push(...deferred);
  }

  private commandIsComplete(record: CommandRecord): boolean {
    return record.kind === 'drag'
      ? record.committedMoves === 1
      : record.committedMoves === record.moves.length;
  }

  private dispatchEndNow(
    commandId: string,
    status: CommandEndStatus,
    reason: string | undefined,
    fatalCleanup: boolean,
  ): void {
    const record = this.liveCommands.get(commandId);
    if (record === undefined || record.ended) return;

    // Mark before invoking the handler: if it throws, this end must never be sent twice.
    record.ended = true;
    record.terminalScheduled = true;
    this.liveCommands.delete(commandId);
    const event: CommandEnd = reason === undefined
      ? { commandId, status, committedMoves: record.committedMoves }
      : { commandId, status, committedMoves: record.committedMoves, reason };
    this.deliverEvent(event, fatalCleanup);
  }

  private deliverEvent(event: DispatchEvent, fatalCleanup: boolean): boolean {
    const observerSnapshot = [...this.observers];
    let authoritativeSucceeded = true;
    this.dispatchingEvent = true;
    try {
      if (this.authoritativeListener !== undefined) {
        try {
          this.authoritativeListener(cloneEvent(event));
        } catch (error) {
          this.reportDispatchError(event, error, 'authoritative');
          authoritativeSucceeded = false;
          if (!fatalCleanup) {
            this.requestedFatal ??= { reason: error };
          }
        }
      }

      for (const observer of observerSnapshot) {
        try {
          observer(cloneEvent(event));
        } catch (error) {
          this.reportDispatchError(event, error, 'observer');
        }
      }
      return authoritativeSucceeded;
    } finally {
      this.dispatchingEvent = false;
    }
  }

  private reportDispatchError(
    event: DispatchEvent,
    error: unknown,
    source: DispatchErrorSource,
  ): void {
    if (this.dispatchErrorListener === undefined) return;
    try {
      this.dispatchErrorListener(
        cloneEvent(event),
        error,
        cloneState(this.latestCommittedState),
        source,
      );
    } catch {
      // Diagnostics must never recurse into, or replace, the original failure.
    }
  }

  private takeRequestedFatal(): unknown {
    const requested = this.requestedFatal;
    this.requestedFatal = null;
    return requested?.reason ?? new Error('Authoritative dispatch failed');
  }

  private performFatalCleanup(reason: unknown): void {
    if (this.fatalCleaning) return;
    this.fatal = true;
    this.fatalCleaning = true;
    this.workQueue.length = 0;
    this.expectedReplacements.length = 0;
    this.deferredDuringEvent?.splice(0);

    try {
      try {
        this.backend.cancelPlayback(`Fatal transport error: ${errorMessage(reason)}`);
      } catch {
        // The backend is already unusable; terminal delivery below is still required.
      }

      const unfinished = [...this.liveCommands.keys()];
      for (const commandId of unfinished) {
        this.dispatchEndNow(commandId, 'failed', errorMessage(reason), true);
      }
    } finally {
      this.fatalCleaning = false;
    }
  }
}
