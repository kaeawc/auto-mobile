package dev.jasonpearson.automobile.demos

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import dev.jasonpearson.automobile.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.prototype.PrototypeHttpRequest
import java.net.URI
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The demo's app-owned device transport: a canned, in-process responder, so the embedding sample's
 * Load button works on any device without a server. It answers `GET .../greeting` and fails every
 * other request with a typed `not_found` error.
 */
object EmbeddedPrototypeDemoTransport : PrototypeHttpClient {
  const val GREETING_TEXT = "Hello from the demo transport"

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
    respond(request.method, request.url)

  /** The canned response for [method] and [url]. */
  fun respond(method: String, url: String): PrototypeRequestResponse {
    val path = runCatching { URI(url).path }.getOrNull()
    return if (method.equals("GET", ignoreCase = true) && path == "/greeting") {
      PrototypeRequestResponse.Received(
        status = 200,
        headers = mapOf("content-type" to "application/json"),
        body = buildJsonObject { put("text", GREETING_TEXT) },
        durationMs = 0L,
      )
    } else {
      PrototypeRequestResponse.Failed(
        PrototypeRequestError(
          PrototypeRequestErrorCode.NOT_FOUND,
          "The demo transport has no canned response for $method $url",
        ),
      )
    }
  }
}

/** Turns the renderer's `prototype_request` events into the demo's visible request status. */
object EmbeddedPrototypeRequestStatus {
  /**
   * The message to show for [event]: null when [event] is not a `prototype_request` event, an empty
   * string for a succeeded request (which clears an earlier error), and the error code and message
   * for a failed one.
   */
  fun messageFor(event: PrototypeEvent): String? {
    if (event.kind != PrototypeEventKind.EMIT || event.name != PrototypeRequests.EVENT_NAME) {
      return null
    }
    val payload = event.payload as? JsonObject ?: return null
    val error = payload["error"] as? JsonObject ?: return ""
    val code = (error["code"] as? JsonPrimitive)?.content ?: "unknown"
    val message = (error["message"] as? JsonPrimitive)?.content.orEmpty()
    return if (message.isEmpty()) "Request failed ($code)" else "Request failed ($code): $message"
  }
}
