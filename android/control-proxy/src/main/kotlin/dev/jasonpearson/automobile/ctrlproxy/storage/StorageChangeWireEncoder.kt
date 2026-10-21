package dev.jasonpearson.automobile.ctrlproxy.storage

import dev.jasonpearson.automobile.ctrlproxy.explicitNullsResultFrame
import dev.jasonpearson.automobile.protocol.StorageChangedEvent
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral

/**
 * Infers the change kind from SDK metadata forwarded unchanged by StorageSubscriptionManager. A
 * non-null key with a null value is a removal, even from a legacy SDK. A known prior-value type
 * with no prior value and a non-null new value is an add (the SDK uses UNKNOWN for that prior
 * type); any other known prior type is a modify. Otherwise omit the kind for the host's legacy
 * modify default. A file clear has a null key and value: it is not a key removal, and is a modify
 * when the SDK supplies its UNKNOWN prior type, or omitted for legacy SDKs.
 */
internal fun storageChangeType(event: PreferenceChangeEvent): String? =
  when {
    event.key != null && event.value == null -> "remove"
    event.previousValueType != null && event.previousValue == null && event.value != null -> "add"
    event.previousValueType != null -> "modify"
    else -> null
  }

/**
 * Builds the `storage_changed` WebSocket payload for a [PreferenceChangeEvent].
 *
 * Extracted from CtrlProxy so the JSON shaping — in particular the type-aware quoting of
 * `value`/`previousValue` — can be unit-tested for validity across add / modify / remove /
 * type-change cases (#3000).
 *
 * STRING and LONG values need JSON quoting + escaping: JavaScript cannot represent all signed
 * 64-bit integers exactly. A non-finite FLOAT also needs quoting because JSON has no NaN or
 * infinity literals. INT, finite FLOAT, BOOLEAN and SDK-produced STRING_SET arrays are already
 * valid JSON fragments. Crucially, `previousValue` is quoted by its OWN
 * [PreferenceChangeEvent.previousValueType], not by the new value's [type]: on a remove (new value
 * null) or a type-changing write the new type is UNKNOWN, so quoting the prior value by it would
 * emit an unquoted STRING and break the entire message's JSON.
 */
internal fun buildStorageChangedMessage(
  event: PreferenceChangeEvent,
  messageTimestampMs: Long,
): String =
  explicitNullsResultFrame(
    StorageChangedEvent(
      timestamp = messageTimestampMs,
      packageName = event.packageName,
      fileName = event.fileName,
      key = event.key,
      value = typedValueElement(event.value, event.type),
      valueType = event.type,
      changeType = storageChangeType(event),
      // Emit `previousValue` ONLY when the SDK actually supplied a prior-value type — i.e.
      // it captured the change and knows the prior value (a genuine "no prior value" add
      // still carries previousValueType = UNKNOWN, so it is emitted as null). A legacy SDK
      // that predates #3000 omits previousValueType (it decodes to null through the protocol
      // and StorageSubscriptionManager), so we omit `previousValue` entirely. That leaves the
      // field absent on the wire, so the TS ingest's `previousValue !== undefined` guard falls
      // through to the DB auto-lookup instead of recording a spurious null for a legacy-SDK
      // change that lands after an existing row.
      previousValue = event.previousValueType?.let { typedValueElement(event.previousValue, it) },
      eventTimestamp = event.timestamp,
      sequenceNumber = event.sequenceNumber,
    ),
  )

/**
 * The JSON value for a preference value: [JsonNull] for a null value, a quoted+escaped string for
 * STRING, LONG, and non-finite FLOAT, and the already-valid-JSON [value] verbatim for every other
 * type (numbers, booleans, and SDK-produced STRING_SET arrays).
 */
@OptIn(ExperimentalSerializationApi::class)
private fun typedValueElement(value: String?, type: String?): JsonElement {
  if (value == null) return JsonNull
  val requiresQuotedValue =
    type == "STRING" ||
      type == "LONG" ||
      (type == "FLOAT" && value.toDoubleOrNull()?.isFinite() != true)
  return when {
    requiresQuotedValue -> JsonPrimitive(value)
    // JsonUnquotedLiteral refuses "null"; the old frame wrote the same bare literal.
    value == "null" -> JsonNull
    else -> JsonUnquotedLiteral(value)
  }
}
