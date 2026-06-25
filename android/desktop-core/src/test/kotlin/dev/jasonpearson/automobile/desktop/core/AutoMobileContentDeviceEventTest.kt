package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AutoMobileContentDeviceEventTest {
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
    assertTrue(isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = "emulator-5554"))
  }

  @Test
  fun `stream frame ignores inactive device`() {
    assertFalse(isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = "emulator-5556"))
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
}
