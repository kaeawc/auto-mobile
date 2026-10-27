package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PrototypeDrawerSemanticsTest {
  @get:Rule val compose = createComposeRule()
  private val interactions = mutableListOf<PrototypeInteraction>()
  private val condition = PrototypeSheetCondition("open", true)
  private val opened = mutableStateOf(true)
  private val activity = PrototypeMotionActivity()

  private fun show(
    edge: String = "start",
    rtl: Boolean = false,
    swipe: Boolean = true,
    motion: Boolean = false,
    reduced: Boolean = false,
  ) {
    Settings.Global.putFloat(
      RuntimeEnvironment.getApplication().contentResolver,
      Settings.Global.ANIMATOR_DURATION_SCALE,
      1f,
    )
    compose.setContent {
      val spec =
        PrototypeSpec(
          "drawer",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          mapOf("open" to PrototypeScalar.BooleanValue(opened.value)),
          PrototypeColumnNode(
            children =
              listOf(
                PrototypeTextNode(testTag = "page", text = "Page"),
                PrototypeDrawerNode(
                  testTag = "drawer",
                  edge = edge,
                  openWhen = condition,
                  dismissOnSwipe = swipe,
                  child = PrototypeTextNode(testTag = "body", text = "Navigation"),
                ),
              ),
          ),
        )
      CompositionLocalProvider(
        LocalPrototypeFillsWindow provides true,
        LocalPrototypeMotion provides motion,
        LocalPrototypeMotionProfile provides
          (if (reduced) PrototypeMotionProfile.REDUCED else PrototypeMotionProfile.FULL),
        LocalPrototypeMotionActivity provides activity,
        LocalLayoutDirection provides if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr,
      ) {
        Box(Modifier.fillMaxSize()) {
          PrototypeSpecContent(mapPrototypeSpec(spec).root) { interactions += it }
        }
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun pageHiddenAndScrimDismisses() {
    show()
    compose.onNodeWithTag("page").assertDoesNotExist()
    compose.onNodeWithTag("body", useUnmergedTree = true).assertTextEquals("Navigation")
    // The scrim spans the window; its center is covered by the start drawer on narrow screens.
    compose.onNodeWithTag("drawer.close").performTouchInput { click(Offset(width - 1f, center.y)) }
    assertEquals(listOf(PrototypeInteraction.SheetDismiss(condition)), interactions)
  }

  @Test
  fun startPanelIsOnLeft() {
    show()
    assertEquals(0f, compose.onNodeWithTag("drawer").fetchSemanticsNode().boundsInRoot.left)
  }

  @Test
  fun endPanelIsOnRight() {
    show(edge = "end")
    assertTrue(compose.onNodeWithTag("drawer").fetchSemanticsNode().boundsInRoot.left > 0f)
  }

  @Test
  fun rtlStartPanelIsOnRight() {
    show(rtl = true)
    assertTrue(compose.onNodeWithTag("drawer").fetchSemanticsNode().boundsInRoot.left > 0f)
  }

  @Test
  fun rtlEndPanelIsOnLeft() {
    show(edge = "end", rtl = true)
    assertEquals(0f, compose.onNodeWithTag("drawer").fetchSemanticsNode().boundsInRoot.left)
  }

  @Test
  fun swipeTowardEdgeDismisses() {
    show()
    compose.onNodeWithTag("drawer").performTouchInput { swipeLeft() }
    assertEquals(listOf(PrototypeInteraction.SheetDismiss(condition)), interactions)
  }

  @Test
  fun disabledSwipeDoesNotDismiss() {
    show(swipe = false)
    compose.onNodeWithTag("drawer").performTouchInput { swipeLeft() }
    assertTrue(interactions.isEmpty())
  }

  @Test
  fun motionNoneClosesImmediately() {
    show()
    compose.runOnIdle { opened.value = false }
    compose.onNodeWithTag("drawer").assertDoesNotExist()
    compose.onNodeWithTag("page").assertExists()
    assertEquals(PrototypeMotionState.Settled, activity.snapshot())
  }

  @Test
  fun slideReportsMotionAndRetainsClosingPanel() {
    show(motion = true)
    compose.runOnIdle { assertEquals(PrototypeMotionState.Settled, activity.snapshot()) }
    compose.mainClock.autoAdvance = false
    changeOpenAndAwaitMotion(false)
    compose.onNodeWithTag("drawer").assertExists()
    compose.onNodeWithTag("page").assertDoesNotExist()
    compose.runOnIdle { assertTrue(activity.snapshot().active > 0) }
    compose.mainClock.advanceTimeBy(100)
    compose.runOnIdle { assertTrue(activity.snapshot().active > 0) }
    compose.mainClock.advanceTimeBy(400)
    compose.onNodeWithTag("drawer").assertDoesNotExist()
    compose.onNodeWithTag("page").assertExists()
    compose.runOnIdle { assertEquals(PrototypeMotionState.Settled, activity.snapshot()) }
  }

  @Test
  fun slideReportsMotionWhileOpening() {
    opened.value = false
    show(motion = true)
    compose.mainClock.autoAdvance = false
    changeOpenAndAwaitMotion(true)
    compose.onNodeWithTag("drawer").assertExists()
    compose.mainClock.advanceTimeBy(100)
    compose.runOnIdle { assertTrue(activity.snapshot().active > 0) }
    compose.mainClock.advanceTimeBy(400)
    compose.onNodeWithTag("drawer").assertExists()
    compose.onNodeWithTag("page").assertDoesNotExist()
    compose.runOnIdle { assertEquals(PrototypeMotionState.Settled, activity.snapshot()) }
  }

  private fun changeOpenAndAwaitMotion(open: Boolean) {
    compose.runOnIdle { opened.value = open }
    Snapshot.sendApplyNotifications()
    // Composition, transition startup and snapshotFlow reporting need separate scheduling turns.
    // Drain each frame's work instead of assuming the report arrives on a fixed frame number.
    repeat(8) {
      compose.mainClock.advanceTimeByFrame()
      if (compose.runOnIdle { activity.snapshot().active > 0 }) return
    }
    fail("Drawer motion was not reported within eight frames")
  }

  @Test
  fun reducedMotionKeepsPanelAtItsEdge() {
    show(motion = true, reduced = true)
    compose.mainClock.autoAdvance = false
    compose.runOnIdle { opened.value = false }
    compose.mainClock.advanceTimeBy(150)
    assertEquals(0f, compose.onNodeWithTag("drawer").fetchSemanticsNode().boundsInRoot.left)
    compose.mainClock.advanceTimeBy(400)
    compose.onNodeWithTag("drawer").assertDoesNotExist()
  }
}
