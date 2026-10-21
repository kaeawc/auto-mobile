package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Loading-state checks the contract cannot express (#14207), the twin of TypeScript's
 * `prototypeLoadingStatesError`: `shimmer` sweeps a container's background, so only box, row,
 * column and card take it.
 */
internal object PrototypeLoadingStatesRules {
  private val shimmerTypes = setOf("box", "row", "column", "card")

  fun shimmerErrors(context: Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      if (node.text("type") in shimmerTypes) continue
      val styles =
        listOf(node["style"] to "$path.style") +
          (node["styleWhen"] as? JsonArray).orEmpty().mapIndexed { index, entry ->
            (entry as? JsonObject)?.get("style") to "$path.styleWhen[$index].style"
          }
      val at = styles.firstOrNull { (style) ->
        (style as? JsonObject)?.containsKey("shimmer") == true
      }
      if (at != null) {
        return fail("${at.second}.shimmer", "shimmer applies only to box, row, column and card")
      }
    }
    return null
  }
}
