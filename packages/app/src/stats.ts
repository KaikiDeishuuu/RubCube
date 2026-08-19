import type { SolveResult } from './store.js';
import { effectiveMs, formatMs, formatResult } from './timer.js';

/**
 * Session statistics over recorded solves.
 *
 * The averages follow the speedcubing convention rather than a plain mean: a
 * fixed number of the best and worst results are discarded before averaging, so
 * one lucky scramble and one pop do not both move the number. WCA regulation 9f
 * defines this for five solves; the trim generalises to the longer windows a
 * practice session cares about.
 */

export const AVERAGE_SIZES = Object.freeze([5, 12, 100] as const);

export type AverageSize = (typeof AVERAGE_SIZES)[number];

/**
 * How many results are discarded from each end of a window.
 *
 * One each for ao5 and ao12, and 5% for the long windows — the convention
 * csTimer uses, which keeps a single disaster in an ao100 from dominating a
 * number meant to describe a whole session.
 */
export function trimCount(size: number): number {
  return Math.max(1, Math.round(size / 20));
}

/** Effective time in ms, or null for a DNF, which has no time. */
export function resultMs(result: SolveResult): number | null {
  return effectiveMs(result.rawMs, result.penalty);
}

/**
 * Trimmed mean of one window, in ms. Null when too many attempts were DNFs.
 *
 * A DNF sorts as the worst possible result, so it is discarded like any other
 * outlier until the trim runs out. Past that the average itself is a DNF: there
 * is no time to substitute, and dropping the attempt instead would score a
 * failed solve as if it had not been attempted.
 */
export function averageOf(window: readonly (number | null)[]): number | null {
  const trim = trimCount(window.length);
  if (window.length <= trim * 2) return null;

  const dnfs = window.filter((value) => value === null).length;
  if (dnfs > trim) return null;

  const sorted = [...window].sort((a, b) => {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return a - b;
  });
  const kept = sorted.slice(trim, sorted.length - trim);
  // Every remaining entry is a real time: the DNFs were all inside the trim.
  const total = kept.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return total / kept.length;
}

/** The average over the most recent `size` results, or null if there are too few. */
export function currentAverage(
  results: readonly SolveResult[],
  size: number,
): number | null {
  if (results.length < size) return null;
  return averageOf(results.slice(results.length - size).map(resultMs));
}

/** The best such average over every window of `size` consecutive results. */
export function bestAverage(
  results: readonly SolveResult[],
  size: number,
): number | null {
  if (results.length < size) return null;
  const times = results.map(resultMs);
  let best: number | null = null;
  for (let start = 0; start + size <= times.length; start += 1) {
    const value = averageOf(times.slice(start, start + size));
    if (value === null) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

export interface AverageStat {
  readonly size: AverageSize;
  readonly current: number | null;
  readonly best: number | null;
}

export interface SessionStats {
  readonly count: number;
  /** Attempts that produced a time; the rest were DNFs. */
  readonly solved: number;
  readonly best: number | null;
  readonly worst: number | null;
  /**
   * Mean of every attempt that produced a time.
   *
   * Untrimmed, and explicitly over the solved attempts only: a session mean
   * including DNFs has no defined value, and dropping them silently would make
   * a session of near-misses look like a clean one.
   */
  readonly mean: number | null;
  readonly averages: readonly AverageStat[];
}

export function summarise(results: readonly SolveResult[]): SessionStats {
  const times = results
    .map(resultMs)
    .filter((value): value is number => value !== null);

  const mean =
    times.length === 0
      ? null
      : times.reduce((sum, value) => sum + value, 0) / times.length;

  return {
    count: results.length,
    solved: times.length,
    best: times.length === 0 ? null : Math.min(...times),
    worst: times.length === 0 ? null : Math.max(...times),
    mean,
    averages: AVERAGE_SIZES.map((size) => ({
      size,
      current: currentAverage(results, size),
      best: bestAverage(results, size),
    })),
  };
}

/** Renders a statistic, or an em dash when there is not enough data for one. */
export function formatStat(value: number | null): string {
  return value === null ? '—' : formatMs(value);
}

const CSV_COLUMNS = Object.freeze([
  'No.',
  'Time',
  'Comment',
  'Scramble',
  'Date',
  'P.1',
] as const);

function csvCell(value: string): string {
  // Quote everything and double any embedded quote. A scramble never contains
  // one today, but a format that only escapes when it must is a format that
  // breaks the first time an assumption changes.
  return `"${value.replace(/"/g, '""')}"`;
}

function csvDate(epochMs: number): string {
  const at = new Date(epochMs);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/**
 * Session export.
 *
 * The column set and semicolon delimiter are csTimer's, so the file opens in
 * the same places a csTimer export does. It has not been round-tripped through
 * a csTimer import, so treat it as "the same shape", not as a certified format.
 */
export function toCsv(results: readonly SolveResult[]): string {
  const rows = results.map((result, index) =>
    [
      String(index + 1),
      formatResult(result.rawMs, result.penalty),
      '',
      result.scramble,
      csvDate(result.recordedAt),
      result.penalty === 'plus2' ? '2' : '0',
    ]
      .map(csvCell)
      .join(';'),
  );
  // A trailing newline: a file whose last line has no terminator is the classic
  // way to lose the last row in a naive reader.
  return [CSV_COLUMNS.map(csvCell).join(';'), ...rows].join('\n') + '\n';
}
