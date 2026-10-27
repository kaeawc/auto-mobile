package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeWindowMotionTest {
  @get:Rule val compose = createComposeRule()

  private fun change(block: () -> Unit) {
    compose.runOnUiThread {
      block()
      Snapshot.sendApplyNotifications()
    }
  }

  @Test
  fun `modal exit stays composed reports motion and reopening cancels exit`() {
    val activity = PrototypeMotionActivity()
    var open by mutableStateOf(true)
    val spec =
      PrototypeSpec(
        "modal",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeDialogNode(
            id = "dialog",
            openWhen = PrototypeSheetCondition("open", true),
            title = "Dialog",
            confirm = PrototypeDialogButton("OK"),
          ),
      )
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        PrototypeSpecContent(
          mapPrototypeSpec(spec.copy(state = mapOf("open" to PrototypeScalar.BooleanValue(open))))
            .root,
        )
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    change { open = false }
    compose.mainClock.advanceTimeBy(100)
    compose.onNodeWithText("OK").assertDoesNotExist()
    compose.onNodeWithText("OK", useUnmergedTree = true).assertExists()
    compose.waitForIdle()
    assertTrue(activity.snapshot().active > 0)
    change { open = true }
    compose.mainClock.advanceTimeBy(400)
    compose.onNodeWithText("OK").assertExists()
    change { open = false }
    compose.mainClock.advanceTimeBy(400)
    compose.onNodeWithText("OK").assertDoesNotExist()
    assertEquals(0, activity.snapshot().active)
  }

  @Test
  fun `sheet snackbar and menu retain their contents through exit`() {
    assertSurfaceExits(
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeBottomSheetNode(
              openWhen = PrototypeSheetCondition("open", true),
              detents = listOf(PrototypeDetent.Half),
              child = PrototypeTextNode(text = "Sheet"),
            ),
            PrototypeSnackbarNode(openWhen = PrototypeSheetCondition("open", true), text = "Snack"),
            PrototypeMenuNode(
              openWhen = PrototypeSheetCondition("open", true),
              items = listOf(PrototypeMenuEntry("Menu")),
            ),
          ),
      ),
    )
  }

  private fun assertSurfaceExits(root: PrototypeNode) {
    var open by mutableStateOf(true)
    val spec = PrototypeSpec("modal", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
      ) {
        PrototypeSpecContent(
          mapPrototypeSpec(spec.copy(state = mapOf("open" to PrototypeScalar.BooleanValue(open))))
            .root,
        )
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    change { open = false }
    compose.mainClock.advanceTimeBy(100)
    for (text in listOf("Sheet", "Snack", "Menu")) compose
      .onNodeWithText(text, useUnmergedTree = true)
      .assertExists()
    compose.mainClock.advanceTimeBy(400)
    for (text in listOf("Sheet", "Snack", "Menu")) compose
      .onNodeWithText(text, useUnmergedTree = true)
      .assertDoesNotExist()
  }

  @Test
  fun `window enter and exit report until their tween settles`() {
    val activity = PrototypeMotionActivity()
    var visible by mutableStateOf(true)
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides true) {
        PrototypeWindowMotion(
          visible,
          PrototypeWindowMotionSpec("scale", "floating", motion = "standard"),
          activity,
        ) {
          Box(Modifier.size(100.dp).testTag("window"))
        }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    change { visible = false }
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    assertTrue(activity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(400)
    assertEquals(0, activity.snapshot().active)
  }

  @Test
  fun `detent springs report motion while reduced detents snap`() {
    var target by mutableFloatStateOf(100f)
    var profile by mutableStateOf(PrototypeMotionProfile.FULL)
    var height = 0f
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides profile,
        LocalPrototypeMotionActivity provides activity,
      ) {
        height = prototypeSettledSheetHeight(target, false)
      }
    }
    compose.mainClock.autoAdvance = false
    change { target = 300f }
    compose.mainClock.advanceTimeBy(100)
    compose.waitForIdle()
    assertTrue("height=$height", height > 100f && height < 300f)
    assertTrue(activity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(1000)
    compose.waitForIdle()
    assertEquals(300f, height, 0.01f)
    change {
      profile = PrototypeMotionProfile.REDUCED
      target = 100f
    }
    compose.mainClock.advanceTimeByFrame()
    compose.waitForIdle()
    assertEquals(100f, height, 0f)
    assertEquals(0, activity.snapshot().active)
  }
}
