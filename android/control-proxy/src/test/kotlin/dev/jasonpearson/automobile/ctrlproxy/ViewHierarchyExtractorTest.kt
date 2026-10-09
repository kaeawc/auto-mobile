package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.text.SpannableString
import android.text.style.ClickableSpan
import android.util.SparseArray
import android.view.View
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SemanticLink
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.models.WindowInfo
import dev.jasonpearson.automobile.ctrlproxy.overlay.INTERACTIVE_OVERLAY_WINDOW_TITLE
import dev.jasonpearson.automobile.ctrlproxy.overlay.OverlayWindowMetadata
import java.util.Random
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

  @Test
  fun `window extraction selects only the requested display roots`() {
    val inner =
      fakeWindow(201, 0, fakeNode(packageName = "app.inner", text = "Inner"), focused = true)
    val cover = fakeWindow(202, 0, fakeNode(packageName = "app.cover", text = "Cover"))
    val all =
      SparseArray<List<AccessibilityWindowInfo>>().apply {
        put(0, listOf(inner))
        put(2, listOf(cover))
      }

    assertEquals(0, extractor.targetDisplayId(all))
    assertEquals(2, extractor.targetDisplayId(all, requestedDisplayId = 2))
    val selected = extractor.windowsForDisplay(all, 2)
    val hierarchy =
      extractor.extractFromAllWindows(
        selected,
        null,
        disableAllFiltering = true,
        displayId = 2,
        panelUniqueId = "panel-cover",
      )
    val serialized = json.encodeToString(ViewHierarchy.serializer(), hierarchy)
    assertTrue(serialized.contains("Cover"))
    assertFalse(serialized.contains("Inner"))
    assertEquals(2, hierarchy.windows?.single()?.displayId)
    assertEquals("panel-cover", hierarchy.windows?.single()?.panelUniqueId)
  }

  @Test
  fun `window entries report the package of their root node`() {
    val app = fakeWindow(1, 0, fakeNode(packageName = "app.main", text = "Main"))
    val overlay =
      fakeWindow(
        2,
        1,
        fakeNode(packageName = "dev.jasonpearson.automobile.ctrlproxy", text = "Overlay"),
        type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        focused = true,
      )

    val hierarchy =
      extractor.extractFromAllWindows(listOf(app, overlay), null, disableAllFiltering = true)

    assertEquals(
      mapOf(1 to "app.main", 2 to "dev.jasonpearson.automobile.ctrlproxy"),
      hierarchy.windows?.associate { it.id to it.packageName },
    )
  }

  @Test
  fun `window entry package round trips and is omitted from the wire when null`() {
    val withPackage = WindowInfo(id = 2, type = 4, isFocused = true, packageName = "app.main")
    val withoutPackage = WindowInfo(id = 3, type = 1)

    // encodeDefaults = true: the null package must still be dropped by @EncodeDefault(NEVER).
    val wire = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
    val encodedWith = wire.encodeToString(WindowInfo.serializer(), withPackage)
    val encodedWithout = wire.encodeToString(WindowInfo.serializer(), withoutPackage)

    assertTrue(encodedWith.contains("\"packageName\":\"app.main\""))
    assertFalse(encodedWithout.contains("packageName"))
    assertEquals(withPackage, wire.decodeFromString(WindowInfo.serializer(), encodedWith))
    assertEquals(withoutPackage, wire.decodeFromString(WindowInfo.serializer(), encodedWithout))
    // An older APK's entry, which never sent the field, still decodes.
    assertNull(
      wire
        .decodeFromString(WindowInfo.serializer(), """{"id":3,"type":1,"isActive":false}""")
        .packageName,
    )
  }

  @Test
  fun `active default display wins over focused virtual display`() {
    val phone = fakeWindow(1, 0, fakeNode(packageName = "phone", text = "Phone"), active = true)
    val virtual = fakeWindow(2, 0, fakeNode(packageName = "virtual"), focused = true)
    val all =
      SparseArray<List<AccessibilityWindowInfo>>().apply {
        put(0, listOf(phone))
        put(2, listOf(virtual))
      }
    assertEquals(0, extractor.targetDisplayId(all))
    assertEquals("Phone", extractor.rootForDisplay(virtual.root, listOf(phone), 0)?.text)
  }

  @Test
  fun `phone window selection includes IME from either display bucket`() {
    val phone = fakeWindow(1, 0, fakeNode(packageName = "phone"), focused = true)
    val localIme =
      fakeWindow(
        2,
        1,
        fakeNode(packageName = "ime"),
        type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
      )
    val shiftedIme =
      fakeWindow(
        3,
        1,
        fakeNode(packageName = "ime"),
        type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
      )
    val systemUi =
      fakeWindow(
        4,
        2,
        fakeNode(packageName = "com.android.systemui"),
        type = AccessibilityWindowInfo.TYPE_SYSTEM,
      )
    val all =
      SparseArray<List<AccessibilityWindowInfo>>().apply {
        put(0, listOf(phone, localIme))
        put(2, listOf(shiftedIme, systemUi))
      }
    assertEquals(listOf(1, 2, 3, 4), extractor.windowsForDisplay(all, 0).map { it.id })
    assertEquals(listOf(3, 4), extractor.windowsForDisplay(all, 2).map { it.id })
  }

  private lateinit var extractor: ViewHierarchyExtractor
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `raw hierarchy reports both checkable states and omits checked for other nodes`() {
    for ((checkable, checked) in listOf(true to false, true to true, false to false)) {
      val node = android.view.accessibility.AccessibilityNodeInfo.obtain()
      node.className = "android.widget.Switch"
      node.text = "Hotspot"
      node.isVisibleToUser = true
      node.isCheckable = checkable
      node.isChecked = checked
      node.setBoundsInScreen(Rect(0, 0, 100, 100))
      android.view.accessibility.AccessibilityNodeInfo::class
        .java
        .getMethod("setSealed", Boolean::class.javaPrimitiveType)
        .invoke(node, true)

      val result = extractor.extractFromActiveWindow(node, disableAllFiltering = true)
      assertNull(result!!.error)
      val rawNode = result.hierarchy!!.node as kotlinx.serialization.json.JsonObject
      assertEquals(
        if (checkable) kotlinx.serialization.json.JsonPrimitive(checked.toString()) else null,
        rawNode["checked"],
      )
      assertEquals(
        if (checkable) kotlinx.serialization.json.JsonPrimitive("true") else null,
        rawNode["checkable"],
      )
      node.recycle()
    }
  }

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

  @Test
  fun `window scopes reserve nodes for later windows and release unused shares`() {
    val budget = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 20), slotCount = 3)
    budget.inScope { first ->
      repeat(14) { assertTrue(first.enter(0)) }
      assertFalse(first.enter(0))
      assertEquals(listOf("max_nodes"), first.truncationReasons())
      assertThrows(IllegalStateException::class.java) { budget.openScope() }
    }
    // A null-root window still opens and finishes its slot without consuming nodes.
    budget.inScope { skipped -> assertTrue(skipped.truncationReasons().isEmpty()) }
    budget.inScope { last ->
      repeat(6) { assertTrue(last.enter(0)) }
      assertFalse(last.enter(0))
    }
    assertEquals(listOf("max_nodes"), budget.truncationReasons())
  }

  @Test
  fun `window scopes attribute cancellation and depth without leaking reasons`() {
    var cancelled = false
    val budget =
      HierarchySnapshotBudget(
        HierarchySnapshotOptions(maxNodes = 4, maxDepth = 0, isCancelled = { cancelled }),
        slotCount = 2,
      )
    budget.inScope { first ->
      assertFalse(first.enter(1))
      cancelled = true
      assertFalse(first.enter(1))
      assertEquals(listOf("max_depth", "cancelled"), first.truncationReasons())
    }
    cancelled = false
    budget.inScope { second ->
      repeat(4) { assertTrue(second.enter(0)) }
      assertFalse(second.enter(0))
      assertEquals(listOf("max_nodes"), second.truncationReasons())
    }
    assertEquals(listOf("max_depth", "cancelled", "max_nodes"), budget.truncationReasons())
  }

  @Test
  fun `one slot matches the legacy counter and failure precedence`() {
    var cancelled = false
    val options = HierarchySnapshotOptions(maxNodes = 2, maxDepth = 0, isCancelled = { cancelled })
    val legacy = HierarchySnapshotBudget(options)
    val scoped = HierarchySnapshotBudget(options, slotCount = 1)
    scoped.inScope { scope ->
      repeat(2) {
        assertTrue(legacy.enter(0))
        assertTrue(scope.enter(0))
      }
      // All limits apply: cancellation wins, then depth, then the node cap.
      cancelled = true
      assertFalse(legacy.enter(1))
      assertFalse(scope.enter(1))
      assertEquals(listOf("cancelled"), scope.truncationReasons())
      cancelled = false
      assertFalse(legacy.enter(1))
      assertFalse(scope.enter(1))
      assertEquals(listOf("cancelled", "max_depth"), scope.truncationReasons())
      assertFalse(legacy.enter(0))
      assertFalse(scope.enter(0))
      assertEquals(listOf("cancelled", "max_depth", "max_nodes"), scope.truncationReasons())
      assertEquals(legacy.truncationReasons(), scope.truncationReasons())
    }
    assertEquals(legacy.truncationReasons(), scoped.truncationReasons())
  }

  @Test
  fun `more window slots than nodes never exceeds the global cap`() {
    val budget = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 2), slotCount = 4)
    var admitted = 0
    repeat(4) {
      budget.inScope { scope ->
        while (scope.enter(0)) admitted += 1
      }
    }
    assertEquals(2, admitted)
    assertEquals(listOf("max_nodes"), budget.truncationReasons())
  }

  @Test
  fun `scope finish releases reservations even when extraction throws`() {
    val budget = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 6), slotCount = 2)
    assertThrows(IllegalStateException::class.java) {
      budget.inScope<Unit> { throw IllegalStateException("fake extraction failure") }
    }
    budget.inScope { last ->
      repeat(6) { assertTrue(last.enter(0)) }
      assertFalse(last.enter(0))
    }
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
  fun `extractFromActiveWindow retains zero-area parent with non-zero-area child`() {
    val child = fakeNode(packageName = "example.app", text = "Visible child")
    val parent =
      fakeNode(
        packageName = "example.app",
        bounds = Rect(0, 0, 0, 0),
        children = listOf(child),
      )

    val result = extractor.extractFromActiveWindow(parent, disableAllFiltering = true)

    assertNotNull(result!!.hierarchy)
    assertTrue(result.hierarchy!!.node.toString().contains("Visible child"))
    parent.recycle()
  }

  @Test
  fun `extractFromActiveWindow prunes zero-area subtree without visible descendants`() {
    val child = fakeNode(packageName = "example.app", bounds = Rect(0, 0, 0, 0))
    val parent =
      fakeNode(
        packageName = "example.app",
        bounds = Rect(0, 0, 0, 0),
        children = listOf(child),
      )

    val result = extractor.extractFromActiveWindow(parent, disableAllFiltering = true)

    assertNull(result!!.hierarchy)
    parent.recycle()
  }

  @Test
  fun `offscreen filtering requires valid dimensions and ignores visibility flag`() {
    for (dimensions in listOf(ScreenDimensions(100, 200), null, ScreenDimensions(0, 200))) {
      val offscreen =
        fakeNode("example.app", text = "Offscreen row", bounds = Rect(10, 201, 40, 240))
      val visible =
        fakeNode(
          "example.app",
          text = "Visible row",
          bounds = Rect(10, 20, 40, 60),
          visibleToUser = false,
        )
      val root =
        fakeNode(
          "example.app",
          bounds = Rect(0, 0, 100, 200),
          children = listOf(offscreen, visible),
        )
      try {
        val result =
          extractor.extractFromActiveWindow(
            root,
            screenDimensions = dimensions,
            disableAllFiltering = true,
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
        .contains("semantic-links"),
    )
    assertTrue(
      verboseJson
        .encodeToString(
          UIElementInfo.serializer(),
          UIElementInfo(semanticLinks = listOf(SemanticLink("Terms", 0, 0, 5))),
        )
        .contains("semantic-links"),
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
      ),
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
      ),
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
      },
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
        mapOf("other" to "x", stateDescriptionExtraKey to "Checked"),
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
        mapOf("androidx.compose.ui.semantics.testTag" to "compose_row_7"),
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
          windowBounds = bounds(0, 1291, 295, 1543),
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
        bounds = Rect(0, 0, 1080, 2400),
        children =
          listOf(fakeNode("example.app", text = "Discover", bounds = Rect(43, 314, 319, 398))),
      )
    val overlay =
      fakeNode(
        packageName = "com.android.systemui",
        text = "Clipboard",
        bounds = Rect(0, 0, 1080, 2400),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(420, 0, app, focused = true),
          fakeWindow(
            423,
            3,
            overlay,
            type = AccessibilityWindowInfo.TYPE_SYSTEM,
            bounds = Rect(0, 1291, 295, 1543),
          ),
        ),
        null,
      )

    assertTrue(json.encodeToString(ViewHierarchy.serializer(), result).contains("Discover"))
    assertEquals(bounds(0, 1291, 295, 1543), result.windows!!.first { it.id == 423 }.bounds)
  }

  /**
   * A floating overlay window covering one app row, as in the #10608/#10544 repro (p7/p8): the
   * row's bounds lie wholly inside the overlay's root.
   */
  private fun coveredRowExtraction(
    overlayType: Int,
    overlayPackage: String,
    overlayTitle: CharSequence?,
    extractor: ViewHierarchyExtractor = this.extractor,
  ): ViewHierarchy {
    val app =
      fakeNode(
        packageName = "example.app",
        text = "App",
        bounds = Rect(0, 0, 1080, 2400),
        children =
          listOf(
            fakeNode("example.app", text = "Visible row", bounds = Rect(0, 200, 1080, 400)),
            fakeNode("example.app", text = "Covered row", bounds = Rect(100, 1000, 980, 1200)),
          ),
      )
    val overlay =
      fakeNode(
        packageName = overlayPackage,
        text = "Overlay card",
        bounds = Rect(0, 900, 1080, 1400),
      )
    return extractor.extractFromAllWindows(
      listOf(
        fakeWindow(1, 0, app, focused = true, active = true),
        fakeWindow(
          2,
          5,
          overlay,
          type = overlayType,
          bounds = Rect(0, 900, 1080, 1400),
          title = overlayTitle,
        ),
      ),
      null,
    )
  }

  @Test
  fun `own interactive overlay windows of either layer do not prune covered app rows`() {
    // The app layer's TYPE_APPLICATION_OVERLAY window reports as TYPE_SYSTEM (#10544).
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        AccessibilityWindowInfo.TYPE_SYSTEM,
      )) {
      val result =
        coveredRowExtraction(
          type,
          "dev.jasonpearson.automobile.ctrlproxy",
          INTERACTIVE_OVERLAY_WINDOW_TITLE,
        )
      val serialized = json.encodeToString(ViewHierarchy.serializer(), result)
      assertTrue("type $type", serialized.contains("Covered row"))
      assertFalse("type $type", serialized.contains("\"occlusionState\":\"hidden\""))
      assertTrue("type $type", serialized.contains("Overlay card"))
    }
  }

  @Test
  fun `third-party and highlight overlays still prune covered app rows`() {
    for ((type, pkg, title) in
      listOf(
        Triple(AccessibilityWindowInfo.TYPE_SYSTEM, "com.android.systemui", "NotificationShade"),
        Triple(AccessibilityWindowInfo.TYPE_SYSTEM, "com.android.systemui", null),
        // CtrlProxy's highlight overlay keeps today's behaviour: only the interactive title skips.
        Triple(
          AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
          "dev.jasonpearson.automobile.ctrlproxy",
          "AutoMobile Overlay",
        ),
        // The interactive title on an application window is not an overlay window.
        Triple(
          AccessibilityWindowInfo.TYPE_APPLICATION,
          "other.app",
          INTERACTIVE_OVERLAY_WINDOW_TITLE,
        ),
      )) {
      val serialized =
        json.encodeToString(ViewHierarchy.serializer(), coveredRowExtraction(type, pkg, title))
      assertFalse("$type $title", serialized.contains("Covered row"))
      assertTrue("$type $title", serialized.contains("Visible row"))
    }
  }

  @Test
  fun `overlay metadata is stamped on both overlay layers but never on SystemUI windows`() {
    val asked = mutableListOf<Pair<String?, String?>>()
    val stamping =
      ViewHierarchyExtractor(
        ownOverlayMetadata = { pkg, title ->
          asked += pkg to title?.toString()
          OverlayWindowMetadata("floating", opaque = false)
        },
      )
    val own = "dev.jasonpearson.automobile.ctrlproxy"
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        AccessibilityWindowInfo.TYPE_SYSTEM,
      )) {
      val window =
        coveredRowExtraction(type, own, INTERACTIVE_OVERLAY_WINDOW_TITLE, stamping)
          .windows!!
          .single { it.id == 2 }
      assertEquals("type $type", "floating", window.overlayPlacement)
      assertEquals("type $type", false, window.overlayOpaque)
    }
    assertEquals(List(2) { own to INTERACTIVE_OVERLAY_WINDOW_TITLE }, asked)

    asked.clear()
    for (title in listOf("NotificationShade", "StatusBar", null)) {
      val window =
        coveredRowExtraction(
            AccessibilityWindowInfo.TYPE_SYSTEM,
            "com.android.systemui",
            title,
            stamping,
          )
          .windows!!
          .single { it.id == 2 }
      assertNull(window.overlayPlacement)
      assertNull(window.overlayOpaque)
    }
    assertTrue(asked.isEmpty())
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
            windowBounds = bounds(0, 0, 1080, 2400),
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
              windowBounds = windowBounds,
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
          extractor.createWindowEntry(423, 3, target, windowBounds = bounds(0, 1291, 295, 1543)),
        ),
      )
    val filtered = extractor.filterOccludedHierarchyForTest(app, info, 420, "", true)!!

    assertEquals(target.bounds, filtered.children.single().bounds)
    assertNull(filtered.children.single().occlusionState)
  }

  @Test
  fun `systemui notification group retains text marked invisible by the framework`() {
    val group =
      fakeNode(
        packageName = "com.android.systemui",
        text = "Notifications",
        children =
          listOf(
            fakeNode("com.android.systemui", text = "Grouped notification", visibleToUser = false),
          ),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 1, group, type = AccessibilityWindowInfo.TYPE_SYSTEM, focused = true)),
        null,
      )

    assertTrue(
      json.encodeToString(ViewHierarchy.serializer(), result).contains("Grouped notification"),
    )
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
            windowBounds = bounds(0, 1291, 295, 1543),
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
            elementWithBounds(
              resourceId = "$id-$index",
              bounds = bounds(0, 0, 1080, 100),
            )
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
  fun `pickPrimaryAppWindowId prefers focused application over higher-layer system window`() {
    // Regression for #5971: on API 34, a status bar window can be marked active while the
    // foreground Settings window is the only focused application window.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = true,
          isFocused = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId preserves focused app selection when its root is unavailable`() {
    // Regression for #5981: do not fall back to an active status-bar window when the focused
    // application temporarily has no accessible root.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = false,
          isFocused = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId leaves active-window fallback when a system window owns focus`() {
    // Genuine system UI: an expanded shade / quick settings / keyguard reports isFocused, and
    // the app beneath it must not be promoted over it (the systemTray workflow observes the
    // shade).
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
          isFocused = true,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId prefers an app window with content when no window reports focus`() {
    // Regression for #6151: when the isFocused flag is populated nowhere, the topmost application
    // window with a root outranks a status bar that merely happens to be marked active.
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
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId prefers the active app over a higher-layer app when no window reports focus`() {
    // Split-screen / picture-in-picture with the focus flag populated nowhere: the resumed
    // (active) application must win over a merely topmost one, so mainPackageName agrees with
    // adb's resumed package and freshness is not retracted against the wrong app.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
          isActive = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 12,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 3,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId selects a focused permission dialog over the app beneath it`() {
    // API 34 shape with a runtime permission dialog in front: the permissioncontroller dialog
    // is its own focused TYPE_APPLICATION window layered above the (unfocused) app window.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 219,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 2,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 318,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 0,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 322,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
          isFocused = true,
        ),
      )
    assertEquals(322, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId selects a focused Settings sub-panel over the status bar`() {
    // API 34 shape with the Settings Wi-Fi picker in front (dumpsys accessibility ground truth
    // from #6151): status bar TYPE_SYSTEM layer 1, Settings window focused+active layer 0.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 219,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 256,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 0,
          hasRoot = true,
          isFocused = true,
        ),
      )
    assertEquals(256, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId keeps the active-window fallback for a status bar alone`() {
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 219,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 1,
          hasRoot = true,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `extractFromAllWindows detects a notification permission dialog in a non-primary window`() {
    // #6151: the flag exists to catch this dialog, so it must be computed from whichever window
    // carries it. Here the app window (still focused, as observed mid-transition) is primary and
    // the permissioncontroller dialog is a second, unfocused application window.
    val appRoot =
      fakeNode(
        packageName = "com.google.android.contacts",
        bounds = Rect(0, 0, 1080, 2400),
        children = listOf(fakeNode(packageName = "com.google.android.contacts", text = "Contacts")),
      )
    val dialogRoot =
      fakeNode(
        packageName = "com.google.android.permissioncontroller",
        bounds = Rect(28, 682, 1052, 1654),
        children =
          listOf(
            fakeNode(
              packageName = "com.google.android.permissioncontroller",
              text = "Allow Contacts to send you notifications?",
              bounds = Rect(100, 700, 1000, 800),
            ),
            fakeNode(
              packageName = "com.google.android.permissioncontroller",
              text = "Allow",
              resourceId = "com.android.permissioncontroller:id/permission_allow_button",
              bounds = Rect(100, 1500, 500, 1600),
            ),
            fakeNode(
              packageName = "com.google.android.permissioncontroller",
              text = "Don't allow",
              resourceId = "com.android.permissioncontroller:id/permission_deny_button",
              bounds = Rect(600, 1500, 1000, 1600),
            ),
          ),
      )
    val windows =
      listOf(
        fakeWindow(id = 318, layer = 0, root = appRoot, focused = true),
        fakeWindow(id = 322, layer = 1, root = dialogRoot, active = true),
      )

    val result = extractor.extractFromAllWindows(windows, appRoot, occlusionEnabled = false)

    assertEquals(true, result.notificationPermissionDetected)
    assertEquals("com.google.android.contacts", result.packageName)
    assertNull(result.ctrlProxyIncomplete)
    val serialized = json.encodeToString(ViewHierarchy.serializer(), result)
    assertTrue(serialized.contains("permission_allow_button"))
    assertTrue(serialized.contains("Allow Contacts to send you notifications?"))

    // An unfocused, inactive permissioncontroller window beside the app (another app's dialog
    // in split-screen) must not flag this app's observation as a permission dialog.
    val bystander =
      listOf(
        fakeWindow(id = 318, layer = 0, root = appRoot, focused = true, active = true),
        fakeWindow(id = 322, layer = 1, root = dialogRoot),
      )
    val bystanderResult =
      extractor.extractFromAllWindows(bystander, appRoot, occlusionEnabled = false)
    assertEquals(false, bystanderResult.notificationPermissionDetected)
  }

  @Test
  fun `extractFromAllWindows does not flag an unrelated app's active dialog in a split-screen pane`() {
    // #6151 follow-up: `canCarryDialog` used to accept ANY focused-or-active permissioncontroller
    // window, so a foreign app's own active dialog in the other split-screen pane could still set
    // the primary app's `notificationPermissionDetected`. Here App A (primary, focused) occupies
    // the top half of the screen; App B's own active permission dialog occupies the bottom half —
    // a disjoint region, so it does not overlap App A's window and must not be correlated with it.
    val appARoot =
      fakeNode(
        packageName = "com.google.android.contacts",
        bounds = Rect(0, 0, 1080, 1200),
        children = listOf(fakeNode(packageName = "com.google.android.contacts", text = "Contacts")),
      )
    val foreignDialogRoot =
      fakeNode(
        packageName = "com.google.android.permissioncontroller",
        bounds = Rect(28, 1300, 1052, 2300),
        children =
          listOf(
            fakeNode(
              packageName = "com.google.android.permissioncontroller",
              text = "Allow Maps to send you notifications?",
              bounds = Rect(100, 1350, 1000, 1450),
            ),
            fakeNode(
              packageName = "com.google.android.permissioncontroller",
              text = "Allow",
              resourceId = "com.android.permissioncontroller:id/permission_allow_button",
              bounds = Rect(100, 2100, 500, 2200),
            ),
          ),
      )
    val windows =
      listOf(
        fakeWindow(
          id = 318,
          layer = 0,
          root = appARoot,
          focused = true,
          bounds = Rect(0, 0, 1080, 1200),
        ),
        fakeWindow(
          id = 322,
          layer = 0,
          root = foreignDialogRoot,
          active = true,
          bounds = Rect(0, 1200, 1080, 2400),
        ),
      )

    val result = extractor.extractFromAllWindows(windows, appARoot, occlusionEnabled = false)

    assertEquals(false, result.notificationPermissionDetected)
    assertEquals("com.google.android.contacts", result.packageName)
  }

  @Test
  fun `extractFromAllWindows reports an incomplete capture when the focused app root is withheld`() {
    // The #6151 device shape before the isAccessibilityTool declaration: the status bar has a
    // root, the focused Settings window does not, and rootInActiveWindow is null too. The
    // capture must be flagged incomplete with no package rather than labelled as app content.
    val statusBarRoot =
      fakeNode(
        packageName = "com.android.systemui",
        bounds = Rect(0, 0, 1080, 63),
        children =
          listOf(
            fakeNode(
              packageName = "com.android.systemui",
              text = "8:33",
              resourceId = "com.android.systemui:id/clock",
              bounds = Rect(21, 0, 107, 63),
            ),
          ),
      )
    val windows =
      listOf(
        fakeWindow(
          id = 219,
          layer = 1,
          root = statusBarRoot,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
        ),
        fakeWindow(id = 256, layer = 0, root = null, focused = true, active = true),
      )

    val result = extractor.extractFromAllWindows(windows, null, occlusionEnabled = false)

    assertEquals(true, result.ctrlProxyIncomplete)
    // All three causes hold; active-window withholding takes precedence.
    assertEquals("active_window_null_root", result.ctrlProxyIncompleteReason)
    assertNull(result.packageName)
    assertNotNull(result.hierarchy)
    val serialized = json.encodeToString(ViewHierarchy.serializer(), result)
    assertTrue(serialized.contains("com.android.systemui:id/clock"))
  }

  @Test
  fun `active null root wins even when an app window is readable`() {
    val app = fakeNode(packageName = "example.app", text = "Readable")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, app, focused = true),
          fakeWindow(2, 1, null, type = AccessibilityWindowInfo.TYPE_SYSTEM, active = true),
        ),
        null,
        occlusionEnabled = false,
      )
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("active_window_null_root", result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `selected app null root wins over no accessible app window`() {
    val bar = fakeNode(packageName = "com.android.systemui", text = "Clock")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 1, bar, type = AccessibilityWindowInfo.TYPE_SYSTEM, active = true),
          fakeWindow(2, 0, null, focused = true),
        ),
        null,
        occlusionEnabled = false,
      )
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("app_window_null_root", result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `non SystemUI foreground without app windows reports no app root`() {
    val overlay = fakeNode(packageName = "example.overlay", text = "Overlay")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            0,
            overlay,
            type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
            active = true,
          ),
        ),
        null,
        occlusionEnabled = false,
      )
    assertEquals("example.overlay", result.packageName)
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("no_app_window_root", result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `complete app capture omits incompleteness metadata`() {
    val app = fakeNode(packageName = "example.app", text = "Readable")
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 0, app, focused = true, active = true)),
        null,
        occlusionEnabled = false,
      )
    assertNotNull(result.hierarchy)
    assertNull(result.ctrlProxyIncomplete)
    assertNull(result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `SystemUI foreground without app windows remains complete`() {
    val shade = fakeNode(packageName = "com.android.systemui", text = "Notifications")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            0,
            shade,
            type = AccessibilityWindowInfo.TYPE_SYSTEM,
            focused = true,
            active = true,
          ),
        ),
        null,
        occlusionEnabled = false,
      )
    assertEquals("com.android.systemui", result.packageName)
    assertNotNull(result.hierarchy)
    assertNull(result.ctrlProxyIncomplete)
    assertNull(result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `unified hierarchy preserves IME subtree identity and raw key detail`() {
    val appRoot = fakeNode(packageName = "example.keyboard", text = "Settings")
    val imeRoot =
      fakeNode(
        packageName = "example.keyboard",
        text = "Keyboard",
        children = listOf(fakeNode(packageName = "example.keyboard", text = "Q")),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(id = 1, layer = 0, root = appRoot, focused = true),
          fakeWindow(
            id = 2,
            layer = 1,
            root = imeRoot,
            type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          ),
        ),
        appRoot,
        disableAllFiltering = true,
        occlusionEnabled = false,
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val app = roots[0] as kotlinx.serialization.json.JsonObject
    val ime = roots[1] as kotlinx.serialization.json.JsonObject
    assertNull(app["extras"])
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive("example.keyboard"),
      (ime["extras"] as kotlinx.serialization.json.JsonObject)["automobile:imePackage"],
    )
    assertTrue(ime.toString().contains("\"Q\""))
  }

  @Test
  fun `wire roots retain exact window ownership and layer independently of focus`() {
    val app = fakeNode(packageName = "example.app", text = "Duplicate")
    val overlay = fakeNode(packageName = "example.app", text = "Duplicate")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(id = 23, layer = 7, root = overlay),
          fakeWindow(id = 24, layer = 2, root = app, focused = true, active = true),
        ),
        app,
        disableAllFiltering = true,
        occlusionEnabled = false,
      )
    val encoded =
      json.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    val metadata = encoded["windows"] as kotlinx.serialization.json.JsonArray
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(24),
      (roots[0] as kotlinx.serialization.json.JsonObject)["windowId"],
    )
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(23),
      (roots[1] as kotlinx.serialization.json.JsonObject)["windowId"],
    )
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(7),
      (metadata[0] as kotlinx.serialization.json.JsonObject)["windowLayer"],
    )
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(2),
      (metadata[1] as kotlinx.serialization.json.JsonObject)["windowLayer"],
    )
  }

  @Test
  fun `fallback root retains matching window metadata`() {
    val app = fakeNode(packageName = "example.app", text = "Fallback")
    val result = extractor.extractFromAllWindows(emptyList(), app, disableAllFiltering = true)
    val root = result.hierarchy!!.node as kotlinx.serialization.json.JsonObject
    val encoded =
      json.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    val windows = encoded["windows"] as? kotlinx.serialization.json.JsonArray
    assertNotNull(windows)
    val metadata = windows!!.single() as kotlinx.serialization.json.JsonObject
    assertEquals(root["windowId"], metadata["id"])
    assertEquals(kotlinx.serialization.json.JsonPrimitive(0), metadata["windowLayer"])
  }

  @Test
  fun `fallback replaces an already extracted active window instead of duplicating its ownership`() {
    val activeRoot = fakeNode(packageName = "example.app", text = "Active content")
    val windows =
      listOf(
        fakeWindow(id = 41, layer = 0, root = null, focused = true),
        fakeWindow(id = 42, layer = 2, root = activeRoot, active = true),
      )
    val result =
      extractor.extractFromAllWindows(
        windows,
        activeRoot,
        disableAllFiltering = true,
        occlusionEnabled = false,
      )
    val encoded =
      json.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    val root = result.hierarchy!!.node as kotlinx.serialization.json.JsonObject
    assertEquals(kotlinx.serialization.json.JsonPrimitive(42), root["windowId"])
    assertNotNull(encoded["windows"])
  }

  @Test
  fun `large first window leaves the later IME complete within the total cap`() {
    val app = budgetTree("App", 40)
    val ime = budgetTree("Keyboard", 2)
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, app, focused = true),
          fakeWindow(2, 1, ime, type = AccessibilityWindowInfo.TYPE_INPUT_METHOD),
        ),
        null,
        disableAllFiltering = true,
        snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val imeOutput = roots[1] as kotlinx.serialization.json.JsonObject
    assertEquals(3, countWireNodes(imeOutput))
    assertTrue(imeOutput.toString().contains("Keyboard-1"))
    assertTrue(imeOutput.toString().contains("Keyboard-2"))
    assertNull(result.windows!!.first { it.id == 2 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.windows.first { it.id == 1 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.truncationReasons)
    assertTrue(countWireNodes(roots) <= 20)
  }

  @Test
  fun `reserved fallback recovers complete app content after large inactive windows`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 1, budgetTree("System", 40), type = AccessibilityWindowInfo.TYPE_SYSTEM),
          fakeWindow(2, 2, budgetTree("Overlay", 40), type = AccessibilityWindowInfo.TYPE_SYSTEM),
        ),
        budgetTree("Fallback", 2),
        disableAllFiltering = true,
        snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
      )
    assertEquals("example.app", result.packageName)
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val fallback =
      roots
        .map { it as kotlinx.serialization.json.JsonObject }
        .first {
          it["windowId"] == kotlinx.serialization.json.JsonPrimitive(-1)
        }
    assertEquals(3, countWireNodes(fallback))
    assertTrue(fallback.toString().contains("Fallback-2"))
    assertNull(result.windows!!.first { it.id == -1 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.windows.first { it.id == 1 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.truncationReasons)
    assertTrue(countWireNodes(roots) <= 20)
  }

  @Test
  fun `fallback replacement reports its own reasons and retains the global union`() {
    val discarded =
      fakeNode(
        packageName = "example.app",
        bounds = Rect(0, 0, 0, 0),
        children =
          (1..40).map {
            fakeNode(packageName = "example.app", bounds = Rect(0, 0, 0, 0))
          },
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(7, 0, discarded, type = AccessibilityWindowInfo.TYPE_SYSTEM, active = true),
        ),
        budgetTree("Fallback", 2),
        disableAllFiltering = true,
        snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
      )
    assertEquals(3, countWireNodes(result.hierarchy!!.node!!))
    assertEquals(7, result.windows!!.single().id)
    assertNull(result.windows.single().truncationReasons)
    assertEquals(listOf("max_nodes"), result.truncationReasons)
  }

  @Test
  fun `skipped null root releases its reservation for a later window`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("First", 40), focused = true),
          fakeWindow(2, 1, null),
          fakeWindow(3, 2, budgetTree("Last", 5)),
        ),
        null,
        disableAllFiltering = true,
        snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    assertEquals(6, countWireNodes(roots[1]))
    assertNull(result.windows!!.first { it.id == 3 }.truncationReasons)
    assertTrue(countWireNodes(roots) <= 20)
  }

  @Test
  fun `complete multi-window metadata omits truncation reasons even with encodeDefaults`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("App", 2), focused = true),
          fakeWindow(
            2,
            1,
            budgetTree("Keyboard", 2),
            type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          ),
        ),
        null,
        disableAllFiltering = true,
      )
    val verbose = Json { encodeDefaults = true }
    val encoded =
      verbose.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    assertFalse(encoded["windows"].toString().contains("truncationReasons"))
    assertNull(result.truncationReasons)
  }

  @Test
  fun `single primary window preserves exact legacy JSON with and without a fallback root`() {
    val childOne =
      """{"text":"One","resource-id":"one","view-id":"one","bounds":{"left":0,"top":100,"right":1080,"bottom":200},"visible-to-user":true}"""
    val childTwo = childOne.replace("One", "Two").replace("one", "two")
    for (limited in listOf(false, true)) {
      for (provideFallback in listOf(false, true)) {
        val root =
          fakeNode(
            packageName = "example.app",
            text = "Root",
            resourceId = "root",
            enabled = true,
            children =
              listOf(
                fakeNode(
                  packageName = "example.app",
                  text = "One",
                  resourceId = "one",
                  enabled = true,
                ),
                fakeNode(
                  packageName = "example.app",
                  text = "Two",
                  resourceId = "two",
                  enabled = true,
                ),
              ),
          )
        val result =
          extractor.extractFromAllWindows(
            listOf(fakeWindow(1, 0, root, focused = true)),
            if (provideFallback) root else null,
            disableAllFiltering = true,
            snapshotOptions =
              if (limited) HierarchySnapshotOptions(maxNodes = 2) else HierarchySnapshotOptions(),
          )
        val children = if (limited) childOne else "[$childOne,$childTwo]"
        val reasons = if (limited) ",\"truncationReasons\":[\"max_nodes\"]" else ""
        // Only the additive attribution (truncation reasons, window package) is removed; every
        // legacy field and its order is checked.
        assertEquals("example.app", result.windows!!.single().packageName)
        val legacy =
          result.copy(
            updatedAt = 0,
            userId = 0,
            windows = result.windows.map { it.copy(truncationReasons = null, packageName = null) },
          )
        val expected =
          """{"updatedAt":0,"packageName":"example.app","userId":0,"hierarchy":{"node":{"text":"Root","windowId":1,"displayId":0,"resource-id":"root","view-id":"root","bounds":{"left":0,"top":100,"right":1080,"bottom":200},"visible-to-user":true,"node":$children}},"windows":[{"id":1,"displayId":0,"type":1,"windowLayer":0,"isFocused":true,"bounds":{"left":0,"top":0,"right":1080,"bottom":2400}}],"intentChooserDetected":false,"notificationPermissionDetected":false$reasons}"""
        assertEquals(expected, json.encodeToString(ViewHierarchy.serializer(), legacy))
        assertEquals(
          if (limited) listOf("max_nodes") else null,
          result.windows.single().truncationReasons,
        )
      }
    }
  }

  @Test
  fun `child cap keeps 256 children and reports only the affected window`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("App", 300), focused = true),
          fakeWindow(2, 1, budgetTree("Small", 0)),
        ),
        null,
        disableAllFiltering = true,
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val children =
      (roots[0] as kotlinx.serialization.json.JsonObject)["node"]
        as kotlinx.serialization.json.JsonArray
    assertEquals(256, children.size)
    assertEquals(257, countWireNodes(roots[0]))
    assertEquals(listOf("max_children"), result.windows!!.first { it.id == 1 }.truncationReasons)
    assertNull(result.windows.first { it.id == 2 }.truncationReasons)
    assertEquals(listOf("max_children"), result.truncationReasons)
  }

  @Test
  fun `exactly 256 children remains complete and omits truncation metadata`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 0, budgetTree("App", 256), focused = true)),
        null,
        disableAllFiltering = true,
      )
    assertEquals(257, countWireNodes(result.hierarchy!!.node!!))
    assertNull(result.windows!!.single().truncationReasons)
    assertNull(result.truncationReasons)
    val encoded =
      Json { encodeDefaults = true }.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    assertFalse(encoded["windows"].toString().contains("truncationReasons"))
  }

  @Test
  fun `nested child caps are deduplicated per window and snapshot`() {
    val root =
      fakeNode(
        packageName = "example.app",
        text = "Root",
        children = listOf(budgetTree("First", 300), budgetTree("Second", 300)),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 0, root, focused = true)),
        null,
        disableAllFiltering = true,
      )
    assertEquals(515, countWireNodes(result.hierarchy!!.node!!))
    assertEquals(listOf("max_children"), result.windows!!.single().truncationReasons)
    assertEquals(listOf("max_children"), result.truncationReasons)
  }

  @Test
  fun `depth truncation belongs only to the window that exceeds the depth limit`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("App", 2), focused = true),
          fakeWindow(2, 1, budgetTree("Small", 0)),
        ),
        null,
        disableAllFiltering = true,
        snapshotOptions = HierarchySnapshotOptions(maxDepth = 0),
      )
    assertEquals(listOf("max_depth"), result.windows!!.first { it.id == 1 }.truncationReasons)
    assertNull(result.windows.first { it.id == 2 }.truncationReasons)
    assertEquals(listOf("max_depth"), result.truncationReasons)
  }

  @Test
  fun `cancelled windows and fallback retain attribution even when no tree is returned`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("System", 0), type = AccessibilityWindowInfo.TYPE_SYSTEM),
        ),
        budgetTree("Fallback", 0),
        disableAllFiltering = true,
        snapshotOptions = HierarchySnapshotOptions(isCancelled = { true }),
      )
    assertNull(result.hierarchy)
    assertEquals(listOf("cancelled"), result.truncationReasons)
    assertEquals(listOf(1, -1), result.windows!!.map { it.id })
    assertTrue(result.windows.all { it.truncationReasons == listOf("cancelled") })
  }

  private fun budgetTree(label: String, children: Int) =
    fakeNode(
      packageName = "example.app",
      text = label,
      children = (1..children).map { fakeNode(packageName = "example.app", text = "$label-$it") },
    )

  private fun countWireNodes(element: kotlinx.serialization.json.JsonElement): Int =
    when (element) {
      is kotlinx.serialization.json.JsonArray -> element.sumOf { countWireNodes(it) }
      is kotlinx.serialization.json.JsonObject ->
        1 + (element["node"]?.let { countWireNodes(it) } ?: 0)
      else -> 0
    }

  private fun fakeNode(
    packageName: String,
    text: String? = null,
    resourceId: String? = null,
    bounds: Rect = Rect(0, 100, 1080, 200),
    children: List<android.view.accessibility.AccessibilityNodeInfo> = emptyList(),
    enabled: Boolean? = null,
    visibleToUser: Boolean = true,
  ): android.view.accessibility.AccessibilityNodeInfo {
    val node = android.view.accessibility.AccessibilityNodeInfo.obtain()
    node.packageName = packageName
    node.className = "android.widget.TextView"
    node.text = text
    node.viewIdResourceName = resourceId
    node.setBoundsInScreen(bounds)
    node.isVisibleToUser = visibleToUser
    enabled?.let { node.isEnabled = it }
    val shadow = org.robolectric.Shadows.shadowOf(node)
    for (child in children) {
      shadow.addChild(child)
    }
    // The extractor calls findFocus on each window root, which the framework only allows on a
    // sealed (service-delivered) node. setSealed is a hidden API, so seal via reflection after
    // the setters above (which in turn require an unsealed node).
    android.view.accessibility.AccessibilityNodeInfo::class
      .java
      .getMethod("setSealed", Boolean::class.javaPrimitiveType)
      .invoke(node, true)
    return node
  }

  private fun fakeWindow(
    id: Int,
    layer: Int,
    root: android.view.accessibility.AccessibilityNodeInfo?,
    type: Int = AccessibilityWindowInfo.TYPE_APPLICATION,
    focused: Boolean = false,
    active: Boolean = false,
    bounds: Rect? = null,
    title: CharSequence? = null,
  ): AccessibilityWindowInfo {
    val window = AccessibilityWindowInfo.obtain()
    val shadow = org.robolectric.Shadows.shadowOf(window)
    title?.let { shadow.setTitle(it) }
    shadow.setId(id)
    shadow.setLayer(layer)
    shadow.setType(type)
    shadow.setRoot(root)
    shadow.setFocused(focused)
    shadow.setActive(active)
    shadow.setBoundsInScreen(
      bounds ?: Rect(0, 0, 1080, if (type == AccessibilityWindowInfo.TYPE_SYSTEM) 63 else 2400),
    )
    return window
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
    // occlusion and should not trigger the IME primary-window remap. The IME owns focus here
    // (the keyboard-showing shape), so the no-focus-anywhere rule (#6151) does not apply either.
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
          isFocused = true,
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
        listOf(firstWindow, duplicateWindow, secondWindow),
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
    element: UIElementInfo,
  ): List<UIElementInfo> = this.visibleChildren(element)

  @Suppress("UNCHECKED_CAST")
  private fun ViewHierarchyExtractor.optimizeHierarchyForTest(
    element: UIElementInfo,
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
    windowBounds: ElementBounds? = null,
    isOwnInteractiveOverlay: Boolean = false,
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
        ElementBounds::class.java,
        Boolean::class.javaPrimitiveType,
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
      windowBounds,
      isOwnInteractiveOverlay,
    )
  }

  private fun ViewHierarchyExtractor.buildOcclusionInfoForTest(
    windowEntries: List<Any>,
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
    elements: List<UIElementInfo>,
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
