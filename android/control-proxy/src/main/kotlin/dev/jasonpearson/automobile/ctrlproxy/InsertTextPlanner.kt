package dev.jasonpearson.automobile.ctrlproxy

internal data class InsertTextPlan(
  val updatedText: String,
  val caret: Int,
  val usedFallbackCaret: Boolean,
  val usedRememberedCaret: Boolean = false,
)

internal data class RememberedCaret(
  val text: String,
  val caret: Int,
  val reportedStart: Int,
  val reportedEnd: Int,
)

/** Plans a text insertion from the selection reported by an editable accessibility node. */
internal fun planInsertText(
  currentText: String?,
  isShowingHintText: Boolean,
  selectionStart: Int,
  selectionEnd: Int,
  textToInsert: String,
  remembered: RememberedCaret? = null,
): InsertTextPlan {
  val text = if (isShowingHintText) "" else currentText.orEmpty()
  if (
    remembered != null &&
      remembered.text == text &&
      remembered.reportedStart == selectionStart &&
      remembered.reportedEnd == selectionEnd &&
      remembered.caret in 0..text.length
  ) {
    return InsertTextPlan(
      text.substring(0, remembered.caret) + textToInsert + text.substring(remembered.caret),
      remembered.caret + textToInsert.length,
      false,
      true,
    )
  }
  val hasValidSelection = selectionStart in 0..text.length && selectionEnd in 0..text.length
  val insertionIndex = if (hasValidSelection) minOf(selectionStart, selectionEnd) else text.length
  val replacementEnd = if (hasValidSelection) maxOf(selectionStart, selectionEnd) else text.length

  return InsertTextPlan(
    updatedText = text.substring(0, insertionIndex) + textToInsert + text.substring(replacementEnd),
    caret = insertionIndex + textToInsert.length,
    usedFallbackCaret = !hasValidSelection,
  )
}

internal data class InsertTextOutcome(
  val success: Boolean,
  val error: String?,
  val warning: String?,
  val caretPlaced: Boolean?,
  val partialApplication: Boolean,
)

internal fun insertTextSelectionSucceeded(
  setTextSucceeded: Boolean,
  selectionAttempted: Boolean,
  selectionReturned: Boolean,
  plan: InsertTextPlan,
  observed: InsertTextSnapshot?,
): Boolean =
  setTextSucceeded &&
    ((selectionAttempted && selectionReturned) ||
      observed != null &&
        // A rejected action needs matching text; preserve the no-action offset-only rule.
        (!selectionAttempted || observed.text == plan.updatedText) &&
        observed.selectionStart == plan.caret &&
        observed.selectionEnd == plan.caret)

internal fun insertTextOutcome(
  setTextSucceeded: Boolean,
  selectionAttempted: Boolean,
  selectionSucceeded: Boolean,
  extraWarning: String?,
  acceptsCaretNotPlaced: Boolean = false,
): InsertTextOutcome {
  if (!setTextSucceeded) {
    return InsertTextOutcome(false, "ACTION_SET_TEXT returned false", extraWarning, null, false)
  }
  if (selectionSucceeded) {
    return InsertTextOutcome(true, null, extraWarning, null, false)
  }
  if (!acceptsCaretNotPlaced) {
    return InsertTextOutcome(
      false,
      "Text was inserted, but ACTION_SET_SELECTION returned false; do not retry",
      extraWarning,
      null,
      true,
    )
  }
  val warning =
    "Text was inserted, but the caret could not be placed after it " +
      (if (selectionAttempted) "(ACTION_SET_SELECTION returned false)"
      else "(selection placement was not attempted)") +
      "; the caret position is unknown, so insert any " +
      "further text with request_insert_text rather than key events"
  return InsertTextOutcome(
    true,
    null,
    listOfNotNull(warning, extraWarning).joinToString(" "),
    false,
    false,
  )
}

internal fun nextRememberedCaret(
  outcome: InsertTextOutcome,
  plan: InsertTextPlan,
  reportedStart: Int,
  reportedEnd: Int,
): RememberedCaret? =
  if (outcome.success && outcome.caretPlaced == false)
    RememberedCaret(plan.updatedText, plan.caret, reportedStart, reportedEnd)
  else null
