package dev.jasonpearson.automobile.ctrlproxy.ime

private const val CLEAR_READ_WINDOW_CHARS = 100_000
private const val MAX_CLEAR_DELETIONS = 16

/**
 * Clear through the editor connection before realistic typing so a rich-text composer retains its
 * response to typed input, including autocomplete, markdown/autoformat shortcuts, and mentions.
 */
internal fun clearImeField(
  finishComposing: () -> Boolean,
  readBefore: (Int) -> CharSequence?,
  readAfter: (Int) -> CharSequence?,
  deleteSurrounding: (Int, Int) -> Boolean,
): ImeCommitResult {
  var deletionAttempted = false
  val success = runCatching {
    // False can mean there was no composing span; still attempt the surrounding-text deletion.
    finishComposing()
    repeat(MAX_CLEAR_DELETIONS) {
      val before = readBefore(CLEAR_READ_WINDOW_CHARS)?.length ?: 0
      val after = readAfter(CLEAR_READ_WINDOW_CHARS)?.length ?: 0
      if (before == 0 && after == 0) return@runCatching true
      deletionAttempted = true
      if (!deleteSurrounding(before, after)) return@runCatching false
    }
    // Confirm the last deletion, but never keep writing to an editor that does not converge.
    val before = readBefore(CLEAR_READ_WINDOW_CHARS)?.length ?: 0
    val after = readAfter(CLEAR_READ_WINDOW_CHARS)?.length ?: 0
    before == 0 && after == 0
  }
    .getOrDefault(false)
  return ImeCommitResult(
    success = success,
    error = if (success) null else "IME clear failed",
    partialApplication = !success && deletionAttempted,
  )
}
