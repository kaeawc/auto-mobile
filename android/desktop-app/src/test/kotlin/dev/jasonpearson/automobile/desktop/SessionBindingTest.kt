package dev.jasonpearson.automobile.desktop

import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DeviceState
import dev.jasonpearson.automobile.desktop.core.workspace.picker.PickerDevice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins which device registers the daemon session so home-grid thumbnails authenticate (Codex P1).
 */
class SessionBindingTest {

  private fun booted(id: String, platform: Platform = Platform.Android) =
    PickerDevice(id, id, platform, DeviceState.Booted)

  private fun shutdown(id: String, platform: Platform = Platform.Android) =
    PickerDevice(id, id, platform, DeviceState.Shutdown)

  @Test
  fun `prefers the focused workspace column, in the daemon wire platform`() {
    val focused = DeviceColumn(deviceId = "emulator-5554", name = "Pixel", platform = Platform.Ios)
    assertEquals(
      SessionBinding("emulator-5554", "ios"),
      resolveSessionBinding(focused, listOf(booted("other"))),
    )
  }

  @Test
  fun `falls back to the first booted grid device when nothing is focused`() {
    val devices = listOf(shutdown("avd"), booted("emulator-5556"), booted("emulator-5557"))
    assertEquals(SessionBinding("emulator-5556", "android"), resolveSessionBinding(null, devices))
  }

  @Test
  fun `is null when nothing is focused and nothing is booted`() {
    assertNull(resolveSessionBinding(null, listOf(shutdown("avd"), shutdown("sim", Platform.Ios))))
  }

  @Test
  fun `is null when there are no devices at all`() {
    assertNull(resolveSessionBinding(null, emptyList()))
  }
}
