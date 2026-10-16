import { useSyncExternalStore } from 'react';

type Readable<S> = { get(): S; subscribe(fn: () => void): () => void };

/** The store's snapshot, or `selector`'s pick of it; re-renders on every change. `selector` must return a stable value. */
export function useStore<S>(store: Readable<S>): S;
export function useStore<S, T>(store: Readable<S>, selector: (s: S) => T): T;
export function useStore<S, T>(store: Readable<S>, selector?: (s: S) => T): S | T {
  const snap = useSyncExternalStore(store.subscribe, store.get);
  return selector ? selector(snap) : snap;
}
