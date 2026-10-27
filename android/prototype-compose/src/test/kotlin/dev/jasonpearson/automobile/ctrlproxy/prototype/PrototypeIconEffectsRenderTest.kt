package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.PrototypeIconEffect
import dev.jasonpearson.automobile.protocol.PrototypeIconEffectRepeat
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeIconEffectsRenderTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `every effect moves in flight and returns to rest`() {
    compose.mainClock.autoAdvance = false
    var type by mutableStateOf("bounce")
    var name by mutableStateOf("home")
    var frame = PrototypeIconFrame()
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        val current = rememberPrototypeIconFrame(PrototypeIconEffect(type), null, name)
        SideEffect { frame = current }
      }
    }
    for (effect in
      listOf(
        "bounce",
        "pulse",
        "scale",
        "variableColor",
        "wiggle",
        "rotate",
        "breathe",
        "replace",
        "drawOn",
      )) {
      change {
        type = effect
        name = if (name == "home") "star" else "home"
      }
      compose.mainClock.advanceTimeBy(144)
      compose.runOnIdle { assertNotEquals(effect, PrototypeIconFrame(), frame) }
      compose.mainClock.advanceTimeBy(800)
      compose.runOnIdle {
        assertEquals(effect, 1f, frame.scale, .001f)
        assertEquals(effect, 1f, frame.alpha, .001f)
        assertEquals(effect, 0f, frame.rotation, .001f)
        assertEquals(PrototypeMotionState.Settled, activity.snapshot())
      }
    }
  }

  @Test
  fun `loops are counted separately and capture holds them at rest`() {
    compose.mainClock.autoAdvance = false
    var capture by mutableStateOf(false)
    var frame = PrototypeIconFrame()
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        val current =
          rememberPrototypeIconFrame(
            PrototypeIconEffect("bounce", repeat = PrototypeIconEffectRepeat()),
            null,
            "home",
            capture,
          )
        SideEffect { frame = current }
      }
    }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle {
      assertEquals(PrototypeMotionState(0, 1), activity.snapshot())
      assertNotEquals(PrototypeIconFrame(), frame)
    }
    change { capture = true }
    compose.mainClock.advanceTimeByFrame()
    compose.runOnIdle { assertEquals(PrototypeIconFrame(), frame) }
    compose.mainClock.advanceTimeBy(1000)
    compose.runOnIdle {
      assertEquals(PrototypeIconFrame(), frame)
      assertEquals(PrototypeMotionState.Settled, activity.snapshot())
    }
  }

  @Test
  fun `trigger replays on value changes and ignores name changes`() {
    compose.mainClock.autoAdvance = false
    var value by mutableStateOf(0)
    var name by mutableStateOf("home")
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        rememberPrototypeIconFrame(
          PrototypeIconEffect(
            "bounce",
            trigger =
              dev.jasonpearson.automobile.protocol.PrototypeIconEffectTrigger(data = "/revision"),
          ),
          kotlinx.serialization.json.JsonPrimitive(value),
          name,
        )
      }
    }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle {
      assertEquals(PrototypeMotionState.Settled, activity.snapshot())
    }
    change { value = 1 }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle { assertEquals(PrototypeMotionState(1, 0), activity.snapshot()) }
    compose.mainClock.advanceTimeBy(800)
    compose.runOnIdle {
      assertEquals(PrototypeMotionState.Settled, activity.snapshot())
    }
    change { name = "star" }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle { assertEquals(PrototypeMotionState.Settled, activity.snapshot()) }
  }

  @Test
  fun `finite repeats count as loops and finish`() {
    compose.mainClock.autoAdvance = false
    val activity = PrototypeMotionActivity()
    var capture by mutableStateOf(false)
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        rememberPrototypeIconFrame(
          PrototypeIconEffect("pulse", repeat = PrototypeIconEffectRepeat(2)),
          null,
          "home",
          capture,
        )
      }
    }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle { assertEquals(PrototypeMotionState(0, 1), activity.snapshot()) }
    compose.mainClock.advanceTimeBy(1400)
    compose.runOnIdle { assertEquals(PrototypeMotionState.Settled, activity.snapshot()) }
    change { capture = true }
    change { capture = false }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle { assertEquals(PrototypeMotionState.Settled, activity.snapshot()) }
  }

  @Test
  fun `scale follows truthiness on press and release`() {
    compose.mainClock.autoAdvance = false
    var value by mutableStateOf(false)
    var frame = PrototypeIconFrame()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
      ) {
        val current =
          rememberPrototypeIconFrame(
            PrototypeIconEffect(
              "scale",
              trigger =
                dev.jasonpearson.automobile.protocol.PrototypeIconEffectTrigger(key = "flag"),
            ),
            kotlinx.serialization.json.JsonPrimitive(value),
            "home",
          )
        SideEffect { frame = current }
      }
    }
    compose.mainClock.advanceTimeByFrame()
    compose.runOnIdle {
      assertEquals(1f, frame.scale)
    }
    change { value = true }
    compose.mainClock.advanceTimeBy(160)
    compose.runOnIdle { assertTrue(frame.scale > 1f && frame.scale < 1.15f) }
    compose.mainClock.advanceTimeBy(300)
    compose.runOnIdle {
      assertEquals(1.15f, frame.scale)
    }
    change { value = false }
    compose.mainClock.advanceTimeBy(400)
    compose.runOnIdle { assertEquals(1f, frame.scale) }
    assertFalse(prototypeIconTruthy(kotlinx.serialization.json.JsonPrimitive(0.0)))
  }

  @Test
  fun `reduced off and disabled motion keep all effects at rest`() {
    compose.mainClock.autoAdvance = false
    var profile by mutableStateOf(PrototypeMotionProfile.REDUCED)
    var enabled by mutableStateOf(true)
    var type by mutableStateOf("bounce")
    var frame = PrototypeIconFrame()
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides enabled,
        LocalPrototypeMotionProfile provides profile,
        LocalPrototypeMotionActivity provides activity,
      ) {
        val current = rememberPrototypeIconFrame(PrototypeIconEffect(type), null, "home")
        SideEffect { frame = current }
      }
    }
    for (effect in
      listOf(
        "bounce",
        "pulse",
        "scale",
        "variableColor",
        "wiggle",
        "rotate",
        "breathe",
        "replace",
        "drawOn",
      )) {
      for (mode in 0..2) {
        change {
          type = effect
          profile = if (mode == 0) PrototypeMotionProfile.REDUCED else PrototypeMotionProfile.OFF
          enabled = mode != 2
        }
        compose.mainClock.advanceTimeBy(144)
        compose.runOnIdle {
          assertEquals(PrototypeIconFrame(), frame)
          assertEquals(PrototypeMotionState.Settled, activity.snapshot())
        }
      }
    }
  }

  private fun change(action: () -> Unit) {
    compose.runOnUiThread {
      action()
      Snapshot.sendApplyNotifications()
    }
    compose.waitForIdle()
    compose.mainClock.advanceTimeByFrame()
    compose.waitForIdle()
  }
}
