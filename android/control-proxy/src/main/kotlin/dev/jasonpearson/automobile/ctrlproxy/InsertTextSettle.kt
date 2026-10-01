package dev.jasonpearson.automobile.ctrlproxy

internal data class InsertTextSnapshot(
  val text: String?,
  val isShowingHintText: Boolean,
  val selectionStart: Int,
  val selectionEnd: Int,
)

internal fun shouldWaitForPrecedingInput(expectedSuffix: String?): Boolean =
  !expectedSuffix.isNullOrEmpty()

internal fun isPrecedingInputReflected(s: InsertTextSnapshot, expectedSuffix: String): Boolean {
  val text = if (s.isShowingHintText) "" else s.text.orEmpty()
  return text.endsWith(expectedSuffix) ||
    (s.selectionStart in 0..text.length &&
      s.selectionEnd in 0..text.length &&
      text.substring(0, maxOf(s.selectionStart, s.selectionEnd)).endsWith(expectedSuffix))
}

/**
 * Exact suffixes only: identical pre-existing suffixes can pass before input lands. IME
 * capitalization/correction can time out. The selection-prefix check handles mid-text input. Bounds
 * added waiting to 300ms plus a final node-refresh IPC, without extracting the hierarchy.
 */
internal fun awaitPrecedingInput(
  expectedSuffix: String,
  readSnapshot: () -> InsertTextSnapshot?,
  nowMs: () -> Long,
  pause: (Long) -> Unit,
  deadlineMs: Long = 300L,
  pollMs: Long = 25L,
  matches: (InsertTextSnapshot) -> Boolean = { isPrecedingInputReflected(it, expectedSuffix) },
): Boolean {
  val start = nowMs()
  while (true) {
    val snapshot = readSnapshot() ?: return false
    if (matches(snapshot)) return true
    if (nowMs() - start >= deadlineMs) return false
    pause(pollMs)
  }
}
