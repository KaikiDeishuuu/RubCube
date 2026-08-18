import {
  applyMove,
  assertMove,
  assertValidState,
  cloneState,
  isLayer,
  isSlice,
  layersAreDisjoint,
  parseMoves,
  type CubeState,
  type Layer,
  type Move,
} from '@rubcube/cube-core';
import { Group, type Object3D, type Vector3 } from 'three';

import { layerNormal } from './layout.js';
import { isForwardMoveOrigin } from './transport.js';
import type {
  CommitProvenance,
  DragCommitProvenance,
  MoveCubeStateChange,
  MoveTransportBackend,
  MoveTransportBackendSink,
  QueuedMove,
} from './transport.js';
import type {
  CubeStateChange as LegacyCubeStateChange,
  CubeStateChangeListener,
  CubieVisual,
} from './types.js';

const QUARTER_TURN = Math.PI / 2;
const SNAP_THRESHOLD = Math.PI / 6;
const BASE_DURATION_SECONDS = 0.12;

/**
 * Cap on layers turning at once, not a geometric limit.
 *
 * With face turns alone only opposite faces were disjoint, so two was all the
 * cube allowed. Slices break that: R, M and L are pairwise disjoint, so three
 * are now possible. Two stays the cap until a third pivot earns its keep.
 */
const MAX_CONCURRENT_LAYERS = 2;

/** Opening speed of DESIGN.md 4.3's easeOutQuad, in progress per duration. */
const IMPULSE_VELOCITY = 2;
/** Hermite with this at both ends is exactly linear: no seam between turns. */
const CRUISE_VELOCITY = 1;
/** A drag sample older than this means the finger had already come to rest. */
const DRAG_VELOCITY_WINDOW_SECONDS = 0.05;

export interface TurnAnimatorOptions {
  /** Rebuild every cubie transform from this authoritative integer state. */
  readonly syncVisuals: (state: CubeState) => void;
  /** Canonical transaction sink. When present, pump is the only start gate. */
  readonly transportSink?: MoveTransportBackendSink;
  /** @deprecated Transitional callback for the pre-transport renderer facade. */
  readonly onStateChange?: CubeStateChangeListener;
  /** Complete each timed turn on its next tick. */
  readonly reducedMotion?: boolean;
}

type ActiveMode = 'queue' | 'interactive' | 'settling';

interface ActiveLayer {
  readonly face: Layer;
  /** Offset along `axis` that a cubie must sit at to belong to this layer. */
  readonly slab: 0 | 1;
  readonly axis: Vector3;
  readonly pivot: Group;
  move: Move | null;
  provenance: CommitProvenance | null;
  startAngle: number;
  targetAngle: number;
  angle: number;
}

/**
 * One or two layers that start and finish on the same tick.
 *
 * Sharing one clock is what makes DESIGN.md 4.4's concurrent turns safe. A
 * group never commits one move while another layer is still parented to a
 * pivot, so the moves always apply in queue order and `syncVisuals` only ever
 * runs with all 26 cubies back under the scene.
 */
interface ActiveGroup {
  mode: ActiveMode;
  readonly layers: readonly ActiveLayer[];
  readonly source: 'queue' | 'drag';
  elapsed: number;
  duration: number;
  entryVelocity: number;
  exitVelocity: number;
  /** Drag only: rad/s, plus the anchor sample it was measured against. */
  dragVelocity: number;
  sampleAngle: number;
  sampleTime: number;
}

interface PendingInteractive {
  readonly face: Layer;
  readonly provenance: DragCommitProvenance;
}

function cloneProvenance(provenance: CommitProvenance): CommitProvenance {
  const candidate = provenance as Partial<CommitProvenance> | null;
  const valid =
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.commandId === 'string' &&
    candidate.commandId.trim().length > 0 &&
    ((candidate.intent === 'forward' && isForwardMoveOrigin(candidate.origin)) ||
      ((candidate.intent === 'undo' || candidate.intent === 'rewind') &&
        candidate.origin === 'history'));
  if (!valid) {
    throw new TypeError('Queued move provenance is invalid');
  }
  return Object.freeze({
    commandId: candidate.commandId!,
    intent: candidate.intent!,
    origin: candidate.origin!,
  }) as CommitProvenance;
}

function cloneDragProvenance(
  provenance: DragCommitProvenance,
): DragCommitProvenance {
  const copied = cloneProvenance(provenance);
  if (copied.intent !== 'forward' || copied.origin !== 'drag') {
    throw new TypeError('Interactive provenance must be forward/drag');
  }
  return copied as DragCommitProvenance;
}

function cloneQueuedMove(queued: QueuedMove): QueuedMove {
  if (typeof queued !== 'object' || queued === null) {
    throw new TypeError('Queued move must be an object');
  }
  assertMove(queued.move);
  const provenance = cloneProvenance(queued.provenance);
  if (provenance.origin === 'drag') {
    throw new TypeError('Drag commands must use beginInteractive');
  }
  return Object.freeze({
    move: Object.freeze({ face: queued.move.face, turns: queued.move.turns }),
    provenance,
  });
}

function isQueuedMove(value: Move | QueuedMove): value is QueuedMove {
  return typeof value === 'object' && value !== null && 'move' in value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Cubic Hermite on [0, 1] with e(0) = 0, e(1) = 1 and the given end velocities.
 *
 * (2, 0) reproduces DESIGN.md 4.3's easeOutQuad exactly, and (1, 1) collapses
 * to the identity. So an isolated turn still snaps and settles, while a turn
 * with neighbours on both sides cruises through at constant angular velocity
 * instead of braking to a standstill at every seam. Both end velocities stay
 * within [0, IMPULSE_VELOCITY], which is exactly the range where the curve is
 * monotonic: above it the layer would visibly overshoot its own target.
 */
function hermiteEase(progress: number, entry: number, exit: number): number {
  const squared = progress * progress;
  const cubed = squared * progress;
  return (
    entry * (cubed - 2 * squared + progress) +
    (3 * squared - 2 * cubed) +
    exit * (cubed - squared)
  );
}

function moveAngle(move: Move): number {
  if (move.turns === 3) return QUARTER_TURN;
  if (move.turns === 2) return -Math.PI;
  return -QUARTER_TURN;
}

/**
 * DESIGN.md 4.3's queue-depth curve, scaled by how far the layer has to travel.
 *
 * A half turn sweeps twice the angle of a quarter turn, so charging both the
 * same duration spins it at twice the angular velocity. The square root keeps a
 * 180 quicker per degree than a 90 without making it feel sluggish.
 */
function queuedTurnDuration(depth: number, angle: number): number {
  return (
    BASE_DURATION_SECONDS *
    clamp(1 - 0.12 * (depth - 1), 0.45, 1) *
    Math.sqrt(Math.abs(angle) / QUARTER_TURN)
  );
}

/**
 * The drag's angular velocity restated in the settle's progress units, so a
 * flick continues at the speed the finger left it at. A stale anchor means the
 * finger had stopped and the snap should start from rest instead.
 */
function releaseEntryVelocity(
  group: ActiveGroup,
  sweep: number,
  duration: number,
): number {
  if (duration <= 0 || sweep === 0) return 0;
  if (group.elapsed - group.sampleTime >= DRAG_VELOCITY_WINDOW_SECONDS) return 0;

  // Dividing by the signed sweep folds direction in: a finger still moving away
  // from the snap target yields a negative value and clamps back to rest.
  return clamp((group.dragVelocity / sweep) * duration, 0, IMPULSE_VELOCITY);
}

function resetPivot(pivot: Group): void {
  pivot.position.set(0, 0, 0);
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  pivot.updateMatrix();
}

/**
 * Owns the transient pivot transforms while keeping CubeState authoritative.
 *
 * `queueLength` includes the queued moves currently being animated. `state`
 * always returns a deep snapshot, so callers cannot mutate the animator's
 * integer state behind its back.
 */
export class TurnAnimator implements MoveTransportBackend {
  private readonly pivots: readonly Group[];
  private readonly queue: QueuedMove[] = [];
  private readonly syncVisuals: (state: CubeState) => void;
  private readonly transportSink: MoveTransportBackendSink | undefined;
  private readonly onStateChange: CubeStateChangeListener | undefined;
  private readonly reducedMotion: boolean;

  private cubeState: CubeState;
  private active: ActiveGroup | null = null;
  private pendingInteractive: PendingInteractive | null = null;
  /** Whether the group that just finished handed off at cruise speed. */
  private chainedEntry = false;
  private legacyCommandSerial = 0;
  private disposed = false;

  constructor(
    private readonly scene: Object3D,
    private readonly cubies: readonly CubieVisual[],
    initialState: CubeState,
    options: TurnAnimatorOptions,
  ) {
    assertValidState(initialState);
    if (typeof options?.syncVisuals !== 'function') {
      throw new TypeError('TurnAnimator requires a syncVisuals callback');
    }

    this.cubeState = cloneState(initialState);
    this.syncVisuals = options.syncVisuals;
    this.transportSink = options.transportSink;
    this.onStateChange = options.onStateChange;
    this.reducedMotion = options.reducedMotion === true;
    this.pivots = Object.freeze(
      Array.from({ length: MAX_CONCURRENT_LAYERS }, (_unused, index) => {
        const pivot = new Group();
        pivot.name = `rubcube-turn-pivot-${index}`;
        return pivot;
      }),
    );

    this.syncFromIntegerState();
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  get isBusy(): boolean {
    return (
      this.active !== null ||
      this.pendingInteractive !== null ||
      this.queue.length > 0
    );
  }

  get queueLength(): number {
    return (
      this.queue.length +
      (this.active !== null && this.active.mode === 'queue'
        ? this.active.layers.length
        : 0)
    );
  }

  get state(): CubeState {
    return cloneState(this.cubeState);
  }

  enqueue(moves: readonly QueuedMove[]): void;
  /** @deprecated Transitional pre-transport overload. */
  enqueue(sequence: string | readonly Move[]): void;
  enqueue(
    sequence: string | readonly Move[] | readonly QueuedMove[],
  ): void {
    this.assertNotDisposed();

    const values = typeof sequence === 'string' ? parseMoves(sequence) : sequence;
    const copies: QueuedMove[] = [];
    const canonicalInput = values.length > 0 && isQueuedMove(values[0]!);
    if (this.transportSink !== undefined && values.length > 0 && !canonicalInput) {
      throw new TypeError('A transport-backed animator requires QueuedMove input');
    }

    if (canonicalInput) {
      for (const queued of values as readonly QueuedMove[]) {
        copies.push(cloneQueuedMove(queued));
      }
    } else {
      this.legacyCommandSerial += 1;
      const provenance: CommitProvenance = Object.freeze({
        commandId: `legacy-queue-${this.legacyCommandSerial}`,
        intent: 'forward',
        origin: 'manual',
      });
      for (const move of values as readonly Move[]) {
        assertMove(move);
        copies.push(Object.freeze({
          move: Object.freeze({ face: move.face, turns: move.turns }),
          provenance,
        }));
      }
    }

    if (copies.length === 0) return;
    this.queue.push(...copies);
    if (this.transportSink === undefined) this.pump();
  }

  /**
   * Advance time-based animation. Returns true when a turn was active during
   * this call (including the frame that completes it), otherwise false.
   */
  tick(deltaSeconds: number): boolean {
    if (this.disposed) return false;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('deltaSeconds must be a finite, non-negative number');
    }

    if (this.active === null) return false;

    let remaining = deltaSeconds;
    let hadActiveTurn = false;

    while (this.active !== null) {
      const group = this.active;
      hadActiveTurn = true;

      if (group.mode === 'interactive') {
        // The finger owns the angle, but the clock still has to run:
        // releaseInteractive reads it back to tell a flick from a finger that
        // had already stopped moving.
        group.elapsed += remaining;
        break;
      }

      const timeToEnd = Math.max(0, group.duration - group.elapsed);
      const consumed = Math.min(remaining, timeToEnd);
      group.elapsed += consumed;
      remaining -= consumed;

      const progress =
        group.duration === 0 ? 1 : clamp(group.elapsed / group.duration, 0, 1);
      const eased = hermiteEase(
        progress,
        group.entryVelocity,
        group.exitVelocity,
      );
      for (const layer of group.layers) {
        layer.angle =
          layer.startAngle + (layer.targetAngle - layer.startAngle) * eased;
        this.setPivotAngle(layer);
      }

      if (progress < 1) break;

      // finishGroup starts whatever is next, so the loop condition alone
      // carries the leftover time into it.
      this.finishGroup(group);

      // Reduced motion means one committed/cancelled turn per rendered frame.
      if (this.reducedMotion) break;
      if (remaining <= 0) break;
    }

    return hadActiveTurn;
  }

  /** Cancel all transient work and atomically display a new valid state. */
  replaceState(state: CubeState): void {
    this.assertNotDisposed();
    // Validate and clone before disturbing an animation. Invalid input is a
    // no-op with respect to the current pivots and queue.
    assertValidState(state);
    const replacement = cloneState(state);

    this.queue.length = 0;
    this.pendingInteractive = null;
    this.abortActiveVisual(false);
    this.cubeState = replacement;
    this.syncFromIntegerState();
    if (this.transportSink === undefined) {
      this.emitLegacyStateChange(null, 'replace');
    } else {
      const snapshot = cloneState(this.cubeState);
      this.transportSink.commit(
        [{ state: cloneState(snapshot), move: null }],
        snapshot,
      );
    }
  }

  beginInteractive(
    face: Layer,
    provenance: DragCommitProvenance,
  ): boolean;
  /** @deprecated Transitional pre-transport overload. */
  beginInteractive(face: Layer): boolean;
  beginInteractive(
    face: Layer,
    provenance?: DragCommitProvenance,
  ): boolean {
    if (
      this.disposed ||
      this.active !== null ||
      this.pendingInteractive !== null ||
      this.queue.length > 0
    ) {
      return false;
    }
    if (!isLayer(face)) {
      throw new TypeError('Interactive turn layer must be one of U/D/L/R/F/B/M/E/S');
    }
    if (this.transportSink !== undefined && provenance === undefined) {
      throw new TypeError('A transport-backed drag requires provenance');
    }

    this.legacyCommandSerial += 1;
    this.pendingInteractive = {
      face,
      provenance: provenance === undefined
        ? {
            commandId: `legacy-drag-${this.legacyCommandSerial}`,
            intent: 'forward',
            origin: 'drag',
          }
        : cloneDragProvenance(provenance),
    };
    if (this.transportSink === undefined) this.pump();
    return true;
  }

  /** The sole canonical gate that may attach a queued or interactive layer. */
  pump(): void {
    if (this.disposed || this.active !== null) return;
    const interactive = this.pendingInteractive;
    if (interactive !== null) {
      this.pendingInteractive = null;
      const layers = [this.createLayer(interactive.face, 0)];
      layers[0]!.provenance = interactive.provenance;
      this.attachLayers(layers);
      this.active = {
        mode: 'interactive',
        layers,
        source: 'drag',
        elapsed: 0,
        duration: 0,
        entryVelocity: 0,
        exitVelocity: 0,
        dragVelocity: 0,
        sampleAngle: 0,
        sampleTime: 0,
      };
      return;
    }
    this.startQueuedTurns();
  }

  setInteractiveAngle(radians: number): void {
    if (!Number.isFinite(radians)) {
      throw new RangeError('Interactive angle must be finite');
    }
    const group = this.active;
    if (group === null || group.mode !== 'interactive') return;

    const layer = group.layers[0]!;
    const angle = clamp(radians, -QUARTER_TURN, QUARTER_TURN);
    layer.angle = angle;
    this.setPivotAngle(layer);

    // Re-anchor on a fixed window rather than per event. A pointermove landing
    // 2ms after the last one gives a meaningless derivative, and a finger that
    // stops moving stops re-anchoring entirely, which is precisely the signal
    // releaseInteractive needs to tell a flick from a deliberate hold.
    const span = group.elapsed - group.sampleTime;
    if (span >= DRAG_VELOCITY_WINDOW_SECONDS) {
      group.dragVelocity = (angle - group.sampleAngle) / span;
      group.sampleAngle = angle;
      group.sampleTime = group.elapsed;
    }
  }

  /**
   * Snap a drag back below 30 degrees, otherwise to +/- 90 degrees. Positive
   * angles commit an inverse move because clockwise is negative around the
   * outward face normal.
   */
  releaseInteractive(): boolean {
    const group = this.active;
    if (group === null || group.mode !== 'interactive') return false;

    const layer = group.layers[0]!;
    const shouldCommit = Math.abs(layer.angle) >= SNAP_THRESHOLD;
    const targetAngle = shouldCommit
      ? Math.sign(layer.angle) * QUARTER_TURN
      : 0;
    const move: Move | null = shouldCommit
      ? {
          face: layer.face,
          turns: targetAngle < 0 ? 1 : 3,
        }
      : null;
    const sweep = targetAngle - layer.angle;
    const duration = this.reducedMotion
      ? 0
      : BASE_DURATION_SECONDS * (Math.abs(sweep) / QUARTER_TURN);

    group.mode = 'settling';
    layer.move = move;
    layer.startAngle = layer.angle;
    layer.targetAngle = targetAngle;
    group.duration = duration;
    // Carry the finger's speed into the snap before resetting the clock:
    // starting from rest while the layer was still moving reads as a hitch, and
    // starting at full speed after the finger stopped reads as a kick.
    group.entryVelocity = releaseEntryVelocity(group, sweep, duration);
    group.exitVelocity = 0;
    group.elapsed = 0;
    return true;
  }

  /** Immediately abandon a drag or its pending snap without changing state. */
  cancelInteractive(): boolean {
    if (this.pendingInteractive !== null) {
      const { provenance } = this.pendingInteractive;
      this.pendingInteractive = null;
      this.transportSink?.endCommand(
        provenance.commandId,
        'cancelled',
        'Interactive turn cancelled',
      );
      return true;
    }
    if (
      this.active === null ||
      (this.active.mode !== 'interactive' && this.active.mode !== 'settling')
    ) {
      return false;
    }

    const provenance = this.active.layers[0]!.provenance;
    this.abortActiveVisual(true);
    if (this.transportSink !== undefined) {
      // Fail loudly rather than degrading to the legacy path. Self-pumping here
      // would start the next group outside the dispatcher's gate and strand the
      // drag's command with no terminal event, leaving the transport busy for
      // good. finishGroup rejects the same missing provenance the same way.
      if (provenance === null) {
        throw new Error('Interactive group is missing commit provenance');
      }
      this.transportSink.endCommand(
        provenance.commandId,
        'cancelled',
        'Interactive turn cancelled',
      );
    } else {
      this.pump();
    }
    return true;
  }

  /** Cancel transient and queued visuals without echoing command-end events. */
  cancelPlayback(reason: string): void {
    if (typeof reason !== 'string') {
      throw new TypeError('cancel reason must be a string');
    }
    this.queue.length = 0;
    this.pendingInteractive = null;
    this.abortActiveVisual(true);
  }

  dispose(): void {
    if (this.disposed) return;

    if (this.transportSink !== undefined && this.isBusy) {
      this.transportSink.fail(new Error('TurnAnimator disposed with unfinished work'));
    }

    this.queue.length = 0;
    this.pendingInteractive = null;
    this.abortActiveVisual(true);
    for (const pivot of this.pivots) this.scene.remove(pivot);
    this.disposed = true;
  }

  private startQueuedTurns(): void {
    if (this.disposed || this.active !== null || this.queue.length === 0) return;

    const depth = this.queue.length;
    const layers: ActiveLayer[] = [];
    let duration = 0;

    while (layers.length < MAX_CONCURRENT_LAYERS) {
      const queued = this.queue[0];
      if (queued === undefined) break;
      if (layers.length > 0 && !this.canOverlapWith(layers, queued)) break;
      this.queue.shift();

      const layer = this.createLayer(queued.move.face, layers.length);
      layer.move = queued.move;
      layer.provenance = queued.provenance;
      layer.targetAngle = moveAngle(queued.move);
      layers.push(layer);
      // The whole group runs on the slower layer's clock. Finishing together is
      // what lets the moves commit in queue order without a per-layer barrier.
      duration = Math.max(duration, queuedTurnDuration(depth, layer.targetAngle));
    }

    // A turn only decelerates to a stop when nothing follows it, and only
    // accelerates from one when nothing preceded it. Anything enqueued after
    // this point starts a fresh impulse: the curve is fixed once it is running,
    // and re-shaping it mid-flight would jump the layer's angle.
    const entryVelocity = this.chainedEntry ? CRUISE_VELOCITY : IMPULSE_VELOCITY;
    const exitVelocity = this.queue.length > 0 ? CRUISE_VELOCITY : 0;
    this.chainedEntry = exitVelocity !== 0;

    this.attachLayers(layers);
    this.active = {
      mode: 'queue',
      layers,
      source: 'queue',
      elapsed: 0,
      duration: this.reducedMotion ? 0 : duration,
      entryVelocity,
      exitVelocity,
      dragVelocity: 0,
      sampleAngle: 0,
      sampleTime: 0,
    };
  }

  /**
   * DESIGN.md 4.4: only opposite layers hold disjoint cubie sets, so only they
   * may play at once. Reduced motion has no motion to overlap, and staying
   * serial there preserves its one-move-per-frame contract.
   */
  private canOverlapWith(
    layers: readonly ActiveLayer[],
    next: QueuedMove,
  ): boolean {
    if (this.reducedMotion) return false;
    return layers.every(
      (layer) =>
        layer.provenance?.commandId === next.provenance.commandId &&
        layersAreDisjoint(layer.face, next.move.face),
    );
  }

  private createLayer(face: Layer, pivotIndex: number): ActiveLayer {
    return {
      face,
      // layerNormal already returns a fresh unit vector along a cardinal axis.
      axis: layerNormal(face),
      // How far along the axis this layer sits: the outer layer a face names,
      // or the middle one a slice names.
      slab: isSlice(face) ? 0 : 1,
      pivot: this.pivots[pivotIndex]!,
      move: null,
      provenance: null,
      startAngle: 0,
      targetAngle: 0,
      angle: 0,
    };
  }

  private attachLayers(layers: readonly ActiveLayer[]): void {
    for (const layer of layers) {
      resetPivot(layer.pivot);
      this.scene.add(layer.pivot);
    }
    this.scene.updateMatrixWorld(true);

    for (const cubie of this.cubies) {
      const [x, y, z] = cubie.gridPosition;
      for (const layer of layers) {
        const { axis, slab } = layer;
        if (Math.abs(axis.x * x + axis.y * y + axis.z * z - slab) < 0.5) {
          layer.pivot.attach(cubie.object);
          // Concurrent layers are disjoint by construction; stopping here keeps
          // that an invariant of this loop rather than a fact about the caller.
          break;
        }
      }
    }
  }

  private setPivotAngle(layer: ActiveLayer): void {
    layer.pivot.setRotationFromAxisAngle(layer.axis, layer.angle);
    layer.pivot.updateMatrixWorld(true);
  }

  private finishGroup(group: ActiveGroup): void {
    if (this.active !== group) return;

    this.active = null;
    this.detachLayers(group.layers);

    // A concurrent pair commits two moves, with a snapshot and provenance for
    // each logical step. The sink is called only after every layer is detached
    // and one final integer-state visual rebuild has completed.
    const changes: MoveCubeStateChange[] = [];
    for (const layer of group.layers) {
      if (layer.move === null) continue;
      if (layer.provenance === null) {
        throw new Error('Active move is missing commit provenance');
      }
      this.cubeState = applyMove(this.cubeState, layer.move);
      changes.push({
        state: cloneState(this.cubeState),
        move: { face: layer.move.face, turns: layer.move.turns },
        provenance: cloneProvenance(layer.provenance),
      });
    }

    // Never round a pivot's floating-point result. This rebuilds every visual
    // transform from the new integer state (or the unchanged state on a
    // cancelled snap).
    this.syncFromIntegerState();
    if (this.transportSink !== undefined) {
      if (changes.length > 0) {
        this.transportSink.commit(changes, cloneState(this.cubeState));
      } else if (group.source === 'drag') {
        const provenance = group.layers[0]!.provenance;
        if (provenance === null) {
          throw new Error('Interactive group is missing commit provenance');
        }
        this.transportSink.endCommand(
          provenance.commandId,
          'cancelled',
          'Interactive turn rolled back below the snap threshold',
        );
      }
    } else {
      for (const change of changes) {
        this.onStateChange?.({
          state: cloneState(change.state),
          move: { face: change.move.face, turns: change.move.turns },
          source: group.source,
        });
      }
      // Transitional mode has no dispatcher to reopen the gate.
      this.pump();
    }
  }

  private abortActiveVisual(sync: boolean): void {
    this.chainedEntry = false;
    const group = this.active;
    if (group === null) return;

    this.active = null;
    this.detachLayers(group.layers);
    if (sync) this.syncFromIntegerState();
  }

  private detachLayers(layers: readonly ActiveLayer[]): void {
    this.scene.updateMatrixWorld(true);
    for (const layer of layers) {
      for (const child of [...layer.pivot.children]) {
        this.scene.attach(child);
      }
      this.scene.remove(layer.pivot);
      resetPivot(layer.pivot);
    }
  }

  private syncFromIntegerState(): void {
    this.syncVisuals(cloneState(this.cubeState));
  }

  private buildLegacyStateChange(
    move: Move | null,
    source: 'queue' | 'drag' | 'replace',
  ): LegacyCubeStateChange {
    return {
      state: cloneState(this.cubeState),
      move: move === null ? null : { face: move.face, turns: move.turns },
      source,
    };
  }

  private emitLegacyStateChange(
    move: Move | null,
    source: 'queue' | 'drag' | 'replace',
  ): void {
    this.onStateChange?.(this.buildLegacyStateChange(move, source));
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('TurnAnimator has been disposed');
  }
}
