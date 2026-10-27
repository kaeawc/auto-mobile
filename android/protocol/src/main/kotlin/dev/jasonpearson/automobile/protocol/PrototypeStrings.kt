package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Integer-only, deterministic string resolution. Translations are never scanned recursively. */
object PrototypeStrings {
  private val display = contractNames("stringFields")
  private val opaque = contractNames("stringOpaqueFields")
  private val token =
    Regex("\\{t:([A-Za-z_][A-Za-z0-9_.-]{0,63})(?:\\|(\\{data:[^{}]+\\}|[^{}]*))?\\}")
  private val digits = Regex("^[0-9]{1,9}$")

  private fun contractNames(name: String): Set<String> =
    PrototypeSpecContract.contract.getValue(name).jsonArray.map { it.jsonPrimitive.content }.toSet()

  internal data class Use(val start: Int, val end: Int, val key: String, val count: String?)

  internal fun uses(text: String, strict: Boolean = true): List<Use>? {
    val result = mutableListOf<Use>()
    var cursor = text.indexOf("{t:")
    while (cursor >= 0) {
      val match = token.find(text, cursor)?.takeIf { it.range.first == cursor } ?: return null
      val count = match.groups[2]?.value
      if (count?.startsWith("{data:") == true) {
        if (!PrototypeDataPointer.isValid(count.substring(6, count.length - 1))) return null
      } else if (strict && count != null && !digits.matches(count)) return null
      result.add(Use(cursor, match.range.last + 1, match.groupValues[1], count))
      cursor = text.indexOf("{t:", match.range.last + 1)
    }
    return result
  }

  fun localeChain(requested: List<String>): List<String> {
    val chain = linkedSetOf<String>()
    for (tag in requested) {
      val parts = normalize(tag).split('-').toMutableList()
      while (parts.isNotEmpty()) {
        val prefix = parts.joinToString("-")
        if (prefix != "default") chain.add(prefix)
        parts.removeAt(parts.lastIndex)
      }
    }
    return chain.toList() + "default"
  }

  internal fun normalize(tag: String): String =
    tag.lowercase(java.util.Locale.ROOT).replace('_', '-')

  /** Million-multiple Romance `many` forms are intentionally outside the v1 integer rules. */
  fun pluralCategory(language: String, count: Double): String {
    return PrototypePluralRules.category(normalize(language).substringBefore('-'), count)
  }

  private fun count(value: String?, data: JsonObject?): Long? {
    if (value?.startsWith("{data:") != true) {
      return value?.takeIf { digits.matches(it) }?.toLong()
    }
    val raw =
      PrototypeDataPointer.resolve(data, value.substring(6, value.length - 1)) as? JsonPrimitive
        ?: return null
    if (raw.isString) return raw.content.takeIf { digits.matches(it) }?.toLong()
    return raw.doubleOrNull
      ?.takeIf { it.isFinite() && it >= 0 && it <= 999999999.0 && it % 1 == 0.0 }
      ?.toLong()
  }

  fun resolveText(
    strings: JsonObject,
    locales: List<String>,
    text: String,
    data: JsonObject? = null,
  ): String {
    val uses = uses(text, strict = false) ?: return text
    val tables = strings.entries.associate { normalize(it.key) to (it.value as? JsonObject) }
    val chain = localeChain(locales)
    return buildString {
      var cursor = 0
      for (use in uses) {
        val tag = chain.firstOrNull { tables[it]?.containsKey(use.key) == true }
        val entry = tables[tag]?.get(use.key)
        val count = count(use.count, data)
        val language = if (tag == "default") locales.firstOrNull() ?: "en" else tag ?: "en"
        val category = count?.let { pluralCategory(language, it.toDouble()) } ?: "other"
        val plural = entry as? JsonObject
        val translated =
          (entry as? JsonPrimitive)?.content
            ?: ((plural?.get(category) ?: plural?.get("other")) as? JsonPrimitive)?.content
            ?: use.key
        append(text.substring(cursor, use.start))
        append(if (count == null) translated else translated.replace("{#}", count.toString()))
        cursor = use.end
      }
      append(text.substring(cursor))
    }
  }

  /** The complete spec transform leaves contract-declared opaque subtrees untouched. */
  fun resolve(spec: JsonObject, locales: List<String>): JsonObject {
    val strings = spec["strings"] as? JsonObject ?: return spec
    return transform(spec, "", strings, locales, spec["data"] as? JsonObject).jsonObject
  }

  fun resolve(spec: PrototypeSpec, locales: List<String>): PrototypeSpec {
    if (spec.strings == null) return spec
    val json = PrototypeSpecValidator.json
    return json.decodeFromJsonElement(resolve(json.encodeToJsonElement(spec).jsonObject, locales))
  }

  private fun transform(
    value: JsonElement,
    parent: String,
    strings: JsonObject,
    locales: List<String>,
    data: JsonObject?,
  ): JsonElement =
    when (value) {
      is JsonArray -> JsonArray(value.map { transform(it, parent, strings, locales, data) })
      is JsonObject ->
        JsonObject(
          value.mapValues { (key, child) ->
            when {
              key in opaque -> child
              child is JsonPrimitive &&
                child.isString &&
                (key in display || "$parent.$key" in display) ->
                JsonPrimitive(resolveText(strings, locales, child.content, data))
              else -> transform(child, key, strings, locales, data)
            }
          },
        )
      else -> value
    }

  internal data class Field(val path: String, val text: String, val description: Boolean)

  internal fun fields(
    value: JsonElement,
    path: String = "",
    parent: String = "",
    descendNodes: Boolean = true,
  ): List<Field> =
    when (value) {
      is JsonArray ->
        value.flatMapIndexed { index, child ->
          fields(child, "$path[$index]", parent, descendNodes)
        }
      is JsonObject ->
        value.flatMap { (key, child) ->
          val at = if (path.isEmpty()) key else "$path.$key"
          when {
            key in opaque || (!descendNodes && key in setOf("child", "children", "screens")) ->
              emptyList()
            child is JsonPrimitive &&
              child.isString &&
              (key in display || "$parent.$key" in display || key == "contentDescription") ->
              listOf(Field(at, child.content, key == "contentDescription"))
            else -> fields(child, at, key, descendNodes)
          }
        }
      else -> emptyList()
    }
}
