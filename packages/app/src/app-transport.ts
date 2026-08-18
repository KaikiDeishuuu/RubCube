import type { CubeState } from '@rubcube/cube-core';
import {
  CommitDispatcher,
  type MoveTransportBackendFactory,
} from '@rubcube/cube-render/transport';

import { useCubeStore } from './store.js';

export interface AppDispatcherOptions {
  readonly initialState: CubeState;
  readonly initialRevision: number;
  readonly createBackend: MoveTransportBackendFactory;
  /** Test seam; production uses the module's shared Zustand store. */
  readonly store?: Pick<typeof useCubeStore, 'getState'>;
  /** Invalidates callbacks from a renderer that has lost backend ownership. */
  readonly isCurrent?: () => boolean;
}

/**
 * Bind one concrete renderer backend to the app's single authoritative store.
 *
 * WebGL and fallback use this exact path.  In particular, neither backend is
 * allowed to publish CubeState directly: committed facts first pass through
 * CommitDispatcher, then history and the live cube are reduced atomically.
 */
export function createAppDispatcher(
  options: AppDispatcherOptions,
): CommitDispatcher {
  let dispatcher: CommitDispatcher | null = null;
  const store = options.store ?? useCubeStore;
  const isCurrent = options.isCurrent ?? (() => true);

  dispatcher = new CommitDispatcher({
    initialState: options.initialState,
    initialRevision: options.initialRevision,
    createBackend: options.createBackend,
    onDispatch: (event) => {
      if (!isCurrent()) return;
      store.getState().handleDispatchEvent(event);
    },
    onDispatchError: (event, error, latestCommittedState, source) => {
      if (!isCurrent() || source === 'observer') return;
      store
        .getState()
        .enterDispatchFatal(event, latestCommittedState, error);
    },
    onRevisionChange: (commandRevision) => {
      if (!isCurrent()) return;
      // Acceptance has already staged work (or registered a live command), so
      // the dispatcher is observably busy even before the backend is entered.
      store.getState().syncTransportStatus({
        isBusy: true,
        isFatal: dispatcher?.isFatal ?? false,
        commandRevision,
      });
    },
    onBusyChange: (isBusy) => {
      if (!isCurrent()) return;
      // Busy notifications cannot fire from a conforming backend factory, so
      // dispatcher is initialized by the time the first edge is observable.
      const commandRevision = dispatcher?.commandRevision ?? options.initialRevision;
      store.getState().syncTransportStatus({
        isBusy,
        isFatal: dispatcher?.isFatal ?? false,
        commandRevision,
      });
    },
  });

  if (isCurrent()) {
    store.getState().syncTransportStatus({
      isBusy: dispatcher.isBusy,
      isFatal: dispatcher.isFatal,
      commandRevision: dispatcher.commandRevision,
    });
  }
  return dispatcher;
}
