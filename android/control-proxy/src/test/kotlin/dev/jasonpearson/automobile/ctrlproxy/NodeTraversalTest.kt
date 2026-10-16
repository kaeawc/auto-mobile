package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NodeTraversalTest {
  private fun node(
    focused: Boolean = false,
    editable: Boolean = false,
    children: List<AccessibilityNodeInfo> = emptyList(),
  ): AccessibilityNodeInfo =
    mockk(relaxed = true) {
      every { isFocused } returns focused
      every { isEditable } returns editable
      every { childCount } returns children.size
      every { getChild(any()) } answers { children[firstArg()] }
    }

  @Test
  fun `a focused editable node is found through nested children`() {
    val target = node(focused = true, editable = true)
    val decoy = node(focused = true, editable = false)
    val root =
      node(children = listOf(node(children = listOf(decoy)), node(children = listOf(target))))

    assertSame(target, findFocusedEditableInHierarchy(root))
  }

  @Test
  fun `children that do not hold the result are recycled and the hit is not`() {
    val target = node(focused = true, editable = true)
    val other = node()
    val wrapper = node(children = listOf(target))

    val found = findFocusedEditableInHierarchy(node(children = listOf(other, wrapper)))

    assertSame(target, found)
    verify(exactly = 1) { other.recycle() }
    verify(exactly = 1) { wrapper.recycle() }
    verify(exactly = 0) { target.recycle() }
  }

  @Test
  fun `no focused editable node yields null`() {
    assertNull(findFocusedEditableInHierarchy(node(children = listOf(node(), node()))))
    assertNull(findFocusedEditableInHierarchy(null))
  }

  @Test
  fun `findFocusedEditableNode prefers the input-focused editable node`() {
    val focus = node(editable = true)
    val root = node()
    every { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } returns focus

    assertSame(focus, findFocusedEditableNode(root))
  }

  @Test
  fun `findFocusedEditableNode recycles a non-editable input focus and falls back to a search`() {
    val focus = node(editable = false)
    val target = node(focused = true, editable = true)
    val root = node(children = listOf(target))
    every { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } returns focus

    assertSame(target, findFocusedEditableNode(root))
    verify(exactly = 1) { focus.recycle() }
  }

  @Test
  fun `test tag is read from known extras keys and falls back to a testtag substring key`() {
    val known = node()
    every { known.extras } returns
      Bundle().apply { putString("androidx.compose.ui.testTag", "login") }
    val fallback = node()
    every { fallback.extras } returns Bundle().apply { putString("My-TestTag-Key", "fb") }
    val blank = node()
    every { blank.extras } returns Bundle().apply { putString("testTag", "  ") }

    assertEquals("login", extractTestTag(known))
    assertEquals("fb", extractTestTag(fallback))
    // A blank known key is skipped, but the substring fallback then returns the same blank value.
    assertEquals("  ", extractTestTag(blank))
    assertNull(extractTestTag(node().also { every { it.extras } returns Bundle() }))
  }

  @Test
  fun `two nodes are the same when bounds id and text all match`() {
    fun described(text: String, left: Int) =
      node().also {
        every { it.getBoundsInScreen(any()) } answers
          {
            firstArg<Rect>().set(left, 0, left + 10, 10)
          }
        every { it.viewIdResourceName } returns "id/field"
        every { it.text } returns text
      }

    assertTrue(isSameNode(described("a", 0), described("a", 0)))
    assertFalse(isSameNode(described("a", 0), described("b", 0)))
    assertFalse(isSameNode(described("a", 0), described("a", 5)))
  }
}
