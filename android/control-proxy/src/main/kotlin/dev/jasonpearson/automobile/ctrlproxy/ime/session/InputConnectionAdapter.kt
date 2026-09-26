package dev.jasonpearson.automobile.ctrlproxy.ime.session

import android.inputmethodservice.InputMethodService
import android.view.inputmethod.InputConnection

class InputConnectionAdapter(
  private val connection: InputConnection,
  private val service: InputMethodService,
) : ImeConnection {
  override fun commitText(text: String): Boolean = connection.commitText(text, 1)

  override fun setComposingText(text: String, newCursorPosition: Int): Boolean =
    connection.setComposingText(text, newCursorPosition)

  override fun finishComposingText(): Boolean = connection.finishComposingText()

  override fun setComposingRegion(start: Int, end: Int): Boolean =
    connection.setComposingRegion(start, end)

  override fun setSelection(start: Int, end: Int): Boolean = connection.setSelection(start, end)

  override fun deleteSurroundingText(before: Int, after: Int): Boolean =
    connection.deleteSurroundingText(before, after)

  override fun sendDownUpKey(keyCode: Int): Boolean {
    service.sendDownUpKeyEvents(keyCode)
    return true
  }

  override fun performEditorAction(actionId: Int): Boolean =
    connection.performEditorAction(actionId)

  override fun beginBatchEdit(): Boolean = connection.beginBatchEdit()

  override fun endBatchEdit(): Boolean = connection.endBatchEdit()

  override fun textBeforeCursor(max: Int): String =
    connection.getTextBeforeCursor(max, 0)?.toString().orEmpty()

  override fun textAfterCursor(max: Int): String =
    connection.getTextAfterCursor(max, 0)?.toString().orEmpty()
}
