package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal class TelemetryEventReader(
  val envelope: TelemetryEventEnvelope,
  val onFieldMismatch: (String) -> Unit,
) {

  val d = envelope.data

  fun JsonElement?.stringMap(key: String): Map<String, String> {
    val value = this ?: return emptyMap()
    if (value is JsonNull) return emptyMap()
    if (value !is JsonObject) {
      onFieldMismatch(key)
      return emptyMap()
    }
    return value.mapValues { (_, item) ->
      if (item !is JsonPrimitive) onFieldMismatch(key)
      item.displayString()
    }
  }

  fun JsonObject.primitiveOrNull(key: String): JsonPrimitive? {
    val value = this[key]
    if (value != null && value !is JsonPrimitive) onFieldMismatch(key)
    return value as? JsonPrimitive
  }

  fun JsonObject.objectOrNull(key: String): JsonObject? {
    val value = this[key]
    if (value != null && value !is JsonNull && value !is JsonObject) onFieldMismatch(key)
    return value as? JsonObject
  }

  fun JsonObject.stringOrDefault(key: String, default: String): String =
    primitiveOrNull(key)?.content ?: default

  fun JsonObject.stringOrNull(key: String): String? = primitiveOrNull(key)?.contentOrNull
}

internal fun reportMalformedTelemetry(error: IllegalArgumentException) {
  dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("TelemetryEventReader")
    .debug("Malformed telemetry field: ${error.message}")
}
