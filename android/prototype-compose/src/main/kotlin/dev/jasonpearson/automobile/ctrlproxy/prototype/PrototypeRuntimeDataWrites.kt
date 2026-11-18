package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*

/** Resolves values before reading the current list limit, matching action execution order. */
internal fun prototypeDataWrite(
  action: PrototypeAction,
  where: PrototypeDataMatch?,
  value: (EmitContextBinding, String) -> JsonElement?,
  maxItems: (String) -> Int?,
): PrototypeDataWrite? {
  return when (action) {
    is PrototypeSetDataAction ->
      value(action.value, action.path)?.let {
        PrototypeDataWrite.Set(action.path, it, where, action.member)
      }
    is PrototypeAppendDataAction ->
      value(action.value, action.path)?.let {
        PrototypeDataWrite.Append(
          action.path,
          it,
          maxItems(action.path),
        )
      }
    // `prependData` inserts one row, so the resolved value is wrapped as the page `[row]`, as on
    // iOS and in the `change` event (#16715).
    is PrototypePrependDataAction ->
      value(action.value, action.path)?.let {
        PrototypeDataWrite.Prepend(
          action.path,
          JsonArray(listOf(it)),
          maxItems(action.path),
        )
      }
    is PrototypeUpsertDataAction ->
      value(action.value, action.path)?.let {
        PrototypeDataWrite.Upsert(
          action.path,
          action.key,
          it,
          listOfNotNull(action.maxItems, maxItems(action.path)).minOrNull(),
        )
      }
    is PrototypeRemoveDataAction -> PrototypeDataWrite.Remove(action.path, where)
    else -> null
  }
}

/**
 * `{op, value?, revision}`. The value is left out when the payload would not fit an event, so the
 * host, which cannot mirror a write it was not shown, stops tracking the spec.
 */
internal fun prototypeDataWritePayload(write: PrototypeDataWrite, revision: Long): JsonObject {
  fun payload(value: JsonElement?) = buildJsonObject {
    put("op", write.op)
    if (write is PrototypeDataWrite.Upsert) put("key", write.key)
    val where =
      when (write) {
        is PrototypeDataWrite.Set -> write.where
        is PrototypeDataWrite.Remove -> write.where
        else -> null
      }
    where?.let { match ->
      put(
        "where",
        buildJsonObject {
          put("field", match.field)
          put("equals", match.equals)
        },
      )
    }
    if (write is PrototypeDataWrite.Set) write.member?.let { put("member", it) }
    if (value != null) put("value", value)
    val maximum = dataWriteMaxItems(write)
    maximum?.let { put("maxItems", it.toLong()) }
    put("revision", revision)
  }
  val value = dataWriteValue(write)
  val full = payload(value)
  return if (
    full.toString().toByteArray(Charsets.UTF_8).size <=
      PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES
  )
    full
  else payload(null)
}

private fun dataWriteValue(write: PrototypeDataWrite): JsonElement? =
  when (write) {
    is PrototypeDataWrite.Upsert -> write.value
    is PrototypeDataWrite.Set -> write.value
    is PrototypeDataWrite.Append -> write.value
    is PrototypeDataWrite.Prepend -> write.value
    is PrototypeDataWrite.Extend -> write.value
    is PrototypeDataWrite.Remove -> null
  }

private fun dataWriteMaxItems(write: PrototypeDataWrite): Number? =
  when (write) {
    is PrototypeDataWrite.Append -> write.maxItems
    is PrototypeDataWrite.Prepend -> write.maxItems
    is PrototypeDataWrite.Extend -> write.maxItems
    is PrototypeDataWrite.Upsert -> write.maxItems
    else -> null
  }
