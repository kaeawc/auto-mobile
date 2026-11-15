package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull

/**
 * The delivered `location.updated` data for one fix (#16463), the Kotlin twin of TypeScript's
 * `prototypeLocationEventSummary` (`prototypeLocationPrivacy.ts`): only `accuracyM` and
 * `approximate`, so coordinates never leave the device in the event. Both replay
 * `test/fixtures/prototype-location/event-summary.json`.
 */
object PrototypeLocationEventSummary {
  /** The summary of [fix]; null without a finite `accuracyM` and a boolean `approximate`. */
  fun of(fix: JsonObject): JsonObject? {
    val accuracyM = (fix["accuracyM"] as? JsonPrimitive)?.takeUnless { it.isString }
    val approximate = (fix["approximate"] as? JsonPrimitive)?.takeUnless { it.isString }
    if (accuracyM?.doubleOrNull?.isFinite() != true) return null
    if (approximate?.booleanOrNull == null) return null
    return buildJsonObject {
      put("accuracyM", accuracyM)
      put("approximate", approximate)
    }
  }
}
