package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePatchShape.isPositiveIndex
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.reject
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.text
import kotlinx.serialization.json.*

internal object PrototypePatchValues {
  fun arrayIndex(token: String, size: Int, add: Boolean): Int? {
    if (add && token == "-") return size
    if (token != "0" && !isPositiveIndex(token)) return null
    return token.toIntOrNull()?.takeIf { it < size || (add && it == size) }
  }

  fun change(
    parent: JsonElement,
    tokens: List<String>,
    op: JsonObject,
    at: String,
  ): JsonElement {
    val key = tokens.first()
    if (tokens.size == 1)
      return when (parent) {
        is JsonObject -> member(parent, key, op, at)
        is JsonArray -> array(parent, key, op, at)
        else -> reject("$at.path", "Path does not exist")
      }
    return when (parent) {
      is JsonObject -> {
        val child = parent[key] ?: reject("$at.path", "Path does not exist")
        JsonObject(parent + (key to change(child, tokens.drop(1), op, at)))
      }
      is JsonArray -> {
        val index = arrayIndex(key, parent.size, false) ?: reject("$at.path", "Path does not exist")
        JsonArray(
          parent.toMutableList().apply {
            this[index] = change(this[index], tokens.drop(1), op, at)
          },
        )
      }
      else -> reject("$at.path", "Path does not exist")
    }
  }

  fun member(parent: JsonObject, key: String, op: JsonObject, at: String): JsonObject {
    val name = text(op["op"])
    if (name != "add" && key !in parent) reject("$at.path", "Path does not exist")
    return when (name) {
      "test" -> {
        if (!equal(parent[key], op["value"])) reject("$at.value", "Test failed")
        parent
      }
      "remove" -> JsonObject(parent - key)
      else -> JsonObject(parent + (key to op.getValue("value")))
    }
  }

  fun array(parent: JsonArray, key: String, op: JsonObject, at: String): JsonArray {
    val name = text(op["op"])
    val index =
      arrayIndex(key, parent.size, name == "add") ?: reject("$at.path", "Path does not exist")
    val items = parent.toMutableList()
    when (name) {
      "test" -> if (!equal(items[index], op["value"])) reject("$at.value", "Test failed")
      "add" -> items.add(index, op.getValue("value"))
      "remove" -> items.removeAt(index)
      "replace" -> items[index] = op.getValue("value")
    }
    return JsonArray(items)
  }

  fun equal(left: JsonElement?, right: JsonElement?): Boolean =
    when {
      left == null || right == null -> false
      left == JsonNull || right == JsonNull -> left == right
      left is JsonObject && right is JsonObject ->
        left.keys == right.keys && left.all { (key, value) -> equal(value, right[key]) }
      left is JsonArray && right is JsonArray ->
        left.size == right.size && left.indices.all { equal(left[it], right[it]) }
      left is JsonPrimitive && right is JsonPrimitive -> primitiveEqual(left, right)
      else -> false
    }

  fun primitiveEqual(left: JsonPrimitive, right: JsonPrimitive): Boolean =
    when {
      left.isString || right.isString ->
        left.isString && right.isString && left.content == right.content
      left.booleanOrNull != null || right.booleanOrNull != null ->
        left.booleanOrNull == right.booleanOrNull
      else -> left.doubleOrNull != null && left.doubleOrNull == right.doubleOrNull
    }
}
