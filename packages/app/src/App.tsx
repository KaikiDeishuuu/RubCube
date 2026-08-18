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
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { createAppDispatcher } from './app-transport.js';
import { FallbackMoveTransportBackend } from './fallback-transport.js';
import {
  canRewind,
  canUndo,
  getRewindMoves,
  getUndoMove,
} from './history.js';
import { useCubeStore } from './store.js';

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
                  active && backendGeneration === generation
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

      if (event.key === 'Escape') {
        if (transportRef.current?.isBusy === true) {
          event.preventDefault();
          cancelPlayback();
        }
        return;
      }

      const move = moveForKey(event.key);
      if (move === null) return;
      event.preventDefault();
      playMove(move);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelPlayback, playMove, rewindHistory, undoLastMove]);

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
    store.setScramble(notation, seed);
    store.setFormulaError(null);
    store.setLastAction(`Scramble · seed ${seed}`);
  };

  const resetCube = (): void => {
    const store = useCubeStore.getState();
    const transport = transportRef.current;
    if (transport === null) return;
    transport.replaceState(createSolvedState());

    store.setScramble('', null);
    store.setFormulaError(null);
    store.setLastAction('Reset · solved');
  };

  const submitOnCommandEnter = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') return;
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      useCubeStore.getState().setFormulaError(null);
    }
  };

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

        <div className="topbar-meta">
          <span>M2.5 playground</span>
          <span aria-hidden="true">/</span>
          <span>3 × 3</span>
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

          <div className="stage-label stage-label--bottom">
            <span className="interaction-copy">
              {renderMode === 'fallback' ? '2D MODE · USE CONTROLS' : 'DRAG A FACE · ORBIT THE SCENE'}
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
                  onKeyDown={submitOnCommandEnter}
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
