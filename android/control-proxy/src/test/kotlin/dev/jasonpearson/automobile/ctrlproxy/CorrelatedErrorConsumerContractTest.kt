package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the two properties that made the #3086 extraction safe but that no existing suite actually
 * asserts.
 *
 * 1. **Byte-identical messages.** The extraction's whole claim is that routing three hand-rolled
 *    bodies through [CorrelatedErrorReporter] changes no emitted text. The three consumer suites
 *    assert with `contains(...)`, so they would not have caught byte-level drift in the composed
 *    `"$prefix: $cause"` — and those suites had to stay unchanged to satisfy the issue's second
 *    acceptance criterion. These tests pin the exact strings instead, so a future edit to a prefix
 *    or to the cause rule fails loudly rather than silently reshaping what the daemon receives.
 * 2. **The launched coroutine's scope is what the action body receives.** [AsyncActionRunner] used
 *    to invoke its `suspend CoroutineScope.() -> Unit` block via an implicit receiver, which could
 *    not be wrong. It now passes the scope explicitly, which *could* be handed the outer scope by
 *    mistake — a change that would break structured concurrency for every action while leaving
 *    every existing assertion green.
 */
class CorrelatedErrorConsumerContractTest {

  private val broadcasts = mutableListOf<WebSocketResponse>()
  private val logs = mutableListOf<String>()

  private fun errors(): List<ErrorResponse> = broadcasts.filterIsInstance<ErrorResponse>()

  // ---------------------------------------------------------------------------
  // Exact emitted text, per consumer
  // ---------------------------------------------------------------------------

  @Test
  fun `ResultBroadcaster emits the exact documented strings`() = runTest {
    val broadcaster =
      ResultBroadcaster(
        broadcastError = { broadcasts += it },
        logError = { message, _ -> logs += message },
      )

    broadcaster.guard(requestId = "req-1", action = "swipe_result") {
      throw IllegalStateException("socket closed")
    }

    assertEquals("Broadcast failed for swipe_result: socket closed", errors().single().error)
    assertEquals("req-1", errors().single().requestId)
    assertEquals(listOf("Error broadcasting swipe_result (requestId=req-1)"), logs)
  }

  @Test
  fun `AsyncActionRunner emits the exact documented strings`() = runTest {
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { broadcasts += it },
        logError = { message, _ -> logs += message },
      )

    runner.launch(requestId = "req-1", action = "screenshot") {
      throw IllegalStateException("boom")
    }
    advanceUntilIdle()

    assertEquals("Action 'screenshot' failed: boom", errors().single().error)
    assertEquals(listOf("Async action 'screenshot' failed (requestId=req-1)"), logs)
  }

  @Test
  fun `ServiceScopeGuard emits the exact documented strings`() = runTest {
    val guard =
      ServiceScopeGuard(
        emitScope = { this },
        broadcastResponse = { broadcasts += it },
        logError = { message, _ -> logs += message },
      )

    val scope =
      CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + guard.handler)
    scope.launch(RequestIdContext("req-1")) { throw IllegalStateException("boom") }
    advanceUntilIdle()

    assertEquals("Uncaught async failure: boom", errors().single().error)
    assertEquals("req-1", errors().single().requestId)
    assertEquals(
      listOf("Uncaught exception in a serviceScope launch (requestId=req-1)"),
      logs,
    )
  }

  @Test
  fun `the shared cause rule still falls back to the class name for every consumer`() = runTest {
    val broadcaster =
      ResultBroadcaster(broadcastError = { broadcasts += it }, logError = { _, _ -> })

    broadcaster.guard(requestId = null, action = "swipe_result") {
      throw IllegalStateException()
    }

    assertEquals(
      "Broadcast failed for swipe_result: IllegalStateException",
      errors().single().error,
    )
  }

  // ---------------------------------------------------------------------------
  // The action body receives the launched coroutine's scope
  // ---------------------------------------------------------------------------

  @Test
  fun `the action body's receiver is the launched coroutine, not the outer scope`() = runTest {
    val runner = AsyncActionRunner(scope = this, broadcastResponse = {}, logError = { _, _ -> })
    val outerJob = coroutineContext[Job]
    var receivedJob: Job? = null

    val job =
      runner.launch(requestId = "req-1", action = "screenshot") {
        receivedJob = coroutineContext[Job]
      }
    job.join()

    assertSame("the block must receive the launched coroutine's Job", job, receivedJob)
    assertTrue("it must not be the outer scope's Job", receivedJob !== outerJob)
  }

  @Test
  fun `genuinely cancelling a suspended action emits no error frame`() = runTest {
    // The other cancellation tests throw a synthetic CancellationException from the block. This one
    // cancels the Job while the block is really suspended, so the cancellation unwinds through the
    // added `guarding` frame the way production shutdown does.
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { broadcasts += it },
        logError = { message, _ -> logs += message },
      )

    val job = runner.launch(requestId = "req-1", action = "screenshot") { delay(60_000) }
    advanceUntilIdle()
    job.cancel()
    job.join()

    assertTrue("a cancelled action must not emit a frame: $broadcasts", broadcasts.isEmpty())
    assertTrue("nor log a failure: $logs", logs.isEmpty())
  }

  @Test
  fun `a child coroutine started by the action body is awaited by the launched job`() = runTest {
    val runner = AsyncActionRunner(scope = this, broadcastResponse = {}, logError = { _, _ -> })
    var childRan = false

    val job =
      runner.launch(requestId = "req-1", action = "screenshot") {
        // `this` is the action body's receiver — structured concurrency must hold through it.
        launch { childRan = true }
      }
    job.join()

    assertTrue("a child launched from the body must run before the parent completes", childRan)
  }
}
