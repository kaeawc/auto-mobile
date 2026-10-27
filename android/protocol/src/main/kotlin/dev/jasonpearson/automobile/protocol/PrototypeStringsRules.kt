package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/** Checks whose paths and messages are shared with the host reference implementation. */
internal object PrototypeStringsRules {
  private val categories = setOf("zero", "one", "two", "few", "many", "other")

  private fun limit(name: String): Int =
    PrototypeSpecContract.limits.getValue(name).jsonPrimitive.content.toInt()

  fun tableError(value: JsonElement): PrototypeSpecError? {
    val tables = value as? JsonObject ?: return fail("strings", "Expected string tables")
    if ("default" !in tables) return fail("strings", "Missing default string table")
    if (tables.size > limit("MAX_PROTOTYPE_STRING_LOCALES"))
      return fail("strings", "String locale limit exceeded")
    val seen = mutableSetOf<String>()
    for ((tag, table) in tables) {
      val path = "strings.$tag"
      if (tag != "default" && !PrototypeSpecContract.patterns.getValue("localeTag").matches(tag))
        return fail(path, "Invalid locale tag")
      if (!seen.add(PrototypeStrings.normalize(tag))) return fail(path, "Duplicate locale tag")
      entriesError(table, path)?.let {
        return it
      }
    }
    return null
  }

  private fun entriesError(value: JsonElement, path: String): PrototypeSpecError? {
    val table = value as? JsonObject ?: return fail(path, "Expected string table")
    if (table.size > limit("MAX_PROTOTYPE_STRING_KEYS"))
      return fail(path, "String key limit exceeded")
    for ((key, entry) in table) {
      val at = "$path.$key"
      if (!PrototypeSpecContract.patterns.getValue("stringKey").matches(key))
        return fail(at, "Invalid string key")
      entryError(entry, at)?.let {
        return it
      }
    }
    return null
  }

  private fun isStringOrPluralObject(entry: JsonElement, plural: JsonObject?): Boolean =
    (entry is JsonPrimitive && entry.isString) ||
      (plural != null && "other" in plural && plural.keys.all { it in categories })

  private fun entryError(entry: JsonElement, path: String): PrototypeSpecError? {
    val plural = entry as? JsonObject
    if (!isStringOrPluralObject(entry, plural)) return fail(path, "Invalid plural object")
    for (value in plural?.values ?: listOf(entry)) {
      val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
      if (text == null || text.isEmpty() || text.length > limit("MAX_PROTOTYPE_STRING_LENGTH"))
        return fail(path, "Invalid translation string")
      if (
        listOf("{t:", "{data:", "{platform:").any { it in text } ||
          (plural == null && "{#}" in text)
      )
        return fail(path, "Forbidden translation placeholder")
    }
    return null
  }

  fun semanticError(value: JsonElement, context: Context): PrototypeSpecError? {
    semanticsError(context)?.let {
      return it
    }
    val tables = (value as? JsonObject)?.get("strings") as? JsonObject
    for ((node, path) in context.nodes) {
      for (field in PrototypeStrings.fields(node, path, descendNodes = false)) {
        if ("{t:" !in field.text) continue
        fieldError(field, tables)?.let {
          return it
        }
      }
    }
    return null
  }

  private fun semanticsError(context: Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      val semantics = node["semantics"] as? JsonObject ?: continue
      if (semantics.isEmpty())
        return fail("$path.semantics", "Expected at least one semantics field")
      if ("label" in semantics && "contentDescription" in node)
        return fail("$path.semantics.label", "semantics.label conflicts with contentDescription")
    }
    return null
  }

  private fun fieldError(field: PrototypeStrings.Field, tables: JsonObject?): PrototypeSpecError? {
    if (field.description) return fail(field.path, "Use semantics.label for string placeholders")
    if (tables == null) return fail(field.path, "String placeholders require strings")
    val uses =
      PrototypeStrings.uses(field.text) ?: return fail(field.path, "Invalid string placeholder")
    val defaults = tables["default"] as? JsonObject
    for (use in uses) {
      if (defaults == null || use.key !in defaults)
        return fail(field.path, "Unknown string key \"${use.key}\"")
      if (defaults[use.key] !is JsonPrimitive && use.count == null)
        return fail(field.path, "String \"${use.key}\" is plural: write {t:${use.key}|count}")
    }
    return null
  }
}
