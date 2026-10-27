package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Only authored condition slots and textField error options introduce this capability. */
internal object PrototypeStringConditions {
  private val comparisons = setOf("contains", "startsWith", "lengthGt", "lengthLt")

  private fun condition(value: JsonElement?): Boolean {
    val fields = value as? JsonObject ?: return false
    return fields.keys.any { it in comparisons } ||
      condition(fields["not"]) ||
      listOf("all", "any").any { group ->
        (fields[group] as? JsonArray).orEmpty().any(::condition)
      }
  }

  fun uses(node: JsonObject): Boolean =
    ((node["type"] as? JsonPrimitive)?.content == "textField" &&
      ("errorWhen" in node || "errorText" in node)) ||
      listOf("visibleWhen", "enabledWhen").any { condition(node[it]) } ||
      (node["styleWhen"] as? JsonArray).orEmpty().any {
        condition((it as? JsonObject)?.get("when"))
      }
}
