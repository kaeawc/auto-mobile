package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Cancellation scanner contracts for unconditional rethrows and early exits. */
internal class LaunchCancellationRethrowTestRethrowTest {

  @Test
  fun `flags a conditionally-rethrowing broad catch - the non-throwing branch swallows`() {
    // Formerly a KNOWN-LIMITATION false-negative: any `throw` in the broad catch body used to
    // count as full re-surfacing. Tightened by #3192 — a conditional rethrow still swallows the
    // cancellation on its non-throwing branch, so it is now flagged.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              if (fatal) throw e else Log.e(TAG, "swallowed on non-fatal branch", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals("conditional rethrow must be flagged (#3192)", 1, result.violations.size)
  }

  @Test
  fun `flags a broad catch whose only throw is nested in a when branch`() {
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              when (e) {
                is IllegalStateException -> throw e
                else -> Log.e(TAG, "swallowed", e)
              }
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
  fun `does not flag a broad catch that cleans up then rethrows unconditionally`() {
    // `cleanup(); throw wrap(e)` always exits via the throw — the legitimate shape #3192 weighed
    // the tightening against. Only the LAST top-level statement must be a throw.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              cleanup()
              throw wrap(e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(
      "cleanup-then-rethrow must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not flag a broad catch whose final throw has multi-line arguments`() {
    // The throw's argument list spans lines; nested-group blanking must collapse it into a single
    // top-level statement instead of mistaking the trailing `)` for the last statement.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              Log.e(TAG, "context", e)
              throw IllegalStateException(
                "wrapped",
                e,
              )
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
  fun `flags a broad catch whose final throw is bypassed by an early top-level return`() {
    // `if (retry) return` exits the catch without throwing, so the trailing `throw e` is not an
    // unconditional rethrow — the return branch still swallows the cancellation.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              if (retry) return
              throw e
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
  fun `flags a broad catch whose only throw is inside a nested lambda`() {
    // A throw deferred into a lambda does not re-surface the cancellation on this path.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              handler.post { throw e }
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
  fun `a CancellationException catch that only conditionally rethrows does not guard the chain`() {
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: CancellationException) {
              if (stopping) throw e
            } catch (e: Exception) {
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
  }
}
