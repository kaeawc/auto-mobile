package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig

class ConfigurableTypingPolicy(private val behavior: TypingBehavior) : TypingPolicy {
  private var composingBuffer = ""

  override fun onText(text: String, snapshot: TextSnapshot): List<ImeOp> {
    val ops = mutableListOf<ImeOp>()
    text.forEach { char ->
      if (!behavior.composeWords) {
        ops += ImeOp.CommitText(char.toString())
      } else if (char.isWordChar()) {
        composingBuffer += char
        ops += ImeOp.SetComposingText(composingBuffer)
      } else {
        finishComposingInto(ops)
        ops += ImeOp.CommitText(char.toString())
      }
    }
    return batchIfNeeded(ops)
  }

  override fun onBackspace(snapshot: TextSnapshot): List<ImeOp> {
    val ops =
      when {
        snapshot.selectionStart != snapshot.selectionEnd -> {
          val selectionOps = mutableListOf<ImeOp>()
          finishComposingInto(selectionOps)
          selectionOps += ImeOp.CommitText("")
          selectionOps
        }
        composingBuffer.isNotEmpty() -> backspaceComposing()
        else -> backspaceCommitted(snapshot)
      }
    return batchIfNeeded(ops)
  }

  override fun onEnter(config: EditorConfig, snapshot: TextSnapshot): List<ImeOp> {
    val ops = mutableListOf<ImeOp>()
    finishComposingInto(ops)
    val action = config.imeOptions and IME_MASK_ACTION
    if (
      action != IME_ACTION_UNSPECIFIED &&
        action != IME_ACTION_NONE &&
        config.imeOptions and IME_FLAG_NO_ENTER_ACTION == 0 &&
        config.inputType and TYPE_TEXT_FLAG_MULTI_LINE == 0
    ) {
      ops += ImeOp.PerformEditorAction(action)
    } else {
      ops +=
        when (behavior.enterStrategy) {
          EnterStrategy.KEY_EVENT -> ImeOp.SendKey(KEYCODE_ENTER)
          EnterStrategy.COMMIT_NEWLINE -> ImeOp.CommitText("\n")
        }
    }
    return batchIfNeeded(ops)
  }

  override fun onSelectionChanged(snapshot: TextSnapshot): List<ImeOp> {
    val ops = mutableListOf<ImeOp>()
    if (composingBuffer.isNotEmpty() && selectionLeftComposingSpan(snapshot)) {
      finishComposingInto(ops)
    }
    // Our own composing edits echo back through onUpdateSelection; only re-compose when the
    // cursor lands in committed text, never while a word we are composing is still live.
    if (
      behavior.recomposeOnCursorMove &&
        composingBuffer.isEmpty() &&
        snapshot.selectionStart == snapshot.selectionEnd
    ) {
      recomposeWordAtCursor(snapshot)?.let { ops += it }
    }
    return batchIfNeeded(ops)
  }

  override fun onFinishInput(): List<ImeOp> {
    if (composingBuffer.isEmpty()) return emptyList()
    composingBuffer = ""
    return listOf(ImeOp.FinishComposingText)
  }

  private fun backspaceComposing(): List<ImeOp> {
    composingBuffer = composingBuffer.dropLast(1)
    return if (composingBuffer.isEmpty()) {
      listOf(ImeOp.SetComposingText(""), ImeOp.FinishComposingText)
    } else {
      listOf(ImeOp.SetComposingText(composingBuffer))
    }
  }

  private fun backspaceCommitted(snapshot: TextSnapshot): List<ImeOp> {
    val before = snapshot.textBeforeCursor
    if (behavior.recomposeOnBackspaceIntoWord && before.lastOrNull()?.isWordChar() == true) {
      val remainingWord = before.dropLast(1).takeLastWhile { it.isWordChar() }
      val ops = mutableListOf<ImeOp>(ImeOp.DeleteSurroundingText(1, 0))
      if (remainingWord.isNotEmpty()) {
        val end = snapshot.selectionStart - 1
        composingBuffer = remainingWord
        ops += ImeOp.SetComposingRegion(end - remainingWord.length, end)
      }
      return ops
    }
    return listOf(
      when (behavior.backspaceStrategy) {
        BackspaceStrategy.DELETE_SURROUNDING -> ImeOp.DeleteSurroundingText(1, 0)
        BackspaceStrategy.KEY_EVENT -> ImeOp.SendKey(KEYCODE_DEL)
      }
    )
  }

  private fun selectionLeftComposingSpan(snapshot: TextSnapshot): Boolean =
    snapshot.selectionStart != snapshot.selectionEnd ||
      snapshot.selectionStart < snapshot.composingStart ||
      snapshot.selectionStart > snapshot.composingEnd

  private fun recomposeWordAtCursor(snapshot: TextSnapshot): ImeOp.SetComposingRegion? {
    val before = snapshot.textBeforeCursor.takeLastWhile { it.isWordChar() }
    val after = snapshot.textAfterCursor.takeWhile { it.isWordChar() }
    if (before.isEmpty() && after.isEmpty()) return null
    composingBuffer = before + after
    return ImeOp.SetComposingRegion(
      snapshot.selectionStart - before.length,
      snapshot.selectionStart + after.length,
    )
  }

  private fun finishComposingInto(ops: MutableList<ImeOp>) {
    if (composingBuffer.isNotEmpty()) {
      ops += ImeOp.FinishComposingText
      composingBuffer = ""
    }
  }

  private fun batchIfNeeded(ops: List<ImeOp>): List<ImeOp> =
    if (behavior.batchEdits && ops.size >= 2) {
      listOf(ImeOp.BeginBatchEdit) + ops + ImeOp.EndBatchEdit
    } else {
      ops
    }

  private fun Char.isWordChar(): Boolean = isLetterOrDigit() || this == '\''

  private companion object {
    // Android EditorInfo.IME_MASK_ACTION
    const val IME_MASK_ACTION = 0xff
    // Android EditorInfo.IME_ACTION_UNSPECIFIED
    const val IME_ACTION_UNSPECIFIED = 0
    // Android EditorInfo.IME_ACTION_NONE
    const val IME_ACTION_NONE = 1
    // Android EditorInfo.IME_FLAG_NO_ENTER_ACTION
    const val IME_FLAG_NO_ENTER_ACTION = 0x40000000
    // Android InputType.TYPE_TEXT_FLAG_MULTI_LINE
    const val TYPE_TEXT_FLAG_MULTI_LINE = 0x20000
    // Android KeyEvent.KEYCODE_ENTER
    const val KEYCODE_ENTER = 66
    // Android KeyEvent.KEYCODE_DEL
    const val KEYCODE_DEL = 67
  }
}
