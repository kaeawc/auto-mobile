package dev.jasonpearson.automobile.ctrlproxy.storage

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Builds the `storage_changed` WebSocket payload for a [PreferenceChangeEvent].
 *
 * Extracted from CtrlProxy so the JSON shaping — in particular the type-aware quoting of
 * `value`/`previousValue` — can be unit-tested for validity across add / modify / remove /
 * type-change cases (#3000).
 *
 * STRING and LONG values need JSON quoting + escaping: JavaScript cannot represent all signed
 * 64-bit integers exactly. INT/FLOAT/BOOLEAN and SDK-produced STRING_SET arrays are already valid
 * JSON fragments. Crucially, `previousValue` is quoted by its OWN
 * [PreferenceChangeEvent.previousValueType], not by the new value's [type]: on a remove (new value
 * null) or a type-changing write the new type is UNKNOWN, so quoting the prior value by it would
 * emit an unquoted STRING and break the entire message's JSON.
 */
internal fun buildStorageChangedMessage(
  event: PreferenceChangeEvent,
  messageTimestampMs: Long,
  json: Json,
): String = buildString {
  append("""{"type":"storage_changed","timestamp":$messageTimestampMs""")
  append(""","packageName":${json.encodeToString(event.packageName)}""")
  append(""","fileName":${json.encodeToString(event.fileName)}""")
  if (event.key != null) {
    append(""","key":${json.encodeToString(event.key)}""")
  } else {
    append(""","key":null""")
  }
  append(""","value":${encodeTypedValue(event.value, event.type, json)}""")
  append(""","valueType":${json.encodeToString(event.type)}""")
  // Emit `previousValue` ONLY when the SDK actually supplied a prior-value type — i.e.
  // it captured the change and knows the prior value (a genuine "no prior value" add
  // still carries previousValueType = UNKNOWN, so it is emitted as null). A legacy SDK
  // that predates #3000 omits previousValueType (it decodes to null through the protocol
  // and StorageSubscriptionManager), so we omit `previousValue` entirely. That leaves the
  // field absent on the wire, so the TS ingest's `previousValue !== undefined` guard falls
  // through to the DB auto-lookup instead of recording a spurious null for a legacy-SDK
  // change that lands after an existing row.
  if (event.previousValueType != null) {
    append(
      ""","previousValue":${encodeTypedValue(event.previousValue, event.previousValueType, json)}"""
    )
  }
  append(""","eventTimestamp":${event.timestamp}""")
  append(""","sequenceNumber":${event.sequenceNumber}""")
  append("}")
}

/**
 * Encodes a JSON value fragment for a preference value. Returns the literal `null` for a null
 * value, a JSON-quoted+escaped string for STRING and LONG, and the already-valid-JSON [value]
 * verbatim for every other type (numbers, booleans, and SDK-produced STRING_SET arrays).
 */
private fun encodeTypedValue(value: String?, type: String?, json: Json): String {
  if (value == null) return "null"
  return if (type == "STRING" || type == "LONG") json.encodeToString(value) else value
}
