package dev.jasonpearson.automobile.desktop.core.failures

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExpandableListStateTest {
  @Test
  fun `all sections start limited and toggle independently`() {
    val items = (1..6).toList()
    val initial = ExpandableListState()
    FailureSection.entries.forEach { section ->
      assertFalse(initial.isExpanded(section))
      assertEquals(items.take(5), initial.visible(section, items))
      val expanded = initial.toggle(section)
      assertTrue(expanded.isExpanded(section))
      assertEquals(items, expanded.visible(section, items))
      FailureSection.entries
        .filter { it != section }
        .forEach {
          assertFalse(expanded.isExpanded(it))
        }
      assertEquals(initial, expanded.toggle(section))
    }
  }

  @Test
  fun `collapsing one section preserves another expansion`() {
    val state = ExpandableListState().toggle(FailureSection.Screens).toggle(FailureSection.Devices)
    val collapsed = state.toggle(FailureSection.Screens)
    assertFalse(collapsed.isExpanded(FailureSection.Screens))
    assertTrue(collapsed.isExpanded(FailureSection.Devices))
  }

  @Test
  fun `visible respects supplied limit and short or empty lists`() {
    val state = ExpandableListState()
    assertEquals(listOf(1, 2), state.visible(FailureSection.Tests, listOf(1, 2, 3), 2))
    assertEquals(listOf(1), state.visible(FailureSection.Tests, listOf(1)))
    assertEquals(emptyList<Int>(), state.visible(FailureSection.Tests, emptyList<Int>()))
  }

  @Test
  fun `partial lists label loaded and total counts`() {
    assertEquals("Show 6 of 42 occurrences", expansionLinkLabel("occurrences", 6, 42, false))
  }

  @Test
  fun `fully loaded lists keep view all label`() {
    assertEquals("View all 6 occurrences", expansionLinkLabel("occurrences", 6, 6, false))
    assertEquals("View all 6 occurrences", expansionLinkLabel("occurrences", 6, 4, false))
  }

  @Test
  fun `lists within preview limit have no link even with a larger total`() {
    for (loadedCount in 0..5) {
      assertNull(expansionLinkLabel("occurrences", loadedCount, 42, false))
    }
  }

  @Test
  fun `expanded lists offer show less`() {
    assertEquals("Show less", expansionLinkLabel("occurrences", 6, 42, true))
  }

  @Test
  fun `link respects supplied preview limit`() {
    assertEquals("Show 3 of 42 occurrences", expansionLinkLabel("occurrences", 3, 42, false, 2))
    assertNull(expansionLinkLabel("occurrences", 3, 42, false, 3))
  }
}
