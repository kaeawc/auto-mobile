package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import okhttp3.Interceptor
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Grouped parameters for recording a network request/response manually.
 *
 * Use this with [AutoMobileNetwork.recordRequest] instead of constructing [SdkNetworkRequestEvent]
 * directly.
 *
 * @property url The full request URL (e.g. "https://api.example.com/users?page=1").
 * @property method HTTP method (e.g. "GET", "POST").
 * @property requestHeaders Optional request headers. Only recorded when header capture is enabled.
 * @property requestBodySize Size of the request body in bytes, or -1 if unknown.
 * @property statusCode HTTP status code of the response (e.g. 200, 404), or 0 on failure.
 * @property protocol Transport or protocol name (for example "cronet" or "http/1.1").
 * @property responseHeaders Optional response headers. Only recorded when header capture is
 *   enabled.
 * @property responseBodySize Size of the response body in bytes, or -1 if unknown.
 * @property durationMs Round-trip duration in milliseconds.
 * @property error Error description if the request failed, null on success.
 * @property host The request host (e.g. "api.example.com"). Extracted from [url] if omitted.
 * @property path The request path (e.g. "/users"). Extracted from [url] if omitted.
 * @property requestBody Request body text. Only useful when body capture is enabled and content is
 *   text-based.
 * @property responseBody Response body text. Only useful when body capture is enabled and content
 *   is text-based.
 * @property contentType Content type of the response (e.g. "application/json").
 */
data class NetworkRequestRecord(
  val url: String,
  val method: String,
  val requestHeaders: Map<String, String>? = null,
  val requestBodySize: Long = -1,
  val statusCode: Int = 0,
  val protocol: String? = null,
  val responseHeaders: Map<String, String>? = null,
  val responseBodySize: Long = -1,
  val durationMs: Long = 0,
  val error: String? = null,
  val host: String? = null,
  val path: String? = null,
  val requestBody: String? = null,
  val responseBody: String? = null,
  val contentType: String? = null,
)

/**
 * A cancellation-safe lifecycle handle for transports that report request and response callbacks
 * separately. The first terminal callback wins, so retries and late callbacks cannot emit duplicate
 * events.
 */
class NetworkCaptureSession private constructor(
  private val url: String,
  private val method: String,
  private val protocol: String?,
  private val requestHeaders: Map<String, String>?,
  private val requestBodySize: Long,
  private val captureHeaders: Boolean,
  private val captureBodies: Boolean,
) {
  private val terminal = AtomicBoolean(false)

  fun complete(
    statusCode: Int,
    responseHeaders: Map<String, String>? = null,
    responseBodySize: Long = -1,
    responseBody: String? = null,
    contentType: String? = null,
    durationMs: Long = 0,
  ) {
    if (!terminal.compareAndSet(false, true)) return
    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = url,
        method = method,
        protocol = protocol,
        requestHeaders = requestHeaders,
        requestBodySize = requestBodySize,
        statusCode = statusCode,
        responseHeaders = responseHeaders,
        responseBodySize = responseBodySize,
        responseBody = responseBody,
        contentType = contentType,
        durationMs = durationMs,
      ),
      captureHeaders = captureHeaders,
      captureBodies = captureBodies,
    )
  }

  fun fail(error: Throwable, durationMs: Long = 0) {
    if (!terminal.compareAndSet(false, true)) return
    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = url,
        method = method,
        protocol = protocol,
        requestHeaders = requestHeaders,
        requestBodySize = requestBodySize,
        error = error.message ?: error::class.simpleName,
        durationMs = durationMs,
      ),
      captureHeaders = captureHeaders,
      captureBodies = captureBodies,
    )
  }

  fun cancel(durationMs: Long = 0) = fail(IllegalStateException("cancelled"), durationMs)

  internal companion object {
    fun create(
      url: String,
      method: String,
      protocol: String?,
      requestHeaders: Map<String, String>?,
      requestBodySize: Long,
      captureHeaders: Boolean,
      captureBodies: Boolean,
    ) = NetworkCaptureSession(
      url,
      method,
      protocol,
      requestHeaders,
      requestBodySize,
      captureHeaders,
      captureBodies,
    )
  }
}

/**
 * Public API for network interception.
 *
 * Provides an OkHttp [Interceptor] for HTTP request/response tracking and a wrapper for
 * [WebSocketListener] to track WebSocket frames.
 *
 * For custom transport layers (gRPC, GraphQL, etc.) that do not use OkHttp, use [recordRequest] to
 * record request metadata manually.
 *
 * OkHttp is a `compileOnly` dependency -- consumers must include OkHttp themselves.
 */
object AutoMobileNetwork {

  @Volatile private var buffer: SdkEventBuffer? = null
  @Volatile private var applicationId: String? = null
  @Volatile private var ruleStore: NetworkMockRuleStore.RuleMatcher? = null
  @Volatile private var capturePolicyProvider: (() -> SdkCapturePolicy)? = null
  @Volatile private var networkControlProvider: (() -> Boolean)? = null

  /**
   * Initialize the network module with a shared event buffer.
   *
   * @param applicationId The application package name
   * @param buffer The shared SDK event buffer
   * @param ruleStore Optional rule matcher for mock enforcement and error simulation
   */
  internal fun initialize(
    applicationId: String?,
    buffer: SdkEventBuffer,
    ruleStore: NetworkMockRuleStore.RuleMatcher? = null,
  ) {
    this.applicationId = applicationId
    this.buffer = buffer
    this.ruleStore = ruleStore
  }

  internal fun setCapturePolicyProvider(provider: (() -> SdkCapturePolicy)?) {
    capturePolicyProvider = provider
  }

  internal fun setNetworkControlProvider(provider: (() -> Boolean)?) {
    networkControlProvider = provider
  }

  /**
   * Create an OkHttp Application-level Interceptor for HTTP request tracking.
   *
   * When a [ruleStore] has been provided via [initialize], the interceptor also enforces mock rules
   * and error simulation by short-circuiting matching requests.
   *
   * @param captureHeaders Whether to capture request/response headers (default false for privacy)
   * @param captureBodies Whether to capture request/response bodies (default false, truncated to
   *   32KB)
   * @return An [Interceptor] that records network events, or null if not initialized
   */
  fun interceptor(
    captureHeaders: Boolean = false,
    captureBodies: Boolean = false,
  ): Interceptor? {
    val buf = buffer ?: return null
    return AutoMobileNetworkInterceptor(
      buf,
      applicationId,
      captureHeaders,
      captureBodies,
      ruleStore = ruleStore,
      policyProvider = capturePolicyProvider,
      networkControlProvider = networkControlProvider,
    )
  }

  /**
   * Record a network request/response manually using a [NetworkRequestRecord].
   *
   * Use this for custom transport layers (gRPC, GraphQL, etc.) where the OkHttp [interceptor]
   * approach is not applicable.
   *
   * @param record A [NetworkRequestRecord] describing the request and response.
   * @param captureHeaders Whether to include request/response headers (default false for privacy).
   * @param captureBodies Whether to include request/response bodies (default false).
   */
  fun recordRequest(
    record: NetworkRequestRecord,
    captureHeaders: Boolean = false,
    captureBodies: Boolean = false,
  ) {
    val buf = buffer ?: return
    val policy = capturePolicyProvider?.invoke()
    val headersEnabled = captureHeaders && (policy?.captureHeaders ?: true)
    val bodiesEnabled = captureBodies && (policy?.captureBodies ?: true)
    val parsedUrl =
      if (record.host == null || record.path == null) {
        try {
          java.net.URL(record.url)
        } catch (_: Exception) {
          null
        }
      } else null
    val host = record.host ?: parsedUrl?.host
    val path = record.path ?: parsedUrl?.path
    buf.add(
      SdkNetworkRequestEvent(
        timestamp = System.currentTimeMillis(),
        applicationId = applicationId,
        url = record.url,
        method = record.method,
        statusCode = record.statusCode,
        durationMs = record.durationMs,
        protocol = record.protocol,
        requestBodySize = record.requestBodySize,
        responseBodySize = record.responseBodySize,
        host = host,
        path = path,
        error = record.error,
        requestHeaders = if (headersEnabled) record.requestHeaders else null,
        responseHeaders = if (headersEnabled) record.responseHeaders else null,
        requestBody = if (bodiesEnabled) record.requestBody else null,
        responseBody = if (bodiesEnabled) record.responseBody else null,
        contentType = record.contentType,
      )
    )
  }

  /**
   * Start a transport-neutral capture lifecycle. Use the returned handle from success, failure,
   * timeout, cancellation, and retry callbacks. Each handle emits at most one event.
   */
  fun startCapture(
    url: String,
    method: String = "GET",
    protocol: String? = null,
    requestHeaders: Map<String, String>? = null,
    requestBodySize: Long = -1,
    captureHeaders: Boolean = false,
    captureBodies: Boolean = false,
  ): NetworkCaptureSession? {
    if (buffer == null) return null
    return NetworkCaptureSession.create(
      url,
      method,
      protocol,
      requestHeaders,
      requestBodySize,
      captureHeaders,
      captureBodies,
    )
  }

  /**
   * Wrap a [WebSocketListener] to capture WebSocket frame metadata.
   *
   * @param delegate The original WebSocketListener to forward callbacks to
   * @param url The WebSocket URL for identification in recorded events
   * @return A wrapping listener that records frame events and delegates to the original
   */
  fun wrapWebSocketListener(delegate: WebSocketListener, url: String): WebSocketListener {
    val buf = buffer ?: return delegate
    return AutoMobileWebSocketListener(delegate, url, buf, applicationId)
  }

  /** Reset internal state. Visible for testing only. */
  internal fun reset() {
    buffer = null
    applicationId = null
    ruleStore = null
    capturePolicyProvider = null
    networkControlProvider = null
  }
}
