package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json

class ObservationStreamClientTest {
  // Mirrors the Json config used by ObservationStreamClient.sendRequest so the serialized subscribe
  // payload asserted here matches what is written to the socket.
  private val wireJson = Json { ignoreUnknownKeys = true }

  @Test
  fun `subscribe request carries requested cadence when provided`() {
    val request =
      StreamRequest(
        id = "req-1",
        command = "subscribe",
        deviceId = "emulator-5554",
        screenshotIntervalMs = 1000L,
        hierarchyIntervalMs = 500L,
      )

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(encoded.contains("\"screenshotIntervalMs\":1000"), encoded)
    assertTrue(encoded.contains("\"hierarchyIntervalMs\":500"), encoded)
  }

  @Test
  fun `subscribe request omits cadence fields when not requested`() {
    // Older daemons predate cadence support; omitting the keys keeps the request backward
    // compatible and lets the daemon apply its default cadence.
    val request =
      StreamRequest(
        id = "req-2",
        command = "subscribe",
        deviceId = "emulator-5554",
      )

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertFalse(encoded.contains("screenshotIntervalMs"), encoded)
    assertFalse(encoded.contains("hierarchyIntervalMs"), encoded)
  }

  @Test
  fun `emits screenshot metadata when provided by stream`() = runTest {
    val client = ObservationStreamClient()

    client.screenshotUpdates.test {
      client.handleMessage(
        """
        {
          "type": "screenshot_update",
          "deviceId": "emulator-5554",
          "timestamp": 1001,
          "screenshotBase64": "aW1hZ2U=",
          "screenWidth": 100,
          "screenHeight": 200,
          "screenshotMimeType": "image/png",
          "screenshotFormat": "png",
          "screenshotCaptureSource": "android_adb_screencap",
          "screenshotFallback": true,
          "screenshotFallbackReason": "websocket_unavailable",
          "screenshotCaptureDurationMs": 42,
          "screenshotEncodeDurationMs": 7,
          "screenshotByteLength": 1200,
          "screenshotBase64Length": 1600
        }
        """
          .trimIndent()
      )

      val update = awaitItem()
      assertEquals("image/png", update.screenshotMimeType)
      assertEquals("png", update.screenshotFormat)
      assertEquals("android_adb_screencap", update.screenshotCaptureSource)
      assertEquals(true, update.screenshotFallback)
      assertEquals("websocket_unavailable", update.screenshotFallbackReason)
      assertEquals(42L, update.screenshotCaptureDurationMs)
      assertEquals(7L, update.screenshotEncodeDurationMs)
      assertEquals(1200, update.screenshotByteLength)
      assertEquals(1600, update.screenshotBase64Length)
    }
  }

  @Test
  fun `emits device connection lost event for disconnect error message`() = runTest {
    val client = ObservationStreamClient()

    client.deviceEvents.test {
      client.handleMessage(deviceConnectionLostMessage())

      assertEquals(
        DeviceStreamEvent.DeviceConnectionLost(
          deviceId = "emulator-5554",
          timestamp = 1234,
          error = "device connection lost",
        ),
        awaitItem(),
      )
    }
  }

  @Test
  fun `clears replayed hierarchy screenshot and performance data when device connection is lost`() =
    runTest {
      val client = ObservationStreamClient()

      client.handleMessage(
        """
        {
          "type": "hierarchy_update",
          "deviceId": "emulator-5554",
          "timestamp": 1000,
          "data": { "packageName": "com.example" }
        }
        """
          .trimIndent()
      )
      client.handleMessage(
        """
        {
          "type": "screenshot_update",
          "deviceId": "emulator-5554",
          "timestamp": 1001,
          "screenshotBase64": "aW1hZ2U=",
          "screenWidth": 100,
          "screenHeight": 200
        }
        """
          .trimIndent()
      )
      client.handleMessage(
        """
        {
          "type": "performance_update",
          "deviceId": "emulator-5554",
          "timestamp": 1002,
          "performanceData": {
            "fps": 60.0,
            "frameTimeMs": 16.67,
            "jankFrames": 0,
            "droppedFrames": 0,
            "memoryUsageMb": 128.0,
            "cpuUsagePercent": 10.0
          }
        }
        """
          .trimIndent()
      )

      client.hierarchyUpdates.test {
        assertEquals("emulator-5554", awaitItem().deviceId)
      }
      client.screenshotUpdates.test {
        assertEquals("emulator-5554", awaitItem().deviceId)
      }
      client.performanceUpdates.test {
        assertEquals("emulator-5554", awaitItem().deviceId)
      }

      client.handleMessage(deviceConnectionLostMessage())

      client.hierarchyUpdates.test {
        expectNoEvents()
      }
      client.screenshotUpdates.test {
        expectNoEvents()
      }
      client.performanceUpdates.test {
        expectNoEvents()
      }
    }

  private fun deviceConnectionLostMessage(): String =
    """
    {
      "type": "error",
      "success": false,
      "deviceId": "emulator-5554",
      "timestamp": 1234,
      "error": "device connection lost"
    }
    """
      .trimIndent()
}
