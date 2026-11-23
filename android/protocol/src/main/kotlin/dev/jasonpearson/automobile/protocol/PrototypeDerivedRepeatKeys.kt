package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.fail
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatValidator.Scope
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Host-side identity checks for repeat keys bound to a `repeat.derive` field. */
internal object PrototypeDerivedRepeatKeys {
  /**
   * A derived key's string is formatted on the device, but one entry formats equal inputs to equal
   * strings, so two rows that feed it the same input always share a key (#18665).
   */
  fun error(
    node: JsonObject,
    scope: Scope,
    key: String,
    at: String,
  ): PrototypeSpecError? {
    val derive = (node["repeat"] as? JsonObject)?.get("derive") as? JsonObject
    val of = (derive?.get(key) as? JsonObject)?.get("of") as? JsonObject
    if (of == null || scope.items.size < 2) return null
    val constant = of.containsKey("value")
    val field = of.text("item")
    if (!constant && (field == null || field in scope.derivedNames)) return null
    val seen = mutableMapOf<String, Int>()
    for ((index, item) in scope.items.withIndex()) {
      val input = if (constant) "constant" else input(item[checkNotNull(field)])
      if (input == null) continue
      seen[input]?.let { first ->
        return fail(
          at,
          "Derived repeat key ${JsonPrimitive(key)} has the same input for items $first and $index",
        )
      }
      seen[input] = index
    }
    return null
  }

  /** The row's input to a derived key, or null when it is not a comparable scalar. */
  private fun input(value: JsonElement?): String? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive is JsonNull) return null
    return when {
      primitive.isString -> "string:${primitive.content}"
      primitive.content == "true" || primitive.content == "false" -> "boolean:${primitive.content}"
      else -> primitive.doubleOrNull?.let { "number:$it" }
    }
  }
}
