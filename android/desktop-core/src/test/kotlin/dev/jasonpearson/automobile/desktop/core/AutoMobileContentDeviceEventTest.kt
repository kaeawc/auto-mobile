package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AutoMobileContentDeviceEventTest {
  @Test
  fun `handler disconnects layout and clears performance metrics for active device connection loss`() {
    val sink = FakeDeviceStreamEventSink()
    val handler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { "emulator-5554" },
        sink = sink,
      )

    handler.handle(deviceConnectionLostEvent(deviceId = "emulator-5554"))

    assertEquals(1, sink.disconnectLayoutCalls)
    assertEquals(1, sink.clearPerformanceMetricsCalls)
  }

  @Test
  fun `handler ignores inactive device connection loss`() {
    val sink = FakeDeviceStreamEventSink()
    val handler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { "emulator-5556" },
        sink = sink,
      )

    handler.handle(deviceConnectionLostEvent(deviceId = "emulator-5554"))

    assertEquals(0, sink.disconnectLayoutCalls)
    assertEquals(0, sink.clearPerformanceMetricsCalls)
  }

  @Test
  fun `handler ignores connection loss when no device is active`() {
    val sink = FakeDeviceStreamEventSink()
    val handler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { null },
        sink = sink,
      )

    handler.handle(deviceConnectionLostEvent(deviceId = "emulator-5554"))

    assertEquals(0, sink.disconnectLayoutCalls)
    assertEquals(0, sink.clearPerformanceMetricsCalls)
  }

  @Test
  fun `device connection lost event matches active device`() {
    val event = deviceConnectionLostEvent(deviceId = "emulator-5554")

    assertEquals(event, activeDeviceConnectionLostEvent(event, activeDeviceId = "emulator-5554"))
  }

  @Test
  fun `device connection lost event ignores inactive device`() {
    val event = deviceConnectionLostEvent(deviceId = "emulator-5554")

    assertNull(activeDeviceConnectionLostEvent(event, activeDeviceId = "emulator-5556"))
  }

  @Test
  fun `device connection lost event ignores missing active device`() {
    val event = deviceConnectionLostEvent(deviceId = "emulator-5554")

    assertNull(activeDeviceConnectionLostEvent(event, activeDeviceId = null))
  }

  @Test
  fun `stream frame matches active device`() {
    assertTrue(
      isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = "emulator-5554")
    )
  }

  @Test
  fun `stream frame ignores inactive device`() {
    assertFalse(
      isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = "emulator-5556")
    )
  }

  @Test
  fun `stream frame ignores missing active device`() {
    assertFalse(isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = null))
  }

  private fun deviceConnectionLostEvent(deviceId: String): DeviceStreamEvent.DeviceConnectionLost =
    DeviceStreamEvent.DeviceConnectionLost(
      deviceId = deviceId,
      timestamp = 1234,
      error = "device connection lost",
    )

  private class FakeDeviceStreamEventSink : AutoMobileDeviceStreamEventSink {
    var disconnectLayoutCalls = 0
      private set

    var clearPerformanceMetricsCalls = 0
      private set

    override fun disconnectLayout() {
      disconnectLayoutCalls++
    }

    override fun clearPerformanceMetrics() {
      clearPerformanceMetricsCalls++
    }
  }
}
