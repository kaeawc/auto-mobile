package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    // pair (android.widget.* vs the iOS runner's UIKit names) would produce.
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

  /** A synthetic multi-window root as [parseHierarchyFromJson] emits for a 2+ window frame. */
  private fun multiWindowRoot(vararg windows: UIElementInfo): UIElementInfo =
    node(MULTI_WINDOW_ROOT_CLASS_NAME, "multiwindow", children = windows.toList())

  @Test
  fun `wrapped multi-window frame diffed against a single-window frame isolates the extra window`() {
    // A carries an extra IME window, so the parser wraps it under the synthetic root; B is a plain
    // single-window frame. The synthetic wrapper must be transparent: the shared app window matches
    // and only the extra IME window surfaces as OnlyInA — not the whole app as OnlyInA/OnlyInB.
    val appSubtree =
      node(
        "app.Window",
        "app",
        children = listOf(node("android.widget.TextView", "title", text = "Hi")),
      )
    val a = multiWindowRoot(appSubtree, node("ime.Window", "ime"))
    val b =
      node(
        "app.Window",
        "app",
        children = listOf(node("android.widget.TextView", "title", text = "Hi")),
      )

    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "app.Window:app"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "TextView:title"))
    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "ime.Window:ime"))
    assertEquals(1, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    // The synthetic wrapper never appears as a diff entry on either side.
    assertNull(statusOf(diff, MULTI_WINDOW_ROOT_CLASS_NAME))
  }

  @Test
  fun `two identical wrapped multi-window frames report no differences`() {
    val a = multiWindowRoot(node("app.Window", "app"), node("ime.Window", "ime"))
    val b = multiWindowRoot(node("app.Window", "app"), node("ime.Window", "ime"))

    val diff = diffHierarchies(a, b)

    assertFalse(diff.hasDifferences)
    // Both windows match; the synthetic wrapper is transparent so it is not counted.
    assertEquals(2, diff.equal)
    assertNull(statusOf(diff, MULTI_WINDOW_ROOT_CLASS_NAME))
  }

  // --- Multi-window pairing by subtree similarity (issue #5533) ----------------------------------
  //
  // The `text-input-empty.json` / `scroll-before.json` fixtures are a 3-window frame and the same
  // frame with the *middle* window removed. Positional (by-index) pairing shifts the surviving
  // third window into the second slot, so both survivors surface as removed+added. Order-preserving
  // similarity matching must instead pair the two survivors and report only the removed window.

  private fun windowA() =
    node(
      "app.Window",
      "app",
      children = listOf(node("android.widget.TextView", "title", text = "Home")),
    )

  private fun windowB() =
    node(
      "dialog.Window",
      "dialog",
      children = listOf(node("android.widget.Button", "ok", text = "OK")),
    )

  private fun windowC() =
    node(
      "ime.Window",
      "ime",
      children = listOf(node("android.widget.EditText", "field", text = "abc")),
    )

  @Test
  fun `middle window removed pairs the surviving windows and surfaces only the removed one`() {
    // A has three windows [app, dialog, ime]; B is the same frame with the middle (dialog) removed.
    val a = multiWindowRoot(windowA(), windowB(), windowC())
    val b = multiWindowRoot(windowA(), windowC())

    val diff = diffHierarchies(a, b)

    // The two survivors pair as Equal despite the index shift of the third window...
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "app.Window:app"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "EditText:field"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "ime.Window:ime"))
    // ...and only the genuinely-removed middle window (and its subtree) surfaces as OnlyInA.
    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "dialog.Window:dialog"))
    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "Button:ok"))
    assertEquals(2, diff.onlyInA) // dialog window + its button
    assertEquals(0, diff.onlyInB)
    assertNull(statusOf(diff, MULTI_WINDOW_ROOT_CLASS_NAME))
  }

  @Test
  fun `inserted middle window is the mirror of a removed one`() {
    // Symmetric to the removal case: inserting a window before another must surface only the
    // inserted window as OnlyInB, not both survivors.
    val a = multiWindowRoot(windowA(), windowC())
    val b = multiWindowRoot(windowA(), windowB(), windowC())

    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "app.Window:app"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "ime.Window:ime"))
    assertEquals(NodeDiffStatus.OnlyInB, statusOf(diff, "dialog.Window:dialog"))
    assertEquals(0, diff.onlyInA)
    assertEquals(2, diff.onlyInB)
  }

  @Test
  fun `multi-window removal classification is symmetric when A and B are swapped`() {
    val a = multiWindowRoot(windowA(), windowB(), windowC())
    val b = multiWindowRoot(windowA(), windowC())
    val ab = diffHierarchies(a, b)
    val ba = diffHierarchies(b, a)

    fun keys(diff: HierarchyDiff, status: NodeDiffStatus) =
      diff.entries.filter { it.status == status }.map { it.key }.toSet()

    // The removed window's keys are identical strings in both directions (same window slot), just
    // labeled OnlyInA one way and OnlyInB the other — the symmetry contract of diffHierarchies.
    assertEquals(keys(ab, NodeDiffStatus.OnlyInA), keys(ba, NodeDiffStatus.OnlyInB))
    assertEquals(keys(ab, NodeDiffStatus.OnlyInB), keys(ba, NodeDiffStatus.OnlyInA))
    assertEquals(keys(ab, NodeDiffStatus.Equal), keys(ba, NodeDiffStatus.Equal))
  }

  @Test
  fun `z-order-reversed windows classify symmetrically under A and B swap`() {
    // Two windows that swap z-order: the similarity matrix is [[0,1],[1,0]] with two equally
    // optimal order-preserving alignments. The tie-break must pick by window content, not by side,
    // so diffHierarchies(a, b) and diffHierarchies(b, a) agree once A/B roles are swapped.
    val a = multiWindowRoot(windowA(), windowC())
    val b = multiWindowRoot(windowC(), windowA())
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
  fun `structurally identical windows differing in content pair the semantic survivor`() {
    // A holds two dialogs with identical structure but different text; B keeps only the first.
    // Structural similarity alone is 1 for every pairing, so a diagonal-on-tie would pair B with
    // A's *second* dialog and report Changed. Semantic-aware similarity must pair the true survivor
    // (Equal) and surface the removed dialog (OnlyInA).
    val dialog = { t: String ->
      node("dialog.Window", "dialog", children = listOf(node("TextView", "msg", text = t)))
    }
    val a = multiWindowRoot(dialog("kept"), dialog("removed"))
    val b = multiWindowRoot(dialog("kept"))

    val diff = diffHierarchies(a, b)

    // The surviving "kept" dialog pairs as Equal, not Changed against the "removed" one.
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "TextView:msg"))
    assertEquals(0, diff.changed)
    // The removed dialog window and its text node surface as OnlyInA.
    assertEquals(2, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
  }

  @Test
  fun `parallel multi-window stacks still pair positionally by highest similarity`() {
    // Two devices, same two-window stack, differing only in a text value on the first window: the
    // diagonal alignment wins, so windows pair by position and just the changed node is Changed.
    val a =
      multiWindowRoot(
        node(
          "app.Window",
          "app",
          children = listOf(node("android.widget.TextView", "title", text = "Home")),
        ),
        node("ime.Window", "ime"),
      )
    val b =
      multiWindowRoot(
        node(
          "app.Window",
          "app",
          children = listOf(node("android.widget.TextView", "title", text = "Away")),
        ),
        node("ime.Window", "ime"),
      )

    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "TextView:title"))
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
  }

  // --- Cross-platform structural-role keying (issue #4872) ---

  /** An Android screen: content frame → list → [title label, action button]. */
  private fun androidScreen(title: String, action: String): UIElementInfo =
    node(
      "android.widget.FrameLayout",
      "android:id/content",
      children =
        listOf(
          node(
            "androidx.recyclerview.widget.RecyclerView",
            "com.app:id/list",
            children =
              listOf(
                node("android.widget.TextView", "com.app:id/title", text = title),
                node("androidx.appcompat.widget.AppCompatButton", "com.app:id/cta", text = action),
              ),
          )
        ),
    )

  /**
   * The iOS rendering of the same screen: application → table → [static text, button]. Uses the
   * UIKit class names the runner actually reports (`ElementLocator.mapElementType`), not the
   * fabricated `XCUIElementType*` forms, so the cross-platform role diff is exercised on the live
   * vocabulary.
   */
  private fun iosScreen(title: String, action: String): UIElementInfo =
    node(
      "XCUIApplication",
      children =
        listOf(
          node(
            "UITableView",
            children = listOf(node("UILabel", text = title), node("UIButton", text = action)),
          )
        ),
    )

  @Test
  fun `class-name mode makes a cross-platform pair a meaningless all-OnlyIn diff`() {
    val diff = diffHierarchies(androidScreen("Inbox", "Compose"), iosScreen("Inbox", "Compose"))

    // Disjoint class names: every Android node is OnlyInA and every iOS node is OnlyInB, with no
    // Equal/Changed — the very failure #4872 describes.
    assertEquals(4, diff.onlyInA)
    assertEquals(4, diff.onlyInB)
    assertEquals(0, diff.equal)
    assertEquals(0, diff.changed)
  }

  @Test
  fun `role mode pairs a structurally-equal cross-platform screen as all-equal`() {
    val diff =
      diffHierarchies(
        androidScreen("Inbox", "Compose"),
        iosScreen("Inbox", "Compose"),
        DiffKeyMode.StructuralRole,
      )

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(4, diff.equal)
    assertFalse(diff.hasDifferences)
    // Keys are keyed by role, not raw class.
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Button#"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "List#"))
  }

  @Test
  fun `role mode reports a differing label as Changed, not OnlyIn`() {
    val diff =
      diffHierarchies(
        androidScreen("Inbox", "Compose"),
        iosScreen("Sent", "Compose"),
        DiffKeyMode.StructuralRole,
      )

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Text#"))
    assertEquals(1, diff.changed)
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(3, diff.equal)
  }

  @Test
  fun `role mode isolates a genuinely-extra node as OnlyIn`() {
    // The Android side has an extra image trailing the button; the rest still pairs by role.
    val android =
      node(
        "android.widget.FrameLayout",
        "android:id/content",
        children =
          listOf(
            node("android.widget.TextView", "com.app:id/title", text = "Inbox"),
            node("android.widget.ImageView", "com.app:id/avatar"),
          ),
      )
    val ios = node("XCUIApplication", children = listOf(node("UILabel", text = "Inbox")))

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "Image#"))
    assertEquals(1, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
  }

  @Test
  fun `role mode is symmetric under A-B swap`() {
    val android = androidScreen("Inbox", "Compose")
    val ios = iosScreen("Sent", "Compose")

    val forward = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)
    val backward = diffHierarchies(ios, android, DiffKeyMode.StructuralRole)

    assertEquals(forward.onlyInA, backward.onlyInB)
    assertEquals(forward.onlyInB, backward.onlyInA)
    assertEquals(forward.changed, backward.changed)
    assertEquals(forward.equal, backward.equal)
  }
}
