package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException

/**
 * The single canonical implementation of *"a throw on a requestId-correlated path must become a
 * correlated `type:"error"` frame, never a silent hang"*.
 *
 * Three seams close that hang-class on three different paths, and each one used to hand-roll the
 * same body:
 * - [AsyncActionRunner] (#3023) — a throw *inside* a launched action coroutine.
 * - [ResultBroadcaster] (#3045) — a throw while *sending* a result.
 * - [ServiceScopeGuard] (#3104) — a throw escaping a *raw* `serviceScope.launch { … }`.
 *
 * Issue #3086 filed the duplication as a deliberate YAGNI defer while there were only two
 * consumers, and named the trigger to act: a third consumer, or the first observed drift. The third
 * consumer arrived. The risk the issue actually tracked is that nothing *forced* the copies to stay
 * in lock-step — a fix to one catch-body (changing the cause derivation, folding the requestId into
 * the message, adjusting cancellation handling) would silently leave the others behind. That risk
 * is now structural: this type is the one place the body lives, and `CorrelatedErrorDriftGuardTest`
 * fails CI if a consumer starts hand-rolling it again.
 *
 * Three layers, because the consumers enter at different points:
 * - [guarding] — run a block, report anything it throws. Used by [ResultBroadcaster] and
 *   [AsyncActionRunner].
 * - [report] — log an *already-caught* throwable, then emit its frame.
 * - [emit] + [causeOf] — the frame-emitting tail and the cause rule on their own, for
 *   [ServiceScopeGuard]: a [kotlinx.coroutines.CoroutineExceptionHandler] is handed a throwable
 *   rather than a block, and must log synchronously (see [emit]).
 *
 * @param broadcastError sink for the correlated fallback frame — `webSocketServer.broadcast(…)` in
 *   production (lazily resolving the `lateinit` server), a capturing lambda in tests.
 * @param logError diagnostic sink; `Log.e` in production, a capturing lambda in tests. This type
 *   holds no Android dependency of its own so it stays unit-testable.
 */
class CorrelatedErrorReporter(
  private val broadcastError: suspend (ErrorResponse) -> Unit,
  private val logError: (String, Throwable) -> Unit,
) {

  /**
   * Run [block]. If it throws anything other than a cooperative [CancellationException], [report]
   * the failure as a correlated error frame.
   *
   * A [CancellationException] always propagates: cooperative cancellation means the scope is
   * shutting down, and converting it into a client-facing error frame would report a shutdown as a
   * request failure.
   *
   * @param requestId correlation id from the originating request; null when the request carried
   *   none (the frame then carries a null requestId, exactly as the synchronous decode path does —
   *   `resolveError` no-ops on an absent id).
   * @param failureLogMessage what to log when [block] throws.
   * @param errorMessagePrefix prefix for the client-facing error text; the derived cause is
   *   appended as `"$errorMessagePrefix: $cause"`.
   * @param doubleFailureLogMessage what to log if the fallback broadcast *itself* throws.
   */
  suspend fun guarding(
    requestId: String?,
    failureLogMessage: String,
    errorMessagePrefix: String,
    doubleFailureLogMessage: String,
    block: suspend () -> Unit,
  ) {
    try {
      block()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      report(
        requestId = requestId,
        throwable = e,
        failureLogMessage = failureLogMessage,
        errorMessagePrefix = errorMessagePrefix,
        doubleFailureLogMessage = doubleFailureLogMessage,
      )
    }
  }

  /**
   * Log [throwable] and emit a best-effort [ErrorResponse] correlated by [requestId], so the
   * awaiting client fails fast instead of hanging to its `RequestManager` timeout.
   *
   * Best-effort is load-bearing: a failure raised while *reporting* the failure must not escape.
   * Letting it out would defeat the entire guarantee — it would bubble to the launched coroutine
   * (or, for [ServiceScopeGuard], re-enter the handler and loop). It is logged and swallowed; the
   * client then falls back to its timeout, but only for this genuinely-unrecoverable double-failure
   * tail. A [CancellationException] from the fallback still propagates, for the same reason as in
   * [guarding].
   */
  suspend fun report(
    requestId: String?,
    throwable: Throwable,
    failureLogMessage: String,
    errorMessagePrefix: String,
    doubleFailureLogMessage: String,
  ) {
    logError(failureLogMessage, throwable)
    emit(
      requestId = requestId,
      errorMessage = "$errorMessagePrefix: ${causeOf(throwable)}",
      doubleFailureLogMessage = doubleFailureLogMessage,
    )
  }

  /**
   * The emit tail of [report], split out for [ServiceScopeGuard]. That consumer must log
   * *synchronously* on the failing thread — a [kotlinx.coroutines.CoroutineExceptionHandler] cannot
   * suspend, so it dispatches this broadcast onto a scope, and folding the log in here would lose
   * the diagnostic entirely whenever that scope is already shut down.
   *
   * Emits a best-effort [ErrorResponse] correlated by [requestId]. Best-effort is load-bearing: see
   * [report].
   */
  suspend fun emit(requestId: String?, errorMessage: String, doubleFailureLogMessage: String) {
    try {
      broadcastError(ErrorResponse(requestId = requestId, error = errorMessage))
    } catch (fallbackError: CancellationException) {
      throw fallbackError
    } catch (fallbackError: Exception) {
      logError(doubleFailureLogMessage, fallbackError)
    }
  }

  companion object {
    /**
     * The one cause-derivation rule: the throwable's message, else its simple class name, else a
     * constant. Shared so a consumer that logs the cause itself cannot derive it differently.
     */
    fun causeOf(throwable: Throwable): String =
      throwable.message ?: throwable::class.simpleName ?: "unknown error"
  }
}
