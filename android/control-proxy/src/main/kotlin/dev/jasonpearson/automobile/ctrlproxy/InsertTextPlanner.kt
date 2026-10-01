package dev.jasonpearson.automobile.ctrlproxy

internal data class InsertTextPlan(
  val updatedText: String,
  val caret: Int,
  val usedFallbackCaret: Boolean,
)

/** Plans a text insertion from the selection reported by an editable accessibility node. */
internal fun planInsertText(
  currentText: String?,
  isShowingHintText: Boolean,
  selectionStart: Int,
  selectionEnd: Int,
  textToInsert: String,
): InsertTextPlan {
  val text = if (isShowingHintText) "" else currentText.orEmpty()
  val hasValidSelection = selectionStart in 0..text.length && selectionEnd in 0..text.length
  val insertionIndex = if (hasValidSelection) minOf(selectionStart, selectionEnd) else text.length
  val replacementEnd = if (hasValidSelection) maxOf(selectionStart, selectionEnd) else text.length

  return InsertTextPlan(
    updatedText = text.substring(0, insertionIndex) + textToInsert + text.substring(replacementEnd),
    caret = insertionIndex + textToInsert.length,
    usedFallbackCaret = !hasValidSelection,
  )
}
