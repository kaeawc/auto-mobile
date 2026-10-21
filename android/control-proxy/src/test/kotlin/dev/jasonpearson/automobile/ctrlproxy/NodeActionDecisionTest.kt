package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/** Issue #10148: accessibility focus is state, so repeating it must not be refused. */
class NodeActionDecisionTest {
  private val unfocusedActions = listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
  private val focusedActions = listOf(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS)

  @Test
  fun `focus on an already focused node is already satisfied even though only clear is advertised`() {
    assertEquals(
      NodeActionDecision.AlreadySatisfied,
      decideNodeAction("focus", NodeActionState(true, focusedActions)),
    )
  }

  @Test
  fun `focus on an already focused node is already satisfied when the action list is unknown`() {
    assertEquals(
      NodeActionDecision.AlreadySatisfied,
      decideNodeAction("focus", NodeActionState(true, null)),
    )
  }

  @Test
  fun `clear_focus on an unfocused node is already satisfied even though only focus is advertised`() {
    assertEquals(
      NodeActionDecision.AlreadySatisfied,
      decideNodeAction("clear_focus", NodeActionState(false, unfocusedActions)),
    )
  }

  @Test
  fun `focus on an unfocused node that advertises focus is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS),
      decideNodeAction("focus", NodeActionState(false, unfocusedActions)),
    )
  }

  @Test
  fun `clear_focus on a focused node that advertises clear is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS),
      decideNodeAction("clear_focus", NodeActionState(true, focusedActions)),
    )
  }

  @Test
  fun `focus on an unfocused node that cannot take accessibility focus is refused`() {
    assertEquals(
      NodeActionDecision.Refused("Accessibility action is unavailable: focus (available: click)"),
      decideNodeAction(
        "focus",
        NodeActionState(false, listOf(AccessibilityNodeInfo.ACTION_CLICK)),
      ),
    )
  }

  @Test
  fun `clear_focus on a focused node that does not advertise clear is refused`() {
    assertEquals(
      NodeActionDecision.Refused(
        "Accessibility action is unavailable: clear_focus (available: click)",
      ),
      decideNodeAction(
        "clear_focus",
        NodeActionState(true, listOf(AccessibilityNodeInfo.ACTION_CLICK)),
      ),
    )
  }

  @Test
  fun `focus on an unfocused node with an unknown action list is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS),
      decideNodeAction("focus", NodeActionState(false, null)),
    )
  }

  @Test
  fun `click without ACTION_CLICK is still refused regardless of focus`() {
    for (focused in listOf(true, false)) {
      assertEquals(
        NodeActionDecision.Refused(
          "Accessibility action is unavailable: click (available: clear_focus)",
        ),
        decideNodeAction("click", NodeActionState(focused, focusedActions)),
      )
    }
  }

  @Test
  fun `click with ACTION_CLICK is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_CLICK),
      decideNodeAction(
        "click",
        NodeActionState(false, listOf(AccessibilityNodeInfo.ACTION_CLICK)),
      ),
    )
  }

  @Test
  fun `unsupported actions are refused`() {
    assertEquals(
      NodeActionDecision.Refused("Unsupported accessibility action: activate"),
      decideNodeAction("activate", NodeActionState(true, null)),
    )
  }

  @Test
  fun `semantic actions map to their platform ids`() {
    val expand = listOf(AccessibilityNodeInfo.ACTION_EXPAND, AccessibilityNodeInfo.ACTION_COLLAPSE)
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_EXPAND),
      decideNodeAction("expand", NodeActionState(false, expand), sdkInt = 34),
    )
    assertEquals(
      NodeActionDecision.Perform(android.R.id.accessibilityActionScrollLeft),
      decideNodeAction(
        "scroll_left",
        NodeActionState(false, listOf(android.R.id.accessibilityActionScrollLeft)),
        sdkInt = 34,
      ),
    )
  }

  @Test
  fun `api gated actions are refused below their api level`() {
    val pageUp = listOf(android.R.id.accessibilityActionPageUp)
    assertEquals(
      NodeActionDecision.Refused(
        "Accessibility action page_up needs Android API 29 (device is API 28)",
      ),
      decideNodeAction("page_up", NodeActionState(false, pageUp), sdkInt = 28),
    )
    assertEquals(
      NodeActionDecision.Perform(android.R.id.accessibilityActionPageUp),
      decideNodeAction("page_up", NodeActionState(false, pageUp), sdkInt = 29),
    )
    assertEquals(null, nodeActionId("press_and_hold", sdkInt = 29))
    assertEquals(android.R.id.accessibilityActionPressAndHold, nodeActionId("press_and_hold", 30))
  }

  @Test
  fun `set_progress carries the progress value and requires one`() {
    val slider = listOf(android.R.id.accessibilityActionSetProgress)
    assertEquals(
      NodeActionDecision.Perform(android.R.id.accessibilityActionSetProgress, progress = 0.5f),
      decideNodeAction(
        "set_progress",
        NodeActionState(false, slider),
        sdkInt = 34,
        arguments = NodeActionArguments(progress = 0.5f),
      ),
    )
    assertEquals(
      NodeActionDecision.Refused("set_progress requires a finite progress value"),
      decideNodeAction("set_progress", NodeActionState(false, slider), sdkInt = 34),
    )
  }

  @Test
  fun `custom actions match the app-defined label exactly and then ignoring case`() {
    val archiveId = 0x7f0a0042
    val labels = mapOf(archiveId to "Archive", AccessibilityNodeInfo.ACTION_CLICK to "Open")
    val ids = listOf(AccessibilityNodeInfo.ACTION_CLICK, archiveId)
    assertEquals(
      NodeActionDecision.Perform(archiveId),
      decideNodeAction(
        "custom",
        NodeActionState(false, ids, labels),
        sdkInt = 34,
        arguments = NodeActionArguments(customAction = "archive"),
      ),
    )
    assertEquals(
      NodeActionDecision.Refused(
        "Custom accessibility action is unavailable: Delete (available: click, custom:Archive)",
      ),
      decideNodeAction(
        "custom",
        NodeActionState(false, ids, labels),
        sdkInt = 34,
        arguments = NodeActionArguments(customAction = "Delete"),
      ),
    )
    assertEquals(
      NodeActionDecision.Refused("custom requires the label of the action to perform"),
      decideNodeAction("custom", NodeActionState(false, ids, labels), sdkInt = 34),
    )
  }

  @Test
  fun `a refusal lists the actions the node offers`() {
    val ids = listOf(AccessibilityNodeInfo.ACTION_CLICK, AccessibilityNodeInfo.ACTION_EXPAND, 99)
    assertEquals(
      NodeActionDecision.Refused(
        "Accessibility action is unavailable: dismiss (available: click, expand, custom:Star)",
      ),
      decideNodeAction("dismiss", NodeActionState(false, ids, mapOf(99 to "Star")), sdkInt = 34),
    )
  }
}
