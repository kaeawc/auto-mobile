package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The image asset a `map` node's `markers.icon` names (#16491), the twin of TypeScript's
 * `prototypeMapMarkerAsset`: `{"asset": id}` instead of a Material icon name.
 */
internal object PrototypeMapMarkerAssets {
  private val placeholder = Regex("""\{[^{}]+\}""")

  /** The asset id, or null for an icon name or a per-marker `{alias.field}` template. */
  fun asset(node: JsonObject): String? {
    if ((node["type"] as? JsonPrimitive)?.content != "map") return null
    val icon = (node["markers"] as? JsonObject)?.get("icon") as? JsonObject ?: return null
    val asset = (icon["asset"] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
    return asset?.takeUnless { placeholder.containsMatchIn(it) }
  }

  /** The first map whose marker asset is not in a complete uploaded asset inventory. */
  fun unknownError(nodes: List<Located>, assets: Set<String>): PrototypeSpecError? =
    nodes.firstNotNullOfOrNull { (node, path) ->
      asset(node)
        ?.takeUnless(assets::contains)
        ?.let { PrototypeSpecError("$path.markers.icon.asset", "Unknown marker asset") }
    }
}
