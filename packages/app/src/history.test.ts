import {
  applyMove,
  applyMoves,
  cloneState,
  createSolvedState,
  invertMoves,
  parseMoves,
  statesEqual,
  type CubeState,
  type Move,
} from '@rubcube/cube-core';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_INTENTS,
  HISTORY_ENTRY_LIMIT,
  HistoryInvariantError,
  MOVE_ORIGINS,
  canRewind,
  canUndo,
  createCommittedHistory,
  getRewindMoves,
  getUndoMove,
  reduceHistoryBatch,
  replayHistory,
  type CommandIntent,
  type CommitProvenance,
  type CommittedHistory,
  type ForwardMoveOrigin,
  type HistoryCommitBatch,
  type HistoryEntry,
  type MoveOrigin,
} from './history.js';

// Derived from the shipped vocabulary, not re-listed: a new origin must widen
// the intent/origin cross product below rather than slip through untested.
const ALL_ORIGINS: readonly MoveOrigin[] = MOVE_ORIGINS;
const ALL_INTENTS: readonly CommandIntent[] = COMMAND_INTENTS;
const FORWARD_ORIGINS: readonly ForwardMoveOrigin[] = MOVE_ORIGINS.filter(
  (origin): origin is ForwardMoveOrigin => origin !== 'history',
);
const RANDOM_FACES = ['U', 'D', 'L', 'R', 'F', 'B'] as const;
const RANDOM_TURNS = [1, 2, 3] as const;

function moveBatch(
  start: CubeState,
  moves: readonly Move[],
  provenance: CommitProvenance,
  batchId: number,
): HistoryCommitBatch {
  let state = cloneState(start);
  const changes = moves.map((move) => {
    state = applyMove(state, move);
    return {
      state: cloneState(state),
      move: { face: move.face, turns: move.turns },
      provenance: { ...provenance },
    };
  });
  return { batchId, changes, finalState: cloneState(state) };
}

function replaceBatch(state: CubeState, batchId: number): HistoryCommitBatch {
  return {
    batchId,
    changes: [{ state: cloneState(state), move: null }],
    finalState: cloneState(state),
  };
}

function reduceForward(
  current: CommittedHistory,
  sequence: string,
  batchId = 1,
): CommittedHistory {
  return reduceHistoryBatch(
    current,
    moveBatch(
      current.cube,
      parseMoves(sequence),
      { commandId: `forward-${batchId}`, intent: 'forward', origin: 'formula' },
      batchId,
    ),
  );
}

/** Crosses the static type boundary deliberately so runtime guards are exercised. */
function uncheckedProvenance(
  commandId: string,
  intent: CommandIntent,
  origin: MoveOrigin,
): CommitProvenance {
  return { commandId, intent, origin } as unknown as CommitProvenance;
}

function createDeterministicRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function pickRandom<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)]!;
}

function randomMove(random: () => number): Move {
  return {
    face: pickRandom(RANDOM_FACES, random),
    turns: pickRandom(RANDOM_TURNS, random),
  };
}

function expectHistoryProperties(current: CommittedHistory, round: number): void {
  expect(
    statesEqual(replayHistory(current.history), current.cube),
    `round ${round}: baseState + entries must equal cube`,
  ).toBe(true);
  expect(current.history.entries.length).toBeLessThanOrEqual(HISTORY_ENTRY_LIMIT);
  expect(canUndo(current.history)).toBe(current.history.entries.length > 0);

  if (current.history.truncated) {
    expect(canRewind(current.history)).toBe(false);
    expect(getRewindMoves(current.history)).toBeNull();
    return;
  }

  const inverse = invertMoves(current.history.entries.map((entry) => entry.move));
  expect(getRewindMoves(current.history)).toEqual(inverse);
  expect(
    statesEqual(applyMoves(current.cube, inverse), current.history.baseState),
    `round ${round}: complete rewind must reach baseState`,
  ).toBe(true);
  expect(canRewind(current.history)).toBe(current.history.entries.length > 0);
}

describe('history checkpoint and forward commits', () => {
  it('creates independent cube and baseState snapshots', () => {
    const source = createSolvedState();
    const committed = createCommittedHistory(source);

    expect(statesEqual(committed.cube, source)).toBe(true);
    expect(statesEqual(committed.history.baseState, source)).toBe(true);
    expect(committed.cube.cp).not.toBe(source.cp);
    expect(committed.history.baseState.cp).not.toBe(source.cp);
    expect(committed.cube.cp).not.toBe(committed.history.baseState.cp);

    source.cp[0] = 7;
    expect(statesEqual(committed.cube, createSolvedState())).toBe(true);
    expect(statesEqual(committed.history.baseState, createSolvedState())).toBe(true);
  });

  it('folds every move snapshot in a batch and records provenance', () => {
    const initial = createCommittedHistory(createSolvedState());
    const moves = parseMoves("R L'");
    const result = reduceHistoryBatch(
      initial,
      moveBatch(
        initial.cube,
        moves,
        { commandId: 'formula-1', intent: 'forward', origin: 'formula' },
        10,
      ),
    );

    expect(result.history.entries).toEqual([
      { move: { face: 'R', turns: 1 }, origin: 'formula', commandId: 'formula-1' },
      { move: { face: 'L', turns: 3 }, origin: 'formula', commandId: 'formula-1' },
    ]);
    expect(statesEqual(result.cube, applyMoves(createSolvedState(), moves))).toBe(true);
    expect(statesEqual(replayHistory(result.history), result.cube)).toBe(true);
    expect(result.history.truncated).toBe(false);
    expect(canUndo(result.history)).toBe(true);
    expect(canRewind(result.history)).toBe(true);
  });

  it('accepts exactly the supported intent/origin provenance matrix at runtime', () => {
    let batchId = 100;

    for (const intent of ALL_INTENTS) {
      for (const origin of ALL_ORIGINS) {
        const initial = createCommittedHistory(createSolvedState());
        const current = reduceForward(initial, 'R', batchId++);
        const move = intent === 'forward' ? parseMoves('U')[0]! : getUndoMove(current.history)!;
        const provenance = uncheckedProvenance(
          `matrix-${intent}-${origin}`,
          intent,
          origin,
        );
        const reduce = (): CommittedHistory =>
          reduceHistoryBatch(current, moveBatch(current.cube, [move], provenance, batchId++));
        const allowed = intent === 'forward' ? origin !== 'history' : origin === 'history';

        if (allowed) {
          const result = reduce();
          if (intent === 'forward') {
            expect(result.history.entries.at(-1)?.origin).toBe(origin);
          } else {
            expect(result.history.entries).toEqual([]);
          }
        } else if (intent === 'forward') {
          expect(reduce).toThrow(/forward commits cannot use history origin/);
        } else {
          expect(reduce).toThrow(new RegExp(`${intent} commits must use history origin`));
        }
      }
    }
  });
});

describe('undo and rewind commits', () => {
  it('pops exactly one entry only after the inverse move commits', () => {
    const initial = createCommittedHistory(createSolvedState());
    const forward = reduceForward(initial, 'R U');
    const undo = getUndoMove(forward.history);

    expect(undo).toEqual({ face: 'U', turns: 3 });
    expect(forward.history.entries).toHaveLength(2);

    const result = reduceHistoryBatch(
      forward,
      moveBatch(
        forward.cube,
        [undo!],
        { commandId: 'undo-1', intent: 'undo', origin: 'history' },
        2,
      ),
    );

    expect(result.history.entries).toEqual([
      { move: { face: 'R', turns: 1 }, origin: 'formula', commandId: 'forward-1' },
    ]);
    expect(statesEqual(result.cube, applyMoves(createSolvedState(), 'R'))).toBe(true);
    expect(statesEqual(replayHistory(result.history), result.cube)).toBe(true);
  });

  it('rewinds in inverse order and preserves a partially committed prefix', () => {
    const initial = createCommittedHistory(createSolvedState());
    let current = reduceForward(initial, 'R U F');
    const rewind = getRewindMoves(current.history);

    expect(rewind).toEqual(parseMoves("F' U' R'"));
    expect(rewind).toEqual(invertMoves(parseMoves('R U F')));

    current = reduceHistoryBatch(
      current,
      moveBatch(
        current.cube,
        [rewind![0]!],
        { commandId: 'rewind-1', intent: 'rewind', origin: 'history' },
        2,
      ),
    );
    expect(current.history.entries.map((entry) => entry.move)).toEqual(parseMoves('R U'));
    expect(statesEqual(replayHistory(current.history), current.cube)).toBe(true);

    current = reduceHistoryBatch(
      current,
      moveBatch(
        current.cube,
        [rewind![1]!],
        { commandId: 'rewind-1', intent: 'rewind', origin: 'history' },
        3,
      ),
    );
    expect(current.history.entries.map((entry) => entry.move)).toEqual(parseMoves('R'));

    current = reduceHistoryBatch(
      current,
      moveBatch(
        current.cube,
        [rewind![2]!],
        { commandId: 'rewind-1', intent: 'rewind', origin: 'history' },
        4,
      ),
    );
    expect(current.history.entries).toEqual([]);
    expect(statesEqual(current.cube, createSolvedState())).toBe(true);
    expect(canUndo(current.history)).toBe(false);
    expect(canRewind(current.history)).toBe(false);
    expect(getUndoMove(current.history)).toBeNull();
    expect(getRewindMoves(current.history)).toEqual([]);
  });
});

describe('replace checkpoints', () => {
  it('resets entries and truncation around an arbitrary valid state', () => {
    const initial = createCommittedHistory(createSolvedState());
    const forward = reduceForward(initial, 'R U F');
    const replacement = applyMoves(createSolvedState(), 'B2 L D');
    const result = reduceHistoryBatch(forward, replaceBatch(replacement, 2));

    expect(statesEqual(result.cube, replacement)).toBe(true);
    expect(statesEqual(result.history.baseState, replacement)).toBe(true);
    expect(result.history.entries).toEqual([]);
    expect(result.history.truncated).toBe(false);
    expect(result.cube.cp).not.toBe(result.history.baseState.cp);
  });
});

describe('batch validation is atomic', () => {
  it('rejects a bad later snapshot without modifying the current cube or history', () => {
    const initial = createCommittedHistory(createSolvedState());
    const current = reduceForward(initial, 'R');
    const beforeCube = cloneState(current.cube);
    const beforeBase = cloneState(current.history.baseState);
    const beforeEntries = current.history.entries.map((entry) => ({
      ...entry,
      move: { ...entry.move },
    }));
    const valid = moveBatch(
      current.cube,
      parseMoves('U D'),
      { commandId: 'formula-2', intent: 'forward', origin: 'formula' },
      2,
    );
    const invalid: HistoryCommitBatch = {
      ...valid,
      changes: [
        valid.changes[0]!,
        { ...valid.changes[1]!, state: cloneState(valid.changes[0]!.state) },
      ],
    };

    let caught: unknown;
    try {
      reduceHistoryBatch(current, invalid);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HistoryInvariantError);
    expect(caught).toMatchObject({ batchId: 2, changeIndex: 1 });
    expect(statesEqual(current.cube, beforeCube)).toBe(true);
    expect(statesEqual(current.history.baseState, beforeBase)).toBe(true);
    expect(current.history.entries).toEqual(beforeEntries);
  });

  it('rejects a mismatched batch finalState', () => {
    const current = createCommittedHistory(createSolvedState());
    const valid = moveBatch(
      current.cube,
      parseMoves('R'),
      { commandId: 'manual-1', intent: 'forward', origin: 'manual' },
      7,
    );

    expect(() =>
      reduceHistoryBatch(current, { ...valid, finalState: createSolvedState() }),
    ).toThrow(HistoryInvariantError);
    expect(current.history.entries).toEqual([]);
    expect(statesEqual(current.cube, createSolvedState())).toBe(true);
  });

  it('rejects an undo that is not the latest move inverse', () => {
    const initial = createCommittedHistory(createSolvedState());
    const current = reduceForward(initial, 'R');
    const invalidUndo = moveBatch(
      current.cube,
      parseMoves("U'"),
      { commandId: 'undo-wrong', intent: 'undo', origin: 'history' },
      2,
    );

    expect(() => reduceHistoryBatch(current, invalidUndo)).toThrow(
      /not the inverse of the latest history entry/,
    );
    expect(current.history.entries.map((entry) => entry.move)).toEqual(parseMoves('R'));
  });
});

describe('history limit', () => {
  it('advances baseState when dropping the oldest of 1001 entries', () => {
    const baseState = createSolvedState();
    const oldMoves: Move[] = Array.from({ length: HISTORY_ENTRY_LIMIT }, () => ({
      face: 'U',
      turns: 1,
    }));
    const entries: HistoryEntry[] = oldMoves.map((move, index) => ({
      move,
      origin: 'manual',
      commandId: `manual-${index}`,
    }));
    const current: CommittedHistory = {
      cube: applyMoves(baseState, oldMoves),
      history: { baseState: cloneState(baseState), entries, truncated: false },
    };
    const result = reduceHistoryBatch(
      current,
      moveBatch(
        current.cube,
        parseMoves('R'),
        { commandId: 'manual-overflow', intent: 'forward', origin: 'manual' },
        1_001,
      ),
    );

    expect(result.history.entries).toHaveLength(HISTORY_ENTRY_LIMIT);
    expect(result.history.entries[0]?.commandId).toBe('manual-1');
    expect(result.history.entries.at(-1)).toEqual({
      move: { face: 'R', turns: 1 },
      origin: 'manual',
      commandId: 'manual-overflow',
    });
    expect(statesEqual(result.history.baseState, applyMove(baseState, oldMoves[0]!))).toBe(
      true,
    );
    expect(statesEqual(replayHistory(result.history), result.cube)).toBe(true);
    expect(result.history.truncated).toBe(true);
    expect(canUndo(result.history)).toBe(true);
    expect(canRewind(result.history)).toBe(false);
    expect(getRewindMoves(result.history)).toBeNull();

    const inverse = invertMoves(result.history.entries.map((entry) => entry.move));
    expect(() =>
      reduceHistoryBatch(
        result,
        moveBatch(
          result.cube,
          [inverse[0]!],
          { commandId: 'invalid-rewind', intent: 'rewind', origin: 'history' },
          1_002,
        ),
      ),
    ).toThrow(/rewind cannot run after history truncation/);

    const undo = getUndoMove(result.history);
    expect(undo).toEqual({ face: 'R', turns: 3 });
    const undone = reduceHistoryBatch(
      result,
      moveBatch(
        result.cube,
        [undo!],
        { commandId: 'truncated-undo', intent: 'undo', origin: 'history' },
        1_003,
      ),
    );
    expect(undone.history.entries).toHaveLength(HISTORY_ENTRY_LIMIT - 1);
    expect(undone.history.truncated).toBe(true);
    expect(statesEqual(replayHistory(undone.history), undone.cube)).toBe(true);

    const replacement = applyMoves(createSolvedState(), 'F2 D B');
    const replaced = reduceHistoryBatch(undone, replaceBatch(replacement, 1_004));
    expect(replaced.history.truncated).toBe(false);
    expect(replaced.history.entries).toEqual([]);
    expect(statesEqual(replaced.history.baseState, replacement)).toBe(true);
    expect(getRewindMoves(replaced.history)).toEqual([]);

    const afterReplace = reduceHistoryBatch(
      replaced,
      moveBatch(
        replaced.cube,
        parseMoves('L'),
        { commandId: 'post-replace', intent: 'forward', origin: 'manual' },
        1_005,
      ),
    );
    expect(canRewind(afterReplace.history)).toBe(true);
    expect(getRewindMoves(afterReplace.history)).toEqual(parseMoves("L'"));
  });
});

describe('deterministic history state machine', () => {
  it('preserves replay and rewind properties for at least 1000 mixed batches', () => {
    const random = createDeterministicRandom(0x5eed_c0de);
    const operationCounts = { forward: 0, undo: 0, rewind: 0, replace: 0 };
    let current = createCommittedHistory(createSolvedState());
    let batchId = 10_000;

    for (let round = 0; round < 1_200; round += 1) {
      const choice = Math.floor(random() * 100);

      if (choice < 55 || current.history.entries.length === 0) {
        const moveCount = random() < 0.3 ? 2 : 1;
        const moves = Array.from({ length: moveCount }, () => randomMove(random));
        const origin = pickRandom(FORWARD_ORIGINS, random);
        current = reduceHistoryBatch(
          current,
          moveBatch(
            current.cube,
            moves,
            { commandId: `random-forward-${round}`, intent: 'forward', origin },
            batchId++,
          ),
        );
        operationCounts.forward += 1;
      } else if (choice < 70) {
        const undo = getUndoMove(current.history)!;
        current = reduceHistoryBatch(
          current,
          moveBatch(
            current.cube,
            [undo],
            { commandId: `random-undo-${round}`, intent: 'undo', origin: 'history' },
            batchId++,
          ),
        );
        operationCounts.undo += 1;
      } else if (choice < 90 && !current.history.truncated) {
        const rewind = getRewindMoves(current.history)!;
        const committedPrefix = rewind.slice(0, Math.min(rewind.length, random() < 0.5 ? 1 : 2));
        current = reduceHistoryBatch(
          current,
          moveBatch(
            current.cube,
            committedPrefix,
            { commandId: `random-rewind-${round}`, intent: 'rewind', origin: 'history' },
            batchId++,
          ),
        );
        operationCounts.rewind += 1;
      } else {
        const replacementMoves = Array.from(
          { length: Math.floor(random() * 9) },
          () => randomMove(random),
        );
        const replacement = applyMoves(createSolvedState(), replacementMoves);
        current = reduceHistoryBatch(current, replaceBatch(replacement, batchId++));
        operationCounts.replace += 1;
      }

      expectHistoryProperties(current, round);
    }

    expect(operationCounts.forward).toBeGreaterThan(0);
    expect(operationCounts.undo).toBeGreaterThan(0);
    expect(operationCounts.rewind).toBeGreaterThan(0);
    expect(operationCounts.replace).toBeGreaterThan(0);
  });
});

describe('defensive copies', () => {
  it('does not retain mutable state, move, provenance, or prior-entry inputs', () => {
    const initial = createCommittedHistory(createSolvedState());
    const move: Move = { face: 'R', turns: 1 };
    const provenance: CommitProvenance = {
      commandId: 'manual-copy',
      intent: 'forward',
      origin: 'manual',
    };
    const committedState = applyMove(initial.cube, move);
    const expected = cloneState(committedState);
    const batch: HistoryCommitBatch = {
      batchId: 1,
      changes: [{ state: committedState, move, provenance }],
      finalState: cloneState(committedState),
    };
    const first = reduceHistoryBatch(initial, batch);
    const second = reduceHistoryBatch(
      first,
      moveBatch(
        first.cube,
        parseMoves('U'),
        { commandId: 'manual-copy-2', intent: 'forward', origin: 'manual' },
        2,
      ),
    );

    (move as { face: Move['face'] }).face = 'F';
    (provenance as { origin: CommitProvenance['origin'] }).origin = 'formula';
    committedState.cp[0] = 7;
    batch.finalState.ep[0] = 11;

    // Committed entries are frozen rather than re-copied on every later commit,
    // so reaching into an earlier result cannot corrupt a later one. This is the
    // stronger half of the same guarantee: the write is refused outright instead
    // of being tolerated by cloning the whole history on each batch.
    expect(Object.isFrozen(first.history.entries)).toBe(true);
    expect(Object.isFrozen(first.history.entries[0])).toBe(true);
    expect(() => {
      (first.history.entries[0]!.move as { face: Move['face'] }).face = 'B';
    }).toThrow(TypeError);

    expect(first.history.entries[0]).toMatchObject({
      origin: 'manual',
      commandId: 'manual-copy',
    });
    expect(statesEqual(first.cube, expected)).toBe(true);
    expect(second.history.entries[0]).toEqual({
      move: { face: 'R', turns: 1 },
      origin: 'manual',
      commandId: 'manual-copy',
    });
    expect(statesEqual(second.history.baseState, createSolvedState())).toBe(true);
    expect(statesEqual(replayHistory(second.history), second.cube)).toBe(true);
  });
});
