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
            client.handleMessage(
                """
                {
                  "type": "error",
                  "success": false,
                  "deviceId": "emulator-5554",
                  "timestamp": 1234,
                  "error": "device connection lost"
                }
                """.trimIndent()
            )

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
}
