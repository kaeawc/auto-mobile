package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContentResolver
import android.os.Looper
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.down
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.up
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
 * Rendered prototype motion against a manually driven frame clock: an animation is observable
 * mid-flight, and a zero animator duration scale must settle every change within one frame so
 * `observe` never needs to wait for the prototype (#10442).
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeMotionRenderTest {
  @get:Rule val compose = createComposeRule()

  // The prototype's own resolver once shown: Robolectric delivers a change only to observers
  // registered on the resolver that is notified.
  private var resolver: ContentResolver = RuntimeEnvironment.getApplication().contentResolver
  private var sequence = 0L

  private fun setDurationScale(scale: Float) {
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
    // The settings provider notifies observers on a real device; Robolectric's store does not.
    resolver.notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), null)
    shadowOf(Looper.getMainLooper()).idle()
  }

  private fun show(spec: PrototypeSpec): PrototypeRuntime {
    val runtime = PrototypeRuntime(spec, nextSequence = { ++sequence })
    compose.setContent {
      resolver = LocalContext.current.contentResolver
      PrototypeRuntimeContent(runtime) { runtime.handle(it) }
    }
    compose.waitForIdle()
    // From here on frames only advance when a test asks for one.
    compose.mainClock.autoAdvance = false
    return runtime
  }

  /** Applies [action], then advances [frames] frames (the first recomposes the state change). */
  private fun PrototypeRuntime.tapThenAdvance(action: PrototypeAction, frames: Int = 1) {
    runBlocking { handle(PrototypeInteraction.Tap(listOf(action))) }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
  }

  private fun settle() = compose.mainClock.advanceTimeBy(SETTLE_MS)

  private fun shown(tag: String): Int =
    compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

  private fun visibilitySpec(): PrototypeSpec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("show" to PrototypeScalar.BooleanValue(true)),
      root =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeTextNode(text = "always", testTag = "always"),
              PrototypeTextNode(
                text = "detail",
                testTag = "detail",
                visibleWhen = PrototypeCondition("show", PrototypeScalar.BooleanValue(true)),
              ),
            ),
        ),
    )

  private val hide = PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(false))

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
  fun `setting the scale to zero while the prototype is shown makes the next change instant`() {
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

  private fun pressSpec(pressScale: Double?, motion: String? = null): PrototypeSpec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      motion = motion,
      root =
        PrototypeBoxNode(
          testTag = "target",
          onTap = listOf(PrototypeEmitAction("tap")),
          style =
            PrototypeStyle(
              width = PrototypeDimension.Dp(100.0),
              height = PrototypeDimension.Dp(100.0),
              pressScale = pressScale,
            ),
          children = listOf(PrototypeTextNode(text = "go")),
        ),
    )

  private fun targetWidth(): Float =
    compose.onNodeWithTag("target", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.width

  private fun press() = compose.onNodeWithTag("target").performTouchInput { down(center) }

  @Test
  fun `pressScale shrinks a pressed tappable node and restores it on release`() {
    setDurationScale(1f)
    show(pressSpec(0.8))
    val rest = targetWidth()

    press()
    settle()
    assertEquals(rest * 0.8f, targetWidth(), 1f)

    compose.onNodeWithTag("target").performTouchInput { up() }
    settle()
    assertEquals(rest, targetWidth(), 0.5f)
  }

  @Test
  fun `pressScale snaps within one frame when the animator scale is zero`() {
    setDurationScale(0f)
    show(pressSpec(0.8))
    val rest = targetWidth()

    press()
    repeat(2) { compose.mainClock.advanceTimeByFrame() }

    assertEquals(rest * 0.8f, targetWidth(), 1f)
  }

  @Test
  fun `pressScale snaps within one frame under spec motion none`() {
    setDurationScale(1f)
    show(pressSpec(0.8, motion = "none"))
    val rest = targetWidth()

    press()
    repeat(2) { compose.mainClock.advanceTimeByFrame() }

    assertEquals(rest * 0.8f, targetWidth(), 1f)
  }

  @Test
  fun `a pressed node without pressScale keeps its size`() {
    setDurationScale(0f)
    show(pressSpec(null))
    val rest = targetWidth()

    press()
    repeat(2) { compose.mainClock.advanceTimeByFrame() }

    assertEquals(rest, targetWidth(), 0.5f)
  }

  private fun pagerSpec(): PrototypeSpec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root =
        PrototypePagerNode(
          "pager",
          children = List(3) { PrototypeTextNode(text = "page $it", testTag = "page$it") },
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

  private val toLastPage = PrototypeSetPageAction("pager", PrototypePageTarget.Index(2))

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
