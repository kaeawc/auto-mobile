package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeControlRules.chipErrors
import dev.jasonpearson.automobile.protocol.PrototypeControlRules.fabErrors
import dev.jasonpearson.automobile.protocol.PrototypeControlRules.progressErrors
import dev.jasonpearson.automobile.protocol.PrototypeControlRules.radioGroupErrors
import dev.jasonpearson.automobile.protocol.PrototypeControlRules.sliderErrors
import dev.jasonpearson.automobile.protocol.PrototypeControlRules.textFieldErrors
import dev.jasonpearson.automobile.protocol.PrototypeControlRules.timePickerErrors
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.isPrototypeDate
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.forItem
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.number
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isBooleanState
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isNonnegativeInteger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

internal object PrototypeNodeBindings {
  fun componentBindingErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    val stored = value.text("stateKey")?.let { state[it] as? JsonPrimitive }
    return when (value.text("type")) {
      "textField" -> textFieldErrors(value, path, stored)
      "slider" -> sliderErrors(value, path, stored)
      "chip" -> chipErrors(value, path, stored)
      "fab" -> fabErrors(value, path)
      "progress" -> progressErrors(value, path, stored)
      "timePicker" -> timePickerErrors(value, path, state)
      "datePicker" ->
        if (isPrototypeDate(stored?.takeIf { it.isString }?.content)) null
        else fail("$path.stateKey", "Date picker requires a YYYY-MM-DD state key in 1900..2100")
      else -> null
    }
  }

  /**
   * First binding rule one node breaks against [state]: the same rules for declared and written.
   */
  fun nodeBindingErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    componentBindingErrors(value, path, state)?.let {
      return it
    }
    val key = value.text("stateKey") ?: return null
    val stored = state[key] as? JsonPrimitive
    if (value.text("type") in setOf("textField", "searchBar") && stored?.isString != true)
      return fail("$path.stateKey", "Text field requires a string state key")
    searchActiveErrors(value, path, state)?.let {
      return it
    }
    if (value.text("type") in setOf("switch", "checkbox") && (!isBooleanState(stored)))
      return fail("$path.stateKey", "Toggle control requires a boolean state key")
    if (value.text("type") in setOf("radioGroup", "segmentedButton", "select")) {
      radioGroupErrors(value, path, stored)?.let {
        return it
      }
    }
    return selectionErrors(value, path, stored)
  }

  fun searchActiveErrors(value: JsonObject, path: String, state: JsonObject): PrototypeSpecError? {
    if (value.text("type") == "searchBar") {
      val active = value.text("activeKey")?.let { state[it] as? JsonPrimitive }
      if (value.text("activeKey") != null && (!isBooleanState(active)))
        return fail("$path.activeKey", "Search bar requires a boolean active key")
    }
    return null
  }

  fun selectionErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    if (value.text("type") !in setOf("tabBar", "bottomNav")) return null
    val number = stored?.takeIf { !it.isString }?.doubleOrNull
    return if (!isNonnegativeInteger(number))
      fail("$path.stateKey", "Selection requires a nonnegative integer state key")
    else null
  }

  fun bindingErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      nodeBindingErrors(value, path, state)?.let {
        return it.forItem(item)
      }
    }
    return null
  }
}
