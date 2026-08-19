import { describe, expect, it } from 'vitest';

import { createSolveArchive, parseResults } from './archive.js';
import type { SolveResult } from './store.js';

const VALID: SolveResult = Object.freeze({
  id: 3,
  recordedAt: 1_755_000_000_000,
  rawMs: 12_340,
  penalty: 'none',
  scramble: "R U R' U'",
  scrambleSeed: 42,
});

describe('restoring a stored session', () => {
  it('reads back a well-formed session unchanged', () => {
    expect(parseResults([VALID])).toEqual([VALID]);
  });

  it('accepts a solve that had no seeded scramble', () => {
    expect(parseResults([{ ...VALID, scrambleSeed: null }])).toHaveLength(1);
  });

  it('loads an empty session for anything that is not a list', () => {
    // A missing key reads as undefined, and an older build may have written
    // something else entirely under it.
    for (const value of [undefined, null, 0, 'x', {}, { results: [VALID] }]) {
      expect(parseResults(value)).toEqual([]);
    }
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['a fractional id', { id: 1.5 }],
    ['a negative id', { id: -1 }],
    ['an unusable timestamp', { recordedAt: Number.NaN }],
    ['a negative duration', { rawMs: -1 }],
    ['an infinite duration', { rawMs: Number.POSITIVE_INFINITY }],
    ['a penalty this build does not know', { penalty: 'plus4' }],
    ['a non-string scramble', { scramble: 42 }],
    ['a fractional seed', { scrambleSeed: 0.5 }],
  ])('drops a record with %s', (_label, overrides) => {
    expect(parseResults([{ ...VALID, ...overrides }])).toEqual([]);
  });

  it('drops only the unusable records, not the session around them', () => {
    // One corrupt entry must cost that entry. Losing a whole practice session
    // to a single bad row is the failure worth designing against.
    const stored = [
      { ...VALID, id: 1, recordedAt: 1 },
      { ...VALID, id: 2, recordedAt: 2, penalty: 'nope' },
      { ...VALID, id: 3, recordedAt: 3 },
      'not a record',
      { ...VALID, id: 4, recordedAt: 4 },
    ];
    expect(parseResults(stored).map((result) => result.id)).toEqual([1, 3, 4]);
  });

  it('restores the session in its own order', () => {
    // Every average is a window over consecutive attempts, so a shuffled
    // restore would produce different numbers from the same solves.
    const stored = [
      { ...VALID, id: 9, recordedAt: 300 },
      { ...VALID, id: 7, recordedAt: 100 },
      { ...VALID, id: 8, recordedAt: 200 },
    ];
    expect(parseResults(stored).map((result) => result.id)).toEqual([7, 8, 9]);
  });

  it('breaks a timestamp tie by id rather than leaving it to sort stability', () => {
    const stored = [
      { ...VALID, id: 6, recordedAt: 100 },
      { ...VALID, id: 5, recordedAt: 100 },
    ];
    expect(parseResults(stored).map((result) => result.id)).toEqual([5, 6]);
  });

  it('copies rather than aliasing the stored objects', () => {
    const stored = [{ ...VALID }];
    const [restored] = parseResults(stored);
    expect(restored).not.toBe(stored[0]);
  });
});

describe('archive availability', () => {
  it('returns null where IndexedDB does not exist', () => {
    // Node has none, which is the same shape as a browser that has revoked it:
    // the session works, it just does not outlive the tab.
    expect(createSolveArchive()).toBeNull();
    expect(createSolveArchive(null)).toBeNull();
  });
});
