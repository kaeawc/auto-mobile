package dev.jasonpearson.automobile.discover.ictrace

import android.os.Build
import android.view.KeyEvent
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.TextAttribute
import androidx.annotation.RequiresApi

// Narrow operation interfaces intentionally override the wrapper via delegation. Keeping the
// wrapper superclass preserves forwarding for unlogged APIs, including Java default methods.
class LoggingInputConnection
private constructor(private val target: InputConnectionWrapper, trace: InputConnectionTrace) :
  InputConnectionWrapper(target, true),
  TextInputOperations by LoggingTextInputConnection(target, trace),
  EditorInputOperations by LoggingEditorInputConnection(target, trace),
  ReadInputOperations by LoggingReadInputConnection(target, trace) {
  constructor(
    base: InputConnection,
    recorder: IcTraceRecorder,
    captureText: () -> Boolean,
    selectionOf: () -> IntArray,
  ) : this(
    InputConnectionWrapper(base, true),
    InputConnectionTrace(recorder, captureText, selectionOf),
  )

  override fun setTarget(target: InputConnection?) {
    this.target.setTarget(target)
  }
}

interface TextInputOperations {
  fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  fun commitText(text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?): Boolean

  fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  fun setComposingText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  fun replaceText(
    start: Int,
    end: Int,
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean

  fun setComposingRegion(start: Int, end: Int): Boolean

  fun finishComposingText(): Boolean
}

interface EditorInputOperations {
  fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean

  fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean

  fun sendKeyEvent(event: KeyEvent?): Boolean

  fun performEditorAction(actionCode: Int): Boolean

  fun commitCompletion(text: CompletionInfo?): Boolean

  fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean

  fun setSelection(start: Int, end: Int): Boolean

  fun beginBatchEdit(): Boolean

  fun endBatchEdit(): Boolean

  fun performContextMenuAction(id: Int): Boolean
}

interface ReadInputOperations {
  fun getTextBeforeCursor(length: Int, flags: Int): CharSequence?

  fun getTextAfterCursor(length: Int, flags: Int): CharSequence?

  fun getSelectedText(flags: Int): CharSequence?
}

private class InputConnectionTrace(
  private val recorder: IcTraceRecorder,
  private val captureText: () -> Boolean,
  private val selectionOf: () -> IntArray,
) {
  fun log(call: String, args: String, result: Boolean? = null, readValue: String? = null) {
    val selection = selectionOf()
    recorder.record(
      call,
      args,
      IcTraceSelection(selection[0], selection[1], selection[2], selection[3]),
      result,
      readValue,
    )
  }

  fun formatText(value: CharSequence?): String = recorder.textArg(value, captureText())

  fun safeText(value: CharSequence?): String? = recorder.safeText(value, captureText())
}

private class LoggingTextInputConnection(
  private val base: InputConnection,
  private val trace: InputConnectionTrace,
) : TextInputOperations {
  override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = base.commitText(text, newCursorPosition)
    trace.log(
      "commitText",
      "text=${trace.formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  // The framework only invokes these overloads on the API levels that introduced them.
  // Keep forwarding intact, including the absence of a legacy fallback.
  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  override fun commitText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean {
    val result = base.commitText(text, newCursorPosition, textAttribute)
    trace.log(
      "commitText",
      "text=${trace.formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = base.setComposingText(text, newCursorPosition)
    trace.log(
      "setComposingText",
      "text=${trace.formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  override fun setComposingText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean {
    val result = base.setComposingText(text, newCursorPosition, textAttribute)
    trace.log(
      "setComposingText",
      "text=${trace.formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  override fun replaceText(
    start: Int,
    end: Int,
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean {
    val result = base.replaceText(start, end, text, newCursorPosition, textAttribute)
    trace.log(
      "replaceText",
      "start=$start, end=$end, text=${trace.formatText(text)}, newCursorPosition=$newCursorPosition",
      result,
    )
    return result
  }

  override fun setComposingRegion(start: Int, end: Int): Boolean {
    val result = base.setComposingRegion(start, end)
    trace.log("setComposingRegion", "start=$start, end=$end", result)
    return result
  }

  override fun finishComposingText(): Boolean {
    val result = base.finishComposingText()
    trace.log("finishComposingText", "", result)
    return result
  }
}

private class LoggingEditorInputConnection(
  private val base: InputConnection,
  private val trace: InputConnectionTrace,
) : EditorInputOperations {
  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    val result = base.deleteSurroundingText(beforeLength, afterLength)
    trace.log(
      "deleteSurroundingText",
      "beforeLength=$beforeLength, afterLength=$afterLength",
      result,
    )
    return result
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    val result = base.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    trace.log(
      "deleteSurroundingTextInCodePoints",
      "beforeLength=$beforeLength, afterLength=$afterLength",
      result,
    )
    return result
  }

  override fun sendKeyEvent(event: KeyEvent?): Boolean {
    val result = base.sendKeyEvent(event)
    trace.log("sendKeyEvent", "keyCode=${event?.keyCode}, action=${event?.action}", result)
    return result
  }

  override fun performEditorAction(actionCode: Int): Boolean {
    val result = base.performEditorAction(actionCode)
    trace.log("performEditorAction", "actionCode=$actionCode", result)
    return result
  }

  override fun commitCompletion(text: CompletionInfo?): Boolean {
    val result = base.commitCompletion(text)
    trace.log(
      "commitCompletion",
      "id=${text?.id}, position=${text?.position}, text=${trace.formatText(text?.text)}",
      result,
    )
    return result
  }

  override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean {
    val result = base.commitCorrection(correctionInfo)
    trace.log(
      "commitCorrection",
      "offset=${correctionInfo?.offset}, oldText=${trace.formatText(correctionInfo?.oldText)}, newText=${trace.formatText(correctionInfo?.newText)}",
      result,
    )
    return result
  }

  override fun setSelection(start: Int, end: Int): Boolean {
    val result = base.setSelection(start, end)
    trace.log("setSelection", "start=$start, end=$end", result)
    return result
  }

  override fun beginBatchEdit(): Boolean {
    val result = base.beginBatchEdit()
    trace.log("beginBatchEdit", "", result)
    return result
  }

  override fun endBatchEdit(): Boolean {
    val result = base.endBatchEdit()
    trace.log("endBatchEdit", "", result)
    return result
  }

  override fun performContextMenuAction(id: Int): Boolean {
    val result = base.performContextMenuAction(id)
    trace.log("performContextMenuAction", "id=$id", result)
    return result
  }
}

private class LoggingReadInputConnection(
  private val base: InputConnection,
  private val trace: InputConnectionTrace,
) : ReadInputOperations {
  override fun getTextBeforeCursor(length: Int, flags: Int): CharSequence? {
    val value = base.getTextBeforeCursor(length, flags)
    trace.log(
      "getTextBeforeCursor",
      "length=$length, flags=$flags",
      readValue = trace.safeText(value),
    )
    return value
  }

  override fun getTextAfterCursor(length: Int, flags: Int): CharSequence? {
    val value = base.getTextAfterCursor(length, flags)
    trace.log(
      "getTextAfterCursor",
      "length=$length, flags=$flags",
      readValue = trace.safeText(value),
    )
    return value
  }

  override fun getSelectedText(flags: Int): CharSequence? {
    val value = base.getSelectedText(flags)
    trace.log("getSelectedText", "flags=$flags", readValue = trace.safeText(value))
    return value
  }
}
