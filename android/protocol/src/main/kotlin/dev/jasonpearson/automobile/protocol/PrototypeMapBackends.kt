package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The SDK backend capabilities a spec's `map` nodes name, from the `platformModules` table. */
internal object PrototypeMapBackends {
  /**
   * The capability a `map` node's non-default `backend` needs on top of the module's (#14302), or
   * null for the default `auto` backend or any value the table does not list.
   */
  private fun nodeBackendCapability(node: JsonObject): String? {
    if ((node["type"] as? JsonPrimitive)?.content != "map") return null
    val backend =
      (node["backend"] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString) ?: return null
    return (PrototypePlatformModules.module("map")
        ?.member("backends")
        ?.member(backend.content)
        ?.get("capability") as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content
  }

  /**
   * Backend capabilities of `map` nodes at node positions only, the twin of TypeScript's
   * `walkPrototypeNodes`: `root` and each component root, then `child`, `children`, `screens`,
   * adaptive slots and list `header`/`footer`. A map-shaped object in a payload, a request field or
   * a channel `equals` literal is data, not a node.
   */
  fun backendCapabilities(spec: JsonObject): Set<String> {
    val pending = ArrayDeque<JsonElement>()
    spec["root"]?.let(pending::add)
    (spec["components"] as? JsonObject).orEmpty().values.forEach {
      (it as? JsonObject)?.get("root")?.let(pending::add)
    }
    val found = linkedSetOf<String>()
    while (pending.isNotEmpty()) {
      val node = pending.removeLast() as? JsonObject ?: continue
      nodeBackendCapability(node)?.let(found::add)
      val type = (node["type"] as? JsonPrimitive)?.content
      for ((key, value) in node) {
        when {
          key == "child" ||
            (type == "adaptive" && key in ADAPTIVE_SLOTS) ||
            (type == "list" && (key == "header" || key == "footer")) -> pending.add(value)
          key == "children" -> (value as? JsonArray).orEmpty().forEach(pending::add)
          key == "screens" -> (value as? JsonObject).orEmpty().values.forEach(pending::add)
        }
      }
    }
    return found
  }

  private val ADAPTIVE_SLOTS = setOf("list", "detail", "content", "main", "supporting")
}
