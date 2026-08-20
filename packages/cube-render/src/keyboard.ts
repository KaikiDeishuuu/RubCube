import type { Move } from '@rubcube/cube-core';

/**
 * Keyed by `KeyboardEvent.code` — the key's physical position, not the
 * character printed on it.
 *
 * csTimer, whose layout this follows, keys off the deprecated `event.keyCode`,
 * so its controls scatter across the board on Dvorak, AZERTY and Colemak: U, R
 * and R' (J, I, K) all land under the left hand on Dvorak. That has been open
 * upstream as cs0x7f/cstimer#72 for years. `code` fixes it at the source,
 * because the key under the right index finger stays the key under the right
 * index finger whatever the layout says it types. It also retires a whole class
 * of locale bug: `key` had to be lowercased, and Turkish folds 'I' to a dotless
 * 'ı', which would silently unbind R.
 *
 * The cost is that the letters shown in the UI are no longer implied by the
 * binding. {@link keyLabelForCode} gives the QWERTY letter, and a caller with
 * `navigator.keyboard.getLayoutMap()` can do better.
 */
export type KeyboardMoveMap = Readonly<Record<string, Move>>;

function move(face: Move['face'], turns: 1 | 2 | 3): Readonly<Move> {
  return Object.freeze({ face, turns });
}

/**
 * csTimer's layout, transcribed from its own `generateCubeKeyMapping`.
 *
 * The logic is fingertricks: U is J because J is what the right index finger
 * presses. Slices get a key for each hand where csTimer gives one - M' on both
 * `.` and X, M on both 5 and 6 - and E and S get one each, which is csTimer's
 * own asymmetry rather than an omission here.
 *
 * No double-turn keys, also following csTimer: U2 is J pressed twice.
 */
export const DEFAULT_KEYBOARD_MOVES: KeyboardMoveMap = Object.freeze({
  KeyJ: move('U', 1),
  KeyF: move('U', 3),
  KeyI: move('R', 1),
  KeyK: move('R', 3),
  KeyE: move('L', 1),
  KeyD: move('L', 3),
  KeyH: move('F', 1),
  KeyG: move('F', 3),
  KeyS: move('D', 1),
  KeyL: move('D', 3),
  KeyW: move('B', 1),
  KeyO: move('B', 3),

  // M follows L, E follows D, S follows F, which is what makes R M' L' an x
  // rotation. cube-core uses the same convention, so these transcribe directly.
  Digit5: move('M', 1),
  Digit6: move('M', 1),
  Period: move('M', 3),
  KeyX: move('M', 3),
  Digit2: move('E', 1),
  Digit9: move('E', 3),
  Digit0: move('S', 1),
  Digit1: move('S', 3),
});

export function moveForCode(
  code: string,
  mapping: KeyboardMoveMap = DEFAULT_KEYBOARD_MOVES,
): Move | null {
  // No case folding and no normalisation: `code` values are a fixed vocabulary
  // and already comparable.
  return mapping[code] ?? null;
}

const PUNCTUATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
});

/**
 * What a QWERTY board prints on that physical key.
 *
 * A fallback, not a claim about the reader's keyboard: a caller that can reach
 * `navigator.keyboard.getLayoutMap()` should prefer it and use this only when
 * the map has no entry, which is what non-Chromium browsers will always do.
 */
export function keyLabelForCode(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1]!;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit !== null) return digit[1]!;
  return PUNCTUATION_LABELS[code] ?? code;
}

/** Every code bound to a move, in mapping order; empty when it is unbound. */
export function codesForMove(
  target: Move,
  mapping: KeyboardMoveMap = DEFAULT_KEYBOARD_MOVES,
): string[] {
  return Object.keys(mapping).filter((code) => {
    const bound = mapping[code]!;
    return bound.face === target.face && bound.turns === target.turns;
  });
}

/**
 * Binds `code` to `move`, dropping whatever else pointed at either.
 *
 * A rebind collapses a move onto the one key just pressed, so a move that
 * shipped with a key for each hand keeps only the new one. That is the
 * predictable reading of "bind this to that", and the defaults are one Reset
 * away.
 */
export function withBinding(
  mapping: KeyboardMoveMap,
  code: string,
  move: Move,
): KeyboardMoveMap {
  const next: Record<string, Move> = {};
  for (const [existing, bound] of Object.entries(mapping)) {
    if (existing === code) continue;
    if (bound.face === move.face && bound.turns === move.turns) continue;
    next[existing] = bound;
  }
  next[code] = Object.freeze({ face: move.face, turns: move.turns });
  return Object.freeze(next);
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

export class KeyboardMoveController {
  constructor(
    private readonly target: Window | HTMLElement,
    private readonly onMove: (move: Move) => void,
    private readonly mapping: KeyboardMoveMap = DEFAULT_KEYBOARD_MOVES,
  ) {
    this.target.addEventListener('keydown', this.onKeyDown as EventListener);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    const move = moveForCode(event.code, this.mapping);
    if (move === null) return;
    event.preventDefault();
    this.onMove(move);
  };
}
