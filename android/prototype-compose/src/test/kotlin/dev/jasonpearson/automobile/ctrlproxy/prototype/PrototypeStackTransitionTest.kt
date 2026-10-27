package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStackTransition
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PrototypeStackTransitionTest {
  @Test
  fun `resolution honors overrides motion and reduced motion`() {
    val transitions = listOf(null) + PrototypeStackTransition.entries
    val flags = listOf(false, true)
    val cases = transitions.flatMap { declared ->
      transitions.flatMap { override ->
        flags.flatMap { motion ->
          flags.map { reduced -> ResolutionCase(declared, override, motion, reduced) }
        }
      }
    }
    cases.forEach { assertEquals(it.expected(), it.resolve()) }
  }

  private data class ResolutionCase(
    val declared: PrototypeStackTransition?,
    val override: PrototypeStackTransition?,
    val motion: Boolean,
    val reduced: Boolean,
  ) {
    fun resolve() = resolveStackTransition(declared, override, motion, reduced)

    fun expected(): StackTransitionKind {
      val chosen = override ?: declared ?: PrototypeStackTransition.PLATFORM
      return when {
        !motion || chosen == PrototypeStackTransition.NONE -> StackTransitionKind.None
        chosen == PrototypeStackTransition.FADE || reduced -> StackTransitionKind.Fade
        chosen == PrototypeStackTransition.SHARED_AXIS_X -> StackTransitionKind.SharedAxisX
        chosen == PrototypeStackTransition.SHARED_AXIS_Y -> StackTransitionKind.SharedAxisY
        chosen == PrototypeStackTransition.ZOOM -> StackTransitionKind.Zoom
        chosen == PrototypeStackTransition.FADE_THROUGH -> StackTransitionKind.FadeThrough
        else -> StackTransitionKind.Slide
      }
    }
  }

  @Test
  fun `platform replacement fades through and respects reduced or disabled motion`() {
    val replace = PrototypeStackChange("nav", "replace")
    val animation = resolveStackAnimation(null, replace, true, false)
    assertEquals(StackTransitionKind.Fade, animation.kind)
    assertTrue(animation.fadeThrough)
    assertFalse(resolveStackAnimation(null, replace, true, true).fadeThrough)
    assertEquals(StackTransitionKind.None, resolveStackAnimation(null, replace, false, false).kind)
    assertEquals(
      StackTransitionKind.Slide,
      resolveStackAnimation(PrototypeStackTransition.SLIDE, replace, true, false).kind,
    )
  }

  @Test
  fun `slides mirror at the end edge`() {
    assertEquals(100, stackSlideOffset(100, false))
    assertEquals(-100, stackSlideOffset(100, true))
    for (rtl in listOf(false, true)) {
      val sign = if (rtl) -1 else 1
      assertEquals(100 * sign, stackEnterOffset(100, false, rtl))
      assertEquals(-30 * sign, stackExitOffset(100, false, rtl))
      assertEquals(-30 * sign, stackEnterOffset(100, true, rtl))
      assertEquals(100 * sign, stackExitOffset(100, true, rtl))
    }
  }

  @Test
  fun `scroll entries retain common prefix and drop replaced or popped entries`() {
    val store = PrototypeStackScrollStore()
    store.retain(listOf("root", "detail"))
    store.save(0, "root", "scroll", 42)
    store.save(1, "detail", "scroll", 99)
    store.retain(listOf("root", "other"))
    assertEquals(42, store.read(0, "root", "scroll"))
    assertEquals(0, store.read(1, "detail", "scroll"))
    store.retain(listOf("root"))
    store.retain(listOf("root", "detail"))
    assertEquals(0, store.read(1, "detail", "scroll"))
    store.retain(emptyList())
    assertEquals(0, store.read(0, "root", "scroll"))
  }

  @Test
  fun `seek commits with progress or with no progress and cancels without commit`() = runBlocking {
    val seen = mutableListOf<Float>()
    assertTrue(collectStackBackProgress(flowOf(0.2f, 0.8f)) { seen += it })
    assertEquals(listOf(0.2f, 0.8f), seen)
    assertTrue(collectStackBackProgress(flowOf()) {})
    assertFalse(
      collectStackBackProgress(
        flow {
          emit(0.5f)
          throw kotlinx.coroutines.CancellationException()
        },
      ) {},
    )
  }
}
