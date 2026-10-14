package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeGestureTest {
  @get:Rule val compose = createComposeRule()

  private val tap = listOf<PrototypeAction>(PrototypeEmitAction("tap"))
  private val hold = listOf<PrototypeAction>(PrototypeEmitAction("hold"))
  private val double = listOf<PrototypeAction>(PrototypeEmitAction("double"))
  private val interactions = mutableListOf<PrototypeInteraction>()
  private var doubleTapTimeout = 0L
  private var longPressTimeout = 0L

  private fun render() {
    val spec =
      PrototypeSpec(
        "gestures",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeColumnNode(
            children =
              listOf(
                PrototypeRowNode(
                  testTag = "row",
                  onTap = tap,
                  onLongPress = hold,
                  onDoubleTap = double,
                  children = listOf(PrototypeTextNode(text = "Row")),
                ),
                PrototypeTextNode(testTag = "hold", text = "Hold", onLongPress = hold),
                PrototypeTextNode(testTag = "tap", text = "Tap", onTap = tap),
                PrototypeTextNode(testTag = "double", text = "Double", onDoubleTap = double),
              ),
          ),
      )
    val root = mapPrototypeSpec(spec).root
    compose.setContent {
      doubleTapTimeout = LocalViewConfiguration.current.doubleTapTimeoutMillis
      PrototypeSpecContent(root) { interactions += it }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
  }

  @Test
  fun `long press and double tap dispatch their own lists once`() {
    render()
    compose.onNodeWithTag("row").performTouchInput { longClick() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(hold)), interactions) }
    compose.onNodeWithTag("row").performTouchInput { doubleClick() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle {
      assertEquals(
        listOf(PrototypeInteraction.Tap(hold), PrototypeInteraction.Tap(double)),
        interactions,
      )
    }
  }

  @Test
  fun `gesture-only text handles long press and ignores single tap`() {
    render()
    compose.onNodeWithTag("hold").performTouchInput { click() }
    compose.runOnIdle { assertTrue(interactions.isEmpty()) }
    compose.onNodeWithTag("hold").performTouchInput { longClick() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(hold)), interactions) }
  }

  @Test
  fun `tap-only node fires immediately`() {
    render()
    compose.onNodeWithTag("tap").performTouchInput { click() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
  }

  @Test
  fun `single tap with double tap handler waits for the built-in timeout`() {
    render()
    compose.onNodeWithTag("row").performTouchInput { click() }
    compose.runOnIdle { assertTrue(interactions.isEmpty()) }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
  }

  private fun renderNested(parentDoubleTap: Boolean = false, pressScale: Double? = null) {
    val root =
      mapPrototypeSpec(
          PrototypeSpec(
            "nested",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            root =
              PrototypeRowNode(
                testTag = "parent",
                onTap = tap,
                onDoubleTap = if (parentDoubleTap) tap else null,
                children =
                  listOf(
                    PrototypeTextNode(
                      testTag = "childHold",
                      text = "Hold",
                      onLongPress = hold,
                      style = PrototypeStyle(pressScale = pressScale),
                    ),
                    PrototypeTextNode(
                      testTag = "childDouble",
                      text = "Double",
                      onDoubleTap = double,
                      style = PrototypeStyle(pressScale = pressScale),
                    ),
                    PrototypeTextNode(
                      testTag = "immediate",
                      text = "Tap hold",
                      onTap = tap,
                      onLongPress = hold,
                    ),
                  ),
              ),
          ),
        )
        .root
    compose.setContent {
      doubleTapTimeout = LocalViewConfiguration.current.doubleTapTimeoutMillis
      longPressTimeout = LocalViewConfiguration.current.longPressTimeoutMillis
      PrototypeSpecContent(root) { interactions += it }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
  }

  @Test
  fun `pressScale gesture-only hold child passes single tap to row but owns long press`() {
    renderNested(pressScale = 0.9)
    compose.onNodeWithTag("childHold", useUnmergedTree = true).performTouchInput { click() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
    compose.runOnIdle { interactions.clear() }
    compose.onNodeWithTag("childHold", useUnmergedTree = true).performTouchInput { longClick() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(hold)), interactions) }
  }

  @Test
  fun `pressScale hold child keeps its long press across recomposition while down`() {
    renderNested(pressScale = 0.9)
    val child = compose.onNodeWithTag("childHold", useUnmergedTree = true)
    child.performTouchInput { down(center) }
    // Separate input batches let the pressScale state recompose while the pointer stays down.
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(longPressTimeout + 1)
    child.performTouchInput { up() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(hold)), interactions) }
  }

  @Test
  fun `pressScale gesture-only double child owns double tap and defers ancestor single tap`() {
    renderNested(pressScale = 0.9)
    compose.onNodeWithTag("childDouble", useUnmergedTree = true).performTouchInput { doubleClick() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(double)), interactions) }
    compose.runOnIdle { interactions.clear() }
    val child = compose.onNodeWithTag("childDouble", useUnmergedTree = true)
    child.performTouchInput { down(center) }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    child.performTouchInput { up() }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    compose.runOnIdle { assertTrue(interactions.isEmpty()) }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
  }

  @Test
  fun `standalone double tap node does not capture an unrelated single tap`() {
    render()
    compose.onNodeWithTag("double").performTouchInput { click() }
    compose.onNodeWithTag("tap").performTouchInput { click() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
  }

  @Test
  fun `gesture-only double child suppresses ancestor double-click fallback`() {
    renderNested(parentDoubleTap = true)
    compose.onNodeWithTag("childDouble", useUnmergedTree = true).performTouchInput { doubleClick() }
    compose.mainClock.advanceTimeBy(doubleTapTimeout + 1)
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(double)), interactions) }
  }

  @Test
  fun `gesture-only long press remains an accessibility action`() {
    renderNested()
    compose.onNodeWithTag("childHold", useUnmergedTree = true).performSemanticsAction(
      SemanticsActions.OnLongClick,
    ) {
      assertTrue(it())
    }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(hold)), interactions) }
  }

  @Test
  fun `tap with only long press fires immediately`() {
    renderNested()
    compose.onNodeWithTag("immediate", useUnmergedTree = true).performTouchInput { click() }
    compose.runOnIdle { assertEquals(listOf(PrototypeInteraction.Tap(tap)), interactions) }
  }

  @Test
  fun `repeat binding carries all three lists through every gesture node variant`() {
    val template =
      listOf<PrototypeAction>(
        PrototypeSetStateAction("picked_{item.id}", PrototypeScalar.Text("{index}")),
        PrototypeEmitAction("pick_{item.id}_{index}"),
      )
    val children =
      listOf(
        PrototypeBoxNode(
          children = emptyList(),
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
        PrototypeRowNode(
          children = emptyList(),
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
        PrototypeColumnNode(
          children = emptyList(),
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
        PrototypeTextNode(
          text = "Text",
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
        PrototypeImageNode(
          asset = PrototypeModeValue.Single("hero"),
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
        PrototypeIconNode(
          name = "Home",
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
        PrototypeCardNode(
          children = emptyList(),
          onTap = template,
          onLongPress = template,
          onDoubleTap = template,
        ),
      )
    val root =
      PrototypeColumnNode(
        children = children,
        repeat =
          PrototypeRepeat(items = listOf(mapOf("id" to PrototypeScalar.Text("a"))), `as` = "item"),
      )
    val expected =
      listOf(
        PrototypeSetStateAction("picked_a", PrototypeScalar.Numeric(0.0)),
        PrototypeEmitAction("pick_a_0"),
      )
    val entries = prototypeChildEntries(root, "root")
    assertEquals(7, entries.size)
    for (entry in entries) {
      assertEquals(expected, entry.node.onTap)
      assertEquals(expected, entry.node.onLongPress)
      assertEquals(expected, entry.node.onDoubleTap)
    }
  }
}
