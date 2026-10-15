package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Pure patch applier; the caller validates the resulting spec separately (#11675). */
object PrototypePatch {
  enum class StateTests {
    EVALUATE,
    SKIP,
  }

  sealed class Result {
    data class Success(val spec: JsonObject) : Result()

    data class Failure(val error: PrototypeSpecError) : Result()
  }

  private class Rejection(val error: PrototypeSpecError) : RuntimeException()

  private fun reject(path: String, message: String): Nothing =
    throw Rejection(PrototypeSpecError(path, message))

  private fun text(value: JsonElement?): String? =
    (value as? JsonPrimitive)?.takeIf { it.isString }?.content

  /** First error in op order wins. Immutable JSON values rebuild only the changed path. */
  fun apply(
    spec: JsonElement,
    ops: JsonElement,
    stateTests: StateTests = StateTests.EVALUATE,
  ): Result =
    try {
      var current = spec as? JsonObject ?: reject("$", "Expected object")
      val operations = ops as? JsonArray ?: reject("ops", "Expected array")
      if (operations.size !in 1..PrototypeSpecValidator.MAX_PROTOTYPE_PATCH_OPS) {
        reject("ops", "Array length out of range")
      }
      operations.forEachIndexed { index, value ->
        val at = "ops[$index]"
        val op = shape(value, at)
        current = applyOp(current, op, at, stateTests)
      }
      Result.Success(current)
    } catch (failure: Rejection) {
      Result.Failure(failure.error)
    }

  fun touchesState(ops: JsonElement): Boolean =
    (ops as? JsonArray)?.any {
      val path = text((it as? JsonObject)?.get("path"))
      path == "/state" || path?.startsWith("/state/") == true
    } == true

  private fun shape(value: JsonElement, at: String): JsonObject {
    val op = value as? JsonObject ?: reject(at, "Expected object")
    val name = text(op["op"])
    if (name !in listOf("add", "replace", "remove", "test", "replaceNode")) {
      reject("$at.op", "Unknown or missing op")
    }
    val required =
      when (name) {
        "replaceNode" -> listOf("id", "node")
        "remove" -> listOf("path")
        else -> listOf("path", "value")
      }
    op.keys
      .filter { it != "op" && it !in required }
      .sortedWith { a, b ->
        compareNames(a, b)
      }
      .firstOrNull()
      ?.let { reject("$at.$it", "Unknown property") }
    required.firstOrNull { it !in op }?.let { reject("$at.$it", "Required property") }
    checkTypes(op, at, name)
    return op
  }

  private fun compareNames(a: String, b: String): Int {
    val left = a.codePoints().toArray()
    val right = b.codePoints().toArray()
    for (index in 0 until minOf(left.size, right.size)) {
      if (left[index] != right[index]) return left[index].compareTo(right[index])
    }
    return left.size.compareTo(right.size)
  }

  private fun checkTypes(op: JsonObject, at: String, name: String?) {
    if (name == "replaceNode") {
      if (text(op["id"]).isNullOrEmpty()) reject("$at.id", "Expected string")
      if (op["node"] !is JsonObject) reject("$at.node", "Expected object")
    } else if (text(op["path"]) == null) reject("$at.path", "Expected string")
  }

  private fun applyOp(spec: JsonObject, op: JsonObject, at: String, tests: StateTests): JsonObject {
    if (text(op["op"]) == "replaceNode") return replaceNode(spec, op, at)
    val path = checkNotNull(text(op["path"]))
    val prefix = path.split('/').getOrNull(1)
    if (path.startsWith('/') && prefix in listOf("root", "window", "theme")) {
      reject(
        "$at.path",
        "Not patchable: use show for window, theme and root changes, or replaceNode for one node",
      )
    }
    val suffix = path.drop(if (prefix == "data") "/data".length else "/state".length)
    if (
      !path.startsWith('/') ||
        prefix !in listOf("data", "state") ||
        (suffix.isNotEmpty() && !PrototypeDataPointer.isValid(suffix))
    ) {
      reject("$at.path", "Patch paths start with /data or /state")
    }
    val tokens = PrototypeDataPointer.tokens(suffix)
    return if (prefix == "state") applyState(spec, op, tokens, at, tests)
    else change(spec, listOf("data") + tokens, op, at) as JsonObject
  }

  private fun applyState(
    spec: JsonObject,
    op: JsonObject,
    tokens: List<String>,
    at: String,
    tests: StateTests,
  ): JsonObject {
    if (tokens.size != 1) reject("$at.path", "State patches address one key: /state/<key>")
    val key = tokens.first()
    if (!PrototypeRepeatTemplate.isFieldName(key)) reject("$at.path", "Invalid state key")
    val name = text(op["op"])
    if (name != "remove" && !PrototypeDataValues.isScalar(op["value"])) {
      reject("$at.value", "Invalid scalar value")
    }
    val state = spec["state"] as? JsonObject ?: JsonObject(emptyMap())
    if (name != "add" && key !in state) reject("$at.path", "Path does not exist")
    if (name == "test" && tests == StateTests.SKIP) return spec
    val changed = member(state, key, op, at)
    return if (name == "test") spec else JsonObject(spec + ("state" to changed))
  }

  private fun arrayIndex(token: String, size: Int, add: Boolean): Int? {
    if (add && token == "-") return size
    if (
      token != "0" && !(token.isNotEmpty() && token[0] in '1'..'9' && token.all { it in '0'..'9' })
    )
      return null
    return token.toIntOrNull()?.takeIf { it < size || (add && it == size) }
  }

  private fun change(
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

  private fun member(parent: JsonObject, key: String, op: JsonObject, at: String): JsonObject {
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

  private fun array(parent: JsonArray, key: String, op: JsonObject, at: String): JsonArray {
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

  private fun equal(left: JsonElement?, right: JsonElement?): Boolean =
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

  private fun primitiveEqual(left: JsonPrimitive, right: JsonPrimitive): Boolean =
    when {
      left.isString || right.isString ->
        left.isString && right.isString && left.content == right.content
      left.booleanOrNull != null || right.booleanOrNull != null ->
        left.booleanOrNull == right.booleanOrNull
      else -> left.doubleOrNull != null && left.doubleOrNull == right.doubleOrNull
    }

  private data class Entry(
    val node: JsonObject,
    val tokens: List<String>,
    val path: String,
    val insideRepeat: Boolean,
  )

  private fun tree(
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

  private fun replacement(op: JsonObject, at: String): JsonObject {
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

  private fun replaceNode(spec: JsonObject, op: JsonObject, at: String): JsonObject {
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
