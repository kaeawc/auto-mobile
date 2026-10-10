package dev.jasonpearson.automobile.protocol

import kotlin.math.abs
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*

/** Canonical errors are computed from JSON structure, never from decoder exception strings. */
data class OverlaySpecError(val path: String, val message: String)

sealed class OverlaySpecValidation {
  data class Success(val spec: OverlaySpec) : OverlaySpecValidation()

  data class Failure(val error: OverlaySpecError) : OverlaySpecValidation()
}

object OverlaySpecValidator {
  private val pathKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
  private val stateKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")
  private val colorPattern = Regex("^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
  private val blankTextPattern =
    Regex(
      "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$",
    )
  private val numberTokenPattern = Regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$")
  private val json = Json { ignoreUnknownKeys = false }
  private val contract: JsonObject =
    json
      .parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json")) {
            "Missing overlay structural contract"
          }
          .bufferedReader()
          .use { it.readText() },
      )
      .jsonObject
  private val definitions = contract.getValue("definitions").jsonObject
  private val limits = contract.getValue("limits").jsonObject
  val MAX_OVERLAY_NODES: Int = limit("MAX_OVERLAY_NODES")
  val MAX_OVERLAY_DEPTH: Int = limit("MAX_OVERLAY_DEPTH")
  val MAX_OVERLAY_IMAGES: Int = limit("MAX_OVERLAY_IMAGES")
  val MAX_OVERLAY_SPEC_BYTES: Int = limit("MAX_OVERLAY_SPEC_BYTES")
  val MAX_OVERLAY_EMIT_PAYLOAD_BYTES: Int = limit("MAX_OVERLAY_EMIT_PAYLOAD_BYTES")
  val MAX_OVERLAY_EMIT_PAYLOAD_DEPTH: Int = limit("MAX_OVERLAY_EMIT_PAYLOAD_DEPTH")
  val MAX_OVERLAY_SELECTOR_DEPTH: Int = limit("MAX_OVERLAY_SELECTOR_DEPTH")
  val MAX_OVERLAY_CONDITION_DEPTH: Int = limit("MAX_OVERLAY_CONDITION_DEPTH")
  val nodeTypes: Set<String> = variants("node")
  val actionTypes: Set<String> = variants("action")
  val placementTypes: Set<String> = variants("placement")

  private fun limit(name: String) = limits.getValue(name).jsonPrimitive.int

  private fun variants(name: String) =
    definitions.getValue(name).jsonObject.getValue("variants").jsonObject.keys

  fun validate(input: String): OverlaySpecValidation {
    if (input.toByteArray(Charsets.UTF_8).size > MAX_OVERLAY_SPEC_BYTES) {
      return OverlaySpecValidation.Failure(fail("", "Spec byte limit exceeded"))
    }
    if (hasUnescapedControl(input)) return OverlaySpecValidation.Failure(fail("", "Invalid JSON"))
    return try {
      val element = json.parseToJsonElement(input)
      if (!validNumberTokens(element)) OverlaySpecValidation.Failure(fail("", "Invalid JSON"))
      else validateElement(element)
    } catch (_: SerializationException) {
      OverlaySpecValidation.Failure(fail("", "Invalid JSON"))
    } catch (_: IllegalArgumentException) {
      OverlaySpecValidation.Failure(fail("", "Invalid JSON"))
    }
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

  private fun validateElement(value: JsonElement): OverlaySpecValidation {
    val context = Context()
    val error =
      walk(value, definitions.getValue("spec").jsonObject, "", context, 0)
        ?: OverlayRepeatValidator.validate(value)
        ?: pagerErrors(context)
        ?: stateTypeErrors(value, context)
    if (error != null) return OverlaySpecValidation.Failure(error)
    return try {
      OverlaySpecValidation.Success(
        json.decodeFromJsonElement<OverlaySpec>(
          normalizeIntegers(value, definitions.getValue("spec").jsonObject),
        ),
      )
    } catch (_: SerializationException) {
      OverlaySpecValidation.Failure(fail("", "Internal model/contract mismatch"))
    }
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
      "array" ->
        JsonArray(
          (value as JsonArray).map { normalizeIntegers(it, rule.getValue("item").jsonObject) },
        )
      "number" ->
        if (rule.flag("integer")) JsonPrimitive(value.jsonPrimitive.double.toInt()) else value
      else -> value
    }

  /** A node or action; [item] is the repeat item its state keys were bound to, if any. */
  private data class Located(val value: JsonObject, val path: String, val item: Int? = null)

  private fun OverlaySpecError.forItem(item: Int?): OverlaySpecError =
    if (item == null) this else copy(message = "$message (repeat item $item)")

  /**
   * State-type checks over every repeat instance: a node or action whose state keys hold
   * placeholders is checked once per item with those keys bound (#11051).
   */
  private fun stateTypeErrors(value: JsonElement, context: Context): OverlaySpecError? {
    val data = value as? JsonObject ?: JsonObject(emptyMap())
    val scopes = OverlayRepeatValidator.scopes(value)
    fun List<Located>.instances() = flatMap { located ->
      OverlayRepeatValidator.keyInstances(scopes, located.value, located.path).map { (bound, item)
        ->
        Located(bound, located.path, item)
      }
    }
    val checked = Context()
    checked.nodes.addAll(context.nodes.instances())
    checked.actions.addAll(context.actions.instances())
    return bindingErrors(checked, data)
      ?: listItemBindingErrors(checked, data)
      ?: sheetBindingErrors(checked, data)
      ?: stateActionErrors(checked, data)
  }

  private class Context {
    val nodes = mutableListOf<Located>()
    val actions = mutableListOf<Located>()
    var images = 0
    var selectorDepth = 0
    var conditionDepth = 0
  }

  private fun fail(path: String, message: String) = OverlaySpecError(path.ifEmpty { "$" }, message)

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
  ): OverlaySpecError? =
    when (rule.text("kind")) {
      "ref" -> visitReference(value, rule, path, context, depth)
      "tagged" -> visitTagged(value, rule, path, context, depth)
      "object" -> visitObject(value, rule, path, context, depth)
      "array" -> visitArray(value, rule, path, context, depth)
      "map" -> visitMap(value, rule, path, context, depth)
      "choice" -> visitChoice(value, rule, path, context, depth)
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
  ): OverlaySpecError? {
    val target = definitions.getValue(checkNotNull(rule.text("name"))).jsonObject
    if (rule.text("name") == "container") return visitContainer(value, target, path, context, depth)
    if (rule.text("name") == "item" && (value as? JsonObject)?.text("image") != null) {
      context.images++
      if (context.images > MAX_OVERLAY_IMAGES) return fail("$path.image", "Image limit exceeded")
    }
    if (rule.text("name") == "condition") return visitCondition(value, target, path, context, depth)
    if (rule.text("name") != "node") return walk(value, target, path, context, depth)
    val node = value as? JsonObject ?: return fail(path, "Expected object")
    context.nodes.add(Located(node, path))
    if (context.nodes.size > MAX_OVERLAY_NODES) return fail(path, "Node limit exceeded")
    if (depth + 1 > MAX_OVERLAY_DEPTH) return fail(path, "Tree depth limit exceeded")
    if (node.text("type") == "image") context.images++
    if (context.images > MAX_OVERLAY_IMAGES) return fail(path, "Image limit exceeded")
    return walk(value, target, path, context, depth + 1)
  }

  private fun visitContainer(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): OverlaySpecError? {
    context.selectorDepth++
    if (context.selectorDepth > MAX_OVERLAY_SELECTOR_DEPTH)
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
  ): OverlaySpecError? {
    context.conditionDepth++
    if (context.conditionDepth > MAX_OVERLAY_CONDITION_DEPTH)
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
  ): OverlaySpecError? {
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
  ): OverlaySpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    val fields = rule.getValue("fields").jsonObject
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
  ): OverlaySpecError? {
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
  private fun formConstraint(data: JsonObject, rule: JsonObject, path: String): OverlaySpecError? {
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
      if (!data.containsKey(trigger)) {
        if (present.isNotEmpty()) return fail(keyPath(path, present.first()), "Requires $trigger")
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
  ): OverlaySpecError? {
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
  ): OverlaySpecError? {
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

  private fun visitChoice(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): OverlaySpecError? {
    val options = rule.getValue("options").jsonArray.map { it.jsonObject }
    val candidates = options.filter { option ->
      when (option.text("kind")) {
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
      "boundKey" -> text != null && OverlayRepeatTemplate.isBoundKey(text)
      "color" -> text != null && colorPattern.matches(text)
      "number" -> numberValid(value, rule)
      "boolean" -> primitive != null && !primitive.isString && primitive.booleanOrNull != null
      "scalar" ->
        text != null ||
          (primitive != null &&
            !primitive.isString &&
            (primitive.booleanOrNull != null || primitive.doubleOrNull?.isFinite() == true))
      "enum" ->
        text != null && rule.getValue("values").jsonArray.any { it.jsonPrimitive.content == text }
      "json" -> jsonCost(value) <= rule.number("maxBytes", Double.POSITIVE_INFINITY)
      else -> false
    }
  }

  // Numeric reserve avoids depending on JSON number token spellings across runtimes.
  private fun jsonCost(value: JsonElement, depth: Int = 0): Double {
    if (depth > MAX_OVERLAY_EMIT_PAYLOAD_DEPTH) return Double.POSITIVE_INFINITY
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

  private fun pagerErrors(context: Context): OverlaySpecError? {
    val pagers = mutableSetOf<String>()
    for ((value, path) in context.nodes) {
      if (value.text("type") != "pager") continue
      val id = checkNotNull(value.text("id"))
      if (!pagers.add(id)) return fail("$path.id", "Duplicate pager id")
    }
    for ((value, path) in context.nodes + context.actions) {
      val pager = value.text("pager") ?: continue
      if (!pagers.contains(pager)) return fail("$path.pager", "Unknown pager id")
    }
    return null
  }

  /** A radio group or segmented button binds a string key to one of its unique option values. */
  private fun radioGroupErrors(
    value: JsonObject,
    path: String,
    stored: JsonPrimitive?,
  ): OverlaySpecError? {
    val name = if (value.text("type") == "segmentedButton") "Segmented button" else "Radio group"
    if (stored == null || !stored.isString)
      return fail("$path.stateKey", "$name requires a string state key")
    val values = mutableSetOf<String?>()
    for ((index, option) in (value["options"] as? JsonArray).orEmpty().withIndex()) {
      if (!values.add((option as? JsonObject)?.text("value")))
        return fail("$path.options[$index].value", "Duplicate radio option value")
    }
    return null
  }

  /** A list item's trailing switch or checkbox binds a boolean, like the standalone controls. */
  private fun listItemBindingErrors(context: Context, data: JsonObject): OverlaySpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      if (value.text("type") != "listItem") continue
      val key = (value["trailing"] as? JsonObject)?.text("stateKey") ?: continue
      val stored = state[key] as? JsonPrimitive
      if (stored == null || stored.isString || stored.booleanOrNull == null)
        return fail("$path.trailing.stateKey", "Toggle control requires a boolean state key")
          .forItem(item)
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
  ): OverlaySpecError? {
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
  ): OverlaySpecError? {
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
  private fun fabErrors(value: JsonObject, path: String): OverlaySpecError? =
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
  ): OverlaySpecError? {
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
  ): OverlaySpecError? {
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

  private fun componentBindingErrors(
    value: JsonObject,
    path: String,
    state: JsonObject,
  ): OverlaySpecError? {
    val stored = value.text("stateKey")?.let { state[it] as? JsonPrimitive }
    return when (value.text("type")) {
      "slider" -> sliderErrors(value, path, stored)
      "chip" -> chipErrors(value, path, stored)
      "fab" -> fabErrors(value, path)
      "progress" -> progressErrors(value, path, stored)
      "timePicker" -> timePickerErrors(value, path, state)
      "datePicker" ->
        if (isOverlayDate(stored?.takeIf { it.isString }?.content)) null
        else fail("$path.stateKey", "Date picker requires a YYYY-MM-DD state key in 1900..2100")
      else -> null
    }
  }

  private fun bindingErrors(context: Context, data: JsonObject): OverlaySpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      componentBindingErrors(value, path, state)?.let {
        return it.forItem(item)
      }
      val key = value.text("stateKey") ?: continue
      val stored = state[key] as? JsonPrimitive
      if (value.text("type") == "textField" && stored?.isString != true)
        return fail("$path.stateKey", "Text field requires a string state key").forItem(item)
      if (
        value.text("type") in setOf("switch", "checkbox") &&
          (stored == null || stored.isString || stored.booleanOrNull == null)
      )
        return fail("$path.stateKey", "Toggle control requires a boolean state key").forItem(item)
      if (value.text("type") in setOf("radioGroup", "segmentedButton")) {
        radioGroupErrors(value, path, stored)?.let {
          return it.forItem(item)
        }
      }
      if (value.text("type") !in setOf("tabBar", "bottomNav")) continue
      val number = stored?.takeIf { !it.isString }?.doubleOrNull
      if (number == null || !number.isFinite() || number < 0 || number % 1.0 != 0.0) {
        return fail("$path.stateKey", "Selection requires a nonnegative integer state key")
          .forItem(item)
      }
    }
    return null
  }

  /** Nodes opened by a boolean `openWhen` key; an existing key must hold a boolean. */
  private val modalNames =
    mapOf("bottomSheet" to "Sheet", "dialog" to "Dialog", "snackbar" to "Snackbar")

  private fun sheetBindingErrors(context: Context, data: JsonObject): OverlaySpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.nodes) {
      val name = modalNames[value.text("type")] ?: continue
      val condition = value["openWhen"] as? JsonObject ?: continue
      val key = condition.text("key") ?: continue
      val stored = state[key] as? JsonPrimitive
      if (
        state.containsKey(key) &&
          (stored == null || stored.isString || stored.booleanOrNull == null)
      ) {
        return fail("$path.openWhen.key", "$name requires a boolean state key").forItem(item)
      }
    }
    return null
  }

  private fun stateActionErrors(context: Context, data: JsonObject): OverlaySpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path, item) in context.actions) {
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
  fun isOverlayDate(value: String?): Boolean {
    if (value == null || !datePattern.matches(value)) return false
    val (year, month, day) = value.split("-").map(String::toInt)
    if (year !in 1900..2100 || month !in 1..12) return false
    val leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    val days = if (month == 2 && leap) 29 else daysInMonth[month - 1]
    return day in 1..days
  }
}
