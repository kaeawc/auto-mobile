package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Reference counts use projected repeat cardinality, matching the shared validator. */
internal object PrototypeTooltipRules {
  fun tooltipErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    val counts = targetCounts(value, context)
    for ((node, path) in context.nodes) {
      if (node.text("type") != "tooltip") continue
      val target = node.text("anchorTo") ?: continue
      val count = counts[target] ?: 0
      if (count != 1 || target == node.text("id")) {
        val kind = if (count > 1) "Duplicate" else "Unknown"
        return fail("$path.anchorTo", "$kind anchorTo id ${JsonPrimitive(target)}")
      }
    }
    return null
  }

  private fun targetCounts(value: JsonElement, context: Context): Map<String, Int> {
    val scopes = PrototypeRepeatValidator.scopes(value)
    val counts = mutableMapOf<String, Int>()
    for ((node, path) in context.nodes) {
      val id = node.text("id") ?: continue
      val count = scopes.firstOrNull { path.startsWith("${it.path}.children[") }?.items?.size ?: 1
      counts[id] = (counts[id] ?: 0) + count
    }
    return counts
  }
}
