package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Authored style slots; values in data and action payloads are opaque. */
internal object PrototypeStylePolishV2Rules {
  const val CAPABILITY = "prototype_style_polish_v2"

  fun styles(node: JsonObject): List<JsonObject> =
    listOfNotNull(node["style"] as? JsonObject) +
      (node["styleWhen"] as? JsonArray).orEmpty().mapNotNull {
        (it as? JsonObject)?.get("style") as? JsonObject
      }

  fun required(node: JsonObject): Boolean =
    "fadeEdges" in node ||
      "filter" in node ||
      styles(node).any {
        "shadows" in it ||
          "cornerStyle" in it ||
          (it["border"] as? JsonObject)?.containsKey("gradient") == true
      }

  fun themedBorder(node: JsonObject): Boolean =
    styles(node).any { style ->
      val stops =
        (((style["border"] as? JsonObject)?.get("gradient") as? JsonObject)?.get("stops")
            as? JsonArray)
          .orEmpty()
      stops.any { PrototypeBundleNodeCapabilities.themed((it as? JsonObject)?.get("color")) }
    }

  fun objectError(data: JsonObject, kind: String, path: String): PrototypeSpecError? {
    if (kind == "style" && "shadows" in data && ("elevation" in data || "shadowColor" in data))
      return fail("$path.shadows", "shadows cannot be combined with elevation or shadowColor")
    if (data.isEmpty() && kind in setOf("fadeEdges", "imageFilter"))
      return fail(
        path,
        if (kind == "fadeEdges") "At least one fade edge is required"
        else "At least one image filter field is required",
      )
    return null
  }
}
