package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PrototypeListAnchorTest {
  @Test
  fun prependPreservesRowKeyAndPixelOffset() {
    assertEquals(
      PrototypeListAnchorTarget(3, 17),
      PrototypeListAnchor.resolve("b", 17, listOf("new", "a", "b"), true),
    )
    assertEquals(
      PrototypeListAnchorTarget(1, 0),
      PrototypeListAnchor.resolve("a", 0, listOf("new", "a"), false),
    )
  }

  @Test
  fun topHeaderResolvesThePreviousFirstRowAtTheSavedScrollOffset() {
    assertEquals(
      PrototypeListAnchorTarget(2, 0),
      PrototypeListAnchor.resolve("a", 0, listOf("new", "a"), true),
    )
    assertNull(PrototypeListAnchor.resolve("gone", 12, listOf("a"), true))
  }

  @Test
  fun restoringAnUnchangedTopRetainsItsHeader() {
    val saved = PrototypeListAnchor("a", 0, 0, headerVisible = true)
    assertEquals(PrototypeListAnchorTarget(0, 0), saved.restore(listOf("a", "b"), true))
    assertEquals(PrototypeListAnchorTarget(2, 0), saved.restore(listOf("new", "a", "b"), true))
  }

  @Test
  fun restoreFollowsKeysThenClampsSavedRowIndex() {
    val saved = PrototypeListAnchor("b", 1, 19)
    assertEquals(PrototypeListAnchorTarget(3, 19), saved.restore(listOf("new", "a", "b"), true))
    assertEquals(PrototypeListAnchorTarget(1, 19), saved.restore(listOf("a"), true))
    assertEquals(PrototypeListAnchorTarget(0, 0), saved.restore(emptyList(), true))
  }

  @Test
  fun stackAnchorsSurviveCoveringAndClearOnPopOrReplacement() {
    val store = PrototypeStackScrollStore()
    val anchor = PrototypeListAnchor("row-20", 20, 7)
    store.retain(listOf("home"))
    store.saveList(0, "home", "feed", anchor)
    store.retain(listOf("home", "detail"))
    store.saveList(1, "detail", "feed", anchor)
    store.retain(listOf("home"))
    assertEquals(anchor, store.readList(0, "home", "feed"))
    assertNull(store.readList(1, "detail", "feed"))
    store.saveList(1, "detail", "feed", anchor)
    assertNull(store.readList(1, "detail", "feed"))
    store.retain(listOf("replacement"))
    assertNull(store.readList(0, "home", "feed"))
  }
}
