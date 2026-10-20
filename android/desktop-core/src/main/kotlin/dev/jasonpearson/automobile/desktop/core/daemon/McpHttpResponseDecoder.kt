package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.http.HttpResponse
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.serializer

internal class McpHttpResponseDecoder(private val json: Json) {
  fun isSessionLost(response: HttpResponse<String>): Boolean {
    if (response.statusCode() != 404) {
      return false
    }
    val envelope = runCatching { json.parseToJsonElement(response.body()) }.getOrNull()
    val error = (envelope as? JsonObject)?.get("error") ?: return false
    val message =
      when (error) {
        is JsonPrimitive -> error.contentOrNull
        is JsonObject -> (error["message"] as? JsonPrimitive)?.contentOrNull
        else -> null
      }
    return message?.contains(SESSION_NOT_FOUND, ignoreCase = true) == true
  }

  fun isEventStream(response: HttpResponse<String>): Boolean =
    response.headers().firstValue("content-type").orElse("").trimStart().startsWith(EVENT_STREAM)

  /** Picks the JSON-RPC reply to [request] out of the stream, skipping everything else. */
  fun responseFromEventStream(request: JsonRpcRequest, body: String): JsonRpcResponse {
    for (event in SseEventParser.parse(body)) {
      if (event.data.isBlank()) {
        continue
      }
      val message = runCatching { json.parseToJsonElement(event.data) }.getOrNull() as? JsonObject
      val isReply = message != null && ("result" in message || "error" in message)
      if (message != null && isReply && message["id"] == request.id) {
        return decodeJsonRpcResponse(event.data)
      }
    }
    throw McpConnectionException(
      "MCP HTTP event stream ended without a reply to ${request.method} (id ${request.id})",
    )
  }

  fun decodeJsonRpcResponse(body: String): JsonRpcResponse =
    try {
      json.decodeFromString(serializer<JsonRpcResponse>(), body)
    } catch (e: SerializationException) {
      throw McpConnectionException(
        "MCP HTTP response was not a JSON-RPC message: ${excerpt(body)}",
        e,
      )
    }

  /** A non-2xx reply: a JSON-RPC error envelope when there is one, otherwise status plus body. */
  fun httpFailure(statusCode: Int, body: String): McpConnectionException {
    val error = runCatching { json.decodeFromString<JsonRpcResponse>(body) }.getOrNull()?.error
    return if (error != null) {
      McpConnectionException("MCP HTTP error ${error.code}: ${error.message} (HTTP $statusCode)")
    } else {
      McpConnectionException("MCP HTTP $statusCode: ${excerpt(body)}")
    }
  }

  fun excerpt(body: String): String =
    if (body.length <= MAX_ERROR_BODY_CHARS) body else body.take(MAX_ERROR_BODY_CHARS) + "..."

  companion object {
    private const val SESSION_NOT_FOUND = "Session not found"
    private const val EVENT_STREAM = "text/event-stream"
    private const val MAX_ERROR_BODY_CHARS = 200
  }
}
