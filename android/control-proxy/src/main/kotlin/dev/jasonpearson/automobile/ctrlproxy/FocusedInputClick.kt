package dev.jasonpearson.automobile.ctrlproxy

internal data class FocusedInputClickOutcome(val success: Boolean, val error: String?)

/** Click only the input-focused editable node and release the acquired node on every outcome. */
internal fun <T> clickFocusedInput(
  findFocusedInput: () -> T?,
  click: (T) -> Boolean,
  recycle: (T) -> Unit,
  settleAfterClick: () -> Unit = {},
): FocusedInputClickOutcome {
  val node =
    findFocusedInput() ?: return FocusedInputClickOutcome(false, "No focused editable input")
  val outcome =
    try {
      val success = click(node)
      FocusedInputClickOutcome(success, if (success) null else "Focused input click returned false")
    } finally {
      recycle(node)
    }
  if (outcome.success) settleAfterClick()
  return outcome
}
