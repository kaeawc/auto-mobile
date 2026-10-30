package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Validated by the shared structural contract; source and format are strict one-key unions. */
@Serializable
data class PrototypeDerivedEntry(
  val of: JsonObject,
  val format: JsonObject,
  val locale: String? = null,
  val timeZone: String? = null,
)
