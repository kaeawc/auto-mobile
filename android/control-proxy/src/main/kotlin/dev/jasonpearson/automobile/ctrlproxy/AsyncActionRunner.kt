package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Launches a fire-and-forget action coroutine so that a throw *inside* the launched coroutine still
 * yields a correlated failure frame instead of dying silently.
 *
 * [CtrlProxyMessageHandler.handleMessage] dispatches almost every command as fire-and-forget: the
 * action returns `null` immediately and does its real work inside `serviceScope.launch { … }`,
 * broadcasting its own `*_result` later. [WebSocketServer]'s handler `catch` (added in #2985 /
 * PR #3019) only wraps the *synchronous* portion of dispatch, so an exception raised in a launched
 * action coroutine — a screenshot-capture failure, a storage read that throws — escapes to the
 * scope's [kotlinx.coroutines.SupervisorJob] with only a log line. No error frame is emitted and
 * the daemon request awaiting that `requestId` hangs to its `RequestManager` timeout — the exact
 * symptom #2985 set out to eliminate, just on the async path. See issue #3023.
 *
 * Routing those launches through [launch] centralizes the correlated-error-on-throw behavior, so
 * new actions get it for free. Actions that already broadcast a `success:false` result on their own
 * error path are unaffected and need not use this helper.
 *
 * @param scope the (supervisor) scope launched action coroutines run on — `serviceScope` in
 *   production, a `TestScope` in tests.
 * @param broadcastResponse sink for the correlated error frame — `webSocketServer.broadcast(…)` in
 *   production, a capturing lambda in tests.
 * @param logError diagnostic sink; defaults to `Log.e` so tests can stay Android-free by
 *   overriding.
 */
class AsyncActionRunner(
  private val scope: CoroutineScope,
  private val broadcastResponse: suspend (WebSocketResponse) -> Unit,
  private val logError: (String, Throwable) -> Unit = { message, error ->
    Log.e(TAG, message, error)
  },
) {
  /** The shared correlated-error-on-throw core (#3086). */
  private val reporter = CorrelatedErrorReporter(broadcastResponse, logError)

  /**
   * Launch [block] on [scope]. If it throws anything other than a cooperative cancellation,
   * broadcast an [ErrorResponse] correlated by [requestId] so the awaiting client fails fast
   * instead of hanging. See [CorrelatedErrorReporter.guarding] for the semantics.
   *
   * @param requestId correlation id from the originating request; null when the request carried
   *   none (the error frame then carries a null requestId, exactly as the synchronous decode path
   *   does).
   * @param action human-readable action name, surfaced in the error message for triage.
   */
  fun launch(
    requestId: String?,
    action: String,
    block: suspend CoroutineScope.() -> Unit,
  ): Job =
    // Tag the launched coroutine with [RequestIdContext] so that a throwable this handler does
    // *not*
    // catch — a non-[Exception] [Throwable] such as an [Error]/[AssertionError] — still escapes
    // with
    // the correlation id attached, letting the scope-level [ServiceScopeGuard] emit a *correlated*
    // error frame instead of a null-id one. The common `Exception` case is handled by the reporter.
    scope.launch(RequestIdContext(requestId)) {
      val launchScope = this
      reporter.guarding(
        requestId = requestId,
        failureLogMessage = { "Async action '$action' failed (requestId=$requestId)" },
        errorMessagePrefix = { "Action '$action' failed" },
        doubleFailureLogMessage = {
          "Failed to broadcast async error for action '$action' (requestId=$requestId)"
        },
      ) {
        block(launchScope)
      }
    }

  companion object {
    private const val TAG = "AsyncActionRunner"
  }
}
