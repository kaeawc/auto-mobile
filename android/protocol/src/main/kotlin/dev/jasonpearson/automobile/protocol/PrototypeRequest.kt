package dev.jasonpearson.automobile.protocol

import java.net.URLDecoder
import java.net.URLEncoder
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * The device-side rules of the `request` action (`prototype_network_v1`, #12523): the Kotlin twin
 * of `prototypeRequest.ts`, `prototypeRequestOutcome.ts` and `prototypeRequestEvent.ts`. Pure JVM,
 * so the runtime, both transports and the tests share one definition of the contract.
 */
object PrototypeRequests {
  const val DEFAULT_METHOD = "GET"

  /**
   * Appended to the last segment of `into`: `/data/feed` reports its metadata at
   * `/data/feed__meta`.
   */
  const val META_SUFFIX = "__meta"

  /**
   * The emit-kind event name a finished request is reported under; authored emits cannot use it.
   */
  const val EVENT_NAME = "prototype_request"

  /** The values `statusKey` moves through. */
  const val STATUS_LOADING = "loading"
  const val STATUS_SUCCESS = "success"
  const val STATUS_ERROR = "error"

  val METHODS: List<String> = listOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD")
  val BODYLESS_METHODS: Set<String> = setOf("GET", "HEAD")
  const val EVENT_URL_MAX = 2048
  const val EVENT_MESSAGE_MAX = 512

  /**
   * [value] with every object's keys in sorted order (UTF-16 code units, `String.compareTo`),
   * recursively, so a request body serializes the same bytes on every runtime. Arrays keep theirs.
   */
  fun sortedKeys(value: JsonElement): JsonElement =
    when (value) {
      is JsonObject ->
        JsonObject(value.toSortedMap().mapValuesTo(LinkedHashMap()) { sortedKeys(it.value) })
      is JsonArray -> JsonArray(value.map(::sortedKeys))
      else -> value
    }

  /**
   * A JSON number as text for a header or query value, by JavaScript's `Number.prototype.toString`
   * rules so every runtime sends the same bytes: the shortest digits that round-trip, plain
   * notation for exponents from -7 up to 20 and `1e+21` / `1.5e-7` outside it, no `.0` on integers
   * and `-0` as `0`. A non-finite number (not valid JSON) keeps its own spelling.
   */
  fun numberText(value: Double): String {
    if (value == 0.0) return "0"
    if (!value.isFinite()) return value.toString()
    val sign = if (value < 0) "-" else ""
    val exact = java.math.BigDecimal(Math.abs(value))
    var digits = ""
    var scale = 0
    for (precision in 1..17) {
      val rounded = exact.round(java.math.MathContext(precision))
      if (rounded.toDouble() == Math.abs(value)) {
        digits = rounded.unscaledValue().toString().trimEnd('0').ifEmpty { "0" }
        // value = 0.<digits> * 10^scale
        scale = rounded.precision() - rounded.scale()
        break
      }
    }
    val count = digits.length
    val text =
      when {
        scale in count..21 -> digits + "0".repeat(scale - count)
        scale in 1..21 -> digits.substring(0, scale) + "." + digits.substring(scale)
        scale in -5..0 -> "0." + "0".repeat(-scale) + digits
        else -> {
          val exponent = scale - 1
          val mantissa = if (count == 1) digits else digits[0] + "." + digits.substring(1)
          mantissa + "e" + (if (exponent < 0) "-" else "+") + Math.abs(exponent)
        }
      }
    return sign + text
  }

  /** The `<into>__meta` pointer: the same path with `__meta` appended to its last segment. */
  fun metaPath(into: String): String = into + META_SUFFIX

  /**
   * `JSON.parse` semantics for a response body: valid JSON as is, else null (the caller keeps the
   * raw text as a string). kotlinx keeps an unquoted word such as `OK` as a literal instead of
   * refusing it, so every non-string primitive must also be a JSON `true`, `false`, `null` or
   * number.
   */
  fun parseJson(text: String): JsonElement? =
    try {
      Json.parseToJsonElement(text).takeIf {
        PrototypeSpecValidator.validNumberTokens(it) && lowerCaseKeywords(it)
      }
    } catch (_: SerializationException) {
      // Not JSON is a supported shape: the response carries the raw string.
      null
    }

  /** kotlinx reads `True` as a boolean; JSON only has `true` and `false`. */
  private fun lowerCaseKeywords(element: JsonElement): Boolean =
    when (element) {
      is JsonObject -> element.values.all(::lowerCaseKeywords)
      is JsonArray -> element.all(::lowerCaseKeywords)
      JsonNull -> true
      is JsonPrimitive ->
        element.isString ||
          !(element.content.equals("true", ignoreCase = true) ||
            element.content.equals("false", ignoreCase = true)) ||
          element.content == "true" ||
          element.content == "false"
    }

  /** `{data:/pointer}` placeholders in [text] read from [data], as in any text field. */
  fun bindDataText(text: String, data: JsonObject?): String = PrototypeDataText.bind(text, data)
}

/** The transport codes of the host executor (`prototypeRequestProtocol.ts`) plus two of ours. */
enum class PrototypeRequestErrorCode(val wireValue: String) {
  TIMEOUT("timeout"),
  TOO_LARGE("too_large"),
  CONNECTION_REFUSED("connection_refused"),
  CANCELLED("cancelled"),
  INVALID_URL("invalid_url"),
  INVALID_REQUEST("invalid_request"),
  NETWORK("network"),
  BLOCKED_DESTINATION("blocked_destination"),
  TOO_MANY_IN_FLIGHT("too_many_in_flight"),

  /** A response with a non-2xx status. */
  HTTP_ERROR("http_error"),

  /** A 2xx body that `/data` cannot hold. */
  INVALID_RESPONSE("invalid_response");

  companion object {
    fun fromWire(value: String): PrototypeRequestErrorCode? = entries.firstOrNull {
      it.wireValue == value
    }
  }
}

data class PrototypeRequestError(val code: PrototypeRequestErrorCode, val message: String)

/** What a transport hands back: an HTTP response of any status, or a typed transport failure. */
sealed interface PrototypeRequestResponse {
  val durationMs: Long

  /** [body] is parsed JSON, the raw string for a non-JSON body, and null for an empty body. */
  data class Received(
    val status: Int,
    val headers: Map<String, String>,
    val body: JsonElement?,
    override val durationMs: Long,
  ) : PrototypeRequestResponse {
    val isSuccessful: Boolean
      get() = status in 200..299
  }

  data class Failed(val error: PrototypeRequestError, override val durationMs: Long = 0L) :
    PrototypeRequestResponse
}

/** A `request` with every binding resolved: what a transport actually sends. */
data class PrototypeResolvedRequest(
  val method: String,
  val url: String,
  val headers: Map<String, String>,
  val body: JsonElement?,
)

sealed interface PrototypeResolvedRequestResult {
  data class Success(val request: PrototypeResolvedRequest) : PrototypeResolvedRequestResult

  data class Failure(val error: PrototypeRequestError) : PrototypeResolvedRequestResult
}

/**
 * Resolves a [PrototypeRequestAction]'s bindings against the committed state and data (the twin of
 * `resolvePrototypeRequest`). The caller has already bound the text placeholders of `url` and of
 * literal header and query strings, and a repeat's `{item}` and `{index}` bindings, which are
 * `{value}` by now. Each `query` entry is set on the URL in authored order, so a query key already
 * in `url` is replaced. A binding whose source is missing or is not a scalar (header, query) fails
 * the request as `invalid_request`.
 */
object PrototypeRequestResolver {
  fun resolve(
    action: PrototypeRequestAction,
    url: String,
    inputs: EmitContextInputs,
  ): PrototypeResolvedRequestResult {
    val target =
      when (val parsed = parseHttpUrl(url)) {
        is Parsed.Failure -> return PrototypeResolvedRequestResult.Failure(parsed.error)
        is Parsed.Url -> parsed
      }
    val headers = linkedMapOf<String, String>()
    val headerNames = HashSet<String>()
    val query = target.segments.toMutableList()
    // Query entries are set in sorted key order (UTF-16 code units), whatever order they were
    // authored in, so every platform builds the same URL.
    val authored = listOf("headers" to action.headers, "query" to action.query?.toSortedMap())
    for ((field, entries) in authored) {
      for ((name, raw) in entries.orEmpty()) {
        val text =
          entryText(raw, "$field.$name", inputs)
            ?: return invalidRequest(
              bindingFailure(raw, "$field.$name", inputs),
            )
        if (field == "headers") {
          if (!headerNames.add(name.lowercase())) {
            return invalidRequest("headers.$name duplicates another header name")
          }
          headers[name] = text
        } else setQuery(query, name, text)
      }
    }
    var body: JsonElement? = null
    action.body?.let { binding ->
      when (val resolved = PrototypeDataWriter.resolveValue(binding, inputs)) {
        is PrototypeDataValue.Resolved -> body = PrototypeRequests.sortedKeys(resolved.value)
        is PrototypeDataValue.Failure -> return invalidRequest("body: ${resolved.error.message}")
      }
    }
    val method = action.method ?: PrototypeRequests.DEFAULT_METHOD
    val resolved =
      PrototypeResolvedRequest(
        method = method,
        url = target.render(query.takeUnless { action.query.isNullOrEmpty() }),
        headers = headers,
        body = body,
      )
    return PrototypeResolvedRequestResult.Success(resolved)
  }

  private fun invalidRequest(message: String) =
    PrototypeResolvedRequestResult.Failure(
      PrototypeRequestError(PrototypeRequestErrorCode.INVALID_REQUEST, message),
    )

  /** The scalar text of one header or query entry, or null when it cannot be bound to one. */
  private fun entryText(raw: JsonElement, what: String, inputs: EmitContextInputs): String? {
    val value =
      if (raw is JsonObject) {
        (PrototypeDataWriter.resolveValue(raw, inputs) as? PrototypeDataValue.Resolved)?.value
      } else raw
    return scalarText(value)
  }

  private fun bindingFailure(raw: JsonElement, what: String, inputs: EmitContextInputs): String {
    val failure =
      (raw as? JsonObject)?.let { PrototypeDataWriter.resolveValue(it, inputs) }
        as? PrototypeDataValue.Failure
    return failure?.let { "$what: ${it.error.message}" }
      ?: "$what must resolve to a string, number or boolean"
  }

  private fun scalarText(value: JsonElement?): String? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive is JsonNull) return null
    if (primitive.isString) return primitive.content
    if (primitive.booleanOrNull != null) return primitive.content
    val number = primitive.doubleOrNull ?: return null
    return PrototypeRequests.numberText(number)
  }

  private sealed interface Parsed {
    data class Failure(val error: PrototypeRequestError) : Parsed

    data class Url(
      val scheme: String,
      val authority: String,
      val path: String,
      val rawQuery: String?,
      val fragment: String?,
    ) : Parsed {
      /** The query's `&`-separated pieces exactly as written. */
      val segments: List<String>
        get() = rawQuery?.split('&')?.filter { it.isNotEmpty() }.orEmpty()

      /**
       * Matches `URL.toString()`: lower-case scheme, a `/` path for none. With no authored query
       * ([pieces] null) the query keeps the spelling it was written in (`?flag`, `%20`); setting an
       * entry changes only that key's pieces and leaves every other piece as written.
       */
      fun render(pieces: List<String>?): String = buildString {
        append(scheme).append("://").append(authority).append(path.ifEmpty { "/" })
        if (pieces == null) {
          rawQuery?.let { append('?').append(it) }
        } else if (pieces.isNotEmpty()) {
          append('?').append(pieces.joinToString("&"))
        }
        fragment?.let { append('#').append(it) }
      }
    }
  }

  private fun parseHttpUrl(url: String): Parsed =
    when (val parsed = PrototypeUrl.parse(url)) {
      is PrototypeUrl.Result.Rejected ->
        Parsed.Failure(PrototypeRequestError(PrototypeRequestErrorCode.INVALID_URL, parsed.message))
      is PrototypeUrl.Result.Absolute ->
        Parsed.Url(
          scheme = parsed.scheme,
          authority = parsed.authority,
          path = parsed.path,
          rawQuery = parsed.query,
          fragment = parsed.fragment,
        )
    }

  private fun decode(text: String): String =
    try {
      URLDecoder.decode(text, Charsets.UTF_8)
    } catch (_: IllegalArgumentException) {
      // A malformed escape stays literal, as in the URL standard's query parser.
      text
    }

  /**
   * `URLSearchParams.set` on raw pieces: the first piece of that name is replaced, later ones
   * dropped, else a new piece is appended. Pieces of other names are not re-encoded.
   */
  private fun setQuery(pieces: MutableList<String>, name: String, value: String) {
    val encoded =
      URLEncoder.encode(name, Charsets.UTF_8) + "=" + URLEncoder.encode(value, Charsets.UTF_8)
    val named = { piece: String -> decode(piece.substringBefore('=')) == name }
    val first = pieces.indexOfFirst(named)
    if (first < 0) {
      pieces.add(encoded)
      return
    }
    pieces[first] = encoded
    var at = pieces.size - 1
    while (at > first) {
      if (named(pieces[at])) pieces.removeAt(at)
      at--
    }
  }
}

/** What a request's metadata holds once a response (or a failure) is in. */
data class PrototypeRequestMeta(
  val status: Int?,
  val headers: Map<String, String>?,
  val durationMs: Long,
  val error: PrototypeRequestError?,
) {
  /** The value written at `<into>__meta`; [withHeaders] false drops the headers. */
  fun toJson(withHeaders: Boolean = true): JsonObject = buildJsonObject {
    status?.let { put("status", it) }
    if (withHeaders && headers != null) {
      put("headers", JsonObject(headers.mapValues { JsonPrimitive(it.value) }))
    }
    put("durationMs", durationMs)
    error?.let { failure ->
      put(
        "error",
        buildJsonObject {
          put("code", failure.code.wireValue)
          put("message", failure.message)
        },
      )
    }
  }
}

data class PrototypeRequestResult(
  /** True when `statusKey` becomes `success` and `onSuccess` runs. */
  val succeeded: Boolean,
  val meta: PrototypeRequestMeta,
  val wroteInto: Boolean,
)

data class PrototypeRequestApplied(val data: JsonObject?, val result: PrototypeRequestResult)

/**
 * What a `request` does with its response (the twin of `applyPrototypeRequestOutcome`):
 * - 2xx: the body is written to `into` with the `setData` semantics (parsed JSON as is, anything
 *   else as a string, an empty body as `""`), then the metadata to `<into>__meta`; the status key
 *   becomes `success` and `onSuccess` runs.
 * - any other status, a transport failure, or a body `/data` cannot hold: `into` is left untouched,
 *   the metadata (with `error`) is still written, the status key becomes `error` and `onError`
 *   runs.
 */
object PrototypeRequestOutcome {
  fun metaOf(response: PrototypeRequestResponse): PrototypeRequestMeta =
    when (response) {
      is PrototypeRequestResponse.Failed ->
        PrototypeRequestMeta(null, null, response.durationMs, response.error)
      is PrototypeRequestResponse.Received ->
        PrototypeRequestMeta(
          status = response.status,
          headers = response.headers,
          durationMs = response.durationMs,
          error =
            if (response.isSuccessful) null
            else
              PrototypeRequestError(
                PrototypeRequestErrorCode.HTTP_ERROR,
                "HTTP ${response.status}",
              ),
        )
    }

  /** The `into` value of a 2xx response: JSON as is, an empty body (and HEAD) as `""`. */
  fun intoValue(response: PrototypeRequestResponse.Received): JsonElement =
    response.body ?: JsonPrimitive("")

  /**
   * Applies one response through [commit], which performs one `/data` write and returns why it was
   * refused, or null once it took effect. `into` is the authored `/data/<pointer>` with repeat
   * `{index}` already bound; without it nothing is written to data but the status and follow-up
   * still follow the response. If the whole metadata does not fit the write limit, `headers` is
   * dropped before giving up.
   */
  inline fun complete(
    into: String?,
    response: PrototypeRequestResponse,
    /**
     * Whether [writes], applied in order from the current data, would all be accepted; the first
     * refusal is returned. Nothing is applied or reported, so a response that ends up refused
     * leaves no trace of the writes tried for it.
     */
    trial: (List<PrototypeDataWrite>) -> PrototypeDataWriteError?,
    commit: (PrototypeDataWrite) -> PrototypeDataWriteError?,
  ): PrototypeRequestResult {
    var meta = metaOf(response)
    // Prefer complete metadata, with a header-free fallback only when headers were supplied.
    val metadataForms = listOfNotNull(true, false.takeIf { meta.headers != null })
    var wroteInto = false
    var form: Boolean? = null
    if (response is PrototypeRequestResponse.Received && response.body is JsonNull) {
      // A literal JSON `null` body is not an empty one: /data cannot hold it, so `into` stays.
      if (meta.error == null) {
        meta =
          meta.copy(
            error =
              PrototypeRequestError(
                PrototypeRequestErrorCode.INVALID_RESPONSE,
                "The response body is JSON null, which /data cannot hold.",
              ),
          )
      }
    } else if (
      response is PrototypeRequestResponse.Received && meta.error == null && into != null
    ) {
      val body = PrototypeDataWrite.Set(into, intoValue(response))
      val metaPath = PrototypeRequests.metaPath(into)
      val refused = trial(listOf(body))
      if (refused != null) {
        meta =
          meta.copy(
            error =
              PrototypeRequestError(PrototypeRequestErrorCode.INVALID_RESPONSE, refused.message),
          )
      } else {
        // The body and the first form of metadata that fits beside it are staged together; only
        // an accepted pair is applied (and reported), never a body whose metadata is refused.
        val forms = metadataForms
        form = forms.firstOrNull {
          trial(listOf(body, PrototypeDataWrite.Set(metaPath, meta.toJson(it)))) == null
        }
        if (form != null && commit(body) == null) {
          wroteInto = true
        } else {
          form = null
          meta =
            meta.copy(
              error =
                PrototypeRequestError(
                  PrototypeRequestErrorCode.INVALID_RESPONSE,
                  METADATA_DOES_NOT_FIT,
                ),
            )
        }
      }
    }
    if (into != null) {
      val path = PrototypeRequests.metaPath(into)
      val attempts = listOfNotNull(form).ifEmpty { metadataForms }
      for (withHeaders in attempts) {
        if (commit(PrototypeDataWrite.Set(path, meta.toJson(withHeaders))) == null) break
      }
    }
    return PrototypeRequestResult(meta.error == null, meta, wroteInto)
  }

  const val METADATA_DOES_NOT_FIT = "response and metadata exceed the data limit"

  /** [trial] over a plain data object: the pure data limits, with nothing applied. */
  fun dataTrial(data: JsonObject?, writes: List<PrototypeDataWrite>): PrototypeDataWriteError? {
    var current = data
    for (write in writes) {
      when (val written = PrototypeDataWriter.apply(current, write)) {
        is PrototypeDataWriteResult.Success -> current = written.data
        is PrototypeDataWriteResult.Failure -> return written.error
      }
    }
    return null
  }

  /** Pure form over a data object, for tests and for hosts mirroring the device. */
  fun apply(
    data: JsonObject?,
    into: String?,
    response: PrototypeRequestResponse,
  ): PrototypeRequestApplied {
    var current = data
    val result =
      complete(into, response, { writes -> dataTrial(current, writes) }) { write ->
        when (val written = PrototypeDataWriter.apply(current, write)) {
          is PrototypeDataWriteResult.Success -> {
            current = written.data
            null
          }
          is PrototypeDataWriteResult.Failure -> written.error
        }
      }
    return PrototypeRequestApplied(current, result)
  }
}

/** The `emit` event a finished request is reported as (`prototypeRequestEvent.ts`). */
object PrototypeRequestEvent {
  /**
   * `error` is present exactly when [outcome] is `error`, including a non-2xx status. [url] is cut
   * to 2048 characters and the message to 512.
   */
  fun payload(
    requestId: String,
    method: String,
    url: String,
    via: String,
    into: String?,
    status: Int?,
    durationMs: Long,
    error: PrototypeRequestError?,
  ): JsonObject = buildJsonObject {
    put("requestId", requestId)
    put("method", method)
    put("url", url.take(PrototypeRequests.EVENT_URL_MAX))
    put("via", via)
    into?.let { put("into", it) }
    put(
      "outcome",
      if (error == null) PrototypeRequests.STATUS_SUCCESS else PrototypeRequests.STATUS_ERROR,
    )
    status?.let { put("status", it) }
    put("durationMs", durationMs)
    error?.let { failure ->
      put(
        "error",
        buildJsonObject {
          put("code", failure.code.wireValue)
          put("message", failure.message.take(PrototypeRequests.EVENT_MESSAGE_MAX))
        },
      )
    }
  }
}

/**
 * The absolute `http(s)` URL check shared by static validation and the resolver. A scan rather than
 * `java.net.URI`: the host (the URL standard) percent-encodes a space or brace where `URI` refuses
 * it, and a spec the host accepts must not be refused here.
 */
internal object PrototypeUrl {
  sealed interface Result {
    data class Rejected(val message: String) : Result

    data class Absolute(
      val scheme: String,
      val authority: String,
      val path: String,
      val query: String?,
      val fragment: String?,
    ) : Result
  }

  fun parse(input: String): Result {
    val url = input.trim { it.code <= 32 }.filterNot { it in "\t\r\n" }.replace('\\', '/')
    val colon = schemeEnd(url)
    if (colon < 0) return notAbsolute(url)
    val scheme = url.substring(0, colon).lowercase()
    if (scheme != "http" && scheme != "https") {
      return Result.Rejected("Only http and https URLs are supported, got $scheme:")
    }
    if (!url.startsWith("//", colon + 1)) return notAbsolute(url)
    val rest = url.substring(colon + 3)
    val fragmentAt = rest.indexOf('#')
    val beforeFragment = if (fragmentAt < 0) rest else rest.substring(0, fragmentAt)
    val queryAt = beforeFragment.indexOf('?')
    val beforeQuery = if (queryAt < 0) beforeFragment else beforeFragment.substring(0, queryAt)
    val pathAt = beforeQuery.indexOf('/')
    val authority = if (pathAt < 0) beforeQuery else beforeQuery.substring(0, pathAt)
    if (authority.isEmpty()) return notAbsolute(url)
    try {
      if (java.net.URI("$scheme://$authority").rawAuthority == null) return notAbsolute(url)
    } catch (_: java.net.URISyntaxException) {
      return notAbsolute(url)
    }
    return Result.Absolute(
      scheme = scheme,
      authority = authority,
      path = if (pathAt < 0) "" else beforeQuery.substring(pathAt),
      query = if (queryAt < 0) null else beforeFragment.substring(queryAt + 1),
      fragment = if (fragmentAt < 0) null else rest.substring(fragmentAt + 1),
    )
  }

  /** The index of the `:` ending a leading RFC 3986 scheme, or -1 when there is none. */
  private fun schemeEnd(url: String): Int {
    if (url.isEmpty() || !url[0].isAsciiLetter()) return -1
    var at = 1
    while (at < url.length && (url[at].isAsciiLetter() || url[at] in "0123456789+-.")) at++
    return if (at < url.length && url[at] == ':') at else -1
  }

  private fun Char.isAsciiLetter() = this in 'A'..'Z' || this in 'a'..'z'

  private fun notAbsolute(url: String) = Result.Rejected("Not an absolute URL: $url")
}
