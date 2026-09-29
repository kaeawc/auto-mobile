package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Thread-safety of [HierarchyDebouncer] state shared by the main, IO and caller threads (#6447).
 */
class HierarchyDebouncerThreadingTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun stubAndroidLogging() {
      mockkStatic(Log::class)
      every { Log.d(any(), any()) } returns 0
      every { Log.w(any(), any<String>()) } returns 0
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

  /** Monotonic clock that is safe to read from several threads at once. */
  private class TickingTime : TimeProvider {
    private val now = AtomicLong(1_000L)

    override fun currentTimeMillis(): Long = now.incrementAndGet()
  }

  private fun hierarchy(name: String) = ViewHierarchy(packageName = name)

  private fun assertHashMatchesCachedHierarchy(debouncer: HierarchyDebouncer) {
    val cached = debouncer.getLastHierarchy()
    val expected = cached?.let { StructuralHasher.computeHash(it) } ?: 0
    assertEquals(
      "lastHash must describe getLastHierarchy()",
      expected,
      debouncer.getState().lastHash,
    )
  }

  @Test
  fun `extractNow job is tracked while in flight`() = runTest {
    val stats = CtrlProxyWorkStats()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(),
        stats = stats,
        extractHierarchy = { _, _ -> hierarchy("now") },
      )

    debouncer.extractNow()
    assertTrue("extractNow's job must be visible", debouncer.getState().hasActiveJob)

    runCurrent()
    assertEquals(1L, stats.extractions.get())
    assertFalse(debouncer.getState().hasActiveJob)
    assertEquals("now", debouncer.getLastHierarchy()?.packageName)
  }

  @Test
  fun `reset cancels a queued extractNow`() = runTest {
    val stats = CtrlProxyWorkStats()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = FakeTime(),
        stats = stats,
        extractHierarchy = { _, _ -> hierarchy("stale") },
      )

    debouncer.extractNow()
    debouncer.reset()
    runCurrent()

    assertEquals(0L, stats.extractions.get())
    assertNull(debouncer.getLastHierarchy())
    assertFalse(debouncer.getState().hasActiveJob)
  }

  @Test
  fun `later extraction wins and hash matches cached hierarchy`() = runTest {
    val time = FakeTime()
    var next = "h1"
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        extractHierarchy = { _, _ -> hierarchy(next) },
      )

    debouncer.extractNow()
    runCurrent()
    assertEquals("h1", debouncer.getLastHierarchy()?.packageName)
    next = "h2"
    debouncer.onAccessibilityEvent()
    advanceTimeBy(5)
    time.now += 5
    runCurrent()

    assertEquals("h2", debouncer.getLastHierarchy()?.packageName)
    assertHashMatchesCachedHierarchy(debouncer)
  }

  @Test
  fun `unchanged capture opens the animation window and counts skipped events`() = runTest {
    val time = FakeTime()
    val stats = CtrlProxyWorkStats()
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider = time,
        stats = stats,
        animationSkipWindowMs = 100,
        extractHierarchy = { _, _ -> hierarchy("same") },
      )

    debouncer.extractNowBlocking()
    debouncer.extractNowBlocking()
    val state = debouncer.getState()
    assertTrue(state.inAnimationMode)
    assertEquals(time.now + 100, state.animationModeEndTime)

    repeat(3) { debouncer.onAccessibilityEvent() }
    assertEquals(3, debouncer.getState().skippedEventCount)
    assertEquals(3L, stats.coalescedEvents.get())

    time.now += 100
    debouncer.onAccessibilityEvent()
    assertFalse("expired window must be exited", debouncer.getState().inAnimationMode)
  }

  /**
   * Drives the debouncer from two caller threads at once — one playing the AccessibilityService
   * main thread, one the WebSocket read loop — while launched extractions run on a third (IO)
   * thread. Pre-fix the unguarded animation/hash fields and the untracked extractNow jobs raced;
   * this asserts no thread throws, nothing deadlocks, and the cached hash and hierarchy agree.
   */
  @Test
  fun `concurrent main and caller threads keep state consistent`() {
    val ioExecutor = Executors.newSingleThreadExecutor()
    val scope = CoroutineScope(SupervisorJob() + ioExecutor.asCoroutineDispatcher())
    val counter = AtomicInteger()
    val debouncer =
      HierarchyDebouncer(
        scope = scope,
        timeProvider = TickingTime(),
        quickDebounceMs = 0,
        animationSkipWindowMs = 2,
        unsolicitedIntervalMs = 0,
        // Alternate between a few trees so both Changed and Unchanged paths are exercised.
        extractHierarchy = { _, _ -> hierarchy("tree-${counter.incrementAndGet() % 3}") },
      )
    val failure = AtomicReference<Throwable?>(null)
    val start = CountDownLatch(1)
    val iterations = 50

    fun worker(name: String, body: (Int) -> Unit) =
      Thread(
          {
            try {
              start.await()
              repeat(iterations) { body(it) }
            } catch (t: Throwable) {
              failure.compareAndSet(null, t)
            }
          },
          name,
        )
        .apply { start() }

    val main = worker("fake-main") { debouncer.onAccessibilityEvent() }
    val caller =
      worker("fake-read-loop") { i ->
        when (i % 3) {
          0 -> debouncer.extractNowBlocking()
          1 -> debouncer.extractNow()
          else -> debouncer.getState()
        }
      }
    start.countDown()
    main.join(5_000)
    caller.join(5_000)

    try {
      assertFalse("main thread deadlocked", main.isAlive)
      assertFalse("caller thread deadlocked", caller.isAlive)
      failure.get()?.let { throw AssertionError("worker thread failed", it) }

      runBlocking { scope.coroutineContext.job.cancelAndJoin() }
      assertHashMatchesCachedHierarchy(debouncer)
    } finally {
      ioExecutor.shutdownNow()
      ioExecutor.awaitTermination(1, TimeUnit.SECONDS)
    }
  }
}
