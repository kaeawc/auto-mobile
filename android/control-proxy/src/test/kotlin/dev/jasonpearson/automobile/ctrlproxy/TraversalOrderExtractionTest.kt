package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows

@RunWith(RobolectricTestRunner::class)
class TraversalOrderExtractionTest {
  private val extractor = ViewHierarchyExtractor()
  private val json = Json { encodeDefaults = true }

  @Test
  fun `both entry points report dropped children without changing the cap`() {
    val single = extractor.extractTraversalOrderFromActiveWindow(traversalTree(300))
    val all =
      extractor.extractTraversalOrderFromAllWindows(
        listOf(window(0, traversalTree(300))),
        null,
      )

    for (result in listOf(single, all)) {
      assertEquals(256, result.elements.size)
      assertEquals(256, result.totalCount)
      assertEquals("Child 0", result.elements.first().text)
      assertEquals("Child 255", result.elements.last().text)
      assertEquals(listOf("max_children"), result.truncationReasons)
      assertEquals("[\"max_children\"]", encoded(result)["truncationReasons"].toString())
    }
  }

  @Test
  fun `all windows de-duplicates dropped-child reasons`() {
    val result =
      extractor.extractTraversalOrderFromAllWindows(
        listOf(window(0, traversalTree(300)), window(1, traversalTree(300))),
        null,
      )

    assertEquals(512, result.elements.size)
    assertEquals(listOf("max_children"), result.truncationReasons)
    assertEquals("[\"max_children\"]", encoded(result)["truncationReasons"].toString())
  }

  @Test
  fun `both entry points omit truncation reasons at or below the cap`() {
    for (childCount in listOf(0, 255, 256)) {
      val single = extractor.extractTraversalOrderFromActiveWindow(traversalTree(childCount))
      val all =
        extractor.extractTraversalOrderFromAllWindows(
          listOf(window(0, traversalTree(childCount))),
          null,
        )

      for (result in listOf(single, all)) {
        assertEquals(childCount, result.elements.size)
        assertNull(result.truncationReasons)
        assertFalse(encoded(result).containsKey("truncationReasons"))
      }
    }
  }

  @Test
  fun `empty entry points omit truncation metadata`() {
    assertFalse(
      encoded(extractor.extractTraversalOrderFromActiveWindow(null))
        .containsKey("truncationReasons")
    )
    assertFalse(
      encoded(extractor.extractTraversalOrderFromAllWindows(emptyList(), null))
        .containsKey("truncationReasons")
    )
  }

  private fun encoded(result: TraversalOrderResult): JsonObject =
    json.encodeToJsonElement(TraversalOrderResult.serializer(), result) as JsonObject

  private fun traversalTree(childCount: Int): AccessibilityNodeInfo =
    node(children = List(childCount) { node(text = "Child $it") })

  private fun node(
    text: String? = null,
    children: List<AccessibilityNodeInfo> = emptyList(),
  ): AccessibilityNodeInfo {
    val node = AccessibilityNodeInfo.obtain()
    node.setBoundsInScreen(Rect(0, 0, 100, 100))
    node.text = text
    if (text != null) {
      node.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_ACCESSIBILITY_FOCUS)
    }
    for (child in children) {
      Shadows.shadowOf(node).addChild(child)
    }
    // Match service-delivered nodes, as in ViewHierarchyExtractorTest's fakeNode helper.
    AccessibilityNodeInfo::class
      .java
      .getMethod("setSealed", Boolean::class.javaPrimitiveType)
      .invoke(node, true)
    return node
  }

  private fun window(layer: Int, root: AccessibilityNodeInfo): AccessibilityWindowInfo {
    val window = AccessibilityWindowInfo.obtain()
    Shadows.shadowOf(window).setLayer(layer)
    Shadows.shadowOf(window).setRoot(root)
    return window
  }
}
