package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #10660: opening the tool window auto-selects the first booted device for display, but that must
 * never become an allocation-bearing binding. Only an explicit user pick may reserve a device.
 */
class DesktopSessionBindingPolicyTest {
  @Test
  fun `auto-selected first device without a user pick does not bind`() {
    val binding =
      desktopSessionBindingFor(
        isRealMode = true,
        userSelectedDeviceId = null,
        activeDeviceId = "emulator-5554",
        isIos = false,
      )

    assertNull(binding)
  }

  @Test
  fun `a device list refresh after an agent release still does not bind`() {
    // The refresh loop re-evaluates the same inputs; the binding stays null, so the session loop
    // never calls setActiveDevice and cannot grab the released device.
    repeat(3) {
      assertNull(
        desktopSessionBindingFor(
          isRealMode = true,
          userSelectedDeviceId = null,
          activeDeviceId = "emulator-5554",
          isIos = false,
        ),
      )
    }
  }

  @Test
  fun `an explicit user pick binds that device`() {
    val binding =
      desktopSessionBindingFor(
        isRealMode = true,
        userSelectedDeviceId = "emulator-5556",
        activeDeviceId = "emulator-5556",
        isIos = false,
      )

    assertEquals(DesktopDaemonSessionBinding("emulator-5556", "android"), binding)
  }

  @Test
  fun `an ios pick binds with the ios platform`() {
    val binding =
      desktopSessionBindingFor(
        isRealMode = true,
        userSelectedDeviceId = "UDID-1",
        activeDeviceId = "UDID-1",
        isIos = true,
      )

    assertEquals(DesktopDaemonSessionBinding("UDID-1", "ios"), binding)
  }

  @Test
  fun `a stale pick that is no longer the displayed device does not bind`() {
    val binding =
      desktopSessionBindingFor(
        isRealMode = true,
        userSelectedDeviceId = "emulator-5556",
        activeDeviceId = "emulator-5554",
        isIos = false,
      )

    assertNull(binding)
  }

  @Test
  fun `fake mode or a missing client never binds`() {
    assertNull(
      desktopSessionBindingFor(
        isRealMode = false,
        userSelectedDeviceId = "emulator-5554",
        activeDeviceId = "emulator-5554",
        isIos = false,
      ),
    )
  }
}
