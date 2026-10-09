package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import dev.jasonpearson.automobile.sdk.events.DropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import okhttp3.Authenticator
import okhttp3.Cache
import okhttp3.Call
import okhttp3.CertificatePinner
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSink
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.After
import org.junit.Test

class AutoMobileNetworkInterceptorTest {
  private var bufferExecutor: ScheduledExecutorService? = null

  @After
  fun tearDown() {
    bufferExecutor?.shutdownNow()
  }

  private fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<List<SdkEvent>>> {
    val flushed = mutableListOf<List<SdkEvent>>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = executor,
      )
    bufferExecutor = executor
    return buffer to flushed
  }

  private fun drainDelivery() {
    bufferExecutor!!.submit {}.get(1, TimeUnit.SECONDS)
  }

  private fun throwingBuffer(): SdkEventBuffer {
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        dropCounter =
          object : DropCounter {
            override fun increment(reason: DropReason, count: Int): Nothing =
              throw IllegalStateException("recording failed")

            override fun snapshot(): Map<DropReason, Long> = emptyMap()

            override fun reset() = Unit
          },
      )
    buffer.shutdown()
    return buffer
  }

  private fun fakeChain(
    request: Request = Request.Builder().url("https://api.example.com/users").build(),
    responseCode: Int = 200,
    responseBody: String = """{"ok":true}""",
    responseContentType: String = "application/json",
    protocol: Protocol = Protocol.HTTP_2,
    throwOnProceed: Exception? = null,
    responseBodyOverride: ResponseBody? = null,
  ): Interceptor.Chain {
    return FakeInterceptorChain(
      responseBodyOverride = responseBodyOverride,
      request = request,
      responseCode = responseCode,
      responseBody = responseBody,
      responseContentType = responseContentType,
      protocol = protocol,
      throwOnProceed = throwOnProceed,
    )
  }

  private class FakeInterceptorChain(
    private val request: Request = Request.Builder().url("https://api.example.com/users").build(),
    private val responseCode: Int = 200,
    private val responseBody: String = """{"ok":true}""",
    private val responseContentType: String = "application/json",
    private val protocol: Protocol = Protocol.HTTP_2,
    private val throwOnProceed: Exception? = null,
    private val onProceed: (() -> Unit)? = null,
    private val responseBodyOverride: ResponseBody? = null,
  ) : Interceptor.Chain {
    override fun request(): Request = request

    override fun proceed(request: Request): Response {
      onProceed?.invoke()
      if (throwOnProceed != null) throw throwOnProceed
      return Response.Builder()
        .request(request)
        .code(responseCode)
        .protocol(protocol)
        .message("OK")
        .header("Content-Type", responseContentType)
        .body(
          responseBodyOverride ?: responseBody.toResponseBody(responseContentType.toMediaType()),
        )
        .build()
    }

    override fun connection(): Connection? = null

    override fun call(): Call = throw UnsupportedOperationException()

    override fun connectTimeoutMillis() = 10_000

    override fun writeTimeoutMillis() = 10_000

    override fun readTimeoutMillis() = 10_000

    override fun withConnectTimeout(timeout: Int, unit: TimeUnit) = this

    override fun withWriteTimeout(timeout: Int, unit: TimeUnit) = this

    override fun withReadTimeout(timeout: Int, unit: TimeUnit) = this

    override val followSslRedirects = true
    override val followRedirects = true
    override val dns: Dns = Dns.SYSTEM

    override fun withDns(dns: Dns) = this

    override val socketFactory: SocketFactory = SocketFactory.getDefault()

    override fun withSocketFactory(socketFactory: SocketFactory) = this

    override val retryOnConnectionFailure = true

    override fun withRetryOnConnectionFailure(retryOnConnectionFailure: Boolean) = this

    override val authenticator: Authenticator = Authenticator.NONE

    override fun withAuthenticator(authenticator: Authenticator) = this

    override val cookieJar: CookieJar = CookieJar.NO_COOKIES

    override fun withCookieJar(cookieJar: CookieJar) = this

    override val cache: Cache? = null

    override fun withCache(cache: Cache?) = this

    override val proxy: Proxy? = null

    override fun withProxy(proxy: Proxy?) = this

    override val proxySelector: ProxySelector = ProxySelector.getDefault()

    override fun withProxySelector(proxySelector: ProxySelector) = this

    override val proxyAuthenticator: Authenticator = Authenticator.NONE

    override fun withProxyAuthenticator(proxyAuthenticator: Authenticator) = this

    override val sslSocketFactoryOrNull: SSLSocketFactory? = null

    override fun withSslSocketFactory(
      sslSocketFactory: SSLSocketFactory?,
      x509TrustManager: X509TrustManager?,
    ) = this

    override val x509TrustManagerOrNull: X509TrustManager? = null
    override val hostnameVerifier = HostnameVerifier { _, _ -> true }

    override fun withHostnameVerifier(hostnameVerifier: HostnameVerifier) = this

    override val certificatePinner: CertificatePinner = CertificatePinner.DEFAULT

    override fun withCertificatePinner(certificatePinner: CertificatePinner) = this

    override val connectionPool = ConnectionPool()

    override fun withConnectionPool(connectionPool: ConnectionPool) = this

    override val eventListener: EventListener = EventListener.NONE
  }

  @Test
  fun `records successful request metadata`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, applicationId = "com.example")
    val request = Request.Builder().url("https://api.example.com/users?page=1").get().build()

    interceptor.intercept(fakeChain(request = request, responseCode = 200))
    drainDelivery()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("https://api.example.com/users?page=1", event.url)
    assertEquals("GET", event.method)
    assertEquals(200, event.statusCode)
    assertEquals("api.example.com", event.host)
    assertEquals("/users", event.path)
    assertEquals("com.example", event.applicationId)
    assertNull(event.error)
  }

  @Test
  fun `records response body size`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)
    val body = "x".repeat(1024)

    interceptor.intercept(fakeChain(responseBody = body))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(1024L, event.responseBodySize)
  }

  @Test
  fun `records protocol`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain(protocol = Protocol.HTTP_2))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("h2", event.protocol)
  }

  @Test
  fun `records failed request with statusCode 0 and error message`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    assertFailsWith<IOException> {
      interceptor.intercept(fakeChain(throwOnProceed = IOException("Connection refused")))
    }
    drainDelivery()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(0, event.statusCode)
    assertEquals(-1L, event.responseBodySize)
    assertEquals("Connection refused", event.error)
  }

  @Test
  fun `rethrows exception after recording`() {
    val (buffer, _) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    assertFailsWith<IOException> {
      interceptor.intercept(fakeChain(throwOnProceed = IOException("timeout")))
    }
  }

  @Test
  fun `records POST method`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)
    val request =
      Request.Builder()
        .url("https://api.example.com/submit")
        .post("data".toRequestBody("text/plain".toMediaType()))
        .build()

    interceptor.intercept(fakeChain(request = request, responseCode = 201))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("POST", event.method)
    assertEquals(201, event.statusCode)
    assertEquals(4L, event.requestBodySize)
  }

  @Test
  fun `records duration greater than zero`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertTrue(event.durationMs >= 0, "Duration should be non-negative")
  }

  // --- captureHeaders tests ---

  @Test
  fun `captureHeaders true captures request headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .header("Accept", "application/json")
        .header("Authorization", "Bearer token123")
        .build()

    interceptor.intercept(fakeChain(request = request))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNotNull(event.requestHeaders)
    assertEquals("application/json", event.requestHeaders!!["Accept"])
    assertEquals("Bearer token123", event.requestHeaders!!["Authorization"])
  }

  @Test
  fun `captureHeaders joins repeated request header values in encounter order`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    // addHeader appends rather than replacing, so this is the only way to produce a
    // Headers instance with a repeated name. Three values, not two: two would still pass
    // if the join order were reversed or the fold kept only the outermost pair.
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .addHeader("X-Trace", "first")
        .addHeader("X-Trace", "second")
        .addHeader("X-Trace", "third")
        .build()

    interceptor.intercept(fakeChain(request = request))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("first, second, third", event.requestHeaders!!["X-Trace"])
  }

  @Test
  fun `captureHeaders keeps repeated header names case sensitive`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    // Differently-cased names are distinct keys -- they must not be folded together, which
    // is why this cannot delegate to okhttp's Headers.toMultimap() (that lowercases names).
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .addHeader("X-Case", "lower")
        .addHeader("X-CASE", "upper")
        .build()

    interceptor.intercept(fakeChain(request = request))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("lower", event.requestHeaders!!["X-Case"])
    assertEquals("upper", event.requestHeaders!!["X-CASE"])
  }

  @Test
  fun `captureHeaders true captures response headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNotNull(event.responseHeaders)
    // Response has Content-Type from fakeChain body
    assertEquals("application/json", event.responseHeaders!!["Content-Type"])
  }

  @Test
  fun `captureHeaders false does not capture headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = false)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
  }

  // --- captureBodies tests ---

  @Test
  fun `captureBodies true captures request body for text content type`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val request =
      Request.Builder()
        .url("https://api.example.com/submit")
        .post("""{"name":"test"}""".toRequestBody("application/json".toMediaType()))
        .build()

    interceptor.intercept(fakeChain(request = request, responseCode = 201)).close()
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("""{"name":"test"}""", event.requestBody)
  }

  @Test
  fun `captureBodies true captures response body for JSON`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)

    val response = interceptor.intercept(fakeChain(responseBody = """{"ok":true}"""))
    assertEquals("""{"ok":true}""", response.body.string())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("""{"ok":true}""", event.responseBody)
  }

  @Test
  fun `captureBodies false does not capture bodies`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = false)
    val request =
      Request.Builder()
        .url("https://api.example.com/submit")
        .post("data".toRequestBody("text/plain".toMediaType()))
        .build()

    interceptor.intercept(fakeChain(request = request))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }

  @Test
  fun `captureBodies does not capture binary content types`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val request =
      Request.Builder()
        .url("https://api.example.com/image")
        .post("binary".toRequestBody("image/png".toMediaType()))
        .build()

    interceptor.intercept(fakeChain(request = request)).close()
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestBody) // image/png is not a text type
  }

  @Test
  fun `contentType field is populated from response`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("application/json", event.contentType)
  }

  @Test
  fun `failed request with captureHeaders still captures request headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    val request =
      Request.Builder().url("https://api.example.com/fail").header("X-Custom", "value").build()

    assertFailsWith<IOException> {
      interceptor.intercept(fakeChain(request = request, throwOnProceed = IOException("timeout")))
    }
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNotNull(event.requestHeaders)
    assertEquals("value", event.requestHeaders!!["X-Custom"])
    assertNull(event.responseHeaders) // no response
  }

  // --- Mock enforcement tests ---

  private fun fakeRuleMatcher(
    matchResult: NetworkMockRuleStore.MatchedMockRule? = null,
    errorSim: NetworkMockRuleStore.ErrorSimulationConfig? = null,
  ): NetworkMockRuleStore.RuleMatcher {
    return object : NetworkMockRuleStore.RuleMatcher {
      override fun findMatchingRule(host: String, path: String, method: String) = matchResult

      override fun getErrorSimulation() = errorSim
    }
  }

  private fun mutationEnabledInterceptor(
    buffer: SdkEventBuffer,
    ruleStore: NetworkMockRuleStore.RuleMatcher,
  ) =
    AutoMobileNetworkInterceptor(
      buffer,
      ruleStore = ruleStore,
      policyProvider = { SdkCapturePolicy(allowMutations = true) },
      networkControlProvider = { true },
    )

  @Test
  fun `mock rule returns synthetic response without calling chain`() {
    val (buffer, flushed) = collectingBuffer()
    var chainCalled = false
    val chain =
      FakeInterceptorChain(
        request = Request.Builder().url("https://api.example.com/users").build(),
        responseBody = "ok",
        responseContentType = "text/plain",
        onProceed = { chainCalled = true },
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

    val response = interceptor.intercept(fakeChain(responseCode = 200))

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

    val response = interceptor.intercept(fakeChain(responseCode = 200))

    assertEquals(200, response.code)
  }

  @Test
  fun `observation failures leave a successful host request unchanged`() {
    val buffer = throwingBuffer()
    var proceedCalls = 0
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        ruleStore =
          object : NetworkMockRuleStore.RuleMatcher {
            override fun findMatchingRule(host: String, path: String, method: String): Nothing =
              throw IllegalStateException("rule matching failed")

            override fun getErrorSimulation(): NetworkMockRuleStore.ErrorSimulationConfig? = null
          },
        policyProvider = { SdkCapturePolicy(allowMutations = true) },
        networkControlProvider = { true },
      )

    val response =
      interceptor.intercept(
        FakeInterceptorChain(responseCode = 202, onProceed = { proceedCalls++ }),
      )

    assertEquals(1, proceedCalls)
    assertEquals(202, response.code)
  }

  @Test
  fun `observation failures leave a failed host request unchanged`() {
    val buffer = throwingBuffer()
    val hostFailure = IOException("host failure")
    var proceedCalls = 0
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        policyProvider = { throw IllegalStateException("policy failed") },
      )

    val thrown =
      assertFailsWith<IOException> {
        interceptor.intercept(
          FakeInterceptorChain(
            throwOnProceed = hostFailure,
            onProceed = { proceedCalls++ },
          ),
        )
      }

    assertEquals(1, proceedCalls)
    assertSame(hostFailure, thrown)
  }

  @Test
  fun `mock rules require an explicitly enabled network control policy`() {
    val (buffer, _) = collectingBuffer()
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 503,
        responseHeaders = emptyMap(),
        responseBody = "mocked",
        contentType = "text/plain",
      )
    var proceedCalls = 0
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        ruleStore = fakeRuleMatcher(matchResult = mockRule),
      )

    val response =
      interceptor.intercept(
        FakeInterceptorChain(responseCode = 204, onProceed = { proceedCalls++ }),
      )

    assertEquals(1, proceedCalls)
    assertEquals(204, response.code)
  }

  @Test
  fun `policy lookup failure disables sensitive capture`() {
    val (buffer, flushed) = collectingBuffer()
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .header("Authorization", "Bearer token")
        .post("secret".toRequestBody("text/plain".toMediaType()))
        .build()
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        captureHeaders = true,
        captureBodies = true,
        policyProvider = { throw IllegalStateException("policy failed") },
      )

    interceptor.intercept(fakeChain(request = request))
    drainDelivery()

    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }

  @Test
  fun `invalid mock response falls through without recording a mock event`() {
    val (buffer, flushed) = collectingBuffer()
    var proceedCalls = 0
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 503,
        responseHeaders = mapOf("X-Invalid" to "line\nbreak"),
        responseBody = "mocked",
        contentType = "text/plain",
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(matchResult = mockRule))

    val response =
      interceptor.intercept(
        FakeInterceptorChain(responseCode = 204, onProceed = { proceedCalls++ }),
      )
    drainDelivery()

    assertEquals(1, proceedCalls)
    assertEquals(204, response.code)
    assertEquals(1, flushed.flatten().size)
    assertNull((flushed.single().single() as SdkNetworkRequestEvent).error)
  }

  // --- Default behavior tests ---

  @Test
  fun `default captureHeaders and captureBodies are false`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }

  // --- Bounded request body capture (#10136) ---

  /** A request body that records how often and how far the SDK or the chain wrote it. */
  private class RecordingRequestBody(
    private val mediaType: String,
    private val length: Long,
    private val chunk: ByteArray,
    private val chunks: Int,
    private val oneShot: Boolean = false,
    private val duplex: Boolean = false,
  ) : RequestBody() {
    var writeToCalls = 0
    var bytesWritten = 0L

    override fun contentType() = mediaType.toMediaType()

    override fun contentLength() = length

    override fun isOneShot() = oneShot

    override fun isDuplex() = duplex

    override fun writeTo(sink: BufferedSink) {
      check(!(oneShot && writeToCalls >= 1)) { "one-shot body written twice" }
      writeToCalls++
      repeat(chunks) {
        sink.write(chunk)
        bytesWritten += chunk.size
      }
    }
  }

  private fun postRequest(body: RequestBody) =
    Request.Builder().url("https://api.example.com/upload").post(body).build()

  @Test
  fun `one-shot request body is not written by capture and reaches the chain intact`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val payload = """{"stream":"from input stream"}""".toByteArray()
    val body = RecordingRequestBody("application/json", payload.size.toLong(), payload, 1, true)
    val request = postRequest(body)
    var sent = ""

    interceptor
      .intercept(
        FakeInterceptorChain(
          request = request,
          onProceed = {
            val wire = Buffer()
            request.body!!.writeTo(wire)
            sent = wire.readUtf8()
          },
        ),
      )
      .close()
    drainDelivery()

    assertEquals(1, body.writeToCalls)
    assertEquals("""{"stream":"from input stream"}""", sent)
    assertNull((flushed.single().single() as SdkNetworkRequestEvent).requestBody)
  }

  @Test
  fun `duplex request body is never written by capture`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val body = RecordingRequestBody("text/plain", -1, "x".toByteArray(), 1, duplex = true)

    interceptor.intercept(fakeChain(request = postRequest(body))).close()
    drainDelivery()

    assertEquals(0, body.writeToCalls)
    assertNull((flushed.single().single() as SdkNetworkRequestEvent).requestBody)
  }

  @Test
  fun `known-length 50 MB request body is skipped without being written`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val fiftyMb = 50L * 1024 * 1024
    val body =
      RecordingRequestBody("text/csv", fiftyMb, ByteArray(1024) { 'a'.code.toByte() }, 51_200)

    interceptor.intercept(fakeChain(request = postRequest(body))).close()
    drainDelivery()

    assertEquals(0, body.writeToCalls)
    assertEquals(0L, body.bytesWritten)
    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertNull(event.requestBody)
    assertEquals(fiftyMb, event.requestBodySize)
  }

  @Test
  fun `unknown-length request body stops being pulled at the capture cap`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val chunk = ByteArray(1024) { 'a'.code.toByte() }
    val body = RecordingRequestBody("text/plain", -1, chunk, 10 * 1024) // 10 MB if fully written

    interceptor.intercept(fakeChain(request = postRequest(body))).close()
    drainDelivery()

    assertEquals(1, body.writeToCalls)
    assertTrue(
      body.bytesWritten < 4 * AutoMobileNetworkInterceptor.MAX_BODY_BYTES,
      "capture pulled ${body.bytesWritten} bytes",
    )
    val captured = (flushed.single().single() as SdkNetworkRequestEvent).requestBody
    assertEquals(AutoMobileNetworkInterceptor.MAX_BODY_BYTES.toInt(), captured?.length)
  }

  @Test
  fun `small known-length request body is still captured whole`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val chunk = "hello".toByteArray()
    val body = RecordingRequestBody("text/plain", 10, chunk, 2)

    interceptor.intercept(fakeChain(request = postRequest(body))).close()
    drainDelivery()

    assertEquals("hellohello", (flushed.single().single() as SdkNetworkRequestEvent).requestBody)
  }

  // --- Non-blocking response body capture (#10137) ---

  /** A response source that yields one chunk and fails the test if anyone reads past it. */
  private class OneChunkSource(
    private val chunk: ByteArray,
    private val failWith: IOException? = null,
  ) : Source {
    var reads = 0
    var closed = false

    override fun read(sink: Buffer, byteCount: Long): Long {
      reads++
      if (reads == 2 && failWith != null) throw failWith
      if (reads > 1) throw AssertionError("source read again before the test released it")
      sink.write(chunk)
      return chunk.size.toLong()
    }

    override fun timeout() = Timeout.NONE

    override fun close() {
      closed = true
    }
  }

  private fun streamingBody(source: Source, contentType: String) =
    source.buffer().asResponseBody(contentType.toMediaType(), -1)

  private val twentyBytes = "data: hello\n\nabcdefg".toByteArray()

  @Test
  fun `server-sent-event response is returned without reading the body and is not captured`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val source = OneChunkSource(twentyBytes)

    val response =
      interceptor.intercept(
        fakeChain(
          responseContentType = "text/event-stream",
          responseBodyOverride = streamingBody(source, "text/event-stream"),
        ),
      )
    drainDelivery()

    assertEquals(0, source.reads)
    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertEquals(200, event.statusCode)
    assertNull(event.responseBody)
    assertEquals("data: hello\n\nabcdefg", response.body.source().readUtf8(20))
    assertEquals(1, source.reads)
  }

  @Test
  fun `streaming json response is returned without a read and reported when the app closes it`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val source = OneChunkSource(twentyBytes)

    val response =
      interceptor.intercept(
        fakeChain(responseBodyOverride = streamingBody(source, "application/json")),
      )
    drainDelivery()
    assertEquals(0, source.reads)
    assertTrue(flushed.isEmpty())

    assertEquals("data: hello\n\nabcdefg", response.body.source().readUtf8(20))
    drainDelivery()
    assertTrue(flushed.isEmpty())

    response.close()
    drainDelivery()
    assertTrue(source.closed)
    assertEquals(
      "data: hello\n\nabcdefg",
      (flushed.single().single() as SdkNetworkRequestEvent).responseBody,
    )
  }

  @Test
  fun `large response is delivered whole while only the cap is captured`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val big = "a".repeat(100 * 1024)

    val response = interceptor.intercept(fakeChain(responseBody = big))
    drainDelivery()
    assertTrue(flushed.isEmpty())

    assertEquals(big, response.body.string())
    drainDelivery()

    val captured = (flushed.single().single() as SdkNetworkRequestEvent).responseBody
    assertEquals("a".repeat(AutoMobileNetworkInterceptor.MAX_BODY_BYTES.toInt()), captured)
  }

  @Test
  fun `response read failure reports what was captured and rethrows`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val failure = IOException("connection reset")
    val source = OneChunkSource("partial".toByteArray(), failWith = failure)

    val response =
      interceptor.intercept(
        fakeChain(responseBodyOverride = streamingBody(source, "application/json")),
      )
    val thrown = assertFailsWith<IOException> { response.body.string() }
    drainDelivery()

    assertSame(failure, thrown)
    assertEquals("partial", (flushed.single().single() as SdkNetworkRequestEvent).responseBody)
  }

  @Test
  fun `abandoned response body is reported at the deadline exactly once`() {
    val (buffer, flushed) = collectingBuffer()
    val deadlines = mutableListOf<Pair<Runnable, Long>>()
    var cancelled = 0
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, captureBodies = true).apply {
        scheduleCaptureDeadline = { task, delayMs ->
          deadlines.add(task to delayMs)
          val cancel: () -> Unit = { cancelled++ }
          cancel
        }
      }
    val source = OneChunkSource(twentyBytes)

    val response =
      interceptor.intercept(
        fakeChain(responseBodyOverride = streamingBody(source, "application/json")),
      )
    response.body.source().require(1)
    drainDelivery()
    assertTrue(flushed.isEmpty())
    assertEquals(NetworkBodyCapture.RESPONSE_CAPTURE_DEADLINE_MS, deadlines.single().second)

    deadlines.single().first.run()
    response.close()
    drainDelivery()

    assertEquals(
      "data: hello\n\nabcdefg",
      (flushed.single().single() as SdkNetworkRequestEvent).responseBody,
    )
    assertEquals(1, cancelled) // the late close does not re-emit
  }

  @Test
  fun `completing the body cancels its deadline`() {
    val (buffer, _) = collectingBuffer()
    var cancelled = 0
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, captureBodies = true).apply {
        scheduleCaptureDeadline = { _, _ -> { cancelled++ } }
      }

    interceptor.intercept(fakeChain(responseBody = """{"ok":true}""")).body.string()

    assertEquals(1, cancelled)
  }

  @Test
  fun `empty response body is reported immediately`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)

    interceptor.intercept(fakeChain(responseBody = ""))
    drainDelivery()

    assertEquals("", (flushed.single().single() as SdkNetworkRequestEvent).responseBody)
  }

  // --- Lazy response capture (#10137) x mocked responses and error simulation ---

  private fun bodyCapturingInterceptor(
    buffer: SdkEventBuffer,
    ruleStore: NetworkMockRuleStore.RuleMatcher,
  ) =
    AutoMobileNetworkInterceptor(
      buffer,
      ruleStore = ruleStore,
      captureBodies = true,
      policyProvider = { SdkCapturePolicy(captureBodies = true, allowMutations = true) },
      networkControlProvider = { true },
    )

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
    val chain = FakeInterceptorChain(onProceed = { chainCalled = true })
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
    val real = interceptor.intercept(fakeChain(responseBody = """{"real":true}"""))
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
