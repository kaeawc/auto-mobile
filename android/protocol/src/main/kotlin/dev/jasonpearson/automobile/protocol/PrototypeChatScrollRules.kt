package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Static chat-list checks the contract cannot express (#14232), the twin of TypeScript's
 * `prototypeChatScrollError`: chat options need a vertical scroll, `atEndKey` a declared boolean
 * state key, and `scrollTo` exactly one scroll with its id.
 */
internal object PrototypeChatScrollRules {
  private val options = listOf("reverse", "stickToEnd", "atEndKey", "onStartReached")

  fun chatScrollErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    val state = (value as? JsonObject)?.get("state") as? JsonObject ?: JsonObject(emptyMap())
    val ids = mutableMapOf<String, Int>()
    for ((node, path) in context.nodes) {
      if (node.text("type") != "scroll") continue
      val option = options.firstOrNull { node.containsKey(it) }
      if (option != null && node.text("axis") == "horizontal") {
        return fail("$path.$option", "Chat scroll options need a vertical scroll")
      }
      val key = node.text("atEndKey")
      val stored = key?.let { state[it] as? JsonPrimitive }
      // A repeat-bound key is checked per row by the state-key bindings.
      if (
        key != null &&
          '{' !in key &&
          (stored == null || stored.isString || stored.booleanOrNull == null)
      ) {
        return fail("$path.atEndKey", "atEndKey must name a declared boolean state key")
      }
      node.text("id")?.let { ids[it] = (ids[it] ?: 0) + 1 }
    }
    for ((action, path) in context.actions) {
      if (action.text("type") != "scrollTo") continue
      val target = action.text("scroll") ?: continue
      val count = ids[target] ?: 0
      if (count != 1) {
        return fail("$path.scroll", if (count == 0) "Unknown scroll id" else "Duplicate scroll id")
      }
    }
    return null
  }
}
