import {
  applyMove,
  applyMoves,
  createSolvedState,
  statesEqual,
  type CubeState,
} from '@rubcube/cube-core';
import { Object3D, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CUBIE_DESCRIPTORS, getCubiePoses } from '../src/layout.js';
import { TurnAnimator } from '../src/turn-animator.js';
import type {
  CubeStateChange,
  CubieVisual,
  GridPosition,
} from '../src/types.js';

function expectVector(actual: Vector3, expected: Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
  expect(actual.z).toBeCloseTo(expected.z, 8);
}

interface Harness {
  readonly scene: Object3D;
  readonly cubies: CubieVisual[];
  readonly changes: CubeStateChange[];
  readonly syncVisuals: ReturnType<typeof vi.fn<(state: CubeState) => void>>;
  readonly animator: TurnAnimator;
}

function createHarness(
  options: {
    initialState?: CubeState;
    reducedMotion?: boolean;
    parent?: Object3D;
  } = {},
): Harness {
  const scene = options.parent ?? new Scene();
  const cubies: CubieVisual[] = CUBIE_DESCRIPTORS.map((descriptor) => {
    const object = new Object3D();
    object.name = descriptor.id;
    scene.add(object);
    return {
      descriptor,
      object,
      gridPosition: [...descriptor.homePosition] as GridPosition,
    };
  });
  const byId = new Map(
    cubies.map((cubie) => [cubie.descriptor.id, cubie] as const),
  );
  const syncVisuals = vi.fn<(state: CubeState) => void>((state) => {
    for (const pose of getCubiePoses(state)) {
      const cubie = byId.get(pose.descriptor.id);
      if (cubie === undefined) throw new Error('test visual is missing');
      cubie.gridPosition = [...pose.gridPosition] as GridPosition;
      cubie.object.position.set(...pose.gridPosition);
      cubie.object.quaternion.copy(pose.quaternion);
      cubie.object.scale.set(1, 1, 1);
      cubie.object.updateMatrix();
    }
    scene.updateMatrixWorld(true);
  });
  const changes: CubeStateChange[] = [];
  const initialState = options.initialState ?? createSolvedState();
  const animator = new TurnAnimator(scene, cubies, initialState, {
    syncVisuals,
    onStateChange: (change) => changes.push(change),
    ...(options.reducedMotion === undefined
      ? {}
      : { reducedMotion: options.reducedMotion }),
  });
  return { scene, cubies, changes, syncVisuals, animator };
}

function cubie(harness: Harness, id: string): CubieVisual {
  const result = harness.cubies.find((candidate) => candidate.descriptor.id === id);
  if (result === undefined) throw new Error(`Missing ${id}`);
  return result;
}

function pivot(harness: Harness, index = 0): Object3D | undefined {
  return harness.scene.getObjectByName(`rubcube-turn-pivot-${index}`);
}

/** Magnitude of a pivot's current rotation, in radians. */
function pivotAngle(harness: Harness, index = 0): number {
  const attached = pivot(harness, index);
  if (attached === undefined) throw new Error(`pivot ${index} is not attached`);
  const { x, y, z, w } = attached.quaternion;
  return 2 * Math.atan2(Math.hypot(x, y, z), w);
}

/**
 * Drive an interactive turn one 20ms frame per angle. The frame deliberately
 * does not divide the animator's 50ms velocity window: at 10ms the accumulated
 * float elapsed lands a half-ulp under the threshold and the anchor never
 * refreshes, which is a property of this harness rather than of a real clock.
 */
function drag(harness: Harness, angles: readonly number[]): void {
  for (const angle of angles) {
    harness.animator.tick(0.02);
    harness.animator.setInteractiveAngle(angle);
  }
}

function expectAllCubiesInScene(harness: Harness): void {
  for (const visual of harness.cubies) {
    expect(visual.object.parent).toBe(harness.scene);
  }
  expect(pivot(harness, 0)).toBeUndefined();
  expect(pivot(harness, 1)).toBeUndefined();
}

describe('TurnAnimator queue', () => {
  it('animates clockwise and inverse turns around the outward face normal', () => {
    const clockwise = createHarness();
    const urf = cubie(clockwise, 'corner:URF');
    clockwise.animator.enqueue('U');

    const layer = pivot(clockwise);
    expect(layer?.children).toHaveLength(9);
    expect(urf.object.parent).toBe(layer);
    expect(clockwise.animator.tick(0.06)).toBe(true);

    // An isolated turn keeps DESIGN.md 4.3's easeOutQuad exactly: half the
    // elapsed duration is 75% of the rotation.
    const expectedClockwise = new Vector3(1, 1, 1).applyAxisAngle(
      new Vector3(0, 1, 0),
      (-Math.PI / 2) * 0.75,
    );
    expectVector(urf.object.getWorldPosition(new Vector3()), expectedClockwise);

    const inverse = createHarness();
    const inverseUrf = cubie(inverse, 'corner:URF');
    inverse.animator.enqueue("U'");
    inverse.animator.tick(0.06);
    const expectedInverse = new Vector3(1, 1, 1).applyAxisAngle(
      new Vector3(0, 1, 0),
      (Math.PI / 2) * 0.75,
    );
    expectVector(
      inverseUrf.object.getWorldPosition(new Vector3()),
      expectedInverse,
    );
  });

  it('uses queue-depth duration scaling and commits in strict order', () => {
    const harness = createHarness();
    harness.animator.enqueue("U R F'");

    expect(harness.animator.isActive).toBe(true);
    expect(harness.animator.queueLength).toBe(3);
    // depth=3: 120ms * (1 - .12 * 2) = 91.2ms
    harness.animator.tick(0.09);
    expect(harness.changes).toHaveLength(0);
    expect(statesEqual(harness.animator.state, createSolvedState())).toBe(true);

    harness.animator.tick(0.002);
    expect(harness.changes.map((change) => change.move)).toEqual([
      { face: 'U', turns: 1 },
    ]);
    expect(harness.animator.queueLength).toBe(2);

    harness.animator.tick(1);
    expect(harness.changes.map((change) => change.move)).toEqual([
      { face: 'U', turns: 1 },
      { face: 'R', turns: 1 },
      { face: 'F', turns: 3 },
    ]);
    expect(
      statesEqual(harness.animator.state, applyMoves(createSolvedState(), "U R F'")),
    ).toBe(true);
    expect(harness.animator.queueLength).toBe(0);
    expect(harness.animator.isActive).toBe(false);
    expectAllCubiesInScene(harness);
    expect(harness.animator.tick(1)).toBe(false);
  });

  it('clamps deep queues to 45% of the base duration', () => {
    const harness = createHarness();
    harness.animator.enqueue(Array.from({ length: 12 }, () => ({
      face: 'U' as const,
      turns: 1 as const,
    })));

    // 120ms * .45 = 54ms, rather than the negative raw scale at depth 12.
    harness.animator.tick(0.053);
    expect(harness.changes).toHaveLength(0);
    harness.animator.tick(0.002);
    expect(harness.changes).toHaveLength(1);
  });

  it('scales a turn duration with the angle it sweeps', () => {
    const quarterDuration = 0.12;
    const halfDuration = quarterDuration * Math.SQRT2;

    const quarter = createHarness();
    quarter.animator.enqueue('R');
    quarter.animator.tick(quarterDuration - 0.001);
    expect(quarter.changes).toHaveLength(0);
    quarter.animator.tick(0.002);
    expect(quarter.changes).toHaveLength(1);

    const half = createHarness();
    half.animator.enqueue('R2');
    // A flat duration would have committed the 180 here too, which is the same
    // wall clock for twice the sweep: exactly twice the angular velocity.
    half.animator.tick(quarterDuration);
    expect(half.changes).toHaveLength(0);
    half.animator.tick(halfDuration - quarterDuration - 0.001);
    expect(half.changes).toHaveLength(0);
    half.animator.tick(0.002);
    expect(half.changes).toEqual([
      expect.objectContaining({ move: { face: 'R', turns: 2 } }),
    ]);
  });

  it('cruises through a sequence instead of stopping dead at every seam', () => {
    const harness = createHarness();
    harness.animator.enqueue('U R F');

    // depth 3 => 91.2ms. Consuming it exactly commits U and starts R at zero.
    harness.animator.tick(0.12 * (1 - 0.12 * 2));
    expect(harness.changes).toHaveLength(1);

    // R has a turn on both sides, so its curve is exactly linear: half the
    // duration is half the angle. easeOutQuad would have put it at 75% here,
    // having entered at full speed from a standstill.
    const duration = 0.12 * (1 - 0.12);
    harness.animator.tick(duration / 2);
    expect(pivotAngle(harness)).toBeCloseTo(Math.PI / 4, 9);
    expect(pivotAngle(harness)).not.toBeCloseTo((Math.PI / 2) * 0.75, 3);
  });

  it('completes one move per tick in reduced-motion mode', () => {
    const harness = createHarness({ reducedMotion: true });
    harness.animator.enqueue('R U');

    expect(harness.animator.tick(0)).toBe(true);
    expect(harness.changes.map((change) => change.move)).toEqual([
      { face: 'R', turns: 1 },
    ]);
    expect(harness.animator.queueLength).toBe(1);

    expect(harness.animator.tick(0)).toBe(true);
    expect(
      statesEqual(harness.animator.state, applyMoves(createSolvedState(), 'R U')),
    ).toBe(true);
    expect(harness.animator.tick(0)).toBe(false);
  });

  it('copies queued moves and exposes a defensive state snapshot', () => {
    const harness = createHarness({ reducedMotion: true });
    const move = { face: 'R' as const, turns: 1 as const };
    harness.animator.enqueue([move]);
    (move as { face: string }).face = 'U';

    const snapshot = harness.animator.state;
    snapshot.cp[0] = 7;
    harness.animator.tick(0);

    expect(
      statesEqual(harness.animator.state, applyMove(createSolvedState(), {
        face: 'R',
        turns: 1,
      })),
    ).toBe(true);
  });
});

describe('TurnAnimator concurrent layers', () => {
  it('plays an opposite-face pair at once and commits it in queue order', () => {
    const harness = createHarness();
    harness.animator.enqueue("R L'");

    const right = pivot(harness, 0);
    const left = pivot(harness, 1);
    expect(right?.children).toHaveLength(9);
    expect(left?.children).toHaveLength(9);
    // Opposite layers are disjoint; the 8 cubies on x=0 stay under the scene.
    expect(new Set([...right!.children, ...left!.children]).size).toBe(18);
    expect(harness.animator.queueLength).toBe(2);

    // Both run on one clock, so neither can commit while the other is still
    // detached from the pose the sync rebuilds.
    harness.animator.tick(0.12 * (1 - 0.12) - 0.001);
    expect(harness.changes).toHaveLength(0);
    harness.animator.tick(0.002);

    expect(harness.changes.map((change) => change.move)).toEqual([
      { face: 'R', turns: 1 },
      { face: 'L', turns: 3 },
    ]);
    // Each listener call reports the state as of its own move, not the state
    // after the whole group.
    expect(
      statesEqual(
        harness.changes[0]!.state,
        applyMove(createSolvedState(), { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(
      statesEqual(harness.animator.state, applyMoves(createSolvedState(), "R L'")),
    ).toBe(true);
    expect(harness.syncVisuals).toHaveBeenCalledTimes(2);
    expectAllCubiesInScene(harness);
  });

  it('keeps intersecting layers serial', () => {
    for (const sequence of ['R U', "R R'", 'F D']) {
      const harness = createHarness();
      harness.animator.enqueue(sequence);

      expect(pivot(harness, 0)?.children).toHaveLength(9);
      expect(pivot(harness, 1)).toBeUndefined();

      harness.animator.tick(1);
      expect(harness.changes).toHaveLength(2);
      expect(
        statesEqual(harness.animator.state, applyMoves(createSolvedState(), sequence)),
      ).toBe(true);
      expectAllCubiesInScene(harness);
    }
  });

  it('resumes serially after an overlapped pair', () => {
    const harness = createHarness();
    harness.animator.enqueue('U D U');

    expect(pivot(harness, 1)?.children).toHaveLength(9);
    harness.animator.tick(1);

    expect(harness.changes.map((change) => change.move)).toEqual([
      { face: 'U', turns: 1 },
      { face: 'D', turns: 1 },
      { face: 'U', turns: 1 },
    ]);
    expectAllCubiesInScene(harness);
  });

  it('keeps reduced motion serial, with nothing to overlap', () => {
    const harness = createHarness({ reducedMotion: true });
    harness.animator.enqueue("R L'");

    expect(pivot(harness, 1)).toBeUndefined();
    harness.animator.tick(0);
    expect(harness.changes.map((change) => change.move)).toEqual([
      { face: 'R', turns: 1 },
    ]);
  });
});

describe('TurnAnimator interactive turns', () => {
  it('springs back without a state change below 30 degrees', () => {
    const harness = createHarness();
    expect(harness.animator.beginInteractive('F')).toBe(true);
    expect(harness.animator.beginInteractive('U')).toBe(false);

    harness.animator.setInteractiveAngle(Math.PI / 7);
    expect(harness.animator.releaseInteractive()).toBe(true);
    expect(harness.animator.releaseInteractive()).toBe(false);
    harness.animator.tick(1);

    expect(statesEqual(harness.animator.state, createSolvedState())).toBe(true);
    expect(harness.changes).toHaveLength(0);
    expectAllCubiesInScene(harness);
  });

  it('snaps negative angles clockwise and positive angles inverse', () => {
    const clockwise = createHarness();
    clockwise.animator.beginInteractive('U');
    clockwise.animator.setInteractiveAngle(-Math.PI / 3);
    clockwise.animator.releaseInteractive();
    clockwise.animator.tick(1);
    expect(clockwise.changes[0]).toMatchObject({
      move: { face: 'U', turns: 1 },
      source: 'drag',
    });
    expect(
      statesEqual(
        clockwise.animator.state,
        applyMove(createSolvedState(), { face: 'U', turns: 1 }),
      ),
    ).toBe(true);

    const inverse = createHarness();
    inverse.animator.beginInteractive('U');
    // Exactly 30 degrees commits; only values strictly below it cancel.
    inverse.animator.setInteractiveAngle(Math.PI / 6);
    inverse.animator.releaseInteractive();
    inverse.animator.tick(1);
    expect(inverse.changes[0]).toMatchObject({
      move: { face: 'U', turns: 3 },
      source: 'drag',
    });
    expect(
      statesEqual(
        inverse.animator.state,
        applyMove(createSolvedState(), { face: 'U', turns: 3 }),
      ),
    ).toBe(true);
  });

  it('snaps at the speed the finger left, not at a fixed impulse', () => {
    const release = -Math.PI / 3;

    // Still moving toward the snap target when the finger lifts.
    const flicked = createHarness();
    flicked.animator.beginInteractive('U');
    drag(
      flicked,
      Array.from({ length: 6 }, (_unused, step) => (release * (step + 1)) / 6),
    );
    flicked.animator.releaseInteractive();
    flicked.animator.tick(0.005);
    const flickedAngle = pivotAngle(flicked);

    // Same angle, but the finger rested there for longer than the sample window.
    const held = createHarness();
    held.animator.beginInteractive('U');
    held.animator.setInteractiveAngle(release);
    held.animator.tick(0.2);
    held.animator.releaseInteractive();
    held.animator.tick(0.005);
    const heldAngle = pivotAngle(held);

    // Same angle again, but the finger was on its way back toward zero. A
    // signed velocity is what stops that from being read as a flick.
    const reversed = createHarness();
    reversed.animator.beginInteractive('U');
    drag(reversed, [-0.5, -1, -1.5, -1.35, -1.2, release]);
    reversed.animator.releaseInteractive();
    reversed.animator.tick(0.005);

    expect(flickedAngle).toBeGreaterThan(heldAngle);
    expect(pivotAngle(reversed)).toBeCloseTo(heldAngle, 12);

    // All three settle on the same committed move regardless of the entry speed.
    for (const harness of [flicked, held, reversed]) {
      harness.animator.tick(1);
      expect(harness.changes.map((change) => change.move)).toEqual([
        { face: 'U', turns: 1 },
      ]);
      expectAllCubiesInScene(harness);
    }
  });

  it('can cancel an interactive snap without committing it', () => {
    const harness = createHarness();
    harness.animator.beginInteractive('L');
    harness.animator.setInteractiveAngle(-Math.PI / 3);
    harness.animator.releaseInteractive();

    expect(harness.animator.cancelInteractive()).toBe(true);
    expect(harness.animator.cancelInteractive()).toBe(false);
    expect(statesEqual(harness.animator.state, createSolvedState())).toBe(true);
    expectAllCubiesInScene(harness);
  });
});

describe('TurnAnimator replacement and cleanup', () => {
  it('supports an Object3D container and returns cubies to that container', () => {
    const container = new Object3D();
    const harness = createHarness({ parent: container });
    harness.animator.enqueue('L2');
    harness.animator.tick(1);

    expectAllCubiesInScene(harness);
    expect(
      statesEqual(
        harness.animator.state,
        applyMove(createSolvedState(), { face: 'L', turns: 2 }),
      ),
    ).toBe(true);
  });

  it('validates before interrupting, then safely replaces an active queue', () => {
    const harness = createHarness();
    harness.animator.enqueue('U R');
    harness.animator.tick(0.03);

    const invalid = createSolvedState();
    invalid.cp[0] = invalid.cp[1]!;
    expect(() => harness.animator.replaceState(invalid)).toThrow();
    expect(harness.animator.isActive).toBe(true);
    expect(harness.animator.queueLength).toBe(2);

    const replacement = applyMoves(createSolvedState(), 'F2 L');
    harness.animator.replaceState(replacement);
    expect(statesEqual(harness.animator.state, replacement)).toBe(true);
    expect(harness.animator.isActive).toBe(false);
    expect(harness.animator.queueLength).toBe(0);
    expect(harness.changes.at(-1)).toMatchObject({ move: null, source: 'replace' });
    expectAllCubiesInScene(harness);
  });

  it('rebuilds exact visual poses from integer state after every commit', () => {
    const harness = createHarness();
    const urf = cubie(harness, 'corner:URF');
    harness.syncVisuals.mockClear();
    harness.animator.enqueue('R');
    harness.animator.tick(0.04);
    const transient = urf.object.getWorldPosition(new Vector3());
    expect(
      Number.isInteger(transient.x) &&
        Number.isInteger(transient.y) &&
        Number.isInteger(transient.z),
    ).toBe(false);

    harness.animator.tick(1);
    const expectedState = applyMove(createSolvedState(), { face: 'R', turns: 1 });
    expect(harness.syncVisuals).toHaveBeenCalledTimes(1);
    expect(statesEqual(harness.syncVisuals.mock.calls[0]![0], expectedState)).toBe(
      true,
    );
    expect(urf.object.position.toArray().every(Number.isInteger)).toBe(true);
    expectAllCubiesInScene(harness);
  });

  it('restores visuals on dispose and becomes inert', () => {
    const harness = createHarness();
    harness.animator.beginInteractive('B');
    harness.animator.setInteractiveAngle(0.8);
    harness.animator.dispose();
    harness.animator.dispose();

    expect(harness.animator.isActive).toBe(false);
    expect(harness.animator.queueLength).toBe(0);
    expect(harness.animator.tick(1)).toBe(false);
    expect(harness.animator.beginInteractive('U')).toBe(false);
    expect(() => harness.animator.enqueue('U')).toThrow(/disposed/);
    expectAllCubiesInScene(harness);
  });

  it('rejects invalid time and angle values', () => {
    const harness = createHarness();
    harness.animator.enqueue('U');
    expect(() => harness.animator.tick(-0.01)).toThrow(RangeError);
    expect(() => harness.animator.tick(Number.NaN)).toThrow(RangeError);
    expect(() => harness.animator.setInteractiveAngle(Infinity)).toThrow(
      RangeError,
    );
  });
});
