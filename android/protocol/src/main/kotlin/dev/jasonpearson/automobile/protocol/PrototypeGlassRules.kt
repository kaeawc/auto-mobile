package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

/** Contract only on Android: no imitation glass is rendered or advertised. */
internal object PrototypeGlassRules {
  private val namespaceFields =
    setOf("glassGroup", "glassUnion", "glassTransition", "backgroundExtension")
  private val containers = setOf("column", "row", "box", "flow", "grid", "list", "listItem")

  fun capabilities(node: JsonObject): Set<String> = buildSet {
    val ios = node["ios"] as? JsonObject
    if (
      PrototypeStylePolishV2Rules.styles(node).any { "surface" in it || "glass" in it } ||
        ios?.keys?.any { it in namespaceFields } == true
    )
      add("prototype_glass_v1")
    if (node.text("type") == "scroll" && "edgeEffect" in node)
      add("prototype_scroll_edge_effect_v1")
  }

  fun sharedGroup(
    node: JsonObject,
    path: String,
    nodes: List<PrototypeStateChecks.Located>,
  ): String? {
    if ("shared" !in node || (node["style"] as? JsonObject)?.text("surface") != "glass") return null
    return nodes
      .lastOrNull {
        path.startsWith("${it.path}.") &&
          (it.value["ios"] as? JsonObject)?.containsKey("glassGroup") == true
      }
      ?.path
  }

  fun needsNamespace(node: JsonObject): Boolean {
    if ("android" in node) return true
    val ios = node["ios"] as? JsonObject ?: return false
    return ios.isEmpty() || ios.keys.any { it !in namespaceFields }
  }

  fun objectError(data: JsonObject, kind: String, path: String): PrototypeSpecError? {
    if (kind == "style" && "glass" in data && data.text("surface") != "glass")
      return fail(
        "$path.glass",
        if (".styleWhen[" in path) "styleWhen glass requires surface: \"glass\" in the same style"
        else "glass requires surface: \"glass\"",
      )
    val ios = data["ios"] as? JsonObject ?: return null
    nodeOnlyError(ios, path)?.let {
      return it
    }
    if ("glassGroup" in ios && data.text("type") !in containers)
      return fail("$path.ios.glassGroup", "glassGroup requires a container node")
    for (key in listOf("glassUnion", "glassTransition")) {
      if (key in ios && (data["style"] as? JsonObject)?.text("surface") != "glass")
        return fail("$path.ios.$key", "$key requires a glass surface")
    }
    if ("backgroundExtension" in ios && data.text("type") != "image")
      return fail("$path.ios.backgroundExtension", "backgroundExtension requires an image node")
    return null
  }

  private fun nodeOnlyError(ios: JsonObject, path: String): PrototypeSpecError? {
    if (path !in setOf("window", "theme")) return null
    for (key in namespaceFields) if (key in ios)
      return fail("$path.ios.$key", "$key is only valid on a node")
    return null
  }
}
