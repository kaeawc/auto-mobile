package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType

interface ImeCommitSink {
  fun nowMs(): Long

  /** The active editor's inputType (EditorInfo.inputType), or null if no connection. */
  fun editorInputType(): Int?

  /** Commit a single char to the InputConnection; false if the connection is gone. */
  fun commitChar(ch: CharSequence): Boolean

  /**
   * Finalize any composing span the active typing profile left open (composing profiles keep the
   * last word composing until a separator); false if the connection is gone.
   */
  fun finishComposing(): Boolean

  /** Read up to maxChars of text before the cursor; null if no connection. */
  fun readTextBeforeCursor(maxChars: Int): String?

  /** Schedule action on the IME main handler, yielding the main thread between polls. */
  fun postDelayed(delayMs: Long, action: () -> Unit)

  /**
   * Force the target editor to apply all prior async commit ops before we switch IMEs, via a
   * blocking getTextBeforeCursor round-trip. Returns false if the connection is gone.
   */
  fun syncEditorState(): Boolean

  /** Switch the system IME back to the given id (InputMethodService.switchInputMethod). */
  fun switchToIme(imeId: String)
}

data class ImeCommitResult(
  val success: Boolean,
  val error: String?,
  val partialApplication: Boolean = false,
)

class ImeCommitDriver(private val sink: ImeCommitSink) {
  private var completed = false
  private var committedChars = 0
  private var completion: ((ImeCommitResult) -> Unit)? = null
  private var restoreId: String? = null

  /**
   * Stops scheduled polls and reports the outcome exactly once before the caller restores the IME.
   */
  fun cancel(reason: String = "IME commit cancelled") {
    complete(failure(reason))
  }

  private fun complete(result: ImeCommitResult) {
    if (completed) return
    completed = true
    restoreIfNeeded(restoreId)
    completion?.invoke(result)
  }

  /**
   * Calls onComplete after the final editor sync and IME restore. The shell still owns idle/finish
   * restoration as a backstop.
   */
  fun commit(
    text: String,
    priorImeId: String?,
    deadlineMs: Long = Long.MAX_VALUE,
    isCancelled: () -> Boolean = { false },
    onComplete: (ImeCommitResult) -> Unit,
  ) {
    check(completion == null) { "An IME commit driver handles one request" }
    completion = onComplete
    restoreId = priorImeId
    if (isCancelled()) {
      complete(failure("IME commit cancelled"))
      return
    }
    if (sink.nowMs() >= deadlineMs) {
      complete(failure("IME commit deadline exceeded"))
      return
    }

    val inputType = sink.editorInputType()
    if (inputType == null) {
      complete(failure("No active input connection"))
      return
    }
    if (isPasswordInputType(inputType)) {
      complete(failure("Cannot commit text into a password field"))
      return
    }

    val segments = splitInlineFormatSpans(text)
    fun commitSegment(index: Int) {
      if (completed) return
      if (isCancelled()) {
        complete(failure("IME commit cancelled"))
        return
      }
      if (sink.nowMs() >= deadlineMs) {
        complete(failure("IME commit deadline exceeded"))
        return
      }
      if (index == segments.size) {
        complete(
          if (sink.syncEditorState()) ImeCommitResult(success = true, error = null)
          else failure("Input connection lost while syncing editor state")
        )
        return
      }
      val segment = segments[index]
      for (ch in segment.text) {
        if (completed) return
        if (isCancelled()) {
          complete(failure("IME commit cancelled"))
          return
        }
        if (sink.nowMs() >= deadlineMs) {
          complete(failure("IME commit deadline exceeded"))
          return
        }
        if (!sink.commitChar(ch.toString())) {
          complete(failure("Input connection lost during commit"))
          return
        }
        committedChars++
      }
      // Composing profiles retain the last word until explicitly finished.
      if (!sink.finishComposing()) {
        complete(failure("Input connection lost while finishing composition"))
        return
      }
      val literal = segment.trailingSpan
      if (literal != null && index < segments.lastIndex) {
        fun pollConverted(attempt: Int) {
          if (completed) return
          if (isCancelled()) {
            complete(failure("IME commit cancelled"))
            return
          }
          if (sink.nowMs() >= deadlineMs) {
            complete(failure("IME commit deadline exceeded"))
            return
          }
          val seen = sink.readTextBeforeCursor(literal.length)
          // seen == null: connection gone — proceed; the next commitChar fails cleanly.
          // seen non-empty and != literal: the composer consumed the markers (converted).
          // seen == literal (not yet converted) OR seen == "" (editor without text retrieval,
          // e.g. some WebView/custom fields — InputConnection.getTextBeforeCursor returns ""):
          // keep polling to the bounded ceiling so retrieval-less editors still get a fixed
          // settle window instead of racing ahead instantly.
          val proceed =
            seen == null || (seen.isNotEmpty() && seen != literal) || attempt >= MAX_POLL_ATTEMPTS
          if (proceed) {
            commitSegment(index + 1)
          } else {
            sink.postDelayed(POLL_INTERVAL_MS) { pollConverted(attempt + 1) }
          }
        }
        pollConverted(0)
      } else {
        commitSegment(index + 1)
      }
    }
    commitSegment(0)
  }

  /** Called by the shell on onFinishInput / idle-deadline; restores if priorImeId is non-null. */
  fun restoreIfNeeded(priorImeId: String?) {
    if (priorImeId != null) sink.switchToIme(priorImeId)
  }

  private data class Segment(val text: String, val trailingSpan: String?)

  private fun splitInlineFormatSpans(text: String): List<Segment> {
    val segments = mutableListOf<Segment>()
    var previousCut = 0
    for (match in INLINE_FORMAT_SPAN.findAll(text)) {
      val end = match.range.last + 1
      segments.add(Segment(text.substring(previousCut, end), match.value))
      previousCut = end
    }
    if (previousCut < text.length) segments.add(Segment(text.substring(previousCut), null))
    return segments.ifEmpty { listOf(Segment(text, null)) }
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

  private fun failure(error: String) =
    ImeCommitResult(success = false, error = error, partialApplication = committedChars > 0)

  private companion object {
    val INLINE_FORMAT_SPAN = Regex("```|`[^`\n]+`|\\*[^*\n]+\\*|_[^_\n]+_|~[^~\n]+~")
    const val POLL_INTERVAL_MS = 40L
    const val MAX_POLL_ATTEMPTS = 12
  }
}
