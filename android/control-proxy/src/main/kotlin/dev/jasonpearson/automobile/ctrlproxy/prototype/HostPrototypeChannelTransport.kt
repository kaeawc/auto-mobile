package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** Where `prototype_channel_*` frames go: the CtrlProxy socket to the connected host. */
interface PrototypeChannelHostLink {
  /** Sends to the latest host; the connection it went to, or null when no host is connected. */
  fun send(frame: String): Any?

  /** Sends to the connection an open went to; false once that connection is gone. */
  fun sendTo(target: Any, frame: String): Boolean
}

/**
 * The `via: "host"` channel transport (#14269): the daemon holds the upstream WebSocket or SSE
 * stream and relays it over the CtrlProxy socket (`prototype_channel_open`, `_send`, `_close` out;
 * `_opened`, `_frame`, `_closed` back). Every frame of one connection goes to the host its open
 * went to. With no host connected an open fails at once with `network`; when that host goes away
 * its connections fail with `network`, and the controller's backoff decides what happens next.
 */
class HostPrototypeChannelTransport(
  private val link: PrototypeChannelHostLink,
  private val warn: (String) -> Unit = { Log.w(TAG, it) },
) : PrototypeChannelTransport {
  private class Entry(val listener: PrototypeChannelListener) {
    /** The connection the open went to; null while it is still being handed to the link. */
    @Volatile var target: Any? = null

    /** Connections that closed while the open was still being handed to the link. */
    val lostWhileSending = HashSet<Any>()
  }

  private val connections = ConcurrentHashMap<String, Entry>()

  override fun open(
    request: PrototypeChannelOpenRequest,
    listener: PrototypeChannelListener,
  ): PrototypeChannelConnection {
    val id = request.connectionId
    val frame = openFrame(request)
    // Registered before the send, so an answer racing the send still finds it.
    val opening = Entry(listener)
    connections[id] = opening
    val target = link.send(frame)
    val lostMeanwhile =
      target != null &&
        synchronized(opening) {
          opening.target = target
          target in opening.lostWhileSending
        }
    when {
      target == null ->
        if (connections.remove(id, opening)) listener.onClosed(null, null, error(NO_HOST_MESSAGE))
      // Its host closed before the send returned, so no onHostLost will name this connection.
      lostMeanwhile ->
        if (connections.remove(id, opening)) listener.onClosed(null, null, error(HOST_LOST_MESSAGE))
    }
    return object : PrototypeChannelConnection {
      override fun send(data: String): Boolean {
        val entry = connections[id] ?: return false
        return link.sendTo(
          entry.target ?: return false,
          message(SEND_TYPE, id) { put("data", data) },
        )
      }

      override fun close(code: Int, reason: String) {
        val entry = connections.remove(id) ?: return
        link.sendTo(
          entry.target ?: return,
          message(CLOSE_TYPE, id) {
            put("code", code)
            if (reason.isNotEmpty()) put("reason", reason)
          },
        )
      }
    }
  }

  /** A `prototype_channel_opened`, `_frame` or `_closed` frame from the host. */
  fun onFrame(frame: String) {
    val message =
      try {
        Json.parseToJsonElement(frame).jsonObject
      } catch (error: SerializationException) {
        warn("Malformed prototype channel frame (${frame.length} chars): ${error.message}")
        return
      } catch (error: IllegalArgumentException) {
        warn("Prototype channel frame is not an object (${frame.length} chars): ${error.message}")
        return
      }
    val id = message.text("connectionId") ?: return
    when (message.text("type")) {
      OPENED_TYPE -> connections[id]?.listener?.onOpen(message.text("protocol"))
      FRAME_TYPE ->
        message.text("data")?.let { data ->
          connections[id]?.listener?.onFrame(data, message.text("event"), message.text("id"))
        }
      CLOSED_TYPE ->
        connections
          .remove(id)
          ?.listener
          ?.onClosed(
            (message["code"] as? JsonPrimitive)?.intOrNull,
            message.text("reason"),
            (message["error"] as? JsonObject)?.let(::parseError),
          )
    }
  }

  /** The host went away: its connections fail; with no [connection], every connection does. */
  fun onHostLost(connection: Any? = null) {
    for ((id, entry) in connections) {
      val affected =
        synchronized(entry) {
          val target = entry.target
          when {
            connection == null || target === connection -> true
            // Still being handed to the link: remember the close so the open can settle it.
            target == null -> false.also { entry.lostWhileSending += connection }
            else -> false
          }
        }
      if (affected && connections.remove(id, entry)) {
        entry.listener.onClosed(null, null, error(HOST_LOST_MESSAGE))
      }
    }
  }

  private fun parseError(error: JsonObject) =
    PrototypeChannelError(
      error.text("code") ?: PrototypeChannelError.NETWORK,
      error.text("message").orEmpty(),
      (error["status"] as? JsonPrimitive)?.intOrNull,
    )

  private fun JsonObject.text(key: String) =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

  companion object {
    private const val TAG = "HostPrototypeChannel"
    const val FRAME_PREFIX = "{\"type\":\"prototype_channel_"
    private const val OPEN_TYPE = "prototype_channel_open"
    private const val SEND_TYPE = "prototype_channel_send"
    private const val CLOSE_TYPE = "prototype_channel_close"
    private const val OPENED_TYPE = "prototype_channel_opened"
    private const val FRAME_TYPE = "prototype_channel_frame"
    private const val CLOSED_TYPE = "prototype_channel_closed"

    const val NO_HOST_MESSAGE =
      "No AutoMobile host is connected to relay this channel (via \"host\"). " +
        "Connect a host, or set via \"device\" to connect from the device itself."
    const val HOST_LOST_MESSAGE = "The AutoMobile host disconnected while the channel was open."

    private fun error(message: String) =
      PrototypeChannelError(PrototypeChannelError.NETWORK, message)

    private fun message(
      type: String,
      connectionId: String,
      fields: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {},
    ): String = buildJsonObject {
      put("type", type)
      put("connectionId", connectionId)
      fields()
    }
      .toString()

    private fun openFrame(request: PrototypeChannelOpenRequest): String =
      message(OPEN_TYPE, request.connectionId) {
        put("prototypeId", request.prototypeId)
        put("channel", request.channel)
        put("kind", request.kind.wireValue)
        put("url", request.url)
        if (request.protocols.isNotEmpty())
          putJsonArray("protocols") { request.protocols.forEach { add(JsonPrimitive(it)) } }
        if (request.headers.isNotEmpty())
          putJsonObject("headers") { request.headers.forEach { (name, value) -> put(name, value) } }
        request.lastEventId?.let { put("lastEventId", it) }
      }
  }
}
