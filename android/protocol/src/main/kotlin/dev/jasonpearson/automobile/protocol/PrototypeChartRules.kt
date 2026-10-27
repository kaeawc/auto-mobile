package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Static chart checks the contract cannot express (#14209), the twin of TypeScript's
 * `prototypeChartError`: a ring takes one series and a positive goal, a `yRange` max is above its
 * min, and a literal series path resolves to an array of objects with a numeric `y`.
 */
internal object PrototypeChartRules {
  fun chartErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    val data = (value as? JsonObject)?.get("data") as? JsonObject
    for ((node, path) in context.nodes) {
      if (node.text("type") != "chart") continue
      (ringError(node, path) ?: rangeError(node, path))?.let {
        return it
      }
      (node["series"] as? JsonArray).orEmpty().forEachIndexed { index, series ->
        seriesError(series as? JsonObject ?: return@forEachIndexed, "$path.series[$index]", data)
          ?.let {
            return it
          }
      }
    }
    return null
  }

  private fun number(element: JsonElement?): Double? =
    (element as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

  private fun ringError(node: JsonObject, path: String): PrototypeSpecError? {
    if (node.text("variant") != "ring") return null
    val series = node["series"] as? JsonArray
    if (series != null && series.size != 1) {
      return fail("$path.series", "A ring chart takes exactly one series")
    }
    val goal = number(node["goal"]) ?: return fail("$path.goal", "A ring chart needs a goal")
    return if (goal > 0) null else fail("$path.goal", "A ring chart goal must be positive")
  }

  private fun rangeError(node: JsonObject, path: String): PrototypeSpecError? {
    val range = node["yRange"] as? JsonObject ?: return null
    val min = number(range["min"]) ?: return null
    val max = number(range["max"]) ?: return null
    return if (max > min) null else fail("$path.yRange.max", "Chart yRange max must be above min")
  }

  private fun seriesError(
    series: JsonObject,
    path: String,
    data: JsonObject?,
  ): PrototypeSpecError? {
    // A repeat-bound path is bound per row by the repeat expansion.
    val pointer = series.text("path")?.takeUnless { '{' in it } ?: return null
    val points =
      PrototypeDataPointer.resolve(data, pointer) as? JsonArray
        ?: return fail("$path.path", "Chart series path does not resolve to an array")
    val y = series.text("y")
    points.forEachIndexed { index, element ->
      val point =
        element as? JsonObject
          ?: return fail("$path.path", "Chart series point $index is not an object")
      if (number(y?.let(point::get)) == null) {
        return fail("$path.y", "Chart series point $index y is not a number")
      }
    }
    return null
  }
}
