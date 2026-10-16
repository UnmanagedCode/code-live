// A tiny observable state cell: `set` replaces the snapshot with a merged
// copy, so a React `useSyncExternalStore` reader sees every change.

/**
 * @template S
 * @param {S} initial
 */
export function createStore(initial) {
  let snapshot = initial;
  const subscribers = new Set();
  return {
    /** @returns {S} */
    get: () => snapshot,
    /** @param {Partial<S>} patch */
    set(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const fn of [...subscribers]) fn();
    },
    /** @param {() => void} fn */
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
  };
}
