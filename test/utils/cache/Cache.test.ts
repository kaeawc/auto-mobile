import { describe, it, expect, beforeEach } from "bun:test";
import { TTLCache } from "../../../src/utils/cache/Cache";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("TTLCache", () => {
  let cache: TTLCache<string, string>;
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    cache = new TTLCache<string, string>(timer, { ttlMs: 1000 });
  });

  describe("basic operations", () => {
    it("sets and gets a value", () => {
      cache.set("key", "value");
      expect(cache.get("key")).toBe("value");
    });

    it("returns undefined for missing keys", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("has() returns true for existing keys", () => {
      cache.set("key", "value");
      expect(cache.has("key")).toBe(true);
    });

    it("has() returns false for missing keys", () => {
      expect(cache.has("nonexistent")).toBe(false);
    });

    it("deletes a key", () => {
      cache.set("key", "value");
      expect(cache.delete("key")).toBe(true);
      expect(cache.get("key")).toBeUndefined();
    });

    it("delete returns false for missing keys", () => {
      expect(cache.delete("nonexistent")).toBe(false);
    });

    it("clears all entries", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("reports correct size", () => {
      expect(cache.size()).toBe(0);
      cache.set("key1", "value1");
      expect(cache.size()).toBe(1);
      cache.set("key2", "value2");
      expect(cache.size()).toBe(2);
    });

    it("overwrites existing keys", () => {
      cache.set("key", "value1");
      cache.set("key", "value2");
      expect(cache.get("key")).toBe("value2");
      expect(cache.size()).toBe(1);
    });
  });

  describe("TTL expiration", () => {
    it("returns value before TTL expires", () => {
      cache.set("key", "value");
      timer.advanceTime(500);
      expect(cache.get("key")).toBe("value");
    });

    it("returns undefined after TTL expires", () => {
      cache.set("key", "value");
      timer.advanceTime(1000);
      expect(cache.get("key")).toBeUndefined();
    });

    it("has() returns false after TTL expires", () => {
      cache.set("key", "value");
      timer.advanceTime(1000);
      expect(cache.has("key")).toBe(false);
    });

    it("cleanup removes expired entries", () => {
      cache.set("key1", "value1");
      timer.advanceTime(500);
      cache.set("key2", "value2");
      timer.advanceTime(600); // key1 is now expired, key2 is not

      const evicted = cache.cleanup();
      expect(evicted).toBe(1);
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBe("value2");
    });

    it("tracks TTL evictions in stats", () => {
      cache.set("key", "value");
      timer.advanceTime(1000);
      cache.get("key"); // Triggers TTL eviction

      const stats = cache.getStats();
      expect(stats.ttlEvictions).toBe(1);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when max entries exceeded", () => {
      const limitedCache = new TTLCache<string, string>(timer, {
        ttlMs: 10000,
        maxEntries: 2,
      });

      limitedCache.set("key1", "value1");
      timer.advanceTime(10);
      limitedCache.set("key2", "value2");
      timer.advanceTime(10);
      limitedCache.set("key3", "value3"); // Should evict key1

      expect(limitedCache.get("key1")).toBeUndefined();
      expect(limitedCache.get("key2")).toBe("value2");
      expect(limitedCache.get("key3")).toBe("value3");
    });

    it("evicts least recently used entry", () => {
      const limitedCache = new TTLCache<string, string>(timer, {
        ttlMs: 10000,
        maxEntries: 2,
      });

      limitedCache.set("key1", "value1");
      timer.advanceTime(10);
      limitedCache.set("key2", "value2");
      timer.advanceTime(10);

      // Access key1 to make it most recently used
      limitedCache.get("key1");
      timer.advanceTime(10);

      // Now add key3 - should evict key2 (least recently used)
      limitedCache.set("key3", "value3");

      expect(limitedCache.get("key1")).toBe("value1");
      expect(limitedCache.get("key2")).toBeUndefined();
      expect(limitedCache.get("key3")).toBe("value3");
    });

    it("tracks size evictions in stats", () => {
      const limitedCache = new TTLCache<string, string>(timer, {
        ttlMs: 10000,
        maxEntries: 1,
      });

      limitedCache.set("key1", "value1");
      limitedCache.set("key2", "value2"); // Should evict key1

      const stats = limitedCache.getStats();
      expect(stats.sizeEvictions).toBe(1);
    });
  });

  describe("size-based eviction", () => {
    it("evicts entries when max size exceeded", () => {
      const sizedCache = new TTLCache<string, Buffer>(timer, {
        ttlMs: 10000,
        maxSizeBytes: 100,
      });

      const buf1 = Buffer.alloc(50);
      const buf2 = Buffer.alloc(50);
      const buf3 = Buffer.alloc(50);

      sizedCache.set("key1", buf1, 50);
      timer.advanceTime(10);
      sizedCache.set("key2", buf2, 50);
      timer.advanceTime(10);
      sizedCache.set("key3", buf3, 50); // Should evict key1

      expect(sizedCache.get("key1")).toBeUndefined();
      expect(sizedCache.getCurrentSizeBytes()).toBeLessThanOrEqual(100);
    });

    it("tracks current size correctly", () => {
      const sizedCache = new TTLCache<string, Buffer>(timer, {
        ttlMs: 10000,
        maxSizeBytes: 1000,
      });

      sizedCache.set("key1", Buffer.alloc(100), 100);
      expect(sizedCache.getCurrentSizeBytes()).toBe(100);

      sizedCache.set("key2", Buffer.alloc(200), 200);
      expect(sizedCache.getCurrentSizeBytes()).toBe(300);

      sizedCache.delete("key1");
      expect(sizedCache.getCurrentSizeBytes()).toBe(200);
    });
  });

  describe("statistics", () => {
    it("tracks hits and misses", () => {
      cache.set("key", "value");
      cache.get("key"); // hit
      cache.get("key"); // hit
      cache.get("missing"); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it("reports correct size in stats", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
    });
  });

  describe("keys()", () => {
    it("returns all keys", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      const keys = cache.keys();
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
      expect(keys.length).toBe(2);
    });
  });

  describe("disabled cache and overwrite size accounting", () => {
    it("stores nothing when maxEntries is 0 (caching disabled)", () => {
      const disabled = new TTLCache<string, string>(timer, { ttlMs: 10000, maxEntries: 0 });
      disabled.set("key", "value");
      expect(disabled.get("key")).toBeUndefined();
      expect(disabled.size()).toBe(0);
    });

    it("stores nothing when maxEntries is negative (caching disabled)", () => {
      const disabled = new TTLCache<string, string>(timer, { ttlMs: 10000, maxEntries: -1 });
      disabled.set("key", "value");
      expect(disabled.get("key")).toBeUndefined();
      expect(disabled.size()).toBe(0);
    });

    it("resets tracked size to the new size when a sized key is overwritten", () => {
      const sizedCache = new TTLCache<string, Buffer>(timer, { ttlMs: 10000, maxSizeBytes: 10000 });
      sizedCache.set("key", Buffer.alloc(100), 100);
      expect(sizedCache.getCurrentSizeBytes()).toBe(100);

      // Overwrite with a larger payload: the old 100 bytes must be subtracted so
      // the total reflects 300, not the double-counted 400.
      sizedCache.set("key", Buffer.alloc(300), 300);
      expect(sizedCache.getCurrentSizeBytes()).toBe(300);
      expect(sizedCache.size()).toBe(1);
    });
  });

  // issue #6653: cleanup() was documented as automatic but nothing in src/
  // ever invoked it, so entries in an unbounded key space (a UUID, a
  // timestamp) accumulated dead weight forever once expired -- only reading
  // the exact same key again after expiry ever reclaimed it.
  describe("automatic cleanup on set() (issue #6653)", () => {
    it("reclaims expired entries via set() alone, even for keys never re-read", () => {
      const unboundedCache = new TTLCache<string, string>(timer, { ttlMs: 1000 });

      for (let i = 0; i < 5; i++) {
        unboundedCache.set(`old-${i}`, `value-${i}`);
      }
      expect(unboundedCache.size()).toBe(5);

      timer.advanceTime(1000); // all 5 entries are now expired

      // Fresh keys, never used before -- nothing ever reads the old keys
      // again, so only the automatic sweep inside set() can reclaim them.
      for (let i = 0; i < 3; i++) {
        unboundedCache.set(`new-${i}`, `value-${i}`);
      }

      // Pre-fix, size() would be 8 (5 stale entries no one ever re-read, plus
      // the 3 fresh ones) because nothing ever called cleanup().
      expect(unboundedCache.size()).toBe(3);
      expect(unboundedCache.get("old-0")).toBeUndefined();
      expect(unboundedCache.get("new-2")).toBe("value-2");
    });

    it("size() does not grow unbounded across many inserts once entries expire", () => {
      const unboundedCache = new TTLCache<string, number>(timer, { ttlMs: 100 });

      for (let batch = 0; batch < 20; batch++) {
        for (let i = 0; i < 10; i++) {
          unboundedCache.set(`batch${batch}-key${i}`, i);
        }
        timer.advanceTime(100); // expire this whole batch before the next one
      }

      // Every batch fully expires before the next batch's first set() call
      // runs its sweep, so at most one batch's worth of entries is ever live.
      expect(unboundedCache.size()).toBeLessThanOrEqual(10);
    });
  });

  describe("bounded size under a maxEntries cap across many inserts", () => {
    it("size() never exceeds maxEntries no matter how many distinct keys are inserted", () => {
      const capped = new TTLCache<string, number>(timer, { ttlMs: 10000, maxEntries: 5 });

      for (let i = 0; i < 500; i++) {
        capped.set(`key-${i}`, i);
        expect(capped.size()).toBeLessThanOrEqual(5);
      }
      expect(capped.size()).toBe(5);
    });
  });

  // issue #6653: evictOldest() used to do a full linear scan of every entry
  // to find the least-recently-used key, so a size- or count-capped cache
  // paid O(n) work per insert once full. evictionScanWorkUnits is a
  // test-only counter (mirrors BufferQueue.compactionWorkUnits) that lets
  // these assertions pin the fix without a flaky wall-clock benchmark.
  describe("bounded eviction/cleanup scan work (issue #6653)", () => {
    it("evictOldest() touches ~O(1) entries per insert under a maxEntries cap, not O(n)", () => {
      const capped = new TTLCache<string, number>(timer, { ttlMs: 10000, maxEntries: 1 });
      const n = 500;

      for (let i = 0; i < n; i++) {
        capped.set(`key-${i}`, i);
      }

      // Each set() after the first evicts exactly one entry via an O(1)
      // peek, plus one O(1) peek from the expiry sweep finding a live front
      // entry: work grows linearly with n. A per-insert O(n) scan (the
      // pre-fix evictOldest()) would touch roughly n*(n-1)/2 entries across
      // this loop -- 124,750 for n=500 -- which the bound below rules out.
      expect(capped.evictionScanWorkUnits).toBeLessThanOrEqual(3 * n);
    });

    it("cleanup() stops at the first non-expired entry instead of scanning the whole cache", () => {
      const mixedCache = new TTLCache<string, number>(timer, { ttlMs: 1000 });

      // 3 entries created at t=0; will be expired once time reaches t=1000.
      for (let i = 0; i < 3; i++) {
        mixedCache.set(`old-${i}`, i);
      }

      timer.advanceTime(500);
      // 200 entries created at t=500; still live at t=1000 (ttl elapses 1500).
      for (let i = 0; i < 200; i++) {
        mixedCache.set(`live-${i}`, i);
      }

      timer.advanceTime(500); // t=1000: old-* (age 1000) expired, live-* (age 500) not.

      const before = mixedCache.evictionScanWorkUnits;
      const evicted = mixedCache.cleanup();
      const workDuringCleanup = mixedCache.evictionScanWorkUnits - before;

      expect(evicted).toBe(3);
      // cleanup() must stop as soon as it reaches the first live entry
      // instead of continuing past it to scan the other 199 -- proportional
      // to the 3 expired entries (plus the one live entry it checks and
      // stops at), not the 203-entry cache.
      expect(workDuringCleanup).toBeLessThanOrEqual(4);
      expect(mixedCache.size()).toBe(200);
    });
  });

  // issue #6653: the maxSizeBytes eviction loop stopped once entries.size
  // reached 0 even if the single incoming value alone exceeded the budget,
  // so an oversized value was inserted unconditionally and permanently
  // pinned currentSizeBytes above maxSizeBytes.
  describe("oversized single values (issue #6653)", () => {
    it("rejects a value whose size alone exceeds maxSizeBytes, without touching other entries", () => {
      const sizedCache = new TTLCache<string, Buffer>(timer, { ttlMs: 10000, maxSizeBytes: 100 });
      const small = Buffer.alloc(50);
      sizedCache.set("small", small, 50);

      sizedCache.set("huge", Buffer.alloc(500), 500);

      expect(sizedCache.get("huge")).toBeUndefined();
      expect(sizedCache.get("small")).toBe(small);
      expect(sizedCache.getCurrentSizeBytes()).toBe(50);
      expect(sizedCache.size()).toBe(1);
    });

    it("leaves an existing entry untouched when overwriting it with an oversized value", () => {
      const sizedCache = new TTLCache<string, Buffer>(timer, { ttlMs: 10000, maxSizeBytes: 100 });
      const original = Buffer.alloc(50);
      sizedCache.set("key", original, 50);

      sizedCache.set("key", Buffer.alloc(500), 500);

      expect(sizedCache.get("key")).toBe(original);
      expect(sizedCache.getCurrentSizeBytes()).toBe(50);
    });
  });
});
