package dev.jasonpearson.automobile.desktop.core.shell

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

class SidebarDeviceAdapterTest {
  @Test
  fun `adapter preserves runtime source identity platform and virtuality for all types`() {
    for (type in DeviceType.entries) {
      val device =
        BootedDevice("runtime", "Device", type, "booted", connectedAt = 0, stableId = "image")
      val adapted = device.toSidebarDeviceInfo()
      assertEquals("runtime", adapted.runtime.deviceId)
      assertEquals("image", adapted.identity.stableId)
      assertEquals("Device", adapted.name)
      assertEquals("booted", adapted.runtime.lifecycle.state)
      assertFalse(adapted.identityUnresolved)
      assertEquals(
        if (type == DeviceType.iOSSimulator || type == DeviceType.iOSPhysical) "ios" else "android",
        adapted.platform,
      )
      assertEquals(
        type == DeviceType.AndroidEmulator || type == DeviceType.iOSSimulator,
        adapted.isVirtual,
      )
    }
  }

  @Test
  fun `runtime label fallback does not claim resolved source identity`() {
    val device =
      BootedDevice(
        "emulator-5554",
        "Unknown",
        DeviceType.AndroidEmulator,
        connectedAt = 0,
        stableId = "emulator-5554",
      )
    val adapted = device.toSidebarDeviceInfo()
    assertEquals("emulator-5554", adapted.runtime.deviceId)
    assertTrue(adapted.identityUnresolved)
  }
}
