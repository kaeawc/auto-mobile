package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** RFC 6901 pointers relative to the read-only data object. Invalid input is always missing. */
object PrototypeDataPointer {
  fun isValid(pointer: String): Boolean {
    if (pointer.length !in 1..PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH) return false
    if (!pointer.startsWith('/')) return false
    var index = 0
    while (index < pointer.length) {
      if (pointer[index] == '~') {
        if (index + 1 == pointer.length || pointer[index + 1] !in "01") return false
        index++
      }
      index++
    }
    return true
  }

  fun tokens(pointer: String): List<String> =
    if (isValid(pointer))
      pointer.substring(1).split('/').map { it.replace("~1", "/").replace("~0", "~") }
    else emptyList()

  fun resolve(data: JsonObject?, pointer: String): JsonElement? {
    if (!isValid(pointer)) return null
    var value: JsonElement? = data
    for (token in tokens(pointer)) {
      value =
        when (val current = value) {
          is JsonObject -> current[token]
          is JsonArray -> arrayIndex(token)?.let { current.getOrNull(it) }
          else -> null
        }
    }
    return value
  }

  private fun isPositiveIndex(token: String): Boolean =
    token.isNotEmpty() && token[0] in '1'..'9' && token.all { it in '0'..'9' }

  private fun arrayIndex(token: String): Int? =
    if (token == "0" || isPositiveIndex(token)) token.toIntOrNull() else null
}

/** Shared projection and scalar semantics; rendering is the existing repeat renderer. */
internal object PrototypeDataValues {
  fun isScalar(value: JsonElement?): Boolean =
    value is JsonPrimitive &&
      value != JsonNull &&
      (value.isString || value.booleanOrNull != null || value.doubleOrNull?.isFinite() == true)

  fun project(item: JsonObject): JsonObject =
    JsonObject(
      item.filter { (key, value) -> PrototypeRepeatTemplate.isFieldName(key) && isScalar(value) },
    )

  fun rendered(value: JsonElement?): String =
    if (isScalar(value)) PrototypeRepeatTemplate.rendered(value as JsonPrimitive) else ""

  fun equal(value: JsonElement?, operand: JsonElement?): Boolean {
    if (!isScalar(value) || !isScalar(operand)) return false
    val left = value as JsonPrimitive
    val right = operand as JsonPrimitive
    return when {
      left.isString || right.isString ->
        left.isString && right.isString && left.content == right.content
      left.booleanOrNull != null || right.booleanOrNull != null ->
        left.booleanOrNull != null && left.booleanOrNull == right.booleanOrNull
      else -> left.doubleOrNull == right.doubleOrNull
    }
  }

  fun holds(condition: JsonObject, data: JsonObject?): Boolean {
    val pointer = (condition["data"] as? JsonPrimitive)?.content ?: return false
    val value = PrototypeDataPointer.resolve(data, pointer)
    return when {
      condition.containsKey("equals") -> equal(value, condition["equals"])
      condition.containsKey("notEquals") -> !equal(value, condition["notEquals"])
      condition.containsKey("gt") -> compare(value, condition["gt"]) { left, right -> left > right }
      condition.containsKey("lt") -> compare(value, condition["lt"]) { left, right -> left < right }
      condition.containsKey("empty") ->
        isEmpty(value) == (condition["empty"] as? JsonPrimitive)?.booleanOrNull
      else -> false
    }
  }

  /** A missing value, `null`, `[]`, `{}` or `""` is empty (#14207); every other value is not. */
  fun isEmpty(value: JsonElement?): Boolean =
    when (value) {
      null,
      JsonNull -> true
      is JsonArray -> value.isEmpty()
      is JsonObject -> value.isEmpty()
      is JsonPrimitive -> value.isString && value.content.isEmpty()
    }

  private fun compare(
    value: JsonElement?,
    operand: JsonElement?,
    comparison: (Double, Double) -> Boolean,
  ): Boolean {
    val left = (value as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
    val right = (operand as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
    return left != null &&
      right != null &&
      left.isFinite() &&
      right.isFinite() &&
      comparison(left, right)
  }
}

/** Per-call caches; JSON values are read-only and projected rows are shared, never mutated. */
internal class PrototypeRepeatData(private val data: JsonObject?) {
  private val renderings = mutableMapOf<String, String>()
  private val sources = mutableMapOf<String, JsonArray?>()
  private val counts = mutableMapOf<String, Int>()
  private val projections = mutableMapOf<String, List<JsonObject>>()
  private val arrays = mutableMapOf<String, JsonArray>()

  fun source(pointer: String): JsonArray? {
    if (!sources.containsKey(pointer)) {
      sources[pointer] = PrototypeDataPointer.resolve(data, pointer) as? JsonArray
    }
    return sources[pointer]
  }

  fun rendered(pointer: String): String =
    renderings.getOrPut(pointer) {
      PrototypeDataValues.rendered(PrototypeDataPointer.resolve(data, pointer))
    }

  /** Null signals an oversized substitution; never construct that resolved string. */
  fun text(text: String, charge: (Long) -> Boolean): String? =
    PrototypeDataText.boundedBind(text, ::rendered, charge)

  fun cells(pointer: String): Int =
    counts.getOrPut(pointer) {
      source(pointer)
        .orEmpty()
        .filterIsInstance<JsonObject>()
        .take(PrototypeSpecValidator.maxRepeatItems)
        .sumOf { item ->
          maxOf(
            1,
            item.count { (key, value) ->
              PrototypeRepeatTemplate.isFieldName(key) && PrototypeDataValues.isScalar(value)
            },
          )
        }
    }

  fun items(pointer: String): List<JsonObject> =
    projections.getOrPut(pointer) {
      source(pointer)
        .orEmpty()
        .filterIsInstance<JsonObject>()
        .take(PrototypeSpecValidator.maxRepeatItems)
        .map(PrototypeDataValues::project)
    }

  fun array(pointer: String): JsonArray = arrays.getOrPut(pointer) { JsonArray(items(pointer)) }
}

/** Authored text is scanned once; replacement values are never scanned again. */
internal object PrototypeDataText {
  private data class Placeholder(val start: Int, val end: Int, val pointer: String)

  private fun placeholders(text: String): List<Placeholder> {
    val found = mutableListOf<Placeholder>()
    var cursor = 0
    while (cursor < text.length) {
      val close = closingBrace(text, cursor)
      val inner = if (close < 0) "" else text.substring(cursor + 1, close)
      val pointer = if (inner.startsWith("data:")) inner.substring("data:".length) else ""
      if (PrototypeDataPointer.isValid(pointer)) {
        found.add(Placeholder(cursor, close + 1, pointer))
        cursor = close + 1
      } else {
        cursor++
      }
    }
    return found
  }

  private fun closingBrace(text: String, cursor: Int): Int {
    if (text[cursor] != '{' || !text.startsWith("data:", cursor + 1)) return -1
    val end =
      minOf(text.length, cursor + 2 + 5 + PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH)
    for (index in cursor + 1 until end) {
      if (text[index] == '}') return index
    }
    return -1
  }

  fun hasBinding(text: String): Boolean = placeholders(text).isNotEmpty()

  fun boundedBind(
    text: String,
    resolve: (String) -> String,
    charge: (Long) -> Boolean,
  ): String? {
    val spans = placeholders(text)
    var length = 0L
    for (span in spans) {
      length += resolve(span.pointer).length
      if (length > PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH) return null
    }
    if (spans.isEmpty()) return text
    if (!charge(text.length.toLong() + length)) return null
    return bind(text, spans, resolve)
  }

  fun bind(text: String, data: JsonObject?): String =
    bind(text, placeholders(text)) { pointer ->
      PrototypeDataValues.rendered(PrototypeDataPointer.resolve(data, pointer))
    }

  private fun bind(
    text: String,
    spans: List<Placeholder>,
    resolve: (String) -> String,
  ): String = buildString {
    var cursor = 0
    for (placeholder in spans) {
      append(text.substring(cursor, placeholder.start))
      append(resolve(placeholder.pointer))
      cursor = placeholder.end
    }
    append(text.substring(cursor))
  }
}

/** Pure, one-time resolution before repeat expansion and state interpolation. */
object PrototypeDataResolver {
  fun resolveRoot(root: JsonObject, data: JsonObject?): JsonObject =
    resolveRoot(root, data, PrototypeRepeatData(data))

  private fun resolveRoot(
    root: JsonObject,
    data: JsonObject?,
    repeats: PrototypeRepeatData,
  ): JsonObject {
    val own = textFields(root, data)
    val resolved =
      JsonObject(
        own.mapValues { (key, value) ->
          when (key) {
            "repeat" -> resolveRepeat(value, repeats)
            "enabledWhen",
            "visibleWhen",
            "errorWhen" -> resolveCondition(value, data)
            "styleWhen" -> resolveStyles(value, data)
            else -> value
          }
        },
      )
    return mapChildren(resolved) { resolveRoot(it, data, repeats) }
  }

  fun resolve(spec: PrototypeSpec): PrototypeSpec {
    val json = PrototypeSpecValidator.json
    val root = json.encodeToJsonElement(PrototypeNode.serializer(), spec.root).jsonObject
    if (!hasBindings(root)) return spec
    val resolved = json.decodeFromJsonElement<PrototypeNode>(resolveRoot(root, spec.data))
    return spec.copy(root = resolved)
  }

  private fun resolveRepeat(value: JsonElement, repeats: PrototypeRepeatData): JsonElement {
    val repeat = value as? JsonObject ?: return value
    val source = repeat["items"] as? JsonObject ?: return value
    val pointer = (source["path"] as? JsonPrimitive)?.content.orEmpty()
    return JsonObject(repeat + ("items" to repeats.array(pointer)))
  }

  private fun resolveCondition(value: JsonElement, data: JsonObject?): JsonElement {
    val condition = value as? JsonObject ?: return value
    if (condition.containsKey("data")) {
      val form = if (PrototypeDataValues.holds(condition, data)) "all" else "any"
      return buildJsonObject { put(form, JsonArray(emptyList())) }
    }
    return JsonObject(
      condition.mapValues { (key, member) ->
        when (key) {
          "not" -> resolveCondition(member, data)
          "all",
          "any" -> JsonArray((member as? JsonArray).orEmpty().map { resolveCondition(it, data) })
          else -> member
        }
      },
    )
  }

  private fun resolveStyles(value: JsonElement, data: JsonObject?): JsonElement =
    JsonArray(
      (value as? JsonArray).orEmpty().map { entry ->
        val style = entry as? JsonObject
        val condition = style?.get("when")
        if (style == null || condition == null) entry
        else JsonObject(style + ("when" to resolveCondition(condition, data)))
      },
    )

  private fun textFields(node: JsonObject, data: JsonObject?): JsonObject {
    val replacements = mutableMapOf<String, JsonElement>()
    PrototypeBindableFields.first<Boolean>(node, "") { value, path, kind ->
      val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
      if (
        kind == PrototypeBindableKind.TEXT && text != null && PrototypeDataText.hasBinding(text)
      ) {
        replacements[path] = JsonPrimitive(PrototypeDataText.bind(text, data))
      }
      null
    }
    return if (replacements.isEmpty()) node else replaceFields(node, "", replacements).jsonObject
  }

  private fun replaceFields(
    value: JsonElement,
    path: String,
    replacements: Map<String, JsonElement>,
  ): JsonElement =
    replacements[path]
      ?: when (value) {
        is JsonObject ->
          JsonObject(
            value.mapValues { (key, member) ->
              replaceFields(member, "$path.$key", replacements)
            },
          )
        is JsonArray ->
          JsonArray(
            value.mapIndexed { index, member ->
              replaceFields(member, "$path[$index]", replacements)
            },
          )
        else -> value
      }

  private fun mapChildren(node: JsonObject, transform: (JsonObject) -> JsonObject): JsonObject {
    val child = node["child"] as? JsonObject
    if (child != null) return JsonObject(node + ("child" to transform(child)))
    val screens = node["screens"] as? JsonObject
    if (screens != null)
      return JsonObject(
        node +
          ("screens" to
            JsonObject(
              screens.mapValues { (_, entry) ->
                if (entry is JsonObject) transform(entry) else entry
              },
            )),
      )
    val children = node["children"] as? JsonArray ?: return node
    return JsonObject(
      node +
        ("children" to
          JsonArray(
            children.map { entry ->
              if (entry is JsonObject) transform(entry) else entry
            },
          )),
    )
  }

  private fun conditionBound(value: JsonElement?): Boolean {
    val condition = value as? JsonObject ?: return false
    return condition.containsKey("data") ||
      conditionBound(condition["not"]) ||
      listOf("all", "any").any { form ->
        (condition[form] as? JsonArray).orEmpty().any(::conditionBound)
      }
  }

  private fun hasBindings(node: JsonObject): Boolean {
    val textBound =
      PrototypeBindableFields.first<Boolean>(node, "") { value, _, kind ->
        if (
          kind == PrototypeBindableKind.EMIT_BINDING &&
            (value as? JsonObject)?.containsKey("data") == true
        )
          return@first true
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (kind == PrototypeBindableKind.TEXT && text?.let(PrototypeDataText::hasBinding) == true)
          true
        else null
      } == true
    val stylesBound =
      (node["styleWhen"] as? JsonArray).orEmpty().any {
        conditionBound((it as? JsonObject)?.get("when"))
      }
    val own =
      (node["repeat"] as? JsonObject)?.get("items") is JsonObject ||
        textBound ||
        conditionBound(node["enabledWhen"]) ||
        conditionBound(node["visibleWhen"]) ||
        conditionBound(node["errorWhen"]) ||
        stylesBound
    val child = node["child"] as? JsonObject
    val nested =
      if (child != null) hasBindings(child)
      else
        (node["children"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>().any(::hasBindings)
    val screensBound =
      (node["screens"] as? JsonObject)?.values?.filterIsInstance<JsonObject>()?.any(::hasBindings)
        ?: false
    return own || nested || screensBound
  }
}
