package dev.jasonpearson.automobile.ctrlproxy

import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * A [CoroutineContext] element carrying the originating request's correlation id into a
 * fire-and-forget `serviceScope.launch { … }`, so [ServiceScopeGuard]'s [CoroutineExceptionHandler]
 * can emit a *correlated* error frame when that launch throws uncaught.
 *
 * Mirrors [kotlinx.coroutines.CoroutineName]: attach it at the launch site of a
 * requestId-correlated action dispatched via a raw launch (i.e. not through [AsyncActionRunner],
 * which already threads the id itself):
 * ```
 * serviceScope.launch(RequestIdContext(requestId)) {
 *   val result = doExpensiveActionAsync() // may throw before the guarded broadcast is reached
 *   broadcastActionResult(requestId, result)
 * }
 * ```
 *
 * When absent, [ServiceScopeGuard] still emits a best-effort error frame with a null requestId — a
 * safe no-op on the daemon (`AndroidCtrlProxyClient` only resolves when the id is present) — plus a
 * log trace, so a raw launch that forgot to thread the id never dies silently.
 *
 * @param requestId correlation id from the originating request; null when the request carried none.
 */
class RequestIdContext(val requestId: String?) : AbstractCoroutineContextElement(RequestIdContext) {

  /** Key identifying this element in a [CoroutineContext]; used by [ServiceScopeGuard]. */
  companion object Key : CoroutineContext.Key<RequestIdContext>
}
