package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

class NetworkMockRuleStoreTest {

  private fun createStore(clock: () -> Long = { 1000L }): NetworkMockRuleStore {
    return NetworkMockRuleStore(clock)
  }

  private fun rule(
    mockId: String = "mock-1",
    host: String = "api\\.example\\.com",
    path: String = "/users",
    method: String = "*",
    limit: Int? = null,
    remaining: Int? = null,
    statusCode: Int = 500,
  ) =
    NetworkMockRuleDto(
      mockId = mockId,
      host = host,
      path = path,
      method = method,
      limit = limit,
      remaining = remaining,
      statusCode = statusCode,
      responseHeaders = mapOf("X-Mock" to "true"),
      responseBody = """{"error":"mocked"}""",
      contentType = "application/json",
    )

  @Test
  fun `matches rule by host and path`() {
    val store = createStore()
    store.setRules(listOf(rule()))

    val match = store.findMatchingRule("api.example.com", "/users", "GET")
    assertNotNull(match)
    assertEquals("mock-1", match.mockId)
    assertEquals(500, match.statusCode)
  }

  @Test
  fun `returns null when no rules match`() {
    val store = createStore()
    store.setRules(listOf(rule()))

    assertNull(store.findMatchingRule("other.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/posts", "GET"))
  }

  @Test
  fun `matches regex host pattern`() {
    val store = createStore()
    store.setRules(listOf(rule(host = ".*\\.example\\.com")))

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNotNull(store.findMatchingRule("cdn.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("other.io", "/users", "GET"))
  }

  @Test
  fun `matches regex path pattern`() {
    val store = createStore()
    store.setRules(listOf(rule(path = "/users/\\d+")))

    assertNotNull(store.findMatchingRule("api.example.com", "/users/123", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/users/abc", "GET"))
  }

  @Test
  fun `wildcard method matches any method`() {
    val store = createStore()
    store.setRules(listOf(rule(method = "*")))

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "POST"))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "DELETE"))
  }

  @Test
  fun `specific method only matches that method`() {
    val store = createStore()
    store.setRules(listOf(rule(method = "POST")))

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "POST"))
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  @Test
  fun `method matching is case insensitive`() {
    val store = createStore()
    store.setRules(listOf(rule(method = "post")))

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "POST"))
  }

  @Test
  fun `limit decrements remaining and stops matching when exhausted`() {
    val store = createStore()
    store.setRules(listOf(rule(limit = 2, remaining = 2)))

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  @Test
  fun `unlimited rule matches indefinitely`() {
    val store = createStore()
    store.setRules(listOf(rule(limit = null, remaining = null)))

    repeat(100) {
      assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    }
  }

  @Test
  fun `setRules replaces all rules`() {
    val store = createStore()
    store.setRules(listOf(rule(mockId = "first")))
    assertEquals(1, store.getRuleCount())

    store.setRules(listOf(rule(mockId = "second"), rule(mockId = "third", path = "/posts")))
    assertEquals(2, store.getRuleCount())

    val match = store.findMatchingRule("api.example.com", "/users", "GET")
    assertNotNull(match)
    assertEquals("second", match.mockId)
  }

  @Test
  fun `clear removes all rules`() {
    val store = createStore()
    store.setRules(listOf(rule()))
    store.clear()

    assertEquals(0, store.getRuleCount())
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  @Test
  fun `skips rules with invalid regex`() {
    val store = createStore()
    store.setRules(
      listOf(
        rule(mockId = "bad", host = "[invalid"),
        rule(mockId = "good"),
      ),
    )

    assertEquals(1, store.getRuleCount())
    val match = store.findMatchingRule("api.example.com", "/users", "GET")
    assertNotNull(match)
    assertEquals("good", match.mockId)
  }

  @Test
  fun `skips a rule whose path has an unescaped brace that JavaScript accepts`() {
    // `/users/{id}` is a valid JavaScript RegExp (the brace is a literal) but the JVM/ICU engine
    // throws "Illegal repetition"; the host rejects it up front (#10059).
    val store = createStore()
    store.setRules(listOf(rule(mockId = "braced", path = "/users/{id}/profile")))

    assertEquals(0, store.getRuleCount())
    assertNull(store.findMatchingRule("api.example.com", "/users/{id}/profile", "GET"))
  }

  @Test
  fun `accepts a leading inline flag that JavaScript rejects`() {
    val store = createStore()
    store.setRules(listOf(rule(mockId = "flagged", host = "(?i)API\\.example\\.com")))

    assertEquals(1, store.getRuleCount())
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  @Test
  fun `matched rule includes response data`() {
    val store = createStore()
    store.setRules(listOf(rule()))

    val match = store.findMatchingRule("api.example.com", "/users", "GET")!!
    assertEquals("""{"error":"mocked"}""", match.responseBody)
    assertEquals("application/json", match.contentType)
    assertEquals(mapOf("X-Mock" to "true"), match.responseHeaders)
  }

  // Probabilistic regression before atomic publication; deterministic no-null invariant after it.
  @Test
  fun `replacing rules never exposes an empty set to concurrent readers`() {
    val store = createStore()
    val dtos = listOf(rule(host = "api.example.com"))
    store.setRules(dtos)
    val started = CountDownLatch(1)
    val stop = AtomicBoolean(false)
    val sawNull = AtomicBoolean(false)
    val iterations = AtomicInteger()
    val readerFailure = AtomicReference<Throwable?>()
    val reader = Thread {
      do {
        if (store.findMatchingRule("api.example.com", "/users", "GET") == null) {
          sawNull.set(true)
        }
        iterations.incrementAndGet()
        started.countDown()
      } while (!stop.get())
    }
      .apply {
        isDaemon = true
        uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, error ->
          readerFailure.set(error)
        }
      }

    reader.start()
    try {
      assertTrue(started.await(1, TimeUnit.SECONDS), "Reader did not start")
      repeat(2000) { store.setRules(dtos) }
    } finally {
      stop.set(true)
      reader.join(1000)
    }

    assertFalse(reader.isAlive, "Reader did not finish within the bounded join")
    assertNull(readerFailure.get(), "Reader failed unexpectedly")
    assertTrue(iterations.get() > 0, "Reader must exercise the published rules")
    assertFalse(sawNull.get(), "Matching rule disappeared during replacement")
  }

  // Deterministic publication behavior: invalid rules are skipped and first match still wins.
  @Test
  fun `mixed valid and invalid rules preserve order and replace the previous set`() {
    val store = createStore()
    store.setRules(
      listOf(
        rule(mockId = "first"),
        rule(mockId = "bad", path = "[invalid"),
        rule(mockId = "second"),
        rule(mockId = "posts", path = "/posts"),
      ),
    )

    assertEquals(3, store.getRuleCount())
    assertEquals("first", store.findMatchingRule("api.example.com", "/users", "GET")?.mockId)
    assertEquals("posts", store.findMatchingRule("api.example.com", "/posts", "GET")?.mockId)

    store.setRules(listOf(rule(mockId = "replacement", path = "/replacement")))

    assertEquals(1, store.getRuleCount())
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/posts", "GET"))
    assertEquals(
      "replacement",
      store.findMatchingRule("api.example.com", "/replacement", "GET")?.mockId,
    )
  }

  // Issue #10101: the device compiles with its own regex engine, so the host cannot know what it
  // will refuse. applyRules reports exactly the rules it skipped, with the compiler's reason.
  @Test
  fun `applyRules returns the ids and reasons of the rules the device engine rejected`() {
    val store = createStore()

    val rejected =
      store.applyRules(
        listOf(
          rule(mockId = "ok"),
          rule(mockId = "brace", path = "/items/{id}"),
          rule(mockId = "bracket", host = "[invalid"),
        ),
      )

    assertEquals(listOf("brace", "bracket"), rejected.map { it.mockId })
    assertTrue(rejected.all { it.reason.startsWith("invalid regex: ") })
    assertEquals(1, store.getRuleCount())
    assertEquals("ok", store.findMatchingRule("api.example.com", "/users", "GET")?.mockId)
    assertNull(store.findMatchingRule("api.example.com", "/items/{id}", "GET"))
  }

  @Test
  fun `applyRules reports nothing when every rule compiles`() {
    val store = createStore()

    assertTrue(store.applyRules(listOf(rule(mockId = "a"), rule(mockId = "b"))).isEmpty())
    assertTrue(store.applyRules(emptyList()).isEmpty())
  }

  // Issue #10060: the host re-sends its whole list on every change and reconnect; an exhausted
  // rule must stay exhausted when the same rule (same mockId and definition) is re-sent.
  @Test
  fun `setRules keeps the consumed counter for an unchanged rule when another rule is added`() {
    val store = createStore()
    val first = rule(mockId = "mock-1", path = "/login", limit = 1, remaining = 1)
    store.setRules(listOf(first))
    assertNotNull(store.findMatchingRule("api.example.com", "/login", "POST"))
    assertNull(store.findMatchingRule("api.example.com", "/login", "POST"))

    store.setRules(listOf(first, rule(mockId = "mock-2", path = "/profile")))

    assertNull(store.findMatchingRule("api.example.com", "/login", "POST"))
    assertNotNull(store.findMatchingRule("api.example.com", "/profile", "GET"))
  }

  @Test
  fun `setRules keeps a partially consumed counter across an identical re-push`() {
    val store = createStore()
    val dtos = listOf(rule(limit = 3, remaining = 3))
    store.setRules(dtos)
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))

    store.setRules(dtos)

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  @Test
  fun `setRules gives a fresh counter to a new mockId or a changed definition`() {
    val store = createStore()
    store.setRules(listOf(rule(mockId = "mock-1", limit = 1, remaining = 1)))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))

    // Same id, different limit: a different rule, so it starts fresh.
    store.setRules(listOf(rule(mockId = "mock-1", limit = 2, remaining = 2)))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))

    // New id, same definition: also fresh.
    store.setRules(listOf(rule(mockId = "mock-9", limit = 2, remaining = 2)))
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  @Test
  fun `setRules with an empty list drops counters so a later push starts fresh`() {
    val store = createStore()
    val dtos = listOf(rule(limit = 1, remaining = 1))
    store.setRules(dtos)
    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))

    store.setRules(emptyList())
    store.setRules(dtos)

    assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET"))
  }

  // --- Error simulation tests ---

  @Test
  fun `getActiveErrorSimulation returns config when not expired`() {
    val store = createStore(clock = { 1000L })
    store.setErrorSimulation(true, "http500", null, 5000L)

    val sim = store.getActiveErrorSimulation()
    assertNotNull(sim)
    assertEquals("http500", sim.errorType)
  }

  @Test
  fun `getActiveErrorSimulation returns null when expired`() {
    val store = createStore(clock = { 6000L })
    store.setErrorSimulation(true, "http500", null, 5000L)

    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `getActiveErrorSimulation returns null when disabled`() {
    val store = createStore()
    store.setErrorSimulation(false, null, null, null)

    assertNull(store.getActiveErrorSimulation())
  }

  // --- Skew-immune expiry (issue #10062) ---

  @Test
  fun `remainingMs simulation runs its duration on a device clock far ahead of the host`() {
    // Device wall clock is two minutes ahead of the host epoch the old code compared against.
    val wall = AtomicLong(1_000_000L + 120_000L)
    val mono = AtomicLong(5_000L)
    val store = NetworkMockRuleStore(clock = { wall.get() }, monotonicClock = { mono.get() })
    store.setErrorSimulation(true, "http500", null, 1_030_000L, remainingMs = 30_000L)

    assertNotNull(store.getActiveErrorSimulation())
    mono.addAndGet(29_999L)
    assertNotNull(store.getActiveErrorSimulation())
    mono.addAndGet(1L)
    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `remainingMs simulation still expires on a device clock far behind the host`() {
    val wall = AtomicLong(1_000_000L - 120_000L)
    val mono = AtomicLong(5_000L)
    val store = NetworkMockRuleStore(clock = { wall.get() }, monotonicClock = { mono.get() })
    store.setErrorSimulation(true, "http500", null, 1_030_000L, remainingMs = 30_000L)

    mono.addAndGet(30_000L)

    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `wall clock steps do not change a remainingMs simulation`() {
    val wall = AtomicLong(1_000L)
    val mono = AtomicLong(0L)
    val store = NetworkMockRuleStore(clock = { wall.get() }, monotonicClock = { mono.get() })
    store.setErrorSimulation(true, "timeout", null, null, remainingMs = 10_000L)

    wall.set(Long.MAX_VALUE / 2)

    assertNotNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `remainingMs of zero is already expired`() {
    val store = NetworkMockRuleStore(clock = { 1_000L }, monotonicClock = { 0L })
    store.setErrorSimulation(true, "timeout", null, null, remainingMs = 0L)

    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `remainingMs wins over a conflicting absolute expiry`() {
    val mono = AtomicLong(0L)
    val store = NetworkMockRuleStore(clock = { 1_000L }, monotonicClock = { mono.get() })
    // The absolute value is already in the past on the device clock; the duration governs.
    store.setErrorSimulation(true, "timeout", null, 500L, remainingMs = 10_000L)

    assertNotNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `a re-pushed remainingMs replaces the deadline rather than extending the original`() {
    val mono = AtomicLong(0L)
    val store = NetworkMockRuleStore(clock = { 1_000L }, monotonicClock = { mono.get() })
    store.setErrorSimulation(true, "timeout", null, null, remainingMs = 30_000L)
    mono.addAndGet(10_000L)
    store.setErrorSimulation(true, "timeout", null, null, remainingMs = 20_000L)

    mono.addAndGet(19_999L)
    assertNotNull(store.getActiveErrorSimulation())
    mono.addAndGet(1L)
    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `error simulation respects limit`() {
    val store = createStore(clock = { 1000L })
    store.setErrorSimulation(true, "timeout", 2, 99999L)

    assertNotNull(store.getActiveErrorSimulation())
    assertNotNull(store.getActiveErrorSimulation())
    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `error simulation without limit works indefinitely`() {
    val store = createStore(clock = { 1000L })
    store.setErrorSimulation(true, "dnsFailure", null, 99999L)

    repeat(50) {
      assertNotNull(store.getActiveErrorSimulation())
    }
  }

  @Test
  fun `clear also clears error simulation`() {
    val store = createStore(clock = { 1000L })
    store.setErrorSimulation(true, "http500", null, 99999L)
    store.clear()

    assertNull(store.getActiveErrorSimulation())
  }

  @Test
  fun `ruleMatcher interface delegates correctly`() {
    val store = createStore(clock = { 1000L })
    store.setRules(listOf(rule()))
    store.setErrorSimulation(true, "timeout", null, 99999L)

    val matcher = store.ruleMatcher
    assertNotNull(matcher.findMatchingRule("api.example.com", "/users", "GET"))
    assertNotNull(matcher.getErrorSimulation())
  }
}
