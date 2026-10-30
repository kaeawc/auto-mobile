package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Root `sensors` block rules (#14327) the contract cannot express, the twin of TypeScript's
 * `prototypeSensorsBlock.ts`: the block needs `sensors` in `requires.platform`, `steps` needs the
 * `motion` permission, and a `/platform/sensors` read or `sensors.*` handler names a sensor the
 * block lists, because the device listens only to declared sensors.
 */
internal object PrototypeSensorRules {
  private val sensorOf =
    mapOf(
      "pitchDeg" to "orientation",
      "rollDeg" to "orientation",
      "headingDeg" to "orientation",
      "steps" to "steps",
      "proximityNear" to "proximity",
      "lightLux" to "light",
      "shake" to "shake",
    )

  fun blockError(root: JsonObject): PrototypeSpecError? {
    val sensors = root.member("sensors") ?: return null
    val requires = root.member("requires")
    if ("sensors" !in (requires?.strings("platform") ?: emptyList()))
      return fail("sensors", "The sensors block requires sensors in requires.platform")
    val motion =
      (requires?.get("permissions") as? JsonArray).orEmpty().any {
        (it as? JsonObject)?.text("name") == "motion"
      }
    return if ("steps" in sensors && !motion)
      fail("sensors.steps", "steps requires permission motion in requires.permissions")
    else null
  }

  /** A `/platform/sensors/<key>` read whose sensor the block does not list. */
  fun readError(pointer: String, path: String, sensors: JsonObject?): PrototypeSpecError? {
    val tokens = PrototypeDataPointer.tokens(pointer)
    return if (tokens.size == 2 && tokens[0] == "sensors") useError(tokens[1], path, sensors)
    else null
  }

  /** A `sensors.<event>` handler whose sensor the block does not list. */
  fun eventError(event: String, path: String, sensors: JsonObject?): PrototypeSpecError? =
    if (event.startsWith("sensors.")) useError(event.removePrefix("sensors."), path, sensors)
    else null

  private fun useError(member: String, path: String, sensors: JsonObject?): PrototypeSpecError? {
    val sensor = sensorOf[member] ?: return null
    return if (sensors?.get(sensor) == null)
      fail(path, "Sensor $sensor is not declared in the sensors block")
    else null
  }
}
