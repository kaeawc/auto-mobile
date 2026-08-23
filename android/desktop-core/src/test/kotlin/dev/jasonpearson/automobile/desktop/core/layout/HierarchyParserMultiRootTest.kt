package dev.jasonpearson.automobile.desktop.core.layout

import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import org.junit.Test

/**
 * Multi-root coverage for [parseHierarchyFromJson] (issue #4874).
 *
 * Android captures often carry several top-level windows in a single frame (app + IME + System UI).
 * The parser's array branch previously kept only `firstOrNull()`, silently dropping every window
 * after the first — which made a two-device compare over such a frame omit all but the primary
 * window and could show a false "Hierarchies match". The fix wraps 2+ roots under a synthetic root
 * so the tree/diff covers every window, while a single-root frame is returned unwrapped
 * (unchanged).
 */
class HierarchyParserMultiRootTest {

  private fun parse(hierarchyJson: String): ParsedHierarchy {
    val parsed = parseHierarchyFromJson(Json.parseToJsonElement(hierarchyJson))
    return assertNotNull(parsed, "hierarchy should parse")
  }

  @Test
  fun `parses all top-level windows, not just the first`() {
    val json =
      """
      { "hierarchy": { "node": [
        { "className": "android.widget.FrameLayout", "resource-id": "app.window",
          "bounds": { "left": 0, "top": 0, "right": 1080, "bottom": 2000 } },
        { "className": "android.inputmethodservice.SoftInputWindow", "resource-id": "ime.window",
          "bounds": { "left": 0, "top": 1400, "right": 1080, "bottom": 2400 } },
        { "className": "com.android.systemui.StatusBar", "resource-id": "sysui.window",
          "bounds": { "left": 0, "top": 0, "right": 1080, "bottom": 63 } }
      ] } }
      """
    val root = parse(json).root

    val classNames = root.children.map { it.className }
    assertEquals(
      listOf(
        "android.widget.FrameLayout",
        "android.inputmethodservice.SoftInputWindow",
        "com.android.systemui.StatusBar",
      ),
      classNames,
      "every top-level window must survive parsing",
    )
  }

  @Test
  fun `synthetic root spans the union of every window's bounds`() {
    val json =
      """
      { "hierarchy": { "node": [
        { "className": "app", "resource-id": "a",
          "bounds": { "left": 10, "top": 20, "right": 500, "bottom": 900 } },
        { "className": "ime", "resource-id": "b",
          "bounds": { "left": 0, "top": 1400, "right": 1080, "bottom": 2400 } }
      ] } }
      """
    val root = parse(json).root
    assertEquals(ElementBounds(left = 0, top = 20, right = 1080, bottom = 2400), root.bounds)
  }

  @Test
  fun `synthetic root and its windows are indexed for lookup and parent traversal`() {
    val json =
      """
      { "hierarchy": { "node": [
        { "className": "app", "resource-id": "a", "bounds": { "left": 0, "top": 0, "right": 10, "bottom": 10 } },
        { "className": "ime", "resource-id": "b", "bounds": { "left": 0, "top": 0, "right": 10, "bottom": 10 } }
      ] } }
      """
    val parsed = parse(json)
    val root = parsed.root

    // The synthetic root and both windows are in the element map.
    assertNotNull(parsed.elementMap[root.id], "synthetic root must be indexed")
    for (window in root.children) {
      assertEquals(window, parsed.elementMap[window.id], "each window must be indexed")
      assertEquals(
        root.id,
        parsed.parentMap[window.id],
        "each window's parent must be the synthetic root",
      )
    }
    // The synthetic root itself has no parent.
    assertNull(parsed.parentMap[root.id], "synthetic root has no parent")
  }

  @Test
  fun `windows under the synthetic root sit one level deeper`() {
    val json =
      """
      { "hierarchy": { "node": [
        { "className": "app", "resource-id": "a", "bounds": { "left": 0, "top": 0, "right": 10, "bottom": 10 } },
        { "className": "ime", "resource-id": "b", "bounds": { "left": 0, "top": 0, "right": 10, "bottom": 10 } }
      ] } }
      """
    val root = parse(json).root
    assertEquals(0, root.depth, "synthetic root is at depth 0")
    assertTrue(
      root.children.all { it.depth == 1 },
      "windows sit at depth 1 under the synthetic root",
    )
  }

  @Test
  fun `single-window frame is returned unwrapped`() {
    val json =
      """
      { "hierarchy": { "node": {
        "className": "android.widget.FrameLayout", "resource-id": "only.window",
        "bounds": { "left": 0, "top": 0, "right": 1080, "bottom": 2400 }
      } } }
      """
    val root = parse(json).root
    // No synthetic wrapper: the real window is the root.
    assertEquals("android.widget.FrameLayout", root.className)
    assertEquals(0, root.depth)
  }

  @Test
  fun `single-element array is returned unwrapped`() {
    val json =
      """
      { "hierarchy": { "node": [
        { "className": "android.widget.FrameLayout", "resource-id": "only.window",
          "bounds": { "left": 0, "top": 0, "right": 1080, "bottom": 2400 } }
      ] } }
      """
    val root = parse(json).root
    assertEquals("android.widget.FrameLayout", root.className)
    assertEquals(0, root.depth)
  }
}
