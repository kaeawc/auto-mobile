package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeChannelBackoff
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** A realtime channel's wire kind (#14269). */
@InternalAutoMobilePrototypeApi
enum class PrototypeChannelKind(val wireValue: String) {
  WEBSOCKET("websocket"),
  SSE("sse");

  companion object {
    fun fromWire(value: String?): PrototypeChannelKind? = entries.firstOrNull {
      it.wireValue == value
    }
  }
}

/**
 * Why a channel connection ended or a send was refused: a request error code (`network`,
 * `blocked_destination`, `too_large`, ...) or `handshake_failed` with the HTTP [status].
 */
@InternalAutoMobilePrototypeApi
data class PrototypeChannelError(val code: String, val message: String, val status: Int? = null) {
  fun toJson(): JsonObject = buildJsonObject {
    put("code", code)
    put("message", message)
    status?.let { put("status", it) }
  }

  companion object {
    const val NETWORK = "network"
    const val TOO_LARGE = "too_large"
    const val INVALID_REQUEST = "invalid_request"
    const val TOO_MANY_IN_FLIGHT = "too_many_in_flight"
    const val HANDSHAKE_FAILED = "handshake_failed"
    const val BLOCKED_DESTINATION = "blocked_destination"
  }
}

/** One connection attempt, with every binding in [url] and [headers] already resolved. */
@InternalAutoMobilePrototypeApi
data class PrototypeChannelOpenRequest(
  val connectionId: String,
  val prototypeId: String,
  val channel: String,
  val kind: PrototypeChannelKind,
  val url: String,
  val protocols: List<String> = emptyList(),
  val headers: Map<String, String> = emptyMap(),
  /** SSE only: sent as `Last-Event-ID` on a reconnect. */
  val lastEventId: String? = null,
)

/**
 * What a transport reports for one connection. Calls may arrive on any thread; after [onClosed] a
 * transport reports nothing more for that connection.
 */
@InternalAutoMobilePrototypeApi
interface PrototypeChannelListener {
  fun onOpen(protocol: String?)

  /** One text frame or SSE event; [event] and [id] are the SSE event name and id. */
  fun onFrame(data: String, event: String?, id: String?)

  fun onClosed(code: Int?, reason: String?, error: PrototypeChannelError?)
}

/** A live connection; [close] is idempotent and reports no [PrototypeChannelListener.onClosed]. */
@InternalAutoMobilePrototypeApi
interface PrototypeChannelConnection {
  /** Queues one text frame; false when the connection can no longer take it. */
  fun send(data: String): Boolean

  fun close(code: Int, reason: String)
}

/** Opens channel connections: the device's own OkHttp client, or the host relay. */
@InternalAutoMobilePrototypeApi
fun interface PrototypeChannelTransport {
  fun open(
    request: PrototypeChannelOpenRequest,
    listener: PrototypeChannelListener,
  ): PrototypeChannelConnection
}

/** The transport behind each `via` value; host is the default. */
@InternalAutoMobilePrototypeApi
class PrototypeChannelTransports(
  val host: PrototypeChannelTransport,
  val device: PrototypeChannelTransport,
) {
  fun forVia(via: String): PrototypeChannelTransport =
    if (via == PrototypeHttpClients.VIA_DEVICE) device else host

  companion object {
    /** A transport that fails every connection at once with [error]. */
    fun failing(error: PrototypeChannelError): PrototypeChannelTransport =
      PrototypeChannelTransport { _, listener ->
        listener.onClosed(null, null, error)
        ClosedConnection
      }

    private object ClosedConnection : PrototypeChannelConnection {
      override fun send(data: String) = false

      override fun close(code: Int, reason: String) = Unit
    }
  }
}

/** One validated `channels` entry, as the controller needs it. */
@InternalAutoMobilePrototypeApi
data class PrototypeChannelDeclaration(
  val kind: PrototypeChannelKind,
  val url: String,
  val protocols: List<String> = emptyList(),
  val headers: Map<String, String> = emptyMap(),
  val via: String = PrototypeHttpClients.VIA_HOST,
  val connectOnShow: Boolean = true,
  val decodeJson: Boolean = true,
  val statusKey: String? = null,
  val maxAttempts: Int? = null,
  val initialDelayMs: Int? = null,
  val maxDelayMs: Int? = null,
  val routes: JsonArray? = null,
  val onOpen: JsonArray? = null,
  val onClose: JsonArray? = null,
  val onError: JsonArray? = null,
) {
  fun backoffMs(attempt: Int, random: () -> Double): Int? =
    PrototypeChannelBackoff.delayMs(attempt, maxAttempts, initialDelayMs, maxDelayMs, random)

  companion object {
    /** Reads a declaration the spec validator already accepted; null for an unknown kind. */
    fun parse(channel: JsonObject): PrototypeChannelDeclaration? {
      fun text(key: String) = (channel[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
      val reconnect = channel["reconnect"] as? JsonObject
      fun reconnectInt(key: String) = (reconnect?.get(key) as? JsonPrimitive)?.intOrNull
      return PrototypeChannelDeclaration(
        kind = PrototypeChannelKind.fromWire(text("kind")) ?: return null,
        url = text("url") ?: return null,
        protocols =
          (channel["protocols"] as? JsonArray).orEmpty().mapNotNull {
            (it as? JsonPrimitive)?.content
          },
        headers =
          (channel["headers"] as? JsonObject).orEmpty().mapValues {
            (it.value as? JsonPrimitive)?.content.orEmpty()
          },
        via = text("via") ?: PrototypeHttpClients.VIA_HOST,
        connectOnShow = text("connect") != "manual",
        decodeJson = text("decode") != "text",
        statusKey = text("statusKey"),
        maxAttempts = reconnectInt("maxAttempts"),
        initialDelayMs = reconnectInt("initialDelayMs"),
        maxDelayMs = reconnectInt("maxDelayMs"),
        routes = channel["routes"] as? JsonArray,
        onOpen = channel["onOpen"] as? JsonArray,
        onClose = channel["onClose"] as? JsonArray,
        onError = channel["onError"] as? JsonArray,
      )
    }
  }
}
