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

import { parseMoves, serializeMove, type Move } from '@rubcube/cube-core';
import type { KeyboardMoveMap } from '@rubcube/cube-render/keyboard';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SOUND_KEY = 'rubcube.sound';
const KEYBOARD_KEY = 'rubcube.keyboard';

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

/**
 * A custom key map, or null to mean "use the shipped defaults".
 *
 * Stored as `{ code: notation }` rather than `{ code: { face, turns } }` so the
 * value is readable in devtools and, more usefully, so reading it back runs
 * through the same move parser everything else does. A hand-edited or
 * half-written entry then fails as a parse error rather than arriving as a
 * plausible-looking object with a `turns` of 7.
 *
 * Any invalid entry discards the whole map. Skipping just the bad ones would
 * silently unbind a key and leave the player hunting for which one; falling all
 * the way back to the defaults is the one outcome that is obvious from the UI.
 */
export function readKeyboardMoves(
  storage: PreferenceStorage | null = null,
): KeyboardMoveMap | null {
  const raw = read(KEYBOARD_KEY, storage);
  if (raw === null || raw === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const mapping: Record<string, Move> = {};
  for (const [code, notation] of Object.entries(parsed)) {
    if (code === '' || typeof notation !== 'string') return null;
    let moves: readonly Move[];
    try {
      moves = parseMoves(notation);
    } catch {
      // Swallowed rather than narrowed to MoveParseError and rethrown: this
      // module's contract is that a preference never takes the app down, and
      // this runs before first paint.
      return null;
    }
    // One key, one move. A stored "R U" would otherwise turn a single press
    // into an algorithm, which is a different feature and not this one.
    if (moves.length !== 1) return null;
    mapping[code] = Object.freeze({ ...moves[0]! });
  }

  // An empty map would leave the keyboard silent with no way back but clearing
  // site data, and no edit path produces one, so read it as "no preference".
  return Object.keys(mapping).length === 0 ? null : Object.freeze(mapping);
}

/** Persists a map, or clears the preference when given null. */
export function writeKeyboardMoves(
  mapping: KeyboardMoveMap | null,
  storage: PreferenceStorage | null = null,
): void {
  if (mapping === null) {
    // Written empty rather than removed: `PreferenceStorage` is the two methods
    // the injected doubles implement, and "never set" and "reset" mean the same
    // thing on the way back in.
    write(KEYBOARD_KEY, '', storage);
    return;
  }
  const encoded: Record<string, string> = {};
  for (const [code, move] of Object.entries(mapping)) {
    encoded[code] = serializeMove(move);
  }
  write(KEYBOARD_KEY, JSON.stringify(encoded), storage);
}
