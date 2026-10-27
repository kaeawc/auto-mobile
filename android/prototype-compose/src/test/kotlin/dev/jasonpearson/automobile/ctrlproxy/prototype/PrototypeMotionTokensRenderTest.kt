package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.PrototypeAnimate
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeMotionTokensRenderTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun expressiveScaleOvershootsWhileAlphaIsCriticallyDamped() {
    var target by mutableStateOf(0f)
    var readScale = { 0f }
    var readAlpha = { 0f }
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeExpressive provides true,
      ) {
        val animate = PrototypeAnimate(tempo = "fast")
        val scale = animateFloatAsState(target, prototypeStyleAnimation(animate), label = "scale")
        val alpha =
          animateFloatAsState(
            target,
            prototypeStyleAnimation(animate, effects = true),
            label = "alpha",
          )
        readScale = { scale.value }
        readAlpha = { alpha.value }
      }
    }
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      target = 1f
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    compose.mainClock.advanceTimeByFrame()
    // The fast expressive spatial spring reaches its first peak near 140 ms.
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle {
      assertTrue("scale=${readScale()}", readScale() > 1f)
      assertTrue("alpha=${readAlpha()}", readAlpha() > 0f && readAlpha() <= 1f)
    }
  }
}
