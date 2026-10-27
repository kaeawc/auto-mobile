package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeDeadTapGestureTest {
  @get:Rule val compose = createComposeRule()
  private val interactions = mutableListOf<PrototypeInteraction>()
  private val action = listOf<PrototypeAction>(PrototypeEmitAction("handled"))
  private var density = 1f
  private var doubleTapTimeout = 0L
  private val area =
    PrototypeStyle(
      width = PrototypeDimension.Dp(200.0),
      height = PrototypeDimension.Dp(80.0),
    )

  private fun render(
    enabled: Boolean = true,
    root: PrototypeNode =
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeBoxNode(testTag = "dead", style = area, children = emptyList()),
            PrototypeTextNode(testTag = "tap", text = "Tap", onTap = action),
            PrototypeTextFieldNode(testTag = "input", stateKey = "text"),
            PrototypeTextNode(testTag = "hold", text = "Hold", onLongPress = action),
            PrototypeTextNode(testTag = "double", text = "Double", onDoubleTap = action),
          ),
      ),
  ) {
    val spec =
      PrototypeSpec(
        "dead",
        PrototypeWindow(PrototypeFullscreenPlacement(), deadTaps = enabled),
        state =
          mapOf("text" to PrototypeScalar.Text(""), "open" to PrototypeScalar.BooleanValue(true)),
        root = root,
      )
    compose.setContent {
      density = LocalDensity.current.density
      doubleTapTimeout = LocalViewConfiguration.current.doubleTapTimeoutMillis
      PrototypeSpecContent(mapPrototypeSpec(spec).root, deadTaps = enabled) { interactions += it }
    }
    compose.waitForIdle()
  }

  @Test
  fun `dead area emits window local dp but action and text field taps do not`() {
    render()
    compose.onNodeWithTag("dead").performTouchInput { click(Offset(20f, 30f)) }
    compose.runOnIdle {
      assertEquals(listOf(PrototypeInteraction.DeadTap(20f / density, 30f / density)), interactions)
      interactions.clear()
    }
    compose.onNodeWithTag("tap").performTouchInput { click() }
    compose.onNodeWithTag("input").performTouchInput { click() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(action)), interactions) }
  }

  @Test
  fun `opt out never installs dead tap reporting`() {
    render(enabled = false)
    compose.onNodeWithTag("dead").performTouchInput { click() }
    compose.runOnIdle { assertTrue(interactions.isEmpty()) }
  }

  @Test
  fun `drag and multi pointer gestures never emit dead taps`() {
    render()
    compose.onNodeWithTag("dead").performTouchInput {
      swipe(Offset(10f, 10f), Offset(150f, 10f), durationMillis = 64L)
      down(0, Offset(10f, 10f))
      down(1, Offset(30f, 10f))
      up(1)
      up(0)
      // Crossing slop and returning to the original point is still a drag.
      down(Offset(10f, 10f))
      moveTo(Offset(150f, 10f))
      moveTo(Offset(10f, 10f))
      up()
    }
    compose.runOnIdle { assertTrue(interactions.isEmpty()) }
  }

  @Test
  fun `gesture only handlers own their taps without breaking long press or double tap`() {
    render()
    compose.onNodeWithTag("hold").performTouchInput { click() }
    compose.onNodeWithTag("double").performTouchInput { click() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertTrue(interactions.isEmpty()) }
    compose.onNodeWithTag("hold").performTouchInput { longClick() }
    compose.onNodeWithTag("double").performTouchInput { doubleClick() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle {
      assertEquals(
        listOf(PrototypeInteraction.Tap(action), PrototypeInteraction.Tap(action)),
        interactions,
      )
    }
  }

  @Test
  fun `dismissing dialog scrim is handled`() {
    val open = PrototypeSheetCondition("open", true)
    render(
      root =
        modalRoot(
          PrototypeDialogNode(
            openWhen = open,
            title = "Dialog",
            confirm = PrototypeDialogButton("OK"),
          ),
        ),
    )
    compose.onRoot().performTouchInput { click(Offset(2f, 2f)) }
    compose.runOnIdle {
      assertEquals(listOf(PrototypeInteraction.SheetDismiss(open)), interactions)
    }
  }

  @Test
  fun `dismissing sheet scrim is handled`() {
    val open = PrototypeSheetCondition("open", true)
    render(
      root =
        modalRoot(
          PrototypeBottomSheetNode(
            openWhen = open,
            detents = listOf(PrototypeDetent.Dp(100.0)),
            child = PrototypeTextNode(text = "Sheet"),
          ),
        ),
    )
    compose.onRoot().performTouchInput { click(Offset(2f, 2f)) }
    compose.runOnIdle {
      assertEquals(listOf(PrototypeInteraction.SheetDismiss(open)), interactions)
    }
  }

  private fun modalRoot(modal: PrototypeNode) =
    PrototypeBoxNode(
      style =
        PrototypeStyle(
          width = PrototypeDimension.Dp(320.0),
          height = PrototypeDimension.Dp(400.0),
        ),
      children = listOf(modal),
    )

  @Test
  fun `passive text and spacer are dead areas`() {
    render(
      root =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeTextNode(testTag = "plain", text = "Plain"),
              PrototypeSpacerNode(testTag = "space", style = area),
            ),
        ),
    )
    compose.onNodeWithTag("plain").performTouchInput { click() }
    compose.onNodeWithTag("space").performTouchInput { click() }
    compose.runOnIdle {
      assertEquals(2, interactions.size)
      assertTrue(interactions.all { it is PrototypeInteraction.DeadTap })
    }
  }
}
