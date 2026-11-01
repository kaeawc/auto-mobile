package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeContentSizeTest {
  @get:Rule val compose = createComposeRule()

  private fun checkSizeAnimation(enabled: Boolean) {
    val expanded = mutableStateOf(false)
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotionActivity provides activity) {
        Box(Modifier.testTag("size").prototypeAnimateSize(enabled)) {
          Box(Modifier.size(if (expanded.value) 120.dp else 40.dp))
        }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    val start = compose.onNodeWithTag("size").fetchSemanticsNode().boundsInRoot.width
    compose.runOnUiThread {
      expanded.value = true
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    if (enabled) {
      compose.mainClock.advanceTimeBy(64)
      val middle = compose.onNodeWithTag("size").fetchSemanticsNode().boundsInRoot.width
      assertTrue(middle > start && middle < start * 3)
      assertTrue(activity.snapshot().active > 0)
      compose.mainClock.advanceTimeBy(2000)
    }
    assertEquals(
      start * 3,
      compose.onNodeWithTag("size").fetchSemanticsNode().boundsInRoot.width,
      1f,
    )
    assertEquals(0, activity.snapshot().active)
  }

  @Test fun `size animation draws mid-flight and final sizes`() = checkSizeAnimation(true)

  @Test fun `disabled size animation settles in a single frame`() = checkSizeAnimation(false)
}
