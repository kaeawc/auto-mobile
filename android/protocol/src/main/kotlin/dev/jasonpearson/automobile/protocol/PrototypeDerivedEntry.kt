package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Shared contract validation selects scalar or collection inputs and an optional display format.
 */
@Serializable
data class PrototypeDerivedEntry(
  val of: JsonObject = JsonObject(emptyMap()),
  val format: JsonObject = JsonObject(emptyMap()),
  val locale: String? = null,
  val timeZone: String? = null,
  val collection: JsonObject? = null,
  val reduce: JsonObject? = null,
)
