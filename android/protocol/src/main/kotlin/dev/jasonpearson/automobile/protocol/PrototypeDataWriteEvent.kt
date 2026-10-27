package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/**
 * A decoded change event; an omitted set/append/extend value is retained for tracking-drop
 * handling.
 */
data class PrototypeDataWriteEvent(
  val path: String,
  val op: String,
  val revision: Long,
  val value: JsonElement? = null,
  val maxItems: Long? = null,
) {
  fun write(): PrototypeDataWrite? =
    when (op) {
      "set" -> value?.let { PrototypeDataWrite.Set(path, it) }
      "append" -> value?.let { PrototypeDataWrite.Append(path, it, maxItems) }
      "extend" -> value?.let { PrototypeDataWrite.Extend(path, it, maxItems) }
      "remove" -> PrototypeDataWrite.Remove(path)
      else -> null
    }

  fun payload(): JsonObject = buildJsonObject {
    put("op", op)
    value?.let { put("value", it) }
    maxItems?.let { put("maxItems", it) }
    put("revision", revision)
  }
}

/** Strict wire decoder matching prototypeDataWriteOf; no side effects or IO. */
fun prototypeDataWriteOf(
  kind: String,
  name: String?,
  payload: JsonElement?,
): PrototypeDataWriteEvent? {
  if (kind != "change" || name == null || PrototypeDataWriter.pathPointer(name) == null) return null
  return decodeDataWrite(name, payload as? JsonObject ?: return null)
}

private fun decodeDataWrite(name: String, fields: JsonObject): PrototypeDataWriteEvent? {
  val op = (fields["op"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
  val allowed =
    when (op) {
      "set" -> setOf("op", "value", "revision")
      "append",
      "extend" -> setOf("op", "value", "revision", "maxItems")
      "remove" -> setOf("op", "revision")
      else -> return null
    }
  if (fields.keys.any { it !in allowed }) return null
  val revision = safeInteger(fields["revision"], 0) ?: return null
  val maxItems =
    if ("maxItems" in fields) safeInteger(fields["maxItems"], 1) ?: return null else null
  val value = fields["value"]
  if (!validWriteValue(op, value)) return null
  return PrototypeDataWriteEvent(name, op, revision, value, maxItems)
}

private fun validWriteValue(op: String, value: JsonElement?): Boolean =
  when {
    value == null -> true
    op == "extend" && value !is JsonArray -> false
    else -> PrototypeRequests.parseJson(value.toString()) != null
  }

private fun safeInteger(value: JsonElement?, minimum: Long): Long? {
  val primitive = value as? JsonPrimitive ?: return null
  if (primitive.isString) return null
  val number = primitive.doubleOrNull ?: return null
  return number
    .takeIf { it.isFinite() && it >= minimum && it <= 9007199254740991L && it == Math.floor(it) }
    ?.toLong()
}
