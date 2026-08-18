import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  LayerDragController,
  mapSurfaceDragToLayer,
  projectWorldTangent,
} from '../src/drag-controller.js';
import type { TurnAnimator } from '../src/turn-animator.js';
import { CUBIE_DESCRIPTORS } from '../src/layout.js';
import type { CubieVisual, GridPosition } from '../src/types.js';

interface RecordedListener {
  readonly type: string;
  readonly listener: (event: PointerEvent) => void;
  readonly options: unknown;
}

/** Minimal canvas/document doubles: these tests run in the node environment. */
function stubHost(): {
  readonly canvas: HTMLCanvasElement;
  readonly onDocument: RecordedListener[];
  readonly onCanvas: RecordedListener[];
  readonly boundsReads: () => number;
} {
  const onDocument: RecordedListener[] = [];
  const onCanvas: RecordedListener[] = [];
  let boundsReads = 0;

  const record =
    (into: RecordedListener[]) =>
    (type: string, listener: (event: PointerEvent) => void, options?: unknown): void => {
      into.push({ type, listener, options });
    };
  const forget =
    (from: RecordedListener[]) =>
    (type: string): void => {
      const index = from.findIndex((entry) => entry.type === type);
      if (index >= 0) from.splice(index, 1);
    };

  const canvas = {
    ownerDocument: {
      addEventListener: record(onDocument),
      removeEventListener: forget(onDocument),
    },
    addEventListener: record(onCanvas),
    removeEventListener: forget(onCanvas),
    getBoundingClientRect: () => {
      boundsReads += 1;
      return { left: 0, top: 0, width: 0, height: 0 };
    },
  } as unknown as HTMLCanvasElement;

  return { canvas, onDocument, onCanvas, boundsReads: () => boundsReads };
}

function makeController(canvas: HTMLCanvasElement): LayerDragController {
  return new LayerDragController(
    canvas,
    new PerspectiveCamera(),
    [],
    { isActive: false } as unknown as TurnAnimator,
    { enabled: true },
  );
}

describe('surface drag mapping', () => {
  it('maps a rightward drag on the U-front row to clockwise F', () => {
    const mapping = mapSurfaceDragToLayer(
      new Vector3(0, 1, 0),
      new Vector3(1, 0, 0),
      [1, 1, 1],
    );
    expect(mapping?.face).toBe('F');
    expect(mapping?.outwardAxis.toArray()).toEqual([0, 0, 1]);
    expect(mapping?.angleSign).toBe(-1);
  });

  it('maps the same surface tangent on the back row to B with inverse sign', () => {
    const mapping = mapSurfaceDragToLayer(
      new Vector3(0, 1, 0),
      new Vector3(1, 0, 0),
      [-1, 1, -1],
    );
    expect(mapping?.face).toBe('B');
    expect(mapping?.outwardAxis.toArray()).toEqual([0, 0, -1]);
    expect(mapping?.angleSign).toBe(1);
  });

  it('rejects only a tangent parallel to the hit normal', () => {
    expect(
      mapSurfaceDragToLayer(new Vector3(0, 1, 0), new Vector3(0, 1, 0), [1, 1, 1]),
    ).toBeNull();
  });

  it('maps a cubie on the rotation axis to the slice that contains it', () => {
    // The U sticker of the UR edge, dragged towards the back: the rotation axis
    // runs through the cubie, so no outer layer holds it and the S slice does.
    expect(
      mapSurfaceDragToLayer(new Vector3(0, 1, 0), new Vector3(1, 0, 0), [1, 1, 0]),
    ).toMatchObject({ face: 'S' });
    // Every centre sticker is on its own axis in both directions.
    expect(
      mapSurfaceDragToLayer(new Vector3(0, 1, 0), new Vector3(1, 0, 0), [0, 1, 0]),
    ).toMatchObject({ face: 'S' });
    expect(
      mapSurfaceDragToLayer(new Vector3(0, 1, 0), new Vector3(0, 0, 1), [0, 1, 0]),
    ).toMatchObject({ face: 'M' });
  });
});

describe('world-to-screen tangent projection', () => {
  it('projects camera-visible directions into normalized screen vectors', () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const projected = projectWorldTangent(
      camera,
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      500,
      500,
    );
    expect(projected).not.toBeNull();
    expect(projected!.direction.x).toBeCloseTo(1);
    expect(projected!.direction.y).toBeCloseTo(0);
    expect(projected!.pixelsPerWorldUnit).toBeGreaterThan(100);
  });

  it('returns null for a direction projected to a point', () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    expect(
      projectWorldTangent(
        camera,
        new Vector3(0, 0, 0),
        new Vector3(0, 0, 1),
        500,
        500,
      ),
    ).toBeNull();
  });
});

describe('pointer listener placement', () => {
  it('binds pointerdown above the canvas, where OrbitControls cannot run first', () => {
    // OrbitControls registers its own pointerdown on the canvas in its
    // constructor. In the AT_TARGET phase listeners run in registration order
    // regardless of `capture`, so staying on the canvas would let the camera
    // latch its rotate anchor before we ever see the event.
    const { canvas, onDocument, onCanvas } = stubHost();
    const controller = makeController(canvas);

    expect(onDocument.map((entry) => [entry.type, entry.options])).toEqual([
      ['pointerdown', { capture: true }],
    ]);
    expect(onCanvas.map((entry) => entry.type)).toEqual([
      'pointermove',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
    ]);

    controller.dispose();
    expect(onDocument).toEqual([]);
    expect(onCanvas).toEqual([]);
  });

  it('ignores document pointerdown events that did not originate on the canvas', () => {
    const { canvas, onDocument, boundsReads } = stubHost();
    const controller = makeController(canvas);
    const onPointerDown = onDocument[0]!.listener;

    onPointerDown({ target: {}, button: 0 } as unknown as PointerEvent);
    expect(boundsReads()).toBe(0);

    onPointerDown({ target: canvas, button: 0 } as unknown as PointerEvent);
    expect(boundsReads()).toBe(1);

    controller.dispose();
  });
});


interface MountedDrag {
  readonly acceptedBegin: ReturnType<typeof vi.fn>;
  readonly directBegin: ReturnType<typeof vi.fn>;
  readonly setInteractiveAngle: ReturnType<typeof vi.fn>;
  readonly stopPropagation: ReturnType<typeof vi.fn>;
  readonly drag: (dx: number, dy: number) => void;
  readonly teardown: () => void;
}

/** Mount a controller over a single cubie, camera on +Z looking at the origin. */
function mountDrag(gridPosition: GridPosition): MountedDrag {
  const onDocument: RecordedListener[] = [];
  const onCanvas: RecordedListener[] = [];
  const record =
    (into: RecordedListener[]) =>
    (type: string, listener: (event: PointerEvent) => void, options?: unknown) => {
      into.push({ type, listener, options });
    };
  const canvas = {
    ownerDocument: {
      addEventListener: record(onDocument),
      removeEventListener: vi.fn(),
    },
    addEventListener: record(onCanvas),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const object = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  object.updateMatrixWorld(true);
  const visual: CubieVisual = {
    descriptor: CUBIE_DESCRIPTORS[0]!,
    object,
    gridPosition,
  };
  object.userData.cubieVisual = visual;

  const directBegin = vi.fn(() => true);
  const setInteractiveAngle = vi.fn();
  const animator = {
    isActive: false,
    beginInteractive: directBegin,
    setInteractiveAngle,
    releaseInteractive: vi.fn(),
    cancelInteractive: vi.fn(),
  } as unknown as TurnAnimator;
  const acceptedBegin = vi.fn(() => true);
  const controller = new LayerDragController(
    canvas,
    camera,
    [visual],
    animator,
    { enabled: true },
    { beginInteractive: acceptedBegin },
  );

  const stopPropagation = vi.fn();
  const drag = (dx: number, dy: number): void => {
    onDocument.find((entry) => entry.type === 'pointerdown')!.listener({
      target: canvas,
      button: 0,
      pointerId: 7,
      clientX: 250,
      clientY: 250,
      preventDefault: vi.fn(),
      stopPropagation,
    } as unknown as PointerEvent);
    onCanvas.find((entry) => entry.type === 'pointermove')!.listener({
      pointerId: 7,
      clientX: 250 + dx,
      clientY: 250 + dy,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);
  };
  const teardown = (): void => {
    controller.dispose();
    object.geometry.dispose();
    object.material.dispose();
  };

  return { acceptedBegin, directBegin, setInteractiveAngle, stopPropagation, drag, teardown };
}

describe('layer gesture acceptance', () => {
  it('routes a locked layer gesture through the injected acceptance gate', () => {
    const rig = mountDrag([1, 1, 1]);
    rig.drag(40, 0);

    expect(rig.acceptedBegin).toHaveBeenCalledTimes(1);
    expect(rig.directBegin).not.toHaveBeenCalled();
    expect(rig.setInteractiveAngle).toHaveBeenCalledTimes(1);
    rig.teardown();
  });

  it('turns a corner sticker on both of its tangents', () => {
    for (const [dx, dy, face] of [[40, 0, 'U'], [0, 40, 'R']] as const) {
      const rig = mountDrag([1, 1, 1]);
      rig.drag(dx, dy);
      expect(rig.acceptedBegin).toHaveBeenCalledWith(face);
      expect(rig.setInteractiveAngle.mock.calls[0]![0]).not.toBe(0);
      rig.teardown();
    }
  });

  it('turns an edge sticker both ways, the second onto a slice', () => {
    // The F sticker of the UF edge turns U when dragged sideways. Dragged
    // vertically no outer layer holds the cubie, so it turns the M slice --
    // before slices existed this direction produced nothing at all.
    const sideways = mountDrag([0, 1, 1]);
    sideways.drag(40, 0);
    expect(sideways.acceptedBegin).toHaveBeenCalledWith('U');
    expect(sideways.setInteractiveAngle.mock.calls[0]![0]).not.toBe(0);
    sideways.teardown();

    const vertical = mountDrag([0, 1, 1]);
    vertical.drag(0, 40);
    expect(vertical.acceptedBegin).toHaveBeenCalledWith('M');
    expect(vertical.setInteractiveAngle.mock.calls[0]![0]).not.toBe(0);
    vertical.teardown();
  });

  it('turns a slice from a centre sticker rather than orbiting the camera', () => {
    // Centres were the one dead zone left: every tangent on them runs along the
    // rotation axis, so the gesture used to fall through to OrbitControls.
    const horizontal = mountDrag([0, 0, 1]);
    horizontal.drag(40, 0);
    expect(horizontal.stopPropagation).toHaveBeenCalled();
    expect(horizontal.acceptedBegin).toHaveBeenCalledWith('E');
    horizontal.teardown();

    const vertical = mountDrag([0, 0, 1]);
    vertical.drag(0, 40);
    expect(vertical.acceptedBegin).toHaveBeenCalledWith('M');
    vertical.teardown();
  });
});
