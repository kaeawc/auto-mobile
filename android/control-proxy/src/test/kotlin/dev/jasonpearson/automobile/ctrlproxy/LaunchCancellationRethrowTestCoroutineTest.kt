package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Cancellation scanner contracts for launch builders, argument syntax, and independent catches. */
internal class LaunchCancellationRethrowTestCoroutineTest {

  @Test
  fun `flags a launch whose broad Exception catch swallows without rethrowing cancellation`() {
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
              sendResult(success = false, error = e.message)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals("the swallowing launch is the sole violation", 1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `flags a launch whose broad Throwable catch swallows without rethrowing cancellation`() {
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (t: Throwable) {
              Log.e(TAG, "boom", t)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
  }

  @Test
  fun `does not flag a launch that rethrows CancellationException before the generic catch`() {
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
              sendResult(success = false, error = e.message)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(
      "compliant launch must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not flag a launch whose CancellationException is fully qualified`() {
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: kotlinx.coroutines.CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
  }

  @Test
  fun `flags a launch whose CancellationException catch does NOT rethrow`() {
    // A CancellationException catch that logs-and-swallows instead of rethrowing is still the bug —
    // the cooperative cancellation is absorbed and the coroutine does not unwind.
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: CancellationException) {
              Log.e(TAG, "cancelled", e)
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
  }

  @Test
  fun `does not flag a launch with no try catch`() {
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch { broadcastPackageEvent(action, pkg) }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not flag a launch whose only broad catch itself rethrows`() {
    // A `catch (e: Exception) { throw e }` re-surfaces everything including cancellation, so it is
    // not a swallow.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              throw e
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
  }

  @Test
  fun `does not flag an asyncActionRunner launch block (out of scope for this scanner)`() {
    // asyncActionRunner.launch is a different seam covered by
    // BroadcastGuardAdoptionTestBroadcastTest; this
    // scanner is scoped to raw serviceScope.launch coroutines only.
    val src =
      """
      class Fake {
        fun dispatch() {
          asyncActionRunner.launch(requestId, "install") {
            try {
              installApp()
            } catch (e: Exception) {
              Log.e(TAG, "boom", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(
      "asyncActionRunner.launch is out of scope: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertEquals("no serviceScope.launch present", 0, result.launchBlocks)
  }

  @Test
  fun `does not desync on a raw string containing braces before an unguarded catch`() {
    // The scanner must blank literal contents before brace matching or it will mis-slice the launch
    // body. Build the triple quotes at runtime so this test file itself stays a valid raw string.
    val tq = "\"\"\""
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            val payload = ${tq}{"type":"cmd","nested":{"a":"b"}}${tq}
            try {
              handle(payload)
            } catch (e: Exception) {
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(
      "the braces in the raw string must not hide the swallow",
      1,
      result.violations.size,
    )
  }

  @Test
  fun `reports one violation per swallowing launch and dedupes by line`() {
    val src =
      """
      class Fake {
        fun a() {
          serviceScope.launch {
            try { x() } catch (e: Exception) { Log.e(TAG, "a", e) }
          }
        }
        fun b() {
          serviceScope.launch {
            try { y() } catch (e: Exception) { Log.e(TAG, "b", e) }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(2, result.violations.size)
    assertEquals(2, result.violations.map { it.line }.toSet().size)
  }

  @Test
  fun `flags a second unrelated swallowing try even when an earlier try rethrows cancellation`() {
    // Per-try precision: a guarded first try must not launder a LATER, separate try/catch that
    // swallows — the exact shape a future edit to commandReceiver would take (the block-level
    // false-negative the reviewers flagged).
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              sendResult(success = false, error = e.message)
            }
            try {
              followUp()
            } catch (e: Exception) {
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals("only the second, unguarded try is a violation", 1, result.violations.size)
  }

  @Test
  fun `flags a dispatcher-argument launch that swallows`() {
    // `serviceScope.launch(Dispatchers.IO) { … }` must not evade the scan by carrying an argument.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch(Dispatchers.IO) {
            try {
              work()
            } catch (e: Exception) {
              Log.e(TAG, "boom", e)
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
  fun `flags a bare scope launch (WebSocketServer form) that swallows`() {
    val src =
      """
      class Fake {
        fun start() {
          scope.launch {
            try {
              connection.close()
            } catch (e: Exception) {
              Log.e(TAG, "closing", e)
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
  fun `does not count launchIn as a launch block`() {
    // `launchIn(scope)` has no trailing lambda; it must not be miscounted or brace-matched.
    val src =
      """
      class Fake {
        fun collect() {
          flow.onEach { handle(it) }.launchIn(serviceScope)
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(0, result.launchBlocks)
    assertTrue(result.violations.isEmpty())
  }
}
