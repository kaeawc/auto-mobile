package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** [maxItems] is supplied by the runtime from matching lists, never authored on an action. */
@Serializable
data class PrototypeRequestAppend(
  val from: String,
  val to: String,
  @kotlinx.serialization.Transient val maxItems: Long? = null,
)

internal object PrototypeRequestAppendWrites {
  data class Staged(
    val writes: List<PrototypeDataWrite>,
    val appended: Int,
    val message: String? = null,
  )

  fun stage(into: String?, body: JsonElement?, append: PrototypeRequestAppend?): Staged {
    var rest = body?.takeUnless { it is JsonNull } ?: JsonPrimitive("")
    val writes = mutableListOf<PrototypeDataWrite>()
    var appended = 0
    if (append != null) {
      val source =
        extract(body, append.from)
          ?: return Staged(
            emptyList(),
            0,
            "append.from does not resolve to an array in the response",
          )
      writes.add(PrototypeDataWrite.Extend(append.to, source.second, append.maxItems))
      appended = source.second.size
      rest = source.first
    }
    if (into != null) writes.add(PrototypeDataWrite.Set(into, rest))
    return Staged(writes, appended)
  }

  /** Persistent spine rebuild; only an object member may be removed from the response. */
  private fun extract(body: JsonElement?, from: String): Pair<JsonElement, JsonArray>? {
    if (!PrototypeDataPointer.isValid(from) || body == null) return null
    return extractAt(body, PrototypeDataPointer.tokens(from))
  }

  private fun extractAt(node: JsonElement, tokens: List<String>): Pair<JsonElement, JsonArray>? {
    val key = tokens.first()
    if (tokens.size == 1) {
      val owner = node as? JsonObject ?: return null
      val items = owner[key] as? JsonArray ?: return null
      return JsonObject(owner - key) to items
    }
    return when (node) {
      is JsonObject -> {
        val child = node[key] ?: return null
        val result = extractAt(child, tokens.drop(1)) ?: return null
        JsonObject(node + (key to result.first)) to result.second
      }
      is JsonArray -> {
        // Reuse RFC pointer indexing, including its leading-zero rule.
        val child =
          PrototypeDataPointer.resolve(JsonObject(mapOf("array" to node)), "/array/$key")
            ?: return null
        val result = extractAt(child, tokens.drop(1)) ?: return null
        val index = key.toIntOrNull() ?: return null
        JsonArray(node.mapIndexed { i, value -> if (i == index) result.first else value }) to
          result.second
      }
      else -> null
    }
  }
}
