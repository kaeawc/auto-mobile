package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

class ObservationStreamClientTest {
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
    fun `clears replayed hierarchy screenshot and performance data when device connection is lost`() = runTest {
        val client = ObservationStreamClient()

        client.handleMessage(
            """
            {
              "type": "hierarchy_update",
              "deviceId": "emulator-5554",
              "timestamp": 1000,
              "data": { "packageName": "com.example" }
            }
            """.trimIndent()
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
            """.trimIndent()
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
            """.trimIndent()
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
        """.trimIndent()
}
