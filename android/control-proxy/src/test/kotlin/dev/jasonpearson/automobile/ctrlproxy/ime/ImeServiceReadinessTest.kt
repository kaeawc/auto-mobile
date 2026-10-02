package dev.jasonpearson.automobile.ctrlproxy.ime

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ImeServiceReadinessTest {
  @Test
  fun `already bound returns without any delay`() = runTest {
    val instance = Any()
    var delays = 0
    val result =
      awaitImeServiceReady(
        nowMs = { testScheduler.currentTime },
        delayMs = {
          delays++
          delay(it)
        },
        probe = { instance },
        isCancelled = { false },
      )
    assertSame(instance, result)
    assertEquals(0, delays)
    assertEquals(0L, testScheduler.currentTime)
  }

  @Test
  fun `binding within the window returns on the next poll`() = runTest {
    val instance = Any()
    val result =
      awaitImeServiceReady(
        nowMs = { testScheduler.currentTime },
        delayMs = { delay(it) },
        probe = { instance.takeIf { testScheduler.currentTime >= 125L } },
        isCancelled = { false },
      )
    assertSame(instance, result)
    assertEquals(150L, testScheduler.currentTime)
  }

  @Test
  fun `unbound service times out at the bound and not before`() = runTest {
    val result = async {
      awaitImeServiceReady<Any>(
        nowMs = { testScheduler.currentTime },
        delayMs = { delay(it) },
        probe = { null },
        isCancelled = { false },
      )
    }
    runCurrent()
    advanceTimeBy(IME_SERVICE_READY_TIMEOUT_MS - 1)
    runCurrent()
    assertFalse(result.isCompleted)
    advanceTimeBy(1)
    runCurrent()
    assertNull(result.await())
    assertEquals(IME_SERVICE_READY_TIMEOUT_MS, testScheduler.currentTime)
  }

  @Test
  fun `cancellation stops at the next poll`() = runTest {
    val result =
      awaitImeServiceReady<Any>(
        nowMs = { testScheduler.currentTime },
        delayMs = { delay(it) },
        probe = { null },
        isCancelled = { testScheduler.currentTime >= 125L },
      )
    assertNull(result)
    assertEquals(150L, testScheduler.currentTime)
  }

  companion object {
    @BeforeClass
    @JvmStatic
    fun warmScheduler() {
      runTest {} // Keep coroutine scheduler initialization outside per-test timing.
    }
  }
}
