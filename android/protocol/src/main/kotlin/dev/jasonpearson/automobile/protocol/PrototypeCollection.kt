package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Bounded collection operations, independent of state ownership or display formatting. */
internal object PrototypeCollection {
  fun clauses(collection: JsonObject): List<JsonObject> =
    (collection["where"] as? JsonArray).orEmpty().map { it.jsonObject }

  fun collect(
    collection: JsonObject,
    reduce: JsonObject?,
    data: JsonElement?,
    state: Map<String, JsonElement>,
  ): JsonElement {
    val pointer = collection.getValue("of").jsonObject.getValue("data").jsonPrimitive.content
    val filters = clauses(collection)
    val rows =
      (PrototypeDataPointer.resolve(data, pointer) as? JsonArray)
        .orEmpty()
        .take(minOf(500, PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS))
        .filterIsInstance<JsonObject>()
        .filter { row -> filters.all { matches(row, it, state) } }
    val sort = collection["sort"] as? JsonObject
    val ordered = if (sort == null) rows else rows.sortedWith { a, b -> compareRows(a, b, sort) }
    val limited = limit(collection["limit"])?.let(ordered::take) ?: ordered
    return if (reduce == null) JsonArray(limited) else reduce(limited, reduce)
  }

  /**
   * Raw JSON may spell an integral limit as `1.0` or `1e2` before input normalization; read it as a
   * double. A non-integral limit is left to the structural validator, which reports it.
   */
  internal fun limit(value: JsonElement?): Int? =
    numeric(value)
      ?.takeIf { it == kotlin.math.floor(it) && it >= 1.0 && it <= Int.MAX_VALUE }
      ?.toInt()

  private fun numeric(value: JsonElement?): Double? =
    (value as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

  private fun sortable(value: JsonElement?): Boolean =
    (value as? JsonPrimitive)?.isString == true || numeric(value) != null

  private fun matches(
    row: JsonObject,
    clause: JsonObject,
    state: Map<String, JsonElement>,
  ): Boolean {
    val left = row[clause.getValue("field").jsonPrimitive.content]
    val binding = clause.getValue("value").jsonObject
    val right = binding["state"]?.jsonPrimitive?.content?.let(state::get) ?: binding["value"]
    val op = clause.getValue("op").jsonPrimitive.content
    if (op == "contains") return contains(left, right)
    if (!sortable(left) || !sortable(right)) return false
    if ((left as JsonPrimitive).isString != (right as JsonPrimitive).isString) return false
    val comparison = compareValues(left, right)
    return when (op) {
      "eq" -> comparison == 0
      "neq" -> comparison != 0
      "gt" -> comparison > 0
      "gte" -> comparison >= 0
      "lt" -> comparison < 0
      "lte" -> comparison <= 0
      else -> false
    }
  }

  private fun contains(left: JsonElement?, right: JsonElement?): Boolean =
    left is JsonPrimitive &&
      left.isString &&
      right is JsonPrimitive &&
      right.isString &&
      left.content
        .lowercase(java.util.Locale.ROOT)
        .contains(right.content.lowercase(java.util.Locale.ROOT))

  private fun compareRows(a: JsonObject, b: JsonObject, sort: JsonObject): Int {
    val field = sort.getValue("field").jsonPrimitive.content
    val left = a[field]
    val right = b[field]
    if (!sortable(left)) return if (sortable(right)) 1 else 0
    if (!sortable(right)) return -1
    val comparison = compareValues(left as JsonPrimitive, right as JsonPrimitive)
    return if (sort["order"]?.jsonPrimitive?.content == "desc") -comparison else comparison
  }

  private fun compareValues(left: JsonPrimitive, right: JsonPrimitive): Int =
    when {
      !left.isString && !right.isString -> {
        val a = left.double
        val b = right.double
        if (a == b) 0 else if (a < b) -1 else 1
      }
      !left.isString -> -1
      !right.isString -> 1
      else -> compareStrings(left.content, right.content)
    }

  private fun compareStrings(left: String, right: String): Int {
    val a = left.codePoints().toArray()
    val b = right.codePoints().toArray()
    for (index in 0 until minOf(a.size, b.size)) {
      if (a[index] != b[index]) return a[index].compareTo(b[index])
    }
    return a.size.compareTo(b.size)
  }

  private fun reduce(rows: List<JsonObject>, reduce: JsonObject): JsonPrimitive {
    val op = reduce.getValue("op").jsonPrimitive.content
    if (op == "count") return JsonPrimitive(rows.size)
    val field = reduce.getValue("field").jsonPrimitive.content
    val numbers = rows.mapNotNull { numeric(it[field]) }
    return JsonPrimitive(
      when (op) {
        "sum" -> numbers.sum()
        "min" -> numbers.minOrNull() ?: 0.0
        else -> numbers.maxOrNull() ?: 0.0
      },
    )
  }
}
