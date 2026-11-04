package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** Lookups into the contract's `platformModules` table (#14294). */
internal object PrototypePlatformModules {
  private val modules: JsonObject =
    PrototypeSpecContract.contract.getValue("platformModules").jsonObject

  fun module(name: String): JsonObject? = modules[name] as? JsonObject

  fun JsonObject.member(key: String): JsonObject? = get(key) as? JsonObject

  fun JsonObject.strings(key: String): List<String> =
    (get(key) as? JsonArray).orEmpty().mapNotNull {
      (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
    }

  /** `<module>.<member>` split at its first dot, or null when either side is empty. */
  private fun qualified(name: String?): Pair<String, String>? {
    name ?: return null
    val dot = name.indexOf('.')
    return if (dot > 0 && dot < name.length - 1) name.substring(0, dot) to name.substring(dot + 1)
    else null
  }

  fun callDefinition(call: String?): Pair<String, JsonObject>? {
    val (owner, op) = qualified(call) ?: return null
    val definition = module(owner)?.member("calls")?.member(op) ?: return null
    return owner to definition
  }

  /** The capability a call needs on top of its module's, when its definition names one. */
  fun callCapability(call: String?): String? =
    (callDefinition(call)?.second?.get("capability") as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content

  /**
   * The capability a `map` node's non-default `backend` needs on top of the module's (#14302), or
   * null for the default `auto` backend or any value the table does not list.
   */
  private fun nodeBackendCapability(node: JsonObject): String? {
    if ((node["type"] as? JsonPrimitive)?.content != "map") return null
    val backend =
      (node["backend"] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString) ?: return null
    return (module("map")?.member("backends")?.member(backend.content)?.get("capability")
        as? JsonPrimitive)
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

  fun eventModule(event: String): String? {
    val (owner, member) = qualified(event) ?: return null
    return owner.takeIf { module(owner)?.member("events")?.containsKey(member) == true }
  }

  /** An `event`'s contract definition, or null when its module does not declare it. */
  fun eventDefinition(event: String): JsonObject? {
    val (owner, member) = qualified(event) ?: return null
    return module(owner)?.member("events")?.member(member)
  }

  /** The capability an `event` handler needs beyond its module's, when its definition names one. */
  fun eventCapability(event: String): String? =
    (eventDefinition(event)?.get("capability") as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content

  /** Whether a call's contract definition is marked `sensitive` (R1). */
  fun sensitiveCall(call: String?): Boolean =
    callDefinition(call)?.second?.flag("sensitive") == true

  /** The module a `/platform` pointer reads: its first segment. */
  fun pointerModule(pointer: String): String =
    pointer.substring(1).substringBefore('/').replace("~1", "/").replace("~0", "~")
}
