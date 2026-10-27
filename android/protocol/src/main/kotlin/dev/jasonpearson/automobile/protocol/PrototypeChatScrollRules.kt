package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text

/**
 * Static chat-list checks the contract cannot express (#14232), the twin of TypeScript's
 * `prototypeChatScrollError`: chat options need a vertical scroll and `scrollTo` exactly one scroll
 * with its id. `atEndKey` must name a declared boolean state key; the state bindings check that per
 * repeat row and on every write.
 */
internal object PrototypeChatScrollRules {
  private val options = listOf("reverse", "stickToEnd", "atEndKey", "onStartReached")

  fun chatScrollErrors(context: Context): PrototypeSpecError? {
    val ids = mutableMapOf<String, Int>()
    for ((node, path) in context.nodes) {
      if (node.text("type") != "scroll") continue
      val option = options.firstOrNull { node.containsKey(it) }
      if (option != null && node.text("axis") == "horizontal") {
        return fail("$path.$option", "Chat scroll options need a vertical scroll")
      }
      node.text("id")?.let { ids[it] = (ids[it] ?: 0) + 1 }
    }
    return scrollToErrors(context, ids)
  }

  private fun scrollToErrors(context: Context, ids: Map<String, Int>): PrototypeSpecError? {
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
