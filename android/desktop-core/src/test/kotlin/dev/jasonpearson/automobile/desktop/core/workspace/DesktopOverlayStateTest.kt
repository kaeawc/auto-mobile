package dev.jasonpearson.automobile.desktop.core.workspace

import kotlin.test.Test
import kotlin.test.assertEquals

class DesktopOverlayStateTest {
  @Test
  fun `opening About replaces Settings`() {
    assertEquals(DesktopOverlayState.About, DesktopOverlayState.None.openSettings().openAbout())
  }

  @Test
  fun `opening Settings replaces About`() {
    assertEquals(DesktopOverlayState.Settings, DesktopOverlayState.None.openAbout().openSettings())
  }

  @Test
  fun `closing About leaves no overlay`() {
    assertEquals(DesktopOverlayState.None, DesktopOverlayState.None.openAbout().closeAbout())
  }

  @Test
  fun `closing Settings leaves no overlay`() {
    assertEquals(DesktopOverlayState.None, DesktopOverlayState.None.openSettings().closeSettings())
  }

  @Test
  fun `closing an inactive overlay preserves the active overlay`() {
    assertEquals(DesktopOverlayState.About, DesktopOverlayState.About.closeSettings())
    assertEquals(DesktopOverlayState.Settings, DesktopOverlayState.Settings.closeAbout())
  }
}
