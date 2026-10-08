package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.ContentResolver
import android.os.Looper
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * Rendered overlay motion against a manually driven frame clock: an animation is observable
 * mid-flight, and a zero animator duration scale must settle every change within one frame so
 * `observe` never needs to wait for the overlay (#10442).
 */
@RunWith(RobolectricTestRunner::class)
class OverlayMotionRenderTest {
  @get:Rule val compose = createComposeRule()

  // The overlay's own resolver once shown: Robolectric delivers a change only to observers
  // registered on the resolver that is notified.
  private var resolver: ContentResolver = RuntimeEnvironment.getApplication().contentResolver
  private var sequence = 0L

  private fun setDurationScale(scale: Float) {
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
    // The settings provider notifies observers on a real device; Robolectric's store does not.
    resolver.notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), null)
    shadowOf(Looper.getMainLooper()).idle()
  }

  private fun show(spec: OverlaySpec): OverlayRuntime {
    val runtime = OverlayRuntime(spec, nextSequence = { ++sequence })
    compose.setContent {
      resolver = LocalContext.current.contentResolver
      OverlayRuntimeContent(runtime) { runtime.handle(it) }
    }
    compose.waitForIdle()
    // From here on frames only advance when a test asks for one.
    compose.mainClock.autoAdvance = false
    return runtime
  }

  /** Applies [action], then advances [frames] frames (the first recomposes the state change). */
  private fun OverlayRuntime.tapThenAdvance(action: OverlayAction, frames: Int = 1) {
    runBlocking { handle(OverlayInteraction.Tap(listOf(action))) }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
  }

  private fun settle() = compose.mainClock.advanceTimeBy(SETTLE_MS)

  private fun shown(tag: String): Int =
    compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

  private fun visibilitySpec(): OverlaySpec =
    OverlaySpec(
      "panel",
      OverlayWindow(OverlayFullscreenPlacement()),
      state = mapOf("show" to OverlayScalar.BooleanValue(true)),
      root =
        OverlayColumnNode(
          children =
            listOf(
              OverlayTextNode(text = "always", testTag = "always"),
              OverlayTextNode(
                text = "detail",
                testTag = "detail",
                visibleWhen = OverlayCondition("show", OverlayScalar.BooleanValue(true)),
              ),
            ),
        ),
    )

  private val hide = OverlaySetStateAction("show", OverlayScalar.BooleanValue(false))

  @Test
  fun `a zero duration scale hides a visibleWhen node within one frame`() {
    setDurationScale(0f)
    val runtime = show(visibilitySpec())
    assertEquals(1, shown("detail"))

    runtime.tapThenAdvance(hide)

    assertEquals(0, shown("detail"))
  }

  @Test
  fun `the default duration scale animates a visibleWhen node out`() {
    setDurationScale(1f)
    val runtime = show(visibilitySpec())

    runtime.tapThenAdvance(hide, frames = 2)
    assertEquals("exit animation still in flight", 1, shown("detail"))

    settle()
    assertEquals(0, shown("detail"))
  }

  @Test
  fun `setting the scale to zero while the overlay is shown makes the next change instant`() {
    setDurationScale(1f)
    val runtime = show(visibilitySpec())

    setDurationScale(0f)
    compose.mainClock.advanceTimeByFrame()
    runtime.tapThenAdvance(hide)

    assertEquals(0, shown("detail"))
  }

  @Test
  fun `spec motion none hides a visibleWhen node within one frame at the default scale`() {
    setDurationScale(1f)
    val runtime = show(visibilitySpec().copy(motion = "none"))

    runtime.tapThenAdvance(hide)

    assertEquals(0, shown("detail"))
  }

  private fun pagerSpec(): OverlaySpec =
    OverlaySpec(
      "panel",
      OverlayWindow(OverlayFullscreenPlacement()),
      root =
        OverlayPagerNode(
          "pager",
          children = List(3) { OverlayTextNode(text = "page $it", testTag = "page$it") },
        ),
    )

  /** Whether [tag]'s page is composed and scrolled exactly to the pager's start edge. */
  private fun atStart(tag: String): Boolean =
    compose
      .onAllNodesWithTag(tag, useUnmergedTree = true)
      .fetchSemanticsNodes()
      .singleOrNull()
      ?.let {
        it.boundsInRoot.left == 0f
      } ?: false

  private val toLastPage = OverlaySetPageAction("pager", OverlayPageTarget.Index(2))

  @Test
  fun `a zero duration scale snaps a setPage change within one frame`() {
    setDurationScale(0f)
    val runtime = show(pagerSpec())

    // One frame recomposes the new page; the snap's remeasure lands on the next.
    runtime.tapThenAdvance(toLastPage, frames = 2)

    assertTrue(atStart("page2"))
  }

  @Test
  fun `the default duration scale animates a setPage change`() {
    setDurationScale(1f)
    val runtime = show(pagerSpec())

    runtime.tapThenAdvance(toLastPage, frames = 2)
    assertFalse("page scroll still in flight", atStart("page2"))

    settle()
    assertTrue(atStart("page2"))
  }

  @Test
  fun `setting the scale to zero while a pager is shown makes the next setPage instant`() {
    setDurationScale(1f)
    val runtime = show(pagerSpec())

    // A page change leaves the spec untouched, so only observing the setting can see this.
    setDurationScale(0f)
    compose.mainClock.advanceTimeByFrame()
    runtime.tapThenAdvance(toLastPage, frames = 2)

    assertTrue(atStart("page2"))
  }

  @Test
  fun `setting the scale to zero mid-scroll snaps the pager to its target page`() {
    setDurationScale(1f)
    val runtime = show(pagerSpec())
    runtime.tapThenAdvance(toLastPage, frames = 6)
    assertFalse("page scroll still in flight", atStart("page2"))

    setDurationScale(0f)
    repeat(2) { compose.mainClock.advanceTimeByFrame() }

    assertTrue(atStart("page2"))
  }

  private companion object {
    const val SETTLE_MS = 2_000L
  }
}
