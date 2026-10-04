package dev.jasonpearson.automobile.ctrlproxy

internal data class SelectAllPlan(val textLength: Int, val shouldPerformAction: Boolean)

/** Plans selection of all actual text, excluding a displayed hint. */
internal fun planSelectAll(
  textLength: Int,
  isShowingHintText: Boolean,
  selectionStart: Int,
  selectionEnd: Int,
): SelectAllPlan {
  val actualTextLength = if (isShowingHintText) 0 else textLength
  val alreadySelected = selectionStart == 0 && selectionEnd == actualTextLength
  return SelectAllPlan(actualTextLength, actualTextLength > 0 && !alreadySelected)
}

internal data class SelectAllOutcome(val success: Boolean, val error: String?)

/**
 * A false action result is accepted only when a refreshed selection confirms the requested range.
 */
internal fun selectAllOutcome(
  textLength: Int,
  actionSucceeded: Boolean,
  selectionRefreshed: Boolean,
  selectionStart: Int,
  selectionEnd: Int,
): SelectAllOutcome {
  val success =
    actionSucceeded || (selectionRefreshed && selectionStart == 0 && selectionEnd == textLength)
  return SelectAllOutcome(success, if (success) null else "performAction returned false")
}
