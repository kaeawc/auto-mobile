package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

/**
 * Hand-written JSON mirrors our own daemon producer's frames asserted in
 * test/daemon/deviceDataStreamSocketServer.test.ts; no transport or wall-clock waits are involved.
 */
class ObservationStreamDeviceSessionTest {
  @Test
  fun `ended session with a successor emits exactly one superseded event`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.deviceEvents.test {
        client.handleMessage(
          """{"type":"device_session_ended","deviceId":"emulator-5554","deviceSessionUuid":"retired","successorSessionUuid":"successor","platform":"android","timestamp":123}""",
        )

        assertEquals(
          DeviceStreamEvent.DeviceSessionSuperseded("emulator-5554", "retired", "successor", 123L),
          awaitItem(),
        )
        expectNoEvents()
      }
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `plain ended session emits nothing`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.deviceEvents.test {
        client.handleMessage(
          """{"type":"device_session_ended","deviceId":"emulator-5554","deviceSessionUuid":"retired","platform":"android","timestamp":123}""",
        )
        expectNoEvents()
      }
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `started session emits nothing`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.deviceEvents.test {
        client.handleMessage(
          """{"type":"device_session_started","deviceId":"emulator-5554","deviceSessionUuid":"successor","platform":"android","timestamp":123}""",
        )
        expectNoEvents()
      }
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `incomplete or blank session identities emit nothing`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.deviceEvents.test {
        val malformedFrames =
          listOf(
            """{"type":"device_session_ended","deviceSessionUuid":"retired","successorSessionUuid":"successor"}""",
            """{"type":"device_session_ended","deviceId":"emulator-5554","successorSessionUuid":"successor"}""",
            """{"type":"device_session_ended","deviceId":"emulator-5554","deviceSessionUuid":"retired","successorSessionUuid":""}""",
            """{"type":"device_session_ended","deviceId":" ","deviceSessionUuid":"retired","successorSessionUuid":"successor"}""",
            """{"type":"device_session_ended","deviceId":"emulator-5554","deviceSessionUuid":" ","successorSessionUuid":"successor"}""",
            """{"type":"device_session_ended","deviceId":"emulator-5554","deviceSessionUuid":"retired","successorSessionUuid":" "}""",
          )
        malformedFrames.forEach { client.handleMessage(it) }
        expectNoEvents()
      }
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `unknown extra fields are tolerated`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.deviceEvents.test {
        client.handleMessage(
          """{"type":"device_session_ended","deviceId":"emulator-5554","deviceSessionUuid":"retired","successorSessionUuid":"successor","timestamp":123,"futureField":{"nested":true}}""",
        )
        assertEquals(
          DeviceStreamEvent.DeviceSessionSuperseded("emulator-5554", "retired", "successor", 123L),
          awaitItem(),
        )
        expectNoEvents()
      }
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `device connection lost error still emits its existing event`() = runTest {
    val client = ObservationStreamClient()
    try {
      client.deviceEvents.test {
        client.handleMessage(
          """{"type":"error","deviceId":"emulator-5554","error":"device connection lost","timestamp":123}""",
        )
        assertEquals(
          DeviceStreamEvent.DeviceConnectionLost("emulator-5554", 123L, "device connection lost"),
          awaitItem(),
        )
        expectNoEvents()
      }
    } finally {
      client.dispose()
    }
  }
}
