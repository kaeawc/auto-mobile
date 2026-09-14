import type { ObserveResult } from "../../../models";

/** The most recent cached observation together with the device it came from. */
export interface RecentObserveCacheEntry {
  deviceId: string;
  result: ObserveResult;
}

/**
 * Storage abstraction for cached observe results.
 *
 * Implementations are responsible for both an in-memory cache and any
 * durable backing store (e.g. disk). Read methods are exposed in both
 * synchronous (memory-only) and asynchronous (memory + durable) variants
 * so callers can pick the right tradeoff for their hot path.
 */
export interface ObserveResultCacheStore {
  /**
   * Persist (memory + disk). Returns when both writes complete.
   *
   * `generation` is the device's cache generation captured at the *start* of the
   * observation that produced `result` (see {@link currentGeneration}). When
   * supplied and the device's generation has since advanced — i.e. the cache was
   * invalidated for the device while this observation was in flight — the write
   * is rejected so an in-flight observation cannot repopulate a just-cleared
   * cache with a now-stale hierarchy (issue #5884). Omit it for unconditional
   * writes (back-compat). `cachedAt`, when supplied, is used for in-memory
   * recency ordering; omit it to retain wall-clock write-time ordering.
   */
  put(
    deviceId: string,
    result: ObserveResult,
    generation?: number,
    cachedAt?: number,
  ): Promise<void>;

  /**
   * The device's current cache generation. Bumped by {@link clear} (per-device
   * on a scoped clear; every device on a clear-all). Capture it at the start of
   * an observation and pass it back to {@link put} to fence stale writes.
   */
  currentGeneration(deviceId: string): number;

  /** Async lookup: checks memory first, then disk; loads disk hits into memory. */
  getMostRecent(deviceId: string): Promise<ObserveResult | undefined>;

  /**
   * Sync in-memory lookup across all devices (for resource handlers).
   *
   * Returns the owning device id alongside the result so a caller that needs a
   * matching artifact (e.g. the screenshot for the same observation) can scope
   * its follow-up lookup to that device instead of running a second, independent
   * "most recent across all devices" resolution that may land on another device
   * (issue #6600).
   */
  getRecentInMemoryEntry(): RecentObserveCacheEntry | undefined;

  /** Sync in-memory lookup for a specific device. */
  getRecentInMemoryForDevice(deviceId: string): ObserveResult | undefined;

  /** Clear memory + disk cache. If deviceId provided, only that device. */
  clear(deviceId?: string): void;
}
