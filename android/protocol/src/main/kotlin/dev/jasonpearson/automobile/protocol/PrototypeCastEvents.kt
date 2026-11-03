package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Data decoders for the `cast` platform module's events (#14239), the Kotlin twin of
 * `src/features/prototype/prototypeCastEvents.ts`. All three replay
 * `test/fixtures/prototype-spec/cast/events.json`. Every event's data is a closed object.
 */
object PrototypeCastEvents {
  val events: List<String> =
    listOf(
      "routesChanged",
      "sessionStarting",
      "sessionStarted",
      "sessionEnded",
      "sessionFailed",
      "remoteVolume",
    )

  /** Why a session failed. `media_not_castable`: the player source is not an absolute http(s) URL. */
  val failureReasons: List<String> =
    listOf("media_not_castable", "play_services_unavailable", "network", "receiver")

  private val states = setOf("unavailable", "noDevices", "notConnected", "connecting", "connected")
  private val protocols = setOf("googleCast", "airplay")

  private fun interface Field {
    fun accepts(value: JsonElement): Boolean
  }

  private fun string(min: Int, max: Int) = Field { value ->
    value is JsonPrimitive && value.isString && value.content.length in min..max
  }

  private fun oneOf(values: Collection<String>) = Field { value ->
    value is JsonPrimitive && value.isString && value.content in values
  }

  private fun number(value: JsonElement): Double? =
    (value as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

  private val count = Field { value ->
    number(value)?.let { it >= 0 && it == Math.floor(it) } == true
  }
  private val fraction = Field { value -> number(value)?.let { it in 0.0..1.0 } == true }

  private val player = string(1, 64)
  private val session =
    mapOf("player" to player, "protocol" to oneOf(protocols), "deviceName" to string(0, 256))

  private class Shape(val required: Map<String, Field>, val optional: Map<String, Field> = emptyMap())

  private val shapes: Map<String, Shape> =
    mapOf(
      "routesChanged" to Shape(mapOf("state" to oneOf(states), "routeCount" to count)),
      "sessionStarting" to Shape(session),
      "sessionStarted" to Shape(session + ("positionMs" to count)),
      "sessionEnded" to Shape(session + ("positionMs" to count)),
      "sessionFailed" to
        Shape(
          mapOf("player" to player, "reason" to oneOf(failureReasons)),
          mapOf("protocol" to oneOf(protocols)),
        ),
      "remoteVolume" to Shape(mapOf("volume" to fraction)),
    )

  /** A decoded `cast.*` event: its short name and its validated data. */
  data class Event(val name: String, val data: JsonObject)

  /**
   * Decode a delivered platform event's `data` for a qualified `cast.<event>` name, or null for
   * another module's event, an unknown cast event or data of the wrong shape.
   */
  fun decode(event: String, data: JsonElement): Event? {
    val name = event.removePrefix("cast.").takeIf { event.startsWith("cast.") } ?: return null
    val shape = shapes[name] ?: return null
    val fields = data as? JsonObject ?: return null
    val known =
      fields.keys.all { it in shape.required || it in shape.optional } &&
        shape.required.all { (key, field) -> fields[key]?.let(field::accepts) == true } &&
        shape.optional.all { (key, field) -> fields[key]?.let(field::accepts) ?: true }
    return if (known) Event(name, fields) else null
  }
}
