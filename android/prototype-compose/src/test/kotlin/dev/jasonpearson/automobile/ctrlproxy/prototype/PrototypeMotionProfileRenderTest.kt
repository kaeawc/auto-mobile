package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PrototypeMotionProfileRenderTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `reduced shimmer stays at rest without reporting a loop`() {
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
        LocalPrototypeMotionActivity provides activity,
      ) {
        Box(Modifier.size(80.dp).prototypeShimmer(true).testTag("loading"))
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.mainClock.advanceTimeBy(1500)
    compose.onNodeWithTag("loading").assertIsDisplayed()
    assertEquals(PrototypeMotionState(0, 0), activity.snapshot())
  }

  @Test
  fun `reduced indeterminate progress does not animate`() {
    val activity = PrototypeMotionActivity()
    val model =
      mapPrototypeSpec(
          PrototypeSpec(
            "progress",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            root = PrototypeProgressNode(),
          ),
        )
        .root
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
        LocalPrototypeMotionActivity provides activity,
      ) {
        RenderPrototypeProgress(model, Modifier.testTag("progress"))
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.mainClock.advanceTimeBy(1500)
    compose
      .onNodeWithTag("progress")
      .assertRangeInfoEquals(androidx.compose.ui.semantics.ProgressBarRangeInfo.Indeterminate)
    assertEquals(PrototypeMotionState(0, 0), activity.snapshot())
  }

  @Test
  fun `reduced press scale snaps on press and release`() {
    val source = MutableInteractionSource()
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
        LocalPrototypeMotionActivity provides activity,
      ) {
        Box(
          Modifier.prototypePressScale(source, 0.8f)
            .size(100.dp)
            .background(Color.Red)
            .testTag("press"),
        )
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    val before = compose.onNodeWithTag("press").fetchSemanticsNode().boundsInRoot.width
    val press = PressInteraction.Press(Offset.Zero)
    compose.runOnUiThread { runBlocking { source.emit(press) } }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(
      before * 0.8f,
      compose.onNodeWithTag("press").fetchSemanticsNode().boundsInRoot.width,
      0.1f,
    )
    assertEquals(0, activity.snapshot().active)
    compose.runOnUiThread { runBlocking { source.emit(PressInteraction.Release(press)) } }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(
      before,
      compose.onNodeWithTag("press").fetchSemanticsNode().boundsInRoot.width,
      0.1f,
    )
    assertEquals(0, activity.snapshot().active)
  }

  @Test
  fun `reduced style alpha and color animate while scale snaps`() {
    var changed by mutableStateOf(false)
    var alpha = 1f
    var color = Color.Blue
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
      ) {
        val model =
          mapPrototypeSpec(
              PrototypeSpec(
                "style",
                PrototypeWindow(PrototypeFullscreenPlacement()),
                root =
                  PrototypeBoxNode(
                    children = emptyList(),
                    animate = PrototypeAnimate(durationMs = 300, easing = "linear"),
                    style =
                      PrototypeStyle(
                        alpha = if (changed) 0.2 else 1.0,
                        scale = if (changed) 0.8 else 1.0,
                      ),
                  ),
              ),
            )
            .root
        alpha = prototypeAnimatedAlpha(model)
        color = prototypeAnimatedColor(model, if (changed) Color.Red else Color.Blue)
        Box(Modifier.prototypeStyleTransform(model).size(100.dp).testTag("transform"))
      }
    }
    compose.waitForIdle()
    val start = compose.onNodeWithTag("transform").fetchSemanticsNode().boundsInRoot.width
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      changed = true
      Snapshot.sendApplyNotifications()
    }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(64)
    assertTrue("alpha=$alpha", alpha > 0.2f && alpha < 1f)
    assertTrue(color.red > 0f && color.blue > 0f)
    assertEquals(
      start * 0.8f,
      compose.onNodeWithTag("transform").fetchSemanticsNode().boundsInRoot.width,
      0.1f,
    )
    compose.mainClock.advanceTimeBy(400)
    assertEquals(0.2f, alpha, 0.001f)
    assertEquals(Color.Red, color)
  }

  @Test
  fun `both global settings are observed while composed`() {
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    val animator = Settings.Global.ANIMATOR_DURATION_SCALE
    val transition = Settings.Global.TRANSITION_ANIMATION_SCALE
    val previousAnimator = Settings.Global.getFloat(resolver, animator, 1f)
    val previousTransition = Settings.Global.getFloat(resolver, transition, 1f)
    var profile = PrototypeMotionProfile.OFF
    try {
      Settings.Global.putFloat(resolver, animator, 1f)
      Settings.Global.putFloat(resolver, transition, 1f)
      compose.setContent {
        val a by rememberAnimatorDurationScale(resolver)
        val t by rememberTransitionAnimationScale(resolver)
        profile = prototypeMotionProfile(null, a, t)
      }
      compose.runOnIdle { assertEquals(PrototypeMotionProfile.FULL, profile) }
      for (setting in listOf(animator, transition)) {
        compose.runOnIdle { Settings.Global.putFloat(resolver, setting, 0f) }
        compose.runOnIdle { assertEquals(PrototypeMotionProfile.OFF, profile) }
        compose.runOnIdle { Settings.Global.putFloat(resolver, setting, 1f) }
        compose.runOnIdle { assertEquals(PrototypeMotionProfile.FULL, profile) }
      }
    } finally {
      Settings.Global.putFloat(resolver, animator, previousAnimator)
      Settings.Global.putFloat(resolver, transition, previousTransition)
    }
  }
}
