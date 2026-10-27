package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeIconEffectRepeat
import dev.jasonpearson.automobile.protocol.PrototypeLoop
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [28])
class PrototypeLoopsRenderTest {
  @get:Rule val compose = createComposeRule()
  private var now = 0L
  private val activity = PrototypeMotionActivity(clock = { now })
  private val enabled = mutableStateOf(false)

  private fun show(loop: PrototypeLoop?, shimmer: Boolean = false, reduced: Boolean = false) {
    compose.mainClock.autoAdvance = false
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides enabled.value,
        LocalPrototypeMotionProfile provides
          (if (reduced) PrototypeMotionProfile.REDUCED else PrototypeMotionProfile.FULL),
        LocalPrototypeMotionActivity provides activity,
      ) {
        Box(
          Modifier.size(120.dp).background(Color.White).testTag("frame"),
          contentAlignment = Alignment.Center,
        ) {
          Box(
            Modifier.prototypeLoop(loop)
              .prototypeShimmer(shimmer)
              .size(48.dp, 24.dp)
              .background(Color.Red)
              .testTag("loop"),
          ) {
            Box(Modifier.size(12.dp).background(Color.Blue))
          }
        }
      }
    }
    compose.waitForIdle()
  }

  private fun image(): Bitmap = compose.onNodeWithTag("frame").captureToImage().asAndroidBitmap()

  private fun start() {
    compose.runOnUiThread {
      enabled.value = true
      Snapshot.sendApplyNotifications()
    }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(256)
  }

  private fun assertCaptureRest(effect: String?, shimmer: Boolean = false) {
    show(effect?.let { PrototypeLoop(it, 800) }, shimmer)
    val rest = image()
    val bounds = compose.onNodeWithTag("loop").fetchSemanticsNode().boundsInRoot
    start()
    assertFalse("moving pixels must differ from rest", rest.sameAs(image()))
    assertEquals(PrototypeMotionState(0, 1), activity.snapshot())
    assertEquals(bounds, compose.onNodeWithTag("loop").fetchSemanticsNode().boundsInRoot)
    compose.runOnUiThread {
      activity.holdForCapture()
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    val first = image()
    assertTrue("capture must draw identity", rest.sameAs(first))
    compose.mainClock.advanceTimeBy(160)
    assertTrue("held captures must be pixel-identical", first.sameAs(image()))
    now = 1500L
    compose.mainClock.advanceTimeByFrame()
    assertFalse("motion resumes after the bounded hold", rest.sameAs(image()))
  }

  @Test fun `pulse is held at rest for identical captures`() = assertCaptureRest("pulse")

  @Test fun `spin is held at rest for identical captures`() = assertCaptureRest("spin")

  @Test fun `shimmer is held without a highlight band`() = assertCaptureRest(null, shimmer = true)

  @Test
  fun `infinite loops do not block Compose idling`() {
    show(PrototypeLoop("pulse", 400))
    start()
    compose.mainClock.autoAdvance = true
    compose.runOnIdle { assertEquals(PrototypeMotionState(0, 1), activity.snapshot()) }
  }

  @Test
  fun `finite loop is active mid-flight and settles to rest`() {
    show(PrototypeLoop("spin", 400, PrototypeIconEffectRepeat(2)))
    val rest = image()
    start()
    assertFalse(rest.sameAs(image()))
    assertEquals(PrototypeMotionState(1, 0), activity.snapshot())
    compose.mainClock.advanceTimeBy(900)
    assertTrue(rest.sameAs(image()))
    assertEquals(PrototypeMotionState.Settled, activity.snapshot())
  }

  @Test
  fun `reduced motion leaves loops at rest and uncounted`() {
    show(PrototypeLoop("pulse", 400), reduced = true)
    val rest = image()
    start()
    assertTrue(rest.sameAs(image()))
    assertEquals(PrototypeMotionState.Settled, activity.snapshot())
  }

  @Test
  fun `motion off leaves loops at rest and uncounted`() {
    show(PrototypeLoop("spin", 400))
    val rest = image()
    compose.mainClock.advanceTimeBy(800)
    assertTrue(rest.sameAs(image()))
    assertEquals(PrototypeMotionState.Settled, activity.snapshot())
  }
}
