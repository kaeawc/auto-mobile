package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import okhttp3.Request
import okio.buffer
import org.junit.Test

internal class AutoMobileNetworkInterceptorMockTest : AutoMobileNetworkInterceptorFixture() {
  @Test
  fun `mock rule returns synthetic response without calling chain`() {
    val (buffer, flushed) = collectingBuffer()
    var chainCalled = false
    val chain =
      FakeInterceptorChain(
        ChainOptions().apply {
          this.request = Request.Builder().url("https://api.example.com/users").build()
          this.responseBody = "ok"
          this.responseContentType = "text/plain"
          this.onProceed = { chainCalled = true }
        },
      )
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 503,
        responseHeaders = mapOf("X-Mock" to "true"),
        responseBody = """{"error":"service unavailable"}""",
        contentType = "application/json",
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(matchResult = mockRule))

    val response = interceptor.intercept(chain)

    assertEquals(false, chainCalled)
    assertEquals(503, response.code)
    assertEquals("""{"error":"service unavailable"}""", response.body.string())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(503, event.statusCode)
    assertEquals("mocked:mock-1", event.error)
  }

  @Test
  fun `no rule store passes through to real request`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, ruleStore = null)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseCode = 200
        },
      )

    assertEquals(200, response.code)
    drainDelivery()
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.error)
  }

  @Test
  fun `error simulation http500 returns 500 response`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "http500",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    val response = interceptor.intercept(fakeChain())

    assertEquals(500, response.code)
    drainDelivery()
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(500, event.statusCode)
    assertEquals("simulated:http500", event.error)
  }

  @Test
  fun `error simulation timeout throws SocketTimeoutException`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "timeout",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    assertFailsWith<java.net.SocketTimeoutException> {
      interceptor.intercept(fakeChain())
    }
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("simulated:timeout", event.error)
  }

  @Test
  fun `error simulation connectionRefused throws ConnectException`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "connectionRefused",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    assertFailsWith<java.net.ConnectException> {
      interceptor.intercept(fakeChain())
    }
  }

  @Test
  fun `error simulation dnsFailure throws UnknownHostException`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "dnsFailure",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    assertFailsWith<java.net.UnknownHostException> {
      interceptor.intercept(fakeChain())
    }
  }

  @Test
  fun `error simulation tlsFailure throws SSLException`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "tlsFailure",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    assertFailsWith<javax.net.ssl.SSLException> {
      interceptor.intercept(fakeChain())
    }
  }

  @Test
  fun `mock rule takes priority over error simulation`() {
    val (buffer, _) = collectingBuffer()
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 404,
        responseHeaders = emptyMap(),
        responseBody = "not found",
        contentType = "text/plain",
      )
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "http500",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor =
      mutationEnabledInterceptor(
        buffer,
        fakeRuleMatcher(matchResult = mockRule, errorSim = sim),
      )

    val response = interceptor.intercept(fakeChain())

    assertEquals(404, response.code) // mock wins, not 500
  }

  @Test
  fun `null error simulation passes through to real request`() {
    val (buffer, _) = collectingBuffer()
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        ruleStore = fakeRuleMatcher(matchResult = null, errorSim = null),
      )

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseCode = 200
        },
      )

    assertEquals(200, response.code)
  }

  @Test
  fun `mocked response with body capture on is emitted once, before the app reads it`() {
    val (buffer, flushed) = collectingBuffer()
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 200,
        responseHeaders = emptyMap(),
        responseBody = """{"mocked":true}""",
        contentType = "application/json",
      )
    var chainCalled = false
    val chain =
      FakeInterceptorChain(
        ChainOptions().apply {
          this.onProceed = { chainCalled = true }
        },
      )
    val interceptor = bodyCapturingInterceptor(buffer, fakeRuleMatcher(matchResult = mockRule))

    val response = interceptor.intercept(chain)
    drainDelivery()

    // The synthetic body is already known, so its event does not wait for the app to finish it.
    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertEquals("mocked:mock-1", event.error)
    assertEquals("""{"mocked":true}""", event.responseBody)
    assertEquals(false, chainCalled)

    assertEquals("""{"mocked":true}""", response.body.string())
    response.close()
    drainDelivery()
    assertEquals(1, flushed.size) // reading and closing the mocked body emits nothing more
  }

  @Test
  fun `http500 error simulation with body capture on is emitted once`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "http500",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = bodyCapturingInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    val response = interceptor.intercept(fakeChain())
    drainDelivery()
    assertEquals("", response.body.string())
    response.close()
    drainDelivery()

    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertEquals(500, event.statusCode)
    assertEquals("simulated:http500", event.error)
  }

  @Test
  fun `thrown error simulation with body capture on is emitted once`() {
    val (buffer, flushed) = collectingBuffer()
    val sim =
      NetworkMockRuleStore.ErrorSimulationConfig(
        errorType = "timeout",
        limit = null,
        remaining = null,
        expiresAtEpochMs = 99999L,
      )
    val interceptor = bodyCapturingInterceptor(buffer, fakeRuleMatcher(errorSim = sim))

    assertFailsWith<java.net.SocketTimeoutException> { interceptor.intercept(fakeChain()) }
    drainDelivery()

    assertEquals("simulated:timeout", (flushed.single().single() as SdkNetworkRequestEvent).error)
  }

  @Test
  fun `a real response after a mocked one is still captured lazily and emitted once`() {
    val (buffer, flushed) = collectingBuffer()
    var rule: NetworkMockRuleStore.MatchedMockRule? =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 200,
        responseHeaders = emptyMap(),
        responseBody = "mocked",
        contentType = "text/plain",
      )
    val ruleStore =
      object : NetworkMockRuleStore.RuleMatcher {
        override fun findMatchingRule(host: String, path: String, method: String) = rule

        override fun getErrorSimulation() = null
      }
    val interceptor = bodyCapturingInterceptor(buffer, ruleStore)

    interceptor.intercept(fakeChain()).body.string()
    drainDelivery()
    assertEquals(1, flushed.size)

    rule = null // the mock is consumed or cleared: the next request goes to the network
    val real =
      interceptor.intercept(
        fakeChain {
          this.responseBody = """{"real":true}"""
        },
      )
    drainDelivery()
    assertEquals(1, flushed.size) // the real event waits for the app to finish the body

    assertEquals("""{"real":true}""", real.body.string())
    drainDelivery()
    assertEquals(2, flushed.size)
    assertEquals(
      """{"real":true}""",
      (flushed[1].single() as SdkNetworkRequestEvent).responseBody,
    )
  }
}
