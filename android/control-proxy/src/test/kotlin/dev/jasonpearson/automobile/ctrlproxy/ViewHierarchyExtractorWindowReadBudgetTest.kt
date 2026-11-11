package dev.jasonpearson.automobile.ctrlproxy

import android.util.SparseArray
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("window_read_skipped", result.ctrlProxyIncompleteReason)
    assertEquals(1, result.skippedWindowReads)
    assertEquals(listOf(2), result.skippedWindowIds)
  }

  @Test
  fun `a stalled capture root is skipped without being treated as a null root`() {
    useGuard()
    worker.durations.addAll(listOf(0, 0, 0, WINDOW_READ_BUDGET_MS + 1))
    val result = capture()
    assertEquals(listOf(1), result.windows!!.map { it.id })
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("window_read_skipped", result.ctrlProxyIncompleteReason)
    assertEquals(1, result.skippedWindowReads)
    assertEquals(listOf(2), result.skippedWindowIds)
  }

  @Test
  fun `null root reasons outrank skipped reads while listing outranks root skips`() {
    useGuard()
    val input =
      listOf(
        fakeWindow(1, 0, null, WindowState(active = true, focused = true)),
        windows()[1],
      )
    worker.durations.addAll(listOf(0, Long.MAX_VALUE))
    val result = extractor.extractFromAllWindows(input, null, options.copy(listingSkipped = true))
    assertEquals("active_window_null_root", result.ctrlProxyIncompleteReason)
    assertEquals(2, result.skippedWindowReads)
    assertEquals(listOf(2), result.skippedWindowIds)
    val partial =
      extractor.extractFromAllWindows(windows(), null, options.copy(listingSkipped = true))
    assertEquals("window_list_skipped", partial.ctrlProxyIncompleteReason)
    assertEquals(2, partial.skippedWindowReads)
    assertEquals(listOf(2), partial.skippedWindowIds)
  }

  @Test
  fun `a slow healthy large tree walks on the caller without a read budget`() {
    useGuard()
    val root =
      fakeNode(
        "example.app",
        state = NodeState(children = List(16) { fakeNode("example.app", text = "Child $it") }),
      )
    val input = listOf(fakeWindow(1, 0, root, WindowState(focused = true, active = true)))
    val slowWalk =
      options.copy(
        snapshotOptions =
          HierarchySnapshotOptions(
            isCancelled = {
              assertFalse("tree walk must not run on the read executor", worker.reading)
              worker.nowMs += 200
              false
            },
          ),
      )
    val result = extractor.extractFromAllWindows(input, null, slowWalk)
    assertEquals(listOf(1), result.windows!!.map { it.id })
    assertTrue(encoded(result).contains("Child 15"))
    assertTrue(worker.nowMs > WINDOW_READ_BUDGET_MS)
    // Primary selection and capture each read the root; no traversal is submitted.
    assertEquals(listOf(WINDOW_READ_BUDGET_MS, WINDOW_READ_BUDGET_MS), worker.budgets)
    assertTrue(worker.abandonedReads.isEmpty())
    assertNull(result.ctrlProxyIncomplete)
    assertNull(result.skippedWindowReads)
    assertNull(result.skippedWindowIds)
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
  fun `late root cannot change published trees metadata counters or later node reservations`() {
    useGuard()
    // Root probes succeed; the app's capture root read is abandoned. XR must still have its
    // reserved node allowance, and a later completion must not mutate either capture's state.
    worker.durations.addAll(listOf(0, 0, Long.MAX_VALUE, 0))
    val input = windows()
    val limited = options.copy(snapshotOptions = HierarchySnapshotOptions(maxNodes = 2))
    val result = extractor.extractFromAllWindows(input, null, limited)
    assertNull(result.error)
    assertEquals(listOf(2), result.windows!!.map { it.id })
    assertEquals("window_read_skipped", result.ctrlProxyIncompleteReason)
    assertEquals(1, result.skippedWindowReads)
    assertEquals(listOf(1), result.skippedWindowIds)
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
    val retried = capture(input)
    assertEquals(listOf(1, 2), retried.windows!!.map { it.id })
    assertNull(retried.ctrlProxyIncomplete)
    assertNull(retried.skippedWindowReads)
    assertNull(retried.skippedWindowIds)
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
  private class ListingService : android.accessibilityservice.AccessibilityService() {
    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit
  }

  private fun service() =
    org.robolectric.Robolectric.buildService(ListingService::class.java).create().get().also {
      org.robolectric.Shadows.shadowOf(it).setWindowsOnDisplay(0, windows())
    }

  @Test
  fun `a window listing that never returns yields no windows so capture falls back`() {
    useGuard()
    worker.durations.addAll(listOf(Long.MAX_VALUE))
    val selected = extractor.selectDisplayWindows(service())
    assertTrue(selected.windows.isEmpty())
    assertEquals(0, selected.displayId)
    assertTrue(selected.listingSkipped)
    val result =
      extractor.extractFromActiveWindow(
        fakeNode("example.app", text = "App"),
        options.copy(listingSkipped = selected.listingSkipped),
      )!!
    assertNotNull(result.hierarchy)
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("window_list_skipped", result.ctrlProxyIncompleteReason)
    assertEquals(1, result.skippedWindowReads)
    assertNull(result.skippedWindowIds)
  }

  @Test
  fun `a skipped listing keeps the active root display and root`() {
    useGuard()
    val root = fakeNode("example.app", text = "App")
    val window = fakeWindow(3, 0, root, WindowState(focused = true, active = true))
    org.robolectric.Shadows.shadowOf(window).setDisplayId(2)
    org.robolectric.Shadows.shadowOf(root).setAccessibilityWindowInfo(window)
    val service = service()
    org.robolectric.Shadows.shadowOf(service).setRootInActiveWindow(root)
    worker.durations += Long.MAX_VALUE

    val selected = extractor.selectDisplayWindows(service)

    assertEquals(2, selected.displayId)
    assertTrue(selected.windows.isEmpty())
    assertTrue(selected.listingSkipped)
    val captureRoot = fakeNode("example.app", text = "App")
    // The lookup recycles its own window and root, so the capture gets its own pair.
    val captureWindow = fakeWindow(3, 0, captureRoot, WindowState(focused = true, active = true))
    org.robolectric.Shadows.shadowOf(captureWindow).setDisplayId(2)
    org.robolectric.Shadows.shadowOf(captureRoot).setAccessibilityWindowInfo(captureWindow)
    assertEquals(
      captureRoot,
      extractor.rootForDisplay(captureRoot, selected.windows, selected.displayId),
    )
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
  }

  @Test
  fun `a skipped listing keeps an explicitly requested display`() {
    useGuard()
    worker.durations += Long.MAX_VALUE

    val selected = extractor.selectDisplayWindows(service(), 7)

    assertEquals(7, selected.displayId)
    assertTrue(selected.windows.isEmpty())
    assertTrue(selected.listingSkipped)
    assertEquals(1, worker.budgets.size)
  }

  @Test
  fun `a skipped active display lookup defaults to display zero`() {
    useGuard()
    worker.durations.addAll(listOf(Long.MAX_VALUE, Long.MAX_VALUE))

    val selected = extractor.selectDisplayWindows(service())

    assertEquals(0, selected.displayId)
    assertTrue(selected.listingSkipped)
    assertEquals(2 * WINDOW_READ_BUDGET_MS, worker.nowMs)
  }

  @Test
  fun `a responsive window listing is returned unchanged`() {
    useGuard()
    val selected = extractor.selectDisplayWindows(service())
    assertEquals(listOf(1, 2), selected.windows.map { it.id })
    assertFalse(selected.listingSkipped)
  }
}
