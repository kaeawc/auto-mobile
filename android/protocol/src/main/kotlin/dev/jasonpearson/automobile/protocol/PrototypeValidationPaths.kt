package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.pathKeyPattern
import dev.jasonpearson.automobile.protocol.PrototypeSpecInput.canonicalString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

internal object PrototypeValidationPaths {
  fun fail(path: String, message: String) = PrototypeSpecError(path.ifEmpty { "$" }, message)

  fun keyPath(path: String, key: String): String =
    if (pathKeyPattern.matches(key)) {
      if (path.isEmpty()) key else "$path.$key"
    } else "${path.ifEmpty { "$" }}[${canonicalString(key)}]"

  fun JsonObject.flag(key: String): Boolean = (get(key) as? JsonPrimitive)?.booleanOrNull == true

  fun JsonObject.number(key: String, fallback: Double): Double =
    (get(key) as? JsonPrimitive)?.doubleOrNull ?: fallback

  fun JsonObject.text(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
}
