package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

internal fun TelemetryEventReader.parseLog(): TelemetryDisplayEvent {
  return TelemetryDisplayEvent.Log(
    timestamp = envelope.timestamp,
    level = d.primitiveOrNull("level")?.intOrNull ?: 4, // default INFO
    tag = d.stringOrDefault("tag", ""),
    message = d.stringOrDefault("message", ""),
  )
}

internal fun TelemetryEventReader.parseCustom(): TelemetryDisplayEvent {
  // Custom events are merged into log events
  val name = d.stringOrDefault("name", "unknown")
  val props = mutableMapOf<String, String>()
  props.putAll(d["properties"].stringMap("properties"))
  val propsJson = d.stringOrNull("properties_json")
  if (props.isEmpty() && propsJson != null) {
    try {
      props.putAll(telemetryJson.parseToJsonElement(propsJson).stringMap("properties"))
    } catch (error: IllegalArgumentException) {
      reportMalformedTelemetry(error)
    }
  }
  val propsStr =
    if (props.isNotEmpty()) {
      " {${props.entries.joinToString(", ") { "${it.key}:${it.value}" }}}"
    } else ""
  return TelemetryDisplayEvent.Log(
    timestamp = envelope.timestamp,
    level = 4, // INFO
    tag = "CustomEvent",
    message = "$name$propsStr",
  )
}

internal fun TelemetryEventReader.parseOs(): TelemetryDisplayEvent {
  val details = mutableMapOf<String, String>()
  details.putAll(d["details"].stringMap("details"))
  val detailsJson = d.stringOrNull("details_json")
  if (details.isEmpty() && detailsJson != null) {
    try {
      details.putAll(telemetryJson.parseToJsonElement(detailsJson).stringMap("details"))
    } catch (error: IllegalArgumentException) {
      reportMalformedTelemetry(error)
    }
  }
  return TelemetryDisplayEvent.Os(
    timestamp = envelope.timestamp,
    category = d.stringOrDefault("category", "unknown"),
    kind = d.stringOrDefault("kind", "unknown"),
    details = details.ifEmpty { null },
  )
}

internal fun TelemetryEventReader.parseCrash(): TelemetryDisplayEvent {
  val frames =
    try {
      d["stackTrace"]
        ?.takeIf { it !is JsonNull }
        ?.jsonArray
        ?.map { frame ->
          val f = frame.jsonObject
          StackTraceFrame(
            className = f.stringOrDefault("className", ""),
            methodName = f.stringOrDefault("methodName", ""),
            fileName = f.stringOrNull("fileName"),
            lineNumber = f.primitiveOrNull("lineNumber")?.intOrNull,
            isAppCode = f.primitiveOrNull("isAppCode")?.booleanOrNull ?: false,
          )
        }
    } catch (error: IllegalArgumentException) {
      reportMalformedTelemetry(error)
      null
    }
  return TelemetryDisplayEvent.Failure(
    timestamp = envelope.timestamp,
    type = envelope.category,
    occurrenceId = d.stringOrDefault("occurrenceId", ""),
    severity = d.stringOrDefault("severity", "medium"),
    title = d.stringOrDefault("title", "Unknown failure"),
    exceptionType = d.stringOrNull("exceptionType"),
    screen = d.stringOrNull("screen"),
    stackTrace = frames,
  )
}
