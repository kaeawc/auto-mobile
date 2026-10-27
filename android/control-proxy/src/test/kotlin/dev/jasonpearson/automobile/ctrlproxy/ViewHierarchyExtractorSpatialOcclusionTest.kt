package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import java.util.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorSpatialOcclusionTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `union area matches original sweep for synthetic and seeded rectangles`() {
    val fixtures =
      listOf(
        emptyList(),
        listOf(bounds(0, 0, 10, 10), bounds(5, 5, 15, 15)), // overlapping
        listOf(bounds(0, 0, 20, 20), bounds(5, 5, 10, 10)), // nested
        listOf(bounds(0, 0, 10, 10), bounds(20, 20, 30, 30)), // disjoint
        listOf(bounds(0, 0, 10, 10), bounds(10, 0, 20, 10)), // touching edges
        listOf(bounds(0, 0, 10, 10), bounds(0, 0, 10, 10)), // identical duplicates
        listOf(bounds(0, 0, 10, 5), bounds(0, 0, 10, 10), bounds(0, 0, 10, 5)),
      )
    val random = Random(6623L)
    val randomFixtures =
      (0 until 40).map {
        (0 until random.nextInt(9)).map {
          val left = random.nextInt(21) - 10
          val top = random.nextInt(21) - 10
          bounds(left, top, left + random.nextInt(11), top + random.nextInt(11))
        }
      }

    for (rectangles in fixtures + randomFixtures) {
      for (maxArea in listOf(null, 0, 1, 25, 95, 1000)) {
        assertEquals(
          "rectangles=$rectangles maxArea=$maxArea",
          originalCalculateUnionArea(rectangles, maxArea),
          extractor.calculateUnionArea(rectangles, maxArea),
        )
      }
    }
  }

  @Test
  fun `multi-window overlapping nested and disjoint nodes retain coverage`() {
    val app =
      elementWithBounds(
        resourceId = "app",
        bounds = bounds(0, 0, 100, 100),
        children =
          listOf(
            elementWithBounds(resourceId = "nested-target", bounds = bounds(0, 0, 50, 100)),
            elementWithBounds(resourceId = "disjoint-target", bounds = bounds(80, 0, 100, 100)),
          ),
      )
    val overlapping =
      elementWithBounds(
        resourceId = "overlapping",
        bounds = bounds(0, 0, 40, 100),
        children =
          listOf(elementWithBounds(resourceId = "nested-cover", bounds = bounds(10, 0, 20, 100))),
      )
    val disjoint = elementWithBounds(resourceId = "disjoint", bounds = bounds(60, 0, 80, 100))
    val info =
      extractor.buildOcclusionInfoForTest(
        listOf(
          extractor.createWindowEntry(1, 0, app),
          extractor.createWindowEntry(2, 1, overlapping),
          extractor.createWindowEntry(3, 2, disjoint),
        ),
      )

    assertEquals(
      mapOf(
        "NodeKey(windowKey=1, path=)" to
          "OcclusionInfo(coverage=0.6, occludedBy=overlapping, occludedByViewId=overlapping)",
        "NodeKey(windowKey=1, path=0)" to
          "OcclusionInfo(coverage=0.8, occludedBy=overlapping, occludedByViewId=overlapping)",
      ),
      info.mapKeys { it.key.toString() }.mapValues { it.value.toString() },
    )
  }

  @Test
  fun `spatial candidate comparisons grow below quadratic across app SystemUI and IME`() {
    fun comparisons(count: Int): Long {
      val stats = CtrlProxyWorkStats()
      val indexedExtractor = ViewHierarchyExtractor(stats = stats)
      fun window(id: String): UIElementInfo =
        elementWithBounds(
          resourceId = "$id-root",
          bounds = bounds(0, 0, count * 20, 100),
          children =
            (0 until count).map { index ->
              elementWithBounds(
                resourceId = "$id-$index",
                bounds = bounds(index * 20, 0, index * 20 + 10, 100),
              )
            },
        )
      indexedExtractor.buildOcclusionInfoForTest(
        listOf(
          indexedExtractor.createWindowEntry(1, 0, window("app")),
          indexedExtractor.createWindowEntry(2, 1, window("system"), windowType = "system"),
          indexedExtractor.createWindowEntry(3, 2, window("ime"), windowType = "input_method"),
        ),
      )
      return stats.occlusionCandidateComparisons.get()
    }

    val small = comparisons(20)
    val large = comparisons(40)
    assertTrue("expected candidate comparisons in small fixture", small > 0)
    assertTrue("doubling nodes must grow below quadratic: $small -> $large", large < small * 3)
  }

  @Test
  fun `dense duplicate bounds compare one occluder per rectangle`() {
    val stats = CtrlProxyWorkStats()
    val indexedExtractor = ViewHierarchyExtractor(stats = stats)
    fun window(id: String): UIElementInfo =
      elementWithBounds(
        resourceId = "$id-root",
        bounds = bounds(0, 0, 1080, 100),
        children =
          (0 until 100).map { index ->
            elementWithBounds(resourceId = "$id-$index", bounds = bounds(0, 0, 1080, 100))
          },
      )

    val occlusionInfo =
      indexedExtractor.buildOcclusionInfoForTest(
        listOf(
          indexedExtractor.createWindowEntry(1, 0, window("app")),
          indexedExtractor.createWindowEntry(2, 1, window("overlay")),
        ),
      )
    assertTrue(
      "duplicate rectangles must not multiply index visits: ${stats.occlusionIndexEntriesVisited.get()}",
      stats.occlusionIndexEntriesVisited.get() <= 101L,
    )
    assertTrue(stats.occlusionCandidateComparisons.get() <= 101L)
    val filtered =
      indexedExtractor.filterOccludedHierarchyForTest(
        window("app"),
        occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )
    assertEquals("overlay-root", filtered?.occludedBy)
  }

  @Test
  fun `duplicate bounds retain first eligible occluder across equal layer windows`() {
    val app =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 100, 100),
        children =
          listOf(elementWithBounds(resourceId = "app-child", bounds = bounds(0, 0, 100, 100))),
      )
    val overlay =
      elementWithBounds(
        resourceId = "overlay-root",
        bounds = bounds(0, 0, 100, 100),
        children =
          listOf(elementWithBounds(resourceId = "overlay-child", bounds = bounds(0, 0, 100, 100))),
      )
    val occlusionInfo =
      extractor.buildOcclusionInfoForTest(
        listOf(
          extractor.createWindowEntry(1, 0, app),
          extractor.createWindowEntry(2, 0, overlay),
        ),
      )
    val root =
      extractor.filterOccludedHierarchyForTest(
        app,
        occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )
    val child =
      extractor.filterOccludedHierarchyForTest(
        app.children.single(),
        occlusionInfo,
        windowKey = 1,
        path = "0",
        isRoot = true,
      )
    assertEquals("overlay-root", root?.occludedBy)
    assertEquals("overlay-child", child?.occludedBy)
  }

  @Test
  fun `IME wrapper spanning full screen does not occlude app window hierarchy`() {
    // On a Pixel 10 Pro with Gboard, the IME window reports bounds matching the keyboard
    // (e.g. y=1464..2410) but its accessibility node tree has a transparent outer wrapper
    // spanning the entire area below the status bar (e.g. y=172..2410). If those wrapper
    // nodes participate in cross-window occlusion, they cover ~93% of the app window; together
    // with the status bar that pushes the app over the 0.95 hidden threshold and every Slack
    // node gets stripped. The fix excludes IME nodes from being occluders for other windows.
    val toolbar = elementWithBounds(resourceId = "toolbar", bounds = bounds(0, 172, 1080, 400))
    val composer = elementWithBounds(resourceId = "composer", bounds = bounds(0, 1200, 1080, 1340))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 1080, 2410),
        children = listOf(toolbar, composer),
      )
    // IME root reports the full transparent wrapper bounds, not the actual keyboard rect.
    val imeWrapper =
      elementWithBounds(resourceId = "ime-wrapper", bounds = bounds(0, 172, 1080, 2410))

    val appEntry =
      extractor.createWindowEntry(
        windowId = 116,
        windowLayer = 0,
        hierarchy = appRoot,
        windowType = "application",
        details = WindowDetails(isActive = true, isFocused = true),
      )
    val imeEntry =
      extractor.createWindowEntry(
        windowId = 108,
        windowLayer = 5,
        hierarchy = imeWrapper,
        windowType = "input_method",
        details = WindowDetails(isActive = false, isFocused = false),
      )
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, imeEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 116,
        path = "",
        isRoot = true,
      )

    assertNotNull("App root must survive IME wrapper occlusion", filtered)
    assertNotNull(
      "Toolbar above the keyboard must remain",
      findElementByResourceId(filtered!!, "toolbar"),
    )
    assertNotNull(
      "Composer above the keyboard must remain",
      findElementByResourceId(filtered, "composer"),
    )
  }

  @Test
  fun `keyboard window does not remove app window hierarchy via occlusion`() {
    // Simulate the keyboard-open scenario from issue #1488:
    // App window covers full screen [0,0][1280,2856]
    // Keyboard (IME) window covers bottom half [0,1395][1280,2856]
    // App elements above the keyboard should NOT be removed
    val toolbar = elementWithBounds(resourceId = "toolbar", bounds = bounds(0, 156, 1280, 400))
    val editText = elementWithBounds(resourceId = "edit-text", bounds = bounds(0, 400, 1280, 500))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 1280, 2856),
        children = listOf(toolbar, editText),
      )
    val keyboardRoot =
      elementWithBounds(resourceId = "keyboard", bounds = bounds(0, 1395, 1280, 2856))

    val appEntry =
      extractor.createWindowEntry(
        windowId = 46,
        windowLayer = 0,
        hierarchy = appRoot,
        windowType = "application",
        details = WindowDetails(isActive = true, isFocused = true),
      )
    val imeEntry =
      extractor.createWindowEntry(
        windowId = 31,
        windowLayer = 1,
        hierarchy = keyboardRoot,
        windowType = "input_method",
        details = WindowDetails(isActive = false, isFocused = false),
      )
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, imeEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 46,
        path = "",
        isRoot = true,
      )

    assertNotNull("App root should not be removed by keyboard occlusion", filtered)
    assertNotNull(
      "Toolbar above keyboard should be preserved",
      findElementByResourceId(filtered!!, "toolbar"),
    )
    assertNotNull(
      "Edit text above keyboard should be preserved",
      findElementByResourceId(filtered, "edit-text"),
    )
  }

  @Test
  fun `keyboard window occlusion marks elements behind keyboard as hidden`() {
    // Element fully behind the keyboard should be marked hidden
    val bottomElement =
      elementWithBounds(resourceId = "bottom-item", bounds = bounds(0, 1400, 1280, 2800))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 1280, 2856),
        children = listOf(bottomElement),
      )
    val keyboardRoot =
      elementWithBounds(resourceId = "keyboard", bounds = bounds(0, 1395, 1280, 2856))

    val appEntry =
      extractor.createWindowEntry(
        windowId = 46,
        windowLayer = 0,
        hierarchy = appRoot,
        details = WindowDetails(isActive = true, isFocused = true),
      )
    val imeEntry =
      extractor.createWindowEntry(
        windowId = 31,
        windowLayer = 1,
        hierarchy = keyboardRoot,
        details = WindowDetails(isActive = false, isFocused = false),
      )
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, imeEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 46,
        path = "",
        isRoot = true,
      )

    assertNotNull("App root should survive as isRoot=true", filtered)
    // The bottom element is fully behind the keyboard, so it should be removed
    assertNull(
      "Element fully behind keyboard should be removed",
      findElementByResourceId(filtered!!, "bottom-item"),
    )
  }

  private fun originalCalculateUnionArea(
    rectangles: List<ElementBounds>,
    maxArea: Int? = null,
  ): Int {
    data class Event(val x: Int, val y1: Int, val y2: Int, val delta: Int)

    val events =
      rectangles
        .flatMap { rect ->
          listOf(
            Event(rect.left, rect.top, rect.bottom, 1),
            Event(rect.right, rect.top, rect.bottom, -1),
          )
        }
        .sortedBy { it.x }

    if (events.isEmpty()) return 0

    val activeIntervals = mutableListOf<Pair<Int, Int>>()
    var previousX = events.first().x
    var area = 0

    fun activeUnionLength(): Int {
      if (activeIntervals.isEmpty()) return 0
      val sorted = activeIntervals.sortedBy { it.first }
      var total = 0
      var currentStart = sorted[0].first
      var currentEnd = sorted[0].second

      for (i in 1 until sorted.size) {
        val (start, end) = sorted[i]
        if (start > currentEnd) {
          total += currentEnd - currentStart
          currentStart = start
          currentEnd = end
        } else {
          currentEnd = maxOf(currentEnd, end)
        }
      }
      total += currentEnd - currentStart
      return total
    }

    for (event in events) {
      val dx = event.x - previousX
      if (dx > 0 && activeIntervals.isNotEmpty()) {
        val unionLength = activeUnionLength()
        area += unionLength * dx
        if (maxArea != null && area >= maxArea) {
          return area
        }
      }

      if (event.delta > 0) {
        activeIntervals.add(event.y1 to event.y2)
      } else {
        val index = activeIntervals.indexOfFirst { it.first == event.y1 && it.second == event.y2 }
        if (index >= 0) {
          activeIntervals.removeAt(index)
        }
      }

      previousX = event.x
    }

    return area
  }
}
