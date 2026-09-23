package dev.jasonpearson.automobile.ctrlproxy.ime.session

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.TextSnapshot

class SelectionTracker {
  private var selStart = -1
  private var selEnd = -1
  private var composingStart = -1
  private var composingEnd = -1

  fun reset(initialSelStart: Int, initialSelEnd: Int) {
    selStart = initialSelStart
    selEnd = initialSelEnd
    composingStart = -1
    composingEnd = -1
  }

  fun update(newSelStart: Int, newSelEnd: Int, candidatesStart: Int, candidatesEnd: Int) {
    selStart = newSelStart
    selEnd = newSelEnd
    composingStart = candidatesStart
    composingEnd = candidatesEnd
  }

  fun snapshot(connection: ImeConnection): TextSnapshot =
    TextSnapshot(
      textBeforeCursor = connection.textBeforeCursor(SNAPSHOT_WINDOW),
      textAfterCursor = connection.textAfterCursor(SNAPSHOT_WINDOW),
      selectionStart = selStart,
      selectionEnd = selEnd,
      composingStart = composingStart,
      composingEnd = composingEnd,
    )

  companion object {
    const val SNAPSHOT_WINDOW = 256
  }
}
