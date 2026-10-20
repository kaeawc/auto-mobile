package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
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

internal abstract class AutoMobileNetworkInterceptorFixture {
  protected var bufferExecutor: ScheduledExecutorService? = null

  @After
  fun tearDown() {
    bufferExecutor?.shutdownNow()
  }

  protected fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<List<SdkEvent>>> {
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

  protected fun drainDelivery() {
    bufferExecutor!!.submit {}.get(1, TimeUnit.SECONDS)
  }

  protected fun throwingBuffer(): SdkEventBuffer {
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

  protected class ChainOptions {
    var request: Request = Request.Builder().url("https://api.example.com/users").build()
    var responseCode: Int = 200
    var responseBody: String = """{"ok":true}"""
    var responseContentType: String = "application/json"
    var protocol: Protocol = Protocol.HTTP_2
    var throwOnProceed: Exception? = null
    var onProceed: (() -> Unit)? = null
    var responseBodyOverride: ResponseBody? = null
  }

  protected fun fakeChain(configure: ChainOptions.() -> Unit = {}): Interceptor.Chain =
    FakeInterceptorChain(ChainOptions().apply(configure))

  protected class FakeInterceptorChain(private val options: ChainOptions = ChainOptions()) :
    Interceptor.Chain {
    override fun request(): Request = options.request

    override fun proceed(request: Request): Response {
      options.onProceed?.invoke()
      options.throwOnProceed?.let { throw it }
      return Response.Builder()
        .request(request)
        .code(options.responseCode)
        .protocol(options.protocol)
        .message("OK")
        .header("Content-Type", options.responseContentType)
        .body(
          options.responseBodyOverride
            ?: options.responseBody.toResponseBody(options.responseContentType.toMediaType()),
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

  // --- captureHeaders tests ---

  // --- captureBodies tests ---

  // --- Mock enforcement tests ---

  protected fun fakeRuleMatcher(
    matchResult: NetworkMockRuleStore.MatchedMockRule? = null,
    errorSim: NetworkMockRuleStore.ErrorSimulationConfig? = null,
  ): NetworkMockRuleStore.RuleMatcher {
    return object : NetworkMockRuleStore.RuleMatcher {
      override fun findMatchingRule(host: String, path: String, method: String) = matchResult

      override fun getErrorSimulation() = errorSim
    }
  }

  protected fun mutationEnabledInterceptor(
    buffer: SdkEventBuffer,
    ruleStore: NetworkMockRuleStore.RuleMatcher,
  ) =
    AutoMobileNetworkInterceptor(
      buffer,
      ruleStore = ruleStore,
      policyProvider = { SdkCapturePolicy(allowMutations = true) },
      networkControlProvider = { true },
    )

  // --- Default behavior tests ---

  // --- Bounded request body capture (#10136) ---

  /** A request body that records how often and how far the SDK or the chain wrote it. */
  protected class RecordingRequestBody(
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

  protected fun postRequest(body: RequestBody) =
    Request.Builder().url("https://api.example.com/upload").post(body).build()

  // --- Non-blocking response body capture (#10137) ---

  /** A response source that yields one chunk and fails the test if anyone reads past it. */
  protected class OneChunkSource(
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

  protected fun streamingBody(source: Source, contentType: String) =
    source.buffer().asResponseBody(contentType.toMediaType(), -1)

  protected val twentyBytes = "data: hello\n\nabcdefg".toByteArray()

  // --- Lazy response capture (#10137) x mocked responses and error simulation ---

  protected fun bodyCapturingInterceptor(
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
}
