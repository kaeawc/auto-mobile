package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure, fast tests for the structural hierarchy diff. No Compose, no I/O. */
class HierarchyDiffTest {

  private fun node(
    className: String,
    resourceId: String? = null,
    text: String? = null,
    contentDescription: String? = null,
    bounds: ElementBounds = ElementBounds(0, 0, 10, 10),
    isClickable: Boolean = false,
    isChecked: Boolean = false,
    children: List<UIElementInfo> = emptyList(),
  ): UIElementInfo =
    UIElementInfo(
      id = "$className:${resourceId ?: ""}:${text ?: ""}",
      className = className,
      resourceId = resourceId,
      text = text,
      contentDescription = contentDescription,
      bounds = bounds,
      isClickable = isClickable,
      isEnabled = true,
      isFocused = false,
      isSelected = false,
      isScrollable = false,
      isCheckable = false,
      isChecked = isChecked,
      children = children,
      depth = 0,
    )

  private fun statusOf(diff: HierarchyDiff, keySubstring: String): NodeDiffStatus? =
    diff.entries.firstOrNull { it.key.contains(keySubstring) }?.status

  @Test
  fun `identical trees are all equal`() {
    val tree = node("Root", "root", children = listOf(node("Text", "title", text = "Hello")))
    val diff = diffHierarchies(tree, tree)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(2, diff.equal)
    assertFalse(diff.hasDifferences)
  }

  @Test
  fun `node present only in A is classified OnlyInA`() {
    val a =
      node(
        "Root",
        "root",
        children = listOf(node("Text", "title", text = "Hi"), node("Button", "extra")),
      )
    val b = node("Root", "root", children = listOf(node("Text", "title", text = "Hi")))
    val diff = diffHierarchies(a, b)

    assertEquals(1, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "Button:extra"))
    assertTrue(diff.hasDifferences)
  }

  @Test
  fun `node present only in B is classified OnlyInB`() {
    val a = node("Root", "root", children = listOf(node("Text", "title", text = "Hi")))
    val b =
      node(
        "Root",
        "root",
        children = listOf(node("Text", "title", text = "Hi"), node("Button", "extra")),
      )
    val diff = diffHierarchies(a, b)

    assertEquals(0, diff.onlyInA)
    assertEquals(1, diff.onlyInB)
    assertEquals(NodeDiffStatus.OnlyInB, statusOf(diff, "Button:extra"))
  }

  @Test
  fun `same-position node with changed text is Changed`() {
    val a = node("Root", "root", children = listOf(node("Text", "title", text = "Hi")))
    val b = node("Root", "root", children = listOf(node("Text", "title", text = "Bye")))
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Text:title"))
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(1, diff.changed)
  }

  @Test
  fun `changed boolean state flag is Changed`() {
    val a = node("Root", "root", children = listOf(node("Box", "toggle", isChecked = false)))
    val b = node("Root", "root", children = listOf(node("Box", "toggle", isChecked = true)))
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Box:toggle"))
  }

  @Test
  fun `differing bounds alone do not mark a node Changed`() {
    // Two devices with different resolutions: geometry differs but structure and semantics match.
    val a = node("Root", "root", bounds = ElementBounds(0, 0, 1080, 1920))
    val b = node("Root", "root", bounds = ElementBounds(0, 0, 1440, 3120))
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Root:root"))
    assertFalse(diff.hasDifferences)
  }

  @Test
  fun `reordered siblings surface positionally as OnlyInA and OnlyInB`() {
    val a = node("Root", "root", children = listOf(node("A", "a"), node("B", "b")))
    val b = node("Root", "root", children = listOf(node("B", "b"), node("A", "a")))
    val diff = diffHierarchies(a, b)

    // Positional identity: A#0 vs B#0 and A#1 vs B#1 differ by className (part of key),
    // so each position has one node only-in-A and one only-in-B. No move detection (deferred).
    assertEquals(2, diff.onlyInA)
    assertEquals(2, diff.onlyInB)
    assertEquals(0, diff.changed)
  }

  @Test
  fun `siblings sharing a resource-id are disambiguated by index`() {
    // RecyclerView-style rows commonly share a resource-id; the index keeps keys unique.
    val row = { t: String -> node("Row", "item", text = t) }
    val a = node("List", "list", children = listOf(row("one"), row("two")))
    val b = node("List", "list", children = listOf(row("one"), row("two")))
    val diff = diffHierarchies(a, b)

    assertEquals(3, diff.equal) // list + 2 rows
    assertEquals(0, diff.changed)
    // Distinct keys for the two same-resource-id rows.
    assertEquals(diff.entries.size, diff.entries.map { it.key }.toSet().size)
  }

  @Test
  fun `classification is symmetric when A and B are swapped`() {
    val a =
      node(
        "Root",
        "root",
        children = listOf(node("Text", "title", text = "Hi"), node("OnlyA", "oa")),
      )
    val b =
      node(
        "Root",
        "root",
        children = listOf(node("Text", "title", text = "Bye"), node("OnlyB", "ob")),
      )
    val ab = diffHierarchies(a, b)
    val ba = diffHierarchies(b, a)

    fun keys(diff: HierarchyDiff, status: NodeDiffStatus) =
      diff.entries.filter { it.status == status }.map { it.key }.toSet()

    assertEquals(keys(ab, NodeDiffStatus.OnlyInA), keys(ba, NodeDiffStatus.OnlyInB))
    assertEquals(keys(ab, NodeDiffStatus.OnlyInB), keys(ba, NodeDiffStatus.OnlyInA))
    assertEquals(keys(ab, NodeDiffStatus.Changed), keys(ba, NodeDiffStatus.Changed))
    assertEquals(keys(ab, NodeDiffStatus.Equal), keys(ba, NodeDiffStatus.Equal))
  }

  @Test
  fun `diff is deterministic across repeated runs`() {
    val a = node("Root", "root", children = listOf(node("A", "a"), node("B", "b"), node("C", "c")))
    val b = node("Root", "root", children = listOf(node("A", "a"), node("C", "c")))

    val first = diffHierarchies(a, b).entries.map { it.key to it.status }
    val second = diffHierarchies(a, b).entries.map { it.key to it.status }
    assertEquals(first, second)
  }

  @Test
  fun `same-platform trees with realistic class names yield a mixed non-disjoint diff`() {
    // Real Android class names on BOTH sides: the shared structure matches by key, so the diff is a
    // meaningful mix of equal/changed/only-in rather than the all-disjoint result a cross-platform
    // pair (android.widget.* vs XCUIElementType*) would produce.
    val a =
      node(
        "android.widget.FrameLayout",
        "content",
        children =
          listOf(
            node("android.widget.TextView", "title", text = "Home"),
            node("android.widget.Button", "submit", isClickable = true),
          ),
      )
    val b =
      node(
        "android.widget.FrameLayout",
        "content",
        children =
          listOf(
            node("android.widget.TextView", "title", text = "Home"), // equal
            node("android.widget.Button", "submit", isClickable = false), // changed flag
            node("android.widget.ProgressBar", "loading"), // only in B
          ),
      )
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "TextView:title"))
    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Button:submit"))
    assertEquals(NodeDiffStatus.OnlyInB, statusOf(diff, "ProgressBar:loading"))
    assertEquals(0, diff.onlyInA)
    // Not all-disjoint: the shared FrameLayout + TextView remain equal.
    assertTrue(diff.equal >= 2)
  }

  @Test
  fun `entries preorder lists A nodes before B-only nodes`() {
    val a = node("Root", "root", children = listOf(node("A", "a")))
    val b = node("Root", "root", children = listOf(node("A", "a"), node("Bonly", "bo")))
    val entries = diffHierarchies(a, b).entries

    // Root, then A (both from A's pre-order), then the B-only node appended last.
    assertEquals(NodeDiffStatus.OnlyInB, entries.last().status)
    assertTrue(entries.last().key.contains("Bonly:bo"))
  }
}
