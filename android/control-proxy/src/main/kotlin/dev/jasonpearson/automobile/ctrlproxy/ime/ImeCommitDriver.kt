package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import dev.jasonpearson.automobile.protocol.ImeTextDelivery

interface ImeCommitSink {
  /** Changes on every input start and finish, including same-editor restarts. */
  fun connectionGeneration(): Long

  /** Stable editor metadata, or null between finish and start. */
  fun editorIdentity(): String?

  fun startedByRestart(): Boolean

  /** Null means the editor did not answer, including a superseded session. */
  fun readEditorTextBeforeCursor(maxChars: Int): String?

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
  val insertedText: String? = null,
  val trace: List<String>? = null,
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
  private val trace: ImeDriverTrace = ImeDriverTrace.NONE,
) {
  // Kotlin trailing lambdas bind only to the last parameter: retain the original overload.
  constructor(
    sink: ImeCommitSink,
    splitGraphemes: (String) -> List<String>,
  ) : this(sink, splitGraphemes, ImeDriverTrace.NONE)

  private var terminalDecisionTraced = false

  private fun record(event: String, vararg fields: Pair<String, Any?>) {
    if (
      event == "decision" &&
        fields.any { it.first == "kind" && (it.second == "fail" || it.second == "succeed") }
    )
      terminalDecisionTraced = true
    runCatching { trace.record(event, fields) }
  }

  private var completed = false
  private var committedUnits = 0
  private var completion: ((ImeCommitResult) -> Unit)? = null
  private var restoreId: String? = null
  private var hardDeadlineMs = Long.MAX_VALUE
  private var insertedText: (() -> String?)? = null
  private var reportInsertedText = true
  private var secureInput = false

  /**
   * Stops scheduled polls and reports the outcome exactly once before the caller restores the IME.
   */
  fun cancel(reason: String = "IME commit cancelled") {
    complete(failure(reason))
  }

  private fun complete(result: ImeCommitResult, readDelta: Boolean = true) {
    if (completed) return
    completed = true
    // Editor writes are oneway; a failed request may have already issued some of them.
    // Keep the result partial when the round-trip cannot confirm quiescence.
    val outcome =
      if (
        !result.success &&
          committedUnits > 0 &&
          sink.nowMs() < hardDeadlineMs &&
          !sink.syncEditorState()
      )
        result.copy(partialApplication = true)
      else result
    val delta =
      if (!reportInsertedText) null
      else outcome.insertedText ?: if (readDelta) insertedText?.invoke() else null
    restoreIfNeeded(restoreId)
    if (!terminalDecisionTraced)
      record(
        "decision",
        "kind" to if (outcome.success) "succeed" else "fail",
        "reason" to if (outcome.success) null else failureCode(outcome.error),
      )
    record(
      "complete",
      "success" to outcome.success,
      "partial" to outcome.partialApplication,
      "committedUnits" to committedUnits,
      "code" to if (outcome.success) "ok" else failureCode(outcome.error),
    )
    completion?.invoke(outcome.copy(committedUnits = committedUnits, insertedText = delta))
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
    hardDeadlineMs: Long = Long.MAX_VALUE,
    onComplete: (ImeCommitResult) -> Unit,
  ) {
    check(completion == null) { "An IME commit driver handles one request" }
    completion = onComplete
    restoreId = priorImeId
    this.hardDeadlineMs = hardDeadlineMs
    if (isCancelled()) {
      complete(failure("IME commit cancelled"))
      return
    }
    if (sink.nowMs() >= minOf(deadlineMs, hardDeadlineMs)) {
      complete(failure("IME commit deadline exceeded"))
      return
    }

    val inputType = sink.editorInputType()
    secureInput = isPasswordInput(inputType)
    if (inputType == null) {
      complete(failure("No active input connection"))
      return
    }
    // Password fields commit like any other field (owner decision 2026-10-07: this is a local,
    // user-operated debug tool). The typed text is never formatted into a log or error here.

    if (delivery == ImeTextDelivery.KEY_EVENTS) {
      sendKeyEvents(text, minOf(deadlineMs, hardDeadlineMs), isCancelled)
      return
    }

    reportInsertedText = !isPasswordInput(sink.editorInputType())
    val sequence = CommitSequence(text, deadlineMs, isCancelled)
    insertedText = sequence::readInsertedText
    sequence.commitSegment(0)
  }

  /** Realistic typing pauses and conversion state belong to this request's continuations. */
  private inner class CommitSequence(
    private val text: String,
    private val deadlineMs: Long,
    private val isCancelled: () -> Boolean,
  ) {
    private val segments = splitInlineFormatSpans(text)
    private val segmentUnits = segments.map { splitGraphemes(it.text) }
    private val dispatched = mutableListOf<ExpectedUnit>()
    // Request progress remains independent of the editor expectation after a rejected unit.
    private var dispatchedPosition = 0
    private val totalUnits = segmentUnits.sumOf { it.size }
    private val postDispatch: Boolean
      get() = dispatchedPosition == totalUnits

    private var generation = sink.connectionGeneration()
    private val identity = sink.editorIdentity()
    private val baseline =
      sink.readEditorTextBeforeCursor(EDITOR_READ_CAP)?.takeIf { it.length < EDITOR_READ_CAP }
    private var resumes = 0
    private var lastResumePosition = -1
    private val rejectedUnitTexts = mutableSetOf<String>()
    private val currentLine = StringBuilder()
    private var settleWaitMs = 0L

    private fun canContinue(): Boolean {
      if (completed) return false
      val error =
        when {
          isCancelled() -> "IME commit cancelled"
          sink.nowMs() >= effectiveDeadlineMs() -> "IME commit deadline exceeded"
          else -> return true
        }
      complete(failure(error))
      return false
    }

    private fun effectiveDeadlineMs(): Long =
      minOf(
        hardDeadlineMs,
        if (deadlineMs >= Long.MAX_VALUE - settleWaitMs) Long.MAX_VALUE
        else deadlineMs + settleWaitMs,
      )

    private fun remainingMs(): Long = effectiveDeadlineMs() - sink.nowMs()

    private fun checkpoint(next: () -> Unit): Boolean {
      if (!canContinue()) return false
      val currentGeneration = sink.connectionGeneration()
      if (currentGeneration != generation) {
        record(
          "reconcileStarted",
          "reason" to "generationChanged",
          "postDispatch" to postDispatch,
          "fromGen" to generation,
          "toGen" to currentGeneration,
        )
        val waitMs =
          if (postDispatch) FINAL_VERIFY_ATTEMPTS * POLL_INTERVAL_MS
          else CtrlProxyIme.INPUT_CONNECTION_TIMEOUT_MS
        reconnect(minOf(effectiveDeadlineMs(), sink.nowMs() + waitMs), next)
        return false
      }
      return true
    }

    fun readInsertedText(): String? {
      if (
        !reportInsertedText ||
          baseline == null ||
          sink.editorIdentity() != identity ||
          sink.nowMs() >= hardDeadlineMs
      )
        return null
      return editorDelta(sink.readEditorTextBeforeCursor(EDITOR_READ_CAP))
    }

    private fun editorDelta(now: String?): String? = editorDelta(baseline, now)

    private fun succeed(delta: String? = null, decisionTraced: Boolean = false) {
      if (!decisionTraced) record("decision", "kind" to "succeed")
      // Null is deliberate evidence of an unverifiable commit, not a request for another read.
      complete(ImeCommitResult(true, null, insertedText = delta), readDelta = false)
    }

    private fun reconnect(waitDeadlineMs: Long, next: () -> Unit) {
      if (!canContinue()) return
      val currentIdentity = sink.editorIdentity()
      when {
        currentIdentity == null -> pollReconnect(waitDeadlineMs, next)
        currentIdentity != identity -> {
          if (postDispatch) succeed()
          else {
            record("decision", "kind" to "fail", "reason" to "identityChanged")
            complete(failure(DISCONNECTED_ERROR))
          }
        }
        baseline == null -> applyReconciliation(null, next)
        else -> reconcileReadBack(waitDeadlineMs, next)
      }
    }

    private fun pollReconnect(waitDeadlineMs: Long, next: () -> Unit) {
      val remaining = minOf(waitDeadlineMs, effectiveDeadlineMs()) - sink.nowMs()
      if (remaining <= 0) {
        if (postDispatch) succeed()
        else {
          record("decision", "kind" to "fail", "reason" to "disconnected")
          complete(failure(DISCONNECTED_ERROR))
        }
        return
      }
      record("reconcileWait", "reason" to "identityNull")
      sink.postDelayed(minOf(CtrlProxyIme.INPUT_CONNECTION_POLL_MS, remaining)) {
        reconnect(waitDeadlineMs, next)
      }
    }

    private fun reconcileReadBack(waitDeadlineMs: Long, next: () -> Unit) {
      val now = sink.readEditorTextBeforeCursor(EDITOR_READ_CAP)
      if (!canContinue()) return
      if (sink.editorIdentity() != identity) {
        reconnect(waitDeadlineMs, next)
        return
      }
      if (now == null && !postDispatch && sink.nowMs() < waitDeadlineMs) {
        record("reconcileWait", "reason" to "readNull")
        sink.postDelayed(
          minOf(CtrlProxyIme.INPUT_CONNECTION_POLL_MS, waitDeadlineMs - sink.nowMs()),
        ) {
          reconnect(waitDeadlineMs, next)
        }
        return
      }
      applyReconciliation(now, next)
    }

    private fun applyReconciliation(now: String?, next: () -> Unit) {
      val startedByRestart = sink.startedByRestart()
      val expected = dispatched.map { it.text }
      val lastResumeConfirmed = dispatched.indexOfLast { it.requestPosition <= lastResumePosition }
      val decision =
        reconcileDecision(
          postDispatch,
          startedByRestart,
          baseline,
          now,
          expected,
          // Express the last resent request position in the remaining expectation's indices.
          lastResumeConfirmed,
        )
      generation = sink.connectionGeneration()
      val delta = editorDelta(now)
      val confirmed = delta?.let { confirmedUnits(it, expected) }
      record(
        "readBack",
        "baselineLength" to if (secureInput) null else baseline?.length,
        "nowLength" to if (secureInput) null else now?.length,
        "nowNull" to if (now == null) true else null,
        "deltaLength" to if (secureInput) null else delta?.length,
        "dispatchedCount" to dispatched.size,
        "confirmed" to (confirmed ?: "none"),
        "startedByRestart" to startedByRestart,
        "postDispatch" to postDispatch,
        "lastResumeConfirmed" to lastResumeConfirmed,
        "secure" to if (secureInput) true else null,
      )
      record(
        "decision",
        "kind" to
          when (decision) {
            Reconciliation.Continue -> "continue"
            is Reconciliation.DropRejected -> "dropRejected"
            is Reconciliation.Resume -> "resume"
            is Reconciliation.Fail -> "fail"
            is Reconciliation.Succeed -> "succeed"
          },
        "confirmed" to confirmed,
        "reason" to if (decision is Reconciliation.Fail) failureCode(decision.error) else null,
      )
      when (decision) {
        Reconciliation.Continue -> next()
        is Reconciliation.DropRejected -> {
          dropRejected(decision.confirmed, now)
          next()
        }
        is Reconciliation.Resume -> reconcileMissingUnit(decision.confirmed, now, next)
        is Reconciliation.Fail ->
          complete(failure(decision.error).copy(insertedText = decision.delta))
        is Reconciliation.Succeed -> succeed(decision.delta, decisionTraced = true)
      }
    }

    private fun reconcileMissingUnit(confirmed: Int, now: String?, next: () -> Unit) {
      if (dispatched[confirmed].text in rejectedUnitTexts) {
        dropRejected(confirmed, now)
        next()
      } else {
        resumeFrom(confirmed, now)
      }
    }

    private fun dropRejected(confirmed: Int, now: String?) {
      val rejected = dispatched[confirmed]
      record("dropRejected", "index" to rejected.requestPosition)
      rejectedUnitTexts.add(rejected.text)
      // Only recovered losses consume the budget. Each request position is still resent at
      // most once (lastResumePosition is monotonic), bounding rejected resends by unit count.
      if (rejected.requestPosition == lastResumePosition) resumes--
      retainConfirmed(confirmed, now)
    }

    private fun resumeFrom(confirmed: Int, now: String?) {
      val applied = requireNotNull(editorDelta(now))
      if (resumes >= MAX_RESUMES) {
        record("decision", "kind" to "fail", "reason" to "resumeLimit", "confirmed" to confirmed)
        complete(
          failure("Editor restarted its input connection during IME commit; resume limit exceeded")
            .copy(insertedText = applied),
        )
        return
      }
      resumes++
      val requestPosition = dispatched[confirmed].requestPosition
      record("resend", "index" to requestPosition, "resumes" to resumes)
      lastResumePosition = requestPosition
      retainConfirmed(confirmed, now)
      dispatchedPosition = requestPosition
      committedUnits = requestPosition
      // A retained prefix cannot tell us whether a newline submitted the editor. The one
      // permitted resend can repeat that action; there is no safe consumed-action signal.
      resumeAt(requestPosition)
    }

    private fun retainConfirmed(confirmed: Int, now: String?) {
      while (dispatched.size > confirmed) dispatched.removeAt(dispatched.lastIndex)
      currentLine.setLength(0)
      currentLine.append(requireNotNull(editorDelta(now)).substringAfterLast('\n'))
    }

    private fun resumeAt(requestPosition: Int) {
      var offset = 0
      for ((index, units) in segmentUnits.withIndex()) {
        if (requestPosition < offset + units.size) {
          commitUnits(index, units, requestPosition - offset)
          return
        }
        offset += units.size
      }
      syncCommit()
    }

    private fun syncCommit(attempt: Int = 0) {
      if (!checkpoint { syncCommit(attempt) }) return
      if (sink.syncEditorState()) {
        verifyFinalText(0)
        return
      }
      if (!checkpoint { syncCommit(attempt) }) return
      // Preserve #10799's bounded retry on the current connection.
      if (
        attempt >= SYNC_RETRY_ATTEMPTS ||
          remainingMs() < SYNC_RETRY_DELAY_MS + SYNC_RETRY_RESERVE_MS
      ) {
        complete(failure(SYNC_LOST_ERROR))
        return
      }
      sink.postDelayed(SYNC_RETRY_DELAY_MS) { syncCommit(attempt + 1) }
    }

    private fun verifyFinalText(
      attempt: Int,
      nullReadDeadlineMs: Long = sink.nowMs() + CtrlProxyIme.INPUT_CONNECTION_TIMEOUT_MS,
    ) {
      if (!checkpoint { verifyFinalText(attempt, nullReadDeadlineMs) }) return
      if (baseline == null) {
        succeed()
        return
      }
      val now = sink.readEditorTextBeforeCursor(EDITOR_READ_CAP)
      if (!checkpoint { verifyFinalText(attempt, nullReadDeadlineMs) }) return
      when {
        now == baseline + text -> succeed(editorDelta(now))
        now == null && sink.nowMs() < nullReadDeadlineMs -> {
          waitForEditor(minOf(POLL_INTERVAL_MS, nullReadDeadlineMs - sink.nowMs())) {
            verifyFinalText(attempt + 1, nullReadDeadlineMs)
          }
        }
        now == null || attempt >= FINAL_VERIFY_ATTEMPTS -> succeed(editorDelta(now))
        else -> waitForEditor(POLL_INTERVAL_MS) { verifyFinalText(attempt + 1, nullReadDeadlineMs) }
      }
    }

    private fun waitForEditor(delayMs: Long, next: () -> Unit) {
      val boundedDelayMs = minOf(delayMs, hardDeadlineMs - sink.nowMs()).coerceAtLeast(0)
      settleWaitMs += boundedDelayMs
      sink.postDelayed(boundedDelayMs) { if (checkpoint(next)) next() }
    }

    fun commitSegment(index: Int) {
      if (!checkpoint { commitSegment(index) }) return
      if (index == segments.size) {
        syncCommit()
        return
      }
      commitUnits(index, segmentUnits[index], 0)
    }

    private fun finishSegment(index: Int) {
      if (!checkpoint { finishSegment(index) }) return
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
      if (!checkpoint { pollInlineConversion(literal, attempt, next) }) return
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
      if (!checkpoint { awaitLineStartConversion(literal, attempt, next) }) return
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
        if (!checkpoint { commitUnits(segmentIndex, units, unitIndex) }) return
        val unit = units[unitIndex]
        // A false return can follow an applied prefix: count conservatively before dispatch.
        committedUnits++
        record(
          "unitDispatched",
          "index" to dispatchedPosition,
          "kind" to if (secureInput) null else unitKind(unit),
          "length" to if (secureInput) null else unit.length,
          "secure" to if (secureInput) true else null,
        )
        dispatched.add(ExpectedUnit(unit, dispatchedPosition++))
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

  private fun unitKind(unit: String): String =
    when {
      unit == "\n" -> "newline"
      unit == " " -> "space"
      isWordUnit(unit) -> "word"
      unit.length == 1 && unit[0] in '!'..'~' -> "punct"
      else -> "other"
    }

  private fun sendKeyEvents(text: String, deadlineMs: Long, isCancelled: () -> Boolean) {
    val units = splitGraphemes(text)
    if (!runCatching { sink.supportsKeyEvents(units) }.getOrDefault(false)) {
      complete(failure("IME key events cannot represent this text; use mode ime for text commit"))
      return
    }
    for ((index, unit) in units.withIndex()) {
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
      record(
        "unitDispatched",
        "index" to index,
        "kind" to if (secureInput) null else unitKind(unit),
        "length" to if (secureInput) null else unit.length,
        "delivery" to if (secureInput) null else "keyEvents",
        "secure" to if (secureInput) true else null,
      )
      if (!runCatching { sink.sendKeyEventUnit(unit) }.getOrDefault(false)) {
        complete(failure("Input connection lost during IME key events"))
        return
      }
    }
    syncAfterDispatch(
      isCancelled,
      remainingMs = {
        if (deadlineMs == Long.MAX_VALUE) Long.MAX_VALUE else deadlineMs - sink.nowMs()
      },
    )
  }

  /**
   * Every unit has been dispatched; only the quiescence barrier remains. Under load the editor can
   * take longer than one bounded sync round-trip to drain the queued ops, or the connection can be
   * re-bound right after the last unit (#10799). Each attempt re-reads the current connection, so a
   * bounded retry turns that transient loss into a confirmed commit. The retry never starts unless
   * a whole sync round-trip still fits before the request deadline.
   */
  private fun syncAfterDispatch(
    isCancelled: () -> Boolean,
    remainingMs: () -> Long,
    attempt: Int = 0,
  ) {
    if (completed) return
    if (sink.nowMs() >= hardDeadlineMs) {
      complete(failure("IME commit deadline exceeded"))
      return
    }
    if (sink.syncEditorState()) {
      complete(ImeCommitResult(success = true, error = null))
      return
    }
    val canRetry =
      attempt < SYNC_RETRY_ATTEMPTS &&
        !isCancelled() &&
        remainingMs() >= SYNC_RETRY_DELAY_MS + SYNC_RETRY_RESERVE_MS
    if (!canRetry) {
      complete(failure(SYNC_LOST_ERROR))
      return
    }
    sink.postDelayed(SYNC_RETRY_DELAY_MS) {
      syncAfterDispatch(isCancelled, remainingMs, attempt + 1)
    }
  }

  /** Called by the shell on onFinishInput / idle-deadline; restores if priorImeId is non-null. */
  fun restoreIfNeeded(priorImeId: String?) {
    if (priorImeId != null) sink.switchToIme(priorImeId)
  }

  internal sealed interface Reconciliation {
    data object Continue : Reconciliation

    data class Resume(val confirmed: Int) : Reconciliation

    data class DropRejected(val confirmed: Int) : Reconciliation

    data class Fail(val error: String, val delta: String?) : Reconciliation

    data class Succeed(val delta: String?) : Reconciliation
  }

  private data class ExpectedUnit(val text: String, val requestPosition: Int)

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
    /**
     * Emitted only after every unit was dispatched; the host re-reads the editor on this error
     * (#10799).
     */
    const val SYNC_LOST_ERROR = "Input connection lost while syncing editor state"
    private const val EDITOR_READ_CAP = 20_000
    private const val MAX_RESUMES = 3
    private const val FINAL_VERIFY_ATTEMPTS = 6
    private const val DISCONNECTED_ERROR = "Editor disconnected during IME commit"
    private const val NONE_APPLIED_ERROR =
      "Editor restarted its input connection during IME commit; none of the dispatched text is in the editor"

    private fun failureCode(error: String?): String =
      when (error) {
        NONE_APPLIED_ERROR -> "noneApplied"
        DISCONNECTED_ERROR -> "disconnected"
        SYNC_LOST_ERROR -> "syncLost"
        "Editor restarted its input connection during IME commit; resume limit exceeded" ->
          "resumeLimit"
        "IME commit cancelled",
        "IME key events cancelled" -> "cancelled"
        "IME commit deadline exceeded",
        "IME key event deadline exceeded" -> "deadline"
        "No active input connection" -> "noConnection"
        "Input connection lost during commit",
        "Input connection lost during IME key events",
        "Input connection lost while finishing composition" -> "connectionLost"
        "IME key events cannot represent this text; use mode ime for text commit" -> "unsupported"
        else -> "other"
      }

    private fun editorDelta(baseline: String?, now: String?): String? =
      if (
        baseline != null && now != null && now.length < EDITOR_READ_CAP && now.startsWith(baseline)
      )
        now.removePrefix(baseline)
      else null

    private fun confirmedUnits(applied: String, dispatched: List<String>): Int? {
      var length = 0
      if (applied.isEmpty()) return 0
      for ((index, unit) in dispatched.withIndex()) {
        if (!applied.startsWith(unit, length)) return null
        length += unit.length
        if (length == applied.length) return index + 1
      }
      return null
    }

    /** Resend only a visible non-empty strict prefix that advances beyond the previous resume. */
    internal fun reconcileDecision(
      postDispatch: Boolean,
      startedByRestart: Boolean,
      baseline: String?,
      now: String?,
      dispatched: List<String>,
      lastResumeConfirmed: Int = -1,
    ): Reconciliation {
      val delta = editorDelta(baseline, now)
      val confirmed = delta?.let { confirmedUnits(it, dispatched) }
      return when {
        confirmed == dispatched.size ->
          if (postDispatch) Reconciliation.Succeed(delta) else Reconciliation.Continue
        confirmed != null && confirmed > 0 ->
          when {
            confirmed > lastResumeConfirmed -> Reconciliation.Resume(confirmed)
            postDispatch -> Reconciliation.Succeed(delta)
            else -> Reconciliation.DropRejected(confirmed)
          }
        postDispatch -> Reconciliation.Succeed(delta)
        confirmed == 0 -> Reconciliation.Fail(NONE_APPLIED_ERROR, delta)
        startedByRestart -> Reconciliation.Continue
        else -> Reconciliation.Fail(DISCONNECTED_ERROR, delta)
      }
    }

    internal fun isPasswordInput(inputType: Int?): Boolean {
      if (inputType == null) return false
      val variation = inputType and InputType.TYPE_MASK_VARIATION
      return when (inputType and InputType.TYPE_MASK_CLASS) {
        InputType.TYPE_CLASS_TEXT ->
          variation in
            listOf(
              InputType.TYPE_TEXT_VARIATION_PASSWORD,
              InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
              InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            )
        InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
        else -> false
      }
    }

    const val SYNC_RETRY_ATTEMPTS = 2
    const val SYNC_RETRY_DELAY_MS = 100L
    // One sync round-trip blocks for at most CtrlProxyIme's 2s sync timeout; keep a margin so a
    // retry cannot outlive the request deadline the host is waiting on.
    const val SYNC_RETRY_RESERVE_MS = 2_500L
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
