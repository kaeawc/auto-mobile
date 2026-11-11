package dev.jasonpearson.automobile.ctrlproxy

import android.util.SparseArray
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

internal abstract class WindowReadBudgetFixtures : ViewHierarchyExtractorFixtures() {
  protected val worker = FakeWindowReadExecutor()
  private val guard = QuarantiningWindowReadGuard(worker, nowMs = { worker.nowMs })
  protected val options = HierarchyExtractionOptions(disableAllFiltering = true)

  protected fun useGuard() {
    extractor = ViewHierarchyExtractor(windowReadGuard = guard)
  }

  protected fun windows(): List<AccessibilityWindowInfo> =
    listOf(
      fakeWindow(
        1,
        0,
        fakeNode("example.app", text = "App"),
        WindowState(focused = true, active = true),
      ),
      fakeWindow(
        2,
        1,
        fakeNode("com.android.systemui.xrhomeenv", text = "Environment"),
        WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM),
      ),
    )

  protected fun capture(windows: List<AccessibilityWindowInfo> = windows()): ViewHierarchy =
    extractor.extractFromAllWindows(windows, null, options)

  protected fun encoded(result: ViewHierarchy): String =
    json.encodeToString(ViewHierarchy.serializer(), result.copy(updatedAt = 0))
}

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorWindowReadBudgetTest : WindowReadBudgetFixtures() {
  @Test
  fun `a root read that never returns is skipped and the app remains usable`() {
    useGuard()
    // Primary-window selection probes app then XR. The timed-out XR probe must not be repeated
    // by the subsequent full capture.
    worker.durations.addAll(listOf(0, Long.MAX_VALUE))
    val result = capture()
    assertNull(result.error)
    assertNotNull(result.hierarchy)
    assertEquals("example.app", result.packageName)
    assertEquals(listOf(1), result.windows!!.map { it.id })
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
    assertEquals(3, worker.budgets.size)
    assertEquals(1, worker.abandonedReads.size)
    assertTrue(extractor.stats.skippedWindowReads.get() > 0)
  }

  @Test
  fun `a slow full tree read within budget is kept with unchanged output`() {
    useGuard()
    val input = windows()
    val expected = encoded(capture(input))
    worker.durations.addAll(listOf(0, 0, 0, WINDOW_READ_BUDGET_MS - 1))
    val result = capture(input)
    assertEquals(listOf(1, 2), result.windows!!.map { it.id })
    assertEquals(expected, encoded(result))
    assertTrue(worker.abandonedReads.isEmpty())
  }

  @Test
  fun `normal windows retain hierarchy window metadata and snapshot limits`() {
    useGuard()
    val input = windows()
    val result = capture(input)
    val immediate =
      ViewHierarchyExtractor(windowReadGuard = ImmediateWindowReadGuard())
        .extractFromAllWindows(input, null, options)
    assertEquals(encoded(immediate), encoded(result))
    assertEquals(listOf(1, 2), result.windows!!.map { it.id })
    assertNull(result.ctrlProxyIncomplete)
    assertNull(result.truncationReasons)
    assertTrue(encoded(result).contains("Environment"))
    assertTrue(worker.budgets.all { it == WINDOW_READ_BUDGET_MS })
  }

  @Test
  fun `late capture cannot change published trees metadata counters or later node reservations`() {
    useGuard()
    // Root probes succeed; the app's tree read is abandoned. The XR read must still have its
    // reserved node allowance, and a later completion must not mutate either capture's state.
    worker.durations.addAll(listOf(0, 0, Long.MAX_VALUE, 0))
    val input = windows()
    val limited = options.copy(snapshotOptions = HierarchySnapshotOptions(maxNodes = 2))
    val result = extractor.extractFromAllWindows(input, null, limited)
    assertNull(result.error)
    assertEquals(listOf(2), result.windows!!.map { it.id })
    val before = encoded(result)
    val visited = extractor.stats.nodesVisited.get()
    worker.abandonedReads.removeFirst().invoke()
    assertEquals(before, encoded(result))
    assertEquals(visited, extractor.stats.nodesVisited.get())
    val next = extractor.extractFromAllWindows(input, null, limited)
    assertEquals(listOf(2), next.windows!!.map { it.id })
    assertEquals(before, encoded(next))
  }

  @Test
  fun `quarantined XR window is skipped without submission and retried after fake TTL`() {
    useGuard()
    val input = windows()
    worker.durations.addAll(listOf(0, Long.MAX_VALUE))
    assertEquals(listOf(1), capture(input).windows!!.map { it.id })
    val submitted = worker.budgets.size
    assertEquals(listOf(1), capture(input).windows!!.map { it.id })
    // Only the healthy app's probe and full capture were submitted.
    assertEquals(submitted + 2, worker.budgets.size)
    worker.abandonedReads.removeFirst().invoke()
    worker.nowMs += WINDOW_READ_QUARANTINE_MS
    assertEquals(listOf(1, 2), capture(input).windows!!.map { it.id })
    val recovered = worker.budgets.size
    assertEquals(listOf(1, 2), capture(input).windows!!.map { it.id })
    assertEquals(recovered + 4, worker.budgets.size)
  }

  private class ImmediateWindowReadGuard : WindowReadGuard {
    override fun <T> read(
      windowId: Int,
      read: () -> T,
      cleanup: () -> Unit,
      discard: (T) -> Unit,
    ): WindowReadResult<T> =
      try {
        WindowReadResult.Completed(read())
      } finally {
        cleanup()
      }
  }
}

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorWindowReadPathsTest : WindowReadBudgetFixtures() {
  @Test
  fun `display overlay root probe shares quarantine with capture`() {
    useGuard()
    val input = windows()
    val all = SparseArray<List<AccessibilityWindowInfo>>()
    all.put(0, input)
    worker.durations.addAll(listOf(0, Long.MAX_VALUE))
    assertEquals(input, extractor.windowsForDisplay(all, 0))
    assertEquals(listOf(1), capture(input).windows!!.map { it.id })
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
    assertEquals(4, worker.budgets.size)
  }

  @Test
  fun `focus search and traversal also skip quarantined windows without another read`() {
    useGuard()
    val input = windows()
    // Traversal searches every window for focus, then collects from each. A timed-out focus
    // search must not trigger another XR root request in collection or a hierarchy capture.
    worker.durations.addAll(listOf(0, Long.MAX_VALUE))
    val traversal = extractor.extractTraversalOrderFromAllWindows(input, null)
    assertTrue(traversal.elements.isEmpty())
    val submitted = worker.budgets.size
    assertEquals(listOf(1), capture(input).windows!!.map { it.id })
    assertEquals(submitted + 2, worker.budgets.size)
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
  }

  @Test
  fun `hierarchy focus discovery cannot block capture of the other windows`() {
    useGuard()
    val input = windows()
    org.robolectric.Shadows.shadowOf(input[1]).setAccessibilityFocused(true)
    worker.durations += Long.MAX_VALUE
    val result = capture(input)
    assertNull(result.error)
    assertEquals(listOf(1), result.windows!!.map { it.id })
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
    assertEquals(3, worker.budgets.size)
  }

  @Test
  fun `display fallback root is guarded and does not probe the same failed candidate twice`() {
    useGuard()
    val input = windows()
    worker.durations += Long.MAX_VALUE
    assertNull(extractor.rootForDisplay(null, input, 0))
    assertEquals(1, worker.budgets.size)
    assertEquals(listOf(2), capture(input).windows!!.map { it.id })
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
  }
}

@RunWith(RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34])
internal class WindowListBudgetTest : WindowReadBudgetFixtures() {
  private class ListingService(val listing: SparseArray<List<AccessibilityWindowInfo>>) :
    android.accessibilityservice.AccessibilityService() {
    override fun getWindowsOnAllDisplays() = listing

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit
  }

  private fun service() =
    ListingService(SparseArray<List<AccessibilityWindowInfo>>().also { it.put(0, windows()) })

  @Test
  fun `a window listing that never returns yields no windows so capture falls back`() {
    useGuard()
    worker.durations.addAll(listOf(Long.MAX_VALUE))
    val selected = extractor.selectDisplayWindows(service())
    assertTrue(selected.windows.isEmpty())
    assertEquals(0, selected.displayId)
    assertTrue(extractor.stats.skippedWindowReads.get() > 0)
  }

  @Test
  fun `a responsive window listing is returned unchanged`() {
    useGuard()
    val selected = extractor.selectDisplayWindows(service())
    assertEquals(listOf(1, 2), selected.windows.map { it.id })
  }
}
