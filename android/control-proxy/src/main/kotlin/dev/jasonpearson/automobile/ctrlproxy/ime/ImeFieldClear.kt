package dev.jasonpearson.automobile.ctrlproxy.ime

private const val CLEAR_READ_WINDOW_CHARS = 100_000
private const val MAX_CLEAR_DELETIONS = 16

/**
 * The editor's current selection. The surrounding-text reads exclude the selected range, so a clear
 * after select-all would see an empty field unless it also reads and replaces the selection
 * (#18861).
 */
internal class ImeSelection(
  val read: () -> CharSequence?,
  val delete: () -> Boolean,
) {
  companion object {
    val NONE = ImeSelection(read = { null }, delete = { true })
  }
}

private class FieldLengths(val before: Int, val after: Int, val selected: Int) {
  val isEmpty: Boolean
    get() = before == 0 && after == 0 && selected == 0
}

private fun readLengths(
  readBefore: (Int) -> CharSequence?,
  readAfter: (Int) -> CharSequence?,
  selection: ImeSelection,
): FieldLengths =
  FieldLengths(
    before = readBefore(CLEAR_READ_WINDOW_CHARS)?.length ?: 0,
    after = readAfter(CLEAR_READ_WINDOW_CHARS)?.length ?: 0,
    selected = selection.read()?.length ?: 0,
  )

/**
 * Clear through the editor connection before realistic typing so a rich-text composer retains its
 * response to typed input, including autocomplete, markdown/autoformat shortcuts, and mentions.
 */
internal fun clearImeField(
  finishComposing: () -> Boolean,
  readBefore: (Int) -> CharSequence?,
  readAfter: (Int) -> CharSequence?,
  selection: ImeSelection = ImeSelection.NONE,
  deleteSurrounding: (Int, Int) -> Boolean,
): ImeCommitResult {
  var deletionAttempted = false
  val success = runCatching {
    // False can mean there was no composing span; still attempt the surrounding-text deletion.
    finishComposing()
    repeat(MAX_CLEAR_DELETIONS) {
      val lengths = readLengths(readBefore, readAfter, selection)
      if (lengths.isEmpty) return@runCatching true
      deletionAttempted = true
      // Replace the selection with nothing first, then delete whatever surrounds the caret.
      val selectionCleared = lengths.selected == 0 || selection.delete()
      val surroundingCleared =
        selectionCleared &&
          (lengths.before == 0 && lengths.after == 0 ||
            deleteSurrounding(lengths.before, lengths.after))
      if (!surroundingCleared) return@runCatching false
    }
    // Confirm the last deletion, but never keep writing to an editor that does not converge.
    readLengths(readBefore, readAfter, selection).isEmpty
  }
    .getOrDefault(false)
  return ImeCommitResult(
    success = success,
    error = if (success) null else "IME clear failed",
    partialApplication = !success && deletionAttempted,
  )
}
