package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeDataRules.isScalarLiteral
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.blankTextPattern
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.number
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

internal object PrototypeValidationValues {
  fun isNonNumericPrimitive(value: JsonPrimitive): Boolean =
    value.isString || value == JsonNull || value.booleanOrNull != null

  fun isBooleanState(value: JsonPrimitive?): Boolean =
    value != null && !value.isString && value.booleanOrNull != null

  fun isFiniteInRange(number: Double?, min: Double, max: Double): Boolean {
    if (number == null || !number.isFinite()) return false
    return number >= min && number <= max
  }

  fun isIntegerInRange(number: Double?, max: Int): Boolean {
    if (number == null || number % 1.0 != 0.0) return false
    return number >= 0 && number <= max
  }

  fun isNonnegativeInteger(number: Double?): Boolean {
    if (number == null || !number.isFinite()) return false
    return number >= 0 && number % 1.0 == 0.0
  }

  fun isValidLiteral(value: JsonElement): Boolean =
    value is JsonPrimitive && value != JsonNull && isScalarLiteral(value)

  fun validText(text: String?, rule: JsonObject): Boolean {
    if (text == null) return false
    return (rule.flag("empty") || text.isNotEmpty()) &&
      (!rule.flag("nonblank") || !blankTextPattern.matches(text)) &&
      text.length <= rule.number("max", Double.POSITIVE_INFINITY)
  }

  fun isScalarPrimitive(value: JsonPrimitive?): Boolean =
    value != null &&
      !value.isString &&
      (value.booleanOrNull != null || value.doubleOrNull?.isFinite() == true)

  fun insideVerticalScroll(context: Context, path: String): Boolean =
    insideScroll(context, path, horizontal = false)

  /** Whether a `scroll` on the given axis encloses the node at [path]. */
  fun insideScroll(context: Context, path: String, horizontal: Boolean): Boolean =
    context.nodes.any { (ancestor, ancestorPath) ->
      ancestor.text("type") == "scroll" &&
        (ancestor.text("axis") == "horizontal") == horizontal &&
        path.startsWith("$ancestorPath.")
    }
}
