package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FocusedInputActionPlannerTest {
  @Test
  fun `click maps to ACTION_CLICK with no range`() {
    assertEquals(
      FocusedInputActionPlan.Perform(AccessibilityNodeInfo.ACTION_CLICK, null, null),
      planFocusedInputAction("click", null, null),
    )
  }

  @Test
  fun `set_selection carries the range to restore`() {
    assertEquals(
      FocusedInputActionPlan.Perform(AccessibilityNodeInfo.ACTION_SET_SELECTION, 0, 3),
      planFocusedInputAction("set_selection", 0, 3),
    )
  }

  @Test
  fun `set_selection without a usable range is rejected`() {
    for ((start, end) in listOf(null to 2, 1 to null, -1 to 2, 1 to -2, null to null)) {
      val plan = planFocusedInputAction("set_selection", start, end)
      assertEquals(
        FocusedInputActionPlan.Rejected(
          "set_selection needs non-negative selectionStart and selectionEnd"
        ),
        plan,
      )
    }
  }

  @Test
  fun `actions other than click and set_selection are rejected`() {
    assertEquals(
      FocusedInputActionPlan.Rejected("Unsupported focused-input action: long_click"),
      planFocusedInputAction("long_click", null, null),
    )
  }

  @Test
  fun `a focused field in the observed package is in scope`() {
    assertNull(focusedInputScopeFailure("com.app", "com.app"))
  }

  @Test
  fun `a caller that names no package is not scoped`() {
    assertNull(focusedInputScopeFailure(null, "com.other"))
    assertNull(focusedInputScopeFailure("", "com.other"))
  }

  @Test
  fun `a focused field in another package is refused with the focus_moved code`() {
    val failure = focusedInputScopeFailure("com.app", "com.other")

    assertEquals(FOCUS_MOVED_ERROR_CODE, failure?.errorCode)
    assertEquals(
      "Focus moved: the input-focused field belongs to com.other, not com.app, so no action was performed",
      failure?.error,
    )
  }

  @Test
  fun `a focused field with no package is refused rather than assumed to match`() {
    assertEquals(FOCUS_MOVED_ERROR_CODE, focusedInputScopeFailure("com.app", null)?.errorCode)
  }

  @Test
  fun `a node that does not advertise the action is not asked to perform it`() {
    assertEquals(
      "Accessibility action is unavailable: click",
      focusedInputActionAvailability(
        "click",
        AccessibilityNodeInfo.ACTION_CLICK,
        listOf(AccessibilityNodeInfo.ACTION_FOCUS),
      ),
    )
    assertNull(
      focusedInputActionAvailability(
        "click",
        AccessibilityNodeInfo.ACTION_CLICK,
        listOf(AccessibilityNodeInfo.ACTION_CLICK),
      )
    )
    assertNull(focusedInputActionAvailability("click", AccessibilityNodeInfo.ACTION_CLICK, null))
  }
}
