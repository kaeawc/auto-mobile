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

/** `action_result` error code for a focused-input action whose field is in another package. */
internal const val FOCUS_MOVED_ERROR_CODE = "focus_moved"

/** A failed focused-input action: the message, plus a machine-readable code when one applies. */
internal data class FocusedInputFailure(val error: String, val errorCode: String? = null)

/**
 * Scopes a focused-input action to the package the caller observed. The runner resolves "the
 * input-focused node" at execution time, so without this a click or caret restore lands in
 * whichever field holds focus by then (a dialog or another app). `null` when the caller named no
 * package (an older host) or the focused field belongs to it.
 */
internal fun focusedInputScopeFailure(
  expectedPackage: String?,
  actualPackage: String?,
): FocusedInputFailure? =
  if (expectedPackage.isNullOrEmpty() || expectedPackage == actualPackage) {
    null
  } else {
    FocusedInputFailure(
      "Focus moved: the input-focused field belongs to ${actualPackage ?: "an unknown package"}, " +
        "not $expectedPackage, so no action was performed",
      FOCUS_MOVED_ERROR_CODE,
    )
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
