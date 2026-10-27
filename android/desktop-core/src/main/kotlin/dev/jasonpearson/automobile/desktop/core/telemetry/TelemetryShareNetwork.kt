package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeNetwork(
  event: TelemetryDisplayEvent.Network,
) {

  put("type", JsonPrimitive("network"))
  put("method", JsonPrimitive(event.method))
  put("statusCode", JsonPrimitive(event.statusCode))
  put("url", JsonPrimitive(event.url))
  put("durationMs", JsonPrimitive(event.durationMs))
  event.host?.let { put("host", JsonPrimitive(it)) }
  event.path?.let { put("path", JsonPrimitive(it)) }
  event.error?.let { put("error", JsonPrimitive(it)) }
  event.requestBody?.let { put("requestBody", JsonPrimitive(it)) }
  event.responseBody?.let { put("responseBody", JsonPrimitive(it)) }
  event.contentType?.let { put("contentType", JsonPrimitive(it)) }
  event.requestHeaders?.let { serializeRequestHeaders(it) }
  event.responseHeaders?.let { headers ->
    put(
      "responseHeaders",
      buildJsonObject {
        headers.forEach { (k, v) ->
          val redacted = if (k.equals("Set-Cookie", ignoreCase = true)) "[REDACTED]" else v
          put(k, JsonPrimitive(redacted))
        }
      },
    )
  }
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeFailure(
  event: TelemetryDisplayEvent.Failure,
) {

  put("type", JsonPrimitive(event.type))
  put("severity", JsonPrimitive(event.severity))
  put("title", JsonPrimitive(event.title))
  put("occurrenceId", JsonPrimitive(event.occurrenceId))
  event.exceptionType?.let { put("exceptionType", JsonPrimitive(it)) }
  event.screen?.let { put("screen", JsonPrimitive(it)) }
  event.stackTrace?.let { frames ->
    put(
      "stackTrace",
      buildJsonArray {
        frames.forEach { f ->
          add(
            buildJsonObject {
              put("className", JsonPrimitive(f.className))
              put("methodName", JsonPrimitive(f.methodName))
              f.fileName?.let { put("fileName", JsonPrimitive(it)) }
              f.lineNumber?.let { put("lineNumber", JsonPrimitive(it)) }
              put("isAppCode", JsonPrimitive(f.isAppCode))
            },
          )
        }
      },
    )
  }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.serializeRequestHeaders(
  headers: Map<String, String>,
) {

  put(
    "requestHeaders",
    buildJsonObject {
      headers.forEach { (k, v) ->
        val redacted =
          if (
            k.equals("Authorization", ignoreCase = true) ||
              k.equals("Cookie", ignoreCase = true) ||
              k.equals("Set-Cookie", ignoreCase = true)
          )
            "[REDACTED]"
          else v
        put(k, JsonPrimitive(redacted))
      }
    },
  )
}
