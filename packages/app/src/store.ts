import {
  createSolvedState,
  type CubeState,
} from '@rubcube/cube-core';
import type {
  CommandEnd,
  CommitBatch,
  DispatchEvent,
} from '@rubcube/cube-render/transport';
import { create } from 'zustand';

import {
  createCommittedHistory,
  reduceHistoryBatch,
  type HistoryState,
} from './history.js';
import {
  DEFAULT_TIMER_CONFIG,
  IDLE_TIMER,
  rawDurationMs,
  reduceTimer,
  type Penalty,
  type TimerConfig,
  type TimerEvent,
  type TimerState,
} from './timer.js';

export type RenderMode = 'booting' | 'webgl' | 'fallback';

export interface SolveResult {
  readonly id: number;
  /** Wall clock at the moment the solve finished, for ordering and export. */
  readonly recordedAt: number;
  /** Solve length before any penalty; the penalty is applied when read. */
  readonly rawMs: number;
  readonly penalty: Penalty;
  readonly scramble: string;
  readonly scrambleSeed: number | null;
}

export interface FatalInvariant {
  readonly name: string;
  readonly message: string;
}

/** Structurally compatible with CommitDispatcher, without retaining it in state. */
export interface TransportStatus {
  readonly isBusy: boolean;
  readonly isFatal: boolean;
  readonly commandRevision: number;
}

export interface CubeStore {
  cube: CubeState;
  history: HistoryState;
  lastCommandEnd: CommandEnd | null;
  fatalInvariant: FatalInvariant | null;
  commandRevision: number;
  transportBusy: boolean;
  transportFatal: boolean;
  renderMode: RenderMode;
  renderDetail: string | null;
  formula: string;
  formulaError: string | null;
  scramble: string;
  scrambleSeed: number | null;
  lastAction: string;
  timer: TimerState;
  timerConfig: TimerConfig;
  results: readonly SolveResult[];

  /**
   * @deprecated Bootstrap-only checkpoint hydration. Runtime state changes must
   * go through MoveTransport so cancellation, revision and provenance stay intact.
   */
  setCube: (cube: CubeState) => void;
  commitBatch: (batch: CommitBatch) => void;
  recordCommandEnd: (event: CommandEnd) => void;
  handleDispatchEvent: (event: DispatchEvent) => void;
  enterDispatchFatal: (
    event: DispatchEvent,
    latestState: CubeState,
    error: unknown,
  ) => void;
  syncTransportStatus: (status: TransportStatus) => void;
  setRenderMode: (mode: RenderMode, detail?: string | null) => void;
  setFormula: (formula: string) => void;
  setFormulaError: (message: string | null) => void;
  setScramble: (scramble: string, seed: number | null) => void;
  setLastAction: (label: string) => void;
  hydrateResults: (results: readonly SolveResult[]) => void;
  dispatchTimer: (event: TimerEvent) => void;
  setInspection: (enabled: boolean) => void;
  setResultPenalty: (id: number, penalty: Penalty) => void;
  deleteResult: (id: number) => void;
  clearResults: () => void;
}

function cloneCommandEnd(event: CommandEnd): CommandEnd {
  const commandId = event.commandId;
  const status = event.status;
  const committedMoves = event.committedMoves;

  if (typeof commandId !== 'string' || commandId.length === 0) {
    throw new TypeError('CommandEnd.commandId must be a non-empty string');
  }
  if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
    throw new TypeError(`Invalid CommandEnd status ${String(status)}`);
  }
  if (!Number.isSafeInteger(committedMoves) || committedMoves < 0) {
    throw new RangeError('CommandEnd.committedMoves must be a non-negative safe integer');
  }
  if (event.reason !== undefined && typeof event.reason !== 'string') {
    throw new TypeError('CommandEnd.reason must be a string when provided');
  }

  const copy = { commandId, status, committedMoves };
  return event.reason === undefined ? copy : { ...copy, reason: event.reason };
}

function fatalInvariant(error: unknown): FatalInvariant {
  try {
    if (error instanceof Error) {
      const rawName: unknown = error.name;
      const rawMessage: unknown = error.message;
      return {
        name:
          typeof rawName === 'string' && rawName.length > 0
            ? rawName
            : 'Error',
        message:
          typeof rawMessage === 'string' && rawMessage.length > 0
            ? rawMessage
            : 'Unknown dispatch failure',
      };
    }
  } catch {
    // Proxies and hostile Error subclasses may throw from prototype/property
    // access. Fall through to the fully guarded string conversion below.
  }

  let message = 'Unknown dispatch failure';
  try {
    const rendered = String(error);
    if (rendered.length > 0) message = rendered;
  } catch {
    // A hostile thrown value may itself fail string conversion. Keep the stable
    // fallback rather than letting diagnostics obscure the original failure.
  }
  return { name: 'Error', message };
}

function isReplaceBatch(batch: CommitBatch): boolean {
  return batch.changes.length === 1 && batch.changes[0]?.move === null;
}

export function createCubeStore(initialState: CubeState = createSolvedState()) {
  const initial = createCommittedHistory(initialState);
  // This compatibility gate is deliberately outside Zustand state: changing the
  // render mode back to "booting" (for example during a StrictMode remount) must
  // not reopen a direct-write path after a transport has existed.
  let bootstrapCheckpointOpen = true;
  // Outside Zustand state because it must keep rising across a cleared session:
  // reusing an id would let a penalty edit land on the wrong solve.
  let nextResultId = 0;
  // Restoring twice would duplicate a whole session, and a late restore
  // arriving after the player has started solving must not replace their work.
  let resultsHydrated = false;

  return create<CubeStore>((set, get) => ({
    cube: initial.cube,
    history: initial.history,
    lastCommandEnd: null,
    fatalInvariant: null,
    commandRevision: 0,
    transportBusy: false,
    transportFatal: false,
    renderMode: 'booting',
    renderDetail: null,
    formula: "R U R' U'",
    formulaError: null,
    scramble: '',
    scrambleSeed: null,
    lastAction: 'Ready',
    timer: IDLE_TIMER,
    timerConfig: DEFAULT_TIMER_CONFIG,
    results: [],

    setCube: (cube) => {
      set((state) => {
        if (
          !bootstrapCheckpointOpen ||
          state.renderMode !== 'booting' ||
          state.transportBusy ||
          state.transportFatal ||
          state.commandRevision !== 0 ||
          state.lastCommandEnd !== null ||
          state.fatalInvariant !== null ||
          state.history.entries.length !== 0 ||
          state.history.truncated
        ) {
          throw new Error(
            'setCube is bootstrap-only; runtime state changes must use MoveTransport',
          );
        }
        const checkpoint = createCommittedHistory(cube);
        return { cube: checkpoint.cube, history: checkpoint.history };
      });
    },

    commitBatch: (batch) => {
      bootstrapCheckpointOpen = false;
      set((state) => {
        // The reducer clones and validates the whole batch before this updater
        // returns. A throw therefore leaves Zustand's previous object untouched
        // and publishes no half-applied history.
        const committed = reduceHistoryBatch(
          { cube: state.cube, history: state.history },
          batch,
        );
        return isReplaceBatch(batch)
          ? {
              ...committed,
              fatalInvariant: null,
              transportFatal: false,
              lastCommandEnd: null,
            }
          : committed;
      });
    },

    recordCommandEnd: (event) => {
      bootstrapCheckpointOpen = false;
      const copy = cloneCommandEnd(event);
      set({ lastCommandEnd: copy });
    },

    handleDispatchEvent: (event) => {
      if ('changes' in event) get().commitBatch(event);
      else get().recordCommandEnd(event);
    },

    enterDispatchFatal: (event, latestState, error) => {
      bootstrapCheckpointOpen = false;
      const checkpoint = createCommittedHistory(latestState);
      const diagnostic = fatalInvariant(error);
      set((state) => {
        // A CommandEnd-handler failure happens after its preceding batches were
        // published, so preserve that valid history. A CommitBatch failure may
        // represent a same-facelet replace checkpoint, so state equality alone
        // cannot distinguish the two event semantics.
        if (!('changes' in event)) {
          return {
            fatalInvariant: diagnostic,
            transportBusy: false,
            transportFatal: true,
          };
        }
        return {
          cube: checkpoint.cube,
          history: checkpoint.history,
          fatalInvariant: diagnostic,
          transportBusy: false,
          transportFatal: true,
        };
      });
    },

    syncTransportStatus: (status) => {
      if (typeof status.isBusy !== 'boolean') {
        throw new TypeError('Transport isBusy must be boolean');
      }
      if (typeof status.isFatal !== 'boolean') {
        throw new TypeError('Transport isFatal must be boolean');
      }
      if (!Number.isSafeInteger(status.commandRevision) || status.commandRevision < 0) {
        throw new RangeError('Transport commandRevision must be a non-negative safe integer');
      }
      const transportBusy = status.isBusy;
      const transportFatal = status.isFatal;
      const commandRevision = status.commandRevision;
      // Calling this method proves a transport has been installed, even when its
      // initial status is the otherwise indistinguishable idle revision zero.
      bootstrapCheckpointOpen = false;
      set((state) => {
        // A stale transport callback must never make an old solver/tutorial
        // snapshot look current again. Replacement transports are seeded from
        // this value when constructed, so a regression is always stale.
        if (commandRevision < state.commandRevision) return state;
        return state.transportBusy === transportBusy &&
          state.transportFatal === transportFatal &&
          state.commandRevision === commandRevision
          ? state
          : { transportBusy, transportFatal, commandRevision };
      });
    },

    setRenderMode: (renderMode, renderDetail = null) => {
      if (renderMode !== 'booting') bootstrapCheckpointOpen = false;
      set({ renderMode, renderDetail });
    },
    setFormula: (formula) => set({ formula, formulaError: null }),
    setFormulaError: (formulaError) => set({ formulaError }),
    setScramble: (scramble, scrambleSeed) => set({ scramble, scrambleSeed }),
    setLastAction: (lastAction) => set({ lastAction }),

    hydrateResults: (loaded) => {
      set((state) => {
        if (resultsHydrated) return state;
        resultsHydrated = true;
        if (loaded.length === 0 && state.results.length === 0) return state;

        nextResultId = loaded.reduce((max, result) => Math.max(max, result.id), 0);
        // A solve finished while the restore was still in flight keeps its
        // place at the end of the session, but is renumbered above everything
        // restored: it was recorded against an id counter that started at zero
        // and would otherwise collide with a restored solve.
        const pending = state.results.map((result) => {
          nextResultId += 1;
          return { ...result, id: nextResultId };
        });
        return { results: [...loaded, ...pending] };
      });
    },

    dispatchTimer: (event) => {
      set((state) => {
        const timer = reduceTimer(state.timer, event, state.timerConfig);
        // The machine returns its input unchanged for every event a finished
        // attempt ignores, so this identity check is what keeps a repeated
        // `solved` from appending a second copy of the same solve — not only a
        // guard against a needless rerender.
        if (timer === state.timer) return state;
        if (timer.phase !== 'stopped') return { timer };
        const rawMs = rawDurationMs(timer);
        if (rawMs === null) return { timer };

        nextResultId += 1;
        return {
          timer,
          results: [
            ...state.results,
            {
              id: nextResultId,
              recordedAt: Date.now(),
              rawMs,
              penalty: timer.penalty,
              scramble: state.scramble,
              scrambleSeed: state.scrambleSeed,
            },
          ],
        };
      });
    },

    setInspection: (enabled) => {
      set((state) => {
        if (state.timerConfig.inspection === enabled) return state;
        // Changing the rule mid-attempt would score that attempt under a rule
        // it was not run to, so the live attempt is abandoned rather than
        // silently re-judged.
        const timer = state.timer.phase === 'idle' ? state.timer : IDLE_TIMER;
        return { timer, timerConfig: { ...state.timerConfig, inspection: enabled } };
      });
    },

    setResultPenalty: (id, penalty) => {
      set((state) => {
        const index = state.results.findIndex((result) => result.id === id);
        if (index === -1 || state.results[index]?.penalty === penalty) return state;
        const results = [...state.results];
        results[index] = { ...results[index]!, penalty };
        return { results };
      });
    },

    deleteResult: (id) => {
      set((state) => {
        const results = state.results.filter((result) => result.id !== id);
        return results.length === state.results.length ? state : { results };
      });
    },

    clearResults: () => {
      set((state) => (state.results.length === 0 ? state : { results: [] }));
    },
  }));
}

export const useCubeStore = createCubeStore();
