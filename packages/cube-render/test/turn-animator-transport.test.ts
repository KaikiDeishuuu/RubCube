import {
  applyMove,
  applyMoves,
  cloneState,
  createSolvedState,
  statesEqual,
  type CubeState,
  type Move,
} from '@rubcube/cube-core';
import { Object3D, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CUBIE_DESCRIPTORS, getCubiePoses } from '../src/layout.js';
import {
  CommitDispatcher,
  type CommandEnd,
  type CommitBatch,
  type CommitProvenance,
  type CubeStateChange,
  type DispatchEvent,
  type DragCommitProvenance,
  type MoveTransportBackendSink,
  type QueuedMove,
} from '../src/transport.js';
import { TurnAnimator } from '../src/turn-animator.js';
import type { CubieVisual, GridPosition } from '../src/types.js';

interface BackendHarness {
  readonly scene: Object3D;
  readonly animator: TurnAnimator;
  readonly commits: Array<{
    readonly changes: readonly CubeStateChange[];
    readonly finalState: CubeState;
  }>;
  readonly ends: Array<{
    readonly commandId: string;
    readonly status: 'completed' | 'cancelled' | 'failed';
    readonly reason?: string;
  }>;
  readonly failures: unknown[];
  readonly syncVisuals: ReturnType<typeof vi.fn<(state: CubeState) => void>>;
}

function provenance(commandId: string): CommitProvenance {
  return { commandId, intent: 'forward', origin: 'formula' };
}

function dragProvenance(commandId: string): DragCommitProvenance {
  return { commandId, intent: 'forward', origin: 'drag' };
}

function queued(move: Move, commandId: string): QueuedMove {
  return { move, provenance: provenance(commandId) };
}

function createVisuals(
  initialState: CubeState,
): {
  readonly scene: Object3D;
  readonly cubies: CubieVisual[];
  readonly syncVisuals: ReturnType<typeof vi.fn<(state: CubeState) => void>>;
} {
  const scene = new Scene();
  const cubies: CubieVisual[] = CUBIE_DESCRIPTORS.map((descriptor) => {
    const object = new Object3D();
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
      const cubie = byId.get(pose.descriptor.id)!;
      cubie.gridPosition = [...pose.gridPosition] as GridPosition;
      cubie.object.position.set(...pose.gridPosition);
      cubie.object.quaternion.copy(pose.quaternion);
      cubie.object.updateMatrix();
    }
    scene.updateMatrixWorld(true);
  });
  syncVisuals(initialState);
  syncVisuals.mockClear();
  return { scene, cubies, syncVisuals };
}

function createBackendHarness(initialState = createSolvedState()): BackendHarness {
  const { scene, cubies, syncVisuals } = createVisuals(initialState);
  const commits: BackendHarness['commits'] = [];
  const ends: BackendHarness['ends'] = [];
  const failures: unknown[] = [];
  const sink: MoveTransportBackendSink = {
    commit: (changes, finalState) => {
      commits.push({ changes, finalState });
    },
    endCommand: (commandId, status, reason) => {
      ends.push(reason === undefined
        ? { commandId, status }
        : { commandId, status, reason });
    },
    fail: (reason) => failures.push(reason),
  };
  const animator = new TurnAnimator(scene, cubies, initialState, {
    syncVisuals,
    transportSink: sink,
  });
  syncVisuals.mockClear();
  return { scene, animator, commits, ends, failures, syncVisuals };
}

function eventLabel(event: DispatchEvent): string {
  if ('status' in event) return `end:${event.commandId}:${event.status}`;
  return `batch:${event.changes[0]!.move?.face ?? 'replace'}`;
}

describe('TurnAnimator MoveTransportBackend queue', () => {
  it('waits for pump, overlaps only one command, and commits one ordered batch', () => {
    const harness = createBackendHarness();
    const input = [
      queued({ face: 'R', turns: 1 }, 'pair'),
      queued({ face: 'L', turns: 3 }, 'pair'),
    ];
    harness.animator.enqueue(input);

    (input[0] as { move: Move }).move = { face: 'U', turns: 2 };
    (input[0] as { provenance: CommitProvenance }).provenance =
      provenance('mutated');
    expect(harness.animator.isBusy).toBe(true);
    expect(harness.animator.isActive).toBe(false);
    expect(harness.animator.tick(1)).toBe(false);
    expect(harness.commits).toHaveLength(0);

    harness.animator.pump();
    expect(harness.animator.isActive).toBe(true);
    expect(harness.scene.getObjectByName('rubcube-turn-pivot-1')).toBeDefined();
    harness.animator.tick(1);

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]!.changes).toEqual([
      expect.objectContaining({
        move: { face: 'R', turns: 1 },
        provenance: provenance('pair'),
      }),
      expect.objectContaining({
        move: { face: 'L', turns: 3 },
        provenance: provenance('pair'),
      }),
    ]);
    expect(
      statesEqual(
        harness.commits[0]!.changes[0]!.state,
        applyMove(createSolvedState(), { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
    expect(
      statesEqual(
        harness.commits[0]!.finalState,
        applyMoves(createSolvedState(), "R L'"),
      ),
    ).toBe(true);
    expect(harness.syncVisuals).toHaveBeenCalledTimes(1);
  });

  it('keeps opposite faces from different commands in separate pumped groups', () => {
    const harness = createBackendHarness();
    harness.animator.enqueue([
      queued({ face: 'R', turns: 1 }, 'a'),
      queued({ face: 'L', turns: 1 }, 'b'),
    ]);

    harness.animator.pump();
    expect(harness.scene.getObjectByName('rubcube-turn-pivot-1')).toBeUndefined();
    harness.animator.tick(1);
    expect(harness.commits.map((commit) => commit.changes)).toHaveLength(1);
    expect(harness.commits[0]!.changes).toHaveLength(1);

    // No direct finishGroup handoff in canonical mode.
    expect(harness.animator.isActive).toBe(false);
    expect(harness.animator.tick(1)).toBe(false);
    harness.animator.pump();
    harness.animator.tick(1);
    expect(harness.commits).toHaveLength(2);
    expect(harness.commits[1]!.changes[0]).toMatchObject({
      move: { face: 'L', turns: 1 },
      provenance: provenance('b'),
    });
  });

  it('cancels an active group at the last integer state without a commit', () => {
    const harness = createBackendHarness();
    harness.animator.enqueue([
      queued({ face: 'R', turns: 1 }, 'cancelled'),
      queued({ face: 'U', turns: 1 }, 'cancelled'),
    ]);
    harness.animator.pump();
    harness.animator.tick(0.03);

    harness.animator.cancelPlayback('user stopped playback');

    expect(harness.commits).toHaveLength(0);
    expect(harness.ends).toHaveLength(0);
    expect(harness.animator.isBusy).toBe(false);
    expect(statesEqual(harness.animator.state, createSolvedState())).toBe(true);
    expect(harness.scene.getObjectByName('rubcube-turn-pivot-0')).toBeUndefined();
  });

  it('replaces active work with one synchronous move:null commit and finalState', () => {
    const harness = createBackendHarness();
    harness.animator.enqueue([
      queued({ face: 'R', turns: 1 }, 'replaced'),
    ]);
    harness.animator.pump();
    harness.animator.tick(0.03);
    const replacement = applyMoves(createSolvedState(), 'F2 U');

    harness.animator.replaceState(replacement);

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]!.changes).toEqual([
      expect.objectContaining({ move: null }),
    ]);
    expect(
      statesEqual(harness.commits[0]!.changes[0]!.state, replacement),
    ).toBe(true);
    expect(statesEqual(harness.commits[0]!.finalState, replacement)).toBe(true);
    expect(statesEqual(harness.animator.state, replacement)).toBe(true);
    expect(harness.animator.isBusy).toBe(false);
  });
});

describe('TurnAnimator MoveTransportBackend drag and failure lifecycle', () => {
  it('admits through beginInteractive, then reports rollback or committed provenance', () => {
    const harness = createBackendHarness();
    expect(
      harness.animator.beginInteractive('F', dragProvenance('drag-cancel')),
    ).toBe(true);
    expect(harness.animator.isActive).toBe(false);
    harness.animator.pump();
    harness.animator.setInteractiveAngle(Math.PI / 7);
    harness.animator.releaseInteractive();
    harness.animator.tick(1);

    expect(harness.commits).toHaveLength(0);
    expect(harness.ends).toEqual([
      expect.objectContaining({
        commandId: 'drag-cancel',
        status: 'cancelled',
      }),
    ]);

    expect(
      harness.animator.beginInteractive('U', dragProvenance('drag-commit')),
    ).toBe(true);
    harness.animator.pump();
    harness.animator.setInteractiveAngle(-Math.PI / 3);
    harness.animator.releaseInteractive();
    harness.animator.tick(1);

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]!.changes).toEqual([
      expect.objectContaining({
        move: { face: 'U', turns: 1 },
        provenance: dragProvenance('drag-commit'),
      }),
    ]);
  });

  it('fails unfinished backend work on dispose and stays silent when idle', () => {
    const active = createBackendHarness();
    active.animator.enqueue([
      queued({ face: 'R', turns: 1 }, 'unfinished'),
    ]);
    active.animator.dispose();
    expect(active.failures).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/unfinished/iu) }),
    ]);

    const idle = createBackendHarness();
    idle.animator.dispose();
    expect(idle.failures).toHaveLength(0);
  });
});

describe('CommitDispatcher with the real Three backend', () => {
  it('drains deferred cancel before pump can start the queued suffix', () => {
    const initialState = createSolvedState();
    const { scene, cubies, syncVisuals } = createVisuals(initialState);
    const events: DispatchEvent[] = [];
    let animator!: TurnAnimator;
    let dispatcher!: CommitDispatcher;
    dispatcher = new CommitDispatcher({
      initialState,
      createBackend: (sink) => {
        animator = new TurnAnimator(scene, cubies, initialState, {
          syncVisuals,
          transportSink: sink,
        });
        return animator;
      },
      onDispatch: (event) => {
        events.push(event);
        if ('changes' in event) dispatcher.cancelPlayback('stop at batch');
      },
    });

    dispatcher.enqueue(
      [
        { face: 'R', turns: 1 },
        { face: 'U', turns: 1 },
      ],
      { commandId: 'formula', intent: 'forward', origin: 'formula' },
    );
    expect(animator.isActive).toBe(true);
    animator.tick(1);

    expect(events.map(eventLabel)).toEqual([
      'batch:R',
      'end:formula:cancelled',
    ]);
    expect((events[0] as CommitBatch).changes).toHaveLength(1);
    expect((events[1] as CommandEnd).committedMoves).toBe(1);
    expect(animator.isBusy).toBe(false);
    expect(
      statesEqual(
        dispatcher.state,
        applyMove(createSolvedState(), { face: 'R', turns: 1 }),
      ),
    ).toBe(true);
  });
});
