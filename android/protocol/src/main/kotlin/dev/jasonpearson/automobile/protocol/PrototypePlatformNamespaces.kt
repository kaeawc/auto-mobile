package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Validated namespace blocks are currently ignored by the renderer, never by the validator. */
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
  val node = stripNamespaceKeys(value) as? JsonObject ?: return value
  return JsonObject(
    node.mapValues { (key, child) ->
      when (key) {
        "child" -> stripNodeNamespaces(child)
        "children" ->
          (child as? JsonArray)?.let { JsonArray(it.map(::stripNodeNamespaces)) } ?: child
        "screens" ->
          (child as? JsonObject)?.let {
            JsonObject(it.mapValues { (_, screen) -> stripNodeNamespaces(screen) })
          } ?: child
        else -> child
      }
    },
  )
}
