import { describe, expect, it } from 'vitest';

import { DEFAULT_KEYBOARD_MOVES, moveForKey } from '../src/keyboard.js';

describe('keyboard move mapping', () => {
  it('matches the documented csTimer-style anchors', () => {
    expect(moveForKey('j')).toEqual({ face: 'U', turns: 1 });
    expect(moveForKey('f')).toEqual({ face: 'U', turns: 3 });
    expect(moveForKey('i')).toEqual({ face: 'R', turns: 1 });
    expect(moveForKey('d')).toEqual({ face: 'L', turns: 3 });
  });

  it('is case-insensitive and ignores unmapped keys', () => {
    expect(moveForKey('J')).toEqual({ face: 'U', turns: 1 });
    expect(moveForKey('Escape')).toBeNull();
  });

  it('accepts a custom map without mutating the defaults', () => {
    const custom = { q: { face: 'F', turns: 2 } } as const;
    expect(moveForKey('q', custom)).toEqual({ face: 'F', turns: 2 });
    expect(moveForKey('q', DEFAULT_KEYBOARD_MOVES)).toBeNull();
    expect(Object.isFrozen(DEFAULT_KEYBOARD_MOVES)).toBe(true);
  });
});
