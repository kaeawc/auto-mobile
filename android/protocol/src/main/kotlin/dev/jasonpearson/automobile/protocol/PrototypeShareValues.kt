package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

internal object PrototypeShareValues {
  private val tokens = Regex("\\{([^{}]*)\\}")

  fun text(value: JsonElement?) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

  fun bytes(value: String) = value.toByteArray(Charsets.UTF_8).size

  fun error(path: String, message: String) = PrototypeSpecError(path, message)

  fun member(path: String, key: String) = PrototypeValidationPaths.keyPath(path, key)

  fun maskTemplate(text: String, replacement: String = "x"): String =
    tokens.replace(text) { match ->
      val token = match.groupValues[1]
      if (templateToken(token)) replacement else match.value
    }

  fun assetId(value: JsonElement?): String? =
    text(value) ?: (value as? JsonObject)?.takeIf { it.size == 1 }?.get("asset")?.let(::text)

  private fun templateToken(token: String): Boolean =
    when {
      token.split('.').let {
        it.size == 2 && it.all(PrototypeSpecContract.stateKeyPattern::matches)
      } -> true
      token.startsWith("data:") -> PrototypeDataPointer.isValid(token.substring(5))
      else -> PrototypeSpecContract.stateKeyPattern.matches(token)
    }
}
