package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #10660, #10730: the studio pane's device is the session's only pane. Showing it allocates
 * nothing; the session allocates it only on the user's first input, so an auto-selected device can
 * be shown (and watched) without ever being reserved.
 */
class DesktopSessionBindingPolicyTest {
  @Test
  fun `the shown device is the session's pane whether or not the user picked it`() {
    assertEquals(
      listOf(DesktopDaemonSessionBinding("emulator-5554", "android")),
      desktopSessionPanesFor(isRealMode = true, activeDeviceId = "emulator-5554", isIos = false),
    )
  }

  @Test
  fun `an ios device is a pane with the ios platform`() {
    assertEquals(
      listOf(DesktopDaemonSessionBinding("UDID-1", "ios")),
      desktopSessionPanesFor(isRealMode = true, activeDeviceId = "UDID-1", isIos = true),
    )
  }

  @Test
  fun `no shown device means no pane`() {
    assertEquals(
      emptyList(),
      desktopSessionPanesFor(isRealMode = true, activeDeviceId = null, isIos = false),
    )
  }

  @Test
  fun `fake mode or a missing client has no pane`() {
    assertEquals(
      emptyList(),
      desktopSessionPanesFor(isRealMode = false, activeDeviceId = "emulator-5554", isIos = false),
    )
  }
}
