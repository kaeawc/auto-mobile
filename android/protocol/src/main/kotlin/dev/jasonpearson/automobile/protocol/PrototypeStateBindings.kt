package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeControlRules.trailingErrors
import dev.jasonpearson.automobile.protocol.PrototypeNodeBindings.nodeBindingErrors
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.forItem
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isBooleanState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

internal object PrototypeStateBindings {
  /** Nodes opened by a boolean `openWhen` key; an existing key must hold a boolean. */
  val modalNames =
    mapOf(
      "bottomSheet" to "Sheet",
      "dialog" to "Dialog",
      "snackbar" to "Snackbar",
      "menu" to "Menu",
      "tooltip" to "Tooltip",
      "drawer" to "Drawer",
    )

  fun openWhenErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    val name = modalNames[value.text("type")] ?: return null
    val key = (value["openWhen"] as? JsonObject)?.text("key") ?: return null
    val stored = state[key] as? JsonPrimitive
    return if (state.containsKey(key) && (!isBooleanState(stored)))
      fail("$path.openWhen.key", "$name requires a boolean state key")
    else null
  }

  /** Pull-to-refresh needs a vertical scroll, and its declared key must hold a boolean. */
  fun refreshErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    if (value.text("type") !in setOf("scroll", "list")) return null
    val refresh = value["refresh"] as? JsonObject ?: return null
    if (value.text("axis") == "horizontal")
      return fail("$path.refresh", "Pull-to-refresh needs a vertical ${value.text("type")}")
    val key = refresh.text("stateKey") ?: return null
    val stored = state[key] as? JsonPrimitive
    return if ((state.containsKey(key) || value.text("type") == "list") && !isBooleanState(stored))
      fail("$path.refresh.stateKey", "Refresh requires a boolean state key")
    else null
  }

  /** A chat scroll's `atEndKey` (#14232) must name a declared boolean state key. */
  fun atEndKeyErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    if (value.text("type") != "scroll") return null
    val key = value.text("atEndKey") ?: return null
    return if (!isBooleanState(state[key] as? JsonPrimitive))
      fail("$path.atEndKey", "atEndKey must name a declared boolean state key")
    else null
  }

  fun sheetBindingErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      (openWhenErrors(value, path, state)
          ?: refreshErrors(value, path, state)
          ?: atEndKeyErrors(value, path, state))
        ?.let {
          return it.forItem(item)
        }
    }
    return null
  }

  /** First binding rule the node breaks; the same rules that check the declared state. */
  fun controlErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? =
    nodeBindingErrors(value, path, state)
      ?: trailingErrors(value, path, state)
      ?: openWhenErrors(value, path, state)
      ?: refreshErrors(value, path, state)
      ?: atEndKeyErrors(value, path, state)

  /** Every state key a node binds: `stateKey`, time picker keys, a trailing control, `openWhen`. */
  fun boundKeys(value: JsonObject): List<String> =
    listOfNotNull(
      value.text("stateKey"),
      value.text("activeKey"),
      value.text("hourKey"),
      value.text("minuteKey"),
      (value["trailing"] as? JsonObject)?.text("stateKey"),
      if (value.text("type") in modalNames) (value["openWhen"] as? JsonObject)?.text("key")
      else null,
      if (value.text("type") in setOf("scroll", "list"))
        (value["refresh"] as? JsonObject)?.text("stateKey")
      else null,
      if (value.text("type") == "scroll") value.text("atEndKey") else null,
    )

  /**
   * A `setState` must leave every control bound to its key valid, so the key is checked as if the
   * value were the declared state (#11452). A key no control binds, a key bound by controls of
   * different types, and a repeat-templated value are not checked.
   */
  fun setStateBindingErrors(
    action: Located,
    context: Context,
    state: JsonObject,
  ): PrototypeSpecError? {
    val key = action.value.text("key") ?: return null
    val raw = action.value["value"]
    // A linkify `{match}` (#14233) writes the matched text, so it is checked as a string.
    val written =
      if (PrototypeLinkify.isMatchBinding(raw)) JsonPrimitive("") else raw as? JsonPrimitive
    if (written == null || action.operandTemplated) return null
    val controls = context.controlsByKey[key].orEmpty()
    if (controls.map { it.value.text("type") }.toSet().size != 1) return null
    val after = JsonObject(state + (key to written))
    for (control in controls) {
      val error = controlErrors(control.value, control.path, after) ?: continue
      return fail(
        "${action.path}.value",
        "setState value does not fit the control bound to \"$key\": ${error.message}",
      )
    }
    return null
  }

  /**
   * `statusKey` (on `request` and `platform`) must be a declared state key holding a string,
   * because the runtime writes `loading`, `success` and `error` to it.
   */
  fun requestStatusKeyError(
    action: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    requestProgressKeyError(action, path, state)?.let {
      return it
    }
    val key = action.text("statusKey") ?: return null
    if (!state.containsKey(key))
      return fail("$path.statusKey", "statusKey must name a declared state key")
    val stored = state.getValue(key) as? JsonPrimitive
    return if (stored != null && stored.isString) null
    else fail("$path.statusKey", "statusKey requires a string state key")
  }

  private fun requestProgressKeyError(
    action: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    if (action.text("type") != "request") return null
    val key = action.text("progressKey") ?: return null
    val body = action["body"] as? JsonObject
    if (listOf("multipart", "form", "file").none { body?.containsKey(it) == true })
      return fail("$path.progressKey", "progressKey requires an upload body")
    val stored = state[key] as? JsonPrimitive
    val number = stored?.takeUnless { it.isString }?.doubleOrNull
    return if (number != null && number.isFinite() && number in 0.0..100.0) null
    else fail("$path.progressKey", "progressKey requires a declared number state key from 0 to 100")
  }

  fun stateActionErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for (action in context.actions) {
      val (value, path, item) = action
      if (value.text("type") == "setState") {
        setStateBindingErrors(action, context, state)?.let {
          return it.forItem(item)
        }
        continue
      }
      if (value.text("type") == "request" || value.text("type") == "platform") {
        requestStatusKeyError(value, path, state)?.let {
          return it.forItem(item)
        }
        continue
      }
      val message = stateOperationMessage(value, state)
      if (message != null) return fail("$path.key", message).forItem(item)
    }
    return null
  }

  fun stateOperationMessage(value: JsonObject, state: JsonObject): String? {
    val stored = state[value.text("key") ?: return null] as? JsonPrimitive
    return when (value.text("type")) {
      "toggle" ->
        "Toggle requires a boolean state key"
          .takeIf {
            !isBooleanState(stored)
          }
      "increment" ->
        "Increment requires a numeric state key"
          .takeIf {
            stored == null || stored.isString || stored.doubleOrNull?.isFinite() != true
          }
      "decrement" ->
        "Decrement requires a numeric state key"
          .takeIf {
            stored == null || stored.isString || stored.doubleOrNull?.isFinite() != true
          }
      else -> null
    }
  }
}
