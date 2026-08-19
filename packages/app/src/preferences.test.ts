import { describe, expect, it } from 'vitest';

import {
  readSoundEnabled,
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
