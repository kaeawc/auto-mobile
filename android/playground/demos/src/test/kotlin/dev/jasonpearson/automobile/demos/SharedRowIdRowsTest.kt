package dev.jasonpearson.automobile.demos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedRowIdRowsTest {
  @Test
  fun defaultListHasAtLeastFiftyDistinctLabels() {
    val labels = sharedRowIdLabels()
    assertTrue(labels.size >= 50)
    assertEquals(labels.size, labels.toSet().size)
    assertEquals("Shared row 01", labels.first())
    assertEquals("Shared row 60", labels.last())
  }

  @Test
  fun noLabelIsAPrefixOfAnother() {
    val labels = sharedRowIdLabels()
    labels.forEach { label ->
      assertFalse(labels.any { other -> other != label && other.startsWith(label) })
    }
  }
}
