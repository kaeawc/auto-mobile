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
  fun `identically-shaped descendants in two windows do not collide in the maps`() {
    // Both windows carry a generic child with no preferred id, sharing depth, sibling index, and
    // bounds — the exact shape that generated a colliding element id before per-window namespacing.
    // Each must remain independently resolvable and parented to its own window.
    val json =
      """
      { "hierarchy": { "node": [
        { "className": "app.Window", "resource-id": "app",
          "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 },
          "node": { "className": "android.view.View",
            "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 } } },
        { "className": "overlay.Window", "resource-id": "overlay",
          "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 },
          "node": { "className": "android.view.View",
            "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 } } }
      ] } }
      """
    val parsed = parse(json)
    val (appWindow, overlayWindow) = parsed.root.children
    val appChild = appWindow.children.single()
    val overlayChild = overlayWindow.children.single()

    // Distinct ids and both survive in the element map (no overwrite).
    assertTrue(appChild.id != overlayChild.id, "the two windows' children must have distinct ids")
    assertEquals(appChild, parsed.elementMap[appChild.id], "app window child must be indexed")
    assertEquals(
      overlayChild,
      parsed.elementMap[overlayChild.id],
      "overlay window child must be indexed",
    )
    // Each child's parent traversal resolves to its own window, not the other.
    assertEquals(appWindow.id, parsed.parentMap[appChild.id])
    assertEquals(overlayWindow.id, parsed.parentMap[overlayChild.id])
  }

  @Test
  fun `a surviving window keeps stable ids when a preceding window disappears`() {
    // The window namespace is derived from the window's own identity, not its array position, so a
    // surviving window's descendant ids do not churn when an unrelated window is dropped or the
    // extractor re-sorts windows by z-order (which would otherwise clear a valid Layout Inspector
    // selection and mark the whole subtree as changed).
    val app =
      """{ "className": "app.Window", "resource-id": "app",
           "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 },
           "node": { "className": "android.widget.Button", "resource-id": "submit",
             "bounds": { "left": 10, "top": 10, "right": 90, "bottom": 40 } } }"""
    val ime =
      """{ "className": "ime.Window", "resource-id": "ime",
           "bounds": { "left": 0, "top": 100, "right": 100, "bottom": 200 } }"""
    val sysui =
      """{ "className": "sysui.Window", "resource-id": "sysui",
           "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 20 } }"""

    fun buttonId(frame: ParsedHierarchy): String =
      frame.elementMap.keys.single { it.contains("submit") }

    // Frame 1: [sysui, app, ime] — app is the middle window. Frame 2: sysui gone, still
    // multi-window.
    val before = parse("""{ "hierarchy": { "node": [ $sysui, $app, $ime ] } }""")
    val after = parse("""{ "hierarchy": { "node": [ $app, $ime ] } }""")

    assertEquals(
      buttonId(before),
      buttonId(after),
      "the app window's descendant ids must not churn when an unrelated window disappears",
    )
  }

  @Test
  fun `windows with no resource-id or class keep stable ids when a preceding window disappears`() {
    // The real wire shape: production captures (e.g. test/fixtures/observe/diff/text-input-empty
    // .json, and scroll-before.json which is that frame with the middle window removed) have window
    // roots with no resource-id and no class, distinguished only by their bounds. A node's id must
    // not encode the window's frame position, or a surviving window churns when a preceding one
    // drops. Bounds below mirror those three fixture window roots.
    fun window(top: Int, bottom: Int, childText: String) =
      """{ "bounds": { "left": 0, "top": $top, "right": 1080, "bottom": $bottom },
           "node": { "text": "$childText",
             "bounds": { "left": 10, "top": ${top + 10}, "right": 90, "bottom": ${top + 40} } } }"""
    val topWin = window(0, 2400, "T")
    val midWin = window(63, 2400, "M")
    val bottomWin = window(0, 63, "B")

    fun idContaining(frame: ParsedHierarchy, marker: String): String =
      frame.elementMap.keys.single { it.contains("text:$marker") }

    val before = parse("""{ "hierarchy": { "node": [ $topWin, $midWin, $bottomWin ] } }""")
    val after = parse("""{ "hierarchy": { "node": [ $topWin, $bottomWin ] } }""")

    assertEquals(
      idContaining(before, "B"),
      idContaining(after, "B"),
      "the last window's ids must be stable when the middle window disappears",
    )
    assertEquals(
      idContaining(before, "T"),
      idContaining(after, "T"),
      "the first window's ids stay stable too",
    )
  }

  @Test
  fun `a window keeps stable ids when the multi-window wrapper disappears`() {
    // A 2-window frame (wrapped) becoming a 1-window frame (unwrapped) — e.g. the IME closing. IDs
    // use window-relative depth, so the surviving window's descendant ids are identical whether the
    // window is a wrapped multi-window child (depth offset 1) or the unwrapped single-window root
    // (offset 0), rather than churning because of the extra wrapper level.
    val app =
      """{ "className": "app.Window", "resource-id": "app",
           "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 },
           "node": { "className": "android.widget.Button", "resource-id": "go",
             "bounds": { "left": 10, "top": 10, "right": 90, "bottom": 40 } } }"""
    val ime =
      """{ "className": "ime.Window", "resource-id": "ime",
           "bounds": { "left": 0, "top": 100, "right": 100, "bottom": 200 } }"""

    fun goId(frame: ParsedHierarchy): String = frame.elementMap.keys.single { it.contains("go@") }

    val multi = parse("""{ "hierarchy": { "node": [ $app, $ime ] } }""")
    val single = parse("""{ "hierarchy": { "node": [ $app ] } }""")

    assertEquals(
      goId(multi),
      goId(single),
      "the surviving window's ids must not change when the multi-window wrapper disappears",
    )
  }

  @Test
  fun `different-class identity-less nodes in separate windows keep distinct order-independent ids`() {
    // Two identity-less children (no resource-id/text/content-desc) of different classes sharing
    // depth, sibling index, and bounds. Including className in the id base keeps them distinct
    // without an order-dependent #suffix, so a z-order flip cannot silently reassign one node's id
    // to the other node.
    val buttonWin =
      """{ "className": "a.Window", "resource-id": "a",
           "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 },
           "node": { "className": "android.widget.Button",
             "bounds": { "left": 5, "top": 5, "right": 95, "bottom": 95 } } }"""
    val imageWin =
      """{ "className": "b.Window", "resource-id": "b",
           "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 100 },
           "node": { "className": "android.widget.ImageView",
             "bounds": { "left": 5, "top": 5, "right": 95, "bottom": 95 } } }"""

    fun idFor(frame: ParsedHierarchy, className: String): String =
      frame.elementMap.keys.single { it.contains("$className@") }

    val forward = parse("""{ "hierarchy": { "node": [ $buttonWin, $imageWin ] } }""")
    val flipped = parse("""{ "hierarchy": { "node": [ $imageWin, $buttonWin ] } }""")

    // No collision suffix — the two nodes are distinguished by class, not traversal order.
    assertTrue(
      !idFor(forward, "android.widget.Button").contains("#"),
      "distinct-class nodes must not need a collision suffix",
    )
    assertTrue(!idFor(forward, "android.widget.ImageView").contains("#"), "no collision suffix")
    // A z-order flip does not move an id onto the other node.
    assertEquals(
      idFor(forward, "android.widget.Button"),
      idFor(flipped, "android.widget.Button"),
      "the Button's id must be independent of window order",
    )
    assertEquals(
      idFor(forward, "android.widget.ImageView"),
      idFor(flipped, "android.widget.ImageView"),
      "the ImageView's id must be independent of window order",
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
