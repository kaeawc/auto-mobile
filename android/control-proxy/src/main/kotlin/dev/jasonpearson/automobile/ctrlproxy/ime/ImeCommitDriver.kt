package dev.jasonpearson.automobile.ctrlproxy.ime

import dev.jasonpearson.automobile.protocol.ImeTextDelivery

interface ImeCommitSink {
  fun nowMs(): Long

  /** The active editor's inputType (EditorInfo.inputType), or null if no connection. */
  fun editorInputType(): Int?

  /** Commit one complete Unicode editing unit; false if the connection is gone. */
  fun commitChar(ch: CharSequence): Boolean

  /** Preflight every requested unit before the first key event is dispatched. */
  fun supportsKeyEvents(units: List<String>): Boolean

  /** Send one complete character's down/up sequence through the current input connection. */
  fun sendKeyEventUnit(unit: String): Boolean

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
  // Incremented before dispatch: the final unit may only have been partially applied.
  val committedUnits: Int = 0,
)

/**
 * Delivers realistic typing through the editor connection. Commits yield at punctuation and
 * separators like a person's keystrokes, allowing autocomplete, markdown/autoformat shortcuts, and
 * mention chips to react to typed input. Letter and digit runs remain synchronous; bounded
 * conversion waits let a rich-text composer settle before the next input arrives.
 */
class ImeCommitDriver(
  private val sink: ImeCommitSink,
  private val splitGraphemes: (String) -> List<String> = ImeGraphemes::split,
) {
  private var completed = false
  private var committedUnits = 0
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
    // Editor writes are oneway; a failed request may have already issued some of them.
    // Keep the result partial when the round-trip cannot confirm quiescence.
    val outcome =
      if (!result.success && committedUnits > 0 && !sink.syncEditorState())
        result.copy(partialApplication = true)
      else result
    restoreIfNeeded(restoreId)
    completion?.invoke(outcome.copy(committedUnits = committedUnits))
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
    delivery: ImeTextDelivery = ImeTextDelivery.COMMIT,
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

    if (sink.editorInputType() == null) {
      complete(failure("No active input connection"))
      return
    }
    // Password fields commit like any other field (owner decision 2026-10-07: this is a local,
    // user-operated debug tool). The typed text is never formatted into a log or error here.

    if (delivery == ImeTextDelivery.KEY_EVENTS) {
      sendKeyEvents(text, deadlineMs, isCancelled)
      return
    }

    CommitSequence(text, deadlineMs, isCancelled).commitSegment(0)
  }

  /** Realistic typing pauses and conversion state belong to this request's continuations. */
  private inner class CommitSequence(
    text: String,
    private val deadlineMs: Long,
    private val isCancelled: () -> Boolean,
  ) {
    private val segments = splitInlineFormatSpans(text)
    private val currentLine = StringBuilder()
    private var settleWaitMs = 0L

    private fun canContinue(): Boolean {
      if (completed) return false
      val error =
        when {
          isCancelled() -> "IME commit cancelled"
          deadlineMs < Long.MAX_VALUE - settleWaitMs && sink.nowMs() >= deadlineMs + settleWaitMs ->
            "IME commit deadline exceeded"
          else -> return true
        }
      complete(failure(error))
      return false
    }

    private fun waitForEditor(delayMs: Long, next: () -> Unit) {
      settleWaitMs += delayMs
      sink.postDelayed(delayMs) { if (canContinue()) next() }
    }

    fun commitSegment(index: Int) {
      if (!canContinue()) return
      if (index == segments.size) {
        complete(
          if (sink.syncEditorState()) ImeCommitResult(success = true, error = null)
          else failure("Input connection lost while syncing editor state")
        )
        return
      }
      commitUnits(index, splitGraphemes(segments[index].text), 0)
    }

    private fun finishSegment(index: Int) {
      // Composing profiles retain the last word until explicitly finished.
      if (!sink.finishComposing()) {
        complete(failure("Input connection lost while finishing composition"))
        return
      }
      val literal = segments[index].trailingSpan
      if (literal != null && index < segments.lastIndex) {
        pollInlineConversion(literal, 0) { commitSegment(index + 1) }
      } else {
        commitSegment(index + 1)
      }
    }

    private fun pollInlineConversion(literal: String, attempt: Int, next: () -> Unit) {
      if (!canContinue()) return
      val seen = sink.readTextBeforeCursor(literal.length)
      // A short unconverted read is a suffix of the literal. Empty/null reads wait to the ceiling.
      val converted = seen != null && seen.isNotEmpty() && !literal.endsWith(seen)
      if (converted || attempt >= MAX_POLL_ATTEMPTS) {
        next()
      } else {
        waitForEditor(POLL_INTERVAL_MS) { pollInlineConversion(literal, attempt + 1, next) }
      }
    }

    private fun awaitLineStartConversion(literal: String, attempt: Int, next: () -> Unit) {
      if (!canContinue()) return
      if (attempt == 0) {
        // Pause as in realistic typing so the rich-text composer can react to the typed shortcut.
        waitForEditor(REALISTIC_TYPING_PAUSE_MS) { awaitLineStartConversion(literal, 1, next) }
        return
      }
      val seen = sink.readTextBeforeCursor(literal.length)
      val converted = seen != null && !seen.endsWith(literal)
      if (converted || attempt >= MAX_POLL_ATTEMPTS) {
        waitForEditor(SETTLE_AFTER_CONVERSION_MS, next)
      } else {
        waitForEditor(POLL_INTERVAL_MS) { awaitLineStartConversion(literal, attempt + 1, next) }
      }
    }

    private fun commitUnits(segmentIndex: Int, units: List<String>, start: Int) {
      // Word runs stay synchronous without consuming one stack frame per grapheme.
      for (unitIndex in start until units.size) {
        if (!canContinue()) return
        val unit = units[unitIndex]
        // A false return can follow an applied prefix: count conservatively before dispatch.
        committedUnits++
        if (!sink.commitChar(unit)) {
          complete(failure("Input connection lost during commit"))
          return
        }
        if (unit == "\n") currentLine.setLength(0) else currentLine.append(unit)
        val hasMore = unitIndex < units.lastIndex || segmentIndex < segments.lastIndex
        val next = { commitUnits(segmentIndex, units, unitIndex + 1) }
        when {
          unit == " " && hasMore && MENTION_BEFORE_SPACE.containsMatchIn(currentLine) -> {
            waitForEditor(SETTLE_AFTER_MENTION_MS, next)
            return
          }
          hasMore && LINE_START_SHORTCUT.matches(currentLine) -> {
            awaitLineStartConversion(currentLine.toString(), 0, next)
            return
          }
          unitIndex < units.lastIndex && !isWordUnit(unit) -> {
            waitForEditor(REALISTIC_TYPING_PAUSE_MS, next)
            return
          }
        }
      }
      if (canContinue()) finishSegment(segmentIndex)
    }
  }

  private fun isWordUnit(unit: String): Boolean =
    unit.isNotEmpty() && unit.codePoints().allMatch { Character.isLetterOrDigit(it) }

  private fun sendKeyEvents(text: String, deadlineMs: Long, isCancelled: () -> Boolean) {
    val units = splitGraphemes(text)
    if (!runCatching { sink.supportsKeyEvents(units) }.getOrDefault(false)) {
      complete(failure("IME key events cannot represent this text; use mode ime for text commit"))
      return
    }
    for (unit in units) {
      if (completed) return
      if (isCancelled()) {
        complete(failure("IME key events cancelled"))
        return
      }
      if (sink.nowMs() >= deadlineMs) {
        complete(failure("IME key event deadline exceeded"))
        return
      }
      // A down event may have reached the editor even if the paired sequence reports failure.
      committedUnits++
      if (!runCatching { sink.sendKeyEventUnit(unit) }.getOrDefault(false)) {
        complete(failure("Input connection lost during IME key events"))
        return
      }
    }
    complete(
      if (sink.syncEditorState()) ImeCommitResult(success = true, error = null)
      else failure("Input connection lost while syncing editor state")
    )
  }

  /** Called by the shell on onFinishInput / idle-deadline; restores if priorImeId is non-null. */
  fun restoreIfNeeded(priorImeId: String?) {
    if (priorImeId != null) sink.switchToIme(priorImeId)
  }

  private data class Segment(val text: String, val trailingSpan: String?)

  private fun failure(error: String) =
    ImeCommitResult(success = false, error = error, partialApplication = committedUnits > 0)

  internal companion object {
    internal fun segmentCount(text: String): Int = splitInlineFormatSpans(text).size

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

    private val INLINE_FORMAT_SPAN =
      Regex("```|`[^`\n]+`|\\*\\*[^*\n]+\\*\\*|~~[^~\n]+~~|\\*[^*\n]+\\*|_[^_\n]+_|~[^~\n]+~")
    const val POLL_INTERVAL_MS = 40L
    const val MAX_POLL_ATTEMPTS = 12
    // Realistic typing pause: let an autoformatting editor react to punctuation and separators.
    // Letter and digit runs remain synchronous.
    const val REALISTIC_TYPING_PAUSE_MS = 45L
    // Realistic typing gives markdown/autoformat shortcuts and mention chips time to settle
    // before the next keystroke, preserving the editor's response to typed input.
    const val SETTLE_AFTER_CONVERSION_MS = 150L
    // A typed @mention is replaced by a mention token after the space; wait for it like a person.
    const val SETTLE_AFTER_MENTION_MS = 400L
    private val MENTION_BEFORE_SPACE = Regex("(^|\\s)@[\\p{L}\\p{N}._-]+ $")
    // Markdown block shortcuts an autoformatting editor converts when a space is typed.
    private val LINE_START_SHORTCUT = Regex("^(>|[-*•+]|\\d+[.)]) $")
  }
}
