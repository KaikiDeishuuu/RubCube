import { describe, expect, it } from 'vitest';

import {
  AVERAGE_SIZES,
  averageOf,
  bestAverage,
  currentAverage,
  formatStat,
  resultMs,
  summarise,
  toCsv,
  trimCount,
} from './stats.js';
import type { SolveResult } from './store.js';
import type { Penalty } from './timer.js';

let serial = 0;

function solve(rawMs: number, penalty: Penalty = 'none'): SolveResult {
  serial += 1;
  return {
    id: serial,
    recordedAt: Date.UTC(2026, 7, 19, 4, 0, serial),
    rawMs,
    penalty,
    scramble: "R U R' U'",
    scrambleSeed: 7,
  };
}

const seconds = (...values: readonly number[]): SolveResult[] =>
  values.map((value) => solve(value * 1_000));

describe('trim', () => {
  it.each([
    [3, 1],
    [5, 1],
    [12, 1],
    [20, 1],
    [50, 3],
    [100, 5],
  ])('discards %i results from each end of a window of %i', (size, expected) => {
    expect(trimCount(size)).toBe(expected);
  });

  it('never trims a window down to nothing', () => {
    // A window that trims away every entry has no average, and the guard below
    // must be the thing that says so rather than a division by zero.
    expect(averageOf([1, 2])).toBeNull();
    expect(averageOf([])).toBeNull();
  });
});

describe('trimmed average', () => {
  it('drops the best and the worst', () => {
    // 10 and 50 are discarded; the mean of 20, 30, 40 is 30.
    expect(averageOf([10, 50, 30, 20, 40])).toBe(30);
  });

  it('is unmoved by an outlier that the trim absorbs', () => {
    const steady = averageOf([10, 20, 30, 40, 50]);
    expect(averageOf([10, 20, 30, 40, 9_999])).toBe(steady);
  });

  it('treats a single DNF as the worst result and discards it', () => {
    // A DNF has no time, so it can only ever sort last. One of them lands
    // inside the trim and costs nothing beyond the attempt itself.
    expect(averageOf([10, 20, 30, 40, null])).toBe(averageOf([10, 20, 30, 40, 50]));
  });

  it('is itself a DNF once the DNFs outnumber the trim', () => {
    expect(averageOf([10, 20, 30, null, null])).toBeNull();
  });

  it('absorbs up to the trim count in a long window', () => {
    const times = Array.from({ length: 95 }, (_, index) => 10_000 + index);
    const five = [...times, null, null, null, null, null];
    expect(trimCount(100)).toBe(5);
    expect(five).toHaveLength(100);
    expect(averageOf(five)).not.toBeNull();

    // One more DNF than the trim can hold, at the same window length.
    const six = [...times.slice(1), null, null, null, null, null, null];
    expect(six).toHaveLength(100);
    expect(averageOf(six)).toBeNull();
  });
});

describe('session averages', () => {
  it('has no average until the window is full', () => {
    const four = seconds(10, 11, 12, 13);
    expect(currentAverage(four, 5)).toBeNull();
    expect(bestAverage(four, 5)).toBeNull();
    expect(currentAverage([...four, solve(14_000)], 5)).not.toBeNull();
  });

  it('reads the current average from the most recent window only', () => {
    const results = seconds(60, 60, 60, 10, 11, 12, 13, 14);
    // The last five are 11,12,13,14 plus the 10 before them: trimmed to 11..13.
    expect(currentAverage(results, 5)).toBe(12_000);
  });

  it('finds the best window anywhere in the session', () => {
    const results = seconds(9, 10, 11, 30, 30, 30, 30, 30);
    // The fastest window is the first five, not the trailing one.
    expect(bestAverage(results, 5)).toBeLessThan(currentAverage(results, 5) ?? 0);
    expect(bestAverage(results, 5)).toBe(averageOf(seconds(9, 10, 11, 30, 30).map(resultMs)));
  });

  it('skips windows whose average is a DNF when looking for the best', () => {
    const results = [
      ...seconds(30, 30, 30, 30, 30),
      solve(1_000, 'dnf'),
      solve(1_000, 'dnf'),
      ...seconds(1, 1, 1),
    ];
    // The trailing window has two DNFs and no average; the clean one stands.
    expect(currentAverage(results, 5)).toBeNull();
    expect(bestAverage(results, 5)).toBe(30_000);
  });
});

describe('penalties', () => {
  it('scores a +2 at the time it actually cost', () => {
    expect(resultMs(solve(10_000, 'plus2'))).toBe(12_000);
    expect(resultMs(solve(10_000, 'none'))).toBe(10_000);
    expect(resultMs(solve(10_000, 'dnf'))).toBeNull();
  });

  it('costs nothing on the worst solve of a window, because the trim eats it', () => {
    const clean = summarise(seconds(10, 11, 12, 13, 14));
    const penalised = summarise([...seconds(10, 11, 12, 13), solve(14_000, 'plus2')]);

    // The slowest solve was already being discarded, and 16s is still the
    // slowest. The penalty changes the recorded time and nothing else.
    expect(penalised.worst).toBe(16_000);
    expect(penalised.averages[0]?.current).toBe(clean.averages[0]?.current);
  });

  it('costs two seconds spread over the window when it lands in the middle', () => {
    const clean = summarise(seconds(10, 11, 12, 13, 14));
    const penalised = summarise([
      ...seconds(10, 11),
      solve(12_000, 'plus2'),
      ...seconds(13, 14),
    ]);

    // 14 is now the middle result and 12+2 the worst, so the kept three become
    // 11, 13, 14: two seconds shared across three solves.
    expect(penalised.averages[0]?.current).toBe(
      (clean.averages[0]?.current ?? 0) + 2_000 / 3,
    );
  });
});

describe('summary', () => {
  it('is empty and undefined for a session with nothing in it', () => {
    const stats = summarise([]);
    expect(stats).toMatchObject({ count: 0, solved: 0, best: null, worst: null, mean: null });
    expect(stats.averages.map((entry) => entry.size)).toEqual([...AVERAGE_SIZES]);
    for (const entry of stats.averages) {
      expect(entry).toMatchObject({ current: null, best: null });
    }
  });

  it('separates attempts from solves so a DNF is not silently dropped', () => {
    const stats = summarise([...seconds(10, 12), solve(30_000, 'dnf')]);
    expect(stats).toMatchObject({ count: 3, solved: 2, best: 10_000, worst: 12_000 });
    // The mean is over the two that produced a time, and says so by way of
    // `solved` sitting below `count`.
    expect(stats.mean).toBe(11_000);
  });

  it('reports nothing rather than zero when every attempt was a DNF', () => {
    const stats = summarise([solve(10_000, 'dnf'), solve(12_000, 'dnf')]);
    expect(stats).toMatchObject({ count: 2, solved: 0, best: null, worst: null, mean: null });
  });

  it('renders a missing statistic as a dash, not as zero', () => {
    expect(formatStat(null)).toBe('—');
    expect(formatStat(12_340)).toBe('12.34');
  });
});

describe('csv export', () => {
  it('writes a header, one row per attempt, and a final newline', () => {
    const csv = toCsv(seconds(10, 12));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"No.";"Time";"Comment";"Scramble";"Date";"P.1"');
    expect(lines).toHaveLength(4);
    // A file whose last row has no terminator is how a naive reader loses it.
    expect(lines.at(-1)).toBe('');
    expect(lines[1]).toContain('"1";"10.00"');
    expect(lines[2]).toContain('"2";"12.00"');
  });

  it('exports a penalty the way it is scored, not as an annotation', () => {
    const csv = toCsv([solve(10_000, 'plus2'), solve(10_000, 'dnf')]);
    const [, plus2, dnf] = csv.split('\n');
    // The +2 row carries the penalised time and flags the penalty column.
    expect(plus2).toContain('"12.00+"');
    expect(plus2?.endsWith('"2"')).toBe(true);
    expect(dnf).toContain('"DNF(10.00)"');
    expect(dnf?.endsWith('"0"')).toBe(true);
  });

  it('escapes a quote instead of ending the field early', () => {
    const csv = toCsv([{ ...solve(10_000), scramble: 'R "U" R' }]);
    expect(csv).toContain('"R ""U"" R"');
  });

  it('writes a real date, and an empty one for an unusable timestamp', () => {
    const DATE_COLUMN = 4;
    const good = toCsv([solve(10_000)]).split('\n')[1]?.split(';') ?? [];
    // Assert the column by position: the Comment column beside it is also
    // empty, so a substring match would pass no matter what the date held.
    expect(good[DATE_COLUMN]).toMatch(/^"2026-08-19 \d\d:\d\d:\d\d"$/);

    // A record restored from storage may carry anything; an export must not be
    // the place that discovers it, and must not emit "NaN-NaN-NaN" either.
    const broken = toCsv([{ ...solve(10_000), recordedAt: Number.NaN }])
      .split('\n')[1]
      ?.split(';') ?? [];
    expect(broken[DATE_COLUMN]).toBe('""');
  });

  it('exports an empty session as a header alone', () => {
    expect(toCsv([]).split('\n')).toHaveLength(2);
  });
});
