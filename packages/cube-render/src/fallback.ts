import {
  fromFacelets,
  toFacelets,
  type CubeState,
  type FaceletColor,
} from '@rubcube/cube-core';

export type FaceletSvgSource = string | CubeState;

export interface FaceletSvgOptions {
  /** Intrinsic SVG width in CSS pixels. The viewBox always keeps the 4:3 net ratio. */
  readonly width?: number;
  /** Intrinsic SVG height in CSS pixels. */
  readonly height?: number;
  /** Accessible name announced for the focusable SVG. */
  readonly ariaLabel?: string;
  /** Text used by the SVG title element. */
  readonly title?: string;
  /** Optional class added to the root SVG element. */
  readonly className?: string;
}

export interface MountedFaceletSvg {
  readonly element: SVGSVGElement;
  /** Validate and paint a new authoritative cube state without replacing the SVG element. */
  update(source: FaceletSvgSource): void;
  /** Remove the SVG if it is still mounted in the original container. */
  destroy(): void;
}

export const DEFAULT_FACELET_COLORS: Readonly<Record<FaceletColor, string>> = Object.freeze({
  U: '#ffffff',
  R: '#c41e3a',
  F: '#009e60',
  D: '#ffd500',
  L: '#ff5800',
  B: '#0051ba',
});

export const FACELET_GAP_COLOR = '#171717';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 360;
const DEFAULT_TITLE = "Rubik's Cube facelet net";
const FACE_SIZE = 72;
const STICKER_INSET = 2;
const STICKER_SIZE = 20;
const STICKER_PITCH = 24;
const VIEWBOX_WIDTH = FACE_SIZE * 4;
const VIEWBOX_HEIGHT = FACE_SIZE * 3;

interface FaceLayout {
  readonly face: FaceletColor;
  readonly offset: number;
  readonly column: number;
  readonly row: number;
}

/** Visual order and coordinates from DESIGN.md: U / L-F-R-B / D. */
const FACE_LAYOUTS: readonly FaceLayout[] = Object.freeze([
  { face: 'U', offset: 0, column: 1, row: 0 },
  { face: 'L', offset: 36, column: 0, row: 1 },
  { face: 'F', offset: 18, column: 1, row: 1 },
  { face: 'R', offset: 9, column: 2, row: 1 },
  { face: 'B', offset: 45, column: 3, row: 1 },
  { face: 'D', offset: 27, column: 1, row: 2 },
]);

interface ResolvedOptions {
  readonly width: number;
  readonly height: number;
  readonly ariaLabel: string;
  readonly title: string;
  readonly className: string | undefined;
}

const WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: true,
  depth: true,
  powerPreference: 'high-performance',
};

/**
 * Feature-detect WebGL without assuming a DOM exists.
 *
 * The probe always runs on a scratch canvas, never on `canvas`. A canvas keeps
 * one context for its whole lifetime, so probing the element we are about to
 * render into would fix that context's attributes and leave `WebGLRenderer` to
 * silently inherit them — its own `alpha`/`stencil`/`preserveDrawingBuffer`
 * request would be discarded with no error. `canvas` is read only for its
 * owning document, so detection still works inside an iframe or a popup.
 *
 * The scratch context is handed back through `WEBGL_lose_context` immediately:
 * browsers cap concurrent contexts, and repeated probes (a React StrictMode
 * remount does two) must not spend that budget.
 *
 * Context creation can throw (privacy settings, exhausted contexts, test doubles),
 * so every failure path deliberately resolves to `false`.
 */
export function supportsWebGL(canvas?: HTMLCanvasElement): boolean {
  try {
    const owner =
      canvas?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
    if (owner === undefined || typeof owner.createElement !== 'function') return false;

    const probe = owner.createElement('canvas');
    if (typeof probe.getContext !== 'function') return false;

    // Three.js r163+ requires WebGL 2; treating a WebGL 1-only canvas as
    // supported would defer the same failure to WebGLRenderer construction.
    const context = probe.getContext('webgl2', WEBGL_CONTEXT_ATTRIBUTES);
    if (context === null) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a validated 3x3 state as a complete, focusable SVG document fragment.
 *
 * String inputs are decoded with cube-core and encoded again, ensuring this
 * fallback accepts exactly the same physically reachable states as the rest of
 * RubCube. CubeState inputs are validated by `toFacelets` itself.
 */
export function createFaceletSvg(
  source: FaceletSvgSource,
  options: FaceletSvgOptions = {},
): string {
  const facelets = normalizeFacelets(source);
  const resolved = resolveOptions(options);
  const rootAttributes = rootSvgAttributes(facelets, resolved)
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(' ');

  const faces = FACE_LAYOUTS.map((layout) => faceMarkup(layout, facelets)).join('');
  const title = escapeXml(resolved.title);
  const description = escapeXml(faceletDescription(facelets));

  return (
    `<svg ${rootAttributes}>` +
    `<title>${title}</title>` +
    `<desc data-rubcube-facelet-description="">${description}</desc>` +
    faces +
    '</svg>'
  );
}

/**
 * Update an SVG produced by this module in place.
 *
 * The new source and all 54 indexed sticker nodes are validated before any fill
 * is changed, preventing a malformed source or host element from being partly
 * painted.
 */
export function updateFaceletSvg(
  svg: SVGSVGElement,
  source: FaceletSvgSource,
): SVGSVGElement {
  const facelets = normalizeFacelets(source);
  const stickerNodes = svg.querySelectorAll<SVGRectElement>('[data-facelet-index]');

  if (stickerNodes.length !== 54) {
    throw new Error(`Facelet SVG must contain exactly 54 stickers; found ${stickerNodes.length}`);
  }

  const stickersByIndex = new Array<SVGRectElement | undefined>(54);
  for (const sticker of stickerNodes) {
    const rawIndex = sticker.getAttribute('data-facelet-index');
    const index = rawIndex === null ? Number.NaN : Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= stickersByIndex.length) {
      throw new Error(`Facelet SVG has an invalid sticker index: ${String(rawIndex)}`);
    }
    if (stickersByIndex[index] !== undefined) {
      throw new Error(`Facelet SVG has duplicate sticker index ${index}`);
    }
    stickersByIndex[index] = sticker;
  }

  for (let index = 0; index < stickersByIndex.length; index += 1) {
    const color = facelets[index] as FaceletColor;
    const sticker = stickersByIndex[index]!;
    sticker.setAttribute('data-color', color);
    sticker.setAttribute('fill', DEFAULT_FACELET_COLORS[color]);
  }

  svg.setAttribute('data-facelets', facelets);
  const description = svg.querySelector<SVGDescElement>('[data-rubcube-facelet-description]');
  if (description !== null) description.textContent = faceletDescription(facelets);
  return svg;
}

/**
 * Mount the fallback without assigning to `innerHTML`. Parsing is performed by
 * the browser's XML parser only after cube state validation and XML escaping.
 */
export function mountFaceletSvg(
  container: Element,
  source: FaceletSvgSource,
  options: FaceletSvgOptions = {},
): MountedFaceletSvg {
  const ownerWindow = container.ownerDocument.defaultView;
  const DomParser = ownerWindow?.DOMParser;
  if (DomParser === undefined) {
    throw new Error('Cannot mount facelet SVG without a browser DOMParser');
  }

  const parsed = new DomParser().parseFromString(createFaceletSvg(source, options), 'image/svg+xml');
  const parsedRoot = parsed.documentElement;
  if (parsedRoot.namespaceURI !== SVG_NAMESPACE || parsedRoot.localName !== 'svg') {
    throw new Error('Failed to parse generated facelet SVG');
  }

  const element = container.ownerDocument.importNode(parsedRoot, true) as unknown as SVGSVGElement;
  container.replaceChildren(element);

  return {
    element,
    update(nextSource): void {
      updateFaceletSvg(element, nextSource);
    },
    destroy(): void {
      if (element.parentNode === container) container.removeChild(element);
    },
  };
}

function normalizeFacelets(source: FaceletSvgSource): string {
  if (typeof source === 'string') return toFacelets(fromFacelets(source));
  return toFacelets(source);
}

function resolveOptions(options: FaceletSvgOptions): ResolvedOptions {
  const width = positiveDimension(options.width, DEFAULT_WIDTH, 'width');
  const height = positiveDimension(options.height, DEFAULT_HEIGHT, 'height');
  const title = nonEmptyText(options.title, DEFAULT_TITLE, 'title');
  const ariaLabel = nonEmptyText(options.ariaLabel, title, 'ariaLabel');

  if (options.className !== undefined && typeof options.className !== 'string') {
    throw new TypeError('SVG className must be a string');
  }

  return { width, height, title, ariaLabel, className: options.className };
}

function positiveDimension(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`SVG ${name} must be a positive finite number`);
  }
  return value;
}

function nonEmptyText(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`SVG ${name} must be a non-empty string`);
  }
  return value;
}

function rootSvgAttributes(
  facelets: string,
  options: ResolvedOptions,
): readonly (readonly [string, string])[] {
  const attributes: [string, string][] = [
    ['xmlns', SVG_NAMESPACE],
    ['viewBox', `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`],
    ['width', String(options.width)],
    ['height', String(options.height)],
    ['preserveAspectRatio', 'xMidYMid meet'],
    ['role', 'img'],
    ['tabindex', '0'],
    ['focusable', 'true'],
    ['aria-label', options.ariaLabel],
    ['data-facelets', facelets],
  ];
  if (options.className !== undefined) attributes.push(['class', options.className]);
  return attributes;
}

function faceMarkup(layout: FaceLayout, facelets: string): string {
  const originX = layout.column * FACE_SIZE;
  const originY = layout.row * FACE_SIZE;
  let stickers = '';

  for (let position = 0; position < 9; position += 1) {
    const column = position % 3;
    const row = Math.floor(position / 3);
    const index = layout.offset + position;
    const color = facelets[index] as FaceletColor;
    const x = originX + STICKER_INSET + column * STICKER_PITCH;
    const y = originY + STICKER_INSET + row * STICKER_PITCH;
    stickers +=
      `<rect data-facelet-index="${index}" data-face="${layout.face}" ` +
      `data-position="${position + 1}" data-color="${color}" ` +
      `x="${x}" y="${y}" width="${STICKER_SIZE}" height="${STICKER_SIZE}" ` +
      `rx="2" fill="${DEFAULT_FACELET_COLORS[color]}" aria-hidden="true"/>`;
  }

  return (
    `<g data-face="${layout.face}" data-net-column="${layout.column}" ` +
    `data-net-row="${layout.row}">` +
    `<rect x="${originX}" y="${originY}" width="${FACE_SIZE}" height="${FACE_SIZE}" ` +
    `rx="3" fill="${FACELET_GAP_COLOR}" aria-hidden="true"/>` +
    stickers +
    '</g>'
  );
}

function faceletDescription(facelets: string): string {
  return (
    'Layout: U above; L, F, R, B across the middle; D below. ' +
    `Current facelets in URFDLB order: ${facelets}.`
  );
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}
