package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Fast, Android-free unit tests for [ResultBroadcaster] — the shared guard that closes the
 * one-layer-down silent-hang gap from issue #3045. Each `broadcast*Result` helper in [CtrlProxy]
 * used to wrap its `webSocketServer.broadcast(...)` in a local `try/catch` that logged and
 * swallowed; if that broadcast (or the serialization feeding it) threw, the helper emitted nothing
 * and the daemon awaiter for that `requestId` hung to its `RequestManager` timeout. Routing every
 * result broadcast through [ResultBroadcaster.guard] guarantees a correlated failure frame instead.
 *
 * Mirrors [AsyncActionRunnerTest]: a capturing broadcast lambda, so no Robolectric or network I/O.
 */
class ResultBroadcasterTest {

  @Test
  fun `broadcasts correlated error frame when the broadcast block throws`() = runTest {
    val broadcasts = mutableListOf<ErrorResponse>()
    val broadcaster =
      ResultBroadcaster(broadcastError = { broadcasts.add(it) }, logError = { _, _ -> })

    broadcaster.guard(requestId = "req-1", action = "swipe_result") {
      throw RuntimeException("socket closed")
    }

    assertEquals("exactly one fallback error frame should be broadcast", 1, broadcasts.size)
    val error = broadcasts.single()
    assertEquals("req-1", error.requestId)
    assertFalse("error frame should mark success=false", error.success)
    assertTrue(
      "error should name the failing action, was: ${error.error}",
      error.error.contains("swipe_result"),
    )
    assertTrue(
      "error should surface the underlying cause, was: ${error.error}",
      error.error.contains("socket closed"),
    )
  }

  @Test
  fun `does not broadcast when the block succeeds`() = runTest {
    val broadcasts = mutableListOf<ErrorResponse>()
    val broadcaster =
      ResultBroadcaster(broadcastError = { broadcasts.add(it) }, logError = { _, _ -> })

    // A successful helper broadcasts its own *_result frame inside the block; the guard stays
    // silent.
    broadcaster.guard(requestId = "req-ok", action = "preference_files") {
      // no-op: represents a successful broadcast
    }

    assertTrue("no error frame should be broadcast on success", broadcasts.isEmpty())
  }

  @Test
  fun `propagates cancellation without broadcasting an error`() = runTest {
    val broadcasts = mutableListOf<ErrorResponse>()
    val broadcaster =
      ResultBroadcaster(broadcastError = { broadcasts.add(it) }, logError = { _, _ -> })

    // Cooperative cancellation means the service scope is shutting down — it must never be reported
    // to the client as a broadcast failure; it must propagate so the coroutine unwinds cleanly.
    try {
      broadcaster.guard(requestId = "req-cancel", action = "highlight_response") {
        throw CancellationException("scope shutting down")
      }
      fail("guard should re-throw CancellationException")
    } catch (e: CancellationException) {
      // expected
    }

    assertTrue("cancellation must not produce an error frame", broadcasts.isEmpty())
  }

  @Test
  fun `carries a null requestId through to the error frame`() = runTest {
    val broadcasts = mutableListOf<ErrorResponse>()
    val broadcaster =
      ResultBroadcaster(broadcastError = { broadcasts.add(it) }, logError = { _, _ -> })

    broadcaster.guard(requestId = null, action = "get_preferences") {
      throw IllegalStateException("boom")
    }

    val error = broadcasts.single()
    assertEquals("null requestId should pass through uncorrelated", null, error.requestId)
  }

  @Test
  fun `swallows a failure raised while broadcasting the fallback frame`() = runTest {
    val logged = mutableListOf<String>()
    val broadcaster =
      ResultBroadcaster(
        broadcastError = { throw RuntimeException("socket still closed") },
        logError = { message, _ -> logged.add(message) },
      )

    // A broadcast failure during fallback reporting must not escape guard (which would defeat the
    // fix by letting the exception bubble to the launched coroutine). It is logged and swallowed.
    broadcaster.guard(requestId = "req-2", action = "drag_result") {
      throw RuntimeException("original broadcast failure")
    }

    // Exactly two: the original broadcast failure, then the failure raised while reporting it.
    assertEquals(
      "both the original and the fallback failure should be logged: $logged",
      2,
      logged.size,
    )
  }

  @Test
  fun `re-throws cancellation raised while broadcasting the fallback frame`() = runTest {
    val broadcaster =
      ResultBroadcaster(
        broadcastError = { throw CancellationException("scope shutting down mid-fallback") },
        logError = { _, _ -> },
      )

    // If the scope is cancelled while we try to send the fallback, that cancellation must still
    // propagate rather than being swallowed as a generic broadcast failure.
    try {
      broadcaster.guard(requestId = "req-3", action = "tap_coordinates_result") {
        throw RuntimeException("original broadcast failure")
      }
      fail("guard should re-throw a CancellationException raised during fallback")
    } catch (e: CancellationException) {
      // expected
    }
  }
}
