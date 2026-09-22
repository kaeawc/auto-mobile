package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

internal class FakeEditor(initialText: String = "") {
  var text: String = initialText
    private set

  var selectionStart: Int = initialText.length
    private set

  var selectionEnd: Int = initialText.length
    private set

  var composingStart: Int = -1
    private set

  var composingEnd: Int = -1
    private set

  fun setSelection(start: Int, end: Int = start) {
    require(start in 0..text.length && end in start..text.length)
    selectionStart = start
    selectionEnd = end
  }

  fun snapshot(): TextSnapshot =
    TextSnapshot(
      textBeforeCursor = text.substring(0, selectionStart),
      textAfterCursor = text.substring(selectionEnd),
      selectionStart = selectionStart,
      selectionEnd = selectionEnd,
      composingStart = composingStart,
      composingEnd = composingEnd,
    )

  fun apply(ops: List<ImeOp>) {
    ops.forEach { op ->
      when (op) {
        is ImeOp.CommitText -> {
          val start = if (composingStart >= 0) composingStart else selectionStart
          val end = if (composingStart >= 0) composingEnd else selectionEnd
          replace(start, end, op.text)
          clearComposing()
        }
        is ImeOp.SetComposingText -> {
          val start = if (composingStart >= 0) composingStart else selectionStart
          val end = if (composingStart >= 0) composingEnd else selectionEnd
          replace(start, end, op.text)
          composingStart = start
          composingEnd = start + op.text.length
        }
        ImeOp.FinishComposingText -> clearComposing()
        is ImeOp.SetComposingRegion -> {
          require(op.start in 0..text.length && op.end in op.start..text.length)
          composingStart = op.start
          composingEnd = op.end
        }
        is ImeOp.DeleteSurroundingText -> {
          val start = (selectionStart - op.before).coerceAtLeast(0)
          val end = (selectionEnd + op.after).coerceAtMost(text.length)
          replace(start, end, "")
          clearComposing()
        }
        is ImeOp.SendKey ->
          when (op.keyCode) {
            67 -> {
              val start =
                if (selectionStart != selectionEnd) selectionStart
                else (selectionStart - 1).coerceAtLeast(0)
              replace(start, selectionEnd, "")
              clearComposing()
            }
            66 -> {
              replace(selectionStart, selectionEnd, "\n")
              clearComposing()
            }
            else -> error("Unsupported key code ${op.keyCode}")
          }
        is ImeOp.PerformEditorAction,
        ImeOp.BeginBatchEdit,
        ImeOp.EndBatchEdit -> Unit
      }
    }
  }

  private fun replace(start: Int, end: Int, replacement: String) {
    text = text.replaceRange(start, end, replacement)
    selectionStart = start + replacement.length
    selectionEnd = selectionStart
  }

  private fun clearComposing() {
    composingStart = -1
    composingEnd = -1
  }
}
