package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InMemoryCacheTest {

  @Test
  fun `get returns fetched value on cache miss`() = runBlocking {
    val cache = InMemoryCache<String, Int>(ttlMs = 1000L)

    val result = cache.get("a") { 42 }

    assertEquals(42, result)
  }

  @Test
  fun `get returns cached value within TTL`() = runBlocking {
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 1000L)

    cache.get("a") {
      fetchCount++
      1
    }
    val second =
        cache.get("a") {
          fetchCount++
          2
        }

    assertEquals(1, fetchCount)
    assertEquals(1, second)
  }

  @Test
  fun `get re-fetches after TTL expires`() = runBlocking {
    var now = 0L
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 100L, clock = { now })

    cache.get("a") {
      fetchCount++
      1
    }
    now = 101L
    val second =
        cache.get("a") {
          fetchCount++
          2
        }

    assertEquals(2, fetchCount)
    assertEquals(2, second)
  }

  @Test
  fun `get does not re-fetch before TTL expires`() = runBlocking {
    var now = 0L
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 100L, clock = { now })

    cache.get("a") {
      fetchCount++
      1
    }
    now = 99L
    val second =
        cache.get("a") {
          fetchCount++
          2
        }

    assertEquals(1, fetchCount)
    assertEquals(1, second)
  }

  @Test
  fun `invalidate removes entry and forces re-fetch`() = runBlocking {
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 10_000L)

    cache.get("a") {
      fetchCount++
      1
    }
    cache.invalidate("a")
    val second =
        cache.get("a") {
          fetchCount++
          2
        }

    assertEquals(2, fetchCount)
    assertEquals(2, second)
  }

  @Test
  fun `invalidateAll clears all entries`() = runBlocking {
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 10_000L)

    cache.get("a") {
      fetchCount++
      10
    }
    cache.get("b") {
      fetchCount++
      20
    }
    cache.invalidateAll()

    val a =
        cache.get("a") {
          fetchCount++
          11
        }
    val b =
        cache.get("b") {
          fetchCount++
          21
        }

    assertEquals(4, fetchCount)
    assertEquals(11, a)
    assertEquals(21, b)
  }

  @Test
  fun `peek returns value without fetching`() = runBlocking {
    val cache = InMemoryCache<String, Int>(ttlMs = 1000L)

    assertNull(cache.peek("a"))

    cache.get("a") { 42 }
    assertEquals(42, cache.peek("a"))
  }

  @Test
  fun `different keys are independent`() = runBlocking {
    val cache = InMemoryCache<String, Int>(ttlMs = 1000L)

    cache.get("a") { 1 }
    cache.get("b") { 2 }

    assertEquals(1, cache.peek("a"))
    assertEquals(2, cache.peek("b"))
  }

  @Test
  fun `concurrent access for same key only fetches once`() = runBlocking {
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 10_000L)

    // Launch multiple concurrent gets for the same key
    val results =
        (1..10)
            .map {
              async {
                cache.get("a") {
                  fetchCount++
                  42
                }
              }
            }
            .awaitAll()

    // All should get the same value; fetch count should be 1
    results.forEach { assertEquals(42, it) }
    assertEquals(1, fetchCount)
  }

  @Test
  fun `timestamp is recorded after fetch completes`() = runBlocking {
    var now = 0L
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 100L, clock = { now })

    // First fetch: clock is at 0, but fetch advances clock to 200 (simulating slow fetch)
    cache.get("a") {
      fetchCount++
      now = 200L // simulate slow fetch
      1
    }

    // Advance clock to 250 — only 50ms after the fetch completed at 200
    now = 250L
    val second =
        cache.get("a") {
          fetchCount++
          2
        }

    // Entry should still be fresh (250 - 200 = 50ms < 100ms TTL)
    assertEquals(1, fetchCount)
    assertEquals(1, second)
  }

  @Test
  fun `concurrent access for different keys fetches independently`() = runBlocking {
    var fetchCount = 0
    val cache = InMemoryCache<String, Int>(ttlMs = 10_000L)

    val results =
        (1..5)
            .map { i ->
              async {
                cache.get("key-$i") {
                  fetchCount++
                  i * 10
                }
              }
            }
            .awaitAll()

    assertEquals(listOf(10, 20, 30, 40, 50), results)
    assertEquals(5, fetchCount)
  }
}
