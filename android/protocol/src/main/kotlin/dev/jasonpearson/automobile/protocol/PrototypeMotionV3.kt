package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Node-local v3 vocabulary; opaque payloads are never scanned here. */
internal object PrototypeMotionV3 {
  const val CAPABILITY = "prototype_motion_v3"

  fun required(node: JsonObject): Boolean =
    "press" in node ||
      ("animate" in node &&
        (layout(node["style"]) ||
          (node["styleWhen"] as? JsonArray).orEmpty().any {
            layout((it as? JsonObject)?.get("style"))
          }))

  private fun layout(value: JsonElement?): Boolean {
    val style = value as? JsonObject ?: return false
    val border = style["border"] as? JsonObject
    return listOf("cornerRadius", "elevation", "shadowColor", "padding").any { it in style } ||
      border?.let { "color" in it || "width" in it } == true ||
      listOf("width", "height").any { (style[it] as? JsonObject)?.containsKey("dp") == true }
  }
}
