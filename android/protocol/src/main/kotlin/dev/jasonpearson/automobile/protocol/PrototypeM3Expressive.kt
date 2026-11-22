package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/**
 * Material 3 Expressive node vocabulary (#15258): a `loadingIndicator` node, `segmentedButton`
 * `variant: "connected"`, `progress` `variant: "wavy"`, `button.split` and `fab.menu`.
 */
object PrototypeM3Expressive {
  const val CAPABILITY = "prototype_m3_expressive_v1"

  fun required(node: JsonObject): Boolean =
    when ((node["type"] as? JsonPrimitive)?.contentOrNull) {
      "loadingIndicator" -> true
      "segmentedButton" -> (node["variant"] as? JsonPrimitive)?.contentOrNull == "connected"
      "progress" -> (node["variant"] as? JsonPrimitive)?.contentOrNull == "wavy"
      "button" -> node["split"] is JsonObject
      "fab" -> node["menu"] is JsonObject
      else -> false
    }
}
