package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Broadcast guard scanner contracts for guarded emissions, catches, and literal handling. */
internal class BroadcastGuardAdoptionTestBroadcastTest {

  @Test
  fun `controller sender emissions require a guard around the actual broadcast`() {
    for (guard in listOf("", "resultBroadcaster.guard(requestId, \"foo_result\") {}")) {
      val source =
        """
        class Fake {
          private suspend fun broadcastFooResult(requestId: String?) {
            $guard
            responseSender.broadcastWithPerf("foo_result", requestId) { put("success", true) }
          }
        }
        """
          .trimIndent()

      val result = BroadcastGuardScanner.scan(source)

      assertEquals(listOf("broadcastFooResult"), result.guardedHelpers)
      assertEquals(
        listOf(BroadcastGuardScanner.Kind.MISSING_GUARD),
        result.violations.map { it.kind },
      )
    }
  }

  @Test
  fun `flags a new broadcast result helper that forgets the guard`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?, success: Boolean) {
          webSocketServer.broadcast("{\"type\":\"foo_result\"}")
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      "the un-guarded helper should be the sole violation",
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags a guarded broadcast helper that reintroduces an inner log-and-swallow`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              Log.e(TAG, "Error broadcasting foo result", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    // Guard is present, so MISSING_GUARD must NOT fire — the inner swallow is the regression.
    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags an asyncActionRunner launch block that reintroduces an inner log-and-swallow`() {
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          asyncActionRunner.launch(requestId, "screenshot") {
            try {
              takeScreenshotAsync()
            } catch (e: Exception) {
              Log.e(TAG, "screenshot blew up", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_LAUNCH to "asyncActionRunner.launch"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag a push-event broadcaster that legitimately swallows`() {
    // Push events carry no requestId to correlate an error to, so their log-and-swallow is correct
    // and must be left alone. Naming (`*Event` not `*Result/Error/Response`) is the discriminator.
    val src =
      """
      class Fake {
        private suspend fun broadcastNavigationEvent(event: Foo) {
          try {
            webSocketServer.broadcast(event)
          } catch (e: Exception) {
            Log.e(TAG, "Error broadcasting navigation event", e)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "event broadcasters must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not flag broadcastNetworkErrorSimulation despite Error appearing mid-name`() {
    // `broadcastNetworkErrorSimulation` contains "Error" mid-name (followed by "Simulation"), is a
    // non-suspend fire-and-forget intent sender, and carries no requestId. It must not be treated
    // as a requestId-correlated result broadcaster.
    val src =
      """
      class Fake {
        private fun broadcastNetworkErrorSimulation(enabled: Boolean) {
          try {
            context.sendBroadcast(intent)
          } catch (e: Exception) {
            Log.e(TAG, "Error simulating network", e)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "broadcastNetworkErrorSimulation must not be in scope: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertTrue(result.guardedHelpers.isEmpty())
  }

  @Test
  fun `does not flag a launch block that catches to broadcast its own error result`() {
    // AsyncActionRunner's contract: an action that broadcasts a success:false result on its own
    // error path already surfaces the failure and is unaffected — its catch must not be flagged.
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          asyncActionRunner.launch(requestId, "install") {
            try {
              installApp()
            } catch (e: Exception) {
              webSocketServer.broadcast(errorResult(requestId, e.message))
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "a catch that surfaces a broadcast must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not flag a guarded helper whose only catch rethrows`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              throw e
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "a rethrowing catch surfaces the error: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `flags a swallow whose catch names a throwable local but never rethrows`() {
    // Regression guard for the surface-detection heuristic: a `throwable` local must not be
    // mistaken
    // for a `throw` (rethrow). The catch logs-and-swallows and must still be flagged.
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              val throwable = e
              Log.e(TAG, "swallowed", throwable)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag a compliant guarded helper with no catch`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?, success: Boolean) {
          resultBroadcaster.guard(requestId, "foo_result") {
            webSocketServer.broadcast("payload")
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(result.violations.isEmpty())
    assertEquals(listOf("broadcastFooResult"), result.guardedHelpers)
  }

  @Test
  fun `handles raw-string literals containing braces without desyncing brace matching`() {
    // Kotlin raw strings embed unbalanced-looking braces (e.g. `""" {"type":"x"} """`). The scanner
    // must blank literal contents before brace matching or it will mis-slice helper bodies. Build
    // the triple quotes at runtime so this test file itself stays a valid raw string.
    val tq = "\"\"\""
    val src =
      """
      class Fake {
        private suspend fun broadcastFancyResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "fancy_result") {
            webSocketServer.broadcast(buildString { append(${tq}{"type":"fancy","nested":{"a":"b"}}${tq}) })
          }
        }
        private suspend fun broadcastNextResult(requestId: String?) {
          webSocketServer.broadcast("oops")
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    // The first helper is compliant; the second (un-guarded) must still be detected — proving the
    // brace matcher did not swallow it into the previous body.
    assertEquals(
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastNextResult"),
      result.violations.map { it.kind to it.symbol },
    )
    assertTrue(result.guardedHelpers.contains("broadcastFancyResult"))
  }

  @Test
  fun `flags a NON-suspend direct broadcaster that forgets the guard`() {
    // A requestId-correlated result broadcaster declared `private fun` (not `suspend fun`) must not
    // evade the scan — the existing `broadcastScreenshot` proves non-suspend broadcasters exist.
    val src =
      """
      class Fake {
        private fun broadcastQuickTapResult(requestId: String?, success: Boolean) {
          try {
            webSocketServer.broadcast(buildResult(requestId, success))
          } catch (e: Exception) {
            Log.e(TAG, "Error broadcasting quick tap result", e)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    // The unguarded broadcast is the primary regression; the log-and-swallow is also flagged.
    assertTrue(
      "non-suspend helper must be in scope and flagged unguarded: ${result.violations}",
      result.violations.any {
        it.kind == BroadcastGuardScanner.Kind.MISSING_GUARD &&
          it.symbol == "broadcastQuickTapResult"
      },
    )
    assertTrue(result.guardedHelpers.contains("broadcastQuickTapResult"))
  }

  @Test
  fun `does not flag a NON-suspend broadcaster that delegates to asyncActionRunner launch`() {
    // `broadcastScreenshot`'s real shape: non-suspend, requestId-correlated, delegates the actual
    // broadcast into asyncActionRunner.launch (which is itself swallow-checked). Must pass.
    val src =
      """
      class Fake {
        private fun broadcastScreenshotResult(requestId: String?) {
          asyncActionRunner.launch(requestId, "screenshot") {
            webSocketServer.broadcast(buildScreenshot(requestId))
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "delegating broadcaster must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertTrue(result.guardedHelpers.contains("broadcastScreenshotResult"))
  }

  @Test
  fun `flags a helper that calls guard but performs the broadcast OUTSIDE the guard block`() {
    // A token guard call does not satisfy the guarantee — the throwing broadcast must be *inside*
    // the guard span, or a throw escapes uncaught and the client hangs (issue #3085).
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?, success: Boolean) {
          val message = buildResult(requestId, success)
          webSocketServer.broadcast(message)
          resultBroadcaster.guard(requestId, "foo_ack") { logSomething() }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      "the broadcast sits outside the guard span",
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags a swallow that only mentions an unrelated broadcast identifier without a call`() {
    // The surface heuristic must require an actual `broadcast*(` call, not a bare `broadcast`
    // substring — a `broadcastCounter` property read must not launder a log-and-swallow.
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              val depth = webSocketServer.broadcastQueueDepth
              Log.e(TAG, "swallowed, depth=", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags a swallow whose catch only re-broadcasts an uncorrelated push event`() {
    // A catch that broadcasts a push event (`broadcast*Event/Update/Change`, no requestId) does not
    // surface a correlated error — the awaiting request still hangs, so it must be flagged (Codex).
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              broadcastNavigationEvent(currentEvent())
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `handles string interpolation nesting a string that contains a brace without desyncing`() {
    // `"a ${f("}")}"` is valid, brace-balanced Kotlin, but a masker that ignores ${...} would let
    // the inner quote close the outer string and expose a stray brace, mis-slicing bodies. The
    // following un-guarded helper must still be detected.
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            val label = "a ${'$'}{describe("}")}"
            webSocketServer.broadcast(label)
          }
        }
        private suspend fun broadcastNextResult(requestId: String?) {
          webSocketServer.broadcast("oops")
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastNextResult"),
      result.violations.map { it.kind to it.symbol },
    )
    assertTrue(result.guardedHelpers.contains("broadcastFooResult"))
  }
}
