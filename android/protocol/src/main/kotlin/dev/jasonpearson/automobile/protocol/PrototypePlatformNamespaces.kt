package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Strip foreign node namespaces and window/theme blocks after strict contract validation. */
internal fun stripPlatformNamespaces(element: JsonElement): JsonElement {
  val spec = element as? JsonObject ?: return element
  return JsonObject(
    spec
      .mapValues { (key, value) ->
        when (key) {
          "root" -> stripNodeNamespaces(value)
          "window" -> stripNamespaceKeys(value)
          // A theme that held only a namespace has nothing left, and an empty theme is invalid.
          "theme" -> stripNamespaceKeys(value).takeUnless { it is JsonObject && it.isEmpty() }
          else -> value
        }
      }
      .filterValues { it != null }
      .mapValues { (_, value) -> checkNotNull(value) },
  )
}

private fun stripNamespaceKeys(value: JsonElement): JsonElement =
  (value as? JsonObject)?.let {
    JsonObject(it.filterKeys { key -> key != "ios" && key != "android" })
  } ?: value

private fun stripNodeNamespaces(value: JsonElement): JsonElement {
  val node = value as? JsonObject ?: return value
  var stripped: JsonElement = node
  // The shared node walker owns the contract's node-bearing fields, including list slots.
  for (entry in PrototypePatchNodes.tree(node, emptyList(), "root").toList().asReversed()) {
    val replacement =
      JsonObject(
        mapOf(
          "op" to kotlinx.serialization.json.JsonPrimitive("replace"),
          "value" to stripNamespaceKeysAtNode(stripped, entry.tokens),
        ),
      )
    stripped =
      if (entry.tokens.isEmpty()) replacement.getValue("value")
      else PrototypePatchValues.change(stripped, entry.tokens, replacement, entry.path)
  }
  return stripped
}

private fun stripNamespaceKeysAtNode(value: JsonElement, tokens: List<String>): JsonElement {
  var current = value
  for (token in tokens) {
    current =
      when (val parent = current) {
        is JsonArray -> parent[token.toInt()]
        is JsonObject -> parent.getValue(token)
        else -> return current
      }
  }
  val node = current as? JsonObject ?: return current
  val glass = setOf("glassGroup", "glassUnion", "glassTransition", "backgroundExtension")
  val ios = node["ios"] as? JsonObject
  // Keep only foreign glass metadata for group-scoped shared IDs during typed round trips.
  // Android's own namespace reaches the renderer; other iOS fields remain ignored.
  val glassMetadata = ios?.filterKeys { it in glass }?.takeIf { it.isNotEmpty() }
  return JsonObject(
    node.filterKeys { it != "ios" } +
      (glassMetadata?.let { mapOf("ios" to JsonObject(it)) } ?: emptyMap()),
  )
}
