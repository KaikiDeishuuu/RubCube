/**
 * Small, synchronous user preferences.
 *
 * Deliberately not the store for solve results: this is for the handful of
 * booleans the UI needs before its first paint, where an async read would show
 * the wrong toggle state for a frame.
 *
 * Every access is guarded. Reading `localStorage` at all throws when a browser
 * has site data disabled, and writing throws when the origin's quota is full,
 * so a preference that cannot be persisted degrades to its default instead of
 * taking the app down.
 */

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SOUND_KEY = 'rubcube.sound';

/**
 * Sound defaults to off.
 *
 * A page that makes noise before the visitor has asked for any gets closed, and
 * the first turn is not a good moment to discover the tab has a speaker.
 */
const SOUND_DEFAULT = false;

function defaultStorage(): PreferenceStorage | null {
  try {
    const storage = globalThis.localStorage;
    return typeof storage?.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

function read(key: string, storage: PreferenceStorage | null): string | null {
  const target = storage ?? defaultStorage();
  if (target === null) return null;
  try {
    return target.getItem(key);
  } catch {
    return null;
  }
}

function write(
  key: string,
  value: string,
  storage: PreferenceStorage | null,
): void {
  const target = storage ?? defaultStorage();
  if (target === null) return;
  try {
    target.setItem(key, value);
  } catch {
    // Quota exhausted or storage revoked mid-session. The setting still applies
    // to this session; only its persistence is lost.
  }
}

export function readSoundEnabled(
  storage: PreferenceStorage | null = null,
): boolean {
  const raw = read(SOUND_KEY, storage);
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return SOUND_DEFAULT;
}

export function writeSoundEnabled(
  enabled: boolean,
  storage: PreferenceStorage | null = null,
): void {
  write(SOUND_KEY, enabled ? 'on' : 'off', storage);
}
