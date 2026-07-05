package dev.jasonpearson.automobile.ctrlproxy.storage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Validates the `storage_changed` wire payload built by [buildStorageChangedMessage] (#3000). The
 * critical guard is that `previousValue` is quoted by its OWN type: a removed or type-changed STRING
 * prior value must stay valid JSON even when the new value's type is UNKNOWN — otherwise the whole
 * message fails JSON.parse on the TS side and the telemetry event is dropped.
 */
class StorageChangeWireEncoderTest {

  private val json = Json { prettyPrint = false }

  private fun encodeAndParse(event: PreferenceChangeEvent): JsonObject {
    val wire = buildStorageChangedMessage(event, messageTimestampMs = 111L, json = json)
    // Must be valid JSON — parse or throw.
    return json.parseToJsonElement(wire) as JsonObject
  }

  private fun baseEvent(
    value: String?,
    type: String,
    previousValue: String?,
    previousValueType: String?,
  ) =
    PreferenceChangeEvent(
      packageName = "com.example",
      fileName = "prefs.xml",
      key = "theme",
      value = value,
      type = type,
      timestamp = 222L,
      sequenceNumber = 3L,
      previousValue = previousValue,
      previousValueType = previousValueType,
    )

  @Test
  fun `modify string quotes both value and previous value`() {
    val obj = encodeAndParse(baseEvent("dark", "STRING", "light", "STRING"))
    assertEquals("dark", obj["value"]!!.jsonPrimitive.content)
    assertEquals("light", obj["previousValue"]!!.jsonPrimitive.content)
    assertEquals("storage_changed", obj["type"]!!.jsonPrimitive.content)
  }

  @Test
  fun `removing a string key keeps previousValue valid JSON even though new type is UNKNOWN`() {
    // The regression this guards: new value null -> type UNKNOWN, but the prior value
    // is a STRING and MUST still be quoted (by previousValueType), not emitted raw.
    val obj = encodeAndParse(baseEvent(null, "UNKNOWN", "was-here", "STRING"))
    assertTrue(obj["value"] is JsonNull)
    assertEquals("was-here", obj["previousValue"]!!.jsonPrimitive.content)
  }

  @Test
  fun `type-changing write quotes previous value by its own prior type`() {
    // STRING -> INT: new type INT (unquoted number), prior STRING must stay quoted.
    val obj = encodeAndParse(baseEvent("42", "INT", "hello", "STRING"))
    // Unquoted number stays a JSON number; prior STRING stays quoted.
    assertEquals("42", obj["value"]!!.jsonPrimitive.content)
    assertTrue(!obj["value"]!!.jsonPrimitive.isString)
    assertEquals("hello", obj["previousValue"]!!.jsonPrimitive.content)
    assertTrue(obj["previousValue"]!!.jsonPrimitive.isString)
  }

  @Test
  fun `newly added key emits previousValue null`() {
    val obj = encodeAndParse(baseEvent("first", "STRING", null, "UNKNOWN"))
    assertEquals("first", obj["value"]!!.jsonPrimitive.content)
    assertTrue(obj["previousValue"] is JsonNull)
  }

  @Test
  fun `string with quotes and backslashes is escaped in previousValue`() {
    // Ensures JSON escaping (not just wrapping) — a raw append would corrupt this.
    val nasty = "a\"b\\c"
    val obj = encodeAndParse(baseEvent("new", "STRING", nasty, "STRING"))
    assertEquals(nasty, obj["previousValue"]!!.jsonPrimitive.content)
  }

  @Test
  fun `string set previous value is emitted as a valid JSON array`() {
    // The SDK serializes STRING_SET to a JSON array string; it must pass through raw
    // (not re-quoted) and remain valid JSON.
    val obj = encodeAndParse(baseEvent("""["x"]""", "STRING_SET", """["a","b"]""", "STRING_SET"))
    // previousValue parses as an array element, not a string — assert it is not a primitive string.
    assertTrue(obj["previousValue"] !is JsonPrimitive || !obj["previousValue"]!!.jsonPrimitive.isString)
  }
}
