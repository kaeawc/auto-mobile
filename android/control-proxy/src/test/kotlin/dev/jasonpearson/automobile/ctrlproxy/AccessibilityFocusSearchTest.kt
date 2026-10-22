package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * A capture searches for accessibility focus only in windows that report it (#13957), so a screen
 * without TalkBack costs no cross-process `getRoot`/`findFocus` calls before the tree walk.
 */
@RunWith(RobolectricTestRunner::class)
internal class AccessibilityFocusSearchTest : ViewHierarchyExtractorFixtures() {

  private fun window(id: Int, accessibilityFocused: Boolean = false): AccessibilityWindowInfo =
    fakeWindow(id, id, null, WindowState(accessibilityFocused = accessibilityFocused))

  @Test
  fun `without accessibility focus no window or active root is searched`() {
    val search = accessibilityFocusSearch(listOf(window(1), window(2), window(3)))
    assertEquals(emptyList<AccessibilityWindowInfo>(), search.windows)
    assertFalse(search.activeRootFallback)
  }

  @Test
  fun `only the window holding accessibility focus is searched, then the active root`() {
    val focused = window(2, accessibilityFocused = true)
    val search = accessibilityFocusSearch(listOf(window(1), focused, window(3)))
    assertEquals(listOf(focused), search.windows)
    assertTrue(search.activeRootFallback)
  }

  @Test
  fun `with no window list the active root is still searched`() {
    val search = accessibilityFocusSearch(emptyList())
    assertEquals(emptyList<AccessibilityWindowInfo>(), search.windows)
    assertTrue(search.activeRootFallback)
  }
}
