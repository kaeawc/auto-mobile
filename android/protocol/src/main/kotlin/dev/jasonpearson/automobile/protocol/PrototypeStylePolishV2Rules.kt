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

  private val nonEmptyMessages =
    mapOf(
      "fadeEdges" to "At least one fade edge is required",
      "imageFilter" to "At least one image filter field is required",
    )

  fun objectError(data: JsonObject, kind: String, path: String): PrototypeSpecError? {
    val legacyShadow = "elevation" in data || "shadowColor" in data
    if (kind == "style" && "shadows" in data && legacyShadow)
      return fail("$path.shadows", "shadows cannot be combined with elevation or shadowColor")
    val emptyMessage = nonEmptyMessages[kind]
    if (data.isEmpty() && emptyMessage != null) return fail(path, emptyMessage)
    return null
  }
}
