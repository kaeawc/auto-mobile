package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import dev.jasonpearson.automobile.desktop.domain.KeyValueType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json

/**
 * Covers the `storage_update` frame and the `request_observation` command added for #3930.
 *
 * Inbound frames are injected through `handleMessage` in the same way as the sibling stream tests;
 * no socket is involved.
 */
class ObservationStreamStorageTest {
  private val wireJson = Json { ignoreUnknownKeys = true }

  private fun storageFrame(
    key: String? = "\"theme\"",
    value: String? = "\"dark\"",
    valueType: String = "STRING",
  ) =
    """
    {
      "type": "storage_update",
      "deviceId": "emulator-5554",
      "timestamp": 9999,
      "storageEvent": {
        "packageName": "com.example",
        "fileName": "prefs.xml",
        "key": ${key ?: "null"},
        "value": ${value ?: "null"},
        "valueType": "$valueType",
        "timestamp": 1234,
        "sequenceNumber": 7
      }
    }
    """
      .trimIndent()

  @Test
  fun `emits a storage update from a storage_update frame`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame())

      val update = awaitItem()
      assertEquals("emulator-5554", update.deviceId)
      assertEquals("com.example", update.packageName)
      assertEquals("prefs.xml", update.fileName)
      assertEquals("theme", update.key)
      assertEquals("dark", update.value)
      assertEquals(KeyValueType.String, update.valueType)
      assertEquals(7L, update.sequenceNumber)
    }
  }

  @Test
  fun `uses the device-side event timestamp rather than the frame timestamp`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame())

      // 1234 is when the change happened on device; 9999 is when the daemon relayed it.
      assertEquals(1234L, awaitItem().timestamp)
    }
  }

  @Test
  fun `a null key marks the frame as a whole-file clear`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame(key = null, value = null))

      val update = awaitItem()
      assertNull(update.key)
      assertTrue(update.isFileCleared)
    }
  }

  @Test
  fun `a null value with a key is a delete, not a clear`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame(value = null))

      val update = awaitItem()
      assertEquals("theme", update.key)
      assertNull(update.value)
      assertTrue(!update.isFileCleared)
    }
  }

  @Test
  fun `an unrecognized value type degrades to Unknown`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      // iOS emits DICTIONARY, which the desktop enum has no member for.
      client.handleMessage(storageFrame(valueType = "DICTIONARY"))

      assertEquals(KeyValueType.Unknown, awaitItem().valueType)
    }
  }

  @Test
  fun `a storage_update without a payload is ignored rather than crashing`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage("""{"type":"storage_update","deviceId":"emulator-5554"}""")

      expectNoEvents()
    }
  }

  @Test
  fun `request_observation carries the device id and no cadence fields`() {
    val request =
      StreamRequest(
        id = "req-1",
        command = "request_observation",
        deviceId = "emulator-5554",
      )

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(encoded.contains("\"command\":\"request_observation\""), encoded)
    assertTrue(encoded.contains("\"deviceId\":\"emulator-5554\""), encoded)
    // A one-shot capture must not disturb the subscription's cadence.
    assertTrue(!encoded.contains("screenshotIntervalMs"), encoded)
    assertTrue(!encoded.contains("hierarchyIntervalMs"), encoded)
  }

  @Test
  fun `request_observation omits the device id when capturing every device`() {
    val request = StreamRequest(id = "req-1", command = "request_observation", deviceId = null)

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(!encoded.contains("deviceId"), encoded)
  }

  @Test
  fun `requestObservation is a no-op while disconnected`() {
    val client = ObservationStreamClient()

    // Must not throw despite there being no socket; the daemon may not be running.
    client.requestObservation("emulator-5554")
  }
}
