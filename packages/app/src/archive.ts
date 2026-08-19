import type { SolveResult } from './store.js';
import { PENALTIES, type Penalty } from './timer.js';

/**
 * Durable storage for a session's solves.
 *
 * IndexedDB rather than localStorage, per DESIGN.md 5.3: writes land off the
 * critical path, which matters because a save is triggered by finishing a solve
 * and a synchronous write there would jank the frame that shows the time. The
 * whole session is written as one record instead of one record per solve — the
 * store is the source of truth, and a per-record writer has to diff against it,
 * which is the kind of bookkeeping that silently drifts.
 */

const DATABASE_NAME = 'rubcube';
const DATABASE_VERSION = 1;
const STORE_NAME = 'sessions';
const SESSION_KEY = 'default';

const PENALTY_SET: ReadonlySet<string> = new Set<string>(PENALTIES);

function isPenalty(value: unknown): value is Penalty {
  return typeof value === 'string' && PENALTY_SET.has(value);
}

function parseResult(value: unknown): SolveResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const { id, recordedAt, rawMs, penalty, scramble, scrambleSeed } = record;
  if (!Number.isSafeInteger(id) || (id as number) < 0) return null;
  if (!Number.isFinite(recordedAt)) return null;
  if (!Number.isFinite(rawMs) || (rawMs as number) < 0) return null;
  if (!isPenalty(penalty)) return null;
  if (typeof scramble !== 'string') return null;
  if (scrambleSeed !== null && !Number.isSafeInteger(scrambleSeed)) return null;

  return {
    id: id as number,
    recordedAt: recordedAt as number,
    rawMs: rawMs as number,
    penalty,
    scramble,
    scrambleSeed: scrambleSeed as number | null,
  };
}

/**
 * Reads a stored session back into results, dropping anything unusable.
 *
 * Storage is untrusted input: it may hold records written by an older build, or
 * edited by hand, or truncated. One malformed entry must cost that entry rather
 * than the session, so a session that fails to parse in part still loads — and
 * a value that is not a list at all loads as an empty session, not a crash.
 */
export function parseResults(value: unknown): SolveResult[] {
  if (!Array.isArray(value)) return [];
  const results: SolveResult[] = [];
  for (const entry of value) {
    const parsed = parseResult(entry);
    if (parsed !== null) results.push(parsed);
  }
  // Ordering is the session's own, and every statistic depends on it: an
  // average is a window over consecutive attempts, so a shuffled restore would
  // silently produce different numbers from the same solves.
  results.sort((left, right) => left.recordedAt - right.recordedAt || left.id - right.id);
  return results;
}

export interface SolveArchive {
  load(): Promise<SolveResult[]>;
  save(results: readonly SolveResult[]): Promise<void>;
  close(): void;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function resolveFactory(factory?: IDBFactory | null): IDBFactory | null {
  if (factory != null) return factory;
  try {
    // Reading the property throws outright in some privacy modes, so this is
    // guarded rather than merely checked for undefined.
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens the session store, or returns null where IndexedDB is unavailable.
 *
 * Null rather than a throwing stub: persistence is an enhancement, and a
 * browser without it should keep a working in-memory session rather than fail
 * to start.
 */
export function createSolveArchive(factory?: IDBFactory | null): SolveArchive | null {
  const idb = resolveFactory(factory);
  if (idb === null) return null;

  let handle: Promise<IDBDatabase> | null = null;
  let closed = false;

  const open = (): Promise<IDBDatabase> => {
    handle ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      // Another tab holding an old version open. Failing is right: this tab
      // must not write through a schema it no longer agrees on.
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
    return handle;
  };

  return {
    async load() {
      if (closed) return [];
      try {
        const database = await open();
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const stored = await requestToPromise(
          transaction.objectStore(STORE_NAME).get(SESSION_KEY),
        );
        return parseResults(stored);
      } catch {
        // A session that cannot be read is a session that starts empty, not an
        // app that refuses to start.
        return [];
      }
    },

    async save(results) {
      if (closed) return;
      try {
        const database = await open();
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        // Structured clone copies the array, but the entries are shared with
        // live store state until it does; copying here keeps a later edit from
        // racing the write.
        transaction.objectStore(STORE_NAME).put(results.map((r) => ({ ...r })), SESSION_KEY);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB write aborted'));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('IndexedDB write failed'));
        });
      } catch {
        // Quota exhausted, or storage revoked mid-session. The session still
        // works; only its durability is lost.
      }
    },

    close() {
      closed = true;
      const pending = handle;
      handle = null;
      if (pending === null) return;
      void pending.then(
        (database) => database.close(),
        () => undefined,
      );
    },
  };
}
