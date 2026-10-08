package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import android.icu.lang.UCharacter
import android.icu.lang.UProperty
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeGraphemes
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig

class ConfigurableTypingPolicy(private val behavior: TypingBehavior) : TypingPolicy {
  private var composingBuffer = ""
  private var composingCursor = 0
  private var composingStart = -1
  private var automationFinishEchoCursor: Int? = null

  fun finishComposingForAutomation(): List<ImeOp> {
    automationFinishEchoCursor =
      if (composingBuffer.isNotEmpty()) composingStart + composingCursor else null
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
        if (composingBuffer.isEmpty()) composingStart = cursorInEditor
        composingBuffer = composingBuffer.insertAt(composingCursor, char)
        composingCursor += char.length
        ops += setComposingTextAtCursor()
        cursorInEditor = composingStart + composingCursor
      } else {
        if (composingBuffer.isNotEmpty()) cursorInEditor = composingStart + composingCursor
        finishComposingInto(ops)
        ops += ImeOp.CommitText(char)
        cursorInEditor += char.length
      }
    }
    return batchIfNeeded(ops)
  }

  override fun onBackspace(snapshot: TextSnapshot): List<ImeOp> {
    updateComposingCursor(snapshot)
    val ops =
      when {
        snapshot.selectionStart != snapshot.selectionEnd -> {
          val selectionOps = mutableListOf<ImeOp>()
          finishComposingInto(selectionOps)
          selectionOps += ImeOp.CommitText("")
          selectionOps
        }
        composingBuffer.isNotEmpty() && composingCursor == 0 ->
          mutableListOf<ImeOp>().also {
            finishComposingInto(it)
            it += backspaceCommitted(snapshot)
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
    // With nothing composing here, a report that still shows a composing span is a late echo of a
    // word this policy already finished: the cursor did not land in committed text, so it must not
    // recompose, and it must not consume the automation finish echo still on its way.
    val staleComposingEcho = composingBuffer.isEmpty() && snapshot.composingStart >= 0
    val suppressRecompose =
      staleComposingEcho ||
        automationFinishEchoCursor == snapshot.selectionStart &&
          snapshot.selectionStart == snapshot.selectionEnd &&
          snapshot.composingStart == -1 &&
          snapshot.composingEnd == -1
    if (!staleComposingEcho) automationFinishEchoCursor = null
    val ops = mutableListOf<ImeOp>()
    if (composingBuffer.isNotEmpty() && selectionLeftComposingSpan(snapshot)) {
      finishComposingInto(ops)
    } else {
      updateComposingCursor(snapshot)
    }
    // Our own composing edits echo back through onUpdateSelection; only re-compose when the
    // cursor lands in committed text, never while a word we are composing is still live.
    if (
      behavior.recomposeOnCursorMove &&
        !suppressRecompose &&
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
    composingCursor = 0
    composingStart = -1
    return listOf(ImeOp.FinishComposingText)
  }

  private fun backspaceComposing(): List<ImeOp> {
    if (composingCursor == 0) return emptyList()
    val previousGraphemeStart = ImeGraphemes.previousStart(composingBuffer, composingCursor)
    composingBuffer = composingBuffer.removeRange(previousGraphemeStart, composingCursor)
    composingCursor = previousGraphemeStart
    return if (composingBuffer.isEmpty()) {
      composingStart = -1
      listOf(ImeOp.SetComposingText(""), ImeOp.FinishComposingText)
    } else {
      setComposingTextAtCursor()
    }
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
        composingBuffer = remainingWord
        composingCursor = composingBuffer.length
        composingStart = end - remainingWord.length
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

  private fun selectionLeftComposingSpan(snapshot: TextSnapshot): Boolean =
    snapshot.selectionStart != snapshot.selectionEnd ||
      snapshot.selectionStart < snapshot.composingStart ||
      snapshot.selectionStart > snapshot.composingEnd

  private fun recomposeWordAtCursor(snapshot: TextSnapshot): ImeOp.SetComposingRegion? {
    val cursorOffset = snapshot.textBeforeCursor.length
    var boundary = 0
    val atGraphemeBoundary =
      cursorOffset == 0 ||
        ImeGraphemes.split(snapshot.textBeforeCursor + snapshot.textAfterCursor).any {
          boundary += it.length
          boundary == cursorOffset
        }
    if (!atGraphemeBoundary) return null
    val before = snapshot.textBeforeCursor.takeLastWord()
    val after = snapshot.textAfterCursor.takeWhileWord()
    if (before.isEmpty() && after.isEmpty()) return null
    composingBuffer = before + after
    composingCursor = before.length
    composingStart = snapshot.selectionStart - before.length
    return ImeOp.SetComposingRegion(
      snapshot.selectionStart - before.length,
      snapshot.selectionStart + after.length,
    )
  }

  private fun finishComposingInto(ops: MutableList<ImeOp>) {
    if (composingBuffer.isNotEmpty()) {
      ops += ImeOp.FinishComposingText
      composingBuffer = ""
      composingCursor = 0
      composingStart = -1
    }
  }

  private fun batchIfNeeded(ops: List<ImeOp>): List<ImeOp> =
    if (behavior.batchEdits && ops.size >= 2) {
      listOf(ImeOp.BeginBatchEdit) + ops + ImeOp.EndBatchEdit
    } else {
      ops
    }

  private fun updateComposingCursor(snapshot: TextSnapshot) {
    if (
      composingBuffer.isNotEmpty() &&
        snapshot.composingStart >= 0 &&
        snapshot.selectionStart in snapshot.composingStart..snapshot.composingEnd
    ) {
      composingCursor =
        (snapshot.selectionStart - snapshot.composingStart).coerceIn(0, composingBuffer.length)
      composingStart = snapshot.composingStart
    }
  }

  private fun setComposingTextAtCursor(): List<ImeOp> = buildList {
    add(ImeOp.SetComposingText(composingBuffer))
    if (composingCursor != composingBuffer.length) {
      val selection = composingStart + composingCursor
      add(ImeOp.SetSelection(selection, selection))
    }
  }

  private fun String.insertAt(index: Int, value: String): String =
    substring(0, index) + value + substring(index)

  private fun String.isWordGrapheme(): Boolean {
    val base = codePointAt(0)
    if (!Character.isLetterOrDigit(base) && base != '\''.code) return false
    if (contains('\uFE0F') || contains('\u20E3')) return false
    return base < 0x80 || !UCharacter.hasBinaryProperty(base, UProperty.EXTENDED_PICTOGRAPHIC)
  }

  private fun String.takeLastWord(): String {
    var index = length
    for (grapheme in ImeGraphemes.split(this).asReversed()) {
      if (!grapheme.isWordGrapheme()) break
      index -= grapheme.length
    }
    return substring(index)
  }

  private fun String.takeWhileWord(): String {
    var index = 0
    for (grapheme in ImeGraphemes.split(this)) {
      if (!grapheme.isWordGrapheme()) break
      index += grapheme.length
    }
    return substring(0, index)
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
