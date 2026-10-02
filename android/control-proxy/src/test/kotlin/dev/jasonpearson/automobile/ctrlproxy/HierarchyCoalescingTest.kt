package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class HierarchyCoalescingTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun stubAndroidLogging() {
      mockkStatic(Log::class)
      every { Log.d(any(), any()) } returns 0
      runTest {} // initialize the coroutine test scheduler outside per-test timing
    }

    @JvmStatic
    @AfterClass
    fun restoreAndroidLogging() {
      unmockkStatic(Log::class)
    }
  }

  private class FakeTime(var now: Long = 1_000L) : TimeProvider {
    override fun currentTimeMillis(): Long = now
  }

  @Test
  fun `connected but idle causes no extraction`() = runTest {
    val stats = CtrlProxyWorkStats()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(),
        stats = stats,
        extractHierarchy = { _, _ -> ViewHierarchy(packageName = "idle") },
      )

    advanceTimeBy(1_000)
    runCurrent()

    assertEquals(0L, stats.extractions.get())
    assertEquals(0L, stats.accessibilityEvents.get())
    assertTrue(debouncer.hierarchyFlow.replayCache.isEmpty())
  }

  @Test
  fun `burst is coalesced and final state is extracted once after throttle`() = runTest {
    val time = FakeTime()
    val stats = CtrlProxyWorkStats()
    var state = 0
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        quickDebounceMs = 5,
        unsolicitedIntervalMs = 250,
        stats = stats,
        extractHierarchy = { _, _ -> ViewHierarchy(packageName = "state-$state") },
      )

    debouncer.onAccessibilityEvent()
    advanceTimeBy(5)
    time.now += 5
    runCurrent()
    assertEquals(1L, stats.extractions.get())

    repeat(100) {
      state = it + 1
      debouncer.onAccessibilityEvent()
    }
    assertEquals(100L, stats.coalescedEvents.get())
    advanceTimeBy(249)
    time.now += 249
    runCurrent()
    assertEquals(1L, stats.extractions.get())

    advanceTimeBy(1)
    time.now += 1
    runCurrent()
    assertEquals(2L, stats.extractions.get())
    assertEquals("state-100", debouncer.getLastHierarchy()?.packageName)
    assertEquals(
      "state-100",
      (debouncer.hierarchyFlow.replayCache.last() as HierarchyResult.Changed).hierarchy.packageName,
    )
    advanceTimeBy(500)
    time.now += 500
    runCurrent()
    assertEquals(2L, stats.extractions.get())
  }

  @Test
  fun `zero client interval still bounds unsolicited extraction without delaying explicit pulls`() =
    runTest {
      val time = FakeTime()
      val stats = CtrlProxyWorkStats()
      var state = 0
      val debouncer =
        HierarchyDebouncer(
          scope = backgroundScope,
          timeProvider = time,
          unsolicitedIntervalMs = 0,
          stats = stats,
          extractHierarchy = { _, _ -> ViewHierarchy(packageName = "state-$state") },
        )

      debouncer.onAccessibilityEvent()
      advanceTimeBy(5)
      time.now += 5
      runCurrent()
      assertEquals(1L, stats.extractions.get())

      debouncer.setUnsolicitedIntervalMs(0)
      state = 1
      repeat(100) { debouncer.onAccessibilityEvent() }
      advanceTimeBy(49)
      time.now += 49
      runCurrent()
      assertEquals(1L, stats.extractions.get())

      advanceTimeBy(1)
      time.now += 1
      runCurrent()
      assertEquals(2L, stats.extractions.get())

      state = 2
      assertEquals("state-2", debouncer.extractImmediately(skipFlowEmit = true)?.packageName)
      assertEquals(3L, stats.extractions.get())
    }

  @Test
  fun `event during extraction requests exactly one trailing refresh`() = runTest {
    val time = FakeTime()
    val stats = CtrlProxyWorkStats()
    var state = 0
    lateinit var debouncer: HierarchyDebouncer
    debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        stats = stats,
        extractHierarchy = { _, _ ->
          if (state == 0) {
            state = 1
            repeat(20) { debouncer.onAccessibilityEvent() }
          }
          ViewHierarchy(packageName = "state-$state")
        },
      )
    debouncer.onAccessibilityEvent()
    advanceTimeBy(5)
    time.now += 5
    runCurrent()
    assertEquals(1L, stats.extractions.get())
    advanceTimeBy(250)
    time.now += 250
    runCurrent()
    assertEquals(2L, stats.extractions.get())
    assertEquals("state-1", debouncer.getLastHierarchy()?.packageName)
  }

  @Test
  fun `replaced debounce job cannot extract or clear its replacement`() = runTest {
    val time = FakeTime()
    val stats = CtrlProxyWorkStats()
    var lockAttempts = 0
    lateinit var debouncer: HierarchyDebouncer
    debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        quickDebounceMs = 5,
        unsolicitedIntervalMs = 250,
        stats = stats,
        beforeDebounceLock = {
          if (++lockAttempts == 1) {
            debouncer.setUnsolicitedIntervalMs(0)
          }
        },
        extractHierarchy = { _, _ -> ViewHierarchy(packageName = "current") },
      )

    debouncer.onAccessibilityEvent()
    advanceTimeBy(5)
    time.now += 5
    runCurrent()
    assertEquals(0L, stats.extractions.get())
    assertTrue(debouncer.getState().hasActiveJob)

    debouncer.onAccessibilityEvent()
    advanceTimeBy(5)
    time.now += 5
    runCurrent()
    assertEquals(1L, stats.extractions.get())

    advanceTimeBy(5)
    time.now += 5
    runCurrent()
    assertEquals(1L, stats.extractions.get())
  }

  @Test
  fun `explicit requests bypass pending event work and return each fresh state`() = runTest {
    val time = FakeTime()
    val stats = CtrlProxyWorkStats()
    var state = 0
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        stats = stats,
        extractHierarchy = { _, _ -> ViewHierarchy(packageName = "state-$state") },
      )
    debouncer.onAccessibilityEvent()
    state = 1
    assertEquals("state-1", debouncer.extractImmediately(skipFlowEmit = true)?.packageName)
    state = 2
    assertEquals("state-2", debouncer.extractImmediately(skipFlowEmit = true)?.packageName)
    assertEquals(2L, stats.extractions.get())
  }

  @Test
  fun `quiescence during active extraction retains owner for trailing refresh`() = runTest {
    val time = FakeTime()
    val stats = CtrlProxyWorkStats()
    var calls = 0
    var completions = 0
    lateinit var debouncer: HierarchyDebouncer
    debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        stats = stats,
        beforeDebounceCompletion = {
          if (++completions == 1) {
            debouncer.extractAfterQuiescence(
              quiescenceMs = 0,
              maxWaitMs = 1,
              initialEventWaitMs = 0,
            )
            debouncer.onAccessibilityEvent()
          }
        },
        extractHierarchy = { _, _ -> ViewHierarchy(packageName = "state-${++calls}") },
      )

    debouncer.onAccessibilityEvent()
    advanceTimeBy(5)
    time.now += 5
    runCurrent()
    advanceTimeBy(250)
    time.now += 250
    runCurrent()
    assertEquals(3L, stats.extractions.get())
  }

  @Test
  fun `explicit request consumes queued default extraction`() = runTest {
    val stats = CtrlProxyWorkStats()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(),
        stats = stats,
        extractHierarchy = { disabled, _ ->
          ViewHierarchy(packageName = if (disabled) "explicit" else "default")
        },
      )

    debouncer.onAccessibilityEvent()
    assertEquals(
      "explicit",
      debouncer.extractImmediately(skipFlowEmit = true, disableAllFiltering = true)?.packageName,
    )
    advanceTimeBy(5)
    runCurrent()
    assertEquals(1L, stats.extractions.get())
    assertEquals("explicit", debouncer.getLastHierarchy()?.packageName)
  }
}
