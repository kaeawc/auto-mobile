package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeMotionTest {
  @Test
  fun `motion is on by default and with standard`() {
    assertTrue(prototypeMotionEnabled(null, 1f))
    assertTrue(prototypeMotionEnabled("standard", 0.5f))
  }

  @Test
  fun `spec opt-out disables motion`() {
    assertFalse(prototypeMotionEnabled("none", 1f))
  }

  @Test
  fun `zero animator duration scale disables motion`() {
    assertFalse(prototypeMotionEnabled(null, 0f))
    assertFalse(prototypeMotionEnabled("standard", 0f))
  }

  @Test
  fun `render model carries the spec motion`() {
    val spec =
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        motion = "none",
        root = PrototypeBoxNode(children = emptyList()),
      )
    assertEquals("none", mapPrototypeSpec(spec).motion)
  }

  @Test
  fun `transition none disables the visibleWhen enter and exit`() {
    assertEquals(EnterTransition.None, prototypeEnterTransition("none"))
    assertEquals(ExitTransition.None, prototypeExitTransition("none"))
  }

  @Test
  fun `each transition picks a distinct animation and absent keeps fade plus expand`() {
    val enters = listOf(null, "fade", "expand", "slide").map { prototypeEnterTransition(it) }
    val exits = listOf(null, "fade", "expand", "slide").map { prototypeExitTransition(it) }
    assertEquals(enters.size, enters.toSet().size)
    assertEquals(exits.size, exits.toSet().size)
    assertNotEquals(EnterTransition.None, enters[0])
  }

  @Test
  fun `source node carries the transition`() {
    assertEquals("slide", PrototypeBoxNode(transition = "slide", children = emptyList()).transition)
  }
}
