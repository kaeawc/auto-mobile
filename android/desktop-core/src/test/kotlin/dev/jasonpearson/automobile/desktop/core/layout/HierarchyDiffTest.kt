package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure, fast tests for the structural hierarchy diff. No Compose, no I/O. */
internal abstract class HierarchyDiffFixture {
  protected data class NodeSpec(
    val className: String,
    val resourceId: String? = null,
    val text: String? = null,
    val contentDescription: String? = null,
    val bounds: ElementBounds = ElementBounds(0, 0, 10, 10),
    val isClickable: Boolean = false,
    val isScrollable: Boolean = false,
    val isCheckable: Boolean = false,
    val isChecked: Boolean = false,
    val children: List<UIElementInfo> = emptyList(),
  )

  protected fun node(spec: NodeSpec): UIElementInfo =
    with(spec) {
      UIElementInfo(
        id = "$className:${resourceId ?: ""}:${text ?: ""}:${contentDescription ?: ""}",
        className = className,
        resourceId = resourceId,
        text = text,
        contentDescription = contentDescription,
        bounds = bounds,
        isClickable = isClickable,
        isEnabled = true,
        isFocused = false,
        isSelected = false,
        isScrollable = isScrollable,
        isCheckable = isCheckable,
        isChecked = isChecked,
        children = children,
        depth = 0,
      )
    }

  protected fun statusOf(diff: HierarchyDiff, keySubstring: String): NodeDiffStatus? =
    diff.entries.firstOrNull { it.key.contains(keySubstring) }?.status

  /** A synthetic multi-window root as [parseHierarchyFromJson] emits for a 2+ window frame. */
  protected fun multiWindowRoot(vararg windows: UIElementInfo): UIElementInfo =
    node(NodeSpec(MULTI_WINDOW_ROOT_CLASS_NAME, "multiwindow", children = windows.toList()))

  // --- Multi-window pairing by subtree similarity (issue #5533) ----------------------------------
  //
  // The `text-input-empty.json` / `scroll-before.json` fixtures are a 3-window frame and the same
  // frame with the *middle* window removed. Positional (by-index) pairing shifts the surviving
  // third window into the second slot, so both survivors surface as removed+added. Order-preserving
  // similarity matching must instead pair the two survivors and report only the removed window.

  protected fun windowA() =
    node(
      NodeSpec(
        "app.Window",
        "app",
        children = listOf(node(NodeSpec("android.widget.TextView", "title", text = "Home"))),
      ),
    )

  protected fun windowB() =
    node(
      NodeSpec(
        "dialog.Window",
        "dialog",
        children = listOf(node(NodeSpec("android.widget.Button", "ok", text = "OK"))),
      ),
    )

  protected fun windowC() =
    node(
      NodeSpec(
        "ime.Window",
        "ime",
        children = listOf(node(NodeSpec("android.widget.EditText", "field", text = "abc"))),
      ),
    )

  // --- Cross-platform structural-role keying (issue #4872) ---

  /** An Android screen: content frame → list → [title label, action button]. */
  protected fun androidScreen(title: String, action: String): UIElementInfo =
    node(
      NodeSpec(
        "android.widget.FrameLayout",
        "android:id/content",
        children =
          listOf(
            node(
              NodeSpec(
                "androidx.recyclerview.widget.RecyclerView",
                "com.app:id/list",
                children =
                  listOf(
                    node(NodeSpec("android.widget.TextView", "com.app:id/title", text = title)),
                    node(
                      NodeSpec(
                        "androidx.appcompat.widget.AppCompatButton",
                        "com.app:id/cta",
                        text = action,
                      ),
                    ),
                  ),
              ),
            ),
          ),
      ),
    )

  /**
   * The iOS rendering of the same screen: application → table → [static text, button]. Uses the
   * UIKit class names the runner actually reports (`ElementLocator.mapElementType`), not the
   * fabricated `XCUIElementType*` forms, so the cross-platform role diff is exercised on the live
   * vocabulary.
   */
  protected fun iosScreen(title: String, action: String): UIElementInfo =
    node(
      NodeSpec(
        "XCUIApplication",
        children =
          listOf(
            node(
              NodeSpec(
                "UITableView",
                children =
                  listOf(
                    node(NodeSpec("UILabel", text = title)),
                    node(NodeSpec("UIButton", text = action)),
                  ),
              ),
            ),
          ),
      ),
    )

  // --- Production-shaped cross-platform pairing (issue #4872 review) ---

  /**
   * The Android compare root as `HierarchyParser` actually produces it: a class-less synthetic
   * wrapper defaulting to `android.view.View`, not the idealized `FrameLayout`. It must pair with
   * the iOS `XCUIApplication` root, or the shared root segment diverges and every descendant key is
   * disjoint — the two live trees would read as wholly OnlyIn.
   */

  /**
   * An icon button carries its label in Android's `content-desc` but in iOS's `text`. Role mode
   * normalizes to a single accessible name, so the equivalent controls read Equal instead of being
   * flagged Changed by a field-by-field text/content-desc comparison.
   */

  /** A genuinely different accessible name is still Changed under the normalized comparison. */

  /**
   * The live iOS runner reports a checkbox as the bare `UIView` class (its `mapElementType` has no
   * `.checkBox` case) while still setting `isCheckable`. Role mode promotes that checkable generic
   * node to Checkbox so it pairs with Android's `CheckBox` instead of surfacing as OnlyIn on each
   * side.
   */

  /**
   * The checkable promotion is gated on generic roles: a `UISwitch` is checkable too but already
   * keys as Switch by class, so it must not be pulled into Checkbox and mis-pair with a checkbox.
   */

  /**
   * Production Android blanks `android.widget.TextView` (it is in the extractor's
   * `GENERIC_CLASS_NAMES`) to a class-less node that `HierarchyParser` defaults to
   * `android.view.View`, so an ordinary label arrives as a generic node — not the idealized
   * `TextView` the earlier tests use. Role mode must still promote a non-interactive text-bearing
   * generic node to Text so it pairs with the iOS `UILabel`; otherwise ubiquitous labels and their
   * subtrees read as OnlyIn (issue #4872 review).
   */

  /**
   * The text promotion is gated on the node being non-interactive: a clickable generic node that
   * carries text is left in its structural Container role on both sides rather than mis-promoted to
   * Text, so an interactive control is never keyed as a static label (issue #4872 review).
   */

  /**
   * Production Android also blanks `android.widget.ScrollView` to `android.view.View`, while
   * retaining its scrollable state. Role mode must recover ScrollView from that state so its
   * subtree aligns with the iOS runner's `UIScrollView` instead of becoming OnlyIn entries.
   */

  /**
   * Android keeps `android.widget.RadioButton` (it is not erased), which contains the `Button`
   * substring, while the iOS runner reports a radio as a checkable generic `UIView`. Role mode
   * folds the Android radio into Checkbox so it pairs with iOS's promoted checkable node instead of
   * surfacing as two OnlyIn entries (issue #4872 review).
   */

  /**
   * A custom Android View subclass (`com.example.ProfileView`) and its whole subtree must pair with
   * the iOS runner's custom `.other -> UIView` container. Without the `*View` container catch-all
   * the Android node keys as Other and the iOS node as Container, making the entire custom subtree
   * disjoint (issue #4872 review).
   */

  /**
   * `android.widget.CheckedTextView` is a standard checkable control, but its class name contains
   * the `TextView` substring so the class mapping keys it as [StructuralRole.Text] — before any
   * generic-role checkable promotion could fire. The iOS runner reports the equivalent checkbox as
   * a checkable bare `UIView -> Container`. Promoting on `isCheckable` regardless of the
   * class-derived role folds the CheckedTextView into Checkbox too, so the two pair instead of
   * surfacing as OnlyIn on each side (issue #4872 review).
   */

  /**
   * A production Android list row is an ordinary `LinearLayout`/`ViewGroup -> Container` whose
   * collection-item metadata `HierarchyParser` drops, while the iOS runner emits the matching row
   * as a `UITableViewCell -> ListItem` by class. Keying the Android row by its class alone would
   * make every row (and its whole subtree) OnlyIn against the iOS cells. Inferring [ListItem] for a
   * generic direct child of a [List] parent pairs the rows so their contents diff (issue #4872
   * review).
   */

  /**
   * The ListItem inference is scoped to a [List] parent: a generic container that is *not* a list
   * row keeps its Container role, so an ordinary nested wrapper is never mis-keyed as a list item.
   */

  /**
   * An Android icon control can carry an empty `text` alongside a real `content-desc`. The
   * normalized accessible name treats empty text as absent and falls back to `content-desc`, so it
   * reads the same as the iOS `text` label instead of comparing `""` against the label and
   * reporting Changed (issue #4872 review).
   */
}

internal class HierarchyDiffTest : HierarchyDiffFixture() {
  @Test
  fun `identical trees are all equal`() {
    val tree =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("Text", "title", text = "Hello"))),
        ),
      )
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
        NodeSpec(
          "Root",
          "root",
          children =
            listOf(node(NodeSpec("Text", "title", text = "Hi")), node(NodeSpec("Button", "extra"))),
        ),
      )
    val b =
      node(
        NodeSpec("Root", "root", children = listOf(node(NodeSpec("Text", "title", text = "Hi")))),
      )
    val diff = diffHierarchies(a, b)

    assertEquals(1, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "Button:extra"))
    assertTrue(diff.hasDifferences)
  }

  @Test
  fun `node present only in B is classified OnlyInB`() {
    val a =
      node(
        NodeSpec("Root", "root", children = listOf(node(NodeSpec("Text", "title", text = "Hi")))),
      )
    val b =
      node(
        NodeSpec(
          "Root",
          "root",
          children =
            listOf(node(NodeSpec("Text", "title", text = "Hi")), node(NodeSpec("Button", "extra"))),
        ),
      )
    val diff = diffHierarchies(a, b)

    assertEquals(0, diff.onlyInA)
    assertEquals(1, diff.onlyInB)
    assertEquals(NodeDiffStatus.OnlyInB, statusOf(diff, "Button:extra"))
  }

  @Test
  fun `same-position node with changed text is Changed`() {
    val a =
      node(
        NodeSpec("Root", "root", children = listOf(node(NodeSpec("Text", "title", text = "Hi")))),
      )
    val b =
      node(
        NodeSpec("Root", "root", children = listOf(node(NodeSpec("Text", "title", text = "Bye")))),
      )
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Text:title"))
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(1, diff.changed)
  }

  @Test
  fun `changed boolean state flag is Changed`() {
    val a =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("Box", "toggle", isChecked = false))),
        ),
      )
    val b =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("Box", "toggle", isChecked = true))),
        ),
      )
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Box:toggle"))
  }

  @Test
  fun `differing bounds alone do not mark a node Changed`() {
    // Two devices with different resolutions: geometry differs but structure and semantics match.
    val a = node(NodeSpec("Root", "root", bounds = ElementBounds(0, 0, 1080, 1920)))
    val b = node(NodeSpec("Root", "root", bounds = ElementBounds(0, 0, 1440, 3120)))
    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Root:root"))
    assertFalse(diff.hasDifferences)
  }

  @Test
  fun `reordered siblings surface positionally as OnlyInA and OnlyInB`() {
    val a =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("A", "a")), node(NodeSpec("B", "b"))),
        ),
      )
    val b =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("B", "b")), node(NodeSpec("A", "a"))),
        ),
      )
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
    val row = { t: String -> node(NodeSpec("Row", "item", text = t)) }
    val a = node(NodeSpec("List", "list", children = listOf(row("one"), row("two"))))
    val b = node(NodeSpec("List", "list", children = listOf(row("one"), row("two"))))
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
        NodeSpec(
          "Root",
          "root",
          children =
            listOf(node(NodeSpec("Text", "title", text = "Hi")), node(NodeSpec("OnlyA", "oa"))),
        ),
      )
    val b =
      node(
        NodeSpec(
          "Root",
          "root",
          children =
            listOf(node(NodeSpec("Text", "title", text = "Bye")), node(NodeSpec("OnlyB", "ob"))),
        ),
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
    val a =
      node(
        NodeSpec(
          "Root",
          "root",
          children =
            listOf(node(NodeSpec("A", "a")), node(NodeSpec("B", "b")), node(NodeSpec("C", "c"))),
        ),
      )
    val b =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("A", "a")), node(NodeSpec("C", "c"))),
        ),
      )

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
        NodeSpec(
          "android.widget.FrameLayout",
          "content",
          children =
            listOf(
              node(NodeSpec("android.widget.TextView", "title", text = "Home")),
              node(NodeSpec("android.widget.Button", "submit", isClickable = true)),
            ),
        ),
      )
    val b =
      node(
        NodeSpec(
          "android.widget.FrameLayout",
          "content",
          children =
            listOf(
              node(NodeSpec("android.widget.TextView", "title", text = "Home")), // equal
              node(
                NodeSpec("android.widget.Button", "submit", isClickable = false),
              ), // changed flag
              node(NodeSpec("android.widget.ProgressBar", "loading")), // only in B
            ),
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
    val a = node(NodeSpec("Root", "root", children = listOf(node(NodeSpec("A", "a")))))
    val b =
      node(
        NodeSpec(
          "Root",
          "root",
          children = listOf(node(NodeSpec("A", "a")), node(NodeSpec("Bonly", "bo"))),
        ),
      )
    val entries = diffHierarchies(a, b).entries

    // Root, then A (both from A's pre-order), then the B-only node appended last.
    assertEquals(NodeDiffStatus.OnlyInB, entries.last().status)
    assertTrue(entries.last().key.contains("Bonly:bo"))
  }

  @Test
  fun `wrapped multi-window frame diffed against a single-window frame isolates the extra window`() {
    // A carries an extra IME window, so the parser wraps it under the synthetic root; B is a plain
    // single-window frame. The synthetic wrapper must be transparent: the shared app window matches
    // and only the extra IME window surfaces as OnlyInA — not the whole app as OnlyInA/OnlyInB.
    val appSubtree =
      node(
        NodeSpec(
          "app.Window",
          "app",
          children = listOf(node(NodeSpec("android.widget.TextView", "title", text = "Hi"))),
        ),
      )
    val a = multiWindowRoot(appSubtree, node(NodeSpec("ime.Window", "ime")))
    val b =
      node(
        NodeSpec(
          "app.Window",
          "app",
          children = listOf(node(NodeSpec("android.widget.TextView", "title", text = "Hi"))),
        ),
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
    val a =
      multiWindowRoot(node(NodeSpec("app.Window", "app")), node(NodeSpec("ime.Window", "ime")))
    val b =
      multiWindowRoot(node(NodeSpec("app.Window", "app")), node(NodeSpec("ime.Window", "ime")))

    val diff = diffHierarchies(a, b)

    assertFalse(diff.hasDifferences)
    // Both windows match; the synthetic wrapper is transparent so it is not counted.
    assertEquals(2, diff.equal)
    assertNull(statusOf(diff, MULTI_WINDOW_ROOT_CLASS_NAME))
  }

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
      node(
        NodeSpec(
          "dialog.Window",
          "dialog",
          children = listOf(node(NodeSpec("TextView", "msg", text = t))),
        ),
      )
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
          NodeSpec(
            "app.Window",
            "app",
            children = listOf(node(NodeSpec("android.widget.TextView", "title", text = "Home"))),
          ),
        ),
        node(NodeSpec("ime.Window", "ime")),
      )
    val b =
      multiWindowRoot(
        node(
          NodeSpec(
            "app.Window",
            "app",
            children = listOf(node(NodeSpec("android.widget.TextView", "title", text = "Away"))),
          ),
        ),
        node(NodeSpec("ime.Window", "ime")),
      )

    val diff = diffHierarchies(a, b)

    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "TextView:title"))
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
  }

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
        NodeSpec(
          "android.widget.FrameLayout",
          "android:id/content",
          children =
            listOf(
              node(NodeSpec("android.widget.TextView", "com.app:id/title", text = "Inbox")),
              node(NodeSpec("android.widget.ImageView", "com.app:id/avatar")),
            ),
        ),
      )
    val ios =
      node(
        NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UILabel", text = "Inbox")))),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(NodeDiffStatus.OnlyInA, statusOf(diff, "Image#"))
    assertEquals(1, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
  }
}

internal class HierarchyDiffStructuralRoleTest : HierarchyDiffFixture() {
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

  @Test
  fun `role mode pairs the production class-less android root with the ios root`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(node(NodeSpec("android.widget.TextView", "com.app:id/title", text = "Inbox"))),
        ),
      )
    val ios =
      node(
        NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UILabel", text = "Inbox")))),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Container#"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Text#"))
  }

  @Test
  fun `role mode treats an android content-desc and an ios text label as the same accessible name`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(node(NodeSpec("android.widget.ImageButton", contentDescription = "Add"))),
        ),
      )
    val ios =
      node(NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UIButton", text = "Add")))))

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.changed)
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Button#"))
  }

  @Test
  fun `role mode still reports a differing accessible name as Changed`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(node(NodeSpec("android.widget.ImageButton", contentDescription = "Add"))),
        ),
      )
    val ios =
      node(
        NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UIButton", text = "Remove")))),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(1, diff.changed)
    assertEquals(NodeDiffStatus.Changed, statusOf(diff, "Button#"))
  }

  @Test
  fun `role mode pairs an ios checkbox reported as a checkable UIView with an android CheckBox`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children = listOf(node(NodeSpec("android.widget.CheckBox", isCheckable = true))),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children = listOf(node(NodeSpec("UIView", isCheckable = true))),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Checkbox#"))
  }

  @Test
  fun `role mode leaves a checkable switch keyed as Switch`() {
    val androidSwitch =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(node(NodeSpec("androidx.appcompat.widget.SwitchCompat", isCheckable = true))),
        ),
      )
    val iosSwitch =
      node(
        NodeSpec(
          "XCUIApplication",
          children = listOf(node(NodeSpec("UISwitch", isCheckable = true))),
        ),
      )

    val diff = diffHierarchies(androidSwitch, iosSwitch, DiffKeyMode.StructuralRole)

    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Switch#"))
    assertNull(statusOf(diff, "Checkbox#"))
  }

  @Test
  fun `role mode promotes a class-erased android label to Text so it pairs with an ios UILabel`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(node(NodeSpec("android.view.View", "com.app:id/title", text = "Inbox"))),
        ),
      )
    val ios =
      node(
        NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UILabel", text = "Inbox")))),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Text#"))
  }

  @Test
  fun `role mode leaves a clickable text-bearing generic node keyed as Container`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children = listOf(node(NodeSpec("android.view.View", text = "Go", isClickable = true))),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children = listOf(node(NodeSpec("UIView", text = "Go", isClickable = true))),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Container#"))
    assertNull(statusOf(diff, "Text#"))
  }

  @Test
  fun `role mode promotes a class-erased android scroll container to ScrollView`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children = listOf(node(NodeSpec("android.view.View", isScrollable = true))),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children = listOf(node(NodeSpec("UIScrollView", isScrollable = true))),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "ScrollView#"))
  }

  @Test
  fun `role mode pairs an android RadioButton with an ios checkable radio view`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children = listOf(node(NodeSpec("android.widget.RadioButton", isCheckable = true))),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children = listOf(node(NodeSpec("UIView", isCheckable = true))),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Checkbox#"))
  }

  @Test
  fun `role mode pairs a custom android View container with an ios UIView container`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(
              node(
                NodeSpec(
                  "com.example.ProfileView",
                  children = listOf(node(NodeSpec("android.widget.TextView", text = "Name"))),
                ),
              ),
            ),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children =
            listOf(
              node(NodeSpec("UIView", children = listOf(node(NodeSpec("UILabel", text = "Name"))))),
            ),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(3, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Container#"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Text#"))
  }

  @Test
  fun `role mode pairs a checkable android CheckedTextView with an ios checkable view`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(
              node(NodeSpec("android.widget.CheckedTextView", text = "Wifi", isCheckable = true)),
            ),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children = listOf(node(NodeSpec("UIView", text = "Wifi", isCheckable = true))),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Checkbox#"))
  }

  @Test
  fun `role mode infers ListItem for an android list-row wrapper so it pairs with an ios cell`() {
    val android =
      node(
        NodeSpec(
          "android.widget.FrameLayout",
          "android:id/content",
          children =
            listOf(
              node(
                NodeSpec(
                  "androidx.recyclerview.widget.RecyclerView",
                  "com.app:id/list",
                  children =
                    listOf(
                      node(
                        NodeSpec(
                          "android.widget.LinearLayout",
                          "com.app:id/row",
                          children =
                            listOf(node(NodeSpec("android.widget.TextView", text = "Inbox"))),
                        ),
                      ),
                    ),
                ),
              ),
            ),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children =
            listOf(
              node(
                NodeSpec(
                  "UITableView",
                  children =
                    listOf(
                      node(
                        NodeSpec(
                          "UITableViewCell",
                          children = listOf(node(NodeSpec("UILabel", text = "Inbox"))),
                        ),
                      ),
                    ),
                ),
              ),
            ),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    // Root(Container) + List + row(ListItem) + label(Text) all pair.
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(4, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "List#"))
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "ListItem#"))
  }

  @Test
  fun `role mode does not infer ListItem for a generic container outside a list`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children = listOf(node(NodeSpec("android.widget.LinearLayout", "com.app:id/panel"))),
        ),
      )
    val ios = node(NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UIView")))))

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Container#"))
    assertNull(statusOf(diff, "ListItem#"))
  }

  @Test
  fun `role mode treats empty android text as absent and falls back to content-desc`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(
              node(NodeSpec("android.widget.ImageButton", text = "", contentDescription = "Add")),
            ),
        ),
      )
    val ios =
      node(NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UIButton", text = "Add")))))

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.changed)
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Button#"))
  }

  @Test
  fun `role mode aligns later siblings after a platform-specific node`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(
              node(NodeSpec("android.widget.TextView", text = "First")),
              node(NodeSpec("android.widget.ImageView")),
              node(NodeSpec("android.widget.TextView", text = "Second")),
            ),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children =
            listOf(
              node(NodeSpec("UILabel", text = "First")),
              node(NodeSpec("UILabel", text = "Second")),
            ),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(1, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(3, diff.equal)
  }

  @Test
  fun `role mode promotes a content-description-only generic node to Text`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children = listOf(node(NodeSpec("android.view.View", contentDescription = "Home"))),
        ),
      )
    val ios =
      node(NodeSpec("XCUIApplication", children = listOf(node(NodeSpec("UIView", text = "Home")))))

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(0, diff.changed)
    assertEquals(2, diff.equal)
    assertEquals(NodeDiffStatus.Equal, statusOf(diff, "Text#"))
  }

  @Test
  fun `role mode prefers an Android content description over visible text`() {
    val android =
      node(
        NodeSpec(
          "android.view.View",
          children =
            listOf(
              node(
                NodeSpec(
                  "android.widget.Button",
                  text = "AutoMobile Playground",
                  contentDescription = "Predicted app: AutoMobile Playground",
                ),
              ),
            ),
        ),
      )
    val ios =
      node(
        NodeSpec(
          "XCUIApplication",
          children =
            listOf(node(NodeSpec("UIButton", text = "Predicted app: AutoMobile Playground"))),
        ),
      )

    val diff = diffHierarchies(android, ios, DiffKeyMode.StructuralRole)

    assertEquals(0, diff.changed)
    assertEquals(0, diff.onlyInA)
    assertEquals(0, diff.onlyInB)
    assertEquals(2, diff.equal)
  }
}
