package dev.jasonpearson.automobile.protocol

import kotlin.math.roundToLong
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Wire frames of host-proxied prototype requests (`request` with `via: "host"`, #12527 on the
 * host, #12528 here), the twin of `prototypeRequestProtocol.ts`. The device sends
 * [PrototypeRequestFrame] with every binding already resolved and the query merged into the URL;
 * the host answers with one [PrototypeResponseFrame] carrying the same `requestId`.
 *
 * They are deliberately not `WebSocketRequest` / `WebSocketResponse` subclasses: the host handles
 * them outside its Kotlin-mirrored wire manifest (`ctrlProxyWireManifest.ts`), so listing them
 * there would add a manifest entry the host does not read. [PrototypeNetworkFrames.json] is the
 * codec for both.
 */
object PrototypeNetworkFrames {
  const val REQUEST_TYPE = "prototype_request"
  const val RESPONSE_TYPE = "prototype_response"
  const val CANCEL_TYPE = "prototype_request_cancel"

  /** The host serializes its reply with `type` first, which lets the device route it cheaply. */
  const val RESPONSE_PREFIX = "{\"type\":\"$RESPONSE_TYPE\""

  val json: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
  }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PrototypeRequestFrame(
  @EncodeDefault val type: String = PrototypeNetworkFrames.REQUEST_TYPE,
  val requestId: String,
  /** The prototype that issued the request; dismissing it cancels the request. */
  val prototypeId: String,
  val method: String,
  val url: String,
  val headers: Map<String, String>? = null,
  val body: JsonElement? = null,
  /** Clamped to the maximum by the host; absent means the default. */
  val timeoutMs: Int? = null,
)

/**
 * Device to host: the request is no longer wanted (superseded, dismissed, reset or abandoned), so
 * the host may stop it. The host sends no reply, and a late `prototype_response` is ignored.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PrototypeRequestCancelFrame(
  @EncodeDefault val type: String = PrototypeNetworkFrames.CANCEL_TYPE,
  val requestId: String,
)

@Serializable data class PrototypeResponseFrameError(val code: String, val message: String)

@Serializable
data class PrototypeResponseFrame(
  val type: String = PrototypeNetworkFrames.RESPONSE_TYPE,
  val requestId: String,
  val ok: Boolean,
  val status: Int? = null,
  val headers: Map<String, String>? = null,
  /** Parsed JSON, or the raw string when the body is not JSON. Null for an empty body. */
  val body: JsonElement? = null,
  val error: PrototypeResponseFrameError? = null,
  val durationMs: Double = 0.0,
) {
  /**
   * The response a runtime applies; a frame that is neither a response nor an error is `network`.
   */
  fun toResponse(): PrototypeRequestResponse {
    val duration = durationMs.roundToLong().coerceAtLeast(0L)
    if (ok && status != null) {
      return PrototypeRequestResponse.Received(status, headers.orEmpty(), body, duration)
    }
    val code = error?.code?.let(PrototypeRequestErrorCode::fromWire)
    return PrototypeRequestResponse.Failed(
      PrototypeRequestError(
        code ?: PrototypeRequestErrorCode.NETWORK,
        error?.message ?: "The host sent a prototype_response with no status and no error.",
      ),
      duration,
    )
  }
}
