package dev.jasonpearson.automobile.discover.ictrace

import android.view.KeyEvent
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper

class LoggingInputConnection(
  base: InputConnection,
  private val recorder: IcTraceRecorder,
  private val captureText: Boolean,
  private val selectionOf: () -> IntArray,
) : InputConnectionWrapper(base, true) {
  private fun log(call: String, args: String) {
    val selection = selectionOf()
    recorder.record(call, args, selection[0], selection[1], selection[2], selection[3])
  }

  private fun formatText(value: CharSequence?): String = recorder.textArg(value, captureText)

  override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = super.commitText(text, newCursorPosition)
    log("commitText", "text=${formatText(text)}, newCursorPosition=$newCursorPosition")
    return result
  }

  override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = super.setComposingText(text, newCursorPosition)
    log("setComposingText", "text=${formatText(text)}, newCursorPosition=$newCursorPosition")
    return result
  }

  override fun setComposingRegion(start: Int, end: Int): Boolean {
    val result = super.setComposingRegion(start, end)
    log("setComposingRegion", "start=$start, end=$end")
    return result
  }

  override fun finishComposingText(): Boolean {
    val result = super.finishComposingText()
    log("finishComposingText", "")
    return result
  }

  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    val result = super.deleteSurroundingText(beforeLength, afterLength)
    log("deleteSurroundingText", "beforeLength=$beforeLength, afterLength=$afterLength")
    return result
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    val result = super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    log("deleteSurroundingTextInCodePoints", "beforeLength=$beforeLength, afterLength=$afterLength")
    return result
  }

  override fun sendKeyEvent(event: KeyEvent?): Boolean {
    val result = super.sendKeyEvent(event)
    log("sendKeyEvent", "keyCode=${event?.keyCode}, action=${event?.action}")
    return result
  }

  override fun performEditorAction(actionCode: Int): Boolean {
    val result = super.performEditorAction(actionCode)
    log("performEditorAction", "actionCode=$actionCode")
    return result
  }

  override fun commitCompletion(text: CompletionInfo?): Boolean {
    val result = super.commitCompletion(text)
    log(
      "commitCompletion",
      "id=${text?.id}, position=${text?.position}, text=${formatText(text?.text)}",
    )
    return result
  }

  override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean {
    val result = super.commitCorrection(correctionInfo)
    log(
      "commitCorrection",
      "offset=${correctionInfo?.offset}, oldText=${formatText(correctionInfo?.oldText)}, newText=${formatText(correctionInfo?.newText)}",
    )
    return result
  }

  override fun setSelection(start: Int, end: Int): Boolean {
    val result = super.setSelection(start, end)
    log("setSelection", "start=$start, end=$end")
    return result
  }

  override fun beginBatchEdit(): Boolean {
    val result = super.beginBatchEdit()
    log("beginBatchEdit", "")
    return result
  }

  override fun endBatchEdit(): Boolean {
    val result = super.endBatchEdit()
    log("endBatchEdit", "")
    return result
  }

  override fun performContextMenuAction(id: Int): Boolean {
    val result = super.performContextMenuAction(id)
    log("performContextMenuAction", "id=$id")
    return result
  }
}
