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
// App-changing dispatches can cache a transition frame afterwards. Keep a
// generation-scoped obligation for the next element resolution, independent of
// response-only settle metadata and of subsequent post-action cache writes.
const pendingWindowResolution = new WeakMap<ObserveResultCacheStore, Map<string, number>>();

export function markWindowResolutionRequired(deviceId: string): void {
  const pending = pendingWindowResolution.get(instance) ?? new Map<string, number>();
  pending.set(deviceId, instance.currentGeneration(deviceId));
  pendingWindowResolution.set(instance, pending);
}

export function pendingWindowResolutionGeneration(deviceId: string): number | undefined {
  return pendingWindowResolution.get(instance)?.get(deviceId);
}

export function completeWindowResolutionRead(deviceId: string, generation: number): void {
  if (pendingWindowResolution.get(instance)?.get(deviceId) === generation) {
    pendingWindowResolution.get(instance)?.delete(deviceId);
  }
}

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
