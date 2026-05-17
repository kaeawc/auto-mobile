import type { ObserveResult } from "../../../models";

/**
 * Storage abstraction for cached observe results.
 *
 * Implementations are responsible for both an in-memory cache and any
 * durable backing store (e.g. disk). Read methods are exposed in both
 * synchronous (memory-only) and asynchronous (memory + durable) variants
 * so callers can pick the right tradeoff for their hot path.
 */
export interface ObserveResultCacheStore {
  /** Persist (memory + disk). Returns when both writes complete. */
  put(deviceId: string, result: ObserveResult): Promise<void>;

  /** Async lookup: checks memory first, then disk; loads disk hits into memory. */
  getMostRecent(deviceId: string): Promise<ObserveResult | undefined>;

  /** Sync in-memory lookup across all devices (for resource handlers). */
  getRecentInMemory(): ObserveResult | undefined;

  /** Sync in-memory lookup for a specific device. */
  getRecentInMemoryForDevice(deviceId: string): ObserveResult | undefined;

  /** Clear memory + disk cache. If deviceId provided, only that device. */
  clear(deviceId?: string): void;
}
