package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import dev.jasonpearson.automobile.protocol.keyframeValue
import dev.jasonpearson.automobile.protocol.prototypeKeyframePoints
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeKeyframesRenderTest {
  @get:Rule val compose = createComposeRule()
  private val frames =
    Json.parseToJsonElement(
      """{"trigger":{"key":"liked"},"durationMs":600,"tracks":{"scale":[[0,1],[0.35,1.3],[1,1]],"alpha":[[0,1],[0.35,0.2],[1,1]]}}""",
    ) as JsonObject

  @Test
  fun `does not play on mount plays on change restarts and settles`() {
    var trigger by mutableStateOf(false)
    var readProgress = { 1f }
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        val progress = rememberPrototypeKeyframeProgress(frames, JsonPrimitive(trigger))
        readProgress = { progress.value }
      }
    }
    compose.mainClock.autoAdvance = false
    compose.runOnIdle {
      assertEquals(1f, readProgress(), 0f)
      assertEquals(0, activity.snapshot().active)
    }
    compose.runOnUiThread {
      trigger = true
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    compose.mainClock.advanceTimeBy(210)
    compose.runOnIdle {
      assertTrue(readProgress() in 0.2f..0.5f)
      val track = (frames["tracks"] as JsonObject).getValue("scale")
      assertTrue(
        keyframeValue(prototypeKeyframePoints(track), "linear", readProgress().toDouble()) > 1.1,
      )
      assertTrue(activity.snapshot().active > 0)
    }
    compose.runOnUiThread {
      trigger = false
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    compose.mainClock.advanceTimeByFrame()
    compose.runOnIdle { assertTrue(readProgress() < 0.1f) }
    compose.mainClock.advanceTimeBy(700)
    compose.runOnIdle {
      assertEquals(1f, readProgress(), 0f)
      assertEquals(0, activity.snapshot().active)
    }
  }

  @Test
  fun `reduced retains alpha and drops every spatial track`() {
    var trigger by mutableStateOf(false)
    var readProgress = { 1f }
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
        LocalPrototypeMotionActivity provides activity,
      ) {
        val progress = rememberPrototypeKeyframeProgress(frames, JsonPrimitive(trigger))
        readProgress = { progress.value }
      }
    }
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      trigger = true
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeByFrame()
    compose.mainClock.advanceTimeBy(210)
    compose.runOnIdle {
      val alpha = (frames["tracks"] as JsonObject).getValue("alpha")
      assertTrue(
        keyframeValue(prototypeKeyframePoints(alpha), "linear", readProgress().toDouble()) < 0.7,
      )
      assertTrue(prototypeKeyframeTrackEnabled("alpha", PrototypeMotionProfile.REDUCED))
      for (name in
        listOf("scale", "scaleX", "scaleY", "rotation", "offsetX", "offsetY")) assertFalse(
        prototypeKeyframeTrackEnabled(name, PrototypeMotionProfile.REDUCED),
      )
      assertTrue(activity.snapshot().active > 0)
    }
    compose.mainClock.advanceTimeBy(700)
    compose.runOnIdle { assertEquals(0, activity.snapshot().active) }
  }

  @Test
  fun `off never plays`() {
    var trigger by mutableStateOf(false)
    var readProgress = { 1f }
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides false,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.OFF,
        LocalPrototypeMotionActivity provides activity,
      ) {
        val progress = rememberPrototypeKeyframeProgress(frames, JsonPrimitive(trigger))
        readProgress = { progress.value }
      }
    }
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      trigger = true
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeBy(210)
    compose.runOnIdle {
      assertEquals(1f, readProgress(), 0f)
      assertEquals(0, activity.snapshot().active)
    }
  }

  @Test
  fun `draw transforms leave observed bounds unchanged`() {
    var trigger by mutableStateOf(false)
    val root =
      mapPrototypeSpec(
          PrototypeSpec(
            "draw",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            root = PrototypeBoxNode(children = emptyList(), keyframes = frames),
          ),
        )
        .root
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
      ) {
        Box(
          Modifier.size(80.dp)
            .prototypeKeyframes(root.copy(keyframeTrigger = JsonPrimitive(trigger)))
            .testTag("draw"),
        )
      }
    }
    compose.mainClock.autoAdvance = false
    val before = compose.onNodeWithTag("draw").fetchSemanticsNode().boundsInRoot
    compose.runOnUiThread {
      trigger = true
      Snapshot.sendApplyNotifications()
    }
    compose.mainClock.advanceTimeBy(210)
    val during = compose.onNodeWithTag("draw").fetchSemanticsNode().boundsInRoot
    assertEquals(before, during)
  }
}
