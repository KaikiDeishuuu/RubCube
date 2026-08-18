import {
  assertValidState,
  cloneState,
  createSolvedState,
  type CubeState,
  type Layer,
  type Move,
} from '@rubcube/cube-core';
import {
  Color,
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import {
  createCubeVisuals,
  type CubeVisualSet,
  type CubieFactoryOptions,
} from './cubie-factory.js';
import { LayerDragController } from './drag-controller.js';
import {
  DEFAULT_KEYBOARD_MOVES,
  KeyboardMoveController,
  type KeyboardMoveMap,
} from './keyboard.js';
import { TurnAnimator } from './turn-animator.js';
import type {
  DragCommitProvenance,
  MoveTransportBackend,
  MoveTransportBackendSink,
  QueuedMove,
} from './transport.js';
import type { CubeStateChangeListener } from './types.js';

export type InteractiveCommandAcceptor = (
  face: Layer,
  provenance: DragCommitProvenance,
) => boolean;

export interface CubeRendererOptions extends CubieFactoryOptions {
  readonly initialState?: CubeState;
  readonly background?: number;
  readonly interactive?: boolean;
  readonly keyboard?: boolean;
  readonly keyboardTarget?: Window | HTMLElement;
  readonly keyboardMapping?: KeyboardMoveMap;
  readonly reducedMotion?: boolean;
  readonly pixelRatio?: number;
  /** Canonical dispatcher sink; enables strict MoveTransportBackend mode. */
  readonly transportSink?: MoveTransportBackendSink;
  /** Routes renderer-created drag commands through dispatcher acceptance. */
  readonly acceptInteractive?: InteractiveCommandAcceptor;
  /** @deprecated Transitional callback for the pre-transport app facade. */
  readonly onStateChange?: CubeStateChangeListener;
  /** Called when the browser reports that the renderer's WebGL context was lost. */
  readonly onRenderFailure?: (error: Error) => void;
}

interface ContactShadow {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly texture: DataTexture;
  dispose(): void;
}

type Cleanup = () => void;

function registerCleanup(cleanups: Cleanup[], cleanup: Cleanup): Cleanup {
  let pending = true;
  const runOnce = (): void => {
    if (!pending) return;
    pending = false;
    cleanup();
  };
  cleanups.push(runOnce);
  return runOnce;
}

function rollback(cleanups: readonly Cleanup[]): void {
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      cleanups[index]!();
    } catch {
      // Preserve the constructor error; each remaining cleanup must still run.
    }
  }
}

function makeContactShadow(spacing: number, cubieSize: number): ContactShadow {
  const size = 96;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const distance = Math.sqrt(nx * nx + ny * ny);
      const strength = Math.max(0, 1 - distance);
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(255 * strength * strength);
    }
  }

  const texture = new DataTexture(pixels, size, size, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  const cleanups: Cleanup[] = [() => texture.dispose()];

  try {
    const shadowSize = (3 * spacing + cubieSize) * 1.35;
    const geometry = new PlaneGeometry(shadowSize, shadowSize);
    cleanups.push(() => geometry.dispose());
    const material = new MeshBasicMaterial({
      color: 0x050504,
      map: texture,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    cleanups.push(() => material.dispose());
    const mesh = new Mesh(geometry, material);
    mesh.name = 'ContactShadow';
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -spacing - cubieSize / 2 - 0.02;
    mesh.renderOrder = -1;

    let disposed = false;
    return {
      mesh,
      texture,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        rollback(cleanups);
      },
    };
  } catch (error) {
    rollback(cleanups);
    throw error;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function renderRuntimeError(reason: unknown): Error {
  let name = 'CubeRendererRuntimeError';
  let message = 'Cube renderer runtime failure';
  try {
    if (reason instanceof Error) {
      const candidateName: unknown = reason.name;
      const candidateMessage: unknown = reason.message;
      if (typeof candidateName === 'string' && candidateName.length > 0) {
        name = candidateName;
      }
      if (typeof candidateMessage === 'string' && candidateMessage.length > 0) {
        message = candidateMessage;
      }
      const error = new Error(message);
      error.name = name;
      return error;
    }
  } catch {
    // Proxies and hostile Error accessors may throw. Use stable diagnostics.
  }
  try {
    const rendered = String(reason);
    if (rendered.length > 0) message = `${message}: ${rendered}`;
  } catch {
    // Hostile thrown values must not escape the browser animation callback.
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Browser-facing Three.js facade. The rule state remains owned by cube-core. */
let nextRendererDragNamespace = 1;

export class CubeRenderer implements MoveTransportBackend {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  readonly visuals: CubeVisualSet;
  readonly animator: TurnAnimator;

  private readonly shadow: ContactShadow;
  private readonly environmentTarget: WebGLRenderTarget;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly dragController: LayerDragController | null;
  private readonly keyboardController: KeyboardMoveController | null;
  private readonly transportSink: MoveTransportBackendSink | undefined;
  private readonly acceptInteractive: InteractiveCommandAcceptor | undefined;
  private readonly onRenderFailure: ((error: Error) => void) | undefined;
  private readonly dragCommandNamespace: number;
  private nextDragCommand = 1;
  private needsRedraw = true;
  private contextLost = false;
  private runtimeFailureReported = false;
  private lastTimeMs: number | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private disposed = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    options: CubeRendererOptions = {},
  ) {
    const stateSource = options.initialState ?? createSolvedState();
    assertValidState(stateSource);
    const initialState = cloneState(stateSource);
    const requestedPixelRatio = options.pixelRatio ?? window.devicePixelRatio ?? 1;
    if (!Number.isFinite(requestedPixelRatio) || requestedPixelRatio <= 0) {
      throw new RangeError('pixelRatio must be a positive finite number');
    }
    if (
      options.acceptInteractive !== undefined &&
      typeof options.acceptInteractive !== 'function'
    ) {
      throw new TypeError('acceptInteractive must be a function');
    }
    this.transportSink = options.transportSink;
    this.acceptInteractive = options.acceptInteractive;
    this.dragCommandNamespace = nextRendererDragNamespace;
    nextRendererDragNamespace += 1;
    this.onRenderFailure = options.onRenderFailure;
    this.scene = new Scene();
    this.scene.background = new Color(options.background ?? 0x11110f);

    this.camera = new PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.set(5.6, 4.5, 6.4);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    const cleanups: Cleanup[] = [];
    registerCleanup(cleanups, () => {
      try {
        this.renderer.dispose();
      } finally {
        // A failed constructor cannot be reused. Relinquish its context after
        // removing all of our listeners so this intentional loss is silent.
        this.renderer.forceContextLoss();
      }
    });

    try {
      registerCleanup(cleanups, () => {
        canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      });
      canvas.addEventListener('webglcontextlost', this.handleContextLost);
      registerCleanup(cleanups, () => {
        canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
      });
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored);

      this.renderer.setPixelRatio(Math.min(Math.max(requestedPixelRatio, 1), 2));
      this.renderer.outputColorSpace = SRGBColorSpace;
      // ACES is a film look: it desaturates saturated albedo as luminance rises,
      // which is exactly wrong for six flat brand colours. Khronos PBR Neutral is
      // built for product shots and holds hue and saturation.
      this.renderer.toneMapping = NeutralToneMapping;
      this.renderer.toneMappingExposure = 1.12;
      this.renderer.shadowMap.enabled = false;

      const pmrem = new PMREMGenerator(this.renderer);
      const disposePmrem = registerCleanup(cleanups, () => pmrem.dispose());
      const room = new RoomEnvironment();
      const disposeRoom = registerCleanup(cleanups, () => room.dispose());
      this.environmentTarget = pmrem.fromScene(room, 0.04);
      registerCleanup(cleanups, () => this.environmentTarget.dispose());
      this.scene.environment = this.environmentTarget.texture;
      disposeRoom();
      disposePmrem();

      // `scene.environment` already supplies the ambient term. The hemisphere
      // light is a small sky/ground tint on top of it, not a second ambient:
      // at its old 1.55 the two stacked into flat fill that erased the shading.
      this.scene.add(new HemisphereLight(0xf7f5e9, 0x292c31, 0.55));
      const keyLight = new DirectionalLight(0xfff3df, 2.05);
      keyLight.position.set(4, 7, 5);
      this.scene.add(keyLight);

      // Kicker placed so its half-vector with the default view lands near +Y.
      // Without it the sticker gloss never resolves into a highlight from this
      // camera, and the roughness split reads as nothing but a darker tile.
      const kickerLight = new DirectionalLight(0xdfe8ff, 0.9);
      kickerLight.position.set(-4, 3.2, -4.6);
      this.scene.add(kickerLight);

      this.visuals = createCubeVisuals(initialState, options);
      registerCleanup(cleanups, () => this.visuals.dispose());
      this.scene.add(this.visuals.group);
      this.shadow = makeContactShadow(this.visuals.spacing, this.visuals.cubieSize);
      registerCleanup(cleanups, () => this.shadow.dispose());
      this.scene.add(this.shadow.mesh);

      const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
      this.animator = new TurnAnimator(
        this.visuals.group,
        this.visuals.cubies,
        initialState,
        {
          syncVisuals: (state) => this.visuals.sync(state),
          ...(options.transportSink === undefined
            ? {}
            : { transportSink: options.transportSink }),
          onStateChange: (change) => {
            this.needsRedraw = true;
            options.onStateChange?.(change);
          },
          reducedMotion,
        },
      );
      registerCleanup(cleanups, () => this.animator.dispose());

      this.controls = new OrbitControls(this.camera, canvas);
      registerCleanup(cleanups, () => this.controls.dispose());
      this.controls.enableDamping = !reducedMotion;
      this.controls.dampingFactor = 0.075;
      this.controls.enablePan = false;
      this.controls.minDistance = 5;
      this.controls.maxDistance = 11;
      this.controls.rotateSpeed = 0.72;
      this.controls.zoomSpeed = 0.85;
      this.controls.target.set(0, 0, 0);
      registerCleanup(cleanups, () => {
        this.controls.removeEventListener('change', this.requestRender);
      });
      this.controls.addEventListener('change', this.requestRender);

      if (options.interactive ?? true) {
        this.dragController = new LayerDragController(
          canvas,
          this.camera,
          this.visuals.cubies,
          this.animator,
          this.controls,
          {
            requestRender: this.requestRender,
            beginInteractive: this.requestInteractive,
          },
        );
        registerCleanup(cleanups, () => this.dragController?.dispose());
      } else {
        this.dragController = null;
      }

      const keyboardTarget = options.keyboardTarget ??
        (typeof window === 'undefined' ? undefined : window);
      if ((options.keyboard ?? true) && keyboardTarget !== undefined) {
        this.keyboardController = new KeyboardMoveController(
          keyboardTarget,
          (move) => this.enqueue(move),
          options.keyboardMapping ?? DEFAULT_KEYBOARD_MOVES,
        );
        registerCleanup(cleanups, () => this.keyboardController?.dispose());
      } else {
        this.keyboardController = null;
      }

      const previousTabIndex = canvas.tabIndex;
      if (previousTabIndex < 0) {
        registerCleanup(cleanups, () => {
          canvas.tabIndex = previousTabIndex;
        });
        canvas.tabIndex = 0;
      }
      if (!canvas.hasAttribute('aria-label')) {
        registerCleanup(cleanups, () => canvas.removeAttribute('aria-label'));
        canvas.setAttribute('aria-label', 'Interactive 3D Rubik’s Cube');
      }

      this.resizeObserver =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => this.resize());
      if (this.resizeObserver !== null) {
        registerCleanup(cleanups, () => this.resizeObserver?.disconnect());
        this.resizeObserver.observe(canvas);
      }
      registerCleanup(cleanups, () => window.removeEventListener('resize', this.resize));
      window.addEventListener('resize', this.resize);
      this.resize();
      registerCleanup(cleanups, () => this.renderer.setAnimationLoop(null));
      this.renderer.setAnimationLoop(this.frame);
    } catch (error) {
      this.disposed = true;
      rollback(cleanups);
      throw error;
    }

    // Ownership has moved to the fully initialized instance and dispose().
    cleanups.length = 0;
  }

  get state(): CubeState {
    return this.animator.state;
  }

  get isBusy(): boolean {
    return this.animator.isBusy;
  }

  enqueue(moves: readonly QueuedMove[]): void;
  /** @deprecated Transitional pre-transport overload. */
  enqueue(moves: string | Move | readonly Move[]): void;
  enqueue(
    moves: string | Move | readonly Move[] | readonly QueuedMove[],
  ): void {
    if (typeof moves === 'string') {
      this.animator.enqueue(moves);
    } else if (Array.isArray(moves)) {
      const first = moves[0] as Move | QueuedMove | undefined;
      if (first !== undefined && 'move' in first) {
        this.animator.enqueue(moves as readonly QueuedMove[]);
      } else {
        this.animator.enqueue(moves as readonly Move[]);
      }
    } else {
      this.animator.enqueue([moves as Move]);
    }
    this.requestRender();
  }

  beginInteractive(
    face: Layer,
    provenance: DragCommitProvenance,
  ): boolean {
    const accepted = this.animator.beginInteractive(face, provenance);
    if (accepted) this.requestRender();
    return accepted;
  }

  cancelPlayback(reason: string): void {
    this.animator.cancelPlayback(reason);
    this.requestRender();
  }

  pump(): void {
    this.animator.pump();
    this.requestRender();
  }

  replaceState(state: CubeState): void {
    this.animator.replaceState(state);
    this.requestRender();
  }

  private readonly requestInteractive = (face: Layer): boolean => {
    if (this.acceptInteractive === undefined) {
      // Canonical mode must never bypass dispatcher command registration.
      if (this.transportSink !== undefined) return false;
      return this.animator.beginInteractive(face);
    }

    const provenance: DragCommitProvenance = {
      commandId:
        `renderer-drag-${this.dragCommandNamespace}-${this.nextDragCommand}`,
      intent: 'forward',
      origin: 'drag',
    };
    this.nextDragCommand += 1;
    return this.acceptInteractive(face, provenance);
  };

  resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, Math.round(this.canvas.clientWidth || this.canvas.width || 1));
    const height = Math.max(1, Math.round(this.canvas.clientHeight || this.canvas.height || 1));
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestRender();
  };

  requestRender = (): void => {
    this.needsRedraw = true;
  };

  dispose(): void {
    if (this.disposed) return;
    // Report before drag-controller cleanup: pointer cleanup is normally a
    // cancelled/0 gesture, but renderer disposal is a backend failure and must
    // end every accepted command as failed through the dispatcher.
    if (this.transportSink !== undefined && this.animator.isBusy) {
      this.transportSink.fail(new Error('CubeRenderer disposed with unfinished work'));
    }
    this.disposed = true;
    const cleanups: readonly Cleanup[] = [
      () => this.renderer.setAnimationLoop(null),
      () => window.removeEventListener('resize', this.resize),
      () => this.resizeObserver?.disconnect(),
      () => this.keyboardController?.dispose(),
      // Dispose the animator before drag cleanup can reinterpret teardown as
      // an ordinary user cancellation (the failure was reported above).
      () => this.animator.dispose(),
      () => this.dragController?.dispose(),
      () => this.controls.removeEventListener('change', this.requestRender),
      () => this.controls.dispose(),
      () => this.shadow.dispose(),
      () => this.visuals.dispose(),
      () => this.environmentTarget.dispose(),
      () => this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored),
      () => this.canvas.removeEventListener('webglcontextlost', this.handleContextLost),
      () => this.renderer.dispose(),
    ];
    let firstFailure: { readonly error: unknown } | null = null;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        firstFailure ??= { error };
      }
    }
    if (firstFailure !== null) throw firstFailure.error;
  }

  private readonly handleContextLost = (event: Event): void => {
    // Asks the browser to restore the context; it answers with
    // 'webglcontextrestored', which resumes the loop below.
    event.preventDefault();
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    let detail = '';
    try {
      const statusMessage = (event as { readonly statusMessage?: unknown })
        .statusMessage;
      if (typeof statusMessage === 'string' && statusMessage.length > 0) {
        detail = `: ${statusMessage}`;
      }
    } catch {
      // A synthetic/foreign event must not prevent transport failure cleanup.
    }
    const error = new Error(`WebGL context lost${detail}`);
    error.name = 'WebGLContextLostError';
    this.reportRuntimeFailure(error);
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed || this.runtimeFailureReported || !this.contextLost) return;
    this.contextLost = false;
    // The clock kept running while parked; drop the stale stamp so the first
    // frame back advances the animation by 0 rather than the whole outage.
    this.lastTimeMs = null;
    this.renderer.setAnimationLoop(this.frame);
    this.requestRender();
  };

  private readonly frame = (timeMs: number): void => {
    if (this.disposed) return;
    try {
      // Clamped at both ends: the 50ms ceiling keeps a long stall from teleporting
      // a turn, and the floor keeps a non-monotonic timestamp (XR time base, a
      // reset rAF clock) from throwing RangeError out of the loop in tick().
      const elapsedSeconds =
        this.lastTimeMs === null
          ? 0
          : Math.min(Math.max(timeMs - this.lastTimeMs, 0) / 1000, 0.05);
      this.lastTimeMs = timeMs;
      const animationChanged = this.animator.tick(elapsedSeconds);
      const controlsChanged = this.controls.enabled ? this.controls.update() : false;

      if (animationChanged || controlsChanged || this.needsRedraw) {
        this.renderer.render(this.scene, this.camera);
        this.needsRedraw = false;
      }
    } catch (error) {
      this.reportRuntimeFailure(error);
    }
  };

  private reportRuntimeFailure(reason: unknown): void {
    if (this.disposed || this.runtimeFailureReported) return;
    this.runtimeFailureReported = true;
    const error = renderRuntimeError(reason);
    try {
      this.renderer.setAnimationLoop(null);
    } catch {
      // The renderer is already unusable; transport failure still must settle.
    }
    try {
      this.transportSink?.fail(error);
    } catch {
      // A foreign sink cannot be allowed to escape an animation/event callback.
    }
    try {
      this.onRenderFailure?.(error);
    } catch {
      // The app callback is observational. The render loop is already parked.
    }
  }
}
