package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class OverlayMotionTest {
  @Test
  fun `motion is on by default and with standard`() {
    assertTrue(overlayMotionEnabled(null, 1f))
    assertTrue(overlayMotionEnabled("standard", 0.5f))
  }

  @Test
  fun `spec opt-out disables motion`() {
    assertFalse(overlayMotionEnabled("none", 1f))
  }

  @Test
  fun `zero animator duration scale disables motion`() {
    assertFalse(overlayMotionEnabled(null, 0f))
    assertFalse(overlayMotionEnabled("standard", 0f))
  }

  @Test
  fun `render model carries the spec motion`() {
    val spec =
      OverlaySpec(
        "panel",
        OverlayWindow(OverlayFullscreenPlacement()),
        motion = "none",
        root = OverlayBoxNode(children = emptyList()),
      )
    assertEquals("none", mapOverlaySpec(spec).motion)
  }
}
