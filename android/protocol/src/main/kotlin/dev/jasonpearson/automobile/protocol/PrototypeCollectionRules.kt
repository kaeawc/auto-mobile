package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeDataRules.jsonCost
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.colorPattern
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.stateKeyPattern
import dev.jasonpearson.automobile.protocol.PrototypeSpecInput.canonicalString
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_STACK_SCREENS
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.number
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isBooleanState
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isScalarPrimitive
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.validText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object PrototypeCollectionRules {
  fun visitArray(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val array = value as? JsonArray ?: return fail(path, "Expected array")
    if (
      array.size < rule.number("min", 0.0) ||
        array.size > rule.number("max", Double.POSITIVE_INFINITY)
    ) {
      return fail(path, "Array length out of range")
    }
    val seen = mutableSetOf<JsonElement>()
    for ((index, child) in array.withIndex()) {
      val childPath = "$path[$index]"
      val error = walk(child, rule.getValue("item").jsonObject, childPath, context, depth)
      if (error != null) return error
      val canonical =
        if (child is JsonObject && child.containsKey("dp"))
          JsonPrimitive(child.getValue("dp").jsonPrimitive.double)
        else child
      if (!seen.add(canonical) && rule.flag("unique"))
        return fail(childPath, "Duplicate array value")
    }
    return null
  }

  fun visitMap(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    for (key in data.keys.sorted()) {
      val childPath = keyPath(path, key)
      if (!stateKeyPattern.matches(key)) return fail(childPath, "Invalid state key")
      val error =
        walk(data.getValue(key), rule.getValue("item").jsonObject, childPath, context, depth)
      if (error != null) return error
    }
    return null
  }

  fun visitScreenMap(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val screens = value as? JsonObject ?: return fail(path, "Expected object")
    if (screens.size !in 1..MAX_PROTOTYPE_STACK_SCREENS)
      return fail(path, "Screen count out of range")
    for (name in screens.keys.sorted()) {
      val at = "$path[${canonicalString(name)}]"
      if (name.isEmpty()) return fail(at, "Empty screen name")
      val error = walk(screens.getValue(name), rule.getValue("item").jsonObject, at, context, depth)
      if (error != null) return error
    }
    return null
  }

  fun visitRecord(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    if (data.size > rule.number("maxEntries", Double.POSITIVE_INFINITY))
      return fail(path, "Record entry limit exceeded")
    for ((key, child) in data) {
      val at = keyPath(path, key)
      if (key.isEmpty()) return fail(at, "Invalid context name")
      if (
        rule["keyPattern"] != null &&
          PrototypeSpecContract.patterns[rule.getValue("keyPattern").jsonPrimitive.content]
            ?.matches(key) != true
      )
        return fail(at, "Invalid record key")
      walk(child, rule.getValue("item").jsonObject, at, context, depth)?.let {
        return it
      }
    }
    return null
  }

  fun visitChoice(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val options = rule.getValue("options").jsonArray.map { it.jsonObject }
    val candidates = options.filter { option ->
      when (option.text("kind")) {
        "array" -> value is JsonArray
        "object" -> value is JsonObject
        "number" -> value is JsonPrimitive && !value.isString && value.doubleOrNull != null
        "scalar" -> value is JsonPrimitive && value !is JsonNull
        else -> value is JsonPrimitive && value.isString
      }
    }
    // Several options can accept the same JSON type (a hex colour or a role name are both strings).
    val errors = candidates.map { walk(value, it, path, context, depth) }
    if (errors.any { it == null }) return null
    return errors.firstOrNull() ?: fail(path, "Invalid union value")
  }

  fun numberValid(value: JsonElement, rule: JsonObject): Boolean {
    val primitive = value as? JsonPrimitive ?: return false
    if (primitive.isString) return false
    val number = primitive.doubleOrNull ?: return false
    return number.isFinite() &&
      (!rule.flag("integer") || number % 1.0 == 0.0) &&
      number >= rule.number("min", Double.NEGATIVE_INFINITY) &&
      number <= rule.number("max", Double.POSITIVE_INFINITY)
  }

  fun primitiveValid(value: JsonElement, rule: JsonObject): Boolean {
    val primitive = value as? JsonPrimitive
    val text = primitive?.takeIf { it.isString }?.content
    return when (rule.text("kind")) {
      "string",
      "key",
      "boundKey",
      "pointer",
      "color" -> textRuleValid(text, rule)
      "number" -> numberValid(value, rule)
      "boolean",
      "true",
      "scalar" -> scalarRuleValid(primitive, rule)
      "enum" -> rule.getValue("values").jsonArray.any { it == value }
      "json" -> jsonRuleValid(value, rule)
      else -> false
    }
  }

  private fun textRuleValid(text: String?, rule: JsonObject): Boolean {
    if (text == null) return false
    return when (rule.text("kind")) {
      "string" -> validText(text, rule)
      "key" -> stateKeyPattern.matches(text)
      "boundKey" -> PrototypeRepeatTemplate.isBoundKey(text)
      "pointer" -> PrototypeDataPointer.isValid(text)
      "color" -> colorPattern.matches(text)
      else -> false
    }
  }

  private fun scalarRuleValid(value: JsonPrimitive?, rule: JsonObject): Boolean =
    when (rule.text("kind")) {
      "boolean" -> isBooleanState(value)
      "true" -> isBooleanState(value) && value?.booleanOrNull == true
      "scalar" -> value?.isString == true || isScalarPrimitive(value)
      else -> false
    }

  private fun jsonRuleValid(value: JsonElement, rule: JsonObject): Boolean {
    val cost = jsonCost(value)
    return cost.isFinite() && cost <= rule.number("maxBytes", Double.POSITIVE_INFINITY)
  }
}
