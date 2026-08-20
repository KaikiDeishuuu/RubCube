import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEYBOARD_MOVES,
  codesForMove,
  keyLabelForCode,
  moveForCode,
  withBinding,
} from '../src/keyboard.js';

describe('keyboard move mapping', () => {
  it('matches csTimer at every face key', () => {
    // Transcribed from cstimer's own generateCubeKeyMapping, so a drift here is
    // a drift away from the layout players already have in their fingers.
    const faces: readonly [string, string, 1 | 3][] = [
      ['KeyJ', 'U', 1], ['KeyF', 'U', 3],
      ['KeyI', 'R', 1], ['KeyK', 'R', 3],
      ['KeyE', 'L', 1], ['KeyD', 'L', 3],
      ['KeyH', 'F', 1], ['KeyG', 'F', 3],
      ['KeyS', 'D', 1], ['KeyL', 'D', 3],
      ['KeyW', 'B', 1], ['KeyO', 'B', 3],
    ];
    for (const [code, face, turns] of faces) {
      expect(moveForCode(code)).toEqual({ face, turns });
    }
  });

  it('binds the three slices, mirroring M for both hands', () => {
    expect(moveForCode('Digit5')).toEqual({ face: 'M', turns: 1 });
    expect(moveForCode('Digit6')).toEqual({ face: 'M', turns: 1 });
    expect(moveForCode('Period')).toEqual({ face: 'M', turns: 3 });
    expect(moveForCode('KeyX')).toEqual({ face: 'M', turns: 3 });
    expect(moveForCode('Digit2')).toEqual({ face: 'E', turns: 1 });
    expect(moveForCode('Digit9')).toEqual({ face: 'E', turns: 3 });
    expect(moveForCode('Digit0')).toEqual({ face: 'S', turns: 1 });
    expect(moveForCode('Digit1')).toEqual({ face: 'S', turns: 3 });
  });

  it('reads a physical position, not a character', () => {
    // The whole point of keying on `code`: 'j' is what a QWERTY board types
    // there, and on Dvorak the same physical key types 'h'. Neither string is
    // the binding.
    expect(moveForCode('j')).toBeNull();
    expect(moveForCode('J')).toBeNull();
    expect(moveForCode('Escape')).toBeNull();
    expect(moveForCode('')).toBeNull();
  });

  it('accepts a custom map without mutating the defaults', () => {
    const custom = { KeyQ: { face: 'F', turns: 2 } } as const;
    expect(moveForCode('KeyQ', custom)).toEqual({ face: 'F', turns: 2 });
    expect(moveForCode('KeyQ', DEFAULT_KEYBOARD_MOVES)).toBeNull();
    expect(Object.isFrozen(DEFAULT_KEYBOARD_MOVES)).toBe(true);
  });

  it('never binds one key to two moves', () => {
    // A map is code -> move, so this holds by construction; the assertion is
    // that no edit to the defaults quietly introduced a duplicate object key.
    expect(Object.keys(DEFAULT_KEYBOARD_MOVES)).toHaveLength(20);
  });
});

describe('key labels', () => {
  it.each([
    ['KeyJ', 'J'],
    ['KeyX', 'X'],
    ['Digit5', '5'],
    ['Numpad0', '0'],
    ['Period', '.'],
    ['Slash', '/'],
    ['Space', 'Space'],
  ])('renders %s as %s', (code, label) => {
    expect(keyLabelForCode(code)).toBe(label);
  });

  it('falls back to the code itself for anything unrecognised', () => {
    // Better a visible "F13" than a blank key cap.
    expect(keyLabelForCode('F13')).toBe('F13');
    expect(keyLabelForCode('IntlBackslash')).toBe('IntlBackslash');
  });
});

describe('rebinding', () => {
  it('lists every code bound to a move', () => {
    expect(codesForMove({ face: 'M', turns: 3 })).toEqual(['Period', 'KeyX']);
    expect(codesForMove({ face: 'U', turns: 1 })).toEqual(['KeyJ']);
    expect(codesForMove({ face: 'U', turns: 2 })).toEqual([]);
  });

  it('collapses a move onto the key just pressed', () => {
    const next = withBinding(DEFAULT_KEYBOARD_MOVES, 'KeyQ', { face: 'M', turns: 3 });
    expect(codesForMove({ face: 'M', turns: 3 }, next)).toEqual(['KeyQ']);
    expect(moveForCode('Period', next)).toBeNull();
    expect(moveForCode('KeyX', next)).toBeNull();
  });

  it('steals a key from whatever held it', () => {
    // Otherwise one press would fire two moves, and which one would depend on
    // object key order.
    const next = withBinding(DEFAULT_KEYBOARD_MOVES, 'KeyJ', { face: 'B', turns: 1 });
    expect(moveForCode('KeyJ', next)).toEqual({ face: 'B', turns: 1 });
    expect(codesForMove({ face: 'U', turns: 1 }, next)).toEqual([]);
    expect(codesForMove({ face: 'B', turns: 1 }, next)).toEqual(['KeyJ']);
  });

  it('leaves the map it was given untouched', () => {
    const before = { ...DEFAULT_KEYBOARD_MOVES };
    const next = withBinding(DEFAULT_KEYBOARD_MOVES, 'KeyQ', { face: 'U', turns: 1 });
    expect(DEFAULT_KEYBOARD_MOVES).toEqual(before);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('is a no-op when the key already holds that move', () => {
    const next = withBinding(DEFAULT_KEYBOARD_MOVES, 'KeyJ', { face: 'U', turns: 1 });
    expect(next).toEqual(DEFAULT_KEYBOARD_MOVES);
  });
});
