package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// PixelCopy of a window (captureToImage) needs API 26+; the module default is 24.
@Config(sdk = [28])
class PrototypeMotionV3RenderTest {
  @get:Rule val compose = createComposeRule()

  @Test fun `off switch reaches final pixels within one frame`() = assertInstantControl("switch")

  @Test
  fun `off checkbox reaches final pixels within one frame`() = assertInstantControl("checkbox")

  @Test fun `off slider reaches final pixels within one frame`() = assertInstantControl("slider")

  private fun assertInstantControl(role: String) {
    var changed by mutableStateOf(false)
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides false) {
        MaterialTheme {
          PrototypeMotionTheme {
            Column {
              for ((tag, final) in listOf("changing" to changed, "final" to true)) {
                val source =
                  when (role) {
                    "switch" -> PrototypeSwitchNode(stateKey = "value")
                    "checkbox" -> PrototypeCheckboxNode(stateKey = "value")
                    else -> PrototypeSliderNode(stateKey = "value", min = 0.0, max = 1.0)
                  }
                val state =
                  if (role == "slider") PrototypeScalar.Numeric(if (final) 1.0 else 0.0)
                  else PrototypeScalar.BooleanValue(final)
                val model =
                  mapPrototypeSpec(
                      PrototypeSpec(
                        "control",
                        PrototypeWindow(PrototypeFullscreenPlacement()),
                        state = mapOf("value" to state),
                        root = source,
                      ),
                    )
                    .root
                Box(Modifier.width(240.dp).testTag(tag)) {
                  if (role == "slider") RenderPrototypeSlider(model, Modifier) {}
                  else RenderPrototypeToggle(model, Modifier) {}
                }
              }
            }
          }
        }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      changed = true
      Snapshot.sendApplyNotifications()
    }
    // One recomposition frame, with no animation time advanced after it.
    compose.mainClock.advanceTimeByFrame()
    val expected = compose.onNodeWithTag("final").captureToImage().asAndroidBitmap()
    val actual = compose.onNodeWithTag("changing").captureToImage().asAndroidBitmap()
    assertTrue("$role still draws an intermediate state", expected.sameAs(actual))
  }

  @Test
  fun `draw-only press retains reported bounds`() {
    val source = MutableInteractionSource()
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides false) {
        Box(
          Modifier.prototypePressScale(source, 0.85f, 0.5f, drawOnly = true)
            .size(48.dp)
            .background(Color.Red)
            .testTag("press"),
        )
      }
    }
    compose.waitForIdle()
    val before = compose.onNodeWithTag("press").fetchSemanticsNode().boundsInRoot
    compose.mainClock.autoAdvance = false
    val press = PressInteraction.Press(Offset.Zero)
    compose.runOnUiThread { runBlocking { source.emit(press) } }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(before, compose.onNodeWithTag("press").fetchSemanticsNode().boundsInRoot)
    compose.runOnUiThread { runBlocking { source.emit(PressInteraction.Release(press)) } }
  }

  @Test
  fun `off authored clickable installs no indication`() {
    var absent = false
    compose.setContent { absent = prototypeIndication(false) == null }
    compose.runOnIdle { assertTrue(absent) }
  }

  @Test
  fun `layout interpolation is immediate when motion is off`() {
    var changed by mutableStateOf(false)
    var observed = PrototypeStyle()
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides false) {
        val style =
          PrototypeStyle(
            width = PrototypeDimension.Dp(if (changed) 120.0 else 40.0),
            cornerRadius = PrototypeCornerRadius.Dp(if (changed) 24.0 else 0.0),
            elevation = if (changed) 8.0 else 0.0,
            padding = PrototypePadding(top = if (changed) 12.0 else 0.0),
          )
        val node =
          mapPrototypeSpec(
              PrototypeSpec(
                "layout",
                PrototypeWindow(PrototypeFullscreenPlacement()),
                root =
                  PrototypeBoxNode(
                    children = emptyList(),
                    style = style,
                    animate = PrototypeAnimate(easing = "spring"),
                  ),
              ),
            )
            .root
        observed = prototypeAnimatedLayout(node)
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      changed = true
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    assertEquals(PrototypeDimension.Dp(120.0), observed.width)
    assertEquals(PrototypeCornerRadius.Dp(24.0), observed.cornerRadius)
    assertEquals(8.0, checkNotNull(observed.elevation), 0.0)
    assertEquals(12.0, checkNotNull(observed.padding?.top), 0.0)
  }

  @Test
  fun `layout fields tween between state targets`() {
    var changed by mutableStateOf(false)
    var observed = PrototypeStyle()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
      ) {
        val style =
          PrototypeStyle(
            width = PrototypeDimension.Dp(if (changed) 120.0 else 40.0),
            height = PrototypeDimension.Dp(if (changed) 100.0 else 20.0),
            cornerRadius = PrototypeCornerRadius.Dp(if (changed) 24.0 else 0.0),
            elevation = if (changed) 8.0 else 0.0,
            padding = PrototypePadding(top = if (changed) 12.0 else 0.0),
            border = PrototypeBorder(if (changed) 6.0 else 2.0, "#112233"),
          )
        val node =
          mapPrototypeSpec(
              PrototypeSpec(
                "layout",
                PrototypeWindow(PrototypeFullscreenPlacement()),
                root =
                  PrototypeBoxNode(
                    children = emptyList(),
                    style = style,
                    animate = PrototypeAnimate(durationMs = 200, easing = "linear"),
                  ),
              ),
            )
            .root
        observed = prototypeAnimatedLayout(node)
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      changed = true
      Snapshot.sendApplyNotifications()
    }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(64)
    assertTrue((observed.width as PrototypeDimension.Dp).dp in 40.01..119.99)
    assertTrue((observed.height as PrototypeDimension.Dp).dp in 20.01..99.99)
    assertTrue(
      checkNotNull((observed.cornerRadius as PrototypeCornerRadius.Corners).topStart) in
        0.01..23.99,
    )
    assertTrue(checkNotNull(observed.elevation) in 0.01..7.99)
    assertTrue(checkNotNull(observed.padding?.top) in 0.01..11.99)
    assertTrue(checkNotNull(observed.border).width in 2.01..5.99)
  }

  @Test
  fun `delayed finite spring holds then follows its original trajectory`() {
    val original = TargetBasedAnimation(spring<Float>(), Float.VectorConverter, 0f, 1f)
    val delayed =
      TargetBasedAnimation(spring<Float>().prototypeEnterDelay(120), Float.VectorConverter, 0f, 1f)
    assertEquals(0f, delayed.getValueFromNanos(119_000_000L))
    assertEquals(original.getValueFromNanos(50_000_000L), delayed.getValueFromNanos(170_000_000L))
    assertEquals(original.durationNanos + 120_000_000L, delayed.durationNanos)
  }
}
