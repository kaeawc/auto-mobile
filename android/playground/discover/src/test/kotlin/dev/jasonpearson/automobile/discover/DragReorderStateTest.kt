package dev.jasonpearson.automobile.discover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DragReorderStateTest {

  private fun items() = (1..5).map { DraggableListItem(it, "Drag item $it") }.toMutableList()

  @Test
  fun `successive moves keep the owner active across reorders`() {
    val items = items()
    val updates = mutableListOf<Pair<Int?, Float>>()
    val state = DragReorderState(items) { id, offset -> updates.add(id to offset) }

    state.start(2)
    state.move(2, 78f, 64f)
    assertEquals(listOf(1, 3, 2, 4, 5), items.map { it.id })
    assertEquals(2, state.draggingItemId)
    assertEquals(14f, state.dragOffset, 0f)

    state.move(2, 58f, 64f)
    assertEquals(listOf(1, 3, 4, 2, 5), items.map { it.id })
    assertEquals(2, state.draggingItemId)
    assertEquals(8f, state.dragOffset, 0f)
    assertEquals(listOf(2 to 0f, 2 to 14f, 2 to 8f), updates)
  }

  @Test
  fun `another row cannot start move end or cancel the owner drag`() {
    val items = items()
    val updates = mutableListOf<Pair<Int?, Float>>()
    val state = DragReorderState(items) { id, offset -> updates.add(id to offset) }
    state.start(2)
    state.move(2, 20f, 64f)

    state.start(3)
    state.move(3, 128f, 64f)
    state.end(3)
    state.cancel(3)

    assertEquals(2, state.draggingItemId)
    assertEquals(20f, state.dragOffset, 0f)
    assertEquals(listOf(1, 2, 3, 4, 5), items.map { it.id })
    assertEquals(listOf(2 to 0f, 2 to 20f), updates)
    state.move(2, 44f, 64f)
    assertEquals(listOf(1, 3, 2, 4, 5), items.map { it.id })
    assertEquals(0f, state.dragOffset, 0f)
  }

  @Test
  fun `row height alone does not cross the stride including spacing`() {
    val items = items()
    val state = DragReorderState(items)
    state.start(2)

    state.move(2, 56f, 64f)
    assertEquals(listOf(1, 2, 3, 4, 5), items.map { it.id })
    assertEquals(56f, state.dragOffset, 0f)

    state.move(2, 8f, 64f)
    assertEquals(listOf(1, 3, 2, 4, 5), items.map { it.id })
    assertEquals(0f, state.dragOffset, 0f)
  }

  @Test
  fun `one full stride moves exactly one row with no drift`() {
    val items = items()
    val state = DragReorderState(items)
    state.start(2)
    state.move(2, 64f, 64f)
    assertEquals(listOf(1, 3, 2, 4, 5), items.map { it.id })
    assertEquals(0f, state.dragOffset, 0f)

    state.move(2, -64f, 64f)
    assertEquals(listOf(1, 2, 3, 4, 5), items.map { it.id })
    assertEquals(0f, state.dragOffset, 0f)
  }

  @Test
  fun `owner end resets state and allows a new owner`() {
    val items = items()
    var mirroredId: Int? = null
    var mirroredOffset = 0f
    val state =
      DragReorderState(items) { id, offset ->
        mirroredId = id
        mirroredOffset = offset
      }
    state.start(2)
    state.move(2, 78f, 64f)
    state.end(2)

    assertNull(state.draggingItemId)
    assertEquals(0f, state.dragOffset, 0f)
    assertNull(mirroredId)
    assertEquals(0f, mirroredOffset, 0f)
    assertEquals(listOf(1, 3, 2, 4, 5), items.map { it.id })
    state.start(3)
    assertEquals(3, state.draggingItemId)
  }

  @Test
  fun `owner cancel resets state and allows a new owner`() {
    val items = items()
    val updates = mutableListOf<Pair<Int?, Float>>()
    val state = DragReorderState(items) { id, offset -> updates.add(id to offset) }
    state.start(2)
    state.move(2, 78f, 64f)
    state.cancel(2)

    assertNull(state.draggingItemId)
    assertEquals(0f, state.dragOffset, 0f)
    assertEquals(null to 0f, updates.last())
    assertEquals(listOf(1, 3, 2, 4, 5), items.map { it.id })
    state.start(3)
    assertEquals(3, state.draggingItemId)
  }

  @Test
  fun `callbacks without an active drag and unknown starts do nothing`() {
    val items = items()
    val updates = mutableListOf<Pair<Int?, Float>>()
    val state = DragReorderState(items) { id, offset -> updates.add(id to offset) }
    state.move(2, 64f, 64f)
    state.end(2)
    state.cancel(2)
    state.start(99)
    assertNull(state.draggingItemId)
    assertEquals(0f, state.dragOffset, 0f)
    assertEquals(listOf(1, 2, 3, 4, 5), items.map { it.id })
    assertEquals(emptyList<Pair<Int?, Float>>(), updates)
  }
}
