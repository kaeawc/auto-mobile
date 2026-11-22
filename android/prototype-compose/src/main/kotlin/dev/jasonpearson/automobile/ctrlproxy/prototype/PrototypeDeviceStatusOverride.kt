package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.protocol.PrototypeSpecError
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

enum class DeviceStatusMode {
  REAL,
  FAKE,
}

/**
 * How real readings, `platformMode` switches and `simulate state` seeds (#14300) combine into the
 * values a status module shows under `/platform/<module>` (#14316), the twin of TypeScript's
 * `prototypeStatusOverrideUpdates`:
 * - In [DeviceStatusMode.REAL] (the default) [shown] is the latest reading.
 * - Switching to [DeviceStatusMode.FAKE] freezes [shown]; later readings are recorded, not shown.
 * - A seed merges into [shown]; a `null` seed value removes the key.
 * - Switching back to real drops the override and shows the latest reading at once.
 *
 * [shown] is null until the first reading or seed. Not thread-safe; [DeviceStatusTracker] guards
 * it.
 */
class DeviceStatusOverride(private val platform: String) {
  var mode = DeviceStatusMode.REAL
    private set

  var shown: JsonObject? = null
    private set

  private var real: JsonObject? = null

  fun reading(values: JsonObject) {
    real = values
    if (mode == DeviceStatusMode.REAL) shown = values
  }

  fun mode(next: DeviceStatusMode) {
    if (next == mode) return
    mode = next
    if (next == DeviceStatusMode.REAL) shown = real ?: shown?.let { JsonObject(emptyMap()) }
  }

  /**
   * Merges [seed] into [shown], or returns the refusal with a path relative to the seed input
   * (`seed` or `seed.<key>`) and leaves [shown] unchanged.
   */
  fun seed(module: String, seed: JsonObject): PrototypeSpecError? {
    if (mode != DeviceStatusMode.FAKE) {
      return PrototypeSpecError("seed", "simulate state needs $module in fake platformMode")
    }
    val values = shown.orEmpty().toMutableMap<String, JsonElement>()
    for ((key, value) in seed) {
      PrototypePlatformCalls.stateSeedError(module, platform, key, value)?.let {
        return PrototypeSpecError("seed.$key", it)
      }
      if (value is JsonNull) values.remove(key) else values[key] = canonical(value)
    }
    val next = JsonObject(values)
    if (next != shown) shown = next
    return null
  }

  /**
   * A whole number in integer form, so a seed of `80.0` equals the reading `80` (`JsonPrimitive`
   * compares the literal text, unlike the TypeScript reference's numeric equality).
   */
  private fun canonical(value: JsonElement): JsonElement {
    val primitive = value as? JsonPrimitive ?: return value
    val number = primitive.takeUnless { it.isString }?.doubleOrNull ?: return value
    val whole = number.toLong()
    return if (number.isFinite() && whole.toDouble() == number) JsonPrimitive(whole) else value
  }
}
