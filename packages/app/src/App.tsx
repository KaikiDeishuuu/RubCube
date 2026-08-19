import {
  createSolvedState,
  generateRandomMoves,
  isSolved,
  MoveParseError,
  parseMoves,
  serializeMove,
  serializeMoves,
  toFacelets,
  type Face,
  type Move,
} from '@rubcube/cube-core';
import {
  createFaceletSvg,
  supportsWebGL,
} from '@rubcube/cube-render/fallback';
import { moveForKey } from '@rubcube/cube-render/keyboard';
import type { CubeRenderer as CubeRendererInstance } from '@rubcube/cube-render/renderer';
import type {
  CommitDispatcher,
  EnqueueMoveOrigin,
} from '@rubcube/cube-render/transport';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { createAppDispatcher } from './app-transport.js';
import { createSolveArchive } from './archive.js';
import { TurnAudio } from './audio.js';
import { FallbackMoveTransportBackend } from './fallback-transport.js';
import {
  canRewind,
  canUndo,
  getRewindMoves,
  getUndoMove,
} from './history.js';
import { readSoundEnabled, writeSoundEnabled } from './preferences.js';
import { formatStat, summarise, toCsv } from './stats.js';
import { useCubeStore } from './store.js';
import {
  PENALTIES,
  formatMs,
  formatResult,
  readTimer,
  type Penalty,
  type TimerPhase,
} from './timer.js';

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'] as const;

const FACE_NAMES: Readonly<Record<Face, string>> = {
  U: 'Up',
  R: 'Right',
  F: 'Front',
  D: 'Down',
  L: 'Left',
  B: 'Back',
};

const KEY_HINTS = [
  ['J / F', "U / U'"],
  ['I / K', "R / R'"],
  ['E / D', "L / L'"],
  ['H / G', "F / F'"],
  ['S / L', "D / D'"],
  ['W / O', "B / B'"],
] as const;

/** Phases in which the cube is under the timer's control, not the player's. */
const LOCKED_PHASES: ReadonlySet<TimerPhase> = new Set<TimerPhase>([
  'inspecting',
  'holding',
  'armed',
]);

/** Phases whose readout changes every frame. */
const LIVE_PHASES: ReadonlySet<TimerPhase> = new Set<TimerPhase>([
  ...LOCKED_PHASES,
  'running',
]);

const PENALTY_LABEL: Readonly<Record<Penalty, string>> = {
  none: 'OK',
  plus2: '+2',
  dnf: 'DNF',
};

/**
 * How long edits are coalesced before a session is written.
 *
 * Long enough that clicking through several penalty chips is one write, short
 * enough that a finished solve is durable well before the next one starts.
 */
const SAVE_DEBOUNCE_MS = 400;

let nextCommandSerial = 1;

function createCommandId(kind: string): string {
  const serial = nextCommandSerial;
  nextCommandSerial += 1;
  return `${kind}-${Date.now().toString(36)}-${serial.toString(36)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof MoveParseError) {
    return `第 ${error.tokenIndex + 1} 个记号“${error.token}”无效。仅支持 U D L R F B，可加 ' 或 2。`;
  }
  return error instanceof Error ? error.message : '无法解析这组公式。';
}

/** `code` covers layouts where the space key does not produce a plain space. */
/**
 * Whether the primary pointer is a finger.
 *
 * The timer is a hold, and the two ways to hold are the space bar and the pad;
 * a phone has no space bar, so telling a touch visitor to hold one is wrong.
 */
function matchesCoarsePointer(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches;
}

function isSpace(event: KeyboardEvent): boolean {
  return event.code === 'Space' || event.key === ' ';
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function makeSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] ?? 0;
  }

  const highResolution =
    typeof performance === 'undefined' ? 0 : Math.floor(performance.now() * 1_000);
  return (Date.now() ^ highResolution) >>> 0;
}

interface FaceletFallbackProps {
  readonly facelets: string;
}

function FaceletFallback({ facelets }: FaceletFallbackProps) {
  const markup = useMemo(
    () =>
      createFaceletSvg(facelets, {
        className: 'facelet-net',
        title: 'RubCube 2D facelet net',
        ariaLabel: '当前魔方的二维展开图',
      }),
    [facelets],
  );

  return (
    <div
      className="facelet-fallback"
      // createFaceletSvg validates the authoritative state and escapes every
      // string it emits; keeping the SVG as markup also avoids a React/DOM
      // ownership split when its 54 stickers update.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CubeRendererInstance | null>(null);
  const transportRef = useRef<CommitDispatcher | null>(null);
  const audioRef = useRef<TurnAudio | null>(null);
  const timerDigitsRef = useRef<HTMLSpanElement>(null);
  const [soundEnabled, setSoundEnabled] = useState(readSoundEnabled);
  const [coarsePointer, setCoarsePointer] = useState(matchesCoarsePointer);

  const cube = useCubeStore((store) => store.cube);
  const history = useCubeStore((store) => store.history);
  const transportBusy = useCubeStore((store) => store.transportBusy);
  const transportFatal = useCubeStore((store) => store.transportFatal);
  const fatalInvariant = useCubeStore((store) => store.fatalInvariant);
  const lastCommandEnd = useCubeStore((store) => store.lastCommandEnd);
  const renderMode = useCubeStore((store) => store.renderMode);
  const renderDetail = useCubeStore((store) => store.renderDetail);
  const formula = useCubeStore((store) => store.formula);
  const formulaError = useCubeStore((store) => store.formulaError);
  const scramble = useCubeStore((store) => store.scramble);
  const scrambleSeed = useCubeStore((store) => store.scrambleSeed);
  const lastAction = useCubeStore((store) => store.lastAction);
  // Only the phase is subscribed, not the whole timer: the digits are painted
  // straight into the DOM from rAF, so a running solve must not re-render this
  // tree sixty times a second.
  const timerPhase = useCubeStore((store) => store.timer.phase);
  const timerPenalty = useCubeStore((store) => store.timer.penalty);
  const inspection = useCubeStore((store) => store.timerConfig.inspection);
  const results = useCubeStore((store) => store.results);

  const facelets = useMemo(() => toFacelets(cube), [cube]);
  const solved = useMemo(() => isSolved(cube), [cube]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let active = true;
    let renderer: CubeRendererInstance | null = null;
    let fallbackBackend: FallbackMoveTransportBackend | null = null;
    let installedTransport: CommitDispatcher | null = null;
    let switchingToFallback = false;
    let backendGeneration = 0;
    const unsubscribeTransportObservers: Array<() => void> = [];
    useCubeStore.getState().setRenderMode('booting');

    const observeTransport = (
      transport: CommitDispatcher,
      generation: number,
    ): void => {
      unsubscribeTransportObservers.push(
        transport.subscribe((event) => {
          if (!active || backendGeneration !== generation) return;
          if (!('changes' in event)) return;
          // A batch is one committed animation group, which is exactly one
          // audible event: it lands when the layer seats, a rolled-back drag
          // never produces one, and a concurrent pair arrives as a single
          // batch. Observer throws are contained by the dispatcher, so sound
          // can never halt playback.
          audioRef.current?.playBatch(event);
          // Read the clock here rather than in an effect. This runs inside the
          // commit that ends the turn, so it is the closest the app gets to the
          // moment the cube became solved; a render pass later would charge the
          // solve for whatever the scheduler did next.
          for (const change of event.changes) {
            // A replace snapshot is a reset or a checkpoint load, not a solve.
            if (change.move === null) continue;
            if (!isSolved(change.state)) continue;
            useCubeStore
              .getState()
              .dispatchTimer({ type: 'solved', at: performance.now() });
            break;
          }
          const lastChange = event.changes.at(-1);
          if (lastChange === undefined || lastChange.move === null) return;
          if (lastChange.provenance.origin === 'drag') {
            useCubeStore
              .getState()
              .setLastAction(`Drag · ${serializeMove(lastChange.move)}`);
          }
        }),
      );
    };

    const installFallback = (detail: string): void => {
      if (!active) return;
      const snapshot = useCubeStore.getState();
      const initialState = snapshot.cube;
      const generation = backendGeneration + 1;
      backendGeneration = generation;
      let backend!: FallbackMoveTransportBackend;
      const transport = createAppDispatcher({
        initialState,
        initialRevision: snapshot.commandRevision,
        isCurrent: () => active && backendGeneration === generation,
        createBackend: (sink) => {
          backend = new FallbackMoveTransportBackend({ initialState, sink });
          return backend;
        },
      });

      if (!active) {
        backend.dispose();
        return;
      }
      fallbackBackend = backend;
      installedTransport = transport;
      transportRef.current = transport;
      rendererRef.current = null;
      observeTransport(transport, generation);
      useCubeStore.getState().setRenderMode('fallback', detail);
    };

    const switchToFallback = (error: Error): void => {
      if (!active || switchingToFallback) return;
      switchingToFallback = true;
      // handleContextLost fails/cancels unfinished work before invoking this
      // callback. Invalidate the old dispatcher's later same-revision status
      // edges before a new backend claims the store.
      backendGeneration += 1;
      const failedRenderer = renderer;
      if (rendererRef.current === failedRenderer) rendererRef.current = null;
      if (transportRef.current === installedTransport) transportRef.current = null;
      useCubeStore.getState().setRenderMode('booting', error.message);

      // Leave the context-loss event stack before tearing down Three's own
      // listeners. The renderer has already failed its unfinished commands;
      // fallback starts from the store's last committed integer checkpoint.
      queueMicrotask(() => {
        try {
          failedRenderer?.dispose();
        } catch {
          // Fallback remains able to recover from a partially failed cleanup.
        }
        if (renderer === failedRenderer) renderer = null;
        if (active) installFallback(error.message);
      });
    };

    // The canvas is passed for its owning document only: supportsWebGL probes a
    // scratch canvas and releases that context immediately, so the target keeps
    // the attributes WebGLRenderer will ask for and a StrictMode remount cannot
    // exhaust the browser's context budget.
    if (!supportsWebGL(canvas)) {
      installFallback('WebGL unavailable');
    } else {
      const initializeRenderer = async (): Promise<void> => {
        try {
          const { CubeRenderer } = await import('@rubcube/cube-render/renderer');
          if (!active) return;

          const snapshot = useCubeStore.getState();
          const initialState = snapshot.cube;
          const generation = backendGeneration + 1;
          backendGeneration = generation;
          let transport!: CommitDispatcher;
          let nextRenderer!: CubeRendererInstance;
          transport = createAppDispatcher({
            initialState,
            initialRevision: snapshot.commandRevision,
            isCurrent: () => active && backendGeneration === generation,
            createBackend: (sink) => {
              nextRenderer = new CubeRenderer(canvas, {
                initialState,
                background: 0x0c0e0d,
                keyboard: false,
                transportSink: sink,
                acceptInteractive: (face, provenance) =>
                  active &&
                  backendGeneration === generation &&
                  // Inspection is time to look, not to turn. Blocking the drag
                  // here rather than in the key handler covers the pointer path
                  // too, which is the one that would otherwise stay open.
                  !LOCKED_PHASES.has(useCubeStore.getState().timer.phase)
                    ? transport.beginInteractive(face, provenance)
                    : false,
                onRenderFailure: switchToFallback,
              });
              return nextRenderer;
            },
          });

          renderer = nextRenderer;
          installedTransport = transport;
          rendererRef.current = nextRenderer;
          transportRef.current = transport;
          observeTransport(transport, generation);
          useCubeStore.getState().setRenderMode('webgl');
        } catch (error) {
          try {
            renderer?.dispose();
          } catch {
            // The fallback transport does not depend on Three cleanup succeeding.
          }
          renderer = null;
          rendererRef.current = null;
          transportRef.current = null;
          if (active) installFallback(errorMessage(error));
        }
      };
      void initializeRenderer();
    }

    return () => {
      for (const unsubscribe of unsubscribeTransportObservers) unsubscribe();
      if (transportRef.current === installedTransport) transportRef.current = null;
      if (rendererRef.current === renderer) rendererRef.current = null;
      // Keep this generation authoritative while dispose synchronously fails
      // unfinished commands. Only then invalidate it, so StrictMode teardown
      // cannot strand the store in a busy state or lose the unique end event.
      try {
        fallbackBackend?.dispose();
      } catch {
        // Cleanup is best-effort after refs have been detached.
      }
      try {
        renderer?.dispose();
      } catch {
        // React cleanup must remain idempotent under StrictMode remounts.
      }
      active = false;
      backendGeneration += 1;
    };
  }, []);

  const playMoves = useCallback(
    (
      moves: readonly Move[],
      label: string,
      origin: EnqueueMoveOrigin,
    ): boolean => {
      if (moves.length === 0) return false;
      const transport = transportRef.current;
      if (transport === null) return false;

      const accepted = transport.enqueue(moves, {
        commandId: createCommandId(origin),
        intent: 'forward',
        origin,
      });
      if (accepted) useCubeStore.getState().setLastAction(label);
      return accepted;
    },
    [],
  );

  const playMove = useCallback(
    (move: Move) =>
      playMoves([move], `Move · ${serializeMove(move)}`, 'manual'),
    [playMoves],
  );

  const undoLastMove = useCallback((): void => {
    const transport = transportRef.current;
    const store = useCubeStore.getState();
    if (
      transport === null ||
      transport.isBusy ||
      store.transportFatal ||
      store.fatalInvariant !== null
    ) {
      return;
    }
    const move = getUndoMove(store.history);
    if (move === null) return;
    if (
      transport.enqueue([move], {
        commandId: createCommandId('undo'),
        intent: 'undo',
        origin: 'history',
      })
    ) {
      store.setLastAction(`Undo · ${serializeMove(move)}`);
    }
  }, []);

  const rewindHistory = useCallback((): void => {
    const transport = transportRef.current;
    const store = useCubeStore.getState();
    if (
      transport === null ||
      transport.isBusy ||
      store.transportFatal ||
      store.fatalInvariant !== null
    ) {
      return;
    }
    const moves = getRewindMoves(store.history);
    if (moves === null || moves.length === 0) return;
    if (
      transport.enqueue(moves, {
        commandId: createCommandId('rewind'),
        intent: 'rewind',
        origin: 'history',
      })
    ) {
      store.setLastAction(`Rewind · ${moves.length} moves`);
    }
  }, []);

  const cancelPlayback = useCallback((): void => {
    const transport = transportRef.current;
    if (transport === null || !transport.isBusy) return;
    transport.cancelPlayback('Cancelled by user');
    useCubeStore.getState().setLastAction('Playback · cancelling');
  }, []);

  useEffect(() => {
    // Owning the instance here rather than at render time keeps a StrictMode
    // remount honest: the simulated unmount really does dispose the context,
    // and the remount really does build a fresh one. The transport observer
    // reads the ref at event time, so it never holds a disposed instance.
    audioRef.current ??= new TurnAudio({ muted: !readSoundEnabled() });

    // A context created outside a user gesture stays suspended for good, and
    // the gesture that enabled sound may predate the first turn by minutes.
    // These listeners are the cheap way to already be running when it matters:
    // unlock returns immediately once the context runs, and while muted.
    const unlock = (): void => audioRef.current?.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });

    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);

  const paintTimer = useCallback((): void => {
    const node = timerDigitsRef.current;
    if (node === null) return;
    const store = useCubeStore.getState();
    const readout = readTimer(store.timer, performance.now(), store.timerConfig);
    switch (readout.kind) {
      case 'inspection':
        // Once inspection has overrun, the remaining count is meaningless and
        // the cost is the only thing worth showing.
        node.textContent =
          readout.penalty === 'dnf'
            ? 'DNF'
            : readout.penalty === 'plus2'
              ? '+2'
              : Math.ceil(readout.remainingMs / 1_000).toString();
        return;
      case 'running':
        node.textContent = formatMs(readout.elapsedMs);
        return;
      case 'result':
        node.textContent = formatResult(readout.rawMs, readout.penalty);
        return;
      default:
        node.textContent = formatMs(0);
    }
  }, []);

  useEffect(() => {
    // Paint on every phase edge, including the ones that end the loop: the last
    // frame of a running solve is not the final time, and a stopped readout
    // would otherwise keep whatever the loop happened to leave behind.
    paintTimer();
    if (!LIVE_PHASES.has(timerPhase)) return;

    let frame = 0;
    const step = (): void => {
      // The charge is advanced from the frame loop rather than a timeout so it
      // cannot fire while the tab is hidden and arm a solve nobody is watching.
      if (useCubeStore.getState().timer.phase === 'holding') {
        useCubeStore.getState().dispatchTimer({ type: 'tick', at: performance.now() });
      }
      paintTimer();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [paintTimer, timerPhase]);

  useEffect(() => {
    // A window that loses focus mid-hold never sees the keyup, and would sit
    // charged until some later keystroke released it. Cancelled rather than
    // released: losing focus is not the player letting go to start a solve.
    const cancel = (): void =>
      useCubeStore.getState().dispatchTimer({ type: 'hold-cancel', at: performance.now() });
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    // A tablet with a keyboard attached, or a desktop browser being resized
    // into a touch emulation, both change the answer while the page is open.
    const query = matchMedia('(pointer: coarse)');
    const sync = (): void => setCoarsePointer(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const archive = createSolveArchive();
    if (archive === null) return;

    let active = true;
    let unsubscribe: (() => void) | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let flush: (() => void) | null = null;

    void archive
      .load()
      .then((loaded) => {
        if (!active) return;
        useCubeStore.getState().hydrateResults(loaded);

        // Subscribing only once the restore has landed. Saving before then
        // would write the empty starting session over the stored one and erase
        // it in the moment before it was read back.
        let latest = useCubeStore.getState().results;
        flush = (): void => {
          if (pending !== null) {
            clearTimeout(pending);
            pending = null;
          }
          void archive.save(latest);
        };
        unsubscribe = useCubeStore.subscribe((state, previous) => {
          if (state.results === previous.results) return;
          latest = state.results;
          if (pending !== null) clearTimeout(pending);
          pending = setTimeout(() => {
            pending = null;
            void archive.save(latest);
          }, SAVE_DEBOUNCE_MS);
        });
      })
      .catch(() => undefined);

    // A tab being hidden may never come back, and the debounce window is long
    // enough to lose the solve that was just finished. This is the last point the
    // browser reliably runs anything.
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') flush?.();
    };
    document.addEventListener('visibilitychange', onHidden);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onHidden);
      flush?.();
      unsubscribe?.();
      archive.close();
    };
  }, []);

  const exportCsv = useCallback((): void => {
    const results = useCubeStore.getState().results;
    if (results.length === 0) return;
    const blob = new Blob([toCsv(results)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rubcube-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    // Revoking on this task can cancel the download before it starts; one task
    // later is the point every browser has already read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const beginHold = useCallback((): void => {
    const store = useCubeStore.getState();
    // A hold that only continues an attempt already under way needs no gate;
    // the checks below decide whether a *new* attempt may open.
    if (store.timer.phase === 'idle' || store.timer.phase === 'stopped') {
      if (
        store.renderMode === 'booting' ||
        store.transportFatal ||
        store.fatalInvariant !== null ||
        // Timing the solve of a cube that is already solved records a result
        // that means nothing, and the stop condition would fire immediately.
        isSolved(store.cube) ||
        // A scramble still playing is not a solve the player has started.
        store.transportBusy
      ) {
        return;
      }
    }
    store.dispatchTimer({ type: 'hold-start', at: performance.now() });
  }, []);

  const endHold = useCallback((): void => {
    useCubeStore
      .getState()
      .dispatchTimer({ type: 'hold-end', at: performance.now() });
  }, []);

  const cancelHold = useCallback((): void => {
    useCubeStore
      .getState()
      .dispatchTimer({ type: 'hold-cancel', at: performance.now() });
  }, []);

  const toggleSound = useCallback((): void => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    writeSoundEnabled(next);
    // Reached from the button's own click handler, which is the gesture the
    // autoplay policy asks for, so the context enabled here is already allowed
    // to run and the very next turn is audible.
    audioRef.current?.setMuted(!next);
  }, [soundEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      const editable = isEditableTarget(event.target);
      const undoShortcut =
        !event.altKey &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z';
      if (!editable && undoShortcut) {
        event.preventDefault();
        if (event.shiftKey) rewindHistory();
        else undoLastMove();
        return;
      }

      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        editable
      ) {
        return;
      }

      if (isSpace(event)) {
        // Always swallowed, even when the hold is refused: space would
        // otherwise scroll the page, or re-activate whichever button the last
        // click left focused.
        event.preventDefault();
        beginHold();
        return;
      }

      if (event.key === 'Escape') {
        // A live attempt outranks playback here. Escape during a solve means
        // "this attempt is over"; there is rarely queued playback to cancel
        // mid-solve, and abandoning the attempt is the harder thing to undo.
        const phase = useCubeStore.getState().timer.phase;
        if (LIVE_PHASES.has(phase)) {
          event.preventDefault();
          useCubeStore
            .getState()
            .dispatchTimer({ type: 'abort', at: performance.now() });
          return;
        }
        if (transportRef.current?.isBusy === true) {
          event.preventDefault();
          cancelPlayback();
        }
        return;
      }

      const move = moveForKey(event.key);
      if (move === null) return;
      event.preventDefault();
      // Turning during inspection would both break the rule and change the
      // state the solve is scored against.
      if (LOCKED_PHASES.has(useCubeStore.getState().timer.phase)) return;
      playMove(move);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (!isSpace(event) || isEditableTarget(event.target)) return;
      event.preventDefault();
      useCubeStore
        .getState()
        .dispatchTimer({ type: 'hold-end', at: performance.now() });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [beginHold, cancelPlayback, playMove, rewindHistory, undoLastMove]);

  useEffect(() => {
    if (lastCommandEnd === null || lastCommandEnd.status === 'completed') return;
    const verb = lastCommandEnd.status === 'failed' ? 'failed' : 'cancelled';
    useCubeStore
      .getState()
      .setLastAction(
        `Playback ${verb} · ${lastCommandEnd.committedMoves} committed`,
      );
  }, [lastCommandEnd]);

  const submitFormula = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const store = useCubeStore.getState();

    try {
      const moves = parseMoves(formula);
      if (moves.length === 0) {
        store.setFormulaError('请输入至少一个 HTM 转动记号。');
        return;
      }
      store.setFormulaError(null);
      playMoves(moves, `Formula · ${moves.length} moves`, 'formula');
    } catch (error) {
      store.setFormulaError(errorMessage(error));
    }
  };

  const runScramble = (): void => {
    const seed = makeSeed();
    const moves = generateRandomMoves(25, seed);
    const notation = serializeMoves(moves);
    const store = useCubeStore.getState();
    const transport = transportRef.current;
    if (
      transport === null ||
      store.transportFatal ||
      store.fatalInvariant !== null
    ) {
      return;
    }

    transport.replaceState(createSolvedState());
    const accepted = transport.enqueue(moves, {
      commandId: createCommandId('scramble'),
      intent: 'forward',
      origin: 'scramble',
    });
    if (!accepted) return;
    // The attempt this scramble replaces never finished, and its clock must not
    // survive into a solve of a different cube.
    store.dispatchTimer({ type: 'reset', at: performance.now() });
    store.setScramble(notation, seed);
    store.setFormulaError(null);
    store.setLastAction(`Scramble · seed ${seed}`);
  };

  const resetCube = (): void => {
    const store = useCubeStore.getState();
    const transport = transportRef.current;
    if (transport === null) return;
    transport.replaceState(createSolvedState());

    store.dispatchTimer({ type: 'reset', at: performance.now() });
    store.setScramble('', null);
    store.setFormulaError(null);
    store.setLastAction('Reset · solved');
  };

  // Enter needs no handler here: the input sits in a form, so the browser's
  // native submit already routes it to submitFormula.
  const dismissFormulaOnEscape = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== 'Escape') return;
    event.currentTarget.blur();
    useCubeStore.getState().setFormulaError(null);
  };

  const lastResult = results.at(-1);
  const stats = useMemo(() => summarise(results), [results]);

  const holdPrompt = coarsePointer ? 'HOLD THE PAD' : 'HOLD SPACE';

  const timerHint =
    timerPhase === 'inspecting'
      ? `${holdPrompt} TO CHARGE`
      : timerPhase === 'holding'
        ? 'KEEP HOLDING'
        : timerPhase === 'armed'
          ? 'RELEASE TO START'
          : timerPhase === 'running'
            ? coarsePointer
              ? 'SOLVE TO STOP'
              : 'SOLVE TO STOP · ESC FOR DNF'
            : solved
              ? 'SCRAMBLE FIRST'
              : timerPenalty === 'dnf'
                ? `DNF · ${holdPrompt} TO RETRY`
                : holdPrompt;

  const controlsDisabled =
    renderMode === 'booting' || transportFatal || fatalInvariant !== null;
  const undoDisabled =
    controlsDisabled || transportBusy || !canUndo(history);
  const rewindDisabled =
    controlsDisabled || transportBusy || !canRewind(history);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#cube-stage" aria-label="RubCube 首页">
          <span className="brand-mark" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <i key={index} />
            ))}
          </span>
          <span className="brand-name">RUB<span>CUBE</span></span>
        </a>

        <div className="topbar-status" aria-live="polite">
          <span className={`status-dot status-dot--${renderMode}`} />
          <span>
            {transportFatal || fatalInvariant !== null
              ? 'Transport · halted'
              : renderMode === 'webgl'
                ? `WebGL · ${transportBusy ? 'playing' : 'live'}`
                : renderMode === 'fallback'
                  ? `2D · ${transportBusy ? 'playing' : 'fallback'}`
                  : 'Starting renderer'}
          </span>
        </div>

        <div className="topbar-tail">
          <button
            type="button"
            className={`sound-toggle${soundEnabled ? ' sound-toggle--on' : ''}`}
            onClick={toggleSound}
            aria-pressed={soundEnabled}
            aria-label={soundEnabled ? '关闭转动音效' : '开启转动音效'}
            title={soundEnabled ? '关闭转动音效' : '开启转动音效'}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path className="speaker" d="M3 6h2.4L8.8 3v10L5.4 10H3z" />
              {soundEnabled ? (
                <>
                  <path className="wave" d="M10.9 5.7a3.2 3.2 0 0 1 0 4.6" />
                  <path className="wave" d="M12.7 4a5.7 5.7 0 0 1 0 8" />
                </>
              ) : (
                <path className="wave" d="M11 6.2 14 9.2M14 6.2 11 9.2" />
              )}
            </svg>
            <span className="sound-label">
              {soundEnabled ? 'Sound on' : 'Sound off'}
            </span>
          </button>

          <div className="topbar-meta">
            <span>M2.5 playground</span>
            <span aria-hidden="true">/</span>
            <span>3 × 3</span>
          </div>
        </div>
      </header>

      <main className="workspace">
        <section className="stage" id="cube-stage" aria-label="魔方视图">
          <canvas
            ref={canvasRef}
            className={`cube-canvas${renderMode === 'fallback' ? ' cube-canvas--inactive' : ''}`}
            aria-hidden={renderMode === 'fallback'}
            aria-label="可交互的 3D 魔方。拖动贴纸转层，拖动空白处旋转视角。"
            tabIndex={renderMode === 'fallback' ? -1 : 0}
          />

          {renderMode === 'fallback' && <FaceletFallback facelets={facelets} />}

          {renderMode === 'booting' && (
            <div className="stage-loading" role="status">
              <span />
              Preparing cube
            </div>
          )}

          <div className="stage-label stage-label--top" aria-hidden="true">
            <span>PLAYGROUND / 01</span>
            <span>{renderMode === 'fallback' ? 'FACELET NET' : 'ORBIT VIEW'}</span>
          </div>

          <div className={`timer-hud timer-hud--${timerPhase}`}>
            {/* Painted from rAF, so it is hidden from assistive tech: a solve
                would otherwise be announced sixty times a second. The finished
                time is announced once, by the panel's live region. */}
            <span className="timer-digits" ref={timerDigitsRef} aria-hidden="true">
              {formatMs(0)}
            </span>
            <span className="timer-hint">{timerHint}</span>
          </div>

          <div className="stage-label stage-label--bottom">
            <span className="interaction-copy">
              {renderMode === 'fallback' ? '2D MODE · USE CONTROLS' : 'DRAG ANY STICKER · ORBIT THE SCENE'}
            </span>
            <span className={solved ? 'cube-badge cube-badge--solved' : 'cube-badge'}>
              <i /> {solved ? 'SOLVED' : 'MIXED'}
            </span>
          </div>

          <div className="axis-glyph" aria-hidden="true">
            <span className="axis axis--y">U</span>
            <span className="axis axis--x">R</span>
            <span className="axis axis--z">F</span>
            <i />
          </div>
        </section>

        <aside className="control-panel" aria-label="魔方控制台">
          <section className="panel-section command-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">SEQUENCE</span>
                <h1>Move console</h1>
              </div>
              <span className="section-index">01</span>
            </div>

            <form className="formula-form" onSubmit={submitFormula} noValidate>
              <label htmlFor="move-formula">Singmaster formula</label>
              <div className={`formula-field${formulaError === null ? '' : ' formula-field--error'}`}>
                <span aria-hidden="true">›</span>
                <input
                  id="move-formula"
                  value={formula}
                  onChange={(event) => useCubeStore.getState().setFormula(event.target.value)}
                  onKeyDown={dismissFormulaOnEscape}
                  spellCheck={false}
                  autoCapitalize="characters"
                  autoComplete="off"
                  aria-invalid={formulaError !== null}
                  aria-describedby={formulaError === null ? 'formula-help' : 'formula-error'}
                  placeholder="R U R' U'"
                />
                <button type="submit" disabled={controlsDisabled} aria-label="执行公式">
                  Run <span aria-hidden="true">↵</span>
                </button>
              </div>
              {formulaError === null ? (
                <p id="formula-help" className="field-help">严格 HTM · 空格分隔 · 支持 ' 与 2</p>
              ) : (
                <p id="formula-error" className="field-error" role="alert">{formulaError}</p>
              )}
            </form>
          </section>

          <section className="panel-section timer-section">
            <div className="section-row-heading">
              <span className="eyebrow">TIMER / WCA</span>
              <label className="inspection-toggle">
                <input
                  type="checkbox"
                  checked={inspection}
                  onChange={(event) =>
                    useCubeStore.getState().setInspection(event.target.checked)
                  }
                />
                <span>15s inspection</span>
              </label>
            </div>

            <button
              type="button"
              className={`hold-pad hold-pad--${timerPhase}`}
              // Pointer events rather than click: the timer is a hold, and the
              // phone has no space bar, so without this path a touch device
              // cannot start the timer at all.
              onPointerDown={(event) => {
                // Stops the press becoming a text selection or a scroll gesture
                // partway through a hold that has to last most of a second.
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                beginHold();
              }}
              onPointerUp={endHold}
              onPointerCancel={cancelHold}
              onLostPointerCapture={cancelHold}
            >
              {timerPhase === 'inspecting'
                ? '按住蓄力'
                : timerPhase === 'holding'
                  ? '继续按住…'
                  : timerPhase === 'armed'
                    ? '松开开始'
                    : timerPhase === 'running'
                      ? '复原魔方即停止'
                      : solved
                        ? '先打乱'
                        : '按住开始'}
            </button>

            <p className="timer-live" role="status" aria-live="polite">
              {lastResult === undefined
                ? '尚无成绩'
                : `最新成绩 ${formatResult(lastResult.rawMs, lastResult.penalty)}`}
            </p>

            {results.length === 0 ? (
              <p className="field-help">
                打乱后按住空格 0.55 秒，松开开始计时；魔方复原时自动停止。Esc 判 DNF。
              </p>
            ) : (
              <>
                <ol className="result-list">
                  {[...results].reverse().map((result, index) => (
                    <li key={result.id} className="result-row">
                      <span className="result-index">
                        {results.length - index}
                      </span>
                      <span
                        className={`result-time result-time--${result.penalty}`}
                      >
                        {formatResult(result.rawMs, result.penalty)}
                      </span>
                      <span className="result-penalties">
                        {PENALTIES.map((penalty) => (
                          <button
                            key={penalty}
                            type="button"
                            className={
                              result.penalty === penalty
                                ? 'penalty-chip penalty-chip--on'
                                : 'penalty-chip'
                            }
                            aria-pressed={result.penalty === penalty}
                            aria-label={`第 ${results.length - index} 次成绩标记为 ${PENALTY_LABEL[penalty]}`}
                            onClick={() =>
                              useCubeStore
                                .getState()
                                .setResultPenalty(result.id, penalty)
                            }
                          >
                            {PENALTY_LABEL[penalty]}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="penalty-chip penalty-chip--drop"
                          aria-label={`删除第 ${results.length - index} 次成绩`}
                          onClick={() =>
                            useCubeStore.getState().deleteResult(result.id)
                          }
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
                <dl className="stat-grid">
                  <div className="stat stat--half">
                    <dt>Best</dt>
                    <dd>{formatStat(stats.best)}</dd>
                  </div>
                  <div className="stat stat--half">
                    <dt>Mean</dt>
                    <dd>{formatStat(stats.mean)}</dd>
                  </div>
                  {stats.averages.map((average) => (
                    <div className="stat stat--third" key={average.size}>
                      <dt>ao{average.size}</dt>
                      <dd>{formatStat(average.current)}</dd>
                      <dd className="stat-best">
                        best {formatStat(average.best)}
                      </dd>
                    </div>
                  ))}
                </dl>

                <p className="stat-note">
                  {stats.solved} / {stats.count} 次计入
                  {stats.solved === stats.count ? '' : `（${stats.count - stats.solved} 次 DNF）`}
                </p>

                <div className="action-row">
                  <button className="button button--primary" type="button" onClick={exportCsv}>
                    Export CSV
                  </button>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => useCubeStore.getState().clearResults()}
                  >
                    Clear session
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="panel-section scramble-section">
            <div className="section-row-heading">
              <span className="eyebrow">SCRAMBLE / 25 HTM</span>
              <span className="seed-label">SEED {scrambleSeed ?? '—'}</span>
            </div>
            <div className="scramble-readout" aria-live="polite">
              {scramble || 'Generate a seeded 25-move scramble.'}
            </div>
            <div className="action-row">
              <button className="button button--primary" type="button" onClick={runScramble} disabled={controlsDisabled}>
                <span aria-hidden="true">✦</span> New scramble
              </button>
              <button className="button button--quiet" type="button" onClick={resetCube} disabled={renderMode === 'booting'}>
                Reset
              </button>
            </div>
          </section>

          <section className="panel-section history-section">
            <div className="section-row-heading">
              <span className="eyebrow">HISTORY / CHECKPOINT</span>
              <span className="legend-copy">
                {history.truncated ? 'PARTIAL' : 'COMPLETE'}
              </span>
            </div>
            <div className="history-summary" aria-live="polite">
              <span>
                <strong>{history.entries.length}</strong>
                committed moves
              </span>
              <span>
                {transportFatal || fatalInvariant !== null
                  ? 'Reset required'
                  : transportBusy
                    ? 'Playback running'
                    : 'Ready'}
              </span>
            </div>
            <div className="history-actions">
              <button
                className="button button--quiet"
                type="button"
                onClick={undoLastMove}
                disabled={undoDisabled}
                aria-keyshortcuts="Control+Z Meta+Z"
              >
                Undo last
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={rewindHistory}
                disabled={rewindDisabled}
                aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
              >
                Rewind
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={cancelPlayback}
                disabled={!transportBusy || transportFatal || fatalInvariant !== null}
                aria-keyshortcuts="Escape"
              >
                Cancel playback
              </button>
            </div>
            {history.truncated && (
              <p className="history-note">
                最早的步骤已折叠进 checkpoint；仍可逐步 Undo，但完整倒带会保持禁用。
              </p>
            )}
            {fatalInvariant !== null && (
              <p className="fatal-note" role="alert">
                {fatalInvariant.name}: {fatalInvariant.message}。请 Reset 建立新的安全 checkpoint。
              </p>
            )}
            {fatalInvariant === null && transportFatal && (
              <p className="fatal-note" role="alert">
                传输后端意外停止。请 Reset 重建安全状态，或重新加载页面。
              </p>
            )}
          </section>

          <section className="panel-section face-section">
            <div className="section-row-heading">
              <span className="eyebrow">FACE TURNS</span>
              <span className="legend-copy">CW · CCW · 180°</span>
            </div>
            <div className="face-controls">
              {FACE_ORDER.map((face) => (
                <div className="face-row" key={face} data-face={face}>
                  <span className="face-name"><i />{face}<small>{FACE_NAMES[face]}</small></span>
                  {([1, 3, 2] as const).map((turns) => {
                    const move: Move = { face, turns };
                    const notation = serializeMove(move);
                    return (
                      <button
                        key={turns}
                        type="button"
                        onClick={() => playMove(move)}
                        disabled={controlsDisabled}
                        aria-label={`${FACE_NAMES[face]} face ${turns === 1 ? 'clockwise' : turns === 3 ? 'counterclockwise' : '180 degrees'}`}
                      >
                        {notation}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section keyboard-section">
            <div className="section-row-heading">
              <span className="eyebrow">KEYBOARD</span>
              <span className="legend-copy">csTimer style</span>
            </div>
            <div className="key-grid">
              {KEY_HINTS.map(([keys, move]) => (
                <span key={keys}><kbd>{keys}</kbd><small>{move}</small></span>
              ))}
            </div>
          </section>

          <section className="panel-section state-section">
            <div className="section-row-heading">
              <span className="eyebrow">STATE / URFDLB</span>
              <span className="legend-copy">54 facelets</span>
            </div>
            <div className="facelet-summary" aria-label={`当前 facelet 状态：${facelets}`}>
              {FACE_ORDER.map((face) => {
                const canonicalIndex = ['U', 'R', 'F', 'D', 'L', 'B'].indexOf(face);
                const slice = facelets.slice(canonicalIndex * 9, canonicalIndex * 9 + 9);
                return <span key={face} data-face={face}><b>{face}</b>{slice}</span>;
              })}
            </div>
            <div className="activity-line">
              <span>LAST</span>
              <output>{lastAction}</output>
            </div>
            {renderMode === 'fallback' && renderDetail !== null && (
              <p className="fallback-note">3D 初始化失败，已保持全部规则操作。{renderDetail}</p>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;
