package dev.jasonpearson.automobile.ctrlproxy.ime.session

interface ImeConnection : ImeTextEditing {
  fun sendDownUpKey(keyCode: Int): Boolean

  fun performEditorAction(actionId: Int): Boolean

  fun beginBatchEdit(): Boolean

  /** Ends one batch edit; Android's return value reports remaining nested batches, not success. */
  fun endBatchEdit(): Boolean

  fun textBeforeCursor(max: Int): String

  /** Null means the editor could not provide surrounding text. */
  fun textBeforeCursorOrNull(max: Int): String? = textBeforeCursor(max)

  fun textAfterCursor(max: Int): String
}

/** Text and composing operations on an editor connection. */
interface ImeTextEditing {
  fun commitText(text: String): Boolean

  fun setComposingText(text: String, newCursorPosition: Int): Boolean

  fun finishComposingText(): Boolean

  fun setComposingRegion(start: Int, end: Int): Boolean

  fun setSelection(start: Int, end: Int): Boolean

  fun deleteSurroundingText(before: Int, after: Int): Boolean
}
