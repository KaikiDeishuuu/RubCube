import type { TableArtifact, TableStore } from '@rubcube/cube-core/solver';

/**
 * IndexedDB cache for the solver's lookup tables.
 *
 * Generating them takes most of a second, which is a long time to spend on
 * every visit for something that is a pure function of the fingerprint. The
 * artifact carries its own version, checksum and fingerprint, so a stale or
 * truncated record is rejected by the decoder rather than trusted from here.
 *
 * Its own database, not a second store beside the solve archive: two modules
 * opening one database would have to agree on a version number, and the first
 * one to bump it would silently block the other.
 */

const DATABASE_NAME = 'rubcube-solver-tables';
const DATABASE_VERSION = 1;
const STORE_NAME = 'artifacts';

/**
 * How long either half of the cache may take before it is treated as absent.
 *
 * The contract requires an adapter to reject rather than stay pending: a
 * never-settling load would leave `ready()` hanging, and the deterministic
 * generator is right there as a fallback.
 */
const OPERATION_TIMEOUT_MS = 5_000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Solver table cache timed out while ${label}`));
    }, OPERATION_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () =>
      reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

function resolveFactory(factory?: IDBFactory | null): IDBFactory | null {
  if (factory != null) return factory;
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

/**
 * A table cache, or undefined where IndexedDB is unavailable.
 *
 * Undefined rather than a stub: `loadTables` treats a missing store as "always
 * generate", which is exactly the right behaviour and needs no null object.
 */
export function createTableCache(factory?: IDBFactory | null): TableStore | undefined {
  const idb = resolveFactory(factory);
  if (idb === null) return undefined;

  let handle: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    handle ??= openDatabase(idb);
    return handle;
  };

  return {
    async load(key: string): Promise<TableArtifact | null> {
      return withTimeout(
        (async () => {
          const database = await open();
          const transaction = database.transaction(STORE_NAME, 'readonly');
          const stored: unknown = await requestToPromise(
            transaction.objectStore(STORE_NAME).get(key),
          );
          // Only the shape is checked here. Everything that decides whether the
          // bytes are usable — format version, fingerprint, length, checksum —
          // is the decoder's job, and duplicating it would let the two drift.
          if (typeof stored !== 'object' || stored === null) return null;
          return stored as TableArtifact;
        })(),
        'reading',
      );
    },

    async save(key: string, artifact: TableArtifact): Promise<void> {
      return withTimeout(
        (async () => {
          const database = await open();
          const transaction = database.transaction(STORE_NAME, 'readwrite');
          transaction.objectStore(STORE_NAME).put(artifact, key);
          await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () =>
              reject(transaction.error ?? new Error('IndexedDB write aborted'));
            transaction.onerror = () =>
              reject(transaction.error ?? new Error('IndexedDB write failed'));
          });
        })(),
        'writing',
      );
    },
  };
}
