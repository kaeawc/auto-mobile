package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
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
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
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

  private fun fakeChain(
    request: Request = Request.Builder().url("https://api.example.com/users").build(),
    responseCode: Int = 200,
    responseBody: String = """{"ok":true}""",
    responseContentType: String = "application/json",
    protocol: Protocol = Protocol.HTTP_2,
    throwOnProceed: Exception? = null,
  ): Interceptor.Chain {
    return FakeInterceptorChain(
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
        .body(responseBody.toResponseBody(responseContentType.toMediaType()))
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

    interceptor.intercept(fakeChain(request = request, responseCode = 201))
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("""{"name":"test"}""", event.requestBody)
  }

  @Test
  fun `captureBodies true captures response body for JSON`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)

    interceptor.intercept(fakeChain(responseBody = """{"ok":true}"""))
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

    interceptor.intercept(fakeChain(request = request))
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
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, ruleStore = fakeRuleMatcher(matchResult = mockRule))

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
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, ruleStore = fakeRuleMatcher(errorSim = sim))

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
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, ruleStore = fakeRuleMatcher(errorSim = sim))

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
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, ruleStore = fakeRuleMatcher(errorSim = sim))

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
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, ruleStore = fakeRuleMatcher(errorSim = sim))

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
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, ruleStore = fakeRuleMatcher(errorSim = sim))

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
      AutoMobileNetworkInterceptor(
        buffer,
        ruleStore = fakeRuleMatcher(matchResult = mockRule, errorSim = sim),
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
}
