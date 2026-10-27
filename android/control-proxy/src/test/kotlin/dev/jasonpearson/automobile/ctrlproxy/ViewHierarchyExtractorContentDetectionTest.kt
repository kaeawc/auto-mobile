package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorContentDetectionTest : ViewHierarchyExtractorFixtures() {

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
  fun `detectContentHiddenRegions finds large empty non-interactive Compose descendant with sparse child coverage`() {
    val visibleToolbar =
      elementWithBounds(resourceId = "com.slack:id/top_bar", bounds = bounds(0, 290, 1440, 458))
    val hiddenBoundary =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        children = listOf(visibleToolbar),
        content = ElementContent(actions = listOf("accessibility_focus")),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(hiddenBoundary),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
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
        content = ElementContent(text = "general"),
      )
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        children = listOf(textChild),
        content = ElementContent(actions = listOf("accessibility_focus")),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
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
        content = ElementContent(contentDesc = "Open navigation drawer"),
      )
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        children = listOf(iconButton),
        content = ElementContent(actions = listOf("accessibility_focus")),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
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
        content = ElementContent(text = "Visible conversation content"),
      )
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        children = listOf(visibleContent),
        content = ElementContent(actions = listOf("accessibility_focus")),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions ignores large Compose descendants with text on candidate boundary`() {
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        content =
          ElementContent(text = "Conversation list", actions = listOf("accessibility_focus")),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions ignores large Compose descendants with content description on candidate boundary`() {
    val contentRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        content =
          ElementContent(
            contentDesc = "Conversation list",
            actions = listOf("accessibility_focus"),
          ),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(contentRegion),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
      )

    val regions = extractor.detectContentHiddenRegionsForTest(composeRoot, 1440, 3000)

    assertTrue(regions.isEmpty())
  }

  @Test
  fun `detectContentHiddenRegions ignores interactive Compose descendants`() {
    val interactiveRegion =
      elementWithBounds(
        bounds = bounds(0, 368, 1440, 2752),
        content = ElementContent(actions = listOf("click")),
      )
    val composeRoot =
      elementWithBounds(
        bounds = bounds(0, 0, 1440, 3000),
        children = listOf(interactiveRegion),
        content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
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

  private fun composeRootWithHiddenBoundary(boundaryBounds: ElementBounds): UIElementInfo {
    val hiddenBoundary =
      elementWithBounds(
        bounds = boundaryBounds,
        content = ElementContent(actions = listOf("accessibility_focus")),
      )
    return elementWithBounds(
      bounds = bounds(0, 0, 1440, 3000),
      children = listOf(hiddenBoundary),
      content = ElementContent(className = "androidx.compose.ui.platform.ComposeView"),
    )
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
    return (method.invoke(this, element, screenWidth, screenHeight) as List<*>).map {
      it as dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion
    }
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
    return (method.invoke(this, elements, null) as List<*>?)?.map {
      it as dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion
    }
  }
}
