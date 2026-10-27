package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.forItem
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.number
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isBooleanState
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isFiniteInRange
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isIntegerInRange
import kotlin.math.abs
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

internal object PrototypeControlRules {
  /** A radio group or segmented button binds a string key to one of its unique option values. */
  fun radioGroupErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    val name =
      when (value.text("type")) {
        "segmentedButton" -> "Segmented button"
        "select" -> "Select"
        else -> "Radio group"
      }
    if (stored == null || !stored.isString)
      return fail("$path.stateKey", "$name requires a string state key")
    val values = mutableSetOf<String?>()
    for ((index, option) in (value["options"] as? JsonArray).orEmpty().withIndex()) {
      if (!values.add((option as? JsonObject)?.text("value")))
        return fail(
          "$path.options[$index].value",
          if (value.text("type") == "select") "Duplicate select option value"
          else "Duplicate radio option value",
        )
    }
    return null
  }

  /** A list item's trailing switch or checkbox binds a boolean, like the standalone controls. */
  fun trailingErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    if (value.text("type") != "listItem") return null
    val key = (value["trailing"] as? JsonObject)?.text("stateKey") ?: return null
    val stored = state[key] as? JsonPrimitive
    return if (!isBooleanState(stored))
      fail("$path.trailing.stateKey", "Toggle control requires a boolean state key")
    else null
  }

  fun listItemBindingErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      trailingErrors(value, path, state)?.let {
        return it.forItem(item)
      }
    }
    return null
  }

  fun stepFitsRange(step: Double, range: Double): Boolean {
    val count = range / step
    return step > 0 && count >= 1 && abs(count - Math.round(count)) < 1e-9
  }

  /** Slider range, step and bound-value checks; the contract only types the individual fields. */
  fun sliderErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    fun JsonObject.double(key: String) = (get(key) as? JsonPrimitive)?.doubleOrNull
    val min = value.double("min")
    val max = value.double("max")
    val step = value.double("step")
    if (min == null || max == null || min >= max)
      return fail("$path.max", "Slider max must be greater than min")
    if (step != null && !stepFitsRange(step, max - min))
      return fail("$path.step", "Slider step must be positive and divide the range evenly")
    val number = stored?.takeIf { !it.isString }?.doubleOrNull
    if (!isFiniteInRange(number, min, max))
      return fail("$path.stateKey", "Slider requires a numeric state key within min and max")
    return null
  }

  /** A filter chip is a boolean toggle; an assist chip only runs its actions. */
  fun chipErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    val bound = value.text("stateKey") != null
    val variant = value.text("variant")
    if (variant == "filter" && !bound)
      return fail("$path.stateKey", "Filter chip requires a boolean state key")
    if (variant != null && variant != "filter" && bound)
      return fail("$path.stateKey", "Only a filter chip can bind a state key")
    if (bound && (!isBooleanState(stored)))
      return fail("$path.stateKey", "Filter chip requires a boolean state key")
    return null
  }

  /** An extended FAB (one with a label) has a single size, so `size` applies only to icon FABs. */
  fun fabErrors(value: JsonObject, path: String): PrototypeSpecError? =
    if (value.text("label") != null && value.containsKey("size"))
      fail("$path.size", "Extended FAB cannot set size")
    else null

  /**
   * A bound progress indicator is determinate over 0..max (default 1); unbound is indeterminate.
   */
  fun progressErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    if (value.text("stateKey") == null)
      return if (value.containsKey("max")) fail("$path.max", "Requires stateKey") else null
    val max = (value["max"] as? JsonPrimitive)?.doubleOrNull ?: 1.0
    if (max <= 0) return fail("$path.max", "Progress max must be greater than 0")
    val number = stored?.takeIf { !it.isString }?.doubleOrNull
    if (!isFiniteInRange(number, 0.0, max))
      return fail("$path.stateKey", "Progress requires a numeric state key within 0 and max")
    return null
  }

  /** A time picker binds two distinct integer keys: hour 0..23 and minute 0..59. */
  fun timePickerErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    for ((field, max, unit) in
      listOf(Triple("hourKey", 23, "hour"), Triple("minuteKey", 59, "minute"))) {
      val stored = value.text(field)?.let { state[it] as? JsonPrimitive }
      val number = stored?.takeIf { !it.isString }?.doubleOrNull
      if (!isIntegerInRange(number, max))
        return fail("$path.$field", "Time picker $unit requires an integer 0..$max state key")
    }
    return if (value.text("hourKey") == value.text("minuteKey"))
      fail("$path.minuteKey", "Time picker hour and minute keys must differ")
    else null
  }

  /** Individual fields are contract-typed; relationships follow the host's textFieldErrors. */
  fun textFieldErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    if (stored?.isString != true)
      return fail("$path.stateKey", "Text field requires a string state key")
    val lineField = listOf("minLines", "maxLines").firstOrNull { value.containsKey(it) }
    if (!value.flag("multiline") && lineField != null)
      return fail("$path.$lineField", "Requires multiline: true")
    if (
      value.flag("multiline") && (value.flag("secure") || value.text("keyboardType") == "password")
    )
      return fail("$path.multiline", "Multiline text cannot be secure")
    val imeField = listOf("imeAction", "onSubmit").firstOrNull { value.containsKey(it) }
    if (value.flag("multiline") && imeField != null)
      return fail("$path.$imeField", "Multiline text has no IME action")
    val minLines = (value["minLines"] as? JsonPrimitive)?.intOrNull
    val maxLines = (value["maxLines"] as? JsonPrimitive)?.intOrNull
    if (minLines != null && maxLines != null && minLines > maxLines)
      return fail("$path.minLines", "minLines cannot exceed maxLines")
    val maxLength = (value["maxLength"] as? JsonPrimitive)?.intOrNull
    if (maxLength != null && stored.content.length > maxLength)
      return fail("$path.stateKey", "Text field value exceeds maxLength")
    return null
  }
}
