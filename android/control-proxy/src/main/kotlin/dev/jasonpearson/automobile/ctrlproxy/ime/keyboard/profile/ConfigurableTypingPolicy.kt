package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import dev.jasonpearson.automobile.ctrlproxy.ime.ImeGraphemes
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig

class ConfigurableTypingPolicy(private val behavior: TypingBehavior) : TypingPolicy {
  private val composing = ComposingWord()
  private var automationFinishEchoCursor: Int? = null

  fun finishComposingForAutomation(): List<ImeOp> {
    automationFinishEchoCursor =
      if (composing.composingBuffer.isNotEmpty())
        composing.composingStart + composing.composingCursor
      else null
    return onFinishInput()
  }

  // The composing cursor is not re-read from the snapshot here: onSelectionChanged already applies
  // every editor report as it arrives, and a snapshot taken before this policy's latest composing
  // edit is echoed (automation commits a word in one synchronous run) would move the cursor back
  // to the start of the new text and type it reversed (#10411).
  override fun onText(text: String, snapshot: TextSnapshot): List<ImeOp> {
    var cursorInEditor = snapshot.selectionStart
    val ops = mutableListOf<ImeOp>()
    ImeGraphemes.split(text).forEach { char ->
      if (!behavior.composeWords) {
        ops += ImeOp.CommitText(char)
        cursorInEditor += char.length
      } else if (char.isWordGrapheme()) {
        if (composing.composingBuffer.isEmpty()) composing.composingStart = cursorInEditor
        composing.composingBuffer =
          composing.composingBuffer.insertAt(composing.composingCursor, char)
        composing.composingCursor += char.length
        ops += composing.setComposingTextAtCursor()
        cursorInEditor = composing.composingStart + composing.composingCursor
      } else {
        if (composing.composingBuffer.isNotEmpty())
          cursorInEditor = composing.composingStart + composing.composingCursor
        composing.finishComposingInto(ops)
        ops += ImeOp.CommitText(char)
        cursorInEditor += char.length
      }
    }
    return batchIfNeeded(ops)
  }

  override fun onBackspace(snapshot: TextSnapshot): List<ImeOp> {
    composing.updateComposingCursor(snapshot)
    val ops =
      when {
        snapshot.selectionStart != snapshot.selectionEnd -> {
          val selectionOps = mutableListOf<ImeOp>()
          composing.finishComposingInto(selectionOps)
          selectionOps += ImeOp.CommitText("")
          selectionOps
        }
        composing.composingBuffer.isNotEmpty() && composing.composingCursor == 0 ->
          mutableListOf<ImeOp>().also {
            composing.finishComposingInto(it)
            it += backspaceCommitted(snapshot)
          }
        composing.composingBuffer.isNotEmpty() -> composing.backspaceComposing()
        else -> backspaceCommitted(snapshot)
      }
    return batchIfNeeded(ops)
  }

  override fun onEnter(config: EditorConfig, snapshot: TextSnapshot): List<ImeOp> {
    val ops = mutableListOf<ImeOp>()
    composing.finishComposingInto(ops)
    val action = config.imeOptions and IME_MASK_ACTION
    val hasEnterAction =
      action != IME_ACTION_UNSPECIFIED &&
        action != IME_ACTION_NONE &&
        config.imeOptions and IME_FLAG_NO_ENTER_ACTION == 0 &&
        config.inputType and TYPE_TEXT_FLAG_MULTI_LINE == 0
    if (hasEnterAction) {
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
    // With nothing composing here, a report that still shows a composing span is a late echo of a
    // word this policy already finished: the cursor did not land in committed text, so it must not
    // recompose, and it must not consume the automation finish echo still on its way.
    val staleComposingEcho = composing.composingBuffer.isEmpty() && snapshot.composingStart >= 0
    val suppressRecompose =
      staleComposingEcho ||
        automationFinishEchoCursor == snapshot.selectionStart &&
          snapshot.selectionStart == snapshot.selectionEnd &&
          snapshot.composingStart == -1 &&
          snapshot.composingEnd == -1
    if (!staleComposingEcho) automationFinishEchoCursor = null
    val ops = mutableListOf<ImeOp>()
    if (composing.composingBuffer.isNotEmpty() && composing.selectionLeftComposingSpan(snapshot)) {
      composing.finishComposingInto(ops)
    } else {
      composing.updateComposingCursor(snapshot)
    }
    // Our own composing edits echo back through onUpdateSelection; only re-compose when the
    // cursor lands in committed text, never while a word we are composing is still live.
    val shouldRecomposeAtCursor =
      behavior.recomposeOnCursorMove &&
        !suppressRecompose &&
        composing.composingBuffer.isEmpty() &&
        snapshot.selectionStart == snapshot.selectionEnd
    if (shouldRecomposeAtCursor) {
      composing.recomposeWordAtCursor(snapshot)?.let { ops += it }
    }
    return batchIfNeeded(ops)
  }

  override fun onFinishInput(): List<ImeOp> {
    if (composing.composingBuffer.isEmpty()) return emptyList()
    composing.composingBuffer = ""
    composing.composingCursor = 0
    composing.composingStart = -1
    return listOf(ImeOp.FinishComposingText)
  }

  private fun backspaceCommitted(snapshot: TextSnapshot): List<ImeOp> {
    val before = snapshot.textBeforeCursor
    if (!snapshot.textBeforeCursorAvailable) {
      return if (snapshot.selectionStart > 0) listOf(ImeOp.DeleteSurroundingText(1, 0))
      else emptyList()
    }
    if (before.isEmpty()) return emptyList()
    val deletedStart = ImeGraphemes.previousStart(before, before.length)
    val deletedWidth = before.length - deletedStart
    val deletedGrapheme = before.substring(deletedStart)
    if (behavior.recomposeOnBackspaceIntoWord && deletedGrapheme.isWordGrapheme()) {
      val remainingText = before.dropLast(deletedWidth)
      val remainingWord = remainingText.takeLastWord()
      val ops = mutableListOf<ImeOp>(ImeOp.DeleteSurroundingText(deletedWidth, 0))
      if (remainingWord.isNotEmpty()) {
        val end = snapshot.selectionStart - deletedWidth
        composing.composingBuffer = remainingWord
        composing.composingCursor = composing.composingBuffer.length
        composing.composingStart = end - remainingWord.length
        ops += ImeOp.SetComposingRegion(end - remainingWord.length, end)
      }
      return ops
    }
    return listOf(
      when (behavior.backspaceStrategy) {
        BackspaceStrategy.DELETE_SURROUNDING -> ImeOp.DeleteSurroundingText(deletedWidth, 0)
        BackspaceStrategy.KEY_EVENT -> ImeOp.SendKey(KEYCODE_DEL)
      },
    )
  }

  private fun batchIfNeeded(ops: List<ImeOp>): List<ImeOp> =
    if (behavior.batchEdits && ops.size >= 2) {
      listOf(ImeOp.BeginBatchEdit) + ops + ImeOp.EndBatchEdit
    } else {
      ops
    }

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
