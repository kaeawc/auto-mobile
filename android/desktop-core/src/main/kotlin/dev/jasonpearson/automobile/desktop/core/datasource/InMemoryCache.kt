package dev.jasonpearson.automobile.desktop.core.datasource

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Generic TTL-based in-memory cache.
 *
 * Uses a ConcurrentHashMap for lock-free reads and a per-key Mutex so that concurrent fetches for
 * *different* keys proceed in parallel while duplicate fetches for the *same* key are coalesced.
 *
 * @param ttlMs Time-to-live in milliseconds. Entries older than this are considered stale.
 * @param clock Injectable clock for deterministic testing.
 */
class InMemoryCache<K, V>(
    private val ttlMs: Long = 30_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
  private data class Entry<V>(val value: V, val timestamp: Long)

  private val cache = ConcurrentHashMap<K, Entry<V>>()
  private val keyMutexes = ConcurrentHashMap<K, Mutex>()

  /**
   * Returns a cached value if fresh, otherwise calls [fetch] and caches the result. Concurrent
   * calls for the same key will coalesce — only one fetch runs at a time per key.
   */
  suspend fun get(key: K, fetch: suspend () -> V): V {
    // Fast path: check cache without locking
    val existing = cache[key]
    if (existing != null && clock() - existing.timestamp < ttlMs) {
      return existing.value
    }

    // Slow path: acquire per-key mutex, double-check, then fetch
    val mutex = keyMutexes.getOrPut(key) { Mutex() }
    return mutex.withLock {
      val entry = cache[key]
      val now = clock()
      if (entry != null && now - entry.timestamp < ttlMs) {
        return@withLock entry.value
      }
      val result = fetch()
      cache[key] = Entry(result, clock())
      result
    }
  }

  /** Remove a single key from the cache. */
  fun invalidate(key: K) {
    cache.remove(key)
  }

  /** Remove all entries from the cache. */
  fun invalidateAll() {
    cache.clear()
  }

  /** Non-blocking peek at the cached value (may be stale). Returns null if absent. */
  fun peek(key: K): V? = cache[key]?.value
}
