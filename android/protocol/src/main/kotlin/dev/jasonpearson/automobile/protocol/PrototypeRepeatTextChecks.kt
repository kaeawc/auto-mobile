package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.chargeText
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.dataTextError
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.emptyEmitName
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.fail
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.invalidBoundKey
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.string
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.unknownField
import dev.jasonpearson.automobile.protocol.PrototypeRepeatValidator.Scope
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object PrototypeRepeatTextChecks {
  class RepeatState(
    val data: PrototypeRepeatData,
    var cells: Int = 0,
    var total: Long = 0,
  )

  data class BoundText(
    val text: String,
    val segments: List<PrototypeRepeatSegment>,
    val path: String,
    val dataRecognized: Boolean,
  )

  /** Count placeholders once, then evaluate field multiplicities per item. */
  fun repeatTextError(
    field: BoundText,
    scope: Scope,
    state: RepeatState,
  ): PrototypeSpecError? {
    val (text, segments, path, dataRecognized) = field
    val (fields, indices) = placeholderCounts(segments)
    if (!dataRecognized && indices == 0 && fields.isEmpty()) return null
    for ((index, item) in scope.items.withIndex()) {
      var length = indices.toLong() * index.toString().length
      if (length > PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH)
        return fail(path, "Substituted text length limit exceeded")
      for ((name, count) in fields) {
        val value = item[name] as? JsonPrimitive
        length += count.toLong() * (value?.let(PrototypeRepeatTemplate::rendered)?.length ?: 0)
        if (length > PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH)
          return fail(path, "Substituted text length limit exceeded")
      }
      if (!chargeText(state, text.length.toLong() + length))
        return fail(path, "Substituted text total limit exceeded")
    }
    return null
  }

  fun placeholderCounts(segments: List<PrototypeRepeatSegment>): Pair<Map<String, Int>, Int> {
    val fields = mutableMapOf<String, Int>()
    var indices = 0
    for (segment in segments) {
      when (segment) {
        is PrototypeRepeatSegment.Index -> indices++
        is PrototypeRepeatSegment.Field -> fields[segment.name] = (fields[segment.name] ?: 0) + 1
        is PrototypeRepeatSegment.Literal -> Unit
      }
    }
    return fields to indices
  }

  fun fieldError(
    value: JsonElement?,
    path: String,
    kind: PrototypeBindableKind,
    scope: Scope,
    state: RepeatState,
  ): PrototypeSpecError? {
    emitBindingError(value, path, kind, scope)?.let {
      return it
    }
    val text = value.string() ?: return null
    val authored = PrototypeRepeatTemplate.segments(text, scope.alias)
    if (
      kind == PrototypeBindableKind.DATA_OPERAND &&
        authored.any { it !is PrototypeRepeatSegment.Literal }
    ) {
      return fail(path, "Repeat placeholder in a data condition operand is not supported")
    }
    unknownField(authored, path, scope)?.let {
      return it
    }
    var dataRecognized = false
    val resolved =
      if (kind == PrototypeBindableKind.TEXT || kind == PrototypeBindableKind.REQUEST_TEXT)
        state.data.text(text) {
          dataRecognized = true
          chargeText(state, it)
        }
      else text
    if (resolved == null) return dataTextError(path, state)
    val segments =
      if (resolved == text) authored else PrototypeRepeatTemplate.segments(resolved, scope.alias)
    repeatTextError(BoundText(resolved, segments, path, dataRecognized), scope, state)?.let {
      return it
    }
    return when (kind) {
      PrototypeBindableKind.EMIT_NAME -> emptyEmitName(segments, path, scope)
      PrototypeBindableKind.KEY -> invalidBoundKey(text, segments, path, scope)
      else -> null
    }
  }

  fun emitBindingError(
    value: JsonElement?,
    path: String,
    kind: PrototypeBindableKind,
    scope: Scope,
  ): PrototypeSpecError? {
    if (kind == PrototypeBindableKind.EMIT_BINDING) {
      val field = (value as? JsonObject)?.text("item")
      if (field != null && !scope.items.all { it.containsKey(field) })
        return fail(path, "Unknown repeat field ${JsonPrimitive(field)}")
    }
    return null
  }

  fun checkOwnFields(
    node: JsonObject,
    path: String,
    scope: Scope,
    state: RepeatState,
  ): PrototypeSpecError? =
    PrototypeBindableFields.first(node, path) { value, fieldPath, kind ->
      dataPathPlaceholderError(kind, value, fieldPath, scope)
        ?: fieldError(value, fieldPath, kind, scope, state)
    }

  /** A data action path binds only a whole `{index}` segment; `{alias.field}` is refused. */
  fun dataPathPlaceholderError(
    kind: PrototypeBindableKind,
    value: JsonElement?,
    path: String,
    scope: Scope,
  ): PrototypeSpecError? {
    val text = value.string()
    if (!kind.isDataPath() || text == null) return null
    return PrototypeRepeatTemplate.dataPathPlaceholderMessage(text, scope.alias)?.let {
      fail(path, it)
    }
  }
}
