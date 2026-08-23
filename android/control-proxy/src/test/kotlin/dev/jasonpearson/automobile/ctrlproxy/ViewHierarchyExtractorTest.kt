package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.text.SpannableString
import android.text.style.ClickableSpan
import android.view.View
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.SemanticLink
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ViewHierarchyExtractorTest {

  private lateinit var extractor: ViewHierarchyExtractor
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `snapshot options reject unsafe bounds`() {
    assertThrows(IllegalArgumentException::class.java) {
      HierarchySnapshotOptions(maxDepth = -1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      HierarchySnapshotOptions(maxNodes = 0)
    }
  }

  @Test
  fun `snapshot budget reports cancellation and limits`() {
    val cancelled = HierarchySnapshotBudget(HierarchySnapshotOptions(isCancelled = { true }))
    assertFalse(cancelled.enter(0))
    assertEquals(listOf("cancelled"), cancelled.truncationReasons())

    val depthLimited = HierarchySnapshotBudget(HierarchySnapshotOptions(maxDepth = 0))
    assertTrue(depthLimited.enter(0))
    assertFalse(depthLimited.enter(1))
    assertEquals(listOf("max_depth"), depthLimited.truncationReasons())

    val nodeLimited = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 1))
    assertTrue(nodeLimited.enter(0))
    assertFalse(nodeLimited.enter(0))
    assertEquals(listOf("max_nodes"), nodeLimited.truncationReasons())
  }

  @Before
  fun setUp() {
    extractor = ViewHierarchyExtractor()
  }

  @Test
  fun `extractFromActiveWindow returns error when rootNode is null`() = runTest {
    val result = extractor.extractFromActiveWindow(null)
    assertNotNull(result)
    assertEquals("Root node is null", result!!.error)
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

  @Test
  fun `ElementBounds calculates width and height correctly`() {
    val bounds = ElementBounds(10, 20, 100, 80)

    assertEquals(90, bounds.width)
    assertEquals(60, bounds.height)
    assertEquals(55, bounds.centerX)
    assertEquals(50, bounds.centerY)
  }

  @Test
  fun `ElementBounds constructor from Rect works correctly`() {
    val rect = Rect(5, 10, 50, 60)
    val bounds = ElementBounds(rect)

    assertEquals(5, bounds.left)
    assertEquals(10, bounds.top)
    assertEquals(50, bounds.right)
    assertEquals(60, bounds.bottom)
  }

  @Test
  fun `ElementBounds fromString parses bounds correctly`() {
    val boundsString = "[10,20][100,80]"
    val bounds = ElementBounds.fromString(boundsString)

    assertNotNull(bounds)
    assertEquals(10, bounds!!.left)
    assertEquals(20, bounds.top)
    assertEquals(100, bounds.right)
    assertEquals(80, bounds.bottom)
  }

  @Test
  fun `ElementBounds fromString returns null for invalid format`() {
    val invalidBounds = "invalid-format"
    val bounds = ElementBounds.fromString(invalidBounds)
    assertNull(bounds)
  }

  @Test
  fun `ElementBounds toString produces object format`() {
    val bounds = ElementBounds(10, 20, 100, 80)
    val result = bounds.toString()
    assertEquals("""{"left":10,"top":20,"right":100,"bottom":80}""", result)
  }

  @Test
  fun `UIElementInfo boolean helpers work correctly`() {
    val element =
      UIElementInfo(
        clickable = "true",
        enabled = "false",
        focusable = "true",
        focused = "false",
        scrollable = "true",
      )

    assertTrue(element.isClickable)
    assertFalse(element.isEnabled)
    assertTrue(element.isFocusable)
    assertFalse(element.isFocused)
    assertTrue(element.isScrollable)
  }

  @Test
  fun `UIElementInfo enabled defaults to true when not specified`() {
    val element =
      UIElementInfo(
        clickable = "false",
        enabled = null, // Not specified
      )

    assertFalse(element.isClickable)
    assertTrue(element.isEnabled) // Should default to true
  }

  @Test
  fun `semantic links preserve visible text ranges and per-text occurrences`() {
    val text = SpannableString("Read Terms, Privacy, and terms")
    val firstTerms =
      object : ClickableSpan() {
        override fun onClick(widget: View) = Unit
      }
    val privacy =
      object : ClickableSpan() {
        override fun onClick(widget: View) = Unit
      }
    val secondTerms =
      object : ClickableSpan() {
        override fun onClick(widget: View) = Unit
      }
    text.setSpan(firstTerms, 5, 10, 0)
    text.setSpan(privacy, 12, 19, 0)
    text.setSpan(secondTerms, 25, 30, 0)

    assertEquals(
      listOf(
        SemanticLink("Terms", 0, 5, 10),
        SemanticLink("Privacy", 0, 12, 19),
        SemanticLink("terms", 1, 25, 30),
      ),
      extractor.semanticLinksFromText(text, apiLevel = 26),
    )
  }

  @Test
  fun `semantic link occurrences use the same Unicode case matching as activation`() {
    val text = SpannableString("İ i")
    text.setSpan(
      object : ClickableSpan() {
        override fun onClick(widget: View) = Unit
      },
      0,
      1,
      0,
    )
    text.setSpan(
      object : ClickableSpan() {
        override fun onClick(widget: View) = Unit
      },
      2,
      3,
      0,
    )

    assertEquals(
      listOf(
        SemanticLink("İ", 0, 0, 1),
        SemanticLink("i", 1, 2, 3),
      ),
      extractor.semanticLinksFromText(text, apiLevel = 26),
    )
  }

  @Test
  fun `semantic links stay absent below API 26 and for plain text`() {
    val spanned = SpannableString("Terms")
    spanned.setSpan(
      object : ClickableSpan() {
        override fun onClick(widget: View) = Unit
      },
      0,
      5,
      0,
    )

    assertNull(extractor.semanticLinksFromText(spanned, apiLevel = 25))
    assertNull(extractor.semanticLinksFromText("Terms", apiLevel = 35))
  }

  @Test
  fun `semantic link metadata stays omitted unless an element contains links`() {
    val verboseJson = Json { encodeDefaults = true }

    assertFalse(
      verboseJson
        .encodeToString(UIElementInfo.serializer(), UIElementInfo(text = "Plain text"))
        .contains("semantic-links")
    )
    assertTrue(
      verboseJson
        .encodeToString(
          UIElementInfo.serializer(),
          UIElementInfo(semanticLinks = listOf(SemanticLink("Terms", 0, 0, 5))),
        )
        .contains("semantic-links")
    )
  }

  @Test
  fun `detectIntentChooserIndicators returns true for text indicator`() {
    val child = UIElementInfo(text = "Choose an app")
    val root = UIElementInfo(className = "android.widget.LinearLayout", children = listOf(child))

    assertTrue(extractor.detectIntentChooserIndicatorsForTest(root))
  }

  @Test
  fun `detectIntentChooserIndicators returns true for resource id indicator`() {
    val child =
      UIElementInfo(resourceId = "android:id/button_once", className = "android.widget.Button")
    val root = UIElementInfo(className = "android.widget.LinearLayout", children = listOf(child))

    assertTrue(extractor.detectIntentChooserIndicatorsForTest(root))
  }

  @Test
  fun `detectIntentChooserIndicators returns false when no indicators present`() {
    val child = UIElementInfo(text = "Normal content", className = "android.widget.TextView")
    val root = UIElementInfo(className = "android.widget.LinearLayout", children = listOf(child))

    assertFalse(extractor.detectIntentChooserIndicatorsForTest(root))
  }

  @Test
  fun `detectNotificationPermissionDialog returns true when notification dialog markers present`() {
    val title = UIElementInfo(text = "Allow Example to send notifications?")
    val allowButton =
      UIElementInfo(resourceId = "com.android.permissioncontroller:id/permission_allow_button")
    val root =
      UIElementInfo(
        className = "android.widget.LinearLayout",
        children = listOf(title, allowButton),
      )

    assertTrue(
      extractor.detectNotificationPermissionDialogForTest(
        root,
        "com.android.permissioncontroller",
      )
    )
  }

  @Test
  fun `detectNotificationPermissionDialog returns false for non-permission controller package`() {
    val title = UIElementInfo(text = "Allow Example to send notifications?")
    val allowButton =
      UIElementInfo(resourceId = "com.android.permissioncontroller:id/permission_allow_button")
    val root =
      UIElementInfo(
        className = "android.widget.LinearLayout",
        children = listOf(title, allowButton),
      )

    assertFalse(
      extractor.detectNotificationPermissionDialogForTest(
        root,
        "com.example.app",
      )
    )
  }

  @Test
  fun `meetsFilterCriteria excludes UIElementInfo with no values`() = runTest {
    val plainElement = UIElementInfo()

    val children = listOf(plainElement)

    val rootElement = UIElementInfo(children = children)
    val filteredChildren = extractor.extractChildrenFromHierarchy(rootElement)

    // Should keep all elements with semantic properties but not the plain element
    assertEquals(0, filteredChildren.size)
  }

  @Test
  fun `meetsFilterCriteria includes elements with semantic properties`() = runTest {
    val elementWithTestTag =
      UIElementInfo(text = "", testTag = "submit-button", clickable = "false")
    val elementWithRole = UIElementInfo(text = "", role = "button", clickable = "false")
    val elementWithState =
      UIElementInfo(text = "", stateDescription = "Expanded", clickable = "false")
    val elementWithHint = UIElementInfo(text = "", hintText = "Enter name", clickable = "false")
    val elementWithError = UIElementInfo(text = "", errorMessage = "Required", clickable = "false")
    val elementWithActions =
      UIElementInfo(text = "", actions = listOf("click", "focus"), clickable = "false")
    val elementWithRange =
      UIElementInfo(text = "", rangeInfo = "current:50,min:0,max:100", clickable = "false")

    val children =
      listOf(
        elementWithTestTag,
        elementWithRole,
        elementWithState,
        elementWithHint,
        elementWithError,
        elementWithActions,
        elementWithRange,
      )

    val rootElement = UIElementInfo(children = children)
    val filteredChildren = extractor.extractChildrenFromHierarchy(rootElement)

    // Should keep all elements with semantic properties but not the plain element
    assertEquals(7, filteredChildren.size)
    assertTrue(filteredChildren.any { it.testTag == "submit-button" })
    assertTrue(filteredChildren.any { it.role == "button" })
    assertTrue(filteredChildren.any { it.stateDescription == "Expanded" })
    assertTrue(filteredChildren.any { it.hintText == "Enter name" })
    assertTrue(filteredChildren.any { it.errorMessage == "Required" })
    assertTrue(filteredChildren.any { it.actions?.contains("click") == true })
    assertTrue(filteredChildren.any { it.rangeInfo == "current:50,min:0,max:100" })

    // Plain element should be filtered out
    assertFalse(
      filteredChildren.any {
        it.text == "" &&
          it.testTag == null &&
          it.role == null &&
          it.stateDescription == null &&
          it.hintText == null &&
          it.errorMessage == null &&
          it.actions == null &&
          it.rangeInfo == null
      }
    )
  }

  @Test
  fun `UIElementInfo semantic properties are properly handled`() {
    val element =
      UIElementInfo(
        text = "Button",
        testTag = "submit-button",
        role = "button",
        stateDescription = "Enabled",
        errorMessage = null,
        hintText = "Click to submit",
        tooltipText = "Submit form",
        paneTitle = "Main Form",
        liveRegion = "polite",
        collectionInfo = "rows:5,cols:3",
        collectionItemInfo = "row:1,col:2",
        rangeInfo = "current:50,min:0,max:100",
        inputType = "text",
        actions = listOf("click", "focus"),
        extras = mapOf("custom-property" to "custom-value"),
      )

    assertEquals("submit-button", element.testTag)
    assertEquals("button", element.role)
    assertEquals("Enabled", element.stateDescription)
    assertNull(element.errorMessage)
    assertEquals("Click to submit", element.hintText)
    assertEquals("Submit form", element.tooltipText)
    assertEquals("Main Form", element.paneTitle)
    assertEquals("polite", element.liveRegion)
    assertEquals("rows:5,cols:3", element.collectionInfo)
    assertEquals("row:1,col:2", element.collectionItemInfo)
    assertEquals("current:50,min:0,max:100", element.rangeInfo)
    assertEquals("text", element.inputType)
    assertEquals(listOf("click", "focus"), element.actions)
    assertEquals(mapOf("custom-property" to "custom-value"), element.extras)
  }

  // MARK: - Compose toggle state description (issue #3139)

  private val stateDescriptionExtraKey =
    "androidx.view.accessibility.AccessibilityNodeInfoCompat.STATE_DESCRIPTION_KEY"

  @Test
  fun `stateDescriptionFromExtras reads androidx compat key`() {
    assertEquals(
      "On",
      extractor.stateDescriptionFromExtras(mapOf(stateDescriptionExtraKey to "On")),
    )
    assertEquals(
      "Checked",
      extractor.stateDescriptionFromExtras(
        mapOf("other" to "x", stateDescriptionExtraKey to "Checked")
      ),
    )
  }

  @Test
  fun `stateDescriptionFromExtras returns null when key absent, blank, or extras null`() {
    assertNull(extractor.stateDescriptionFromExtras(null))
    assertNull(extractor.stateDescriptionFromExtras(emptyMap()))
    assertNull(extractor.stateDescriptionFromExtras(mapOf("unrelated" to "value")))
    assertNull(extractor.stateDescriptionFromExtras(mapOf(stateDescriptionExtraKey to "   ")))
  }

  @Test
  fun `testTagFromExtras supports the documented legacy View key`() {
    assertEquals(
      "message_row_42",
      extractor.testTagFromExtras(mapOf("test-tag" to "message_row_42")),
    )
    assertEquals(
      "compose_row_7",
      extractor.testTagFromExtras(
        mapOf("androidx.compose.ui.semantics.testTag" to "compose_row_7")
      ),
    )
  }

  @Test
  fun `api gated audit fields only appear on supported Android versions`() {
    assertEquals(
      ViewHierarchyExtractor.ApiGatedNodeFields(uniqueId = null, containerTitle = null),
      extractor.apiGatedNodeFields(32, uniqueId = "node-1", containerTitle = "Inbox"),
    )
    assertEquals(
      ViewHierarchyExtractor.ApiGatedNodeFields(uniqueId = "node-1", containerTitle = null),
      extractor.apiGatedNodeFields(33, uniqueId = "node-1", containerTitle = "Inbox"),
    )
    assertEquals(
      ViewHierarchyExtractor.ApiGatedNodeFields(uniqueId = "node-1", containerTitle = "Inbox"),
      extractor.apiGatedNodeFields(34, uniqueId = "node-1", containerTitle = "Inbox"),
    )
  }

  @Test
  fun `visibility audit field does not filter otherwise retained nodes`() = runTest {
    val element = UIElementInfo(text = "Compose row", visibleToUser = false)
    val root = UIElementInfo(children = listOf(element))

    val retained = extractor.extractChildrenFromHierarchy(root)

    assertEquals(1, retained.size)
    assertEquals(false, retained.single().visibleToUser)
  }

  @Test
  fun `semantic fields are serialized to JSON correctly`() {
    val element =
      UIElementInfo(
        text = "Button",
        testTag = "submit-button",
        uniqueId = "android-node-7",
        visibleToUser = false,
        containerTitle = "Messages",
        collectionRowIndex = 4,
        collectionColumnIndex = 0,
        role = "button",
        stateDescription = "Enabled",
        actions = listOf("click"),
        extras = mapOf("custom" to "value"),
      )

    val json = Json { prettyPrint = true }
    val jsonString = json.encodeToString(UIElementInfo.serializer(), element)

    // Verify semantic fields appear in JSON with correct serialization names
    assertTrue("JSON should contain test-tag field", jsonString.contains("test-tag"))
    assertTrue("JSON should contain unique-id field", jsonString.contains("unique-id"))
    assertTrue("JSON should contain visible-to-user field", jsonString.contains("visible-to-user"))
    assertTrue("JSON should contain container-title field", jsonString.contains("container-title"))
    assertTrue(
      "JSON should contain collection row and column fields",
      jsonString.contains("collection-row-index") && jsonString.contains("collection-column-index"),
    )
    assertTrue("JSON should contain role field", jsonString.contains("\"role\""))
    assertTrue(
      "JSON should contain state-description field",
      jsonString.contains("state-description"),
    )
    assertTrue("JSON should contain actions field", jsonString.contains("\"actions\""))
    assertTrue("JSON should contain extras field", jsonString.contains("\"extras\""))
  }

  // MARK: - Occlusion Filtering Tests

  @Test
  fun `occlusion filtering is active by default with multiple windows`() {
    assertTrue(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = false,
        occlusionEnabled = true,
        windowCount = 2,
      )
    )
  }

  @Test
  fun `occlusion filtering is skipped when occlusionEnabled is false (--no-occlusion)`() {
    assertFalse(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = false,
        occlusionEnabled = false,
        windowCount = 2,
      )
    )
  }

  @Test
  fun `occlusion filtering is skipped when disableAllFiltering is true regardless of occlusionEnabled`() {
    assertFalse(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = true,
        occlusionEnabled = true,
        windowCount = 2,
      )
    )
  }

  @Test
  fun `occlusion filtering is skipped with a single window regardless of occlusionEnabled`() {
    assertFalse(
      extractor.isOcclusionFilteringActive(
        disableAllFiltering = false,
        occlusionEnabled = true,
        windowCount = 1,
      )
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
  fun `cross-window occlusion annotates unlabeled occluder with view id`() {
    val target = elementWithBounds(resourceId = "partial-target", bounds = bounds(0, 0, 100, 100))
    val appRoot =
      elementWithBounds(
        resourceId = "app-root",
        bounds = bounds(0, 0, 200, 200),
        children = listOf(target),
      )
    val occluder =
      elementWithBounds(
        viewId = "stable-unlabeled-occluder",
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
      elementWithBounds(text = "Demos", viewId = "stable-demos", bounds = bounds(0, 0, 50, 50))
    val labelledWrapper =
      elementWithBounds(
        contentDesc = "Demos",
        bounds = bounds(0, 0, 50, 50),
        children = listOf(labelledChild),
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
      elementWithBounds(className = "android.view.ViewGroup", bounds = bounds(0, 0, 100, 50))

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
        contentDesc = "Demos",
        viewId = "stable-demos-wrapper",
        bounds = bounds(0, 0, 50, 50),
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

  @Test
  fun `pickPrimaryAppWindowId returns null when no IME is up`() {
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId returns topmost app window when IME is up`() {
    // Reproduces the Gboard-over-Slack scenario observed on a Pixel 10 Pro:
    // the IME has isActive=true (owns input focus) and the app window has isActive=false,
    // so the extractor must not rely on isActive to find the user-facing app.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 42,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 99,
          type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          layer = 10,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 7,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 20,
          hasRoot = true,
        ),
      )
    assertEquals(42, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId ignores IME with null root`() {
    // An IME window present in the windows list but without a root cannot contribute
    // occlusion and should not trigger the primary-window remap.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 42,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 99,
          type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          layer = 10,
          hasRoot = false,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId picks highest-layer app window among multiple`() {
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 1,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 2,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 3,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 99,
          type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          layer = 10,
          hasRoot = true,
        ),
      )
    assertEquals(2, extractor.pickPrimaryAppWindowId(windows))
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
      elementWithBounds(
        resourceId = "ime-wrapper",
        bounds = bounds(0, 172, 1080, 2410),
      )

    val appEntry =
      extractor.createWindowEntry(
        windowId = 116,
        windowLayer = 0,
        hierarchy = appRoot,
        windowType = "application",
        isActive = true,
        isFocused = true,
      )
    val imeEntry =
      extractor.createWindowEntry(
        windowId = 108,
        windowLayer = 5,
        hierarchy = imeWrapper,
        windowType = "input_method",
        isActive = false,
        isFocused = false,
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
        isActive = true,
        isFocused = true,
      )
    val imeEntry =
      extractor.createWindowEntry(
        windowId = 31,
        windowLayer = 1,
        hierarchy = keyboardRoot,
        windowType = "input_method",
        isActive = false,
        isFocused = false,
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
        isActive = true,
        isFocused = true,
      )
    val imeEntry =
      extractor.createWindowEntry(
        windowId = 31,
        windowLayer = 1,
        hierarchy = keyboardRoot,
        isActive = false,
        isFocused = false,
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

  // MARK: - Node Relationship Tests

  @Test
  fun `determineNodeRelationship detects direct siblings`() {
    // Two nodes with same parent "0.0.0" - they are siblings
    val nodePath = "0.0.0.0"
    val occluderPath = "0.0.0.1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 5,
        nodeSubtreeEnd = 5,
        occluderOrder = 6,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship detects uncles - sibling of parent`() {
    // Node at "0.0.0.1.0" (child of "0.0.0.1")
    // Occluder at "0.0.0.2" (sibling of "0.0.0.1", which is the node's parent)
    // This is the NavigationBar case - occluder is uncle of node
    val nodePath = "0.0.0.1.0"
    val occluderPath = "0.0.0.2"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 11,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  @Test
  fun `determineNodeRelationship detects uncles - sibling of grandparent`() {
    // Node deeply nested at "0.0.0.1.0.0"
    // Occluder at "0.0.0.2" (sibling of grandparent)
    val nodePath = "0.0.0.1.0.0"
    val occluderPath = "0.0.0.2"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 15,
        nodeSubtreeEnd = 15,
        occluderOrder = 16,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  @Test
  fun `determineNodeRelationship detects descendants using traversal order`() {
    // Occluder is a child of the node (traversal order within subtree)
    val nodePath = "0.0.0.1"
    val occluderPath = "0.0.0.1.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 15, // Subtree ends at 15
        occluderOrder = 11, // Child is at 11, within [10, 15]
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.DESCENDANT, relationship)
  }

  @Test
  fun `determineNodeRelationship detects descendants with multiple children`() {
    // Node has multiple descendants
    val nodePath = "0.0.0.1"
    val occluderPath = "0.0.0.1.2.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 20,
        occluderOrder = 18, // Deep descendant within subtree
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.DESCENDANT, relationship)
  }

  @Test
  fun `determineNodeRelationship detects unrelated nodes - different branches`() {
    // Nodes in completely different branches
    val nodePath = "0.0.0.1.0"
    val occluderPath = "0.0.1.0.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 12,
        occluderOrder = 20,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNRELATED, relationship)
  }

  @Test
  fun `determineNodeRelationship detects unrelated nodes - cousin relationship`() {
    // Cousins: share grandparent but different parents
    val nodePath = "0.0.0.1.0"
    val occluderPath = "0.0.0.2.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 15,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNRELATED, relationship)
  }

  @Test
  fun `determineNodeRelationship handles root node edge case`() {
    // Root-level siblings (empty parent path)
    val nodePath = "0"
    val occluderPath = "1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 0,
        nodeSubtreeEnd = 100,
        occluderOrder = 101,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship TabRow structure - text and role description as siblings`() {
    // Real TabRow case: Text "Tap" and role description are siblings
    val textPath = "0.0.0.0.0.0.1.0.0.0.0"
    val roleDescPath = "0.0.0.0.0.0.1.0.0.0.1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = textPath,
        occluderPath = roleDescPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 11,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship NavigationBar structure - text nested with uncle`() {
    // Real NavigationBar case: Text is nested, occluder is uncle
    // Text: "0.0.0.0.0.0.1.0.0.1.0" (in wrapper "0.0.0.0.0.0.1.0.0.1")
    // Occluder: "0.0.0.0.0.0.1.0.0.2" (sibling of wrapper's parent)
    val textPath = "0.0.0.0.0.0.1.0.0.1.0"
    val occluderPath = "0.0.0.0.0.0.1.0.0.2"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = textPath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 11,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  @Test
  fun `determineNodeRelationship root-level promoted header is related to deep content occluder`() {
    // The real channel-header scenario, with paths in the correct traversal direction.
    // In the Slack Box, ChannelHeader is child 0 (traversed first) and the content fragment is
    // child 1 (traversed later). optimizeHierarchy promotes the header's bounds-only wrappers, so
    // the header lands at a shallow root-level path "0" (empty parent, low pre-order), while the
    // content subtree stays deeply nested at e.g. "1.0.0.3" (higher pre-order). Because the content
    // has the higher order, it is the *occluder* and the header is the *node* — the header's empty
    // parent path makes them share the implicit root, so they are SIBLING (never UNRELATED).
    val nodePath = "0" // promoted header, root-level, traversed first (low order)
    val occluderPath = "1.0.0.3" // deep content child, traversed later (high order)

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 1,
        nodeSubtreeEnd = 1,
        occluderOrder = 9,
      )

    // Node's parent "" is empty → shares the implicit root with the occluder → SIBLING
    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship root-level node is related to deep nested node`() {
    // Root-level promoted node should not be UNRELATED to nodes in sibling branches.
    // This prevents false occlusion after optimizeHierarchy flattens the tree.
    val nodePath = "2"
    val occluderPath = "0.1.0.2.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 80,
        nodeSubtreeEnd = 80,
        occluderOrder = 30,
      )

    // Node's parent "" is empty → SIBLING (shares implicit root)
    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship detects nephew at intermediate depth`() {
    // Non-root nephew case: node at "0.1" is uncle of occluder at "0.1.2.3.4"
    // because node's parent "0" is a prefix of occluder's path
    val nodePath = "0.1"
    val occluderPath = "0.1.2.3.4"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 5,
        nodeSubtreeEnd = 5,
        occluderOrder = 20,
      )

    // occluder is a descendant check first: occluderOrder(20) > nodeOrder(5) && 20 <= 5? NO
    // Then: nodeParent="0", occluderParent="0.1.2.3" → not equal
    // Uncle check: occluderParent "0.1.2.3" prefix of "0.1"? NO
    // Nephew check: nodeParent "0" prefix of "0.1.2.3.4"? "0.1.2.3.4".startsWith("0.") → YES
    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  // MARK: - viewId Generation Tests

  @Test
  fun `UIElementInfo with resourceId gets viewId equal to resourceId`() {
    val element =
      UIElementInfo(resourceId = "com.example:id/my_button", viewId = "com.example:id/my_button")
    assertEquals("com.example:id/my_button", element.viewId)
  }

  @Test
  fun `UIElementInfo without resourceId gets UUID-formatted viewId`() {
    val uuidRegex = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    val viewId = extractor.generateDeterministicUuidForTest("0/1/2")
    assertTrue("viewId should be UUID-formatted but was: $viewId", uuidRegex.matches(viewId))
  }

  @Test
  fun `generateDeterministicUuid is stable - same input produces same output`() {
    val first = extractor.generateDeterministicUuidForTest("some/path/0")
    val second = extractor.generateDeterministicUuidForTest("some/path/0")
    assertEquals(first, second)
  }

  @Test
  fun `generateDeterministicUuid produces different UUIDs for different paths`() {
    val uuid1 = extractor.generateDeterministicUuidForTest("0/1/0")
    val uuid2 = extractor.generateDeterministicUuidForTest("0/1/1")
    assertTrue("Different paths should produce different UUIDs", uuid1 != uuid2)
  }

  @Test
  fun `viewId field is serialized to JSON with correct key`() {
    val element =
      UIElementInfo(
        text = "Hello",
        resourceId = "com.example:id/text",
        viewId = "com.example:id/text",
      )
    val jsonString = json.encodeToString(UIElementInfo.serializer(), element)
    assertTrue("JSON should contain view-id field", jsonString.contains("\"view-id\""))
  }

  @Test
  fun `occludedByViewId field is serialized to JSON with correct key`() {
    val element =
      UIElementInfo(
        text = "Covered",
        occlusionState = "partial",
        occludedBy = "unlabeled view",
        occludedByViewId = "stable-unlabeled-occluder",
      )
    val jsonString = json.encodeToString(UIElementInfo.serializer(), element)
    assertTrue(
      "JSON should contain occludedByViewId field",
      jsonString.contains("\"occludedByViewId\""),
    )
  }

  @Test
  fun `detectContentHiddenRegions finds large empty non-interactive Compose descendant with sparse child coverage`() {
    val visibleToolbar =
      elementWithBounds(
        resourceId = "com.slack:id/top_bar",
        bounds = bounds(0, 290, 1440, 458),
      )
    val hiddenBoundary =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        actions = listOf("accessibility_focus"),
        children = listOf(visibleToolbar),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(hiddenBoundary),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertEquals(1, regions.size)
    assertEquals("compose-interop-no-hide-descendants", regions[0].reason)
    assertEquals(bounds(0, 368, 1440, 2752), regions[0].bounds)
    assertEquals(79, regions[0].areaPercent)
  }

  @Test
  fun `detectContentHiddenRegions reports large Compose descendants with sparse child text content`() {
    val textChild =
      elementWithBounds(
        bounds = bounds(32, 500, 400, 560),
        text = "general",
      )
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        actions = listOf("accessibility_focus"),
        children = listOf(textChild),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertEquals(1, regions.size)
    assertEquals(bounds(0, 368, 1440, 2752), regions[0].bounds)
  }

  @Test
  fun `detectContentHiddenRegions reports large Compose descendants with sparse child content description`() {
    val iconButton =
      elementWithBounds(
        bounds = bounds(32, 500, 112, 580),
        contentDesc = "Open navigation drawer",
      )
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        actions = listOf("accessibility_focus"),
        children = listOf(iconButton),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertEquals(1, regions.size)
    assertEquals(bounds(0, 368, 1440, 2752), regions[0].bounds)
  }

  @Test
  fun `detectContentHiddenRegions ignores large Compose descendants with substantial child text coverage`() {
    val visibleContent =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 1200),
        text = "Visible conversation content",
      )
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        actions = listOf("accessibility_focus"),
        children = listOf(visibleContent),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions ignores large Compose descendants with text on candidate boundary`() {
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        text = "Conversation list",
        actions = listOf("accessibility_focus"),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions ignores large Compose descendants with content description on candidate boundary`() {
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        contentDesc = "Conversation list",
        actions = listOf("accessibility_focus"),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions ignores interactive Compose descendants`() {
    val interactiveRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        actions = listOf("click"),
      )
    val composeRoot =
      elementWithBounds(
        className = "androidx.compose.ui.platform.ComposeView",
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(interactiveRegion),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions deduplicates hidden regions aggregated across window roots`() {
    val firstWindow = composeRootWithHiddenBoundary(bounds(0, 368, 1440, 1400))
    val duplicateWindow = composeRootWithHiddenBoundary(bounds(0, 368, 1440, 1400))
    val secondWindow = composeRootWithHiddenBoundary(bounds(0, 1500, 1440, 2752))

    val regions =
      extractor.detectContentHiddenRegionsAcrossRootsForTest(
        listOf(firstWindow, duplicateWindow, secondWindow)
      )

    assertNotNull(regions)
    assertEquals(2, regions!!.size)
    assertEquals(bounds(0, 368, 1440, 1400), regions[0].bounds)
    assertEquals(bounds(0, 1500, 1440, 2752), regions[1].bounds)
  }

  private fun ViewHierarchyExtractor.generateDeterministicUuidForTest(path: String): String {
    val method = this.javaClass.getDeclaredMethod("generateDeterministicUuid", String::class.java)
    method.isAccessible = true
    return method.invoke(this, path) as String
  }

  // Helper method to read the visible typed children of a hierarchy node (issue #5471).
  private fun ViewHierarchyExtractor.extractChildrenFromHierarchy(
    element: UIElementInfo
  ): List<UIElementInfo> = this.visibleChildren(element)

  @Suppress("UNCHECKED_CAST")
  private fun ViewHierarchyExtractor.optimizeHierarchyForTest(
    element: UIElementInfo
  ): List<UIElementInfo> {
    val method = this.javaClass.getDeclaredMethod("optimizeHierarchy", UIElementInfo::class.java)
    method.isAccessible = true
    return method.invoke(this, element) as List<UIElementInfo>
  }

  // Issue #5471: the optimize pass walks typed children and performs ZERO serialization, so every
  // element it returns still has a null `node` (the wire projection is built only at the boundary).
  @Test
  fun `optimize pass performs no intermediate serialization`() {
    val leaf = UIElementInfo(text = "leaf", clickable = "true")
    val interactiveParent = UIElementInfo(text = "row", clickable = "true", children = listOf(leaf))
    val boundsOnlyWrapper =
      UIElementInfo(bounds = ElementBounds(0, 0, 100, 100), children = listOf(interactiveParent))

    val optimized = extractor.optimizeHierarchyForTest(boundsOnlyWrapper)

    fun assertNoNode(element: UIElementInfo) {
      assertNull("pipeline must not materialize node before the wire boundary", element.node)
      element.children.forEach(::assertNoNode)
    }
    optimized.forEach(::assertNoNode)

    // The bounds-only wrapper is promoted away; its interactive child (with its typed leaf)
    // remains.
    assertEquals(1, optimized.size)
    assertEquals("row", optimized.single().text)
    assertEquals("leaf", optimized.single().children.single().text)
  }

  private fun elementWithBounds(
    resourceId: String? = null,
    viewId: String? = resourceId,
    bounds: ElementBounds? = null,
    className: String? = null,
    text: String? = null,
    contentDesc: String? = null,
    actions: List<String>? = null,
    children: List<UIElementInfo> = emptyList(),
  ): UIElementInfo {
    return UIElementInfo(
      resourceId = resourceId,
      viewId = viewId,
      bounds = bounds,
      className = className,
      text = text,
      contentDesc = contentDesc,
      actions = actions,
      children = children,
    )
  }

  private fun bounds(left: Int, top: Int, right: Int, bottom: Int): ElementBounds {
    return ElementBounds(left, top, right, bottom)
  }

  private fun composeRootWithHiddenBoundary(boundaryBounds: ElementBounds): UIElementInfo {
    val hiddenBoundary =
      elementWithBounds(
        bounds = boundaryBounds,
        actions = listOf("accessibility_focus"),
      )
    return elementWithBounds(
      className = "androidx.compose.ui.platform.ComposeView",
      bounds = bounds(0, 0, 1440, 3000),
      children = listOf(hiddenBoundary),
    )
  }

  private fun findElementByResourceId(
    element: UIElementInfo,
    resourceId: String,
  ): UIElementInfo? {
    if (element.resourceId == resourceId) {
      return element
    }
    for (child in element.children) {
      val found = findElementByResourceId(child, resourceId)
      if (found != null) {
        return found
      }
    }
    return null
  }

  private fun ViewHierarchyExtractor.createWindowEntry(
    windowId: Int,
    windowLayer: Int,
    hierarchy: UIElementInfo,
    windowType: String = "application",
    packageName: String? = null,
    isActive: Boolean = true,
    isFocused: Boolean = true,
  ): Any {
    val windowEntryClass = this.javaClass.declaredClasses.first { it.simpleName == "WindowEntry" }
    val constructor =
      windowEntryClass.getDeclaredConstructor(
        Int::class.javaPrimitiveType,
        String::class.java,
        Int::class.javaPrimitiveType,
        String::class.java,
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
        UIElementInfo::class.java,
      )
    constructor.isAccessible = true
    return constructor.newInstance(
      windowId,
      windowType,
      windowLayer,
      packageName,
      isActive,
      isFocused,
      hierarchy,
    )
  }

  private fun ViewHierarchyExtractor.buildOcclusionInfoForTest(
    windowEntries: List<Any>
  ): Map<*, *> {
    val method = this.javaClass.getDeclaredMethod("buildOcclusionInfo", List::class.java)
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    return method.invoke(this, windowEntries) as Map<*, *>
  }

  private fun ViewHierarchyExtractor.filterOccludedHierarchyForTest(
    element: UIElementInfo,
    occlusionInfo: Map<*, *>,
    windowKey: Int,
    path: String,
    isRoot: Boolean,
  ): UIElementInfo? {
    val method =
      this.javaClass.getDeclaredMethod(
        "filterOccludedHierarchy",
        UIElementInfo::class.java,
        Map::class.java,
        Int::class.javaPrimitiveType,
        String::class.java,
        Boolean::class.javaPrimitiveType,
      )
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    return method.invoke(this, element, occlusionInfo, windowKey, path, isRoot) as UIElementInfo?
  }

  private fun ViewHierarchyExtractor.detectContentHiddenRegionsForTest(
    element: UIElementInfo,
    screenWidth: Int,
    screenHeight: Int,
  ): List<dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion> {
    val method =
      this.javaClass.getDeclaredMethod(
        "detectContentHiddenRegions",
        UIElementInfo::class.java,
        Int::class.javaPrimitiveType,
        Int::class.javaPrimitiveType,
      )
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    return method.invoke(this, element, screenWidth, screenHeight)
      as List<dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion>
  }

  private fun ViewHierarchyExtractor.detectContentHiddenRegionsAcrossRootsForTest(
    elements: List<UIElementInfo>
  ): List<dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion>? {
    val method =
      this.javaClass.getDeclaredMethod(
        "detectContentHiddenRegions",
        List::class.java,
        dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions::class.java,
      )
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    return method.invoke(this, elements, null)
      as List<dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion>?
  }
}
