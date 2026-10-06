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
    val first = root("a")
    val second = root("b")
    val third = root("c")

    val previous = selectPreviousFocusable(listOf(first, second, third)) { it === third }

    assertSame(second, previous)
    verify(exactly = 1) { first.recycle() }
    verify(exactly = 0) { second.recycle() }
    verify(exactly = 1) { third.recycle() }
  }

  @Test
  fun `previous with four earlier fields never recycles a copy twice`() {
    val nodes = listOf("a", "b", "c", "d", "e").map(::root)

    val previous = selectPreviousFocusable(nodes) { it === nodes[4] }

    assertSame(nodes[3], previous)
    nodes.forEachIndexed { i, n -> verify(exactly = if (i == 3) 0 else 1) { n.recycle() } }
  }

  @Test
  fun `previous when the current node is not found releases every copy exactly once`() {
    val nodes = listOf("a", "b", "c").map(::root)

    assertNull(selectPreviousFocusable(nodes) { false })

    nodes.forEach { verify(exactly = 1) { it.recycle() } }
  }

  @Test
  fun `previous when the current node is first returns null and releases every copy once`() {
    val nodes = listOf("a", "b").map(::root)

    assertNull(selectPreviousFocusable(nodes) { it === nodes[0] })

    nodes.forEach { verify(exactly = 1) { it.recycle() } }
  }

  @Test
  fun `previous with a single predecessor returns it`() {
    val first = root("a")
    val second = root("b")

    assertSame(first, selectPreviousFocusable(listOf(first, second)) { it === second })

    verify(exactly = 0) { first.recycle() }
    verify(exactly = 1) { second.recycle() }
  }
}
