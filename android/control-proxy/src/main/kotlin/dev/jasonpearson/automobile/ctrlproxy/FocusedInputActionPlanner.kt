package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo

/**
 * What a `request_action` addressed at the input-focused editable node (`focusedInput = true`) may
 * do. The keyboard-open path needs exactly two: `click`, which makes the framework show the IME for
 * the focused field without a touch position, and `set_selection`, which puts the caret back where
 * it was if the click moved it (a Compose text field has no stable selector, so a selector based
 * node action cannot name it).
 */
internal sealed interface FocusedInputActionPlan {
  /** The accessibility action id and, for set_selection, its range. */
  data class Perform(val actionId: Int, val selectionStart: Int?, val selectionEnd: Int?) :
    FocusedInputActionPlan

  data class Rejected(val error: String) : FocusedInputActionPlan
}

internal fun planFocusedInputAction(
  action: String,
  selectionStart: Int?,
  selectionEnd: Int?,
): FocusedInputActionPlan =
  when (action) {
    "click" -> FocusedInputActionPlan.Perform(AccessibilityNodeInfo.ACTION_CLICK, null, null)
    "set_selection" ->
      if (
        selectionStart == null || selectionEnd == null || selectionStart < 0 || selectionEnd < 0
      ) {
        FocusedInputActionPlan.Rejected(
          "set_selection needs non-negative selectionStart and selectionEnd"
        )
      } else {
        FocusedInputActionPlan.Perform(
          AccessibilityNodeInfo.ACTION_SET_SELECTION,
          selectionStart,
          selectionEnd,
        )
      }
    else -> FocusedInputActionPlan.Rejected("Unsupported focused-input action: $action")
  }

/**
 * `null` when the node advertises [actionId] (or the advertised list is unknown), otherwise the
 * failure to report. A node that does not advertise the action is not asked to perform it.
 */
internal fun focusedInputActionAvailability(
  action: String,
  actionId: Int,
  availableActionIds: Collection<Int>?,
): String? =
  if (availableActionIds != null && actionId !in availableActionIds) {
    "Accessibility action is unavailable: $action"
  } else {
    null
  }
