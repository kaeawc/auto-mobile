package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Device media items (#14192): an `image` `asset`, or a tab item `image`, of the form `{data:
 * "/pointer"}` names a device media item held in `/data`. The spec-language gate
 * `prototype_platform_media_items_v1` covers it; it is not a platform module.
 */
internal object PrototypeMediaItemBindings {
  fun usedBy(node: JsonObject): Boolean =
    (node["type"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } == "image" &&
      bound(node["asset"])) ||
      (node["items"] as? JsonArray).orEmpty().any { bound((it as? JsonObject)?.get("image")) }

  private fun bound(value: kotlinx.serialization.json.JsonElement?) =
    (value as? JsonObject)?.containsKey("data") == true
}
