package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class ObservationStreamClientTest {
  // Uses the same configuration as ObservationStreamClient so these assertions match the socket.
  private val wireJson = DaemonJson

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
  fun `update_cadence request carries the changed cadence and omits unset fields`() {
    // setCadence(screenshotIntervalMs = X) sends an update_cadence command; the hierarchy field is
    // omitted so the daemon relaxes it back to its per-platform default.
    val request =
      StreamRequest(
        id = "req-3",
        command = "update_cadence",
        subscriptionId = "devicedatastream-1",
        deviceId = "emulator-5554",
        screenshotIntervalMs = 500L,
      )

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(encoded.contains("\"command\":\"update_cadence\""), encoded)
    assertTrue(encoded.contains("\"subscriptionId\":\"devicedatastream-1\""), encoded)
    assertTrue(encoded.contains("\"screenshotIntervalMs\":500"), encoded)
    assertFalse(encoded.contains("hierarchyIntervalMs"), encoded)
  }

  @Test
  fun `subscription response decodes the server minted subscription ID`() {
    val response =
      wireJson.decodeFromString(
        StreamResponse.serializer(),
        """{"type":"subscription_response","success":true,"subscriptionId":"devicedatastream-1"}""",
      )

    assertEquals("devicedatastream-1", response.subscriptionId)
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
          "screenshotBase64Length": 1600,
          "rotation": 1
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
      assertEquals(1, update.rotation)
    }
  }

  @Test
  fun `narrows the declared coordinate space on both geometry-bearing messages`() = runTest {
    // Issue #4550: the declaration reaches the client typed, per message, on the screenshot AND on
    // the hierarchy — the control policy compares dimensions exactly only when both agree.
    val client = ObservationStreamClient()

    client.screenshotUpdates.test {
      client.handleMessage(
        """
        {
          "type": "screenshot_update",
          "deviceId": "emulator-5554",
          "timestamp": 1001,
          "screenshotBase64": "aW1hZ2U=",
          "screenWidth": 1170,
          "screenHeight": 2532,
          "coordinateSpace": "px",
          "nativeScale": 3.5,
          "frameContext": "ios:41"
        }
        """
          .trimIndent()
      )
      val update = awaitItem()
      assertEquals(CoordinateSpace.Pixels, update.coordinateSpace)
      assertEquals(3.5, update.nativeScale)
      assertEquals("ios:41", update.frameContext)
    }

    client.hierarchyUpdates.test {
      client.handleMessage(
        """
        {
          "type": "hierarchy_update",
          "deviceId": "emulator-5554",
          "timestamp": 2000,
          "data": { "packageName": "com.example" },
          "coordinateSpace": "px",
          "nativeScale": 3.5,
          "frameContext": "ios:41"
        }
        """
          .trimIndent()
      )
      val update = awaitItem()
      assertEquals(CoordinateSpace.Pixels, update.coordinateSpace)
      assertEquals(3.5, update.nativeScale)
      assertEquals("ios:41", update.frameContext)
    }
  }

  @Test
  fun `an absent space is legacy while an unknown one is surfaced as unrecognized`() = runTest {
    // A pre-#4548 runner declares nothing (legacy point-space). A future daemon may declare a space
    // this client does not know — which must be kept DISTINCT from absent, so control can fail
    // closed on it, and must not fail the whole message.
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
          "screenHeight": 200
        }
        """
          .trimIndent()
      )
      assertNull(awaitItem().coordinateSpace)

      client.handleMessage(
        """
        {
          "type": "screenshot_update",
          "deviceId": "emulator-5554",
          "timestamp": 1002,
          "screenshotBase64": "aW1hZ2U=",
          "screenWidth": 100,
          "screenHeight": 200,
          "coordinateSpace": "dp"
        }
        """
          .trimIndent()
      )
      assertEquals(CoordinateSpace.Unrecognized("dp"), awaitItem().coordinateSpace)
    }
  }

  @Test
  fun `emits hierarchy diff summary when the daemon provides it`() = runTest {
    val client = ObservationStreamClient()

    client.hierarchyUpdates.test {
      client.handleMessage(
        """
        {
          "type": "hierarchy_update",
          "deviceId": "emulator-5554",
          "timestamp": 2000,
          "data": { "packageName": "com.example" },
          "hierarchyDiff": { "hasBaseline": true, "added": 2, "changed": 3, "removed": 1 },
          "rotation": 1
        }
        """
          .trimIndent()
      )

      val update = awaitItem()
      assertEquals(
        HierarchyDiffSummary(hasBaseline = true, added = 2, changed = 3, removed = 1),
        update.diff,
      )
      assertEquals(1, update.rotation)
    }
  }

  @Test
  fun `hierarchy update diff is null when the daemon omits it`() = runTest {
    // Older daemons predate diff metadata; the layout inspector must render cleanly with no diff.
    val client = ObservationStreamClient()

    client.hierarchyUpdates.test {
      client.handleMessage(
        """
        {
          "type": "hierarchy_update",
          "deviceId": "emulator-5554",
          "timestamp": 2001,
          "data": { "packageName": "com.example" }
        }
        """
          .trimIndent()
      )

      assertEquals(null, awaitItem().diff)
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

  @Test
  fun `resetLayoutReplayCache drops the buffered layout frame for new subscribers`() = runTest {
    // Reproduces Live Layout reopen: a screenshot+hierarchy frame is buffered (replay=1), then the
    // layout replay is cleared so a resubscribing collector must NOT replay the stale pre-close
    // frame
    // and re-arm control from it (issue #3347).
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

    // Before reset, a new subscriber replays the buffered frame.
    client.screenshotUpdates.test { assertEquals("emulator-5554", awaitItem().deviceId) }

    client.resetLayoutReplayCache()

    // After reset, a new subscriber gets nothing until a genuinely fresh frame arrives.
    client.hierarchyUpdates.test { expectNoEvents() }
    client.screenshotUpdates.test { expectNoEvents() }
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
