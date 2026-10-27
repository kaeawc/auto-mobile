package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

internal fun TelemetryEventReader.parseNetwork(): TelemetryDisplayEvent {
  val reqHeaders = d["requestHeaders"].stringMap("requestHeaders").toMutableMap()
  val respHeaders = d["responseHeaders"].stringMap("responseHeaders").toMutableMap()
  // Also check snake_case variants from backfill
  if (reqHeaders.isEmpty()) {
    val reqJson = d.stringOrNull("request_headers_json")
    if (reqJson != null) {
      try {
        reqHeaders.putAll(telemetryJson.parseToJsonElement(reqJson).stringMap("requestHeaders"))
      } catch (error: IllegalArgumentException) {
        reportMalformedTelemetry(error)
      }
    }
  }
  if (respHeaders.isEmpty()) {
    val respJson = d.stringOrNull("response_headers_json")
    if (respJson != null) {
      try {
        respHeaders.putAll(
          telemetryJson.parseToJsonElement(respJson).stringMap("responseHeaders"),
        )
      } catch (error: IllegalArgumentException) {
        reportMalformedTelemetry(error)
      }
    }
  }
  return TelemetryDisplayEvent.Network(
    timestamp = envelope.timestamp,
    method = d.stringOrDefault("method", "?"),
    statusCode =
      d.primitiveOrNull("statusCode")?.intOrNull
        ?: d.primitiveOrNull("status_code")?.intOrNull
        ?: 0,
    url = d.stringOrDefault("url", ""),
    durationMs =
      d.primitiveOrNull("durationMs")?.longOrNull
        ?: d.primitiveOrNull("duration_ms")?.longOrNull
        ?: 0,
    host = d.stringOrNull("host"),
    path = d.stringOrNull("path"),
    error = d.stringOrNull("error"),
    requestHeaders = reqHeaders.ifEmpty { null },
    responseHeaders = respHeaders.ifEmpty { null },
    requestBody = d.stringOrNull("requestBody") ?: d.stringOrNull("request_body"),
    responseBody = d.stringOrNull("responseBody") ?: d.stringOrNull("response_body"),
    contentType = d.stringOrNull("contentType") ?: d.stringOrNull("content_type"),
  )
}

internal fun TelemetryEventReader.parseNavigation(): TelemetryDisplayEvent {
  val args = d["arguments"].stringMap("arguments")
  val meta = d["metadata"].stringMap("metadata")
  // Build human-readable triggering interaction summary
  val trigInteraction =
    d.objectOrNull("triggeringInteraction")?.let { ti ->
      val interType = ti.stringOrNull("type") ?: "interaction"
      val elText = ti.stringOrNull("elementText")
      val elResId = ti.stringOrNull("elementResourceId")
      val target = elText ?: elResId
      if (target != null) "$interType on '$target'" else interType
    }
  return TelemetryDisplayEvent.Navigation(
    timestamp = envelope.timestamp,
    destination = d.stringOrDefault("destination", "unknown"),
    source = d.stringOrNull("source"),
    arguments = args.ifEmpty { null },
    metadata = meta.ifEmpty { null },
    triggeringInteraction = trigInteraction,
    screenshotUri = d.stringOrNull("screenshotUri"),
  )
}
