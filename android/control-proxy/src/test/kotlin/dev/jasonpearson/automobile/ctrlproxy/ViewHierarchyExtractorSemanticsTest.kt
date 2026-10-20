package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.text.SpannableString
import android.text.style.ClickableSpan
import android.view.View
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.SemanticLink
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorSemanticsTest : ViewHierarchyExtractorFixtures() {

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

      val result =
        extractor.extractFromActiveWindow(
          node,
          options = HierarchyExtractionOptions(disableAllFiltering = true),
        )
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
}
