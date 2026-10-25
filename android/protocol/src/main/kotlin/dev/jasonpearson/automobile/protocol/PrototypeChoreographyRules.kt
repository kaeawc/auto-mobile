package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlin.math.abs
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Choreography checks the contract cannot express (#15247), the twin of TypeScript's
 * `prototypeChoreographyError`: no child of a staggered container waits more than 600 ms in all.
 */
object PrototypeChoreographyRules {
  const val MAX_DELAY_MS = 600
  const val MAX_STAGGER_MS = 100

  /** How many steps after the first the child at [index] of [count] waits, by stagger [order]. */
  fun rank(index: Int, count: Int, order: String?): Int =
    when (order) {
      "reverse" -> count - 1 - index
      "center" -> abs(2 * index - (count - 1)) / 2
      else -> index
    }

  /**
   * The wait of each of [count] staggered children in layout order: [ms] times the rank in [order],
   * plus the child's own [childDelayMs].
   */
  fun delays(count: Int, ms: Int, order: String?, childDelayMs: (Int) -> Int): List<Int> =
    List(count) { index -> rank(index, count, order) * ms + childDelayMs(index) }

  internal fun choreographyErrors(context: Context): PrototypeSpecError? {
    val (_, path) =
      context.nodes.firstOrNull { (node) ->
        val stagger = node["stagger"] as? JsonObject
        stagger != null && longestDelayMs(node, stagger) > MAX_DELAY_MS
      } ?: return null
    return fail(
      "$path.stagger",
      "Stagger and transition delays add up to more than $MAX_DELAY_MS ms",
    )
  }

  private fun number(value: JsonElement?): Int =
    (value as? JsonPrimitive)?.doubleOrNull?.toInt() ?: 0

  /**
   * Only `visibleWhen` children are staggered, in layout order, and a literal `repeat` multiplies
   * them; a data-bound repeat has no static count, so the device clamps it instead.
   */
  private fun longestDelayMs(node: JsonObject, stagger: JsonObject): Int {
    val children =
      (node["children"] as? JsonArray).orEmpty().filter {
        (it as? JsonObject)?.containsKey("visibleWhen") == true
      }
    if (children.isEmpty()) return 0
    val items = (node["repeat"] as? JsonObject)?.get("items") as? JsonArray
    val count = children.size * (items?.size ?: 1)
    val order = (stagger["order"] as? JsonPrimitive)?.content
    return delays(count, number(stagger["ms"]), order) { index ->
        val transition = (children[index % children.size] as? JsonObject)?.get("transition")
        number((transition as? JsonObject)?.get("delayMs"))
      }
      .maxOrNull() ?: 0
  }
}
