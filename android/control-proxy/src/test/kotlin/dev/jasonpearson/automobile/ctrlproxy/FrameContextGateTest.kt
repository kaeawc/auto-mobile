package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.FrameContextValidationResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FrameContextGateTest {
  private class FixedTimer : TimeProvider {
    override fun currentTimeMillis() = 8_080L
  }

  private val sent = mutableListOf<WebSocketResponse>()
  private val errors = mutableListOf<ErrorResponse>()
  private var failBroadcast: RuntimeException? = null

  private fun gate(testScope: TestScope, epoch: String = "run-a") =
    FrameContextGate(
      epoch = epoch,
      asyncActionRunner =
        AsyncActionRunner(
          scope = CoroutineScope(UnconfinedTestDispatcher(testScope.testScheduler)),
          broadcastResponse = { errors += it as ErrorResponse },
          logError = { _, _ -> },
        ),
      timeProvider = FixedTimer(),
      broadcast = { response ->
        failBroadcast?.let { throw it }
        sent += response
      },
    )

  @Test
  fun `the token names the epoch and advances on every UI change`() = runTest {
    val gate = gate(this)
    assertEquals("run-a:0", gate.current())

    gate.advance()
    gate.advance()

    assertEquals("run-a:2", gate.current())
    assertEquals(
      "each service process mints its own epoch",
      "run-z:0",
      gate(this, "run-z").current(),
    )
  }

  @Test
  fun `a token is stale once the UI changed or when it comes from another epoch`() = runTest {
    val gate = gate(this)
    val observed = gate.current()

    assertFalse("an unchecked input is never stale", gate.isStale(null))
    assertFalse(gate.isStale(observed))
    gate.advance()
    assertTrue(gate.isStale(observed))
    assertTrue("a restarted service rejects an old run's token", gate.isStale("run-b:1"))
  }

  @Test
  fun `validation of the current token succeeds`() = runTest {
    val gate = gate(this)

    gate.validate("req-1", gate.current())

    val result = sent.single() as FrameContextValidationResult
    assertEquals("req-1", result.requestId)
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals(8_080L, result.timestamp)
    assertEquals(0L, result.totalTimeMs)
  }

  @Test
  fun `validation of a stale token fails with the retry hint`() = runTest {
    val gate = gate(this)
    val observed = gate.current()
    gate.advance()

    gate.validate("req-2", observed)

    val result = sent.single() as FrameContextValidationResult
    assertFalse(result.success)
    assertEquals(
      "Stale frame context for input/key; observe a fresh frame before retrying",
      result.error,
    )
  }

  @Test
  fun `a failed validation broadcast becomes a correlated error instead of a hang`() = runTest {
    failBroadcast = IllegalStateException("socket closed")

    gate(this).validate("req-3", "run-a:0")

    assertEquals("req-3", errors.single().requestId)
  }
}
