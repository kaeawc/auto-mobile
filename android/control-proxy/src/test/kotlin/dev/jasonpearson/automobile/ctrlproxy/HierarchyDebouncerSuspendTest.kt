package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class HierarchyDebouncerSuspendTest {
  @Test
  fun `suspend quiescence returns same tree as blocking facade without emitting`() = runTest {
    val expected = ViewHierarchy(packageName = "settled")
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider =
          object : TimeProvider {
            override fun currentTimeMillis() = testScheduler.currentTime
          },
        extractHierarchy = { _, _ -> expected },
      )
    val suspending =
      debouncer.extractAfterQuiescenceSuspending(
        quiescenceMs = 0,
        initialEventWaitMs = 0,
      )
    val blocking = debouncer.extractAfterQuiescence(quiescenceMs = 0, initialEventWaitMs = 0)
    assertEquals(expected, suspending)
    assertEquals(suspending, blocking)
    assertTrue(debouncer.hierarchyFlow.replayCache.isEmpty())
  }

  @Test
  fun `polling suspends and cancellation releases only its own flow suppression`() = runTest {
    val expected = ViewHierarchy(packageName = "settled")
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider =
          object : TimeProvider {
            override fun currentTimeMillis() = testScheduler.currentTime
          },
        extractHierarchy = { _, _ -> expected },
      )
    val first = launch { debouncer.extractAfterQuiescenceSuspending() }
    val second = launch { debouncer.extractAfterQuiescenceSuspending() }
    runCurrent()
    assertTrue(first.isActive)
    assertTrue(second.isActive)
    debouncer.extractImmediately()
    assertTrue(debouncer.hierarchyFlow.replayCache.isEmpty())
    first.cancelAndJoin()
    debouncer.extractImmediately()
    assertTrue(debouncer.hierarchyFlow.replayCache.isEmpty())
    second.cancelAndJoin()
    debouncer.extractImmediately()
    assertEquals(1, debouncer.hierarchyFlow.replayCache.size)
  }

  @Test
  fun `cancelled extraction preserves cached tree hash and flow until a live capture`() = runTest {
    val complete = ViewHierarchy(updatedAt = 0, packageName = "complete")
    val truncated = ViewHierarchy(updatedAt = 0, packageName = "truncated")
    val discarded = mutableListOf<ViewHierarchy>()
    var next = complete
    var cancelDuringWalk = false
    var cancelled = false
    val debouncer =
      HierarchyDebouncer(
        scope = backgroundScope,
        timeProvider =
          object : TimeProvider {
            override fun currentTimeMillis() = testScheduler.currentTime
          },
        onDiscardedHierarchy = { discarded += it },
        extractHierarchy = { _, _ ->
          if (cancelDuringWalk) cancelled = true
          next
        },
      )
    debouncer.extractImmediately()
    val firstResult = debouncer.hierarchyFlow.replayCache.single()
    assertTrue(firstResult is HierarchyResult.Changed)
    next = truncated
    cancelDuringWalk = true
    assertNull(
      debouncer.extractImmediately(
        snapshotOptions = HierarchySnapshotOptions(isCancelled = { cancelled }),
      ),
    )
    assertEquals(listOf(truncated), discarded)
    assertSame(complete, debouncer.getLastHierarchy())
    assertSame(firstResult, debouncer.hierarchyFlow.replayCache.single())
    cancelDuringWalk = false
    cancelled = false
    next = complete
    assertSame(complete, debouncer.extractImmediately())
    assertTrue(debouncer.hierarchyFlow.replayCache.single() is HierarchyResult.Unchanged)
    next = truncated
    debouncer.extractImmediately()
    assertTrue(debouncer.hierarchyFlow.replayCache.single() is HierarchyResult.Changed)
  }
}
