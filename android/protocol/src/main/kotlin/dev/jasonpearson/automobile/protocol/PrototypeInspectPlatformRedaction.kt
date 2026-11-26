package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull

/**
 * The `/platform` state an `inspect` reports (#16463), the Kotlin twin of TypeScript's
 * `redactPrototypeInspectPlatform` (`prototypeLocationPrivacy.ts`). Only keys in a module's
 * contract `state` table are kept (the placeholder `test` module has no table and keeps every key).
 * `location.current` becomes its accuracy summary with `redacted: true` (null stays null) unless
 * `includeLocation`, and any other `sensitive` key is omitted. Both replay
 * `test/fixtures/prototype-location/inspect-redaction.json`.
 */
object PrototypeInspectPlatformRedaction {
  fun redact(platform: JsonObject, includeLocation: Boolean): JsonObject = buildJsonObject {
    for ((name, values) in platform) {
      val definition = PrototypePlatformModules.module(name) ?: continue
      if (values !is JsonObject) continue
      put(name, redactModule(name, definition.member("state"), values, includeLocation))
    }
  }

  private fun redactModule(
    name: String,
    table: JsonObject?,
    values: JsonObject,
    includeLocation: Boolean,
  ): JsonObject {
    if (table == null) return values
    return buildJsonObject {
      for ((key, value) in values) {
        val entry = table[key]
        if (name == "location" && key == "current") {
          put(key, if (includeLocation) value else redactedFix(value))
        } else if (entry != null && (entry as? JsonObject)?.flag("sensitive") != true) {
          put(key, value)
        }
      }
    }
  }

  /**
   * The fix as presence and accuracy: a finite `accuracyM` and a boolean `approximate` when it has
   * them, always `redacted: true`; no fix stays null.
   */
  private fun redactedFix(fix: JsonElement): JsonElement {
    if (fix is JsonNull) return JsonNull
    val fields = fix as? JsonObject
    val accuracyM = (fields?.get("accuracyM") as? JsonPrimitive)?.takeUnless { it.isString }
    val approximate = (fields?.get("approximate") as? JsonPrimitive)?.takeUnless { it.isString }
    return buildJsonObject {
      if (accuracyM?.doubleOrNull?.isFinite() == true) put("accuracyM", accuracyM)
      if (approximate?.booleanOrNull != null) put("approximate", approximate)
      put("redacted", JsonPrimitive(true))
    }
  }
}
