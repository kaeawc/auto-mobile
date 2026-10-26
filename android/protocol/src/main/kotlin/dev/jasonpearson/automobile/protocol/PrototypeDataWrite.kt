package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/** One `/data` write, with the path spelled `/data/<pointer>` and any `{index}` already bound. */
sealed interface PrototypeDataWrite {
  val path: String

  data class Set(override val path: String, val value: JsonElement) : PrototypeDataWrite

  data class Append(override val path: String, val value: JsonElement) : PrototypeDataWrite

  data class Remove(override val path: String) : PrototypeDataWrite

  /** The wire `op` of the `change` event that reports this write. */
  val op: String
    get() =
      when (this) {
        is Set -> "set"
        is Append -> "append"
        is Remove -> "remove"
      }
}

enum class PrototypeDataWriteErrorCode(val wireValue: String) {
  INVALID_PATH("invalid_path"),
  INVALID_VALUE("invalid_value"),
  NOT_FOUND("not_found"),
  NOT_ARRAY("not_array"),
  LIMIT_EXCEEDED("limit_exceeded"),
}

data class PrototypeDataWriteError(val code: PrototypeDataWriteErrorCode, val message: String)

sealed interface PrototypeDataWriteResult {
  data class Success(val data: JsonObject) : PrototypeDataWriteResult

  data class Failure(val error: PrototypeDataWriteError) : PrototypeDataWriteResult
}

/**
 * The pure semantics of a data write; the Kotlin twin of `applyPrototypeDataWrite` in
 * `src/features/prototype/prototypeDataWrite.ts`, with the same typed errors. `set` creates or
 * replaces an object member and replaces an existing array element; `append` pushes onto an
 * existing array; `remove` deletes an existing member or element (later elements shift down). The
 * input is never mutated, and the result must satisfy the data limits including
 * `MAX_PROTOTYPE_DATA_WRITE_BYTES`, or nothing is written.
 */
object PrototypeDataWriter {
  private const val DATA_PREFIX = "/data"

  /** The pointer of a `/data/<pointer>` path, or null; `/data` alone is refused. */
  fun pathPointer(path: String): String? {
    if (!path.startsWith("$DATA_PREFIX/")) return null
    val pointer = path.removePrefix(DATA_PREFIX)
    return pointer.takeIf(PrototypeDataPointer::isValid)
  }

  fun apply(data: JsonObject?, write: PrototypeDataWrite): PrototypeDataWriteResult {
    val pointer =
      pathPointer(write.path)
        ?: return refused(
          PrototypeDataWriteErrorCode.INVALID_PATH,
          "${write.path} is not a /data/<pointer> path",
        )
    val current = data ?: JsonObject(emptyMap())
    targetRefusal(current, pointer, write)?.let {
      return it
    }
    val tokens = PrototypeDataPointer.tokens(pointer)
    val next =
      when (write) {
        is PrototypeDataWrite.Set -> update(current, tokens) { _ -> write.value }
        is PrototypeDataWrite.Append ->
          update(current, tokens) { target -> JsonArray((target as JsonArray) + write.value) }
        is PrototypeDataWrite.Remove -> remove(current, tokens)
      }
        as JsonObject
    val invalid = PrototypeSpecValidator.dataWriteError(next)
    if (invalid != null) {
      val code =
        if (invalid.message.contains("limit")) PrototypeDataWriteErrorCode.LIMIT_EXCEEDED
        else PrototypeDataWriteErrorCode.INVALID_VALUE
      return refused(code, invalid.message)
    }
    return PrototypeDataWriteResult.Success(next)
  }

  private fun refused(code: PrototypeDataWriteErrorCode, message: String) =
    PrototypeDataWriteResult.Failure(PrototypeDataWriteError(code, message))

  private fun targetRefusal(
    data: JsonObject,
    pointer: String,
    write: PrototypeDataWrite,
  ): PrototypeDataWriteResult? {
    val existing = PrototypeDataPointer.resolve(data, pointer)
    return when (write) {
      is PrototypeDataWrite.Append ->
        when {
          existing == null ->
            refused(
              PrototypeDataWriteErrorCode.NOT_FOUND,
              "appendData target ${write.path} does not exist",
            )
          existing !is JsonArray ->
            refused(
              PrototypeDataWriteErrorCode.NOT_ARRAY,
              "appendData target ${write.path} is not an array",
            )
          else -> null
        }
      is PrototypeDataWrite.Remove ->
        if (existing == null)
          refused(
            PrototypeDataWriteErrorCode.NOT_FOUND,
            "removeData target ${write.path} does not exist",
          )
        else null
      is PrototypeDataWrite.Set -> {
        val parentPointer = pointer.substring(0, pointer.lastIndexOf('/'))
        val parent =
          if (parentPointer.isEmpty()) data else PrototypeDataPointer.resolve(data, parentPointer)
        val container = parent is JsonObject || parent is JsonArray
        // An array element is replaced, never created: appending is appendData's job.
        if (!container || (existing == null && parent is JsonArray))
          refused(
            PrototypeDataWriteErrorCode.NOT_FOUND,
            "setData target ${write.path} has no existing parent or element",
          )
        else null
      }
    }
  }

  /** Rebuilds the spine to [tokens], replacing the value there with [transform]'s result. */
  private fun update(
    node: JsonElement,
    tokens: List<String>,
    transform: (JsonElement?) -> JsonElement,
  ): JsonElement {
    val token = tokens.first()
    val last = tokens.size == 1
    return when (node) {
      is JsonObject ->
        JsonObject(
          LinkedHashMap(node).also { copy ->
            copy[token] =
              if (last) transform(node[token])
              else update(node.getValue(token), tokens.drop(1), transform)
          },
        )
      is JsonArray -> {
        val index = checkNotNull(token.toIntOrNull())
        JsonArray(
          node.mapIndexed { at, child ->
            if (at != index) child
            else if (last) transform(child) else update(child, tokens.drop(1), transform)
          },
        )
      }
      else -> node
    }
  }

  private fun remove(node: JsonElement, tokens: List<String>): JsonElement {
    val token = tokens.first()
    val last = tokens.size == 1
    return when (node) {
      is JsonObject ->
        JsonObject(
          LinkedHashMap(node).also { copy ->
            if (last) copy.remove(token)
            else copy[token] = remove(node.getValue(token), tokens.drop(1))
          },
        )
      is JsonArray -> {
        val index = checkNotNull(token.toIntOrNull())
        if (last) JsonArray(node.filterIndexed { at, _ -> at != index })
        else
          JsonArray(
            node.mapIndexed { at, child ->
              if (at == index) remove(child, tokens.drop(1)) else child
            },
          )
      }
      else -> node
    }
  }

  /**
   * `{state}` and `{data}` read the committed values at the action; a missing source is an error.
   */
  fun resolveValue(binding: EmitContextBinding, inputs: EmitContextInputs): PrototypeDataValue {
    fun fail(code: PrototypeDataWriteErrorCode, message: String) =
      PrototypeDataValue.Failure(PrototypeDataWriteError(code, message))
    return when {
      "value" in binding -> PrototypeDataValue.Resolved(binding.getValue("value"))
      "state" in binding -> {
        val key = binding.getValue("state").jsonPrimitive.content
        inputs.state(key)?.let(PrototypeDataValue::Resolved)
          ?: fail(PrototypeDataWriteErrorCode.INVALID_VALUE, "State key $key is not set")
      }
      "data" in binding -> {
        val pointer = binding.getValue("data").jsonPrimitive.content
        inputs.data(pointer)?.let(PrototypeDataValue::Resolved)
          ?: fail(PrototypeDataWriteErrorCode.NOT_FOUND, "Data pointer $pointer does not exist")
      }
      "platform" in binding || "event" in binding -> {
        val source = if ("platform" in binding) "platform" else "event"
        val pointer = binding.getValue(source).jsonPrimitive.content
        val value = if (source == "platform") inputs.platform(pointer) else inputs.event(pointer)
        value?.let(PrototypeDataValue::Resolved)
          ?: fail(PrototypeDataWriteErrorCode.NOT_FOUND, "Data pointer $pointer does not exist")
      }
      else ->
        fail(
          PrototypeDataWriteErrorCode.INVALID_VALUE,
          "A data write value must be bound to a literal, state or data before it runs",
        )
    }
  }
}

sealed interface PrototypeDataValue {
  data class Resolved(val value: JsonElement) : PrototypeDataValue

  data class Failure(val error: PrototypeDataWriteError) : PrototypeDataValue
}
