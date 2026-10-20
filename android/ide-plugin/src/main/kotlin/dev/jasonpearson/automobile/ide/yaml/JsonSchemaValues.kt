package dev.jasonpearson.automobile.ide.yaml

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

internal fun JsonObject.schemaObjectValue(key: String): JsonObject? =
  this[key]?.schemaAsObjectOrNull()

internal fun JsonObject.schemaArrayValue(key: String): JsonArray? = this[key]?.schemaAsArrayOrNull()

internal fun JsonObject.schemaStringValue(key: String): String? = this[key]?.schemaStringValue()

internal fun JsonObject.schemaBooleanValue(key: String): Boolean? {
  return (this[key] as? JsonPrimitive)?.booleanOrNull
}

internal fun JsonElement.schemaStringValue(): String? = (this as? JsonPrimitive)?.content

internal fun JsonElement.schemaAsObjectOrNull(): JsonObject? = this as? JsonObject

internal fun JsonElement.schemaAsArrayOrNull(): JsonArray? = this as? JsonArray
