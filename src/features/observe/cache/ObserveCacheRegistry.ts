import type { ObserveResultCacheStore } from "./ObserveResultCacheStore";
import { FileSystemObserveCacheStore } from "./FileSystemObserveCacheStore";

/**
 * Module-level singleton for the observe-result cache store.
 *
 * Production code reads the cache via {@link getObserveCacheStore} (returns
 * a {@link FileSystemObserveCacheStore} by default). Tests can replace the
 * instance with a fake via {@link setObserveCacheStore} and restore the
 * default with {@link resetObserveCacheStore}.
 */
let instance: ObserveResultCacheStore = new FileSystemObserveCacheStore();

export function getObserveCacheStore(): ObserveResultCacheStore {
  return instance;
}

export function setObserveCacheStore(store: ObserveResultCacheStore): void {
  instance = store;
}

export function resetObserveCacheStore(): void {
  instance = new FileSystemObserveCacheStore();
}
