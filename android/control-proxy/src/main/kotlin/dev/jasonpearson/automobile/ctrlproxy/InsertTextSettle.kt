package dev.jasonpearson.automobile.ctrlproxy

internal typealias InsertTextSnapshot = dev.jasonpearson.automobile.protocol.InsertTextState

internal fun shouldWaitForPrecedingInput(expectedSuffix: String?): Boolean =
  !expectedSuffix.isNullOrEmpty()

/**
 * With a pre-dispatch baseline, reflection requires BOTH: (1) text equals replacing the baseline
 * selection with expectedSuffix, and (2) text changed, OR selection changed to a collapsed caret
 * immediately after that insertion. A valid baseline selection is required; unchanged text plus
 * unchanged selection never proves delivery, even for a pre-existing suffix. Transformed input
 * conservatively times out through the existing bounded wait/warning path. With a null/unavailable
 * baseline, retain the legacy suffix/selection-prefix check.
 */
internal fun isPrecedingInputReflected(
  s: InsertTextSnapshot,
  expectedSuffix: String,
  baseline: InsertTextSnapshot? = null,
): Boolean {
  val text = if (s.isShowingHintText) "" else s.text.orEmpty()
  if (baseline != null) {
    val before = if (baseline.isShowingHintText) "" else baseline.text.orEmpty()
    if (
      baseline.selectionStart !in 0..before.length || baseline.selectionEnd !in 0..before.length
    ) {
      return false
    }
    val expected =
      planInsertText(before, false, baseline.selectionStart, baseline.selectionEnd, expectedSuffix)
    val selectionAdvanced =
      s.selectionStart == expected.caret &&
        s.selectionEnd == expected.caret &&
        (s.selectionStart != baseline.selectionStart || s.selectionEnd != baseline.selectionEnd)
    val changed = text != before || selectionAdvanced
    return changed && text == expected.updatedText
  }
  return text.endsWith(expectedSuffix) ||
    (s.selectionStart in 0..text.length &&
      s.selectionEnd in 0..text.length &&
      text.substring(0, maxOf(s.selectionStart, s.selectionEnd)).endsWith(expectedSuffix))
}

/**
 * Bounds added waiting to 300ms plus a final node-refresh IPC, without extracting the hierarchy.
 * IME capitalization/correction can time out rather than falsely proving input was delivered.
 */
internal fun awaitPrecedingInput(
  expectedSuffix: String,
  readSnapshot: () -> InsertTextSnapshot?,
  nowMs: () -> Long,
  pause: (Long) -> Unit,
  deadlineMs: Long = 300L,
  pollMs: Long = 25L,
  baseline: InsertTextSnapshot? = null,
  matches: (InsertTextSnapshot) -> Boolean = {
    isPrecedingInputReflected(it, expectedSuffix, baseline)
  },
): Boolean {
  val start = nowMs()
  while (true) {
    val snapshot = readSnapshot() ?: return false
    if (matches(snapshot)) return true
    if (nowMs() - start >= deadlineMs) return false
    pause(pollMs)
  }
}
