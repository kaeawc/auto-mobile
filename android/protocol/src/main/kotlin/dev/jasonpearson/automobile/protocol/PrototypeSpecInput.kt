package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeChartRules.chartErrors
import dev.jasonpearson.automobile.protocol.PrototypeChatScrollRules.chatScrollErrors
import dev.jasonpearson.automobile.protocol.PrototypeChoreographyRules.choreographyErrors
import dev.jasonpearson.automobile.protocol.PrototypeContainerRules.pagerErrors
import dev.jasonpearson.automobile.protocol.PrototypeContainerRules.stackErrors
import dev.jasonpearson.automobile.protocol.PrototypeContainerRules.swipeActionsErrors
import dev.jasonpearson.automobile.protocol.PrototypeDataRules.dataActionErrors
import dev.jasonpearson.automobile.protocol.PrototypeLinkifyRules.linkifyErrors
import dev.jasonpearson.automobile.protocol.PrototypeLoadingStatesRules.shimmerErrors
import dev.jasonpearson.automobile.protocol.PrototypeMotionRules.motionErrors
import dev.jasonpearson.automobile.protocol.PrototypePlatformRules.platformErrors
import dev.jasonpearson.automobile.protocol.PrototypeRequestRules.requestActionErrors
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.definitions
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.json
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.numberTokenPattern
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_BYTES
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.validate
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.stateTypeErrors
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.number
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isNonNumericPrimitive
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object PrototypeSpecInput {
  fun validateInput(input: String, context: Context): PrototypeSpecValidation {
    if (input.toByteArray(Charsets.UTF_8).size > MAX_PROTOTYPE_SPEC_BYTES) {
      return PrototypeSpecValidation.Failure(fail("", "Spec byte limit exceeded"))
    }
    if (hasUnescapedControl(input)) return PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
    return try {
      val element = json.parseToJsonElement(PrototypeStrictJson.prepare(input))
      if (!validNumberTokens(element)) PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
      else validateElement(element, context)
    } catch (_: SerializationException) {
      PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
    } catch (_: IllegalArgumentException) {
      PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
    }
  }

  fun hasUnescapedControl(input: String): Boolean {
    var quoted = false
    var escaped = false
    for (character in input) {
      if (escaped) {
        escaped = false
        continue
      }
      if (quoted && character == '\\') {
        escaped = true
        continue
      }
      if (character == '"') {
        quoted = !quoted
        continue
      }
      if (quoted && character.code < 32) return true
    }
    return false
  }

  // JsonElement's tree parser retains unquoted literals; validate number tokens
  // structurally instead of relying on primitive coercion or exception messages.
  internal fun validNumberTokens(root: JsonElement): Boolean {
    val pending = ArrayDeque<JsonElement>()
    pending.add(root)
    while (pending.isNotEmpty()) {
      when (val value = pending.removeLast()) {
        is JsonObject -> pending.addAll(value.values)
        is JsonArray -> pending.addAll(value)
        is JsonPrimitive ->
          if (!isNonNumericPrimitive(value) && !numberTokenPattern.matches(value.content))
            return false
      }
    }
    return true
  }

  // Match JSON.stringify's escaped spelling of lone UTF-16 surrogates in paths
  // and byte accounting; ordinary strings use the standard JSON writer.
  fun canonicalString(value: String): String {
    val encoded = JsonPrimitive(value).toString()
    return buildString {
      for (index in encoded.indices) {
        val character = encoded[index]
        val loneHigh =
          character in '\uD800'..'\uDBFF' &&
            (index + 1 == encoded.length || encoded[index + 1] !in '\uDC00'..'\uDFFF')
        val loneLow =
          character in '\uDC00'..'\uDFFF' &&
            (index == 0 || encoded[index - 1] !in '\uD800'..'\uDBFF')
        if (loneHigh || loneLow) append("\\u" + character.code.toString(16).padStart(4, '0'))
        else append(character)
      }
    }
  }

  private fun nodeVocabularyErrors(value: JsonElement, context: Context): PrototypeSpecError? =
    platformErrors(value, context)
      ?: PrototypeTimerRules.error(context)
      ?: PrototypeScrollMotion.error(context)
      ?: motionErrors(context)
      ?: choreographyErrors(context)
      ?: shimmerErrors(context)
      ?: PrototypeStringsRules.semanticError(value, context)
      ?: chartErrors(value, context)
      ?: linkifyErrors(value, context)
      ?: chatScrollErrors(context)
      ?: PrototypeTooltipRules.tooltipErrors(value, context)

  fun validateElement(value: JsonElement, context: Context): PrototypeSpecValidation {
    context.root = value
    val repeats = PrototypeRepeatData((value as? JsonObject)?.get("data") as? JsonObject)
    val error =
      structuralError(value, context)
        ?: PrototypeKeyframesRules.validate(context)
        ?: PrototypeRepeatValidator.validate(value, repeats)
        ?: PrototypeStorageValidation.error(value.jsonObject)
        ?: dataActionErrors(context, value)
        ?: requestActionErrors(context)
        ?: nodeVocabularyErrors(value, context)
        ?: swipeActionsErrors(context)
        ?: PrototypeBarScrollRules.error(context)
        ?: pagerErrors(context)
        ?: stackErrors(context)
        ?: stateTypeErrors(value, context, repeats)
    if (error != null) return PrototypeSpecValidation.Failure(error)
    return try {
      PrototypeSpecValidation.Success(
        json.decodeFromJsonElement<PrototypeSpec>(
          stripPlatformNamespaces(
            normalizeIntegers(value, definitions.getValue("spec").jsonObject),
          ),
        ),
      )
    } catch (_: SerializationException) {
      PrototypeSpecValidation.Failure(fail("", "Internal model/contract mismatch"))
    }
  }

  private fun structuralError(value: JsonElement, context: Context): PrototypeSpecError? =
    PrototypeLazyListRules.limitError(value)
      ?: walk(value, definitions.getValue("spec").jsonObject, "", context, 0)
      ?: excludeAccessoryReferences(context)
      ?: PrototypeRouteRules.error(value.jsonObject, context)
      ?: PrototypeSharedElementRules.error(context)
      ?: gridSpanErrors(context)
      ?: PrototypeDerivedRules.error(value, context)
      ?: PrototypeContainerRules.pagerStateKeyErrors(context)
      ?: PrototypeLazyListRules.error(context)

  /** Drops nodes and actions under `ios.bottomAccessory`, which neither renderer draws. */
  fun excludeAccessoryReferences(context: Context): PrototypeSpecError? {
    val ignored =
      context.nodes
        .filter {
          (it.value["ios"] as? JsonObject)?.get("bottomAccessory") is JsonObject
        }
        .map { "${it.path}.ios.bottomAccessory" }
    fun ignoredPath(path: String): Boolean = ignored.any {
      path == it || path.startsWith("$it.") || path.startsWith("$it[")
    }
    context.nodes.removeAll { ignoredPath(it.path) }
    context.actions.removeAll { ignoredPath(it.path) }
    return null
  }

  // JSON integers include exponent/decimal spellings (1e2, 100.0). Kotlin's Int decoder
  // accepts only integer lexical tokens, so normalize validated integer fields structurally.
  fun normalizeIntegers(value: JsonElement, rule: JsonObject): JsonElement =
    when (rule.text("kind")) {
      "ref" ->
        normalizeIntegers(value, definitions.getValue(checkNotNull(rule.text("name"))).jsonObject)
      "tagged" ->
        normalizeIntegers(
          value,
          rule
            .getValue("variants")
            .jsonObject
            .getValue(checkNotNull((value as JsonObject).text("type")))
            .jsonObject,
        )
      "object" -> {
        val fields = rule.getValue("fields").jsonObject
        JsonObject(
          (value as JsonObject).mapValues { (key, child) ->
            normalizeIntegers(child, fields.getValue(key).jsonObject.getValue("rule").jsonObject)
          },
        )
      }
      "map",
      "record",
      "screenMap" ->
        JsonObject(
          (value as JsonObject).mapValues { (_, child) ->
            normalizeIntegers(child, rule.getValue("item").jsonObject)
          },
        )
      "array" ->
        JsonArray(
          (value as JsonArray).map { normalizeIntegers(it, rule.getValue("item").jsonObject) },
        )
      "choice" -> {
        val option =
          rule.getValue("options").jsonArray.first {
            walk(value, it.jsonObject, "", Context(), 0) == null
          }
        normalizeIntegers(value, option.jsonObject)
      }
      "number" ->
        if (rule.flag("integer")) JsonPrimitive(value.jsonPrimitive.double.toInt()) else value
      else -> value
    }

  /** A span belongs to the direct grid parent, including repeat templates. */
  fun gridSpanErrors(context: Context): PrototypeSpecError? {
    val parents = mutableMapOf<String, JsonObject>()
    for ((node, path) in context.nodes) {
      if (node.containsKey("span")) {
        val parent =
          parents[path] ?: return fail("$path.span", "span requires a direct grid parent")
        if (parent.text("type") != "grid") {
          return fail("$path.span", "span requires a direct grid parent")
        }
        val columns = (parent["columns"] as? JsonPrimitive)?.doubleOrNull
        if (columns != null && node.number("span", 0.0) > columns) {
          return fail("$path.span", "span exceeds grid columns")
        }
      }
      (node["children"] as? JsonArray)?.indices?.forEach { index ->
        parents["$path.children[$index]"] = node
      }
    }
    return null
  }
}
