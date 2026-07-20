package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Direct unit tests for the shared correlated-error-on-throw core extracted in issue #3086.
 *
 * The three consumers ([ResultBroadcaster], [AsyncActionRunner], [ServiceScopeGuard]) keep their
 * own suites, which now exercise this core through their public surfaces. These tests pin the
 * core's semantics on their own, so a future change to it is described in one place.
 */
class CorrelatedErrorReporterTest {

  private val broadcasts = mutableListOf<ErrorResponse>()
  private val logs = mutableListOf<Pair<String, Throwable>>()

  private fun reporter(
    broadcastError: suspend (ErrorResponse) -> Unit = { broadcasts += it }
  ): CorrelatedErrorReporter =
    CorrelatedErrorReporter(broadcastError) { message, error -> logs += message to error }

  // ---------------------------------------------------------------------------
  // guarding
  // ---------------------------------------------------------------------------

  @Test
  fun `guarding emits a correlated frame when the block throws`() = runTest {
    reporter().guarding(
      requestId = "req-1",
      failureLogMessage = { "failure log" },
      errorMessagePrefix = { "Action 'foo' failed" },
      doubleFailureLogMessage = { "double failure log" },
    ) {
      throw IllegalStateException("boom")
    }

    assertEquals(1, broadcasts.size)
    assertEquals("req-1", broadcasts.single().requestId)
    assertEquals("Action 'foo' failed: boom", broadcasts.single().error)
    assertEquals(false, broadcasts.single().success)
    assertEquals(listOf("failure log"), logs.map { it.first })
  }

  @Test
  fun `guarding emits nothing when the block succeeds`() = runTest {
    reporter().guarding(
      requestId = "req-1",
      failureLogMessage = { "failure log" },
      errorMessagePrefix = { "Action 'foo' failed" },
      doubleFailureLogMessage = { "double failure log" },
    ) {
      // no-op
    }

    assertTrue(broadcasts.isEmpty())
    assertTrue(logs.isEmpty())
  }

  @Test
  fun `guarding propagates cancellation without emitting a frame`() = runTest {
    try {
      reporter().guarding(
        requestId = "req-1",
        failureLogMessage = { "failure log" },
        errorMessagePrefix = { "Action 'foo' failed" },
        doubleFailureLogMessage = { "double failure log" },
      ) {
        throw CancellationException("shutting down")
      }
      fail("expected the cancellation to propagate")
    } catch (expected: CancellationException) {
      assertEquals("shutting down", expected.message)
    }

    assertTrue("cancellation must never become a client-facing frame", broadcasts.isEmpty())
    assertTrue(logs.isEmpty())
  }

  @Test
  fun `guarding carries a null requestId through to the frame`() = runTest {
    reporter().guarding(
      requestId = null,
      failureLogMessage = { "failure log" },
      errorMessagePrefix = { "Action 'foo' failed" },
      doubleFailureLogMessage = { "double failure log" },
    ) {
      throw IllegalStateException("boom")
    }

    assertNull(broadcasts.single().requestId)
  }

  // ---------------------------------------------------------------------------
  // Double-failure tail
  // ---------------------------------------------------------------------------

  @Test
  fun `a failure raised while emitting the frame is logged and swallowed`() = runTest {
    reporter(broadcastError = { throw IllegalStateException("sink down") }).guarding(
      requestId = "req-1",
      failureLogMessage = { "failure log" },
      errorMessagePrefix = { "Action 'foo' failed" },
      doubleFailureLogMessage = { "double failure log" },
    ) {
      throw IllegalStateException("boom")
    }

    assertEquals(listOf("failure log", "double failure log"), logs.map { it.first })
    assertEquals("sink down", logs.last().second.message)
  }

  @Test
  fun `a cancellation raised while emitting the frame propagates`() = runTest {
    try {
      reporter(broadcastError = { throw CancellationException("scope died") }).guarding(
        requestId = "req-1",
        failureLogMessage = { "failure log" },
        errorMessagePrefix = { "Action 'foo' failed" },
        doubleFailureLogMessage = { "double failure log" },
      ) {
        throw IllegalStateException("boom")
      }
      fail("expected the cancellation to propagate")
    } catch (expected: CancellationException) {
      assertEquals("scope died", expected.message)
    }

    assertEquals(listOf("failure log"), logs.map { it.first })
  }

  // ---------------------------------------------------------------------------
  // Cause derivation
  // ---------------------------------------------------------------------------

  @Test
  fun `cause falls back to the class name when the throwable has no message`() {
    assertEquals(
      "IllegalStateException",
      CorrelatedErrorReporter.causeOf(IllegalStateException()),
    )
  }

  @Test
  fun `cause uses the message when present`() {
    assertEquals("boom", CorrelatedErrorReporter.causeOf(IllegalStateException("boom")))
  }

  @Test
  fun `cause falls back to a constant for an anonymous throwable with no message`() {
    val anonymous = object : Throwable() {}
    assertEquals("unknown error", CorrelatedErrorReporter.causeOf(anonymous))
  }

  // ---------------------------------------------------------------------------
  // emit
  // ---------------------------------------------------------------------------

  @Test
  fun `emit sends the error text verbatim without logging on success`() = runTest {
    reporter()
      .emit(
        requestId = "req-1",
        errorMessage = "Uncaught async failure: boom",
        doubleFailureLogMessage = { "double failure log" },
      )

    assertEquals("Uncaught async failure: boom", broadcasts.single().error)
    assertEquals("req-1", broadcasts.single().requestId)
    assertTrue("a successful emit must not log", logs.isEmpty())
  }

  @Test
  fun `emit carries a null requestId through to the frame`() = runTest {
    reporter()
      .emit(
        requestId = null,
        errorMessage = "Uncaught async failure: boom",
        doubleFailureLogMessage = { "double failure log" },
      )

    assertNull(broadcasts.single().requestId)
  }

  @Test
  fun `emit swallows a failing sink rather than escaping to its caller`() = runTest {
    // ServiceScopeGuard enters here directly; an escape would re-enter its handler and loop.
    reporter(broadcastError = { throw IllegalStateException("sink down") })
      .emit(
        requestId = "req-1",
        errorMessage = "Uncaught async failure: boom",
        doubleFailureLogMessage = { "double failure log" },
      )

    assertEquals(listOf("double failure log"), logs.map { it.first })
  }

  @Test
  fun `emit propagates a cancellation raised by the sink`() = runTest {
    try {
      reporter(broadcastError = { throw CancellationException("scope died") })
        .emit(
          requestId = "req-1",
          errorMessage = "Uncaught async failure: boom",
          doubleFailureLogMessage = { "double failure log" },
        )
      fail("expected the cancellation to propagate")
    } catch (expected: CancellationException) {
      assertEquals("scope died", expected.message)
    }

    assertTrue(logs.isEmpty())
  }
}
