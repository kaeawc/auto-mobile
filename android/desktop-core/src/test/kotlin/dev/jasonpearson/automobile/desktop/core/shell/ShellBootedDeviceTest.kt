package dev.jasonpearson.automobile.desktop.core.shell

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceSession
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

class ShellBootedDeviceTest {
  private fun daemonDevice(
    platform: String,
    stableId: String,
    runtimeId: String? = "runtime",
    identityUnresolved: Boolean = false,
  ) =
    BootedDeviceInfo(
      name = "Device",
      platform = platform,
      isVirtual = false,
      identity = DeviceIdentity(stableId),
      runtime =
        DeviceRuntime(
          deviceId = runtimeId,
          lifecycle = DeviceLifecycle(state = "booted", known = true),
          session = DeviceSession(sessionUuid = "session"),
        ),
      identityUnresolved = identityUnresolved,
    )

  @Test
  fun `forShell keeps the runtime id, resolved source identity and daemon fields`() {
    for (platform in listOf("android", "ios")) {
      val device = daemonDevice(platform, stableId = "image").forShell()
      assertEquals("runtime", device.deviceId)
      assertEquals("image", device.identity.stableId)
      assertEquals("image", device.knownSourceImageId())
      assertFalse(device.identityUnresolved)
      assertEquals(platform, device.platform)
      assertFalse(device.isVirtual)
      assertEquals("session", device.runtime.session?.sessionUuid)
    }
  }

  @Test
  fun `forShell falls back to the source identity when the runtime id is missing`() {
    val device = daemonDevice("ios", stableId = "UDID", runtimeId = null).forShell()
    assertEquals("UDID", device.runtime.deviceId)
    assertEquals("UDID", device.deviceId)
  }

  @Test
  fun `an Android runtime label is not a resolved source identity`() {
    for (label in listOf("emulator-5554", "Unknown (emulator-5554)")) {
      val device = daemonDevice("android", stableId = label, runtimeId = "emulator-5554")
      assertNull(device.knownSourceImageId())
      val shell = device.forShell()
      assertEquals("emulator-5554", shell.identity.stableId)
      assertTrue(shell.identityUnresolved)
    }
  }

  @Test
  fun `an iOS UDID matching the runtime id is a resolved source identity`() {
    val device = daemonDevice("ios", stableId = "UDID", runtimeId = "UDID").forShell()
    assertEquals("UDID", device.knownSourceImageId())
    assertFalse(device.identityUnresolved)
  }

  @Test
  fun `the daemon's unresolved marker is honoured`() {
    val device = daemonDevice("android", stableId = "Pixel_8", identityUnresolved = true)
    assertNull(device.knownSourceImageId())
    assertEquals("runtime", device.forShell().identity.stableId)
  }

  @Test
  fun `shellBootedDevice builds a runtime-only device`() {
    val device = shellBootedDevice("pixel8", "Pixel 8", platform = "android", state = "Running")
    assertEquals("pixel8", device.deviceId)
    assertEquals("Running", device.runtime.lifecycle.state)
    assertTrue(device.isVirtual)
    assertTrue(device.identityUnresolved)
    assertFalse(device.isIos)
  }
}
