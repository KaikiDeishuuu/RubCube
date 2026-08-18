import type { Face } from '@rubcube/cube-core';
import {
  Camera,
  Raycaster,
  Vector2,
  Vector3,
  type Intersection,
  type Object3D,
} from 'three';

import { TurnAnimator } from './turn-animator.js';
import type { CubieVisual, GridPosition } from './types.js';

const CARDINALS = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
] as const;
const LOCK_THRESHOLD_PX = 8;
const MAX_DRAG_ANGLE = Math.PI / 2;

export interface CameraControlsLike {
  enabled: boolean;
}

export interface LayerDragMapping {
  readonly face: Face;
  /** Outward normal of the selected face/layer. */
  readonly outwardAxis: Vector3;
  /** Converts positive motion along `tangent` to angle about `outwardAxis`. */
  readonly angleSign: -1 | 1;
}

export interface LayerDragControllerOptions {
  readonly requestRender?: () => void;
  readonly lockThresholdPx?: number;
  /** Command acceptance gate; the renderer routes this through CommitDispatcher. */
  readonly beginInteractive?: (face: Face) => boolean;
}

interface ProjectedTangent {
  readonly world: Vector3;
  readonly screen: Vector2;
  readonly pixelsPerWorldUnit: number;
  readonly mapping: LayerDragMapping;
}

interface PendingPointer {
  readonly pointerId: number;
  readonly start: Vector2;
  readonly hitPoint: Vector3;
  readonly tangents: readonly ProjectedTangent[];
  locked: ProjectedTangent | null;
  radius: number;
}

function snapCardinal(vector: Vector3): Vector3 {
  const absolute = [Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z)];
  let dominant = 0;
  if (absolute[1]! > absolute[dominant]!) dominant = 1;
  if (absolute[2]! > absolute[dominant]!) dominant = 2;
  const result = new Vector3();
  const value = vector.getComponent(dominant);
  result.setComponent(dominant, value < 0 ? -1 : 1);
  return result;
}

function faceFromOutwardNormal(normal: Vector3): Face {
  if (normal.x > 0.5) return 'R';
  if (normal.x < -0.5) return 'L';
  if (normal.y > 0.5) return 'U';
  if (normal.y < -0.5) return 'D';
  if (normal.z > 0.5) return 'F';
  return 'B';
}

/** Map a surface tangent drag to the outer layer it rotates. */
export function mapSurfaceDragToLayer(
  faceNormal: Vector3,
  tangent: Vector3,
  gridPosition: Readonly<GridPosition>,
): LayerDragMapping | null {
  const normal = snapCardinal(faceNormal);
  const direction = snapCardinal(tangent);
  if (Math.abs(normal.dot(direction)) > 0.5) return null;

  const rotationAxis = new Vector3().crossVectors(normal, direction);
  const layerCoordinate =
    rotationAxis.x * gridPosition[0] +
    rotationAxis.y * gridPosition[1] +
    rotationAxis.z * gridPosition[2];
  if (Math.abs(layerCoordinate) < 0.5) return null;

  const angleSign = layerCoordinate < 0 ? -1 : 1;
  const outwardAxis = snapCardinal(rotationAxis.multiplyScalar(angleSign));
  return {
    face: faceFromOutwardNormal(outwardAxis),
    outwardAxis,
    angleSign,
  };
}

/** Project a unit world tangent to a CSS-pixel direction at a world point. */
export function projectWorldTangent(
  camera: Camera,
  point: Vector3,
  tangent: Vector3,
  width: number,
  height: number,
): { direction: Vector2; pixelsPerWorldUnit: number } | null {
  const start = point.clone().project(camera);
  const end = point.clone().add(tangent).project(camera);
  const screen = new Vector2(
    (end.x - start.x) * width * 0.5,
    -(end.y - start.y) * height * 0.5,
  );
  const pixelsPerWorldUnit = screen.length();
  if (!Number.isFinite(pixelsPerWorldUnit) || pixelsPerWorldUnit < 1e-5) return null;
  return { direction: screen.divideScalar(pixelsPerWorldUnit), pixelsPerWorldUnit };
}

function cubieFromIntersection(intersection: Intersection<Object3D>): CubieVisual | null {
  let object: Object3D | null = intersection.object;
  while (object !== null) {
    const candidate = object.userData.cubieVisual as CubieVisual | undefined;
    if (candidate !== undefined) return candidate;
    object = object.parent;
  }
  return null;
}

export class LayerDragController {
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly requestRender: () => void;
  private readonly beginInteractive: (face: Face) => boolean;
  private readonly lockThresholdPx: number;
  private readonly ownerDocument: Document;
  private pending: PendingPointer | null = null;
  private controlsWereEnabled = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly cubies: readonly CubieVisual[],
    private readonly animator: TurnAnimator,
    private readonly controls: CameraControlsLike,
    options: LayerDragControllerOptions = {},
  ) {
    this.requestRender = options.requestRender ?? (() => undefined);
    this.beginInteractive =
      options.beginInteractive ?? ((face) => this.animator.beginInteractive(face));
    this.lockThresholdPx = options.lockThresholdPx ?? LOCK_THRESHOLD_PX;
    this.ownerDocument = canvas.ownerDocument;
    // OrbitControls attaches its own `pointerdown` handler to this same canvas.
    // In the AT_TARGET phase, capturing and bubbling listeners on the target run
    // in registration order, so a capturing listener on the canvas cannot
    // preempt a controls instance that was constructed first. Binding one level
    // up puts us in a real capture phase, where stopPropagation() keeps the
    // gesture away from the camera no matter the construction order.
    this.ownerDocument.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
  }

  dispose(): void {
    this.cancelPending();
    this.ownerDocument.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target !== this.canvas) return;
    if (event.button !== 0 || this.pending !== null || this.animator.isActive) return;
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    this.pointerNdc.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const intersections = this.raycaster.intersectObjects(
      this.cubies.map((cubie) => cubie.object),
      false,
    );
    const intersection = intersections[0];
    if (intersection?.face === null || intersection?.face === undefined) return;
    const cubie = cubieFromIntersection(intersection);
    if (cubie === null) return;

    const faceNormal = snapCardinal(
      intersection.face.normal.clone().transformDirection(intersection.object.matrixWorld),
    );
    const tangents: ProjectedTangent[] = [];
    for (const tangent of CARDINALS) {
      if (Math.abs(tangent.dot(faceNormal)) > 0.5) continue;
      const mapping = mapSurfaceDragToLayer(faceNormal, tangent, cubie.gridPosition);
      if (mapping === null) continue;
      const projected = projectWorldTangent(
        this.camera,
        intersection.point,
        tangent,
        bounds.width,
        bounds.height,
      );
      if (projected === null) continue;
      tangents.push({
        world: tangent.clone(),
        screen: projected.direction,
        pixelsPerWorldUnit: projected.pixelsPerWorldUnit,
        mapping,
      });
    }
    if (tangents.length === 0) return;

    event.preventDefault();
    // We are still above the canvas in the capture phase, so this prevents the
    // event from ever reaching OrbitControls' target listener. Disabling
    // `controls` alone would not be enough: its pointerdown handler latches the
    // rotate anchor before checking `enabled` on later moves, so a gesture we
    // later cancel would resume orbiting from a stale anchor.
    event.stopPropagation();
    this.controlsWereEnabled = this.controls.enabled;
    this.controls.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.pending = {
      pointerId: event.pointerId,
      start: new Vector2(event.clientX, event.clientY),
      hitPoint: intersection.point.clone(),
      tangents,
      locked: null,
      radius: 1,
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pending = this.pending;
    if (pending === null || pending.pointerId !== event.pointerId) return;
    event.preventDefault();

    const delta = new Vector2(
      event.clientX - pending.start.x,
      event.clientY - pending.start.y,
    );
    if (pending.locked === null) {
      if (delta.length() < this.lockThresholdPx) return;
      const ranked = pending.tangents
        .map((tangent) => ({ tangent, score: Math.abs(delta.dot(tangent.screen)) }))
        .sort((left, right) => right.score - left.score);
      const selected = ranked[0]?.tangent;
      if (selected === undefined || !this.beginInteractive(selected.mapping.face)) {
        this.cancelPending();
        return;
      }
      pending.locked = selected;
      const axis = selected.mapping.outwardAxis;
      const alongAxis = axis.clone().multiplyScalar(pending.hitPoint.dot(axis));
      pending.radius = Math.max(0.5, pending.hitPoint.distanceTo(alongAxis));
    }

    const locked = pending.locked;
    const pixels = delta.dot(locked.screen);
    const rawAngle = pixels / (locked.pixelsPerWorldUnit * pending.radius);
    const angle = Math.max(
      -MAX_DRAG_ANGLE,
      Math.min(MAX_DRAG_ANGLE, rawAngle * locked.mapping.angleSign),
    );
    this.animator.setInteractiveAngle(angle);
    this.requestRender();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pending?.pointerId !== event.pointerId) return;
    if (this.pending.locked === null) this.animator.cancelInteractive();
    else this.animator.releaseInteractive();
    this.finishPointer(event.pointerId);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.pending?.pointerId !== event.pointerId) return;
    this.animator.cancelInteractive();
    this.finishPointer(event.pointerId);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    if (this.pending?.pointerId !== event.pointerId) return;
    this.animator.cancelInteractive();
    this.finishPointer(event.pointerId);
  };

  private finishPointer(pointerId: number): void {
    if (this.pending === null) return;
    this.pending = null;
    this.controls.enabled = this.controlsWereEnabled;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.requestRender();
  }

  private cancelPending(): void {
    const pending = this.pending;
    if (pending === null) return;
    if (pending.locked !== null) {
      this.animator.cancelInteractive();
    }
    this.pending = null;
    this.controls.enabled = this.controlsWereEnabled;
    if (this.canvas.hasPointerCapture(pending.pointerId)) {
      this.canvas.releasePointerCapture(pending.pointerId);
    }
  }
}
