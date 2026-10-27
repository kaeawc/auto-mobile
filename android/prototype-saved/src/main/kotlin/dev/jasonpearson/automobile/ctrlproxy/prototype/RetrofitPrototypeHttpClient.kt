package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.Proxy
import java.net.UnknownServiceException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HEAD
import retrofit2.http.HTTP
import retrofit2.http.HeaderMap
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Streaming
import retrofit2.http.Tag
import retrofit2.http.Url

/** The whole-call timeout of one request, carried as a request tag to the [Call.Factory]. */
internal class PrototypeCallTimeout(val millis: Long)

/**
 * One service for every prototype request: the URL, headers and body are all dynamic. Requests and
 * responses stay raw ([RequestBody], [ResponseBody]); the client parses JSON itself, so no
 * converter is installed. Responses are `@Streaming` so the size cap is enforced while reading, not
 * after Retrofit has buffered the whole body.
 */
internal interface PrototypeHttpService {
  @GET
  @Streaming
  suspend fun get(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<ResponseBody>

  @HEAD
  suspend fun head(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<Unit>

  @POST
  @Streaming
  suspend fun post(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Body body: RequestBody,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<ResponseBody>

  @PUT
  @Streaming
  suspend fun put(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Body body: RequestBody,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<ResponseBody>

  @PATCH
  @Streaming
  suspend fun patch(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Body body: RequestBody,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<ResponseBody>

  @DELETE
  @Streaming
  suspend fun delete(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<ResponseBody>

  /** `@DELETE` forbids a body; a DELETE that carries one goes through the generic annotation. */
  @HTTP(method = "DELETE", hasBody = true)
  @Streaming
  suspend fun deleteWithBody(
    @Url url: String,
    @HeaderMap headers: Map<String, String>,
    @Body body: RequestBody,
    @Tag timeout: PrototypeCallTimeout,
  ): Response<ResponseBody>
}

/**
 * Runs a prototype request from the device itself (`via: "device"`), to any absolute http or https
 * URL allowed by the egress policy. The caller supplies the transport configuration and DNS; the
 * client enforces destination checks and validates each redirect before following it.
 *
 * Mirrors the host executor (`PrototypeHttpExecutor.ts`): a non-string body is sent as JSON, with
 * `Content-Type: application/json` unless a header sets one; redirects are followed; the body is
 * parsed JSON, else the raw text, and empty for HEAD or no content; and a body over
 * [maxResponseBytes] is `too_large`.
 */
class RetrofitPrototypeHttpClient(
  client: OkHttpClient,
  private val maxResponseBytes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_RESPONSE_BYTES,
  private val clock: () -> Long = { System.nanoTime() / NANOS_PER_MILLI },
  /** Unexpected failures; a seam so JVM tests need no `android.util.Log`. */
  private val warn: (String, Throwable) -> Unit = { message, error -> Log.w(TAG, message, error) },
  /** Expected non-errors, such as a body that is not JSON. */
  private val debug: (String) -> Unit = { Log.d(TAG, it) },
  private val policy: PrototypeDestinationPolicy = PrototypeEgressPolicy(),
) : PrototypeHttpClient {
  private val service: PrototypeHttpService =
    Retrofit.Builder()
      .baseUrl(PLACEHOLDER_BASE_URL.toHttpUrl())
      .callFactory(
        TimeoutCallFactory(
          client
            .newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            // Direct connections keep the checked DNS address and the destination socket aligned.
            .proxy(Proxy.NO_PROXY)
            .connectionPool(ConnectionPool())
            .addNetworkInterceptor(PrototypeEgressInterceptor(policy))
            .build(),
          policy,
        ),
      )
      .build()
      .create(PrototypeHttpService::class.java)

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
    val started = clock()
    fun failed(code: PrototypeRequestErrorCode, message: String) =
      PrototypeRequestResponse.Failed(PrototypeRequestError(code, message), clock() - started)
    val url =
      request.url.toHttpUrlOrNull()
        ?: return failed(
          PrototypeRequestErrorCode.INVALID_URL,
          "Not an absolute URL: ${request.url}",
        )
    return try {
      followRedirects(request, url, started)
    } catch (error: CancellationException) {
      throw error
    } catch (error: PrototypeBlockedDestinationException) {
      failed(PrototypeRequestErrorCode.BLOCKED_DESTINATION, error.message)
    } catch (error: InterruptedIOException) {
      // The whole-call timeout expired; SocketTimeoutException is an InterruptedIOException too.
      warn("Prototype request timed out: ${request.url}", error)
      failed(
        PrototypeRequestErrorCode.TIMEOUT,
        "Request timed out after ${request.timeoutMs}ms." + localNetworkHint(url.host),
      )
    } catch (error: ConnectException) {
      failed(PrototypeRequestErrorCode.CONNECTION_REFUSED, "Connection refused: ${request.url}")
    } catch (error: UnknownServiceException) {
      // OkHttp refuses a cleartext http:// call the network security policy forbids, at once.
      warn("Prototype request refused by network policy: ${error.message}", error)
      failed(
        PrototypeRequestErrorCode.NETWORK,
        "Cleartext HTTP to ${url.host} is not permitted by the app's network security policy: " +
          (error.message ?: "refused"),
      )
    } catch (error: IOException) {
      warn("Prototype request failed: ${error.message}", error)
      failed(
        if (error.message == "Canceled") PrototypeRequestErrorCode.CANCELLED
        else PrototypeRequestErrorCode.NETWORK,
        error.message ?: error.javaClass.simpleName,
      )
    } catch (error: IllegalArgumentException) {
      // A header name or value, or a Content-Type, that OkHttp refuses to put on the wire.
      failed(PrototypeRequestErrorCode.INVALID_REQUEST, error.message ?: "Invalid request")
    }
  }

  private suspend fun followRedirects(
    initial: PrototypeHttpRequest,
    initialUrl: HttpUrl,
    started: Long,
  ): PrototypeRequestResponse {
    var request = initial
    var url = initialUrl
    for (hop in 0..MAX_REDIRECTS) {
      validate(request, url)
      url = PrototypeEgressPolicy.normalize(url)
      val response = call(request, url.toString())
      if (response.code() !in REDIRECT_CODES) return received(response, request.method, started)
      val location = response.headers()["Location"]
      (response.body() as? ResponseBody)?.close()
      response.errorBody()?.close()
      if (location == null) throw IOException("Redirect has no Location")
      if (hop == MAX_REDIRECTS) throw IOException("Too many redirects")
      val next =
        url.resolve(location)
          ?: return PrototypeRequestResponse.Failed(
            PrototypeRequestError(PrototypeRequestErrorCode.INVALID_URL, "Invalid redirect URL"),
            clock() - started,
          )
      if (url.isHttps && !next.isHttps) {
        throw PrototypeBlockedDestinationException("Blocked destination scheme downgrade")
      }
      val sameOrigin =
        Triple(url.scheme, url.host, url.port) == Triple(next.scheme, next.host, next.port)
      val toGet = redirectBecomesGet(response.code(), request.method)
      val remaining = initial.timeoutMs - (clock() - started)
      if (remaining <= 0) throw InterruptedIOException("Request timed out")
      request =
        request.copy(
          url = next.toString(),
          method = if (toGet) "GET" else request.method,
          body = if (toGet) null else request.body,
          headers =
            request.headers.filterKeys {
              (sameOrigin || !it.equals("Authorization", true)) &&
                !(toGet && it.lowercase() in ENTITY_HEADERS)
            },
          timeoutMs = remaining.coerceAtMost(initial.timeoutMs.toLong()).toInt(),
        )
      url = next
    }
    throw IOException("Too many redirects")
  }

  private fun validate(request: PrototypeHttpRequest, url: HttpUrl) {
    require(
      request.headers.keys.none { name ->
        name.lowercase() in FORBIDDEN_HEADERS ||
          name.startsWith("Proxy-", true) ||
          name.startsWith("X-Forwarded-", true)
      },
    ) {
      "Forbidden request header"
    }
    policy.check(url.host, url.port, emptyList()).requireAllowed()
  }

  /**
   * On API 37 a connection to a local-network address is dropped, so it times out, unless CtrlProxy
   * holds `ACCESS_LOCAL_NETWORK` (#13018). Only private or emulator-alias hosts get the hint.
   */
  private fun localNetworkHint(host: String): String =
    if (isLocalNetworkHost(host)) {
      " $host is a local-network address: on Android 17+ grant CtrlProxy " +
        "android.permission.ACCESS_LOCAL_NETWORK (adb shell pm grant " +
        "dev.jasonpearson.automobile.ctrlproxy android.permission.ACCESS_LOCAL_NETWORK)."
    } else ""

  /** The raw call; an HTTP error status is a [Response], not an exception. */
  private suspend fun call(request: PrototypeHttpRequest, url: String): Response<*> {
    val timeout = PrototypeCallTimeout(request.timeoutMs.toLong())
    val headers = request.headers
    val body by lazy { requestBody(request.body) }
    return when (request.method) {
      "GET" -> service.get(url, headers, timeout)
      "HEAD" -> service.head(url, headers, timeout)
      "POST" -> service.post(url, headers, body, timeout)
      "PUT" -> service.put(url, headers, body, timeout)
      "PATCH" -> service.patch(url, headers, body, timeout)
      "DELETE" ->
        if (request.body == null) service.delete(url, headers, timeout)
        else service.deleteWithBody(url, headers, body, timeout)
      else -> throw IllegalArgumentException("Unsupported method ${request.method}")
    }
  }

  private fun requestBody(body: JsonElement?): RequestBody =
    when {
      body == null -> EMPTY_BODY
      body is JsonPrimitive && body.isString -> body.content.toRequestBody(TEXT)
      else ->
        JSON_CODEC.encodeToString(JsonElement.serializer(), PrototypeRequests.sortedKeys(body))
          .toRequestBody(JSON)
    }

  private fun received(
    response: Response<*>,
    method: String,
    started: Long,
  ): PrototypeRequestResponse {
    val headers = flatten(response.headers())
    val raw = response.body() as? ResponseBody
    return try {
      val body =
        if (method == "HEAD" || !response.isSuccessful || raw == null) null
        else
          when (val read = readBody(raw)) {
            BodyRead.TooLarge -> return tooLarge(started)
            is BodyRead.Content -> read.json
          }
      PrototypeRequestResponse.Received(response.code(), headers, body, clock() - started)
    } finally {
      raw?.close()
      response.errorBody()?.close()
    }
  }

  private fun tooLarge(started: Long) =
    PrototypeRequestResponse.Failed(
      PrototypeRequestError(
        PrototypeRequestErrorCode.TOO_LARGE,
        "Response body exceeds $maxResponseBytes bytes.",
      ),
      clock() - started,
    )

  private sealed interface BodyRead {
    data object TooLarge : BodyRead

    /** [json] is null for an empty body. */
    data class Content(val json: JsonElement?) : BodyRead
  }

  /**
   * The parsed body, or [BodyRead.TooLarge] once it crosses the cap. A declared length over the cap
   * is refused without reading; otherwise at most one byte past the cap is pulled from the socket.
   */
  private fun readBody(body: ResponseBody): BodyRead {
    if (body.contentLength() > maxResponseBytes) return BodyRead.TooLarge
    val source = body.source()
    source.request(maxResponseBytes.toLong() + 1)
    if (source.buffer.size > maxResponseBytes) return BodyRead.TooLarge
    // Always UTF-8, whatever the declared charset: the host and iOS decode the same way.
    val text = source.readString(Charsets.UTF_8)
    return BodyRead.Content(if (text.isEmpty()) null else parse(text))
  }

  private fun parse(text: String): JsonElement =
    PrototypeRequests.parseJson(text)
      ?: JsonPrimitive(text).also {
        // Not JSON is a supported shape: the response carries the raw string.
        debug("Response body is not JSON (${text.length} chars)")
      }

  /** Header names lower-cased, repeated headers joined as HTTP does. */
  private fun flatten(headers: Headers): Map<String, String> =
    headers.toMultimap().mapValues { (_, values) -> values.joinToString(", ") }

  /** Applies the request's whole-call timeout to the call OkHttp creates for it. */
  private class TimeoutCallFactory(
    private val delegate: OkHttpClient,
    private val policy: PrototypeDestinationPolicy,
  ) : Call.Factory {
    // OkHttp compares DNS identity when matching pooled connections. Keep it stable per port
    // so same-origin calls can reuse a connection; another host still requires DNS validation.
    private val dnsByPort = ConcurrentHashMap<Int, PrototypePolicyDns>()

    override fun newCall(request: Request): Call {
      val timeoutMs = request.tag(PrototypeCallTimeout::class.java)?.millis
      return delegate
        .newBuilder()
        .dns(
          dnsByPort.computeIfAbsent(request.url.port) {
            PrototypePolicyDns(delegate.dns, policy, it)
          },
        )
        .apply {
          if (timeoutMs != null) {
            // The request's timeoutMs is the whole call. The delegate's own connect, read and write
            // timeouts (OkHttp's default is 10 s each) must not end a slower call earlier (#13455).
            callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          }
        }
        .build()
        .newCall(request)
    }
  }

  internal companion object {
    /** Literal private-range IPv4 hosts, `localhost` and `*.local`; no DNS lookup is made. */
    fun isLocalNetworkHost(host: String): Boolean {
      if (host == "localhost" || host.endsWith(".local")) return true
      val octets = host.split('.').map { it.toIntOrNull() ?: return false }
      if (octets.size != 4 || octets.any { it !in 0..255 }) return false
      val (a, b) = octets
      return a == 10 ||
        a == 127 ||
        (a == 192 && b == 168) ||
        (a == 172 && b in 16..31) ||
        (a == 169 && b == 254)
    }

    private const val MAX_REDIRECTS = 5
    private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
    private val ENTITY_HEADERS =
      setOf(
        "content-type",
        "content-length",
        "content-encoding",
        "content-language",
        "content-location",
      )

    /**
     * Fetch's redirect rule, matching the host executor: POST becomes GET on 301/302, any method
     * but HEAD becomes GET on 303, and 307/308 keep the method and body.
     */
    internal fun redirectBecomesGet(status: Int, method: String): Boolean =
      (status == 303 && method != "HEAD") || ((status == 301 || status == 302) && method == "POST")

    private val FORBIDDEN_HEADERS =
      setOf(
        "host",
        "connection",
        "upgrade",
        "transfer-encoding",
        "content-length",
        "te",
        "trailer",
        "keep-alive",
        "cookie",
        "origin",
        "expect",
        "via",
        "forwarded",
        "accept-encoding",
      )
    const val TAG = "RetrofitPrototypeHttp"
    const val NANOS_PER_MILLI = 1_000_000L

    /** Retrofit insists on a base URL; every request overrides it with an absolute `@Url`. */
    const val PLACEHOLDER_BASE_URL = "http://localhost/"
    val JSON_CODEC = Json
    val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)
    val TEXT: MediaType = "text/plain; charset=utf-8".toMediaType()
    val JSON: MediaType = "application/json; charset=utf-8".toMediaType()
  }
}
