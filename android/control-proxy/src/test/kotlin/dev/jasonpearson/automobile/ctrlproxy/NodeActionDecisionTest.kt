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
      decideNodeAction("focus", isAccessibilityFocused = true, availableActionIds = focusedActions),
    )
  }

  @Test
  fun `focus on an already focused node is already satisfied when the action list is unknown`() {
    assertEquals(
      NodeActionDecision.AlreadySatisfied,
      decideNodeAction("focus", isAccessibilityFocused = true, availableActionIds = null),
    )
  }

  @Test
  fun `clear_focus on an unfocused node is already satisfied even though only focus is advertised`() {
    assertEquals(
      NodeActionDecision.AlreadySatisfied,
      decideNodeAction(
        "clear_focus",
        isAccessibilityFocused = false,
        availableActionIds = unfocusedActions,
      ),
    )
  }

  @Test
  fun `focus on an unfocused node that advertises focus is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS),
      decideNodeAction(
        "focus",
        isAccessibilityFocused = false,
        availableActionIds = unfocusedActions,
      ),
    )
  }

  @Test
  fun `clear_focus on a focused node that advertises clear is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS),
      decideNodeAction(
        "clear_focus",
        isAccessibilityFocused = true,
        availableActionIds = focusedActions,
      ),
    )
  }

  @Test
  fun `focus on an unfocused node that cannot take accessibility focus is refused`() {
    assertEquals(
      NodeActionDecision.Refused("Accessibility action is unavailable: focus"),
      decideNodeAction(
        "focus",
        isAccessibilityFocused = false,
        availableActionIds = listOf(AccessibilityNodeInfo.ACTION_CLICK),
      ),
    )
  }

  @Test
  fun `clear_focus on a focused node that does not advertise clear is refused`() {
    assertEquals(
      NodeActionDecision.Refused("Accessibility action is unavailable: clear_focus"),
      decideNodeAction(
        "clear_focus",
        isAccessibilityFocused = true,
        availableActionIds = listOf(AccessibilityNodeInfo.ACTION_CLICK),
      ),
    )
  }

  @Test
  fun `focus on an unfocused node with an unknown action list is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS),
      decideNodeAction("focus", isAccessibilityFocused = false, availableActionIds = null),
    )
  }

  @Test
  fun `click without ACTION_CLICK is still refused regardless of focus`() {
    for (focused in listOf(true, false)) {
      assertEquals(
        NodeActionDecision.Refused("Accessibility action is unavailable: click"),
        decideNodeAction(
          "click",
          isAccessibilityFocused = focused,
          availableActionIds = focusedActions,
        ),
      )
    }
  }

  @Test
  fun `click with ACTION_CLICK is performed`() {
    assertEquals(
      NodeActionDecision.Perform(AccessibilityNodeInfo.ACTION_CLICK),
      decideNodeAction(
        "click",
        isAccessibilityFocused = false,
        availableActionIds = listOf(AccessibilityNodeInfo.ACTION_CLICK),
      ),
    )
  }

  @Test
  fun `unsupported actions are refused`() {
    assertEquals(
      NodeActionDecision.Refused("Unsupported accessibility action: activate"),
      decideNodeAction("activate", isAccessibilityFocused = true, availableActionIds = null),
    )
  }
}
