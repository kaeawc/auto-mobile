package dev.jasonpearson.automobile.protocol

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
      "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$"
    )
  private val numberTokenPattern = Regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$")
  private val json = Json { ignoreUnknownKeys = false }
  private val contract: JsonObject =
    json
      .parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/overlay-spec-contract.json")) {
            "Missing overlay structural contract"
          }
          .bufferedReader()
          .use { it.readText() }
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
        ?: pagerErrors(context)
        ?: bindingErrors(context, value as? JsonObject ?: JsonObject(emptyMap()))
        ?: sheetBindingErrors(context, value as? JsonObject ?: JsonObject(emptyMap()))
    if (error != null) return OverlaySpecValidation.Failure(error)
    return try {
      OverlaySpecValidation.Success(
        json.decodeFromJsonElement<OverlaySpec>(
          normalizeIntegers(value, definitions.getValue("spec").jsonObject)
        )
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
          }
        )
      }
      "array" ->
        JsonArray(
          (value as JsonArray).map { normalizeIntegers(it, rule.getValue("item").jsonObject) }
        )
      "number" ->
        if (rule.flag("integer")) JsonPrimitive(value.jsonPrimitive.double.toInt()) else value
      else -> value
    }

  private data class Located(val value: JsonObject, val path: String)

  private class Context {
    val nodes = mutableListOf<Located>()
    val actions = mutableListOf<Located>()
    var images = 0
    var selectorDepth = 0
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
        if (primitiveValid(value, rule)) null else fail(path, "Invalid ${rule.text("kind")} value")
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
    if (rule.flag("atLeastOne") && data.isEmpty())
      return fail(path, "At least one selector field is required")
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

  private fun bindingErrors(context: Context, data: JsonObject): OverlaySpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path) in context.nodes) {
      val key = value.text("stateKey") ?: continue
      val stored = state[key] as? JsonPrimitive
      if (value.text("type") == "textField" && stored?.isString != true)
        return fail("$path.stateKey", "Text field requires a string state key")
      if (value.text("type") !in setOf("tabBar", "bottomNav")) continue
      val number = stored?.takeIf { !it.isString }?.doubleOrNull
      if (number == null || !number.isFinite() || number < 0 || number % 1.0 != 0.0) {
        return fail("$path.stateKey", "Selection requires a nonnegative integer state key")
      }
    }
    return null
  }

  private fun sheetBindingErrors(context: Context, data: JsonObject): OverlaySpecError? {
    val state = data["state"] as? JsonObject ?: JsonObject(emptyMap())
    for ((value, path) in context.nodes) {
      if (value.text("type") != "bottomSheet") continue
      val condition = value["openWhen"] as? JsonObject ?: continue
      val key = condition.text("key") ?: continue
      val stored = state[key] as? JsonPrimitive
      if (
        state.containsKey(key) &&
          (stored == null || stored.isString || stored.booleanOrNull == null)
      ) {
        return fail("$path.openWhen.key", "Sheet requires a boolean state key")
      }
    }
    return null
  }
}
