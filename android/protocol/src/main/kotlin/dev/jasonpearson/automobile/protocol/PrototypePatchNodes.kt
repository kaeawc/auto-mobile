package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePatchShape.reject
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.text
import dev.jasonpearson.automobile.protocol.PrototypePatchValues.change
import kotlinx.serialization.json.*

internal object PrototypePatchNodes {
  data class Entry(
    val node: JsonObject,
    val tokens: List<String>,
    val path: String,
    val insideRepeat: Boolean,
  )

  fun tree(
    node: JsonObject,
    tokens: List<String>,
    path: String,
    insideRepeat: Boolean = false,
  ): Sequence<Entry> = sequence {
    yield(Entry(node, tokens, path, insideRepeat))
    val repeated = insideRepeat || "repeat" in node
    (node["child"] as? JsonObject)?.let {
      yieldAll(tree(it, tokens + "child", "$path.child", repeated))
    }
    for ((name, screen) in (node["screens"] as? JsonObject).orEmpty()) {
      if (screen is JsonObject) {
        yieldAll(
          tree(
            screen,
            tokens + listOf("screens", name),
            "$path.screens[${JsonPrimitive(name)}]",
            repeated,
          ),
        )
      }
    }
    val children = (node["children"] as? JsonArray).orEmpty()
    for ((index, child) in children.withIndex()) {
      if (child is JsonObject) {
        yieldAll(
          tree(
            child,
            tokens + listOf("children", index.toString()),
            "$path.children[$index]",
            repeated,
          ),
        )
      }
    }
  }

  fun replacement(op: JsonObject, at: String): JsonObject {
    val node = op.getValue("node") as JsonObject
    if (text(node["id"]) != text(op["id"]))
      reject("$at.node.id", "Replacement must keep the same id")
    for (entry in tree(node, emptyList(), "$at.node")) {
      if (text(entry.node["type"]) == "use") {
        reject(
          "${entry.path}.type",
          "Components are not expanded in a patch: inline the node or use show",
        )
      }
      if (text((entry.node["anchor"] as? JsonObject)?.get("type")) == "element") {
        reject(
          "${entry.path}.anchor.type",
          "Element anchors are resolved by show: use a bounds anchor or use show",
        )
      }
    }
    return node
  }

  fun replaceNode(spec: JsonObject, op: JsonObject, at: String): JsonObject {
    val node = replacement(op, at)
    val matches =
      (spec["root"] as? JsonObject)
        ?.let { tree(it, listOf("root"), "root") }
        .orEmpty()
        .filter { text(it.node["id"]) == text(op["id"]) }
        .toList()
    if (matches.isEmpty()) reject("$at.id", "Unknown node id")
    if (matches.size > 1) reject("$at.id", "Node id is not unique")
    val match = matches.first()
    if (match.tokens.size == 1) reject("$at.id", "The root cannot be replaced: use show")
    if (match.insideRepeat) {
      reject("$at.id", "A node inside a repeat cannot be replaced: replace the repeating node")
    }
    val replace = JsonObject(mapOf("op" to JsonPrimitive("replace"), "value" to node))
    return change(spec, match.tokens, replace, at) as JsonObject
  }
}
