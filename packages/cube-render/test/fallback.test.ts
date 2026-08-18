import {
  SOLVED_FACELETS,
  applyMoves,
  createSolvedState,
  toFacelets,
  type FaceletColor,
} from '@rubcube/cube-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FACELET_COLORS,
  FACELET_GAP_COLOR,
  createFaceletSvg,
  mountFaceletSvg,
  supportsWebGL,
  updateFaceletSvg,
} from '../src/fallback.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supportsWebGL', () => {
  const loseContext = vi.fn();
  const webgl2Context = {
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext } : null,
  };

  /** A render-target double whose ownerDocument hands out `probe`. */
  function hostCanvas(probe: unknown): {
    readonly canvas: HTMLCanvasElement;
    readonly targetGetContext: ReturnType<typeof vi.fn>;
    readonly createElement: ReturnType<typeof vi.fn>;
  } {
    const targetGetContext = vi.fn(() => ({}));
    const createElement = vi.fn(() => probe);
    const canvas = {
      ownerDocument: { createElement },
      getContext: targetGetContext,
    } as unknown as HTMLCanvasElement;
    return { canvas, targetGetContext, createElement };
  }

  beforeEach(() => {
    loseContext.mockClear();
  });

  it('returns false without a DOM', () => {
    vi.stubGlobal('document', undefined);
    expect(supportsWebGL()).toBe(false);
  });

  it('never creates a context on the canvas it is handed', () => {
    // A canvas keeps one context for its lifetime, so probing the render target
    // would freeze the attributes WebGLRenderer asks for afterwards.
    const probe = { getContext: vi.fn(() => webgl2Context) };
    const { canvas, targetGetContext, createElement } = hostCanvas(probe);

    expect(supportsWebGL(canvas)).toBe(true);
    expect(targetGetContext).not.toHaveBeenCalled();
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect(probe.getContext).toHaveBeenCalledTimes(1);
  });

  it('releases the scratch context so repeated probes cannot exhaust the budget', () => {
    const probe = { getContext: vi.fn(() => webgl2Context) };
    const { canvas } = hostCanvas(probe);

    expect(supportsWebGL(canvas)).toBe(true);
    expect(supportsWebGL(canvas)).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(2);
  });

  it('requires the WebGL2 level used by Three.js and safely handles context errors', () => {
    const legacy = { getContext: vi.fn((kind: string) => (kind === 'webgl' ? {} : null)) };
    expect(supportsWebGL(hostCanvas(legacy).canvas)).toBe(false);
    expect(legacy.getContext).toHaveBeenCalledTimes(1);

    const throwing = {
      getContext: vi.fn(() => {
        throw new Error('WebGL disabled');
      }),
    };
    expect(supportsWebGL(hostCanvas(throwing).canvas)).toBe(false);

    expect(supportsWebGL(hostCanvas({}).canvas)).toBe(false);
    expect(supportsWebGL({} as HTMLCanvasElement)).toBe(false);
  });

  it('accepts a context that does not expose WEBGL_lose_context', () => {
    const probe = { getContext: vi.fn(() => ({ getExtension: () => null })) };
    expect(supportsWebGL(hostCanvas(probe).canvas)).toBe(true);
    expect(loseContext).not.toHaveBeenCalled();
  });

  it('can create its own canvas when a DOM is present', () => {
    const probe = {
      getContext: vi.fn((kind: string) => (kind === 'webgl2' ? webgl2Context : null)),
    };
    const createElement = vi.fn(() => probe);
    vi.stubGlobal('document', { createElement });

    expect(supportsWebGL()).toBe(true);
    expect(createElement).toHaveBeenCalledWith('canvas');
  });
});

describe('createFaceletSvg', () => {
  it('renders the solved state in the DESIGN.md U / L-F-R-B / D layout', () => {
    const svg = createFaceletSvg(SOLVED_FACELETS);

    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg.match(/data-facelet-index=/gu)).toHaveLength(54);
    expect(svg.match(new RegExp(`fill="${FACELET_GAP_COLOR}"`, 'gu'))).toHaveLength(6);

    expect(svg).toContain('<g data-face="U" data-net-column="1" data-net-row="0">');
    expect(svg).toContain('<g data-face="L" data-net-column="0" data-net-row="1">');
    expect(svg).toContain('<g data-face="F" data-net-column="1" data-net-row="1">');
    expect(svg).toContain('<g data-face="R" data-net-column="2" data-net-row="1">');
    expect(svg).toContain('<g data-face="B" data-net-column="3" data-net-row="1">');
    expect(svg).toContain('<g data-face="D" data-net-column="1" data-net-row="2">');

    for (let index = 0; index < SOLVED_FACELETS.length; index += 1) {
      const color = SOLVED_FACELETS[index] as FaceletColor;
      expect(svg).toContain(
        `data-facelet-index="${index}" data-face="${color}" ` +
          `data-position="${(index % 9) + 1}" data-color="${color}"`,
      );
      expect(svg).toContain(`data-color="${color}" x=`);
      expect(svg).toContain(`fill="${DEFAULT_FACELET_COLORS[color]}"`);
    }
  });

  it('renders a non-uniform CubeState and its canonical facelet string identically', () => {
    const state = applyMoves(createSolvedState(), "R U F2 L' D");
    const facelets = toFacelets(state);
    const fromState = createFaceletSvg(state);
    const fromText = createFaceletSvg(facelets);

    expect(fromState).toBe(fromText);
    expect(new Set(facelets.slice(0, 9))).not.toEqual(new Set(['U']));

    for (let index = 0; index < facelets.length; index += 1) {
      const color = facelets[index] as FaceletColor;
      expect(fromState).toContain(
        `data-facelet-index="${index}" data-face=`,
      );
      expect(fromState).toMatch(
        new RegExp(
          `data-facelet-index="${index}"[^>]+data-color="${color}"[^>]+fill="${DEFAULT_FACELET_COLORS[color]}"`,
          'u',
        ),
      );
    }
  });

  it('rejects malformed, impossible, and invalid cubie inputs through cube-core', () => {
    expect(() => createFaceletSvg('U'.repeat(54))).toThrow(/facelet color count/iu);
    expect(() =>
      createFaceletSvg(
        'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBX',
      ),
    ).toThrow(/length|character/iu);

    const invalidState = createSolvedState();
    invalidState.cp[0] = invalidState.cp[1]!;
    expect(() => createFaceletSvg(invalidState)).toThrow(/invalid cube state/iu);
  });

  it('emits ARIA, focus, keyboard, title, and escaped user-text markers', () => {
    const svg = createFaceletSvg(createSolvedState(), {
      width: 640,
      height: 480,
      title: 'Cube <net>',
      ariaLabel: 'Cube & keyboard "view"',
      className: 'cube-net custom',
    });

    expect(svg).toContain('role="img"');
    expect(svg).toContain('tabindex="0"');
    expect(svg).toContain('focusable="true"');
    expect(svg).toContain('aria-label="Cube &amp; keyboard &quot;view&quot;"');
    expect(svg).toContain('<title>Cube &lt;net&gt;</title>');
    expect(svg).toContain('<desc data-rubcube-facelet-description="">Layout:');
    expect(svg).toContain('width="640" height="480"');
    expect(svg).toContain('class="cube-net custom"');
    expect(svg).not.toContain('<net>');
  });

  it('rejects unusable presentation options', () => {
    expect(() => createFaceletSvg(SOLVED_FACELETS, { width: 0 })).toThrow(/width/iu);
    expect(() => createFaceletSvg(SOLVED_FACELETS, { height: Number.NaN })).toThrow(/height/iu);
    expect(() => createFaceletSvg(SOLVED_FACELETS, { title: '  ' })).toThrow(/title/iu);
    expect(() =>
      createFaceletSvg(SOLVED_FACELETS, { className: 42 } as unknown as { className: string }),
    ).toThrow(/className/iu);
  });
});

describe('updateFaceletSvg', () => {
  it('updates indexed stickers in place after validating the next state', () => {
    const state = applyMoves(createSolvedState(), 'R U');
    const facelets = toFacelets(state);
    const attributes = Array.from({ length: 54 }, (_, index) =>
      new Map<string, string>([['data-facelet-index', String(index)]]),
    );
    const stickers = attributes.map(
      (values) =>
        ({
          getAttribute: (name: string) => values.get(name) ?? null,
          setAttribute: (name: string, value: string) => values.set(name, value),
        }) as unknown as SVGRectElement,
    );
    const rootAttributes = new Map<string, string>();
    const description = { textContent: '' };
    const svg = {
      querySelectorAll: () => stickers,
      querySelector: () => description,
      setAttribute: (name: string, value: string) => rootAttributes.set(name, value),
    } as unknown as SVGSVGElement;

    expect(updateFaceletSvg(svg, state)).toBe(svg);
    expect(rootAttributes.get('data-facelets')).toBe(facelets);
    expect(description.textContent).toContain(facelets);
    for (let index = 0; index < facelets.length; index += 1) {
      const color = facelets[index] as FaceletColor;
      expect(attributes[index]!.get('data-color')).toBe(color);
      expect(attributes[index]!.get('fill')).toBe(DEFAULT_FACELET_COLORS[color]);
    }
  });

  it('rejects malformed host SVGs before painting them', () => {
    const malformed = {
      querySelectorAll: () => [],
    } as unknown as SVGSVGElement;
    expect(() => updateFaceletSvg(malformed, SOLVED_FACELETS)).toThrow(/exactly 54/iu);

    const indexedSticker = (index: string): SVGRectElement =>
      ({
        getAttribute: () => index,
        setAttribute: vi.fn(),
      }) as unknown as SVGRectElement;
    const invalidIndex = {
      querySelectorAll: () => [
        indexedSticker('not-a-number'),
        ...Array.from({ length: 53 }, (_, index) => indexedSticker(String(index + 1))),
      ],
    } as unknown as SVGSVGElement;
    expect(() => updateFaceletSvg(invalidIndex, SOLVED_FACELETS)).toThrow(/invalid sticker index/iu);

    const duplicateIndex = {
      querySelectorAll: () => Array.from({ length: 54 }, () => indexedSticker('0')),
    } as unknown as SVGSVGElement;
    expect(() => updateFaceletSvg(duplicateIndex, SOLVED_FACELETS)).toThrow(/duplicate sticker/iu);
  });
});

describe('mountFaceletSvg', () => {
  it('mounts through DOMParser, updates in place, and destroys without innerHTML', () => {
    const stickerAttributes = Array.from({ length: 54 }, (_, index) =>
      new Map<string, string>([['data-facelet-index', String(index)]]),
    );
    const stickers = stickerAttributes.map(
      (values) =>
        ({
          getAttribute: (name: string) => values.get(name) ?? null,
          setAttribute: (name: string, value: string) => values.set(name, value),
        }) as unknown as SVGRectElement,
    );
    const rootAttributes = new Map<string, string>();
    const description = { textContent: '' };
    const element = {
      parentNode: undefined as unknown,
      querySelectorAll: () => stickers,
      querySelector: () => description,
      setAttribute: (name: string, value: string) => rootAttributes.set(name, value),
    };
    const parsedRoot = { namespaceURI: 'http://www.w3.org/2000/svg', localName: 'svg' };
    let parsedMarkup = '';
    class FakeDomParser {
      parseFromString(markup: string, mimeType: string): { documentElement: typeof parsedRoot } {
        parsedMarkup = markup;
        expect(mimeType).toBe('image/svg+xml');
        return { documentElement: parsedRoot };
      }
    }
    const ownerDocument = {
      defaultView: { DOMParser: FakeDomParser },
      importNode: vi.fn(() => element),
    };
    const container = {
      ownerDocument,
      replaceChildren: vi.fn(),
      removeChild: vi.fn(),
    };
    element.parentNode = container;

    const mounted = mountFaceletSvg(
      container as unknown as Element,
      SOLVED_FACELETS,
      { ariaLabel: 'Fallback cube' },
    );
    expect(mounted.element).toBe(element);
    expect(parsedMarkup).toContain('aria-label="Fallback cube"');
    expect(container.replaceChildren).toHaveBeenCalledWith(element);
    expect('innerHTML' in container).toBe(false);

    const nextState = applyMoves(createSolvedState(), 'F R');
    mounted.update(nextState);
    expect(rootAttributes.get('data-facelets')).toBe(toFacelets(nextState));

    mounted.destroy();
    expect(container.removeChild).toHaveBeenCalledWith(element);
  });

  it('fails clearly without a browser DOMParser or a parsed SVG root', () => {
    const withoutParser = {
      ownerDocument: { defaultView: null },
    } as unknown as Element;
    expect(() => mountFaceletSvg(withoutParser, SOLVED_FACELETS)).toThrow(/DOMParser/iu);

    class InvalidDomParser {
      parseFromString(): { documentElement: { namespaceURI: string; localName: string } } {
        return { documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml', localName: 'html' } };
      }
    }
    const invalidParsedRoot = {
      ownerDocument: { defaultView: { DOMParser: InvalidDomParser } },
    } as unknown as Element;
    expect(() => mountFaceletSvg(invalidParsedRoot, SOLVED_FACELETS)).toThrow(/failed to parse/iu);
  });
});
