package dev.jasonpearson.automobile.discover.ictrace

import android.content.Context
import android.text.InputType
import android.util.AttributeSet
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.EditText

// Plain EditText (not AppCompatEditText): this view is hosted in a Compose/Material3 activity that
// has no AppCompat theme, under which AppCompatEditText fails to take touch focus.
class IcTraceEditText(context: Context, attrs: AttributeSet? = null) : EditText(context, attrs) {
  var recorder: IcTraceRecorder? = null
  var captureText: Boolean = true

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val base = super.onCreateInputConnection(outAttrs) ?: return null
    val activeRecorder = recorder ?: return base
    return LoggingInputConnection(base, activeRecorder, captureText) {
      intArrayOf(
        selectionStart,
        selectionEnd,
        text?.let { BaseInputConnection.getComposingSpanStart(it) } ?: -1,
        text?.let { BaseInputConnection.getComposingSpanEnd(it) } ?: -1,
      )
    }
  }
}
