import { Timer, defaultTimer } from "../SystemTimer";
import { logger } from "../logger";

/**
 * Configuration for cache behavior.
 */
interface CacheOptions {
  /**
   * Time-to-live in milliseconds.
   * Entries older than this will be considered expired.
   * Default: 60000 (1 minute)
   */
  ttlMs?: number;

  /**
   * Maximum number of entries in the cache.
   * When exceeded, oldest entries are evicted (LRU).
   * Default: unlimited
   */
  maxEntries?: number;

  /**
   * Maximum total size in bytes (for size-aware caches).
   * Default: unlimited
   *
   * A single value whose `sizeBytes` alone exceeds this budget is rejected
   * outright by `set()` (logged, not cached) rather than admitted and left
   * permanently pinning `currentSizeBytes` above the budget -- no amount of
   * evicting other entries can make room for it (issue #6653).
   */
  maxSizeBytes?: number;
}

/**
 * Entry stored in the cache with metadata.
 */
interface CacheEntry<T> {
  /** The cached value */
  value: T;
  /** Timestamp when the entry was created */
  createdAt: number;
  /** Size in bytes (if tracked) */
  sizeBytes?: number;
}

/**
 * Statistics about cache performance.
 */
interface CacheStats {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Number of entries currently in cache */
  size: number;
  /** Number of entries evicted due to TTL */
  ttlEvictions: number;
  /** Number of entries evicted due to size limits */
  sizeEvictions: number;
}

/**
 * Generic cache interface.
 */
interface Cache<K, V> {
  /**
   * Get a value from the cache.
   * Returns undefined if not found or expired.
   */
  get(key: K): V | undefined;

  /**
   * Set a value in the cache.
   * @param key - Cache key
   * @param value - Value to cache
   * @param sizeBytes - Optional size hint for size-aware caches
   */
  set(key: K, value: V, sizeBytes?: number): void;

  /**
   * Check if a key exists and is not expired.
   */
  has(key: K): boolean;

  /**
   * Delete a specific entry.
   */
  delete(key: K): boolean;

  /**
   * Clear all entries.
   */
  clear(): void;

  /**
   * Get the number of entries in the cache.
   */
  size(): number;

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats;

  /**
   * Remove all currently-expired entries, in ascending creation-time order,
   * stopping at the first entry that has not expired yet (everything created
   * after it is at least as fresh, so it cannot be expired either). Cost is
   * proportional to the number of expired entries removed, not the total
   * cache size.
   *
   * `set()` runs this same bounded sweep automatically before every insert,
   * and `get()`/`has()` opportunistically evict the single key they touch
   * when it has expired -- so an unbounded key space does not accumulate
   * expired dead weight indefinitely even if a caller never invokes
   * `cleanup()` manually (issue #6653). Call it directly only to force an
   * immediate full pass, e.g. before reporting memory stats.
   */
  cleanup(): number;
}

/**
 * Default cache options.
 */
export const DEFAULT_CACHE_OPTIONS: Required<Omit<CacheOptions, "maxSizeBytes">> = {
  ttlMs: 60000, // 1 minute
  maxEntries: Infinity,
};

/**
 * TTL-based cache implementation with LRU eviction.
 *
 * Two Maps track different orderings of the same key set so both eviction
 * paths stay O(1)/bounded instead of scanning every entry (issue #6653):
 *  - `entries` iteration order tracks access recency: a hit in `get()` moves
 *    its key to the tail, so the front is always the least-recently-used
 *    entry and `evictOldest()` just peeks it.
 *  - `expiryOrder` iteration order tracks creation time ascending (a fresh
 *    `set()` always appends, including on overwrite): the front is always
 *    the oldest-created entry, so a TTL sweep can stop as soon as it hits a
 *    non-expired one instead of walking the whole cache.
 */
export class TTLCache<K, V> implements Cache<K, V> {
  private readonly entries: Map<K, CacheEntry<V>> = new Map();
  private readonly expiryOrder: Set<K> = new Set();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxSizeBytes: number;
  private currentSizeBytes: number = 0;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    ttlEvictions: 0,
    sizeEvictions: 0,
  };
  // Cumulative entries touched by evictOldest()'s O(1) peek and the
  // expiry sweep's bounded prefix walk. A test-only seam (mirrors
  // BufferQueue.compactionWorkUnits) proving eviction/cleanup cost stays
  // linear in entries actually evicted, never quadratic in cache size.
  private evictionScanWork: number = 0;

  constructor(
    private readonly timer: Timer = defaultTimer,
    options?: CacheOptions,
  ) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_CACHE_OPTIONS.ttlMs;
    this.maxEntries = options?.maxEntries ?? DEFAULT_CACHE_OPTIONS.maxEntries;
    this.maxSizeBytes = options?.maxSizeBytes ?? Infinity;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    const now = this.timer.now();
    if (now - entry.createdAt >= this.ttlMs) {
      // Entry has expired
      this.removeEntry(key);
      this.stats.ttlEvictions++;
      this.stats.misses++;
      this.updateSizeStats();
      return undefined;
    }

    // Move this key to the tail of `entries` so its iteration order tracks
    // access recency -- see the class doc and evictOldest().
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  set(key: K, value: V, sizeBytes?: number): void {
    // Reject a value that alone exceeds the byte budget outright: no amount
    // of evicting OTHER entries can bring currentSizeBytes back under
    // maxSizeBytes once even one oversized value is admitted (issue #6653).
    // Checked before any mutation so a rejected call is a complete no-op,
    // including leaving any existing entry for this key untouched.
    if (this.isOversizedValue(sizeBytes)) {
      logger.warn(
        `[TTLCache] rejecting value for key that alone exceeds maxSizeBytes ` +
          `(${sizeBytes} > ${this.maxSizeBytes} bytes); value not cached`,
      );
      return;
    }

    const now = this.timer.now();

    // Remove existing entry if present
    if (this.entries.has(key)) {
      this.removeEntry(key);
    }

    // Opportunistic amortized cleanup: every set() clears any already-expired
    // prefix before considering size/count eviction, so an unbounded key
    // space does not accumulate dead entries indefinitely even if callers
    // never call cleanup() themselves (issue #6653). Cost is proportional to
    // entries actually expired, not cache size -- see sweepExpiredPrefix.
    this.sweepExpiredPrefix(now);

    this.evictForCapacity(sizeBytes);

    // Skip caching if maxEntries is 0 or negative (caching disabled)
    if (this.maxEntries <= 0) {
      return;
    }

    // Add new entry
    const entry: CacheEntry<V> = {
      value,
      createdAt: now,
      sizeBytes,
    };

    this.entries.set(key, entry);
    this.expiryOrder.add(key);
    this.currentSizeBytes += sizeBytes ?? 0;
    this.updateSizeStats();
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    const now = this.timer.now();
    if (now - entry.createdAt >= this.ttlMs) {
      this.removeEntry(key);
      this.stats.ttlEvictions++;
      this.updateSizeStats();
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    if (this.entries.has(key)) {
      this.removeEntry(key);
      this.updateSizeStats();
      return true;
    }
    return false;
  }

  clear(): void {
    this.entries.clear();
    this.expiryOrder.clear();
    this.currentSizeBytes = 0;
    this.updateSizeStats();
  }

  size(): number {
    return this.entries.size;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  cleanup(): number {
    return this.sweepExpiredPrefix(this.timer.now());
  }

  /**
   * Get the current total size in bytes.
   */
  getCurrentSizeBytes(): number {
    return this.currentSizeBytes;
  }

  /**
   * Get all keys currently in the cache.
   */
  keys(): K[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Test seam: cumulative entries touched by evictOldest()'s O(1) peek and
   * the expiry sweep's bounded prefix walk (see the class doc and
   * evictionScanWork). Lets tests pin eviction/cleanup cost as linear in
   * entries actually evicted rather than quadratic in cache size, without a
   * flaky wall-clock benchmark.
   */
  get evictionScanWorkUnits(): number {
    return this.evictionScanWork;
  }

  /**
   * Remove entries from the front of `expiryOrder` (ascending creation time)
   * while they are expired, stopping at the first one that is not -- every
   * entry after it was created no earlier, so it cannot be expired yet
   * either. Cost is proportional to entries actually removed, not the total
   * cache size (issue #6653).
   */
  private sweepExpiredPrefix(now: number): number {
    let evicted = 0;

    for (const key of this.expiryOrder) {
      this.evictionScanWork++;
      const entry = this.entries.get(key);
      // expiryOrder and entries are kept in lockstep by every mutator below,
      // so a missing entry here would indicate a bug rather than legitimate
      // state -- treat it the same as "not expired" and stop.
      if (!entry || now - entry.createdAt < this.ttlMs) {
        break;
      }
      this.removeEntry(key);
      this.stats.ttlEvictions++;
      evicted++;
    }

    if (evicted > 0) {
      this.updateSizeStats();
    }
    return evicted;
  }

  /**
   * True when `sizeBytes` alone would exceed a finite `maxSizeBytes` budget
   * -- no eviction of other entries could ever make room for it (issue
   * #6653).
   */
  private isOversizedValue(sizeBytes: number | undefined): boolean {
    return (
      sizeBytes !== undefined && this.maxSizeBytes !== Infinity && sizeBytes > this.maxSizeBytes
    );
  }

  /**
   * Evict entries (oldest-first, O(1) each via evictOldest()) until the
   * incoming value fits within maxSizeBytes and the entry count is under
   * maxEntries.
   */
  private evictForCapacity(sizeBytes: number | undefined): void {
    if (sizeBytes !== undefined && this.maxSizeBytes !== Infinity) {
      while (this.currentSizeBytes + sizeBytes > this.maxSizeBytes && this.entries.size > 0) {
        this.evictOldest();
        this.stats.sizeEvictions++;
      }
    }

    // Guard against maxEntries <= 0 (caching disabled; set() returns early).
    while (this.maxEntries > 0 && this.entries.size >= this.maxEntries && this.entries.size > 0) {
      this.evictOldest();
      this.stats.sizeEvictions++;
    }
  }

  /**
   * Evict the least-recently-used entry in O(1): `entries` iteration order
   * tracks access recency (see the class doc and get()), so the front is
   * always the LRU key -- no scan needed to find it.
   */
  private evictOldest(): void {
    const oldestKey: K | undefined = this.entries.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    this.evictionScanWork++;
    this.removeEntry(oldestKey);
  }

  /**
   * Remove a key from both orderings and the value store, adjusting the
   * tracked byte total. Centralizes the bookkeeping every removal path
   * (expiry, explicit delete, LRU eviction) must keep in sync; callers are
   * responsible for any stats increment and updateSizeStats() call.
   */
  private removeEntry(key: K): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.currentSizeBytes -= entry.sizeBytes ?? 0;
      this.entries.delete(key);
    }
    this.expiryOrder.delete(key);
  }

  private updateSizeStats(): void {
    this.stats.size = this.entries.size;
  }
}

/**
 * Create a TTL cache with the default timer.
 */
