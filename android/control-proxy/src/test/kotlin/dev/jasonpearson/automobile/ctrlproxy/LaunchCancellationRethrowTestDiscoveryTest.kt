package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Cancellation scanner contracts for WebSocket routes and suspend-function discovery. */
internal class LaunchCancellationRethrowTestDiscoveryTest {

  @Test
  fun `flags a webSocket route handler whose outer catch swallows cancellation`() {
    // The Ktor read loop is a coroutine; an outer `catch (e: Exception)` re-swallows the
    // cancellation an inline suspend call rethrows (the #3130 review finding at
    // WebSocketServer:171).
    val src =
      """
      class Fake {
        fun start() {
          routing {
            webSocket("/ws") {
              try {
                for (frame in incoming) {
                  handleClientMessage(frame.readText())
                }
              } catch (e: Exception) {
                Log.e(TAG, "Error in WebSocket connection", e)
              } finally {
                cleanup()
              }
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not flag a webSocket handler that rethrows cancellation`() {
    val src =
      """
      class Fake {
        fun start() {
          webSocket("/ws") {
            try {
              loop()
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "err", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not match webSocketServer field reads or the WebSockets plugin`() {
    // `\bwebSocket\b` must not fire on `webSocketServer.broadcast(...)` (no word boundary after
    // "webSocket") or the capitalized `WebSockets` plugin.
    val src =
      """
      class Fake {
        fun go() {
          install(WebSockets)
          webSocketServer.broadcast(payload)
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(0, result.launchBlocks)
    assertTrue(result.violations.isEmpty())
  }

  @Test
  fun `auto-discovers a suspend fn whose broad catch swallows cancellation`() {
    // A named suspend helper (the `broadcastToClients` shape) whose broad catch wraps a suspend
    // send but does not sit inside a launch block. Since #3191 no curated list is needed — every
    // `suspend fun` in the source is discovered and scanned by default.
    val src =
      """
      class Fake {
        private suspend fun broadcastToClients(message: String) {
          connections.forEach { connection ->
            try {
              connection.send(Frame.Text(message))
            } catch (e: Exception) {
              deadConnections.add(connection)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `auto-discovers a suspend extension fn declared with extra modifiers`() {
    // `suspend inline fun`, generics, and a dotted extension receiver must not evade discovery.
    val src =
      """
      internal suspend inline fun <T> Session.sendAll(frames: List<T>) {
        try {
          frames.forEach { send(it) }
        } catch (e: Exception) {
          Log.e(TAG, "swallowed", e)
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not flag a suspend fn that rethrows cancellation`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastToClients(message: String) {
          connections.forEach { connection ->
            try {
              connection.send(Frame.Text(message))
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              deadConnections.add(connection)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `an exempted suspend fn is skipped - the explicit opt-out`() {
    val src =
      """
      class Fake {
        private suspend fun parseOnly(message: String) {
          try {
            decode(message)
          } catch (e: Exception) {
            Log.w(TAG, "bad payload", e)
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src, exemptSuspendFns = listOf("parseOnly"))

    assertTrue("exempted fn must not be flagged: ${result.violations}", result.violations.isEmpty())
    assertEquals("exempted fn is not counted as a scanned body", 0, result.launchBlocks)
  }

  @Test
  fun `a stale exemptSuspendFns entry fails loudly`() {
    // An opt-out for a fn that no longer exists must not rot silently — it would mask a rename
    // that reintroduces the swallow under a new name.
    val src =
      """
      class Fake {
        private suspend fun stillHere(message: String) {
          send(message)
        }
      }
      """
        .trimIndent()

    val stale = listOf("renamedAway")
    val thrown = runCatching { LaunchCancellationScanner.scan(src, stale) }.exceptionOrNull()

    assertTrue(
      "expected an AssertionError naming the stale entry, got $thrown",
      thrown is AssertionError && thrown.message!!.contains("renamedAway"),
    )
  }

  @Test
  fun `skips a bodyless suspend fun declaration without mis-slicing the next block`() {
    // An interface/abstract declaration has no body; the discovery pass must not brace-match into
    // the following declaration's block (which here contains a swallow that is NOT in a coroutine).
    val src =
      """
      interface Handler {
        suspend fun handleMessage(request: Request): Response?
      }

      class Impl {
        fun notACoroutine() {
          try {
            work()
          } catch (e: Exception) {
            Log.e(TAG, "sync-only, out of scope", e)
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(0, result.launchBlocks)
    assertTrue(result.violations.isEmpty())
  }
}
