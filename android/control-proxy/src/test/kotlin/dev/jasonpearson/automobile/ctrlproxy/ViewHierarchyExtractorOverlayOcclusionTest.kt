package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorOverlayOcclusionTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `clipboard overlay clips every occluder to its window and keeps visible app content`() {
    // Real geometry from scratch/evidence9673/clipboard-chip-raw-observe.json and
    // scratch/evidence9673/occlusion-clipboard.logcat.txt. The covered app target reuses the
    // dismiss button's footprint to exercise content directly under the overlay.
    val discover = UIElementInfo(text = "Discover", bounds = bounds(43, 314, 319, 398))
    val bottomDiscover = UIElementInfo(text = "Discover", bounds = bounds(58, 2253, 197, 2295))
    val covered = elementWithBounds(resourceId = "covered", bounds = bounds(138, 1322, 264, 1448))
    val partial = elementWithBounds(resourceId = "partial", bounds = bounds(0, 136, 1080, 1517))
    val app =
      UIElementInfo(
        bounds = bounds(0, 0, 1080, 2400),
        children = listOf(discover, bottomDiscover, covered, partial),
      )
    val overlay = clipboardOverlayHierarchy()
    val entries =
      listOf(
        extractor.createWindowEntry(420, 0, app),
        extractor.createWindowEntry(
          423,
          3,
          overlay,
          windowType = "system",
          details = WindowDetails(windowBounds = bounds(0, 1291, 295, 1543)),
        ),
      )
    val info = extractor.buildOcclusionInfoForTest(entries)
    val filtered = extractor.filterOccludedHierarchyForTest(app, info, 420, "", true)!!

    assertEquals(
      listOf(discover.bounds, bottomDiscover.bounds),
      filtered.children.take(2).map { it.bounds },
    )
    assertTrue(filtered.children.take(2).all { it.occlusionState == null })
    assertNull(findElementByResourceId(filtered, "covered"))
    val partialResult = findElementByResourceId(filtered, "partial")!!
    assertEquals("partial", partialResult.occlusionState)
    assertEquals(partial.bounds, partialResult.bounds)
    assertEquals(
      "hidden",
      extractor.filterOccludedHierarchyForTest(covered, info, 420, "2", true)!!.occlusionState,
    )
    val filteredOverlay = extractor.filterOccludedHierarchyForTest(overlay, info, 423, "", true)!!
    assertEquals(overlay.bounds, filteredOverlay.bounds)
    assertEquals(overlay.children.single().bounds, filteredOverlay.children.single().bounds)
  }

  @Test
  fun `clipboard overlay window bounds are carried through framework extraction`() {
    // Window 423, its root, and Discover are from
    // scratch/evidence9673/clipboard-chip-raw-observe.json.
    val app =
      fakeNode(
        packageName = "example.app",
        text = "App",
        state =
          NodeState(
            bounds = Rect(0, 0, 1080, 2400),
            children =
              listOf(
                fakeNode(
                  "example.app",
                  text = "Discover",
                  state = NodeState(bounds = Rect(43, 314, 319, 398)),
                ),
              ),
          ),
      )
    val overlay =
      fakeNode(
        packageName = "com.android.systemui",
        text = "Clipboard",
        state = NodeState(bounds = Rect(0, 0, 1080, 2400)),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(420, 0, app, state = WindowState(focused = true)),
          fakeWindow(
            423,
            3,
            overlay,
            state =
              WindowState(
                type = AccessibilityWindowInfo.TYPE_SYSTEM,
                bounds = Rect(0, 1291, 295, 1543),
              ),
          ),
        ),
        null,
      )

    assertTrue(json.encodeToString(ViewHierarchy.serializer(), result).contains("Discover"))
    assertEquals(bounds(0, 1291, 295, 1543), result.windows!!.first { it.id == 423 }.bounds)
  }

  @Test
  fun `full screen overlay still hides app content`() {
    // Discover and the full-screen root are from
    // scratch/evidence9673/occlusion-clipboard.logcat.txt.
    val target = UIElementInfo(text = "Discover", bounds = bounds(43, 314, 319, 398))
    val app = UIElementInfo(bounds = bounds(0, 0, 1080, 2400), children = listOf(target))
    val info =
      extractor.buildOcclusionInfoForTest(
        listOf(
          extractor.createWindowEntry(420, 0, app),
          extractor.createWindowEntry(
            423,
            3,
            clipboardOverlayHierarchy(),
            details = WindowDetails(windowBounds = bounds(0, 0, 1080, 2400)),
          ),
        ),
      )
    val filtered = extractor.filterOccludedHierarchyForTest(app, info, 420, "", true)!!

    assertEquals("hidden", filtered.occlusionState)
    assertTrue(filtered.children.isEmpty())
  }

  @Test
  fun `unavailable overlay window bounds preserve unclipped occlusion`() {
    // Real node geometry from scratch/evidence9673/occlusion-clipboard.logcat.txt.
    val target = UIElementInfo(text = "Discover", bounds = bounds(43, 314, 319, 398))
    val app = UIElementInfo(bounds = bounds(0, 0, 1080, 2400), children = listOf(target))
    for (windowBounds in listOf(null, bounds(0, 0, 0, 0))) {
      val info =
        extractor.buildOcclusionInfoForTest(
          listOf(
            extractor.createWindowEntry(420, 0, app),
            extractor.createWindowEntry(
              423,
              3,
              clipboardOverlayHierarchy(),
              details = WindowDetails(windowBounds = windowBounds),
            ),
          ),
        )
      val filtered = extractor.filterOccludedHierarchyForTest(app, info, 420, "", true)!!

      assertEquals("hidden", filtered.occlusionState)
      assertTrue(filtered.children.isEmpty())
    }
  }

  @Test
  fun `occluder clipping rejects empty intersections and preserves unavailable bounds`() {
    // Overlay geometry from scratch/evidence9673/clipboard-chip-raw-observe.json.
    val window = bounds(0, 1291, 295, 1543)
    val fullScreen = bounds(0, 0, 1080, 2400)
    assertEquals(window, extractor.clipOccluderBounds(fullScreen, window))
    assertEquals(
      bounds(0, 1291, 295, 1517),
      extractor.clipOccluderBounds(bounds(0, 136, 1080, 1517), window),
    )
    assertNull(extractor.clipOccluderBounds(bounds(43, 314, 319, 398), window))
    assertNull(extractor.clipOccluderBounds(bounds(295, 1291, 319, 1543), window))
    assertEquals(fullScreen, extractor.clipOccluderBounds(fullScreen, null))
    assertEquals(fullScreen, extractor.clipOccluderBounds(fullScreen, bounds(0, 0, 0, 0)))
    assertEquals(fullScreen, extractor.clipOccluderBounds(fullScreen, fullScreen))
  }

  @Test
  fun `occluder entirely outside its window contributes no coverage`() {
    // Discover and window 423 geometry from scratch/evidence9673/clipboard-chip-raw-observe.json.
    val target = UIElementInfo(text = "Discover", bounds = bounds(43, 314, 319, 398))
    val app = UIElementInfo(bounds = bounds(0, 0, 1080, 2400), children = listOf(target))
    val info =
      extractor.buildOcclusionInfoForTest(
        listOf(
          extractor.createWindowEntry(420, 0, app),
          extractor.createWindowEntry(
            423,
            3,
            target,
            details = WindowDetails(windowBounds = bounds(0, 1291, 295, 1543)),
          ),
        ),
      )
    val filtered = extractor.filterOccludedHierarchyForTest(app, info, 420, "", true)!!

    assertEquals(target.bounds, filtered.children.single().bounds)
    assertNull(filtered.children.single().occlusionState)
  }

  @Test
  fun `clipped occlusion retains the 95 percent threshold`() {
    // Window bounds from scratch/evidence9673/clipboard-chip-raw-observe.json; synthetic targets
    // straddle its right edge with exactly 95% and 94% coverage.
    val atThreshold =
      elementWithBounds(resourceId = "95-percent", bounds = bounds(200, 1291, 300, 1543))
    val belowThreshold =
      elementWithBounds(resourceId = "94-percent", bounds = bounds(201, 1291, 301, 1543))
    val app =
      UIElementInfo(
        bounds = bounds(0, 0, 1080, 2400),
        children = listOf(atThreshold, belowThreshold),
      )
    val info =
      extractor.buildOcclusionInfoForTest(
        listOf(
          extractor.createWindowEntry(420, 0, app),
          extractor.createWindowEntry(
            423,
            3,
            clipboardOverlayHierarchy(),
            details = WindowDetails(windowBounds = bounds(0, 1291, 295, 1543)),
          ),
        ),
      )
    val filtered = extractor.filterOccludedHierarchyForTest(app, info, 420, "", true)!!

    assertNull(findElementByResourceId(filtered, "95-percent"))
    assertEquals("partial", findElementByResourceId(filtered, "94-percent")!!.occlusionState)
  }

  private fun clipboardOverlayHierarchy(): UIElementInfo =
    // Root and labelled clipboard_ui bounds from
    // scratch/evidence9673/clipboard-chip-raw-observe.json.
    UIElementInfo(
      bounds = bounds(0, 0, 1080, 2400),
      children =
        listOf(
          UIElementInfo(
            contentDesc = "Clipboard",
            resourceId = "com.android.systemui:id/clipboard_ui",
            bounds = bounds(0, 136, 1080, 1517),
          ),
        ),
    )

  @Test
  fun `cross-window occlusion keeps partial overlap and annotates metadata`() {
    val target = elementWithBounds(resourceId = "partial-target", bounds = bounds(0, 0, 100, 100))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 200, 200),
        children = listOf(target),
      )
    val occluder =
      elementWithBounds(
        resourceId = "partial-occluder",
        viewId = "stable-partial-occluder",
        bounds = bounds(0, 0, 50, 50),
      )

    val appEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = appRoot)
    val overlayEntry =
      extractor.createWindowEntry(windowId = 2, windowLayer = 1, hierarchy = occluder)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, overlayEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    val targetResult = findElementByResourceId(filtered!!, "partial-target")
    assertNotNull(targetResult)
    assertEquals("partial", targetResult!!.occlusionState)
    assertEquals("partial-occluder", targetResult.occludedBy)
    assertEquals("stable-partial-occluder", targetResult.occludedByViewId)
  }

  @Test
  fun `multi-window output matches the quadratic algorithm golden fixture`() {
    // The original layer/order pair scan marks both app nodes half covered by SystemUI and
    // ignores the transparent IME wrapper. Preserve every field of that filtered tree.
    val target = elementWithBounds(resourceId = "target", bounds = bounds(0, 0, 100, 100))
    val app =
      elementWithBounds(
        resourceId = "app",
        bounds = bounds(0, 0, 100, 100),
        children = listOf(target),
      )
    val systemUi =
      elementWithBounds(
        resourceId = "system-ui",
        viewId = "system-ui-id",
        bounds = bounds(0, 0, 50, 100),
      )
    val ime = elementWithBounds(resourceId = "ime", bounds = bounds(0, 50, 100, 100))
    val entries =
      listOf(
        extractor.createWindowEntry(1, 0, app),
        extractor.createWindowEntry(2, 1, systemUi, windowType = "system"),
        extractor.createWindowEntry(3, 2, ime, windowType = "input_method"),
      )

    val info = extractor.buildOcclusionInfoForTest(entries)
    val actual = extractor.filterOccludedHierarchyForTest(app, info, 1, "", true)
    val expected =
      app.copy(
        occlusionState = "partial",
        occludedBy = "system-ui",
        occludedByViewId = "system-ui-id",
        children =
          listOf(
            target.copy(
              occlusionState = "partial",
              occludedBy = "system-ui",
              occludedByViewId = "system-ui-id",
            ),
          ),
      )
    assertEquals(expected, actual)
    assertEquals(
      mapOf(
        "NodeKey(windowKey=1, path=)" to
          "OcclusionInfo(coverage=0.5, occludedBy=system-ui, occludedByViewId=system-ui-id)",
        "NodeKey(windowKey=1, path=0)" to
          "OcclusionInfo(coverage=0.5, occludedBy=system-ui, occludedByViewId=system-ui-id)",
      ),
      info.mapKeys { it.key.toString() }.mapValues { it.value.toString() },
    )
  }

  @Test
  fun `cross-window occlusion annotates unlabeled occluder with view id`() {
    val target = elementWithBounds(resourceId = "partial-target", bounds = bounds(0, 0, 100, 100))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 200, 200),
        children = listOf(target),
      )
    val occluder =
      elementWithBounds(viewId = "stable-unlabeled-occluder", bounds = bounds(0, 0, 50, 50))

    val appEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = appRoot)
    val overlayEntry =
      extractor.createWindowEntry(windowId = 2, windowLayer = 1, hierarchy = occluder)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, overlayEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    val targetResult = findElementByResourceId(filtered!!, "partial-target")
    assertNotNull(targetResult)
    assertEquals("partial", targetResult!!.occlusionState)
    assertEquals("unlabeled view", targetResult.occludedBy)
    assertEquals("stable-unlabeled-occluder", targetResult.occludedByViewId)
  }

  @Test
  fun `cross-window occlusion links labelled wrapper to matching descendant view id`() {
    val target = elementWithBounds(resourceId = "partial-target", bounds = bounds(0, 0, 100, 100))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 200, 200),
        children = listOf(target),
      )
    val labelledChild =
      elementWithBounds(
        viewId = "stable-demos",
        bounds = bounds(0, 0, 50, 50),
        content = ElementContent(text = "Demos"),
      )
    val labelledWrapper =
      elementWithBounds(
        bounds = bounds(0, 0, 50, 50),
        children = listOf(labelledChild),
        content = ElementContent(contentDesc = "Demos"),
      )

    val appEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = appRoot)
    val overlayEntry =
      extractor.createWindowEntry(windowId = 2, windowLayer = 1, hierarchy = labelledWrapper)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, overlayEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    val targetResult = findElementByResourceId(filtered!!, "partial-target")
    assertNotNull(targetResult)
    assertEquals("partial", targetResult!!.occlusionState)
    assertEquals("Demos", targetResult.occludedBy)
    val overlayResult =
      extractor.filterOccludedHierarchyForTest(
        element = labelledWrapper,
        occlusionInfo = occlusionInfo,
        windowKey = 2,
        path = "",
        isRoot = true,
      )
    assertNotNull(overlayResult)
    assertEquals(overlayResult!!.viewId, targetResult.occludedByViewId)
    assertNotNull(targetResult.occludedByViewId)
  }

  @Test
  fun `cross-window occlusion links id-less container to its emitted fallback view id`() {
    val target = elementWithBounds(resourceId = "partial-target", bounds = bounds(0, 0, 100, 100))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 200, 200),
        children = listOf(target),
      )
    val statusBarRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 100, 50),
        content = ElementContent(className = "android.view.ViewGroup"),
      )

    val appEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = appRoot)
    val overlayEntry =
      extractor.createWindowEntry(windowId = 2, windowLayer = 1, hierarchy = statusBarRoot)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, overlayEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    val targetResult = findElementByResourceId(filtered!!, "partial-target")
    assertNotNull(targetResult)
    assertEquals("partial", targetResult!!.occlusionState)
    assertEquals("android.view.ViewGroup", targetResult.occludedBy)
    val overlayResult =
      extractor.filterOccludedHierarchyForTest(
        element = statusBarRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 2,
        path = "",
        isRoot = true,
      )
    assertNotNull(overlayResult)
    assertEquals(overlayResult!!.viewId, targetResult.occludedByViewId)
    assertNotNull(targetResult.occludedByViewId)
  }

  @Test
  fun `cross-window occlusion prefers direct wrapper view id over generated fallback`() {
    val target = elementWithBounds(resourceId = "partial-target", bounds = bounds(0, 0, 100, 100))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 200, 200),
        children = listOf(target),
      )
    val labelledWrapper =
      elementWithBounds(
        viewId = "stable-demos-wrapper",
        bounds = bounds(0, 0, 50, 50),
        content = ElementContent(contentDesc = "Demos"),
      )

    val appEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = appRoot)
    val overlayEntry =
      extractor.createWindowEntry(windowId = 2, windowLayer = 1, hierarchy = labelledWrapper)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(appEntry, overlayEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = appRoot,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    val targetResult = findElementByResourceId(filtered!!, "partial-target")
    assertNotNull(targetResult)
    assertEquals("partial", targetResult!!.occlusionState)
    assertEquals("Demos", targetResult.occludedBy)
    assertEquals("stable-demos-wrapper", targetResult.occludedByViewId)
  }

  @Test
  fun `hidden root occlusion retains children`() {
    val child = elementWithBounds(resourceId = "root-child", bounds = bounds(98, 98, 100, 100))
    val root =
      elementWithBounds(
        resourceId = "root-window",
        bounds = bounds(0, 0, 100, 100),
        children = listOf(child),
      )
    val occluderRoot =
      elementWithBounds(resourceId = "occluding-root", bounds = bounds(0, 0, 98, 98))

    val windowEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = root)
    val occluderEntry =
      extractor.createWindowEntry(windowId = 2, windowLayer = 1, hierarchy = occluderRoot)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(windowEntry, occluderEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = root,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    assertEquals("hidden", filtered!!.occlusionState)
    assertEquals("occluding-root", filtered.occludedBy)
    assertEquals("occluding-root", filtered.occludedByViewId)
    assertNotNull(findElementByResourceId(filtered, "root-child"))
  }
}
