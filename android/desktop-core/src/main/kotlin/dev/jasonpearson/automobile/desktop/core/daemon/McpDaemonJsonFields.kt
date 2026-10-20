package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive

internal fun JsonObjectBuilder.putOptionalString(
  key: String,
  value: String?,
) {
  if (value != null) {
    put(key, JsonPrimitive(value))
  }
}

internal fun JsonObjectBuilder.putOptionalInt(
  key: String,
  value: Int?,
) {
  if (value != null) {
    put(key, JsonPrimitive(value))
  }
}

internal fun JsonObjectBuilder.putOptionalBoolean(
  key: String,
  value: Boolean?,
) {
  if (value != null) {
    put(key, JsonPrimitive(value))
  }
}
