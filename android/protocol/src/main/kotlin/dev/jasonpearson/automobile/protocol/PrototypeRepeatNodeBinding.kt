package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Binds a repeat row's item and index into a template node's raw action fields. */
object PrototypeRepeatNodeBinding {
  private data class RowBinding(
    val alias: String,
    val item: Map<String, JsonElement>,
    val index: Int,
    val outerAlias: String?,
  )

  /**
   * Binds raw action fields with the same field visitor the repeat validator uses. Literal JSON and
   * match bindings stay untouched until a link tap.
   */
  fun bindNodeFields(
    node: JsonObject,
    alias: String,
    item: Map<String, JsonElement>,
    index: Int,
    outerAlias: String? = null,
  ): JsonObject {
    val binding = RowBinding(alias, item, index, outerAlias)
    val replacements = mutableMapOf<String, JsonElement>()
    PrototypeBindableFields.first<Unit>(node, "root") { value, path, kind ->
      val bound = boundField(value, kind, binding)
      if (bound != null && bound != value) replacements[path] = bound
      null
    }
    fun replace(value: JsonElement, path: String): JsonElement =
      replacements[path]
        ?: when (value) {
          is JsonObject ->
            JsonObject(
              value.mapValues { (key, child) ->
                replace(child, PrototypeBindableFields.memberPath(path, key))
              },
            )
          is JsonArray -> JsonArray(value.mapIndexed { at, child -> replace(child, "$path[$at]") })
          else -> value
        }
    return replace(node, "root") as JsonObject
  }

  private fun boundField(
    value: JsonElement?,
    kind: PrototypeBindableKind,
    binding: RowBinding,
  ): JsonElement? {
    val (alias, item, index, outerAlias) = binding
    if (kind == PrototypeBindableKind.EMIT_BINDING && value is JsonObject) {
      return PrototypeRepeatTemplate.bindBinding(value, alias, item, index, outerAlias)
    }
    if (value !is JsonPrimitive || !value.isString) return value
    val only = PrototypeRepeatTemplate.segments(value.content, alias, outerAlias).singleOrNull()
    val operand = kind == PrototypeBindableKind.OPERAND
    return when {
      operand && only is PrototypeRepeatSegment.Index -> JsonPrimitive(index)
      operand && only is PrototypeRepeatSegment.Field -> item[only.name] ?: value
      else ->
        JsonPrimitive(PrototypeRepeatTemplate.bind(value.content, alias, item, index, outerAlias))
    }
  }
}
