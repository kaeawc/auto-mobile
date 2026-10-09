package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class HierarchyDebouncerSuppressionTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun stubAndroidLogging() {
      mockkStatic(Log::class)
      every { Log.d(any(), any()) } returns 0
      runTest {}
    }

    @JvmStatic
    @AfterClass
    fun restoreAndroidLogging() {
      unmockkStatic(Log::class)
    }
  }

  private class FakeTime(private val secondStarted: CountDownLatch? = null) : TimeProvider {
    private val secondReads = AtomicInteger()

    override fun currentTimeMillis(): Long {
      // The second read happens inside the wait loop, after this call entered suppression.
      if (
        Thread.currentThread().name.startsWith("second extraction") &&
          secondReads.incrementAndGet() == 2
      ) {
        secondStarted?.countDown()
      }
      return 1_000L
    }
  }

  private fun await(latch: CountDownLatch) {
    assertTrue("timed out waiting for extraction", latch.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `quiescence extraction forwards explicit and default snapshot options`() = runTest {
    val optionsSeen = mutableListOf<HierarchySnapshotOptions>()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(),
        extractHierarchy = { _, snapshotOptions ->
          optionsSeen.add(snapshotOptions)
          ViewHierarchy(packageName = "current")
        },
      )
    val explicit = HierarchySnapshotOptions(displayId = 2)
    debouncer.extractAfterQuiescence(
      quiescenceMs = 0,
      initialEventWaitMs = 0,
      snapshotOptions = explicit,
    )
    debouncer.extractAfterQuiescence(quiescenceMs = 0, initialEventWaitMs = 0)
    assertEquals(2, optionsSeen.size)
    assertSame(explicit, optionsSeen.first())
    assertEquals(2, optionsSeen.first().displayId)
    assertNull(optionsSeen.last().displayId)
  }

  @Test
  fun `overlapping calls suppress emissions until both complete`() = runTest {
    verifyOverlappingCalls(firstThrows = false)
  }

  @Test
  fun `throwing call leaves the other call's suppression active`() = runTest {
    verifyOverlappingCalls(firstThrows = true)
  }

  private fun TestScope.verifyOverlappingCalls(firstThrows: Boolean) {
    val firstEntered = CountDownLatch(1)
    val secondStarted = CountDownLatch(1)
    val secondEntered = CountDownLatch(1)
    val releaseFirst = CountDownLatch(1)
    val releaseSecond = CountDownLatch(1)
    val firstFailure = AtomicReference<Throwable?>()
    val secondFailure = AtomicReference<Throwable?>()
    val calls = AtomicInteger()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(secondStarted),
        quickDebounceMs = 0,
        unsolicitedIntervalMs = 0,
        extractHierarchy = { _, _ ->
          when (calls.incrementAndGet()) {
            1 -> {
              firstEntered.countDown()
              await(releaseFirst)
              if (firstThrows) error("first extraction failed")
              ViewHierarchy(packageName = "first")
            }
            2 -> {
              secondEntered.countDown()
              await(releaseSecond)
              ViewHierarchy(packageName = "second")
            }
            else -> ViewHierarchy(packageName = "unsolicited")
          }
        },
      )
    val first =
      thread(name = "first extraction") {
        firstFailure.set(
          runCatching {
            debouncer.extractAfterQuiescence(
              quiescenceMs = 0,
              maxWaitMs = 1,
              initialEventWaitMs = 0,
            )
          }
            .exceptionOrNull(),
        )
      }
    try {
      await(firstEntered)
      val second =
        thread(name = "second extraction") {
          secondFailure.set(
            runCatching {
              debouncer.extractAfterQuiescence(
                quiescenceMs = 0,
                maxWaitMs = 1,
                initialEventWaitMs = 0,
              )
            }
              .exceptionOrNull(),
          )
        }
      try {
        await(secondStarted)
        releaseFirst.countDown()
        await(secondEntered)
        first.join(1_000)
        assertFalse(first.isAlive)
        if (firstThrows) {
          assertEquals("first extraction failed", firstFailure.get()?.message)
        } else {
          assertNull(firstFailure.get())
        }

        debouncer.onAccessibilityEvent()
        assertFalse("remaining call must suppress debounce", debouncer.getState().hasActiveJob)
        assertTrue(debouncer.hierarchyFlow.replayCache.isEmpty())
      } finally {
        releaseSecond.countDown()
        second.join(1_000)
      }
      assertFalse(second.isAlive)
      assertNull(secondFailure.get())

      debouncer.onAccessibilityEvent()
      assertTrue("last call must restore debounce", debouncer.getState().hasActiveJob)
      runCurrent()
      assertNotNull(debouncer.hierarchyFlow.replayCache.lastOrNull())
    } finally {
      releaseFirst.countDown()
      first.join(1_000)
    }
  }

  @Test
  fun `single call suppresses then restores emissions`() = runTest {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(),
        quickDebounceMs = 0,
        unsolicitedIntervalMs = 0,
        extractHierarchy = { _, _ ->
          entered.countDown()
          await(release)
          ViewHierarchy(packageName = "current")
        },
      )
    val worker = thread {
      failure.set(
        runCatching {
          debouncer.extractAfterQuiescence(
            quiescenceMs = 0,
            maxWaitMs = 1,
            initialEventWaitMs = 0,
          )
        }
          .exceptionOrNull(),
      )
    }
    try {
      await(entered)
      debouncer.onAccessibilityEvent()
      assertFalse(debouncer.getState().hasActiveJob)
      assertTrue(debouncer.hierarchyFlow.replayCache.isEmpty())
    } finally {
      release.countDown()
      worker.join(1_000)
    }
    assertFalse(worker.isAlive)
    assertNull(failure.get())

    debouncer.onAccessibilityEvent()
    assertTrue(debouncer.getState().hasActiveJob)
    runCurrent()
    assertNotNull(debouncer.hierarchyFlow.replayCache.lastOrNull())
  }
}
