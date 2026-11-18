package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatTemplate.isFieldName
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTemplate.rendered
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

internal object PrototypeRepeatTokens {
  fun token(inner: String, alias: String, outerAlias: String? = null): PrototypeRepeatSegment? {
    if (outerAlias != null && inner == "outerIndex")
      return PrototypeRepeatSegment.Field("\$outerIndex")
    if (outerAlias != null && inner.startsWith("$outerAlias.")) {
      val name = inner.removePrefix("$outerAlias.")
      return if (isFieldName(name)) PrototypeRepeatSegment.Field("outer.$name") else null
    }
    if (inner == "index") return PrototypeRepeatSegment.Index
    val prefix = "$alias."
    val field = inner.removePrefix(prefix)
    return if (
      inner.startsWith(prefix) &&
        (if (alias == "route") PrototypeSpecContract.pathKeyPattern.matches(field)
        else isFieldName(field))
    )
      PrototypeRepeatSegment.Field(field)
    else null
  }

  fun bind(
    segments: List<PrototypeRepeatSegment>,
    alias: String,
    item: Map<String, JsonElement>,
    index: Int,
  ): String =
    segments.joinToString("") { segment ->
      when (segment) {
        is PrototypeRepeatSegment.Literal -> segment.text
        is PrototypeRepeatSegment.Index -> index.toString()
        is PrototypeRepeatSegment.Field ->
          (item[segment.name] as? JsonPrimitive)?.let(::rendered) ?: "{$alias.${segment.name}}"
      }
    }

  fun isPlaceholder(inner: String): Boolean {
    if (inner == "index" || inner == "outerIndex") return true
    val dot = inner.indexOf('.')
    return dot > 0 &&
      isFieldName(inner.substring(0, dot)) &&
      (if (inner.substring(0, dot) == "route")
        PrototypeSpecContract.pathKeyPattern.matches(inner.substring(dot + 1))
      else isFieldName(inner.substring(dot + 1)))
  }

  fun isKeyCharacter(character: Char): Boolean =
    character in 'A'..'Z' || character in 'a'..'z' || character in '0'..'9' || character == '_'
}
