package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fast, Android-free unit tests for [ServiceScopeGuard] — the
 * [kotlinx.coroutines.CoroutineExceptionHandler] installed on `serviceScope` that closes the
 * raw-`serviceScope.launch` half of the silent-hang gap (issue #3104). Complements
 * [AsyncActionRunnerTest] (dispatch/async path) and [ResultBroadcasterTest] (result-send path).
 *
 * Each test builds a real child [CoroutineScope] carrying the guard's handler and a
 * [StandardTestDispatcher] tied to `runTest`'s scheduler, so a throw inside a launched coroutine
 * exercises the handler exactly as it would in production — without Robolectric or real network
 * I/O. The scope is deliberately *not* parented to the `runTest` job so an uncaught throw is
 * delivered to the guard's handler (the unit under test) rather than failing the test harness.
 */
class ServiceScopeGuardTest {

  @Test
  fun `broadcasts a correlated error frame when a raw launch throws`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val guard =
      ServiceScopeGuard(
        emitScope = { this },
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )
    val scope =
      CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + guard.handler)

    scope.launch(RequestIdContext("req-1")) { throw RuntimeException("boom") }
    advanceUntilIdle()

    assertEquals("exactly one error frame should be broadcast", 1, broadcasts.size)
    val error = broadcasts.single() as ErrorResponse
    assertEquals("req-1", error.requestId)
    assertFalse("error frame should mark success=false", error.success)
    assertTrue(
      "error should surface the underlying cause, was: ${error.error}",
      error.error.contains("boom"),
    )
  }

  @Test
  fun `carries a null requestId when the launch has no RequestIdContext`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val guard =
      ServiceScopeGuard(
        emitScope = { this },
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )
    val scope =
      CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + guard.handler)

    // A raw launch that forgot to thread the correlation id still yields an error frame + a log
    // trace — just with a null requestId, which the daemon no-ops on (a safe fallback to timeout).
    scope.launch { throw IllegalStateException("no id") }
    advanceUntilIdle()

    val error = broadcasts.single() as ErrorResponse
    assertEquals("uncorrelated failures pass a null requestId through", null, error.requestId)
  }

  @Test
  fun `does not broadcast an error frame on cooperative cancellation`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val guard =
      ServiceScopeGuard(
        emitScope = { this },
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )
    val scope =
      CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + guard.handler)

    // Cancellation means the scope is shutting down — the handler is not invoked for a
    // CancellationException, so no client-facing error frame is emitted.
    scope.launch(RequestIdContext("req-cancel")) { throw CancellationException("shutting down") }
    advanceUntilIdle()

    assertTrue("cancellation must not produce an error frame", broadcasts.isEmpty())
  }

  @Test
  fun `swallows a failure raised while broadcasting the fallback frame`() = runTest {
    val logged = mutableListOf<String>()
    val guard =
      ServiceScopeGuard(
        emitScope = { this },
        broadcastResponse = { throw RuntimeException("socket closed") },
        logError = { message, _ -> logged.add(message) },
      )
    val scope =
      CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + guard.handler)

    // A failure while reporting the uncaught exception must not itself escape (which would re-enter
    // the handler and loop). It is logged and swallowed.
    scope.launch(RequestIdContext("req-2")) { throw RuntimeException("original failure") }
    advanceUntilIdle()

    // Exactly two: the original uncaught failure, then the failure raised while broadcasting it.
    assertEquals(
      "both the original failure and the broadcast failure should be logged: $logged",
      2,
      logged.size,
    )
    assertTrue(
      "the guard must not spin into a re-entrant broadcast loop",
      logged.size < 10,
    )
  }

  @Test
  fun `RequestIdContext exposes its correlation id via the context key`() = runTest {
    var recovered: String? = "sentinel"
    val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))

    scope.launch(RequestIdContext("req-7")) {
      recovered = coroutineContext[RequestIdContext]?.requestId
    }
    advanceUntilIdle()

    assertEquals("req-7", recovered)
  }
}
