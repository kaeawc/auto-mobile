package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.net.URLDecoder
import kotlinx.serialization.json.*

/** Adapts the validated spec table to the pure matcher and the ordinary tap executor. */
internal class PrototypeInboundRouting(links: JsonArray?) {
  private val entries = links.orEmpty().map { it.jsonObject }
  private val json = Json { classDiscriminator = "type" }

  fun resolve(url: String, schemes: List<String>): PrototypeLinkMatcher.Match? =
    PrototypeLinkResolver.resolve(
      url,
      PrototypeLinkResolver.Registration(schemes),
      entries.map {
        PrototypeLinkMatcher.Entry(
          it.getValue("path").jsonPrimitive.content,
          (it["query"] as? JsonObject).orEmpty().mapValues { (_, declaration) ->
            (declaration as? JsonObject)?.getValue("type")?.jsonPrimitive?.content
              ?: declaration.jsonPrimitive.content
          },
        )
      },
    )

  fun path(match: PrototypeLinkMatcher.Match): String =
    entries[match.entryIndex].getValue("path").jsonPrimitive.content

  fun actions(match: PrototypeLinkMatcher.Match): List<PrototypeAction> {
    val values = match.query + match.captures.mapValues { JsonPrimitive(it.value) }
    return entries[match.entryIndex].getValue("actions").jsonArray.map { raw ->
      json.decodeFromJsonElement<PrototypeAction>(bind(raw, values))
    }
  }

  private fun bind(value: JsonElement, values: Map<String, JsonElement>): JsonElement =
    when (value) {
      is JsonArray -> JsonArray(value.map { bind(it, values) })
      is JsonObject -> bindObject(value, values)
      else -> value
    }

  private fun bindObject(value: JsonObject, values: Map<String, JsonElement>): JsonObject =
    when {
      value.size == 1 && value["link"] is JsonPrimitive -> {
        val name = value.getValue("link").jsonPrimitive.content
        // An absent optional query refuses the whole action list, as on iOS.
        val bound = requireNotNull(values[name]) { "Absent link binding: $name" }
        buildJsonObject { put("value", bound) }
      }
      value.size == 1 && "value" in value -> value
      else -> unwrapStateValue(value.mapValues { (key, child) -> bindField(key, child, values) })
    }

  private fun bindField(
    key: String,
    child: JsonElement,
    values: Map<String, JsonElement>,
  ): JsonElement =
    when {
      key == "payload" -> child
      key in setOf("params", "context", "args", "headers", "query", "form") &&
        child is JsonObject -> JsonObject(child.mapValues { bind(it.value, values) })
      else -> bind(child, values)
    }

  // setState owns a scalar, while params/context/args own binding objects. Nested actions such as
  // startTimer.actions and request.onSuccess are bound here too, so every level unwraps.
  private fun unwrapStateValue(bound: Map<String, JsonElement>): JsonObject {
    if (bound["type"] != JsonPrimitive("setState")) return JsonObject(bound)
    val value = bound["value"]
    return if (value is JsonObject && "value" in value)
      JsonObject(bound + ("value" to value.getValue("value")))
    else JsonObject(bound)
  }

  /** Remove every occurrence, including encoded names, even on an unmatched URL. */
  fun redact(url: String): String {
    val secrets =
      entries
        .flatMap { entry ->
          (entry["query"] as? JsonObject)
            .orEmpty()
            .filterValues {
              (it as? JsonObject)?.get("secret") == JsonPrimitive(true)
            }
            .keys
        }
        .toSet()
    if (secrets.isEmpty() || '?' !in url.substringBefore('#')) return url
    val head = url.substringBefore('#')
    val fragment = if ('#' in url) "#" + url.substringAfter('#') else ""
    val query =
      head
        .substringAfter('?')
        .split('&')
        .filter { pair ->
          val key = runCatching {
            URLDecoder.decode(pair.substringBefore('='), "UTF-8")
          }
            .getOrNull()
          key != null && key !in secrets
        }
        .joinToString("&")
    return head.substringBefore('?') + (if (query.isEmpty()) "" else "?$query") + fragment
  }
}
