package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

internal object PrototypePatchShape {
  class Rejection(val error: PrototypeSpecError) : RuntimeException()

  fun reject(path: String, message: String): Nothing =
    throw Rejection(PrototypeSpecError(path, message))

  fun text(value: JsonElement?): String? =
    (value as? JsonPrimitive)?.takeIf { it.isString }?.content

  /** First error in op order wins. Immutable JSON values rebuild only the changed path. */
  fun shape(value: JsonElement, at: String): JsonObject {
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

  fun compareNames(a: String, b: String): Int {
    val left = a.codePoints().toArray()
    val right = b.codePoints().toArray()
    for (index in 0 until minOf(left.size, right.size)) {
      if (left[index] != right[index]) return left[index].compareTo(right[index])
    }
    return left.size.compareTo(right.size)
  }

  fun checkTypes(op: JsonObject, at: String, name: String?) {
    if (name == "replaceNode") {
      if (text(op["id"]).isNullOrEmpty()) reject("$at.id", "Expected string")
      if (op["node"] !is JsonObject) reject("$at.node", "Expected object")
    } else if (text(op["path"]) == null) reject("$at.path", "Expected string")
  }

  fun invalidSuffix(suffix: String): Boolean =
    suffix.isNotEmpty() && !PrototypeDataPointer.isValid(suffix)

  fun isPositiveIndex(token: String): Boolean =
    token.isNotEmpty() && token[0] in '1'..'9' && token.all { it in '0'..'9' }
}
