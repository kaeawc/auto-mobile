package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException

/**
 * Guards a result broadcast so that a throw while *sending* a result still yields a correlated
 * failure frame instead of being logged and swallowed.
 *
 * Every `broadcast*Result` / `broadcast*Error` / `broadcast*Response` helper in [CtrlProxy]
 * historically wrapped its `webSocketServer.broadcast(...)` (or `broadcastWithPerf { … }`) in a
 * local `try { … } catch (e: Exception) { Log.e(…) }`. If that inner broadcast — or the
 * serialization that builds its message — threw, the helper emitted nothing and the daemon request
 * awaiting that `requestId` hung to its `RequestManager` timeout. This is the same silent-hang
 * class that [AsyncActionRunner] / #2985 closed on the dispatch and async-launch paths, one layer
 * further down (the throw is caught-and-swallowed *inside* the helper, so [AsyncActionRunner] never
 * sees it). See issue #3045.
 *
 * Routing every result broadcast through [guard] centralizes the correlated-error-on-throw
 * behavior: a broadcast failure emits a best-effort [ErrorResponse] keyed by the originating
 * `requestId`, which the daemon fans into both `RequestManager.resolveError` and the hierarchy wait
 * (see `AndroidCtrlProxyClient.handleWebSocketMessage`), failing the awaiter fast instead of
 * hanging.
 *
 * @param broadcastError sink for the correlated fallback frame — `webSocketServer.broadcast(…)` in
 *   production (lazily resolving the `lateinit` server, exactly like [AsyncActionRunner]), a
 *   capturing lambda in tests.
 * @param logError diagnostic sink; defaults to `Log.e` so tests can stay Android-free by
 *   overriding.
 */
class ResultBroadcaster(
  private val broadcastError: suspend (ErrorResponse) -> Unit,
  private val logError: (String, Throwable) -> Unit = { message, error ->
    Log.e(TAG, message, error)
  },
) {
  /**
   * Run [block] (which performs the actual result broadcast). If it throws anything other than a
   * cooperative [CancellationException], broadcast an [ErrorResponse] correlated by [requestId] so
   * the awaiting client fails fast instead of hanging.
   *
   * @param requestId correlation id from the originating request; null when the request carried
   *   none (the fallback frame then carries a null requestId, exactly as the synchronous decode
   *   path does — `resolveError` no-ops on an absent id).
   * @param action human-readable action / result-type name, surfaced in the error message for
   *   triage.
   */
  suspend fun guard(requestId: String?, action: String, block: suspend () -> Unit) {
    try {
      block()
    } catch (e: CancellationException) {
      // Cooperative cancellation means the service scope is shutting down — never convert it into a
      // client-facing error frame; let it propagate so the coroutine unwinds cleanly.
      throw e
    } catch (e: Exception) {
      val cause = e.message ?: e::class.simpleName ?: "unknown error"
      logError("Error broadcasting $action (requestId=$requestId)", e)
      try {
        broadcastError(
          ErrorResponse(requestId = requestId, error = "Broadcast failed for $action: $cause")
        )
      } catch (fallbackError: CancellationException) {
        throw fallbackError
      } catch (fallbackError: Exception) {
        // A failure while reporting the broadcast failure must not escape (which would let the
        // exception bubble to the launched coroutine and defeat the fix). Log and swallow — the
        // client then falls back to its timeout, but only for this genuinely-unrecoverable
        // double-failure tail.
        logError(
          "Failed to broadcast fallback error for $action (requestId=$requestId)",
          fallbackError,
        )
      }
    }
  }

  companion object {
    private const val TAG = "ResultBroadcaster"
  }
}
