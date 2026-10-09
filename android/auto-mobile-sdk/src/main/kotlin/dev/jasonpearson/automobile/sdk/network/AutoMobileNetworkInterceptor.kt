package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * OkHttp Application-level Interceptor that captures HTTP request/response metadata and enforces
 * network mock rules and error simulation.
 *
 * Records URL, method, status, duration, body sizes, and optionally headers and bodies. Header/body
 * capture is opt-in to avoid leaking auth tokens by default.
 *
 * When a [ruleStore] is provided, the interceptor checks for matching mock rules and active error
 * simulations before making real HTTP calls. Matching requests are short-circuited with synthetic
 * responses.
 *
 * This class references OkHttp types which must be on the classpath. The SDK declares OkHttp as
 * `compileOnly` so consumers must bring their own OkHttp dependency.
 */
internal class AutoMobileNetworkInterceptor(
  private val buffer: SdkEventBuffer,
  private val applicationId: String? = null,
  /** Capture request and response headers (may contain auth tokens) */
  private val captureHeaders: Boolean = false,
  /** Capture request and response bodies (truncated to [maxBodyBytes]) */
  private val captureBodies: Boolean = false,
  /** Maximum body size to capture in bytes */
  private val maxBodyBytes: Long = MAX_BODY_BYTES,
  /** Optional rule store for mock enforcement and error simulation */
  private val ruleStore: NetworkMockRuleStore.RuleMatcher? = null,
  private val policyProvider: (() -> SdkCapturePolicy)? = null,
  private val networkControlProvider: (() -> Boolean)? = null,
) : Interceptor {

  /**
   * Schedules the deadline after which an unread, never-closed response body is reported with what
   * was captured so far; returns a cancel handle. Null uses the event buffer's shared scheduler. A
   * seam for deterministic tests; a property rather than a constructor parameter so the existing
   * constructor signature stays unchanged.
   */
  internal var scheduleCaptureDeadline: ((Runnable, Long) -> (() -> Unit)?)? = null

  companion object {
    private const val TAG = "AutoMobileNetwork"

    /** Default max body capture size: 32KB */
    const val MAX_BODY_BYTES = 32L * 1024

    private val TEXT_CONTENT_TYPES =
      setOf(
        "application/json",
        "text/plain",
        "text/html",
        "text/xml",
        "application/xml",
        "application/x-www-form-urlencoded",
      )

    private fun isTextContentType(contentType: String?): Boolean {
      if (contentType == null) return false
      val base = contentType.substringBefore(';').trim().lowercase()
      return TEXT_CONTENT_TYPES.any { base == it || base.startsWith("text/") }
    }
  }

  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    val startMs = System.currentTimeMillis()
    val policy = policyProvider?.let { observeOrNull { it() } }
    val policyUnavailable = policyProvider != null && policy == null
    val headersEnabled = captureHeaders && !policyUnavailable && (policy?.captureHeaders ?: true)
    val bodiesEnabled = captureBodies && !policyUnavailable && (policy?.captureBodies ?: true)
    val mutationsEnabled = policy?.allowMutations == true
    val networkControlEnabled =
      mutationsEnabled && observeOrNull { networkControlProvider?.invoke() } == true

    // Capture request headers — include OkHttp defaults that will be added later
    val reqHeaders = observeOrNull {
      if (!headersEnabled) return@observeOrNull null
      val headers = request.headers.toHeaderMap().toMutableMap()
      if ("Host" !in headers) headers["Host"] = request.url.host
      if ("User-Agent" !in headers) headers["User-Agent"] = "okhttp/${okhttp3.OkHttp.VERSION}"
      headers
    }

    // Capture request body
    val reqBody = observeOrNull {
      if (bodiesEnabled && request.body != null) captureRequestBody(request) else null
    }

    // --- Mock rule enforcement ---
    val mockRule =
      if (mutationsEnabled && networkControlEnabled) {
        observeOrNull {
          ruleStore?.findMatchingRule(request.url.host, request.url.encodedPath, request.method)
        }
      } else null
    if (mockRule != null) {
      val durationMs = System.currentTimeMillis() - startMs
      val mockedResponse = observeOrNull { buildMockResponse(request, mockRule) }
      if (mockedResponse != null) {
        observe {
          buffer.add(
            SdkNetworkRequestEvent(
              timestamp = startMs,
              applicationId = applicationId,
              url = request.url.toString(),
              method = request.method,
              statusCode = mockRule.statusCode,
              durationMs = durationMs,
              requestBodySize = request.body?.contentLength() ?: -1,
              responseBodySize = mockRule.responseBody.length.toLong(),
              host = request.url.host,
              path = request.url.encodedPath,
              error = "mocked:${mockRule.mockId}",
              requestHeaders = reqHeaders,
              requestBody = reqBody,
              responseBody = if (bodiesEnabled) mockRule.responseBody else null,
              contentType = mockRule.contentType,
            ),
          )
        }
        return mockedResponse
      }
    }

    // --- Error simulation enforcement ---
    val errorSim =
      if (mutationsEnabled && networkControlEnabled) {
        observeOrNull { ruleStore?.getErrorSimulation() }
      } else null
    if (errorSim != null) {
      val durationMs = System.currentTimeMillis() - startMs
      return handleErrorSimulation(request, errorSim, startMs, durationMs, reqHeaders, reqBody)
    }

    // --- Normal request flow ---
    val response: Response
    try {
      response = chain.proceed(request)
    } catch (e: Exception) {
      val durationMs = System.currentTimeMillis() - startMs
      observe {
        buffer.add(
          SdkNetworkRequestEvent(
            timestamp = startMs,
            applicationId = applicationId,
            url = request.url.toString(),
            method = request.method,
            statusCode = 0,
            durationMs = durationMs,
            requestBodySize = request.body?.contentLength() ?: -1,
            responseBodySize = -1,
            host = request.url.host,
            path = request.url.encodedPath,
            error = e.message,
            requestHeaders = reqHeaders,
            requestBody = reqBody,
          ),
        )
      }
      throw e
    }

    return observeOrNull {
      recordResponse(
        request = request,
        response = response,
        startMs = startMs,
        headersEnabled = headersEnabled,
        bodiesEnabled = bodiesEnabled,
        reqHeaders = reqHeaders,
        reqBody = reqBody,
      )
    } ?: response
  }

  /**
   * Emit the event for a completed exchange and return the response to hand to the app.
   *
   * Response bodies are never read here: reading would put body download time into time-to-headers
   * and would block forever on a streaming response. When a body is captured, the returned response
   * wraps the original body so bytes are copied as the app reads them, and the event is emitted
   * when the app finishes (or abandons) the body. See [NetworkBodyCapture.CapturingResponseBody].
   */
  private fun recordResponse(
    request: okhttp3.Request,
    response: Response,
    startMs: Long,
    headersEnabled: Boolean,
    bodiesEnabled: Boolean,
    reqHeaders: Map<String, String>?,
    reqBody: String?,
  ): Response {
    val durationMs = System.currentTimeMillis() - startMs
    val responseContentType = response.header("Content-Type")
    val finalReqHeaders = if (headersEnabled) response.request.headers.toHeaderMap() else reqHeaders
    val respHeaders = if (headersEnabled) response.headers.toHeaderMap() else null
    val responseBodySize = response.body?.contentLength() ?: -1
    fun event(respBody: String?) =
      SdkNetworkRequestEvent(
        timestamp = startMs,
        applicationId = applicationId,
        url = request.url.toString(),
        method = request.method,
        statusCode = response.code,
        durationMs = durationMs,
        requestBodySize = request.body?.contentLength() ?: -1,
        responseBodySize = responseBodySize,
        protocol = response.protocol.toString(),
        host = request.url.host,
        path = request.url.encodedPath,
        requestHeaders = finalReqHeaders,
        responseHeaders = respHeaders,
        requestBody = reqBody,
        responseBody = respBody,
        contentType = responseContentType,
      )

    val body = response.body
    val capture =
      bodiesEnabled &&
        isTextContentType(responseContentType) &&
        !NetworkBodyCapture.isStreamingContentType(responseContentType)
    if (!capture || body == null) {
      buffer.add(event(null))
      return response
    }
    if (responseBodySize == 0L) {
      buffer.add(event(""))
      return response
    }
    val capturing =
      NetworkBodyCapture.CapturingResponseBody(
        delegate = body,
        maxBytes = maxBodyBytes,
        onComplete = { text -> observe { buffer.add(event(text)) } },
        scheduleDeadline =
          scheduleCaptureDeadline ?: { task, delayMs -> buffer.scheduleDelivery(task, delayMs) },
      )
    return response.newBuilder().body(capturing).build()
  }

  private fun buildMockResponse(
    request: okhttp3.Request,
    rule: NetworkMockRuleStore.MatchedMockRule,
  ): Response {
    val statusCode = rule.statusCode.coerceIn(100, 599)
    val mediaType =
      try {
        rule.contentType.toMediaType()
      } catch (_: IllegalArgumentException) {
        "application/octet-stream".toMediaType()
      }
    val builder =
      Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(statusCode)
        .message("Mocked by AutoMobile (${rule.mockId})")
        .body(rule.responseBody.toResponseBody(mediaType))
    for ((name, value) in rule.responseHeaders) {
      builder.addHeader(name, value)
    }
    return builder.build()
  }

  private fun handleErrorSimulation(
    request: okhttp3.Request,
    sim: NetworkMockRuleStore.ErrorSimulationConfig,
    startMs: Long,
    durationMs: Long,
    reqHeaders: Map<String, String>?,
    reqBody: String?,
  ): Response {
    val errorMsg = "simulated:${sim.errorType}"
    when (sim.errorType) {
      "http500" -> {
        observe {
          buffer.add(
            SdkNetworkRequestEvent(
              timestamp = startMs,
              applicationId = applicationId,
              url = request.url.toString(),
              method = request.method,
              statusCode = 500,
              durationMs = durationMs,
              requestBodySize = request.body?.contentLength() ?: -1,
              responseBodySize = 0,
              host = request.url.host,
              path = request.url.encodedPath,
              error = errorMsg,
              requestHeaders = reqHeaders,
              requestBody = reqBody,
            ),
          )
        }
        return Response.Builder()
          .request(request)
          .protocol(Protocol.HTTP_1_1)
          .code(500)
          .message("Simulated Error (AutoMobile)")
          .body("".toResponseBody("text/plain".toMediaType()))
          .build()
      }
      else -> {
        observe {
          buffer.add(
            SdkNetworkRequestEvent(
              timestamp = startMs,
              applicationId = applicationId,
              url = request.url.toString(),
              method = request.method,
              statusCode = 0,
              durationMs = durationMs,
              requestBodySize = request.body?.contentLength() ?: -1,
              responseBodySize = -1,
              host = request.url.host,
              path = request.url.encodedPath,
              error = errorMsg,
              requestHeaders = reqHeaders,
              requestBody = reqBody,
            ),
          )
        }
        throw when (sim.errorType) {
          "timeout" -> SocketTimeoutException("Simulated timeout (AutoMobile)")
          "connectionRefused" -> ConnectException("Simulated connection refused (AutoMobile)")
          "dnsFailure" -> UnknownHostException("Simulated DNS failure (AutoMobile)")
          "tlsFailure" -> SSLException("Simulated TLS failure (AutoMobile)")
          else -> ConnectException("Simulated error: ${sim.errorType} (AutoMobile)")
        }
      }
    }
  }

  private fun captureRequestBody(request: okhttp3.Request): String? {
    val body = request.body ?: return null
    if (!isTextContentType(body.contentType()?.toString())) return null
    return NetworkBodyCapture.captureRequestBody(body, maxBodyBytes)
  }

  private fun observe(block: () -> Unit) {
    try {
      block()
    } catch (error: Exception) {
      logObservationFailure(error)
    }
  }

  private fun <T> observeOrNull(block: () -> T): T? =
    try {
      block()
    } catch (error: Exception) {
      logObservationFailure(error)
      null
    }

  private fun logObservationFailure(error: Exception) {
    // Custom loggers are user supplied, so logging must not break host transport behavior either.
    runCatching {
      AutoMobileSDK.logger.w(TAG, error) { "Network observation failed; continuing host transport" }
    }
  }

  /**
   * Flatten headers into a map, joining repeated names with ", " in encounter order.
   *
   * Deliberately hand-rolled rather than delegating to okhttp's `Headers.toMultimap()`: that
   * lowercases every name, which would silently change the header casing we report as telemetry.
   * Named `toHeaderMap` rather than `toMap` because okhttp's `Headers` is an `Iterable<Pair<..>>`,
   * so a `toMap` extension here shadows the stdlib one -- and the stdlib version takes last-wins on
   * duplicate names instead of joining them.
   *
   * Single-pass on purpose: this runs up to three times per intercepted request, and the common
   * single-valued header must not allocate an intermediate list or copy its value string.
   */
  private fun okhttp3.Headers.toHeaderMap(): Map<String, String> {
    // Deliberately not buildMap: its MutableMap receiver shadows `size`, so `0 until size`
    // would read the map being built (0) rather than the header count and silently produce
    // an empty map.
    val merged = LinkedHashMap<String, String>(size)
    for (i in 0 until size) {
      merged.merge(name(i), value(i)) { existing, next -> "$existing, $next" }
    }
    return merged
  }
}
