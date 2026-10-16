package dev.jasonpearson.automobile.protocol

import kotlin.math.abs
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Canonical errors are computed from JSON structure, never from decoder exception strings. */
data class PrototypeSpecError(val path: String, val message: String)

sealed class PrototypeSpecValidation {
  data class Success(val spec: PrototypeSpec) : PrototypeSpecValidation()

  data class Failure(val error: PrototypeSpecError) : PrototypeSpecValidation()
}

/** Prepared rules for successive states of one unchanged spec structure. */
fun interface PrototypeStateWriteValidator {
  fun validate(state: Map<String, PrototypeScalar>): PrototypeSpecError?
}

object PrototypeSpecValidator {
  private val pathKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
  internal val stateKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")
  private val colorPattern = Regex("^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
  private val blankTextPattern =
    Regex(
      "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$",
    )
  private val numberTokenPattern = Regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$")
  internal val json = Json { ignoreUnknownKeys = false }
  private val contract: JsonObject =
    json
      .parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json")) {
            "Missing prototype structural contract"
          }
          .bufferedReader()
          .use { it.readText() },
      )
      .jsonObject
  private val definitions = contract.getValue("definitions").jsonObject
  private val limits = contract.getValue("limits").jsonObject
  val MAX_PROTOTYPE_TEXT_SPANS: Int = limit("MAX_PROTOTYPE_TEXT_SPANS")
  val MAX_PROTOTYPE_NODES: Int = limit("MAX_PROTOTYPE_NODES")
  val MAX_PROTOTYPE_PAGER_DP: Int = limit("MAX_PROTOTYPE_PAGER_DP")
  val MAX_PROTOTYPE_DEPTH: Int = limit("MAX_PROTOTYPE_DEPTH")
  val MAX_PROTOTYPE_IMAGES: Int = limit("MAX_PROTOTYPE_IMAGES")
  val MAX_PROTOTYPE_SPEC_BYTES: Int = limit("MAX_PROTOTYPE_SPEC_BYTES")
  val MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES: Int = limit("MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES")
  val MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES: Int = limit("MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES")
  val MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH: Int = limit("MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH")
  val MAX_PROTOTYPE_SELECTOR_DEPTH: Int = limit("MAX_PROTOTYPE_SELECTOR_DEPTH")
  val MAX_PROTOTYPE_CONDITION_DEPTH: Int = limit("MAX_PROTOTYPE_CONDITION_DEPTH")
  val MAX_PROTOTYPE_PATCH_OPS: Int = limit("MAX_PROTOTYPE_PATCH_OPS")
  val MAX_PROTOTYPE_DATA_BYTES: Int = limit("MAX_PROTOTYPE_DATA_BYTES")
  val MAX_PROTOTYPE_DATA_WRITE_BYTES: Int = limit("MAX_PROTOTYPE_DATA_WRITE_BYTES")
  val MAX_PROTOTYPE_STORAGE_BYTES: Int = limit("MAX_PROTOTYPE_STORAGE_BYTES")
  val MAX_PROTOTYPE_STORAGE_KEYS: Int = limit("MAX_PROTOTYPE_STORAGE_KEYS")
  val MAX_PROTOTYPE_DATA_DEPTH: Int = limit("MAX_PROTOTYPE_DATA_DEPTH")
  val MAX_PROTOTYPE_DATA_ARRAY_ITEMS: Int = limit("MAX_PROTOTYPE_DATA_ARRAY_ITEMS")
  val MAX_PROTOTYPE_REPEAT_PATH_CELLS: Int = limit("MAX_PROTOTYPE_REPEAT_PATH_CELLS")
  val MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH: Int = limit("MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH")
  val MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL: Int = limit("MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL")
  val MAX_PROTOTYPE_DATA_POINTER_LENGTH: Int = limit("MAX_PROTOTYPE_DATA_POINTER_LENGTH")
  val MAX_PROTOTYPE_STACK_SCREENS: Int = limit("MAX_PROTOTYPE_STACK_SCREENS")
  val MAX_PROTOTYPE_STACK_DEPTH: Int = limit("MAX_PROTOTYPE_STACK_DEPTH")
  internal val maxRepeatItems: Int =
    definitions
      .getValue("repeat")
      .jsonObject
      .getValue("fields")
      .jsonObject
      .getValue("items")
      .jsonObject
      .getValue("rule")
      .jsonObject
      .getValue("options")
      .jsonArray
      .first { it.jsonObject.text("kind") == "array" }
      .jsonObject
      .getValue("max")
      .jsonPrimitive
      .int
  val nodeTypes: Set<String> = variants("node")
  val actionTypes: Set<String> = variants("action")
  val placementTypes: Set<String> = variants("placement")

  private fun limit(name: String) = limits.getValue(name).jsonPrimitive.int

  private fun variants(name: String) =
    definitions.getValue(name).jsonObject.getValue("variants").jsonObject.keys

  fun validate(input: String): PrototypeSpecValidation = validate(input, Context())

  private fun validate(input: String, context: Context): PrototypeSpecValidation {
    if (input.toByteArray(Charsets.UTF_8).size > MAX_PROTOTYPE_SPEC_BYTES) {
      return PrototypeSpecValidation.Failure(fail("", "Spec byte limit exceeded"))
    }
    if (hasUnescapedControl(input)) return PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
    return try {
      val element = json.parseToJsonElement(input)
      if (!validNumberTokens(element)) PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
      else validateElement(element, context)
    } catch (_: SerializationException) {
      PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
    } catch (_: IllegalArgumentException) {
      PrototypeSpecValidation.Failure(fail("", "Invalid JSON"))
    }
  }

  /** The caller supplies the same compact encoder it uses for full-spec writes. */
  fun prepareStateWrites(spec: PrototypeSpec, encoder: Json): PrototypeStateWriteValidator {
    val encoded =
      try {
        encoder.encodeToString(PrototypeSpec.serializer(), spec)
      } catch (_: IllegalArgumentException) {
        // An unserializable base may become serializable when the write replaces its state.
        // Defer to the full write path, which preserves its original exception or validation error.
        return fullStateWrites(spec, encoder)
      }
    val context = Context()
    if (validate(encoded, context) !is PrototypeSpecValidation.Success) {
      return fullStateWrites(spec, encoder)
    }
    val value = checkNotNull(context.root).jsonObject
    val checked = checkNotNull(context.stateBindings)
    // Only bindings can change their verdict. Static-only nodes/actions passed full validation.
    checked.nodes.removeAll {
      boundKeys(it.value).isEmpty() &&
        it.value["enabledWhen"] == null &&
        it.value["visibleWhen"] == null &&
        it.value["styleWhen"] == null
    }
    checked.actions.removeAll {
      it.value.text("type") !in stateWriteActionTypes && it.value["requireValid"] == null
    }
    val serializer = MapSerializer(String.serializer(), PrototypeScalar.serializer())
    // An omitted state adds its field name and comma; a present state replaces only its value.
    // Compact serialization preserves all non-state bytes, including UTF-8 and escaped strings.
    val fixedBytes =
      encoded.toByteArray(Charsets.UTF_8).size -
        (value["state"]?.toString()?.toByteArray(Charsets.UTF_8)?.size ?: -",\"state\":".length)
    val stateRule =
      definitions
        .getValue("spec")
        .jsonObject
        .getValue("fields")
        .jsonObject
        .getValue("state")
        .jsonObject
        .getValue("rule")
        .jsonObject
    return PrototypeStateWriteValidator { state ->
      // Encoding first preserves serialization exceptions, including non-finite numbers.
      val encodedState = encoder.encodeToString(serializer, state)
      if (fixedBytes + encodedState.toByteArray(Charsets.UTF_8).size > MAX_PROTOTYPE_SPEC_BYTES) {
        fail("", "Spec byte limit exceeded")
      } else {
        val stored = json.parseToJsonElement(encodedState)
        if (!validNumberTokens(stored)) fail("", "Invalid JSON")
        else
          walk(stored, stateRule, "state", Context(), 0)
            ?: checkedStateErrors(checked, buildJsonObject { put("state", stored) })
      }
    }
  }

  private val stateWriteActionTypes = setOf("setState", "toggle", "increment", "decrement")

  private fun fullStateWrites(spec: PrototypeSpec, encoder: Json) =
    PrototypeStateWriteValidator { state ->
      (validate(encoder.encodeToString(PrototypeSpec.serializer(), spec.copy(state = state)))
          as? PrototypeSpecValidation.Failure)
        ?.error
    }

  // JsonElement's tree parser retains unquoted literals; validate number tokens
  // structurally instead of relying on primitive coercion or exception messages.
  private fun validNumberTokens(root: JsonElement): Boolean {
    val pending = ArrayDeque<JsonElement>()
    pending.add(root)
    while (pending.isNotEmpty()) {
      when (val value = pending.removeLast()) {
        is JsonObject -> pending.addAll(value.values)
        is JsonArray -> pending.addAll(value)
        is JsonPrimitive ->
          if (
            !value.isString &&
              value != JsonNull &&
              value.booleanOrNull == null &&
              !numberTokenPattern.matches(value.content)
          )
            return false
      }
    }
    return true
  }

  private fun hasUnescapedControl(input: String): Boolean {
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

  // Match JSON.stringify's escaped spelling of lone UTF-16 surrogates in paths
  // and byte accounting; ordinary strings use the standard JSON writer.
  private fun canonicalString(value: String): String {
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

  private fun validateElement(value: JsonElement, context: Context): PrototypeSpecValidation {
    context.root = value
    val repeats = PrototypeRepeatData((value as? JsonObject)?.get("data") as? JsonObject)
    val error =
      walk(value, definitions.getValue("spec").jsonObject, "", context, 0)
        ?: gridSpanErrors(context)
        ?: PrototypeRepeatValidator.validate(value, repeats)
        ?: dataActionErrors(context, value)
        ?: pagerErrors(context)
        ?: stackErrors(context)
        ?: stateTypeErrors(value, context, repeats)
    if (error != null) return PrototypeSpecValidation.Failure(error)
    return try {
      PrototypeSpecValidation.Success(
        json.decodeFromJsonElement<PrototypeSpec>(
          normalizeIntegers(value, definitions.getValue("spec").jsonObject),
        ),
      )
    } catch (_: SerializationException) {
      PrototypeSpecValidation.Failure(fail("", "Internal model/contract mismatch"))
    }
  }

  /** A span belongs to the direct grid parent, including repeat templates. */
  private fun gridSpanErrors(context: Context): PrototypeSpecError? {
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

  // JSON integers include exponent/decimal spellings (1e2, 100.0). Kotlin's Int decoder
  // accepts only integer lexical tokens, so normalize validated integer fields structurally.
  private fun normalizeIntegers(value: JsonElement, rule: JsonObject): JsonElement =
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
      "number" ->
        if (rule.flag("integer")) JsonPrimitive(value.jsonPrimitive.double.toInt()) else value
      else -> value
    }

  /** A node or action; [item] is the repeat item its state keys were bound to, if any. */
  private data class Located(
    val value: JsonObject,
    val path: String,
    val item: Int? = null,
    /** An action whose `value` holds a repeat placeholder: its type is not known statically. */
    val operandTemplated: Boolean = false,
  )

  private fun PrototypeSpecError.forItem(item: Int?): PrototypeSpecError =
    if (item == null) this else copy(message = "$message (repeat item $item)")

  /**
   * State-type checks over every repeat instance: a node or action whose state keys hold
   * placeholders is checked once per item with those keys bound (#11051).
   */
  private fun stateTypeErrors(
    value: JsonElement,
    context: Context,
    repeats: PrototypeRepeatData,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: JsonObject(emptyMap())
    val checked = stateInstances(value, context, repeats)
    context.stateBindings = checked
    return checkedStateErrors(checked, data)
  }

  private fun stateInstances(
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

  private fun checkedStateErrors(checked: Context, data: JsonObject): PrototypeSpecError? =
    bindingErrors(checked, data)
      ?: listItemBindingErrors(checked, data)
      ?: sheetBindingErrors(checked, data)
      ?: stateActionErrors(checked, data)
      ?: checkErrors(checked, data)

  private fun checkErrors(context: Context, data: JsonObject): PrototypeSpecError? {
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

  private fun nodeCheckError(node: JsonObject, path: String): PrototypeSpecError? {
    val checks = (node["checks"] as? JsonArray).orEmpty().map { it.jsonObject }
    for ((index, check) in checks.withIndex()) {
      val kind = check.keys.first { it != "message" }
      val at = "$path.checks[$index].$kind"
      val fits =
        when (kind) {
          "minLength",
          "maxLength",
          "format",
          "pattern" -> node.text("type") == "textField"
          "min",
          "max" -> node.text("type") in setOf("slider", "datePicker", "timePicker")
          else -> true
        }
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

  private fun keyCheckError(
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

  private fun conditionCheckError(
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

  private class Context {
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
  }

  private fun fail(path: String, message: String) =
    PrototypeSpecError(path.ifEmpty { "$" }, message)

  private fun keyPath(path: String, key: String): String =
    if (pathKeyPattern.matches(key)) {
      if (path.isEmpty()) key else "$path.$key"
    } else "${path.ifEmpty { "$" }}[${canonicalString(key)}]"

  private fun JsonObject.flag(key: String): Boolean =
    (get(key) as? JsonPrimitive)?.booleanOrNull == true

  private fun JsonObject.number(key: String, fallback: Double): Double =
    (get(key) as? JsonPrimitive)?.doubleOrNull ?: fallback

  private fun JsonObject.text(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun walk(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? =
    when (rule.text("kind")) {
      "ref" -> visitReference(value, rule, path, context, depth)
      "tagged" -> visitTagged(value, rule, path, context, depth)
      "object" -> visitObject(value, rule, path, context, depth)
      "array" -> visitArray(value, rule, path, context, depth)
      "map" -> visitMap(value, rule, path, context, depth)
      "screenMap" -> visitScreenMap(value, rule, path, context, depth)
      "record" -> visitRecord(value, rule, path, context, depth)
      "choice" -> visitChoice(value, rule, path, context, depth)
      "data" -> dataError(value)
      else ->
        if (primitiveValid(value, rule)) null
        else
          fail(path, "Invalid ${rule.text("kind").takeUnless { it == "boundKey" } ?: "key"} value")
    }

  private fun visitReference(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val target = definitions.getValue(checkNotNull(rule.text("name"))).jsonObject
    if (rule.text("name") == "container") return visitContainer(value, target, path, context, depth)
    val itemImages =
      if (rule.text("name") == "item") prototypeImageSlotUses((value as? JsonObject)?.get("image"))
      else 0
    if (itemImages > 0) {
      context.images += itemImages
      if (context.images > MAX_PROTOTYPE_IMAGES) return fail("$path.image", "Image limit exceeded")
    }
    if (rule.text("name") == "condition") return visitCondition(value, target, path, context, depth)
    if (rule.text("name") != "node") return walk(value, target, path, context, depth)
    val node = value as? JsonObject ?: return fail(path, "Expected object")
    context.nodes.add(Located(node, path))
    if (context.nodes.size > MAX_PROTOTYPE_NODES) return fail(path, "Node limit exceeded")
    if (depth + 1 > MAX_PROTOTYPE_DEPTH) return fail(path, "Tree depth limit exceeded")
    if (node.text("type") == "image")
      context.images += maxOf(1, prototypeImageSlotUses(node["asset"]))
    if (context.images > MAX_PROTOTYPE_IMAGES) return fail(path, "Image limit exceeded")
    return walk(value, target, path, context, depth + 1)
  }

  private fun visitContainer(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    context.selectorDepth++
    if (context.selectorDepth > MAX_PROTOTYPE_SELECTOR_DEPTH)
      return fail(path, "Selector depth limit exceeded")
    val error = walk(value, target, path, context, depth)
    context.selectorDepth--
    return error
  }

  private fun visitCondition(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    context.conditionDepth++
    if (context.conditionDepth > MAX_PROTOTYPE_CONDITION_DEPTH)
      return fail(path, "Condition depth limit exceeded")
    val error = walk(value, target, path, context, depth)
    context.conditionDepth--
    return error
  }

  private fun visitTagged(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    val variant =
      rule.getValue("variants").jsonObject[data.text("type")] as? JsonObject
        ?: return fail(keyPath(path, "type"), "Unknown or missing discriminator")
    if (rule === definitions["action"]) context.actions.add(Located(data, path))
    return walk(data, variant, path, context, depth)
  }

  private fun visitObject(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    // Text constraints precede field walking, matching the host's first-error ordering.
    if (rule === definitions.getValue("node").jsonObject.getValue("variants").jsonObject["text"]) {
      val exactlyOne = rule.getValue("exactlyOne").jsonArray
      if (exactlyOne.count { data.containsKey(it.jsonPrimitive.content) } != 1) {
        val spans = data.containsKey("spans")
        return fail(
          keyPath(path, if (spans) "spans" else "text"),
          if (spans) "text and spans cannot both be set" else "text node needs text or spans",
        )
      }
      if ((data["spans"] as? JsonArray)?.size?.let { it > MAX_PROTOTYPE_TEXT_SPANS } == true)
        return fail(keyPath(path, "spans"), "Text span limit exceeded")
    }
    val fields = rule.getValue("fields").jsonObject
    if (data.text("type") == "searchBar" && "child" in data && "activeKey" !in data)
      return fail("$path.child", "Search bar child requires activeKey")
    for (key in (data.keys + fields.keys).sorted()) {
      val childPath = keyPath(path, key)
      val field = fields[key] as? JsonObject ?: return fail(childPath, "Unknown property")
      val child = data[key]
      if (child == null) {
        if (!field.flag("optional")) return fail(childPath, "Required property")
        continue
      }
      val error = walk(child, field.getValue("rule").jsonObject, childPath, context, depth)
      if (error != null) return error
    }
    return objectConstraint(data, rule, path)
  }

  private fun objectConstraint(
    data: JsonObject,
    rule: JsonObject,
    path: String,
  ): PrototypeSpecError? {
    if (rule.flag("binding") && data.containsKey("pager") == data.containsKey("stateKey")) {
      return fail(keyPath(path, "pager"), "Exactly one of pager or stateKey is required")
    }
    val exclusive = rule["exclusive"] as? JsonArray
    if (exclusive != null && exclusive.count { data.containsKey(it.jsonPrimitive.content) } != 1) {
      return fail(
        keyPath(path, exclusive.first().jsonPrimitive.content),
        "Exactly one container selector is required",
      )
    }
    formConstraint(data, rule, path)?.let {
      return it
    }
    if (rule.flag("atLeastOne") && data.isEmpty())
      return fail(path, "At least one selector field is required")
    return null
  }

  /** `exactlyOne` picks one form of a union-like object; `dependents` ties fields to a trigger. */
  private fun formConstraint(
    data: JsonObject,
    rule: JsonObject,
    path: String,
  ): PrototypeSpecError? {
    val exactlyOne = (rule["exactlyOne"] as? JsonArray)?.map { it.jsonPrimitive.content }
    if (exactlyOne != null && exactlyOne.count { data.containsKey(it) } != 1) {
      return fail(
        keyPath(path, exactlyOne.first()),
        "Exactly one of ${exactlyOne.joinToString(", ")} is required",
      )
    }
    val dependents = rule["dependents"] as? JsonObject ?: return null
    for ((trigger, names) in dependents) {
      val fields = names.jsonArray.map { it.jsonPrimitive.content }
      val present = fields.filter { data.containsKey(it) }
      if (trigger.split("|").none { data.containsKey(it) }) {
        if (present.isNotEmpty())
          return fail(
            keyPath(path, present.first()),
            "Requires ${trigger.split("|").joinToString(" or ")}",
          )
      } else if (present.size != 1) {
        return fail(
          keyPath(path, present.getOrNull(1) ?: fields.first()),
          "Exactly one of ${fields.joinToString(", ")} is required",
        )
      }
    }
    return null
  }

  private fun visitArray(
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

  private fun visitMap(
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

  private fun visitScreenMap(
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

  private fun visitRecord(
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
      walk(child, rule.getValue("item").jsonObject, at, context, depth)?.let {
        return it
      }
    }
    return null
  }

  private fun visitChoice(
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
        else -> value is JsonPrimitive && value.isString
      }
    }
    // Several options can accept the same JSON type (a hex colour or a role name are both strings).
    val errors = candidates.map { walk(value, it, path, context, depth) }
    if (errors.any { it == null }) return null
    return errors.firstOrNull() ?: fail(path, "Invalid union value")
  }

  private fun numberValid(value: JsonElement, rule: JsonObject): Boolean {
    val primitive = value as? JsonPrimitive ?: return false
    if (primitive.isString) return false
    val number = primitive.doubleOrNull ?: return false
    return number.isFinite() &&
      (!rule.flag("integer") || number % 1.0 == 0.0) &&
      number >= rule.number("min", Double.NEGATIVE_INFINITY) &&
      number <= rule.number("max", Double.POSITIVE_INFINITY)
  }

  private fun primitiveValid(value: JsonElement, rule: JsonObject): Boolean {
    val primitive = value as? JsonPrimitive
    val text = primitive?.takeIf { it.isString }?.content
    return when (rule.text("kind")) {
      "string" ->
        text != null &&
          (rule.flag("empty") || text.isNotEmpty()) &&
          (!rule.flag("nonblank") || !blankTextPattern.matches(text))
      "key" -> text != null && stateKeyPattern.matches(text)
      "boundKey" -> text != null && PrototypeRepeatTemplate.isBoundKey(text)
      "pointer" -> text != null && PrototypeDataPointer.isValid(text)
      "color" -> text != null && colorPattern.matches(text)
      "number" -> numberValid(value, rule)
      "boolean" -> primitive != null && !primitive.isString && primitive.booleanOrNull != null
      "true" -> primitive != null && !primitive.isString && primitive.booleanOrNull == true
      "scalar" ->
        text != null ||
          (primitive != null &&
            !primitive.isString &&
            (primitive.booleanOrNull != null || primitive.doubleOrNull?.isFinite() == true))
      "enum" -> rule.getValue("values").jsonArray.any { it == value }
      "json" ->
        jsonCost(value).let {
          it.isFinite() && it <= rule.number("maxBytes", Double.POSITIVE_INFINITY)
        }
      else -> false
    }
  }

  private fun dataError(value: JsonElement): PrototypeSpecError? {
    if (value !is JsonObject) return fail("data", "Expected object")
    return walkDataValue(value, "data", 1)
      ?: if (jsonCost(value) > MAX_PROTOTYPE_DATA_BYTES) fail("data", "Data byte limit exceeded")
      else null
  }

  /**
   * The data a device write leaves behind must stay inside the data limits, with the write byte cap
   * in place of the spec's own. A message containing "limit" is a limit refusal; any other is a
   * value data cannot hold.
   */
  internal fun dataWriteError(value: JsonObject): PrototypeSpecError? =
    walkDataValue(value, "data", 1)
      ?: if (jsonCost(value) > MAX_PROTOTYPE_DATA_WRITE_BYTES)
        fail("data", "Data byte limit exceeded")
      else null

  private val dataActionTypes = setOf("setData", "appendData", "removeData")

  /**
   * Static checks for `setData`, `appendData` and `removeData` (#12519) that the contract cannot
   * express: the `/data/<pointer>` path, a literal value data can hold, and an `appendData` target
   * the spec's own data already defines as something other than an array. A target under `{index}`
   * or one only an earlier write creates is the device's to check.
   */
  private fun dataActionErrors(context: Context, root: JsonElement): PrototypeSpecError? {
    val data = (root as? JsonObject)?.get("data") as? JsonObject
    for ((value, path) in context.actions) {
      val type = value.text("type")
      if (type !in dataActionTypes) continue
      val actionPath = value.text("path").orEmpty()
      val pointer =
        PrototypeDataWriter.pathPointer(PrototypeRepeatTemplate.bindDataPath(actionPath, 0))
          ?: return fail(
            "$path.path",
            "Data action paths are /data/<RFC 6901 pointer> and address a member of data",
          )
      val literal = (value["value"] as? JsonObject)?.get("value")
      if (literal != null && dataError(JsonObject(mapOf("value" to literal))) != null) {
        return fail(
          "$path.value.value",
          "A data write value must be a string, boolean, finite number, array or object",
        )
      }
      if (type == "appendData" && !PrototypeRepeatTemplate.dataPathHasIndex(actionPath)) {
        val target = PrototypeDataPointer.resolve(data, pointer)
        if (target != null && target !is JsonArray) {
          return fail("$path.path", "appendData target is not an array")
        }
      }
    }
    return null
  }

  private fun dataChildren(value: JsonElement, path: String): List<Pair<JsonElement, String>> =
    when (value) {
      is JsonObject -> value.keys.sorted().map { value.getValue(it) to keyPath(path, it) }
      is JsonArray -> value.mapIndexed { index, child -> child to "$path[$index]" }
      else -> emptyList()
    }

  private fun walkDataValue(value: JsonElement, path: String, depth: Int): PrototypeSpecError? {
    if (value !is JsonObject && value !is JsonArray) {
      return if (PrototypeDataValues.isScalar(value)) null else fail(path, "Invalid data value")
    }
    if (depth > MAX_PROTOTYPE_DATA_DEPTH) return fail(path, "Data depth limit exceeded")
    if (value is JsonArray && value.size > MAX_PROTOTYPE_DATA_ARRAY_ITEMS) {
      return fail(path, "Data array limit exceeded")
    }
    return dataChildren(value, path).firstNotNullOfOrNull { (child, childPath) ->
      walkDataValue(child, childPath, depth + 1)
    }
  }

  // Numeric reserve avoids depending on JSON number token spellings across runtimes.
  private fun jsonCost(value: JsonElement, depth: Int = 0): Double {
    if (depth > MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH) return Double.POSITIVE_INFINITY
    return when (value) {
      JsonNull -> 4.0
      is JsonObject ->
        2.0 +
          maxOf(0, value.size - 1) +
          value.entries.sumOf { (key, child) ->
            canonicalString(key).toByteArray(Charsets.UTF_8).size + 1 + jsonCost(child, depth + 1)
          }
      is JsonArray -> 2.0 + maxOf(0, value.size - 1) + value.sumOf { jsonCost(it, depth + 1) }
      is JsonPrimitive -> primitiveJsonCost(value)
    }
  }

  private fun primitiveJsonCost(value: JsonPrimitive): Double {
    if (value.isString)
      return canonicalString(value.content).toByteArray(Charsets.UTF_8).size.toDouble()
    if (value.booleanOrNull != null) return value.toString().length.toDouble()
    return if (value.doubleOrNull?.isFinite() == true) 32.0 else Double.POSITIVE_INFINITY
  }

  private fun stackErrors(context: Context): PrototypeSpecError? {
    val stacks = mutableMapOf<String, JsonObject>()
    for ((value, path) in context.nodes) {
      if (value.text("type") != "stack") continue
      val id = checkNotNull(value.text("id"))
      if (stacks.containsKey(id)) return fail("$path.id", "Duplicate stack id")
      val screens = value.getValue("screens").jsonObject
      val start = checkNotNull(value.text("start"))
      if (!screens.containsKey(start)) return fail("$path.start", "Unknown start screen")
      stacks[id] = screens
    }
    for ((value, path) in context.actions) {
      val id = value.text("stack") ?: continue
      val screens = stacks[id] ?: return fail("$path.stack", "Unknown stack id")
      val screen = value.text("screen")
      if (screen != null && !screens.containsKey(screen))
        return fail("$path.screen", "Unknown stack screen")
    }
    return null
  }

  private fun pagerErrors(context: Context): PrototypeSpecError? {
    val pagers = mutableSetOf<String>()
    for ((value, path) in context.nodes) {
      if (value.text("type") != "pager") continue
      val id = checkNotNull(value.text("id"))
      if (!pagers.add(id)) return fail("$path.id", "Duplicate pager id")
      if (
        value.text("axis") == "vertical" &&
          context.nodes.any { (ancestor, ancestorPath) ->
            ancestor.text("type") == "scroll" &&
              ancestor.text("axis") != "horizontal" &&
              path.startsWith("$ancestorPath.")
          }
      )
        return fail("$path.axis", "A vertical pager cannot appear inside a vertical scroll")
    }
    for ((value, path) in context.nodes + context.actions) {
      val pager = value.text("pager") ?: continue
      if (!pagers.contains(pager)) return fail("$path.pager", "Unknown pager id")
    }
    for ((value, path) in context.actions) {
      for ((name, binding) in (value["context"] as? JsonObject).orEmpty()) {
        val page = (binding as? JsonObject)?.text("page") ?: continue
        if (page !in pagers) return fail(keyPath("$path.context", name), "Unknown pager id")
      }
    }
    return null
  }

  /** A radio group or segmented button binds a string key to one of its unique option values. */
  private fun radioGroupErrors(
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
  private fun trailingErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    if (value.text("type") != "listItem") return null
    val key = (value["trailing"] as? JsonObject)?.text("stateKey") ?: return null
    val stored = state[key] as? JsonPrimitive
    return if (stored == null || stored.isString || stored.booleanOrNull == null)
      fail("$path.trailing.stateKey", "Toggle control requires a boolean state key")
    else null
  }

  private fun listItemBindingErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      trailingErrors(value, path, state)?.let {
        return it.forItem(item)
      }
    }
    return null
  }

  private fun stepFitsRange(step: Double, range: Double): Boolean {
    val count = range / step
    return step > 0 && count >= 1 && abs(count - Math.round(count)) < 1e-9
  }

  /** Slider range, step and bound-value checks; the contract only types the individual fields. */
  private fun sliderErrors(
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
    if (number == null || !number.isFinite() || number < min || number > max)
      return fail("$path.stateKey", "Slider requires a numeric state key within min and max")
    return null
  }

  /** A filter chip is a boolean toggle; an assist chip only runs its actions. */
  private fun chipErrors(
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
    if (bound && (stored == null || stored.isString || stored.booleanOrNull == null))
      return fail("$path.stateKey", "Filter chip requires a boolean state key")
    return null
  }

  /** An extended FAB (one with a label) has a single size, so `size` applies only to icon FABs. */
  private fun fabErrors(value: JsonObject, path: String): PrototypeSpecError? =
    if (value.text("label") != null && value.containsKey("size"))
      fail("$path.size", "Extended FAB cannot set size")
    else null

  /**
   * A bound progress indicator is determinate over 0..max (default 1); unbound is indeterminate.
   */
  private fun progressErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): PrototypeSpecError? {
    if (value.text("stateKey") == null)
      return if (value.containsKey("max")) fail("$path.max", "Requires stateKey") else null
    val max = (value["max"] as? JsonPrimitive)?.doubleOrNull ?: 1.0
    if (max <= 0) return fail("$path.max", "Progress max must be greater than 0")
    val number = stored?.takeIf { !it.isString }?.doubleOrNull
    if (number == null || !number.isFinite() || number < 0 || number > max)
      return fail("$path.stateKey", "Progress requires a numeric state key within 0 and max")
    return null
  }

  /** A time picker binds two distinct integer keys: hour 0..23 and minute 0..59. */
  private fun timePickerErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    for ((field, max, unit) in
      listOf(Triple("hourKey", 23, "hour"), Triple("minuteKey", 59, "minute"))) {
      val stored = value.text(field)?.let { state[it] as? JsonPrimitive }
      val number = stored?.takeIf { !it.isString }?.doubleOrNull
      if (number == null || number % 1.0 != 0.0 || number < 0 || number > max)
        return fail("$path.$field", "Time picker $unit requires an integer 0..$max state key")
    }
    return if (value.text("hourKey") == value.text("minuteKey"))
      fail("$path.minuteKey", "Time picker hour and minute keys must differ")
    else null
  }

  /** Individual fields are contract-typed; relationships follow the host's textFieldErrors. */
  private fun textFieldErrors(
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
    val minLines = (value["minLines"] as? JsonPrimitive)?.intOrNull
    val maxLines = (value["maxLines"] as? JsonPrimitive)?.intOrNull
    if (minLines != null && maxLines != null && minLines > maxLines)
      return fail("$path.minLines", "minLines cannot exceed maxLines")
    val maxLength = (value["maxLength"] as? JsonPrimitive)?.intOrNull
    if (maxLength != null && stored.content.length > maxLength)
      return fail("$path.stateKey", "Text field value exceeds maxLength")
    return null
  }

  private fun componentBindingErrors(
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
  private fun nodeBindingErrors(
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
    if (value.text("type") == "searchBar") {
      val active = value.text("activeKey")?.let { state[it] as? JsonPrimitive }
      if (
        value.text("activeKey") != null &&
          (active == null || active.isString || active.booleanOrNull == null)
      )
        return fail("$path.activeKey", "Search bar requires a boolean active key")
    }
    if (
      value.text("type") in setOf("switch", "checkbox") &&
        (stored == null || stored.isString || stored.booleanOrNull == null)
    )
      return fail("$path.stateKey", "Toggle control requires a boolean state key")
    if (value.text("type") in setOf("radioGroup", "segmentedButton", "select")) {
      radioGroupErrors(value, path, stored)?.let {
        return it
      }
    }
    if (value.text("type") !in setOf("tabBar", "bottomNav")) return null
    val number = stored?.takeIf { !it.isString }?.doubleOrNull
    return if (number == null || !number.isFinite() || number < 0 || number % 1.0 != 0.0)
      fail("$path.stateKey", "Selection requires a nonnegative integer state key")
    else null
  }

  private fun bindingErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      nodeBindingErrors(value, path, state)?.let {
        return it.forItem(item)
      }
    }
    return null
  }

  /** Nodes opened by a boolean `openWhen` key; an existing key must hold a boolean. */
  private val modalNames =
    mapOf(
      "bottomSheet" to "Sheet",
      "dialog" to "Dialog",
      "snackbar" to "Snackbar",
      "menu" to "Menu",
    )

  private fun openWhenErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    val name = modalNames[value.text("type")] ?: return null
    val key = (value["openWhen"] as? JsonObject)?.text("key") ?: return null
    val stored = state[key] as? JsonPrimitive
    return if (
      state.containsKey(key) && (stored == null || stored.isString || stored.booleanOrNull == null)
    )
      fail("$path.openWhen.key", "$name requires a boolean state key")
    else null
  }

  /** Pull-to-refresh needs a vertical scroll, and its declared key must hold a boolean. */
  private fun refreshErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? {
    if (value.text("type") != "scroll") return null
    val refresh = value["refresh"] as? JsonObject ?: return null
    if (value.text("axis") == "horizontal")
      return fail("$path.refresh", "Pull-to-refresh needs a vertical scroll")
    val key = refresh.text("stateKey") ?: return null
    val stored = state[key] as? JsonPrimitive
    return if (
      state.containsKey(key) && (stored == null || stored.isString || stored.booleanOrNull == null)
    )
      fail("$path.refresh.stateKey", "Refresh requires a boolean state key")
    else null
  }

  private fun sheetBindingErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      (openWhenErrors(value, path, state) ?: refreshErrors(value, path, state))?.let {
        return it.forItem(item)
      }
    }
    return null
  }

  /** First binding rule the node breaks; the same rules that check the declared state. */
  private fun controlErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): PrototypeSpecError? =
    nodeBindingErrors(value, path, state)
      ?: trailingErrors(value, path, state)
      ?: openWhenErrors(value, path, state)
      ?: refreshErrors(value, path, state)

  /** Every state key a node binds: `stateKey`, time picker keys, a trailing control, `openWhen`. */
  private fun boundKeys(value: JsonObject): List<String> =
    listOfNotNull(
      value.text("stateKey"),
      value.text("activeKey"),
      value.text("hourKey"),
      value.text("minuteKey"),
      (value["trailing"] as? JsonObject)?.text("stateKey"),
      if (value.text("type") in modalNames) (value["openWhen"] as? JsonObject)?.text("key")
      else null,
      if (value.text("type") == "scroll") (value["refresh"] as? JsonObject)?.text("stateKey")
      else null,
    )

  /**
   * A `setState` must leave every control bound to its key valid, so the key is checked as if the
   * value were the declared state (#11452). A key no control binds, a key bound by controls of
   * different types, and a repeat-templated value are not checked.
   */
  private fun setStateBindingErrors(
    action: Located,
    context: Context,
    state: JsonObject,
  ): PrototypeSpecError? {
    val key = action.value.text("key") ?: return null
    val written = action.value["value"] as? JsonPrimitive
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

  private fun stateActionErrors(context: Context, data: JsonObject): PrototypeSpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for (action in context.actions) {
      val (value, path, item) = action
      if (value.text("type") == "setState") {
        setStateBindingErrors(action, context, state)?.let {
          return it.forItem(item)
        }
        continue
      }
      val stored = state[value.text("key") ?: continue] as? JsonPrimitive
      val message =
        when (value.text("type")) {
          "toggle" ->
            "Toggle requires a boolean state key"
              .takeIf {
                stored == null || stored.isString || stored.booleanOrNull == null
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
      if (message != null) return fail("$path.key", message).forItem(item)
    }
    return null
  }

  private val datePattern = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
  private val daysInMonth = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

  /** A `YYYY-MM-DD` calendar date in 1900..2100, the Material date picker's year range. */
  fun isPrototypeDate(value: String?): Boolean {
    if (value == null || !datePattern.matches(value)) return false
    val (year, month, day) = value.split("-").map(String::toInt)
    if (year !in 1900..2100 || month !in 1..12) return false
    val leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    val days = if (month == 2 && leap) 29 else daysInMonth[month - 1]
    return day in 1..days
  }
}
