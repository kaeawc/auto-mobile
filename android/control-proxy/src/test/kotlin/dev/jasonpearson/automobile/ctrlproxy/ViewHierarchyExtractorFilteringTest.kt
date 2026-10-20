package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorFilteringTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `extractFromActiveWindow returns error when rootNode is null`() = runTest {
    val result = extractor.extractFromActiveWindow(null)
    assertNotNull(result)
    assertEquals("Root node is null", result!!.error)
  }

  @Test
  fun `extractFromActiveWindow retains zero-area parent with non-zero-area child`() {
    val child = fakeNode(packageName = "example.app", text = "Visible child")
    val parent =
      fakeNode(
        packageName = "example.app",
        state = NodeState(bounds = Rect(0, 0, 0, 0), children = listOf(child)),
      )

    val result =
      extractor.extractFromActiveWindow(
        parent,
        options = HierarchyExtractionOptions(disableAllFiltering = true),
      )

    assertNotNull(result!!.hierarchy)
    assertTrue(result.hierarchy!!.node.toString().contains("Visible child"))
    parent.recycle()
  }

  @Test
  fun `extractFromActiveWindow prunes zero-area subtree without visible descendants`() {
    val child = fakeNode(packageName = "example.app", state = NodeState(bounds = Rect(0, 0, 0, 0)))
    val parent =
      fakeNode(
        packageName = "example.app",
        state = NodeState(bounds = Rect(0, 0, 0, 0), children = listOf(child)),
      )

    val result =
      extractor.extractFromActiveWindow(
        parent,
        options = HierarchyExtractionOptions(disableAllFiltering = true),
      )

    assertNull(result!!.hierarchy)
    parent.recycle()
  }

  @Test
  fun `offscreen filtering requires valid dimensions and ignores visibility flag`() {
    for (dimensions in listOf(ScreenDimensions(100, 200), null, ScreenDimensions(0, 200))) {
      val offscreen =
        fakeNode(
          "example.app",
          text = "Offscreen row",
          state = NodeState(bounds = Rect(10, 201, 40, 240)),
        )
      val visible =
        fakeNode(
          "example.app",
          text = "Visible row",
          state = NodeState(bounds = Rect(10, 20, 40, 60), visibleToUser = false),
        )
      val root =
        fakeNode(
          "example.app",
          state = NodeState(bounds = Rect(0, 0, 100, 200), children = listOf(offscreen, visible)),
        )
      try {
        val result =
          extractor.extractFromActiveWindow(
            root,
            options =
              HierarchyExtractionOptions(
                screenDimensions = dimensions,
                disableAllFiltering = true,
              ),
          )
        val hierarchy = result!!.hierarchy!!.node.toString()
        assertTrue(hierarchy.contains("Visible row"))
        assertEquals(dimensions?.isValid() != true, hierarchy.contains("Offscreen row"))
      } finally {
        root.recycle()
      }
    }
  }

  @Test
  fun `filterViewHierarchy removes non-interactive elements without content`() = runTest {
    val emptyElement =
      UIElementInfo(
        text = null,
        contentDesc = null,
        resourceId = null,
        clickable = "false",
        focusable = "false",
        scrollable = "false",
      )

    val interactiveElement = UIElementInfo(text = "Button", clickable = "true")

    val elementWithContent = UIElementInfo(text = "Some text", clickable = "false")

    val children = listOf(emptyElement, interactiveElement, elementWithContent)

    val rootElement = UIElementInfo(className = "android.widget.LinearLayout", children = children)

    // Extract children from filtered hierarchy
    val filteredChildren = extractor.extractChildrenFromHierarchy(rootElement)
    assertEquals(2, filteredChildren.size)

    // Should keep interactive element and element with content
    assertTrue(filteredChildren.any { it.text == "Button" && it.isClickable })
    assertTrue(filteredChildren.any { it.text == "Some text" })
  }

  // MARK: - Occlusion Filtering Tests

  @Test
  fun `occlusion filtering is active by default with multiple windows`() {
    assertTrue(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = false,
        occlusionEnabled = true,
        windowCount = 2,
      ),
    )
  }

  @Test
  fun `occlusion filtering is skipped when occlusionEnabled is false (--no-occlusion)`() {
    assertFalse(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = false,
        occlusionEnabled = false,
        windowCount = 2,
      ),
    )
  }

  @Test
  fun `occlusion filtering is skipped when disableAllFiltering is true regardless of occlusionEnabled`() {
    assertFalse(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = true,
        occlusionEnabled = true,
        windowCount = 2,
      ),
    )
  }

  @Test
  fun `occlusion filtering is skipped with a single window regardless of occlusionEnabled`() {
    assertFalse(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = false,
        occlusionEnabled = true,
        windowCount = 1,
      ),
    )
  }

  @Test
  fun `same-window nodes never occlude each other even when fully overlapping`() {
    // Regression test for the channel-header disappearance bug.
    // Previously, an UNRELATED same-window node that fully covered another node would mark it
    // "hidden" and strip it. After optimizeHierarchy promotes children of bounds-only wrappers,
    // visual siblings (e.g., a Compose toolbar and a full-screen content area) can end up in
    // different tree branches, be classified UNRELATED, and falsely occlude each other.
    // Same-window occlusion is now skipped entirely; only cross-window occlusion applies.
    val target = elementWithBounds(resourceId = "header-target", bounds = bounds(0, 0, 100, 100))
    val targetParent = elementWithBounds(resourceId = "target-parent", children = listOf(target))
    val occluder = elementWithBounds(resourceId = "content-node", bounds = bounds(0, 0, 100, 100))
    val occluderParent =
      elementWithBounds(resourceId = "occluder-parent", children = listOf(occluder))
    val root = elementWithBounds(children = listOf(targetParent, occluderParent))

    val windowEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = root)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(windowEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = root,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    // Both nodes retained — same-window occlusion no longer strips the covered node.
    val targetResult = findElementByResourceId(filtered!!, "header-target")
    val occluderResult = findElementByResourceId(filtered, "content-node")
    assertNotNull(targetResult)
    assertNotNull(occluderResult)
    assertNull(targetResult!!.occlusionState)
    assertNull(targetResult.occludedBy)
  }

  @Test
  fun `same-window occlusion skip rescues an asymmetric-depth cousin that fix 3 cannot`() {
    // Faithful reproduction of the channel-header shape AND the justification for the full
    // same-window skip (Option B) over the narrower determineNodeRelationship patch (Option A).
    //
    // optimizeHierarchy promotes the header's bounds-only wrappers, so a header lands at a
    // shallow path ("0.0") while the content subtree stays deeply nested in a different branch
    // ("1.0.0.0"). Neither parent is empty and neither path prefixes the other, so the fix #3
    // nephew/root-level rules do NOT reclassify them — determineNodeRelationship still returns
    // UNRELATED (see the companion characterization test below). The ONLY thing that keeps the
    // fully-covered header is fix #1: skipping same-window occlusion entirely.
    //
    // Without the same-window skip this test fails: the content node (higher pre-order → occluder)
    // fully covers the header (lower pre-order → node), coverage 100% >= 0.95, so the header is
    // marked "hidden" and stripped. Intermediate wrappers carry no bounds so only the two leaf
    // nodes participate in occlusion.
    val headerTarget =
      elementWithBounds(resourceId = "header-target", bounds = bounds(0, 0, 100, 100))
    val headerParent =
      elementWithBounds(resourceId = "header-parent", children = listOf(headerTarget))

    val contentNode =
      elementWithBounds(resourceId = "content-node", bounds = bounds(0, 0, 100, 100))
    val contentInner =
      elementWithBounds(resourceId = "content-inner", children = listOf(contentNode))
    val contentMid = elementWithBounds(resourceId = "content-mid", children = listOf(contentInner))
    val contentBranch =
      elementWithBounds(resourceId = "content-branch", children = listOf(contentMid))

    // root children: header branch (index 0, path "0") then content branch (index 1, path "1").
    // → header-target path "0.0"; content-node path "1.0.0.0".
    val root = elementWithBounds(children = listOf(headerParent, contentBranch))

    val windowEntry = extractor.createWindowEntry(windowId = 1, windowLayer = 0, hierarchy = root)
    val occlusionInfo = extractor.buildOcclusionInfoForTest(listOf(windowEntry))
    val filtered =
      extractor.filterOccludedHierarchyForTest(
        element = root,
        occlusionInfo = occlusionInfo,
        windowKey = 1,
        path = "",
        isRoot = true,
      )

    assertNotNull(filtered)
    val targetResult = findElementByResourceId(filtered!!, "header-target")
    assertNotNull(targetResult)
    assertNull(targetResult!!.occlusionState)
    assertNull(targetResult.occludedBy)
    // Sanity: the occluder itself is always retained (highest order, no occluder above it).
    assertNotNull(findElementByResourceId(filtered, "content-node"))
  }

  @Test
  fun `determineNodeRelationship leaves mismatched-depth cousins UNRELATED - justifies full skip`() {
    // Characterization test documenting the LIMIT of the fix #3 nephew/root-level patch, which is
    // why Option B (skip same-window occlusion entirely) was chosen over Option A (patch this
    // function only). For the doc's cited example — a cousin pair at mismatched depths where
    // neither parent path is empty and neither prefixes the other — the patched function still
    // returns UNRELATED. If someone deleted fix #1 believing fix #3 alone were sufficient, cases
    // like this would regress to false occlusion. This test guards that reasoning.
    val nodePath = "2.1" // depth-2 branch
    val occluderPath = "3.0.0" // depth-3 branch, no prefix relationship to "2.1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 20,
      )

    // parents "2" and "3.0": not equal, no prefix either way, neither empty → UNRELATED.
    // fix #3 does NOT rescue this; only the full same-window skip does.
    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNRELATED, relationship)
  }

  @Test
  fun `systemui notification group retains text marked invisible by the framework`() {
    val group =
      fakeNode(
        packageName = "com.android.systemui",
        text = "Notifications",
        state =
          NodeState(
            children =
              listOf(
                fakeNode(
                  "com.android.systemui",
                  text = "Grouped notification",
                  state = NodeState(visibleToUser = false),
                ),
              ),
          ),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            1,
            group,
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM, focused = true),
          ),
        ),
        null,
      )

    assertTrue(
      json.encodeToString(ViewHierarchy.serializer(), result).contains("Grouped notification"),
    )
  }
}
