import { describe, expect, it } from 'vitest';

import { DEFAULT_KEYBOARD_MOVES } from '@rubcube/cube-render/keyboard';

import {
  readKeyboardMoves,
  readSoundEnabled,
  writeKeyboardMoves,
  writeSoundEnabled,
  type PreferenceStorage,
} from './preferences.js';

function memoryStorage(seed: Readonly<Record<string, string>> = {}): PreferenceStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const HOSTILE: PreferenceStorage = {
  getItem() {
    throw new DOMException('storage disabled', 'SecurityError');
  },
  setItem() {
    throw new DOMException('quota exceeded', 'QuotaExceededError');
  },
};

describe('sound preference', () => {
  it('defaults to off so a first visit is silent', () => {
    expect(readSoundEnabled(memoryStorage())).toBe(false);
  });

  it('round-trips both settings', () => {
    const storage = memoryStorage();
    writeSoundEnabled(true, storage);
    expect(readSoundEnabled(storage)).toBe(true);
    writeSoundEnabled(false, storage);
    expect(readSoundEnabled(storage)).toBe(false);
  });

  it('falls back to the default for a value it did not write', () => {
    // Another origin's key collision, a half-finished migration, or a user
    // editing storage by hand must not produce a third state.
    expect(readSoundEnabled(memoryStorage({ 'rubcube.sound': 'true' }))).toBe(false);
    expect(readSoundEnabled(memoryStorage({ 'rubcube.sound': '' }))).toBe(false);
  });

  it('survives storage that throws on access', () => {
    // Reading localStorage at all throws when site data is blocked, and writing
    // throws when the origin is out of quota.
    expect(readSoundEnabled(HOSTILE)).toBe(false);
    expect(() => writeSoundEnabled(true, HOSTILE)).not.toThrow();
  });

  it('reads the default when no storage exists at all', () => {
    // Node has no localStorage, which is the same shape as a browser that has
    // revoked it: the setting still applies for the session, it just does not
    // outlive the tab.
    expect(readSoundEnabled()).toBe(false);
    expect(() => writeSoundEnabled(true)).not.toThrow();
  });
});

const KEYBOARD_KEY = 'rubcube.keyboard';

describe('keyboard preference', () => {
  it('reads as null when nothing was ever stored', () => {
    // Null means "use the shipped defaults", which is what the caller falls
    // back to; an empty map here would silence the keyboard.
    expect(readKeyboardMoves(memoryStorage())).toBeNull();
  });

  it('round-trips a custom map through move notation', () => {
    const storage = memoryStorage();
    const mapping = { KeyQ: { face: 'U', turns: 1 }, KeyW: { face: 'M', turns: 3 } } as const;
    writeKeyboardMoves(mapping, storage);
    expect(storage.getItem(KEYBOARD_KEY)).toBe('{"KeyQ":"U","KeyW":"M\'"}');
    expect(readKeyboardMoves(storage)).toEqual(mapping);
  });

  it('round-trips the shipped defaults, slices included', () => {
    const storage = memoryStorage();
    writeKeyboardMoves(DEFAULT_KEYBOARD_MOVES, storage);
    expect(readKeyboardMoves(storage)).toEqual(DEFAULT_KEYBOARD_MOVES);
  });

  it('clears back to the defaults when given null', () => {
    const storage = memoryStorage();
    writeKeyboardMoves({ KeyQ: { face: 'U', turns: 1 } }, storage);
    writeKeyboardMoves(null, storage);
    expect(readKeyboardMoves(storage)).toBeNull();
  });

  it.each([
    ['not JSON at all', 'KeyJ=U'],
    ['a JSON array', '["KeyJ"]'],
    ['a JSON scalar', '"KeyJ"'],
    ['null', 'null'],
    ['a non-string binding', '{"KeyJ":3}'],
    ['an unparseable move', '{"KeyJ":"Q"}'],
    ['an empty code', '{"":"U"}'],
    ['an empty map', '{}'],
  ])('falls back to the defaults for %s', (_label, stored) => {
    expect(readKeyboardMoves(memoryStorage({ [KEYBOARD_KEY]: stored }))).toBeNull();
  });

  it('refuses a binding holding more than one move', () => {
    // One key, one turn. A stored algorithm would make a single press fire a
    // whole sequence, which is what the formula field is for.
    expect(readKeyboardMoves(memoryStorage({ [KEYBOARD_KEY]: '{"KeyJ":"R U"}' }))).toBeNull();
  });

  it('discards the whole map when one entry is bad', () => {
    // Skipping only the bad entry would silently unbind one key and leave the
    // player hunting for which; a full reset is visible in the panel.
    const stored = '{"KeyQ":"U","KeyW":"nonsense"}';
    expect(readKeyboardMoves(memoryStorage({ [KEYBOARD_KEY]: stored }))).toBeNull();
  });

  it('survives storage that throws on every access', () => {
    expect(readKeyboardMoves(HOSTILE)).toBeNull();
    expect(() => writeKeyboardMoves(DEFAULT_KEYBOARD_MOVES, HOSTILE)).not.toThrow();
    expect(() => writeKeyboardMoves(null, HOSTILE)).not.toThrow();
  });

  it('freezes what it hands back', () => {
    const storage = memoryStorage({ [KEYBOARD_KEY]: '{"KeyQ":"U"}' });
    const mapping = readKeyboardMoves(storage);
    expect(mapping).not.toBeNull();
    expect(Object.isFrozen(mapping)).toBe(true);
  });
});
