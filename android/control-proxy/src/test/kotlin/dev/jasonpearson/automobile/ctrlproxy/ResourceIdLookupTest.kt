package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class ResourceIdLookupTest {
  private val screen = ScreenDimensions(100, 200)
  private val onScreen = Rect(10, 20, 40, 60)
  private val offScreen = Rect(10, 201, 40, 240)

  @Before
  fun warmFramework() {
    // Keep Robolectric's initial framework setup outside the per-test timing budget.
    node("warm", "warm").recycle()
  }

  @Test
  fun `on-screen duplicate wins over first off-screen match`() {
    val first = node("first", "row", offScreen)
    val visible = node("visible", "row")
    assertSelected("visible", node("root", children = listOf(first, visible)))
  }

  @Test
  fun `only off-screen duplicates return the first match`() {
    val first = node("first", "row", offScreen)
    val second = node("second", "row", Rect(-50, 20, -1, 60))
    assertSelected("first", node("root", children = listOf(first, second)))
  }

  @Test
  fun `single on-screen match is unchanged`() {
    val match = node("single", "row")
    assertSelected("single", node("root", children = listOf(match)))
  }

  @Test
  fun `single off-screen match is unchanged`() {
    val match = node("single", "row", offScreen)
    assertSelected("single", node("root", children = listOf(match)))
  }

  @Test
  fun `unavailable dimensions preserve first match`() {
    assertFirstMatch(null)
  }

  @Test
  fun `invalid dimensions preserve first match`() {
    for (dimensions in listOf(ScreenDimensions(0, 200), ScreenDimensions(100, -1))) {
      assertFirstMatch(dimensions)
    }
  }

  @Test
  fun `short id suffix selects nested on-screen duplicate in depth-first order`() {
    val first = node("first", "example:id/row", offScreen)
    val nested = node("nested", "example:id/row")
    val parent = node("parent", children = listOf(nested))
    val later = node("later", "other:id/row")
    assertSelected("nested", node("root", children = listOf(first, parent, later)))
  }

  @Test
  fun `off-screen fallback preserves nested depth-first order`() {
    val nested = node("nested", "example:id/row", offScreen)
    val parent = node("parent", children = listOf(nested))
    val later = node("later", "example:id/row", offScreen)
    assertSelected("nested", node("root", children = listOf(parent, later)))
  }

  @Test
  fun `full id exact match prefers on-screen duplicate`() {
    val first = node("first", "example:id/row", offScreen)
    val visible = node("visible", "example:id/row")
    assertSelected("visible", node("root", children = listOf(first, visible)), "example:id/row")
  }

  @Test
  fun `visibility flag does not exclude an on-screen match`() {
    val first = node("first", "row", offScreen)
    val visible = node("visible", "row", visibleToUser = false)
    assertSelected("visible", node("root", children = listOf(first, visible)))
  }

  @Test
  fun `partially on-screen and edge-touching bounds follow extractor rule`() {
    for (bounds in listOf(Rect(-20, 20, 10, 60), Rect(100, 20, 120, 60))) {
      val first = node("first", "row", offScreen)
      val visible = node("visible", "row", bounds)
      assertSelected("visible", node("root", children = listOf(first, visible)))
    }
  }

  @Test
  fun `off-screen matching root does not hide on-screen descendant`() {
    val visible = node("visible", "row")
    assertSelected("visible", node("root", "row", offScreen, listOf(visible)))
  }

  @Test
  fun `returned root is the original caller-owned node`() {
    for (bounds in listOf(onScreen, offScreen)) {
      val root = node("root", "row", bounds)
      try {
        assertSame(root, findNodeByResourceId(root, "row", screen))
      } finally {
        root.recycle()
      }
    }
  }

  @Test
  fun `null root and missing id return null`() {
    assertNull(findNodeByResourceId(null, "row", screen))
    val root = node("root", children = listOf(node("different", "other")))
    try {
      assertNull(findNodeByResourceId(root, "row", screen))
    } finally {
      root.recycle()
    }
  }

  private fun assertFirstMatch(dimensions: ScreenDimensions?) {
    val first = node("first", "row", offScreen)
    val visible = node("visible", "row")
    assertSelected(
      "first",
      node("root", children = listOf(first, visible)),
      dimensions = dimensions,
    )
  }

  @Test
  @Config(sdk = [30])
  fun `throwing dimension provider preserves first match`() {
    assertProviderSelected("first") { throw IllegalStateException("dimensions unavailable") }
  }

  @Test
  @Config(sdk = [30])
  fun `null dimension provider preserves first match`() {
    assertProviderSelected("first") { null }
  }

  @Test
  @Config(sdk = [30])
  fun `provider receives root display and prefers on-screen duplicate`() {
    assertProviderSelected("visible") { displayId ->
      assertEquals(7, displayId)
      screen
    }
  }

  @Test
  @Config(sdk = [30])
  fun `unknown root window skips provider and preserves first match`() {
    assertProviderSelected("first", attachWindow = false) {
      throw AssertionError("unknown display must not invoke provider")
    }
  }

  @Test
  @Config(sdk = [30])
  fun `null root skips dimension provider`() {
    assertNull(
      findNodeByResourceIdOnRootDisplay(null, "row") {
        throw AssertionError("null root must not invoke provider")
      }
    )
  }

  @Test
  @Config(sdk = [29])
  fun `pre-R root uses default display without a window`() {
    assertProviderSelected("visible", attachWindow = false) { displayId ->
      assertEquals(Display.DEFAULT_DISPLAY, displayId)
      screen
    }
  }

  private fun assertProviderSelected(
    expected: String,
    attachWindow: Boolean = true,
    provider: (Int) -> ScreenDimensions?,
  ) {
    val root =
      node("root", children = listOf(node("first", "row", offScreen), node("visible", "row")))
    if (attachWindow) {
      // The lookup helper owns recycling the window returned by root.window.
      AccessibilityWindowInfo.obtain().also {
        shadowOf(it).setDisplayId(7)
        shadowOf(root).setAccessibilityWindowInfo(it)
      }
    }
    var selected: AccessibilityNodeInfo? = null
    var providerCalls = 0
    try {
      selected =
        findNodeByResourceIdOnRootDisplay(root, "row") {
          providerCalls++
          provider(it)
        }
      assertEquals(expected, selected?.text?.toString())
      assertEquals(
        if (attachWindow || android.os.Build.VERSION.SDK_INT < 30) 1 else 0,
        providerCalls,
      )
    } finally {
      if (selected !== root) selected?.recycle()
      root.recycle()
    }
  }

  private fun assertSelected(
    expected: String,
    root: AccessibilityNodeInfo,
    resourceId: String = "row",
    dimensions: ScreenDimensions? = screen,
  ) {
    val selected = findNodeByResourceId(root, resourceId, dimensions)
    try {
      assertEquals(expected, selected?.text?.toString())
    } finally {
      if (selected !== root) selected?.recycle()
      root.recycle()
    }
  }

  private fun node(
    label: String,
    resourceId: String? = null,
    bounds: Rect = onScreen,
    children: List<AccessibilityNodeInfo> = emptyList(),
    visibleToUser: Boolean = true,
  ): AccessibilityNodeInfo {
    val node = AccessibilityNodeInfo.obtain()
    node.text = label
    node.viewIdResourceName = resourceId
    node.setBoundsInScreen(bounds)
    node.isVisibleToUser = visibleToUser
    for (child in children) shadowOf(node).addChild(child)
    // Match the service-delivered nodes used by the hierarchy extractor's existing fakes.
    AccessibilityNodeInfo::class
      .java
      .getMethod("setSealed", Boolean::class.javaPrimitiveType)
      .invoke(node, true)
    return node
  }
}
