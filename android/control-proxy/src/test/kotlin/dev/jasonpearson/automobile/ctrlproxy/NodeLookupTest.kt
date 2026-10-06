package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Issue #10070 (window-set lookup) and #10071 (each pooled copy released exactly once). */
@RunWith(RobolectricTestRunner::class)
class NodeLookupTest {

  private fun root(label: String): AccessibilityNodeInfo =
    mockk(relaxed = true, name = label) { every { viewIdResourceName } returns label }

  /** An editable field the focus fallback may move to unless a flag below says otherwise. */
  private fun field(
    label: String,
    editable: Boolean = true,
    focusable: Boolean = true,
    visible: Boolean = true,
    enabled: Boolean = true,
  ): AccessibilityNodeInfo =
    mockk(relaxed = true, name = label) {
      every { viewIdResourceName } returns label
      every { isEditable } returns editable
      every { isFocusable } returns focusable
      every { isVisibleToUser } returns visible
      every { isEnabled } returns enabled
    }

  private fun window(
    root: AccessibilityNodeInfo?,
    active: Boolean = false,
  ): AccessibilityWindowInfo =
    mockk(relaxed = true) {
      every { this@mockk.root } returns root
      every { isActive } returns active
    }

  private fun matching(id: String): (AccessibilityNodeInfo) -> AccessibilityNodeInfo? = {
    if (it.viewIdResourceName == id) it else null
  }

  @Test
  fun `finds a node that only a non-active window contains`() {
    val activeRoot = root("left")
    val otherRoot = root("right")

    val found =
      findNodeAcrossWindows(
        windows = listOf(window(activeRoot, active = true), window(otherRoot)),
        activeRoot = { activeRoot },
        find = matching("right"),
      )

    assertSame(otherRoot, found)
    // The non-matching root was released; the returned root belongs to the caller.
    verify(exactly = 1) { activeRoot.recycle() }
    verify(exactly = 0) { otherRoot.recycle() }
  }

  @Test
  fun `a single-root lookup of the active window alone misses the same node`() {
    val activeRoot = root("left")
    assertNull(findNodeAcrossWindows(emptyList(), { activeRoot }, matching("right")))
  }

  @Test
  fun `searches the other windows topmost first like the extractor and stops at the first hit`() {
    val top = root("dup")
    val bottom = root("dup")

    val found =
      findNodeAcrossWindows(listOf(window(top), window(bottom)), { null }, matching("dup"))

    assertSame(top, found)
    verify(exactly = 0) { bottom.recycle() }
    verify(exactly = 0) { bottom.viewIdResourceName }
  }

  @Test
  fun `a bare id present in the active app window and a higher IME window resolves to the app`() {
    val ime = root("title")
    val app = root("title")
    val appWindow = window(app, active = true)
    val imeWindow = window(ime)

    // Framework z-order lists the IME window ahead of the app window.
    val found = findNodeAcrossWindows(listOf(imeWindow, appWindow), { app }, matching("title"))

    assertSame(app, found)
    // The IME window is never consulted once the active window hits.
    verify(exactly = 0) { imeWindow.root }
    verify(exactly = 0) { ime.viewIdResourceName }
  }

  @Test
  fun `an app node that vanished still widens to another window and the active window is searched once`() {
    val ime = root("other")
    val app = root("app")
    val appWindow = window(app, active = true)

    val found = findNodeAcrossWindows(listOf(window(ime), appWindow), { app }, matching("other"))

    assertSame(ime, found)
    verify(exactly = 1) { app.recycle() }
    verify(exactly = 0) { appWindow.root }
  }

  @Test
  fun `a miss in the active window is not searched a second time when it is also listed`() {
    val app = root("app")

    assertNull(findNodeAcrossWindows(listOf(window(app, active = true)), { app }, matching("gone")))

    verify(exactly = 1) { app.recycle() }
    verify(exactly = 1) { app.viewIdResourceName }
  }

  @Test
  fun `skips windows without a root`() {
    val other = root("right")
    val found =
      findNodeAcrossWindows(listOf(window(null), window(other)), { null }, matching("right"))
    assertSame(other, found)
  }

  @Test
  fun `searches the active root first and only widens to listed windows on a miss`() {
    val listed = root("left")
    val active = root("active")
    val listedWindow = window(listed)
    val found = findNodeAcrossWindows(listOf(listedWindow), { active }, matching("active"))
    assertSame(active, found)
    verify(exactly = 0) { listedWindow.root }
    verify(exactly = 0) { active.recycle() }

    val onlyActive = root("active")
    assertSame(onlyActive, findNodeAcrossWindows(emptyList(), { onlyActive }, matching("active")))
  }

  @Test
  fun `a miss everywhere recycles every acquired root and returns null`() {
    val a = root("a")
    val b = root("b")
    val active = root("c")

    assertNull(findNodeAcrossWindows(listOf(window(a), window(b)), { active }, matching("zzz")))

    verify(exactly = 1) { a.recycle() }
    verify(exactly = 1) { b.recycle() }
    verify(exactly = 1) { active.recycle() }
  }

  @Test
  fun `a descendant hit recycles its root but the descendant stays with the caller`() {
    val rootNode = root("root")
    val child = root("child")

    val found =
      findNodeAcrossWindows(listOf(window(rootNode)), { null }) {
        if (it === rootNode) child else null
      }

    assertSame(child, found)
    verify(exactly = 1) { rootNode.recycle() }
    verify(exactly = 0) { child.recycle() }
  }

  @Test
  fun `a throwing finder still releases the root it was handed`() {
    val rootNode = root("root")
    try {
      findNodeAcrossWindows(listOf(window(rootNode)), { null }) { error("boom") }
    } catch (expected: IllegalStateException) {
      assertEquals("boom", expected.message)
    }
    verify(exactly = 1) { rootNode.recycle() }
  }

  @Test
  fun `previous with two earlier fields returns the second and releases each copy once`() {
    val first = field("a")
    val second = field("b")
    val third = field("c")

    val previous =
      selectAdjacentFocusable(listOf(first, second, third), forward = false) { it === third }

    assertSame(second, previous)
    verify(exactly = 1) { first.recycle() }
    verify(exactly = 0) { second.recycle() }
    verify(exactly = 1) { third.recycle() }
  }

  @Test
  fun `previous with four earlier fields never recycles a copy twice`() {
    val nodes = listOf("a", "b", "c", "d", "e").map { field(it) }

    val previous = selectAdjacentFocusable(nodes, forward = false) { it === nodes[4] }

    assertSame(nodes[3], previous)
    nodes.forEachIndexed { i, n -> verify(exactly = if (i == 3) 0 else 1) { n.recycle() } }
  }

  @Test
  fun `previous when the current node is not found releases every copy exactly once`() {
    val nodes = listOf("a", "b", "c").map { field(it) }

    assertNull(selectAdjacentFocusable(nodes, forward = false) { false })

    nodes.forEach { verify(exactly = 1) { it.recycle() } }
  }

  @Test
  fun `previous when the current node is first returns null and releases every copy once`() {
    val nodes = listOf("a", "b").map { field(it) }

    assertNull(selectAdjacentFocusable(nodes, forward = false) { it === nodes[0] })

    nodes.forEach { verify(exactly = 1) { it.recycle() } }
  }

  @Test
  fun `previous with a single predecessor returns it`() {
    val first = field("a")
    val second = field("b")

    assertSame(
      first,
      selectAdjacentFocusable(listOf(first, second), forward = false) { it === second },
    )

    verify(exactly = 0) { first.recycle() }
    verify(exactly = 1) { second.recycle() }
  }

  @Test
  fun `next skips a disabled field and returns the enabled one behind it`() {
    val email = field("email")
    val referral = field("referral", enabled = false)
    val password = field("password")

    val next =
      selectAdjacentFocusable(listOf(email, referral, password), forward = true) { it === email }

    assertSame(password, next)
    verify(exactly = 1) { referral.recycle() }
    verify(exactly = 1) { email.recycle() }
    verify(exactly = 0) { password.recycle() }
  }

  @Test
  fun `previous skips an invisible field and returns the visible one before it`() {
    val first = field("first")
    val hidden = field("hidden", visible = false)
    val last = field("last")

    val previous =
      selectAdjacentFocusable(listOf(first, hidden, last), forward = false) { it === last }

    assertSame(first, previous)
    verify(exactly = 1) { hidden.recycle() }
  }

  @Test
  fun `next with only an ineligible field behind returns null and releases every copy once`() {
    val email = field("email")
    val readOnly = field("readOnly", focusable = false)

    assertNull(selectAdjacentFocusable(listOf(email, readOnly), forward = true) { it === email })

    verify(exactly = 1) { email.recycle() }
    verify(exactly = 1) { readOnly.recycle() }
  }

  // ----- focusFirstTraversalTarget: each strategy falls through to the next (#10219) -----

  private val focusIt: (AccessibilityNodeInfo) -> Boolean = { true }

  @Test
  fun `a traversal hint that points at a disabled node falls through to the next strategy`() {
    val disabledHint = field("hint", enabled = false)
    val viaSearch = field("search")
    val current = field("current")
    val focused = mutableListOf<AccessibilityNodeInfo>()

    val outcome =
      focusFirstTraversalTarget(
        listOf({ disabledHint }, { viaSearch }, { error("not reached") }),
        { it === current },
        {
          focused += it
          true
        },
      )

    assertEquals(TraversalOutcome.FOCUSED, outcome)
    assertEquals(listOf(viaSearch), focused)
    verify(exactly = 1) { disabledHint.recycle() }
    verify(exactly = 1) { viaSearch.recycle() }
  }

  @Test
  fun `a traversal strategy that returns the current node is rejected`() {
    val current = field("current")
    val other = field("other")

    val outcome =
      focusFirstTraversalTarget(listOf({ current }, { other }), { it === current }, focusIt)

    assertEquals(TraversalOutcome.FOCUSED, outcome)
    verify(exactly = 1) { current.recycle() }
    verify(exactly = 1) { other.recycle() }
  }

  @Test
  fun `a focusSearch result that is the host view and refuses focus falls through to tree order`() {
    // Compose: focusSearch resolves to AndroidComposeView, which is focusable, visible and
    // enabled (so it passes reachability) but refuses ACTION_FOCUS. Tree order must still run.
    val current = field("current")
    val host = field("host", editable = true)
    val treeOrder = field("treeOrder")
    val tried = mutableListOf<AccessibilityNodeInfo>()

    val outcome =
      focusFirstTraversalTarget(
        listOf({ host }, { null }, { treeOrder }),
        { it === current },
        {
          tried += it
          it !== host
        },
      )

    assertEquals(TraversalOutcome.FOCUSED, outcome)
    assertEquals(listOf(host, treeOrder), tried)
    verify(exactly = 1) { host.recycle() }
    verify(exactly = 1) { treeOrder.recycle() }
  }

  @Test
  fun `a strategy node that is not an editable input falls through without being focused`() {
    val current = field("current")
    val container = field("container", editable = false)
    val treeOrder = field("treeOrder")
    val tried = mutableListOf<AccessibilityNodeInfo>()

    val outcome =
      focusFirstTraversalTarget(
        listOf({ container }, { treeOrder }),
        { it === current },
        {
          tried += it
          true
        },
      )

    assertEquals(TraversalOutcome.FOCUSED, outcome)
    assertEquals(listOf(treeOrder), tried)
    verify(exactly = 1) { container.recycle() }
  }

  @Test
  fun `every strategy refusing focus reports a refusal after trying them all`() {
    val current = field("current")
    val first = field("first")
    val second = field("second")

    val outcome =
      focusFirstTraversalTarget(
        listOf({ first }, { second }),
        { it === current },
        { false },
      )

    assertEquals(TraversalOutcome.REFUSED, outcome)
    verify(exactly = 1) { first.recycle() }
    verify(exactly = 1) { second.recycle() }
  }

  @Test
  fun `no strategy yielding an eligible node reports no target`() {
    val invisible = field("invisible", visible = false)

    val outcome =
      focusFirstTraversalTarget(listOf({ null }, { invisible }), { false }, { error("no") })

    assertEquals(TraversalOutcome.NO_TARGET, outcome)
    verify(exactly = 1) { invisible.recycle() }
  }

  @Test
  fun `a refusal followed by an ineligible node still reports a refusal`() {
    val refuser = field("refuser")
    val hidden = field("hidden", visible = false)

    val outcome = focusFirstTraversalTarget(listOf({ refuser }, { hidden }), { false }, { false })

    assertEquals(TraversalOutcome.REFUSED, outcome)
  }
}
