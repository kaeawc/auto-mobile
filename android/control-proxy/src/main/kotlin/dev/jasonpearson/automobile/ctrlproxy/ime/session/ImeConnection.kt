package dev.jasonpearson.automobile.ctrlproxy.ime.session

interface ImeConnection {
  fun commitText(text: String): Boolean

  fun setComposingText(text: String): Boolean

  fun finishComposingText(): Boolean

  fun setComposingRegion(start: Int, end: Int): Boolean

  fun deleteSurroundingText(before: Int, after: Int): Boolean

  fun sendDownUpKey(keyCode: Int): Boolean

  fun performEditorAction(actionId: Int): Boolean

  fun beginBatchEdit(): Boolean

  fun endBatchEdit(): Boolean

  fun textBeforeCursor(max: Int): String

  fun textAfterCursor(max: Int): String
}
