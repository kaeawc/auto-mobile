package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
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

  @Test
  fun `transition none disables the visibleWhen enter and exit`() {
    assertEquals(EnterTransition.None, overlayEnterTransition("none"))
    assertEquals(ExitTransition.None, overlayExitTransition("none"))
  }

  @Test
  fun `each transition picks a distinct animation and absent keeps fade plus expand`() {
    val enters = listOf(null, "fade", "expand", "slide").map { overlayEnterTransition(it) }
    val exits = listOf(null, "fade", "expand", "slide").map { overlayExitTransition(it) }
    assertEquals(enters.size, enters.toSet().size)
    assertEquals(exits.size, exits.toSet().size)
    assertNotEquals(EnterTransition.None, enters[0])
  }

  @Test
  fun `source node carries the transition`() {
    assertEquals("slide", OverlayBoxNode(transition = "slide", children = emptyList()).transition)
  }
}
