package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
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

  fun eventModule(event: String): String? {
    val (owner, member) = qualified(event) ?: return null
    return owner.takeIf { module(owner)?.member("events")?.containsKey(member) == true }
  }

  /** The module a `/platform` pointer reads: its first segment. */
  fun pointerModule(pointer: String): String =
    pointer.substring(1).substringBefore('/').replace("~1", "/").replace("~0", "~")
}
