package dev.jasonpearson.automobile.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

class StorageProtocolTest {

  @Test
  fun `storage_changed frame decodes device fields without legacy data`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"theme","value":"dark","valueType":"STRING","previousValue":"light","changeType":"modify","eventTimestamp":222,"sequenceNumber":3}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals(111L, event.timestamp)
    assertEquals("com.example", event.packageName)
    assertEquals("prefs.xml", event.fileName)
    assertEquals("theme", event.key)
    assertEquals(JsonPrimitive("dark"), event.value)
    assertEquals("STRING", event.valueType)
    assertEquals(JsonPrimitive("light"), event.previousValue)
    assertEquals("modify", event.changeType)
    assertEquals(222L, event.eventTimestamp)
    assertEquals(3L, event.sequenceNumber)
    assertNull(event.data)
  }

  @Test
  fun `storage_changed frame decodes INT values as bare numbers`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"counter","value":42,"valueType":"INT","previousValue":41}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals(JsonPrimitive(42), event.value)
    assertEquals(JsonPrimitive(41), event.previousValue)
  }

  @Test
  fun `storage_changed frame decodes BOOLEAN values as bare booleans`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"enabled","value":true,"valueType":"BOOLEAN","previousValue":false}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals(JsonPrimitive(true), event.value)
    assertEquals(JsonPrimitive(false), event.previousValue)
  }

  @Test
  fun `storage_changed frame decodes finite FLOAT values as bare numbers`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"ratio","value":1.5,"valueType":"FLOAT","previousValue":0.5}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals(JsonPrimitive(1.5), event.value)
    assertEquals(JsonPrimitive(0.5), event.previousValue)
  }

  @Test
  fun `storage_changed frame decodes STRING_SET values as arrays`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"tags","value":["a","b"],"valueType":"STRING_SET","previousValue":["a"]}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals(JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b"))), event.value)
    assertEquals(JsonArray(listOf(JsonPrimitive("a"))), event.previousValue)
  }

  @Test
  fun `storage_changed frame preserves LONG values as quoted strings`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"counter","value":"9223372036854775807","valueType":"LONG","previousValue":"-9223372036854775808"}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals(JsonPrimitive(Long.MAX_VALUE.toString()), event.value)
    assertEquals(JsonPrimitive(Long.MIN_VALUE.toString()), event.previousValue)
  }

  @Test
  fun `storage_changed frame decodes explicit null values`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","key":"theme","value":null,"valueType":"UNKNOWN","previousValue":null}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertNull(event.value)
    assertNull(event.previousValue)
  }

  @Test
  fun `legacy storage_changed frame retains data and defaults new fields`() {
    val frame =
      """{"type":"storage_changed","timestamp":111,"packageName":"com.example","fileName":"prefs.xml","data":"{}"}"""

    val event = Json.decodeFromString(WebSocketResponse.serializer(), frame)

    assertIs<StorageChangedEvent>(event)
    assertEquals("{}", event.data)
    assertNull(event.key)
    assertNull(event.value)
    assertNull(event.valueType)
    assertNull(event.previousValue)
    assertNull(event.changeType)
    assertNull(event.eventTimestamp)
    assertNull(event.sequenceNumber)
  }

  // =============================================================================
  // Request Serialization Tests
  // =============================================================================

  @Test
  fun `CheckAvailability request roundtrip`() {
    val request = StorageRequest.CheckAvailability

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.CheckAvailability>(deserialized)
  }

  @Test
  fun `ListFiles request roundtrip`() {
    val request = StorageRequest.ListFiles

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.ListFiles>(deserialized)
  }

  @Test
  fun `GetPreferences request roundtrip`() {
    val request = StorageRequest.GetPreferences(fileName = "auth_prefs")

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.GetPreferences>(deserialized)
    assertEquals("auth_prefs", deserialized.fileName)
  }

  @Test
  fun `Subscribe request roundtrip`() {
    val request = StorageRequest.Subscribe(fileName = "settings")

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.Subscribe>(deserialized)
    assertEquals("settings", deserialized.fileName)
  }

  @Test
  fun `Unsubscribe request roundtrip`() {
    val request = StorageRequest.Unsubscribe(fileName = "settings")

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.Unsubscribe>(deserialized)
    assertEquals("settings", deserialized.fileName)
  }

  @Test
  fun `GetChanges request roundtrip with default sinceSequence`() {
    val request = StorageRequest.GetChanges(fileName = "prefs")

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.GetChanges>(deserialized)
    assertEquals("prefs", deserialized.fileName)
    assertEquals(0L, deserialized.sinceSequence)
  }

  @Test
  fun `GetChanges request roundtrip with custom sinceSequence`() {
    val request = StorageRequest.GetChanges(fileName = "prefs", sinceSequence = 42L)

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.GetChanges>(deserialized)
    assertEquals("prefs", deserialized.fileName)
    assertEquals(42L, deserialized.sinceSequence)
  }

  @Test
  fun `GetListenedFiles request roundtrip`() {
    val request = StorageRequest.GetListenedFiles

    val json = StorageProtocolSerializer.requestToJson(request)
    val deserialized = StorageProtocolSerializer.requestFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageRequest.GetListenedFiles>(deserialized)
  }

  // =============================================================================
  // Response Serialization Tests
  // =============================================================================

  @Test
  fun `Availability response roundtrip`() {
    val response = StorageResponse.Availability(available = true, version = 1)

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.Availability>(deserialized)
    assertEquals(true, deserialized.available)
    assertEquals(1, deserialized.version)
  }

  @Test
  fun `FileList response roundtrip`() {
    val response =
      StorageResponse.FileList(
        files =
          listOf(
            StorageFileInfo(
              name = "prefs",
              path = "/data/data/app/shared_prefs/prefs.xml",
              entryCount = 5,
            ),
            StorageFileInfo(
              name = "auth",
              path = "/data/data/app/shared_prefs/auth.xml",
              entryCount = 2,
            ),
          ),
      )

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.FileList>(deserialized)
    assertEquals(2, deserialized.files.size)
    assertEquals("prefs", deserialized.files[0].name)
    assertEquals(5, deserialized.files[0].entryCount)
  }

  @Test
  fun `Preferences response roundtrip`() {
    val response =
      StorageResponse.Preferences(
        file = StorageFileInfo(name = "prefs", path = "/path/to/prefs.xml", entryCount = 2),
        entries =
          listOf(
            StorageEntry(key = "user_name", value = "\"John\"", type = "STRING"),
            StorageEntry(key = "logged_in", value = "true", type = "BOOLEAN"),
          ),
      )

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.Preferences>(deserialized)
    assertNotNull(deserialized.file)
    assertEquals("prefs", deserialized.file.name)
    assertEquals(2, deserialized.entries.size)
    assertEquals("user_name", deserialized.entries[0].key)
    assertEquals("STRING", deserialized.entries[0].type)
  }

  @Test
  fun `SubscriptionResult response roundtrip`() {
    val response = StorageResponse.SubscriptionResult(fileName = "prefs", subscribed = true)

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.SubscriptionResult>(deserialized)
    assertEquals("prefs", deserialized.fileName)
    assertEquals(true, deserialized.subscribed)
  }

  @Test
  fun `Changes response roundtrip`() {
    val response =
      StorageResponse.Changes(
        fileName = "prefs",
        changes =
          listOf(
            StorageChangeEvent(
              fileName = "prefs",
              key = "counter",
              value = "42",
              type = "INT",
              timestamp = 1234567890L,
              sequenceNumber = 1L,
              previousValue = "41",
              previousValueType = "INT",
            ),
            StorageChangeEvent(
              fileName = "prefs",
              key = null,
              value = null,
              type = "CLEARED",
              timestamp = 1234567891L,
              sequenceNumber = 2L,
            ),
          ),
      )

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.Changes>(deserialized)
    assertEquals("prefs", deserialized.fileName)
    assertEquals(2, deserialized.changes.size)
    assertEquals("counter", deserialized.changes[0].key)
    // The runner-supplied prior value and its own type round-trip (#3000).
    assertEquals("41", deserialized.changes[0].previousValue)
    assertEquals("INT", deserialized.changes[0].previousValueType)
    assertNull(deserialized.changes[1].key)
    // Absent prior value defaults to null (value and type).
    assertNull(deserialized.changes[1].previousValue)
    assertNull(deserialized.changes[1].previousValueType)
  }

  @Test
  fun `Changes response decodes previousValue when omitted (backward compat)`() {
    // A payload emitted by an older SDK that predates previousValue must still
    // deserialize, defaulting the field to null (#3000).
    val legacyJson =
      """{"type":"changes","fileName":"prefs","changes":[""" +
        """{"fileName":"prefs","key":"k","value":"v","type":"STRING",""" +
        """"timestamp":1,"sequenceNumber":1}]}"""

    val deserialized = StorageProtocolSerializer.responseFromJson(legacyJson)

    assertNotNull(deserialized)
    assertIs<StorageResponse.Changes>(deserialized)
    assertEquals(1, deserialized.changes.size)
    assertNull(deserialized.changes[0].previousValue)
  }

  @Test
  fun `ListenedFiles response roundtrip`() {
    val response = StorageResponse.ListenedFiles(files = listOf("prefs", "auth", "settings"))

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.ListenedFiles>(deserialized)
    assertEquals(3, deserialized.files.size)
    assertEquals("prefs", deserialized.files[0])
  }

  @Test
  fun `Error response roundtrip`() {
    val response = StorageResponse.Error(errorType = "DISABLED", message = "Inspection is disabled")

    val json = StorageProtocolSerializer.responseToJson(response)
    val deserialized = StorageProtocolSerializer.responseFromJson(json)

    assertNotNull(deserialized)
    assertIs<StorageResponse.Error>(deserialized)
    assertEquals("DISABLED", deserialized.errorType)
    assertEquals("Inspection is disabled", deserialized.message)
  }

  // =============================================================================
  // Method Name Tests
  // =============================================================================

  @Test
  fun `getMethodName returns correct method for each request type`() {
    assertEquals(
      "checkAvailability",
      StorageProtocolSerializer.getMethodName(StorageRequest.CheckAvailability),
    )
    assertEquals("listFiles", StorageProtocolSerializer.getMethodName(StorageRequest.ListFiles))
    assertEquals(
      "getPreferences",
      StorageProtocolSerializer.getMethodName(StorageRequest.GetPreferences("f")),
    )
    assertEquals(
      "subscribeToFile",
      StorageProtocolSerializer.getMethodName(StorageRequest.Subscribe("f")),
    )
    assertEquals(
      "unsubscribeFromFile",
      StorageProtocolSerializer.getMethodName(StorageRequest.Unsubscribe("f")),
    )
    assertEquals(
      "getChanges",
      StorageProtocolSerializer.getMethodName(StorageRequest.GetChanges("f")),
    )
    assertEquals(
      "getListenedFiles",
      StorageProtocolSerializer.getMethodName(StorageRequest.GetListenedFiles),
    )
  }

  // =============================================================================
  // Error Handling Tests
  // =============================================================================

  @Test
  fun `requestFromJson returns null for invalid json`() {
    val result = StorageProtocolSerializer.requestFromJson("not valid json")
    assertNull(result)
  }

  @Test
  fun `responseFromJson returns null for invalid json`() {
    val result = StorageProtocolSerializer.responseFromJson("not valid json")
    assertNull(result)
  }
}
