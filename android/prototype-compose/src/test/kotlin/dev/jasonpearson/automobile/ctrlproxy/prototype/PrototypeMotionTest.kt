package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeMotionTest {
  @Test
  fun `profiles respect spec and both system scales`() {
    for (motion in listOf(null, "standard", "none", "reduced")) {
      for (animator in listOf(0f, 0.5f, 1f)) {
        for (transition in listOf(0f, 0.5f, 1f)) {
          val expected =
            when {
              motion == "none" || animator == 0f || transition == 0f -> PrototypeMotionProfile.OFF
              motion == "reduced" -> PrototypeMotionProfile.REDUCED
              else -> PrototypeMotionProfile.FULL
            }
          assertEquals(
            "$motion / $animator / $transition",
            expected,
            prototypeMotionProfile(motion, animator, transition),
          )
        }
      }
    }
  }

  @Test
  fun `reduced visibility replaces spatial transitions with fades`() {
    for (type in
      listOf(null, "slide", "slideStart", "slideEnd", "expand", "scale", "blurReplace", "fade")) {
      assertEquals("fade", prototypeVisibilityTransition(type, PrototypeMotionProfile.REDUCED))
      assertEquals(type, prototypeVisibilityTransition(type, PrototypeMotionProfile.FULL))
    }
    assertEquals("none", prototypeVisibilityTransition("none", PrototypeMotionProfile.REDUCED))
    assertEquals(
      "fade",
      prototypeVisibilityTransition("none", PrototypeMotionProfile.REDUCED, shared = true),
    )
  }

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
    assertEquals(
      PrototypeTransition("slide"),
      PrototypeBoxNode(transition = PrototypeTransition("slide"), children = emptyList())
        .transition,
    )
  }
}
