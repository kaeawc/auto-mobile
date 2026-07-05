package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Builds the [CoroutineExceptionHandler] installed on `serviceScope` so that *any* exception
 * escaping a fire-and-forget `serviceScope.launch { … }` still yields a correlated `type:"error"`
 * frame instead of dying silently on the scope's [kotlinx.coroutines.SupervisorJob] and hanging the
 * daemon awaiter to its `RequestManager` timeout.
 *
 * This closes the raw-launch half of the silent-hang gap **by construction** (issue #3104),
 * complementing the two sibling seams that centralize the same guarantee on their own paths:
 * [AsyncActionRunner] (a throw inside a launched action coroutine, #3023) and [ResultBroadcaster]
 * (a throw while *sending* a result, #3045). Those two only cover launches routed through them; a
 * brand-new action dispatched via a *raw* `serviceScope.launch` that throws before reaching its
 * guarded broadcast is invisible to both — and to the #3085 source-scanning backstop, which cannot
 * distinguish such an action from the ~30 legitimate raw launches without false positives.
 * Installing the handler on the scope itself catches every one of them for free.
 *
 * A side benefit: an uncaught exception in a scope-root `launch` is otherwise delivered to the
 * platform's default handler, which on Android crashes the process. Routing it here logs it and
 * emits a best-effort frame instead.
 *
 * The correlation id is recovered from a [RequestIdContext] element on the failed coroutine's
 * context when present; absent it, the frame carries a null requestId (a safe no-op on the daemon,
 * exactly as the synchronous decode path does) and still leaves a log trace.
 *
 * @param emitScope supplies the scope the best-effort fallback broadcast is re-launched on. A
 *   [CoroutineExceptionHandler] runs synchronously on the failing thread, so the suspend broadcast
 *   must be dispatched onto a live scope — `serviceScope` in production (resolved lazily to break
 *   the scope↔handler construction cycle), a `TestScope` in tests.
 * @param broadcastResponse sink for the correlated error frame — `webSocketServer.broadcast(…)` in
 *   production (lazily resolving the `lateinit` server, exactly like [AsyncActionRunner]), a
 *   capturing lambda in tests.
 * @param logError diagnostic sink; defaults to `Log.e` so tests can stay Android-free by
 *   overriding.
 */
class ServiceScopeGuard(
  private val emitScope: () -> CoroutineScope,
  private val broadcastResponse: suspend (WebSocketResponse) -> Unit,
  private val logError: (String, Throwable) -> Unit = { message, error ->
    Log.e(TAG, message, error)
  },
) {

  /**
   * The handler to add to the `serviceScope` context. On any uncaught throwable other than a
   * cooperative [CancellationException], it logs the failure and re-launches a best-effort
   * [ErrorResponse] broadcast correlated by the [RequestIdContext] on the failed coroutine's
   * context.
   */
  val handler: CoroutineExceptionHandler = CoroutineExceptionHandler { context, throwable ->
    // Defense-in-depth: kotlinx never routes a CancellationException here, but a cooperative
    // cancellation must never be converted into a client-facing error frame if it ever did.
    if (throwable is CancellationException) return@CoroutineExceptionHandler

    val requestId = context[RequestIdContext]?.requestId
    val cause = throwable.message ?: throwable::class.simpleName ?: "unknown error"
    logError("Uncaught exception in a serviceScope launch (requestId=$requestId)", throwable)

    emitScope().launch {
      try {
        broadcastResponse(
          ErrorResponse(requestId = requestId, error = "Uncaught async failure: $cause")
        )
      } catch (broadcastError: CancellationException) {
        throw broadcastError
      } catch (broadcastError: Exception) {
        // A failure while reporting the uncaught exception must not escape — it would re-enter this
        // same handler and loop. Log and swallow; the client then falls back to its timeout, but
        // only for this genuinely-unrecoverable double-failure tail.
        logError(
          "Failed to broadcast uncaught-exception error frame (requestId=$requestId)",
          broadcastError,
        )
      }
    }
  }

  companion object {
    private const val TAG = "ServiceScopeGuard"
  }
}
