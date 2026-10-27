package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import dev.jasonpearson.automobile.ctrlproxy.ime.ImeGraphemes

/** Mutable composing span and its cursor operations. */
internal class ComposingWord {
  var composingBuffer = ""
  var composingCursor = 0
  var composingStart = -1

  fun backspaceComposing(): List<ImeOp> {
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

  fun selectionLeftComposingSpan(snapshot: TextSnapshot): Boolean =
    snapshot.selectionStart != snapshot.selectionEnd ||
      snapshot.selectionStart < snapshot.composingStart ||
      snapshot.selectionStart > snapshot.composingEnd

  fun recomposeWordAtCursor(snapshot: TextSnapshot): ImeOp.SetComposingRegion? {
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

  fun finishComposingInto(ops: MutableList<ImeOp>) {
    if (composingBuffer.isNotEmpty()) {
      ops += ImeOp.FinishComposingText
      composingBuffer = ""
      composingCursor = 0
      composingStart = -1
    }
  }

  fun updateComposingCursor(snapshot: TextSnapshot) {
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

  fun setComposingTextAtCursor(): List<ImeOp> = buildList {
    add(ImeOp.SetComposingText(composingBuffer))
    if (composingCursor != composingBuffer.length) {
      val selection = composingStart + composingCursor
      add(ImeOp.SetSelection(selection, selection))
    }
  }
}
