package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeControlRules.listItemBindingErrors
import dev.jasonpearson.automobile.protocol.PrototypeNodeBindings.bindingErrors
import dev.jasonpearson.automobile.protocol.PrototypeStateBindings.boundKeys
import dev.jasonpearson.automobile.protocol.PrototypeStateBindings.sheetBindingErrors
import dev.jasonpearson.automobile.protocol.PrototypeStateBindings.stateActionErrors
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

internal object PrototypeStateChecks {
  /** A node or action; [item] is the repeat item its state keys were bound to, if any. */
  data class Located(
    val value: JsonObject,
    val path: String,
    val item: Int? = null,
    /** An action whose `value` holds a repeat placeholder: its type is not known statically. */
    val operandTemplated: Boolean = false,
  )

  fun PrototypeSpecError.forItem(item: Int?): PrototypeSpecError =
    if (item == null) this else copy(message = "$message (repeat item $item)")

  /**
   * State-type checks over every repeat instance: a node or action whose state keys hold
   * placeholders is checked once per item with those keys bound (#11051).
   */
  fun stateTypeErrors(
    value: JsonElement,
    context: Context,
    repeats: PrototypeRepeatData,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: JsonObject(emptyMap())
    val checked = stateInstances(value, context, repeats)
    context.stateBindings = checked
    return checkedStateErrors(checked, data)
  }

  fun stateInstances(
    value: JsonElement,
    context: Context,
    repeats: PrototypeRepeatData,
  ): Context {
    val scopes = PrototypeRepeatValidator.scopes(value, repeats)
    fun List<Located>.instances() = flatMap { located ->
      val templated = PrototypeRepeatValidator.operandTemplated(scopes, located.value, located.path)
      PrototypeRepeatValidator.keyInstances(scopes, located.value, located.path).map { (bound, item)
        ->
        Located(bound, located.path, item, templated)
      }
    }
    val checked = Context()
    checked.nodes.addAll(context.nodes.instances())
    checked.actions.addAll(context.actions.instances())
    checked.indexControls()
    return checked
  }

  fun checkedStateErrors(checked: Context, data: JsonObject): PrototypeSpecError? =
    bindingErrors(checked, data)
      ?: listItemBindingErrors(checked, data)
      ?: sheetBindingErrors(checked, data)
      ?: stateActionErrors(checked, data)
      ?: checkErrors(checked, data)

  fun checkErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    val keys =
      context.nodes
        .flatMap { located ->
          if ((located.value["checks"] as? JsonArray).isNullOrEmpty()) emptyList()
          else
            listOfNotNull(
                located.value.text("stateKey"),
                located.value.text("hourKey"),
                located.value.text("minuteKey"),
              )
              .filter(state::containsKey)
        }
        .toSet()
    for ((value, path) in context.nodes) {
      nodeCheckError(value, path)?.let {
        return it
      }
      conditionCheckError(value["visibleWhen"], "$path.visibleWhen", keys)?.let {
        return it
      }
      conditionCheckError(value["enabledWhen"], "$path.enabledWhen", keys)?.let {
        return it
      }
      for ((index, entry) in (value["styleWhen"] as? JsonArray).orEmpty().withIndex()) {
        conditionCheckError(
            (entry as? JsonObject)?.get("when"),
            "$path.styleWhen[$index].when",
            keys,
          )
          ?.let {
            return it
          }
      }
    }
    for ((value, path) in context.actions) {
      value["requireValid"]?.let {
        keyCheckError(it, path, keys)?.let { error ->
          return error
        }
      }
    }
    return null
  }

  fun nodeCheckError(node: JsonObject, path: String): PrototypeSpecError? {
    val checks = (node["checks"] as? JsonArray).orEmpty().map { it.jsonObject }
    for ((index, check) in checks.withIndex()) {
      val kind = check.keys.first { it != "message" }
      val at = "$path.checks[$index].$kind"
      val fits = PrototypeSpecContract.checkControls[kind]?.contains(node.text("type")) ?: true
      if (!fits) return fail(at, "Check $kind does not fit ${node.text("type")}")
      check.text("pattern")?.let {
        val result = PrototypeCheckPattern.parse(it)
        if (!result.ok) return fail(at, checkNotNull(result.message))
      }
    }
    for ((lower, upper) in listOf("min" to "max", "minLength" to "maxLength")) {
      val low = checks.mapNotNull { (it[lower] as? JsonPrimitive)?.doubleOrNull }.maxOrNull()
      val high = checks.mapNotNull { (it[upper] as? JsonPrimitive)?.doubleOrNull }.minOrNull()
      if (low != null && high != null && low > high) {
        val index = checks.indexOfFirst { (it[upper] as? JsonPrimitive)?.doubleOrNull == high }
        return fail("$path.checks[$index].$upper", "$lower exceeds $upper")
      }
    }
    return null
  }

  fun keyCheckError(
    value: JsonElement,
    path: String,
    keys: Set<String>,
  ): PrototypeSpecError? {
    val requested = if (value is JsonArray) value else listOf(value)
    return if (
      requested.any { (it as? JsonPrimitive)?.takeIf { key -> key.isString }?.content !in keys }
    )
      fail(path, "Validity key must be declared state with at least one check")
    else null
  }

  fun conditionCheckError(
    value: JsonElement?,
    path: String,
    keys: Set<String>,
  ): PrototypeSpecError? {
    val condition = value as? JsonObject ?: return null
    condition["valid"]?.let {
      return keyCheckError(it, path, keys)
    }
    condition["not"]?.let {
      return conditionCheckError(it, "$path.not", keys)
    }
    for (form in listOf("all", "any")) {
      for ((index, child) in (condition[form] as? JsonArray).orEmpty().withIndex()) {
        conditionCheckError(child, "$path.$form[$index]", keys)?.let {
          return it
        }
      }
    }
    return null
  }

  class Context {
    var root: JsonElement? = null
    var stateBindings: Context? = null
    val nodes = mutableListOf<Located>()
    val actions = mutableListOf<Located>()
    var controlsByKey: Map<String, List<Located>> = emptyMap()

    fun indexControls() {
      controlsByKey =
        nodes
          .flatMap { node -> boundKeys(node.value).distinct().map { it to node } }
          .groupBy({ it.first }, { it.second })
    }

    var images = 0
    var selectorDepth = 0
    var conditionDepth = 0
    var actionDepth = 0
  }
}
