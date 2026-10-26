package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContentResolver
import android.os.Looper
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/** The counter behind `motion: {active, loops}` in the window metadata (#15114). Pure. */
class PrototypeMotionActivityCounterTest {
  @Test
  fun `a site reporting twice is counted once and release drops it from both counts`() {
    val activity = PrototypeMotionActivity()
    val a = Any()
    val b = Any()

    activity.report(a, true)
    activity.report(a, true)
    activity.report(b, true, loop = true)
    assertEquals(PrototypeMotionState(1, 1), activity.snapshot())

    activity.report(a, false)
    assertEquals(PrototypeMotionState(0, 1), activity.snapshot())

    activity.report(a, true)
    activity.release(a)
    activity.release(b)
    assertEquals(PrototypeMotionState.Settled, activity.snapshot())
  }

  @Test
  fun `window metadata copies carry the motion state and default to none`() {
    val base = PrototypeWindowMetadata("floating", true)
    assertEquals(null, base.motion)
    assertEquals(
      PrototypeMotionState(2, 1),
      base.copy(motion = PrototypeMotionState(2, 1)).motion,
    )
  }
}

/**
 * Each transition drawn mid-flight and at rest against a manually driven frame clock, with the
 * motion-active signal the host reads: positive while the animation runs, zero once it settles, and
 * zero after a single frame when motion is off (#15114).
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeMotionActivityTest {
  @get:Rule val compose = createComposeRule()

  private var resolver: ContentResolver = RuntimeEnvironment.getApplication().contentResolver
  private var sequence = 0L

  private fun setDurationScale(scale: Float) {
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
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
    compose.mainClock.autoAdvance = false
    return runtime
  }

  private fun PrototypeRuntime.tapThenAdvance(action: PrototypeAction, frames: Int = 1) {
    runBlocking { handle(PrototypeInteraction.Tap(listOf(action))) }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
  }

  private fun settle() = compose.mainClock.advanceTimeBy(SETTLE_MS)

  private fun shown(tag: String): Int =
    compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

  private fun PrototypeRuntime.state() = motionActivity.snapshot()

  private fun transitionSpec(transition: String, motion: String? = null): PrototypeSpec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      motion = motion,
      state = mapOf("show" to PrototypeScalar.BooleanValue(true)),
      root =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeTextNode(text = "always", testTag = "always"),
              PrototypeTextNode(
                text = "detail",
                testTag = "detail",
                transition = PrototypeTransition(transition),
                visibleWhen = PrototypeCondition("show", PrototypeScalar.BooleanValue(true)),
              ),
            ),
        ),
    )

  private val hide = PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(false))

  private fun assertTransitionFlies(transition: String) {
    setDurationScale(1f)
    val runtime = show(transitionSpec(transition))
    assertEquals("$transition: settled before the change", 0, runtime.state().active)

    runtime.tapThenAdvance(hide, frames = 2)
    assertEquals("$transition: exit still drawn mid-flight", 1, shown("detail"))
    assertTrue("$transition: motion active mid-flight", runtime.state().active > 0)
    assertEquals("$transition: not a loop", 0, runtime.state().loops)

    settle()
    assertEquals("$transition: gone at rest", 0, shown("detail"))
    assertEquals("$transition: settled at rest", PrototypeMotionState.Settled, runtime.state())
  }

  private fun assertTransitionSnaps(transition: String, motion: String?, scale: Float) {
    setDurationScale(scale)
    val runtime = show(transitionSpec(transition, motion))

    runtime.tapThenAdvance(hide)

    assertEquals("$transition: gone within one frame", 0, shown("detail"))
    assertEquals("$transition: never active", PrototypeMotionState.Settled, runtime.state())
  }

  @Test fun `fade is active mid-flight and settled at rest`() = assertTransitionFlies("fade")

  @Test fun `expand is active mid-flight and settled at rest`() = assertTransitionFlies("expand")

  @Test fun `slide is active mid-flight and settled at rest`() = assertTransitionFlies("slide")

  @Test
  fun `slideStart is active mid-flight and settled at rest`() = assertTransitionFlies("slideStart")

  @Test
  fun `slideEnd is active mid-flight and settled at rest`() = assertTransitionFlies("slideEnd")

  @Test fun `scale is active mid-flight and settled at rest`() = assertTransitionFlies("scale")

  @Test fun `fade settles in one frame under motion none`() = assertSnapsUnderNone("fade")

  @Test fun `expand settles in one frame under motion none`() = assertSnapsUnderNone("expand")

  @Test fun `slide settles in one frame under motion none`() = assertSnapsUnderNone("slide")

  @Test
  fun `slideStart settles in one frame under motion none`() = assertSnapsUnderNone("slideStart")

  @Test fun `slideEnd settles in one frame under motion none`() = assertSnapsUnderNone("slideEnd")

  @Test fun `scale settles in one frame under motion none`() = assertSnapsUnderNone("scale")

  @Test fun `fade settles in one frame at animator scale zero`() = assertSnapsAtScaleZero("fade")

  @Test
  fun `expand settles in one frame at animator scale zero`() = assertSnapsAtScaleZero("expand")

  @Test fun `slide settles in one frame at animator scale zero`() = assertSnapsAtScaleZero("slide")

  @Test
  fun `slideStart settles in one frame at animator scale zero`() =
    assertSnapsAtScaleZero("slideStart")

  @Test
  fun `slideEnd settles in one frame at animator scale zero`() = assertSnapsAtScaleZero("slideEnd")

  @Test
  fun `scale settles in one frame at animator scale zero`() = assertSnapsAtScaleZero("scale")

  private fun assertSnapsUnderNone(transition: String) =
    assertTransitionSnaps(transition, motion = "none", scale = 1f)

  private fun assertSnapsAtScaleZero(transition: String) =
    assertTransitionSnaps(transition, motion = null, scale = 0f)

  private fun animateSpec(animate: PrototypeAnimate, motion: String? = null): PrototypeSpec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      motion = motion,
      state = mapOf("dim" to PrototypeScalar.BooleanValue(false)),
      root =
        PrototypeBoxNode(
          testTag = "box",
          animate = animate,
          style = PrototypeStyle(width = PrototypeDimension.Dp(80.0), height = PrototypeDimension.Dp(80.0)),
          styleWhen =
            listOf(
              PrototypeStyleWhen(
                PrototypeCondition("dim", PrototypeScalar.BooleanValue(true)),
                PrototypeStyle(alpha = 0.2, scale = 0.5),
              ),
            ),
          children = emptyList(),
        ),
    )

  private val dim = PrototypeSetStateAction("dim", PrototypeScalar.BooleanValue(true))

  @Test
  fun `animate with a tween is active mid-flight and settled at rest`() {
    setDurationScale(1f)
    val runtime = show(animateSpec(PrototypeAnimate(durationMs = 300, easing = "standard")))

    runtime.tapThenAdvance(dim, frames = 3)
    assertTrue(runtime.state().active > 0)

    settle()
    assertEquals(PrototypeMotionState.Settled, runtime.state())
  }

  @Test
  fun `animate with a spring is active mid-flight and settled at rest`() {
    setDurationScale(1f)
    val runtime = show(animateSpec(PrototypeAnimate(easing = "spring")))

    runtime.tapThenAdvance(dim, frames = 3)
    assertTrue(runtime.state().active > 0)

    settle()
    assertEquals(PrototypeMotionState.Settled, runtime.state())
  }

  @Test
  fun `animate settles in one frame under motion none`() {
    setDurationScale(1f)
    val runtime = show(animateSpec(PrototypeAnimate(durationMs = 300), motion = "none"))

    runtime.tapThenAdvance(dim, frames = 2)

    assertEquals(PrototypeMotionState.Settled, runtime.state())
  }

  @Test
  fun `animate settles in one frame at animator scale zero`() {
    setDurationScale(0f)
    val runtime = show(animateSpec(PrototypeAnimate(durationMs = 300)))

    runtime.tapThenAdvance(dim, frames = 2)

    assertEquals(PrototypeMotionState.Settled, runtime.state())
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

  private val toLastPage = PrototypeSetPageAction("pager", PrototypePageTarget.Index(2))

  @Test
  fun `setPage is active while the pager scrolls and settled after`() {
    setDurationScale(1f)
    val runtime = show(pagerSpec())

    runtime.tapThenAdvance(toLastPage, frames = 4)
    assertTrue(runtime.state().active > 0)

    settle()
    assertEquals(PrototypeMotionState.Settled, runtime.state())
  }

  @Test
  fun `setPage settles in one tap under a zero animator scale`() {
    setDurationScale(0f)
    val runtime = show(pagerSpec())

    runtime.tapThenAdvance(toLastPage, frames = 3)

    assertEquals(PrototypeMotionState.Settled, runtime.state())
  }

  @Test
  fun `a shimmer is a loop and never counts as active motion`() {
    setDurationScale(1f)
    val runtime =
      show(
        PrototypeSpec(
          "panel",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root =
            PrototypeBoxNode(
              style =
                PrototypeStyle(
                  width = PrototypeDimension.Dp(80.0),
                  height = PrototypeDimension.Dp(80.0),
                  shimmer = true,
                ),
              children = emptyList(),
            ),
        ),
      )
    compose.mainClock.advanceTimeByFrame()
    compose.mainClock.advanceTimeByFrame()

    assertEquals(PrototypeMotionState(0, 1), runtime.state())
  }

  private companion object {
    const val SETTLE_MS = 2_000L
  }
}
