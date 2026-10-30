package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isBooleanState
import kotlinx.serialization.json.*

internal object PrototypeAdaptiveRules {
  private val fieldsByKind =
    mapOf(
      "listDetail" to listOf("list", "detail", "selectionKey"),
      "navigationSuite" to listOf("items", "stateKey", "content"),
      "supporting" to listOf("main", "supporting", "openKey"),
    )
  private val allFields =
    listOf(
      "list",
      "detail",
      "content",
      "main",
      "supporting",
      "items",
      "selectionKey",
      "stateKey",
      "openKey",
    )

  fun error(value: JsonObject, path: String, state: JsonObject): PrototypeSpecError? {
    if (value.text("type") != "adaptive") return null
    val kind = value.text("kind")
    val fields = fieldsByKind[kind].orEmpty()
    for (field in fields) if (field !in value) return fail("$path.$field", "Required field")
    for (field in allFields) if (field in value && field !in fields)
      return fail("$path.$field", "Field is not allowed for adaptive kind")
    val field =
      when (kind) {
        "listDetail" -> "selectionKey"
        "supporting" -> "openKey"
        else -> "stateKey"
      }
    val stored = state[value.text(field)] as? JsonPrimitive
    val valid = if (field == "openKey") isBooleanState(stored) else stored?.isString == true
    val type = if (field == "openKey") "boolean" else "string"
    if (!valid) return fail("$path.$field", "Adaptive $kind requires a declared $type state key")
    return if (kind == "navigationSuite") navigationError(value, path, stored?.content) else null
  }

  private fun navigationError(
    value: JsonObject,
    path: String,
    stored: String?,
  ): PrototypeSpecError? {
    val values = mutableSetOf<String?>()
    for ((index, item) in (value["items"] as? JsonArray).orEmpty().withIndex()) {
      if (!values.add((item as? JsonObject)?.text("value")))
        return fail("$path.items[$index].value", "Duplicate adaptive item value")
    }
    return if (stored in values) null
    else fail("$path.stateKey", "Adaptive navigationSuite state must name an item value")
  }
}
