package dev.jasonpearson.automobile.discover.ictrace

import android.view.KeyEvent
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.TextAttribute

class LoggingInputConnection(
  base: InputConnection,
  private val recorder: IcTraceRecorder,
  private val captureText: () -> Boolean,
  private val selectionOf: () -> IntArray,
) : InputConnectionWrapper(base, true) {
  private fun log(call: String, args: String, result: Boolean? = null, readValue: String? = null) {
    val selection = selectionOf()
    recorder.record(
      call,
      args,
      selection[0],
      selection[1],
      selection[2],
      selection[3],
      result,
      readValue,
    )
  }

  private fun formatText(value: CharSequence?): String = recorder.textArg(value, captureText())

  override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = super.commitText(text, newCursorPosition)
    log("commitText", "text=${formatText(text)}, newCursorPosition=$newCursorPosition", result)
    return result
  }

  override fun commitText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean {
    val result = super.commitText(text, newCursorPosition, textAttribute)
    log("commitText", "text=${formatText(text)}, newCursorPosition=$newCursorPosition", result)
    return result
  }

  override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = super.setComposingText(text, newCursorPosition)
    log(
      "setComposingText",
      "text=${formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  override fun setComposingText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean {
    val result = super.setComposingText(text, newCursorPosition, textAttribute)
    log(
      "setComposingText",
      "text=${formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  override fun replaceText(
    start: Int,
    end: Int,
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean {
    val result = super.replaceText(start, end, text, newCursorPosition, textAttribute)
    log(
      "replaceText",
      "start=$start, end=$end, text=${formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  override fun setComposingRegion(start: Int, end: Int): Boolean {
    val result = super.setComposingRegion(start, end)
    log("setComposingRegion", "start=$start, end=$end", result)
    return result
  }

  override fun finishComposingText(): Boolean {
    val result = super.finishComposingText()
    log("finishComposingText", "", result)
    return result
  }

  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    val result = super.deleteSurroundingText(beforeLength, afterLength)
    log("deleteSurroundingText", "beforeLength=$beforeLength, afterLength=$afterLength", result)
    return result
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    val result = super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    log(
      "deleteSurroundingTextInCodePoints",
      "beforeLength=$beforeLength, afterLength=$afterLength",
      result,
    )
    return result
  }

  override fun sendKeyEvent(event: KeyEvent?): Boolean {
    val result = super.sendKeyEvent(event)
    log("sendKeyEvent", "keyCode=${event?.keyCode}, action=${event?.action}", result)
    return result
  }

  override fun performEditorAction(actionCode: Int): Boolean {
    val result = super.performEditorAction(actionCode)
    log("performEditorAction", "actionCode=$actionCode", result)
    return result
  }

  override fun commitCompletion(text: CompletionInfo?): Boolean {
    val result = super.commitCompletion(text)
    log(
      "commitCompletion",
      "id=${text?.id}, position=${text?.position}, text=${formatText(text?.text)}",
      result,
    )
    return result
  }

  override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean {
    val result = super.commitCorrection(correctionInfo)
    log(
      "commitCorrection",
      "offset=${correctionInfo?.offset}, oldText=${formatText(correctionInfo?.oldText)}, newText=${formatText(correctionInfo?.newText)}",
      result,
    )
    return result
  }

  override fun setSelection(start: Int, end: Int): Boolean {
    val result = super.setSelection(start, end)
    log("setSelection", "start=$start, end=$end", result)
    return result
  }

  override fun beginBatchEdit(): Boolean {
    val result = super.beginBatchEdit()
    log("beginBatchEdit", "", result)
    return result
  }

  override fun endBatchEdit(): Boolean {
    val result = super.endBatchEdit()
    log("endBatchEdit", "", result)
    return result
  }

  override fun performContextMenuAction(id: Int): Boolean {
    val result = super.performContextMenuAction(id)
    log("performContextMenuAction", "id=$id", result)
    return result
  }

  override fun getTextBeforeCursor(length: Int, flags: Int): CharSequence? {
    val value = super.getTextBeforeCursor(length, flags)
    log(
      "getTextBeforeCursor",
      "length=$length, flags=$flags",
      readValue = recorder.safeText(value, captureText()),
    )
    return value
  }

  override fun getTextAfterCursor(length: Int, flags: Int): CharSequence? {
    val value = super.getTextAfterCursor(length, flags)
    log(
      "getTextAfterCursor",
      "length=$length, flags=$flags",
      readValue = recorder.safeText(value, captureText()),
    )
    return value
  }

  override fun getSelectedText(flags: Int): CharSequence? {
    val value = super.getSelectedText(flags)
    log("getSelectedText", "flags=$flags", readValue = recorder.safeText(value, captureText()))
    return value
  }
}
