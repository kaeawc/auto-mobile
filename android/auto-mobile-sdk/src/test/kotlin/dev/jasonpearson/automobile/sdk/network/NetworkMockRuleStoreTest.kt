package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
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
      )
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
      )
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

  // Deterministic: every publication gets fresh counters, including unchanged rules.
  @Test
  fun `setRules resets remaining counters for unchanged rules`() {
    val store = createStore()
    val dtos = listOf(rule(limit = 5, remaining = 2))
    store.setRules(dtos)
    repeat(2) { assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET")) }
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))

    store.setRules(dtos)

    repeat(2) { assertNotNull(store.findMatchingRule("api.example.com", "/users", "GET")) }
    assertNull(store.findMatchingRule("api.example.com", "/users", "GET"))
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
