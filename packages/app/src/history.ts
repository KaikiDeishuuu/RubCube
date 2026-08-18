import {
  applyMove,
  applyMoves,
  assertMove,
  assertValidState,
  cloneState,
  invertMove,
  invertMoves,
  statesEqual,
  type CubeState,
  type Move,
} from '@rubcube/cube-core';
import { isCommandIntent, isMoveOrigin } from '@rubcube/cube-render/transport';
import type {
  CommitBatch,
  CommitProvenance,
  ForwardMoveOrigin,
} from '@rubcube/cube-render/transport';

export type {
  CommandIntent,
  CommitProvenance,
  ForwardMoveOrigin,
  MoveOrigin,
} from '@rubcube/cube-render/transport';

/** Re-exported so the app layer never re-lists the vocabulary for itself. */
export {
  COMMAND_INTENTS,
  MOVE_ORIGINS,
} from '@rubcube/cube-render/transport';

export const HISTORY_ENTRY_LIMIT = 1_000;

/** The reducer consumes the transport contract directly, without a parallel shape. */
export type HistoryCommitBatch = CommitBatch;

export interface HistoryEntry {
  readonly move: Move;
  readonly origin: ForwardMoveOrigin;
  readonly commandId: string;
}

export interface HistoryState {
  /** Deep-cloned state at the latest replace/reset/import checkpoint. */
  readonly baseState: CubeState;
  readonly entries: readonly HistoryEntry[];
  readonly truncated: boolean;
}

/** The two store fields that must be published in one transaction. */
export interface CommittedHistory {
  readonly cube: CubeState;
  readonly history: HistoryState;
}

export class HistoryInvariantError extends Error {
  readonly batchId: number | null;
  readonly changeIndex: number | null;

  constructor(
    message: string,
    batchId: number | null = null,
    changeIndex: number | null = null,
  ) {
    super(message);
    this.name = 'HistoryInvariantError';
    this.batchId = batchId;
    this.changeIndex = changeIndex;
  }
}

function fail(
  message: string,
  batchId: number | null = null,
  changeIndex: number | null = null,
): never {
  throw new HistoryInvariantError(message, batchId, changeIndex);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertState(
  state: CubeState,
  label: string,
  batchId: number | null = null,
  changeIndex: number | null = null,
): void {
  try {
    assertValidState(state);
  } catch (error) {
    fail(`${label} is invalid: ${errorDetail(error)}`, batchId, changeIndex);
  }
}

function cloneMove(move: Move, batchId: number | null, changeIndex: number | null): Move {
  try {
    assertMove(move);
  } catch (error) {
    fail(`Move is invalid: ${errorDetail(error)}`, batchId, changeIndex);
  }
  return { face: move.face, turns: move.turns };
}

function cloneProvenance(
  provenance: CommitProvenance | undefined,
  batchId: number,
  changeIndex: number,
): CommitProvenance {
  if (provenance === undefined) {
    fail('Move commit is missing provenance', batchId, changeIndex);
  }
  const candidate: {
    readonly commandId: unknown;
    readonly intent: unknown;
    readonly origin: unknown;
  } = provenance;
  const { commandId, intent, origin } = candidate;
  if (typeof commandId !== 'string' || commandId.length === 0) {
    fail('Move commit has an empty commandId', batchId, changeIndex);
  }
  if (!isCommandIntent(intent)) {
    fail(`Move commit has invalid intent ${String(intent)}`, batchId, changeIndex);
  }
  if (!isMoveOrigin(origin)) {
    fail(`Move commit has invalid origin ${String(origin)}`, batchId, changeIndex);
  }
  if (intent === 'forward') {
    if (origin === 'history') {
      fail('forward commits cannot use history origin', batchId, changeIndex);
    }
    return { commandId, intent, origin };
  }
  if (origin !== 'history') {
    fail(`${intent} commits must use history origin`, batchId, changeIndex);
  }
  return { commandId, intent, origin };
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  if (typeof entry.commandId !== 'string' || entry.commandId.length === 0) {
    fail('History contains an entry with an empty commandId');
  }
  const origin: unknown = entry.origin;
  if (!isMoveOrigin(origin) || origin === 'history') {
    fail(`History contains an entry with invalid origin ${String(origin)}`);
  }
  return {
    move: cloneMove(entry.move, null, null),
    origin,
    commandId: entry.commandId,
  };
}

function sameMove(left: Move, right: Move): boolean {
  return left.face === right.face && left.turns === right.turns;
}

function sameProvenance(left: CommitProvenance, right: CommitProvenance): boolean {
  return (
    left.commandId === right.commandId &&
    left.intent === right.intent &&
    left.origin === right.origin
  );
}

function replay(
  baseState: CubeState,
  entries: readonly HistoryEntry[],
  batchId: number | null,
  changeIndex: number | null,
): CubeState {
  try {
    return applyMoves(
      baseState,
      entries.map((entry) => entry.move),
    );
  } catch (error) {
    fail(`History cannot be replayed: ${errorDetail(error)}`, batchId, changeIndex);
  }
}

/** Create an empty, independently-owned checkpoint for the app store. */
export function createCommittedHistory(baseState: CubeState): CommittedHistory {
  assertState(baseState, 'Checkpoint state');
  return {
    cube: cloneState(baseState),
    history: {
      baseState: cloneState(baseState),
      entries: [],
      truncated: false,
    },
  };
}

/** Replay a history into a fresh CubeState. Primarily useful for diagnostics/tests. */
export function replayHistory(history: HistoryState): CubeState {
  assertState(history.baseState, 'History baseState');
  return replay(history.baseState, history.entries.map(cloneEntry), null, null);
}

export function canUndo(history: HistoryState): boolean {
  return history.entries.length > 0;
}

export function canRewind(history: HistoryState): boolean {
  return !history.truncated && history.entries.length > 0;
}

/** Return a fresh inverse move, or null when there is nothing to undo. */
export function getUndoMove(history: HistoryState): Move | null {
  const last = history.entries.at(-1);
  return last === undefined ? null : invertMove(last.move);
}

/** Return null when truncation makes a complete rewind unknowable. */
export function getRewindMoves(history: HistoryState): Move[] | null {
  if (history.truncated) return null;
  return invertMoves(history.entries.map((entry) => entry.move));
}

/**
 * Fold one already-committed transport batch without mutating any input.
 *
 * Every intermediate change is checked against `baseState + entries`, and the
 * final state is checked separately. Callers can therefore calculate this
 * result before a single Zustand `set`, preserving batch atomicity even when a
 * later change is malformed.
 */
export function reduceHistoryBatch(
  current: CommittedHistory,
  batch: HistoryCommitBatch,
): CommittedHistory {
  if (!Number.isSafeInteger(batch.batchId) || batch.batchId < 0) {
    fail(`Invalid batchId ${String(batch.batchId)}`);
  }
  if (batch.changes.length === 0) {
    fail('CommitBatch must contain at least one change', batch.batchId);
  }
  if (typeof current.history.truncated !== 'boolean') {
    fail('History truncated flag must be boolean');
  }
  if (current.history.entries.length > HISTORY_ENTRY_LIMIT) {
    fail(`History exceeds the ${HISTORY_ENTRY_LIMIT}-entry limit`);
  }

  assertState(current.cube, 'Current cube');
  assertState(current.history.baseState, 'History baseState');

  let baseState = cloneState(current.history.baseState);
  // Entries are deeply immutable and are only ever appended, popped or shifted
  // here, so a shallow copy already keeps `current` untouched. Cloning and
  // revalidating all of them would put the whole history on every commit.
  const entries = [...current.history.entries];
  let truncated = current.history.truncated;

  // Induction anchor for the per-change check below. This function's own
  // postcondition is that `cube` equals `baseState` replayed through `entries`,
  // so advancing that state one move at a time is equivalent to replaying the
  // whole history per change, at one applyMove instead of one per entry.
  let batchProvenance: CommitProvenance | null = null;
  let committedState = cloneState(current.cube);

  for (let index = 0; index < batch.changes.length; index += 1) {
    const change = batch.changes[index]!;
    assertState(change.state, 'Committed change state', batch.batchId, index);

    if (change.move === null) {
      if (batch.changes.length !== 1) {
        fail('Replace must be the only change in its batch', batch.batchId, index);
      }
      if (change.provenance !== undefined) {
        fail('Replace change must not have provenance', batch.batchId, index);
      }
      baseState = cloneState(change.state);
      entries.length = 0;
      truncated = false;
      // A replace is a checkpoint: baseState + an empty history is the state
      // itself, so there is nothing to verify it against.
      committedState = cloneState(change.state);
    } else {
      const move = cloneMove(change.move, batch.batchId, index);
      const provenance = cloneProvenance(change.provenance, batch.batchId, index);
      if (batchProvenance === null) {
        batchProvenance = provenance;
      } else if (!sameProvenance(batchProvenance, provenance)) {
        fail('All move changes in a batch must share provenance', batch.batchId, index);
      }

      if (provenance.intent === 'forward') {
        // Frozen on creation rather than deep-copied on every later commit.
        // That keeps a caller from mutating an entry it can still reach through
        // an earlier result, which is what copying used to defend against, and
        // it makes sharing entry objects between successive results safe.
        entries.push(Object.freeze({
          move: Object.freeze(move),
          origin: provenance.origin,
          commandId: provenance.commandId,
        }));
        while (entries.length > HISTORY_ENTRY_LIMIT) {
          const oldest = entries.shift();
          if (oldest === undefined) {
            fail('History truncation lost its oldest entry', batch.batchId, index);
          }
          baseState = applyMove(baseState, oldest.move);
          truncated = true;
        }
      } else {
        if (provenance.intent === 'rewind' && truncated) {
          fail('rewind cannot run after history truncation', batch.batchId, index);
        }
        if (provenance.intent === 'undo' && batch.changes.length !== 1) {
          fail('undo must commit exactly one move', batch.batchId, index);
        }
        const last = entries.at(-1);
        if (last === undefined) {
          fail(`${provenance.intent} cannot pop an empty history`, batch.batchId, index);
        }
        const expected = invertMove(last.move);
        if (!sameMove(move, expected)) {
          fail(
            `${provenance.intent} move is not the inverse of the latest history entry`,
            batch.batchId,
            index,
          );
        }
        entries.pop();
      }

      // Appending `move` and undoing the entry that `move` inverts are the same
      // single step away from the running state, and truncation only shifts a
      // move from `entries` into `baseState`, so their sum is unchanged. One
      // applyMove therefore proves the same thing a full replay would.
      committedState = applyMove(committedState, move);
      if (!statesEqual(committedState, change.state)) {
        fail(
          'Committed change state does not match baseState + committed entries',
          batch.batchId,
          index,
        );
      }
    }
  }

  assertState(batch.finalState, 'CommitBatch finalState', batch.batchId);
  if (!statesEqual(committedState, batch.finalState)) {
    fail('CommitBatch finalState does not match its last change', batch.batchId);
  }

  return {
    cube: cloneState(batch.finalState),
    history: {
      baseState,
      // Sealed once this result is published, so the next commit can share
      // these entry objects instead of rebuilding the list.
      entries: Object.freeze(entries),
      truncated,
    },
  };
}
