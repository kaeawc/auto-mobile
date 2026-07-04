package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fast, Android-free unit tests for [AsyncActionRunner] — the shared helper that closes the async
 * silent-hang gap from issue #3023. Uses a [runTest] [kotlinx.coroutines.test.TestScope] as the
 * launch scope and a capturing broadcast lambda, so no Robolectric or real network I/O is needed.
 */
class AsyncActionRunnerTest {

  @Test
  fun `broadcasts correlated error frame when block throws`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )

    runner.launch(requestId = "req-1", action = "screenshot") {
      throw RuntimeException("boom")
    }
    advanceUntilIdle()

    assertEquals("exactly one error frame should be broadcast", 1, broadcasts.size)
    val error = broadcasts.single() as ErrorResponse
    assertEquals("req-1", error.requestId)
    assertFalse("error frame should mark success=false", error.success)
    assertTrue(
      "error should name the failing action, was: ${error.error}",
      error.error.contains("screenshot"),
    )
    assertTrue(
      "error should surface the underlying cause, was: ${error.error}",
      error.error.contains("boom"),
    )
  }

  @Test
  fun `does not broadcast when block succeeds`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )

    runner.launch(requestId = "req-ok", action = "get_permission") {
      // Successful action: broadcasts its own result elsewhere, so the runner must stay silent.
    }
    advanceUntilIdle()

    assertTrue("no error frame should be broadcast on success", broadcasts.isEmpty())
  }

  @Test
  fun `propagates cancellation without broadcasting an error`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )

    // Cooperative cancellation means the service scope is shutting down — it must not be reported
    // to
    // the client as an action failure.
    runner.launch(requestId = "req-cancel", action = "list_preference_files") {
      throw CancellationException("scope shutting down")
    }
    advanceUntilIdle()

    assertTrue("cancellation must not produce an error frame", broadcasts.isEmpty())
  }

  @Test
  fun `carries a null requestId through to the error frame`() = runTest {
    val broadcasts = mutableListOf<WebSocketResponse>()
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { broadcasts.add(it) },
        logError = { _, _ -> },
      )

    runner.launch(requestId = null, action = "get_preferences") {
      throw IllegalStateException("no prefs")
    }
    advanceUntilIdle()

    val error = broadcasts.single() as ErrorResponse
    assertEquals("null requestId should pass through uncorrelated", null, error.requestId)
  }

  @Test
  fun `swallows a failure raised while broadcasting the error frame`() = runTest {
    val logged = mutableListOf<String>()
    val runner =
      AsyncActionRunner(
        scope = this,
        broadcastResponse = { throw RuntimeException("socket closed") },
        logError = { message, _ -> logged.add(message) },
      )

    // A broadcast failure during error reporting must not escape the coroutine (which would crash
    // the launch and defeat the whole point). It is logged and swallowed.
    runner.launch(requestId = "req-2", action = "subscribe_storage") {
      throw RuntimeException("original failure")
    }
    advanceUntilIdle()

    assertTrue(
      "both the original failure and the broadcast failure should be logged",
      logged.size >= 2,
    )
  }
}
