package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeModalExitInputTest {
  @get:Rule val compose = createComposeRule()
  private val condition = PrototypeSheetCondition("open", true)
  private val actions = listOf(PrototypeEmitAction("clicked"))

  @Test
  fun `closing dialog hides semantics and rejects a second button tap`() =
    checkExit(
      PrototypeDialogNode(
        openWhen = condition,
        title = "Dialog",
        confirm = PrototypeDialogButton("Go", onTap = actions),
      ),
      "Go",
    )

  @Test
  fun `closing sheet hides semantics and rejects child and scrim taps`() =
    checkExit(
      PrototypeBottomSheetNode(
        openWhen = condition,
        detents = listOf(PrototypeDetent.Half),
        child = PrototypeButtonNode(label = "Go", onTap = actions),
      ),
      "Go",
    )

  @Test
  fun `closing menu hides semantics and rejects a second entry tap`() =
    checkExit(
      PrototypeMenuNode(
        openWhen = condition,
        items = listOf(PrototypeMenuEntry("Go", onTap = actions)),
      ),
      "Go",
    )

  private fun checkExit(modal: PrototypeNode, target: String) {
    var open by mutableStateOf(true)
    val interactions = mutableListOf<PrototypeInteraction>()
    var underlying = 0
    val spec =
      PrototypeSpec(
        "modal",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeBoxNode(
            onTap = actions,
            children = listOf(PrototypeTextNode(text = "Page"), modal),
          ),
      )
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
      ) {
        PrototypeSpecContent(
          mapPrototypeSpec(spec.copy(state = mapOf("open" to PrototypeScalar.BooleanValue(open))))
            .root,
        ) {
          if (it is PrototypeInteraction.Tap && !open) underlying++
          else {
            interactions += it
            open = false
          }
        }
      }
    }
    compose.waitForIdle()
    val position = compose.onNodeWithText(target).fetchSemanticsNode().boundsInRoot.center
    compose.mainClock.autoAdvance = false
    compose.onRoot().performTouchInput { click(position) }
    compose.runOnUiThread { Snapshot.sendApplyNotifications() }
    compose.mainClock.advanceTimeBy(64)
    compose.onNodeWithText(target).assertDoesNotExist()
    // Retained drawing still has its child in the unmerged composition during the exit.
    compose.onNodeWithText(target, useUnmergedTree = true).assertExists()
    val count = interactions.size
    compose.onRoot().performTouchInput {
      click(position)
      click(Offset(1f, 1f))
    }
    assertEquals(count, interactions.size)
    assertTrue("closed scrim must let the page receive taps", underlying > 0)
    compose.mainClock.advanceTimeBy(400)
    compose.onNodeWithText(target, useUnmergedTree = true).assertDoesNotExist()
  }
}
