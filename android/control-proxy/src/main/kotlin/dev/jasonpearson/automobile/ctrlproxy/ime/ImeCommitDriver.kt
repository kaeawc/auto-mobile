package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType

interface ImeCommitSink {
  /** The active editor's inputType (EditorInfo.inputType), or null if no connection. */
  fun editorInputType(): Int?

  /** Commit a single char to the InputConnection; false if the connection is gone. */
  fun commitChar(ch: CharSequence): Boolean

  /**
   * Finalize any composing span the active typing profile left open (composing profiles keep the
   * last word composing until a separator); false if the connection is gone.
   */
  fun finishComposing(): Boolean

  /** Switch the system IME back to the given id (InputMethodService.switchInputMethod). */
  fun switchToIme(imeId: String)
}

data class ImeCommitResult(val success: Boolean, val error: String?)

class ImeCommitDriver(private val sink: ImeCommitSink) {
  /**
   * Returns the outcome; does not itself restore on idle/finish (the shell owns those triggers),
   * but restores immediately after a completed or failed commit when priorImeId is non-null.
   */
  fun commit(text: String, priorImeId: String?): ImeCommitResult =
    try {
      commitToActiveEditor(text)
    } finally {
      restoreIfNeeded(priorImeId)
    }

  /** Called by the shell on onFinishInput / idle-deadline; restores if priorImeId is non-null. */
  fun restoreIfNeeded(priorImeId: String?) {
    if (priorImeId != null) sink.switchToIme(priorImeId)
  }

  private fun commitToActiveEditor(text: String): ImeCommitResult {
    val inputType = sink.editorInputType() ?: return failure("No active input connection")
    if (isPasswordInputType(inputType)) {
      return failure("Cannot commit text into a password field")
    }

    for (ch in text) {
      if (!sink.commitChar(ch.toString())) {
        return failure("Input connection lost during commit")
      }
    }
    // Without this the trailing word stays uncommitted whenever no IME switch follows (the user
    // already selected this keyboard), and editors that react to commits never see it.
    if (!sink.finishComposing()) {
      return failure("Input connection lost while finishing composition")
    }
    return ImeCommitResult(success = true, error = null)
  }

  private fun isPasswordInputType(inputType: Int): Boolean {
    val variation = inputType and InputType.TYPE_MASK_VARIATION
    val inputClass = inputType and InputType.TYPE_MASK_CLASS
    val isTextPassword =
      inputClass == InputType.TYPE_CLASS_TEXT &&
        variation in
          setOf(
            InputType.TYPE_TEXT_VARIATION_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
          )
    val isNumberPassword =
      inputClass == InputType.TYPE_CLASS_NUMBER &&
        variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    return isTextPassword || isNumberPassword
  }

  private fun failure(error: String) = ImeCommitResult(success = false, error = error)
}
