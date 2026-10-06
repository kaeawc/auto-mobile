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
