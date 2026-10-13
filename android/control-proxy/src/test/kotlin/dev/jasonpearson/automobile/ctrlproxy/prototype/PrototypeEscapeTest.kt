package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

class PrototypeEscapeTest {
  private val scheduler = FakePrototypeEscapeScheduler()
  private var escapes = 0
  private val tracker = PrototypeEscapeTracker(8, scheduler) { escapes++ }
  private val first = PrototypeEscapePointer(10, 20f, 30f)
  private val second = PrototypeEscapePointer(20, 80f, 90f)
  private val pair = listOf(first, second)

  private fun sample(
    action: PrototypeEscapeAction = PrototypeEscapeAction.MOVE,
    pointers: List<PrototypeEscapePointer> = pair,
  ) = tracker.sample(action, pointers)

  @Test
  fun `stationary two fingers fire from scheduler once and trailing gesture is swallowed`() {
    sample(PrototypeEscapeAction.DOWN, listOf(first))
    sample(PrototypeEscapeAction.POINTER_DOWN)
    scheduler.advanceBy(999)
    assertEquals(0, escapes)
    scheduler.advanceBy(1)
    assertEquals(1, escapes)
    scheduler.tasks.single().block()
    assertEquals(1, escapes)
    assertTrue(sample(pointers = listOf(first.copy(x = 22f), second)))
    scheduler.advanceBy(5_000)
    assertEquals(1, escapes)
    assertTrue(sample(PrototypeEscapeAction.POINTER_UP, listOf(first)))
    assertTrue(sample(PrototypeEscapeAction.UP, emptyList()))
    assertFalse(sample(PrototypeEscapeAction.DOWN, listOf(first)))
  }

  @Test
  fun `fresh down releases an unterminated swallowed stream and another hold can arm`() {
    sample(PrototypeEscapeAction.DOWN, listOf(first))
    sample(PrototypeEscapeAction.POINTER_DOWN)
    scheduler.advanceBy(PROTOTYPE_ESCAPE_HOLD_MILLIS)
    assertEquals(1, escapes)
    assertTrue(sample())
    // The first stream disappears without UP/CANCEL; the next stream is a pill tap.
    assertFalse(sample(PrototypeEscapeAction.DOWN, listOf(first)))
    assertFalse(sample(pointers = listOf(first)))
    assertFalse(sample(PrototypeEscapeAction.UP, emptyList()))
    assertFalse(sample(PrototypeEscapeAction.DOWN, listOf(first)))
    assertFalse(sample(PrototypeEscapeAction.POINTER_DOWN))
    scheduler.advanceBy(PROTOTYPE_ESCAPE_HOLD_MILLIS)
    assertEquals(2, escapes)
    assertTrue(sample())
    assertTrue(sample(PrototypeEscapeAction.POINTER_UP, listOf(first)))
    assertTrue(sample(PrototypeEscapeAction.UP, emptyList()))
  }

  @Test
  fun `one finger never arms and a third finger cancels the scheduled hold`() {
    sample(PrototypeEscapeAction.DOWN, listOf(first))
    scheduler.advanceBy(5_000)
    assertEquals(0, escapes)
    sample(PrototypeEscapeAction.POINTER_DOWN)
    sample(PrototypeEscapeAction.POINTER_DOWN, pair + PrototypeEscapePointer(30, 0f, 0f))
    assertEquals(1, scheduler.cancelled)
    scheduler.advanceBy(1_000)
    assertEquals(0, escapes)
  }

  @Test
  fun `movement of either finger past slop rejects the same hold even after returning`() {
    for (index in pair.indices) {
      sample(PrototypeEscapeAction.DOWN, listOf(first))
      sample(PrototypeEscapeAction.POINTER_DOWN)
      sample(pointers = pair.mapIndexed { i, p -> if (i == index) p.copy(x = p.x + 9) else p })
      sample()
      scheduler.advanceBy(1_000)
      assertEquals(0, escapes)
      sample(PrototypeEscapeAction.UP, emptyList())
    }
    assertEquals(2, scheduler.cancelled)
  }

  @Test
  fun `movement within slop keeps the original deadline without re-arming`() {
    sample(PrototypeEscapeAction.POINTER_DOWN)
    scheduler.advanceBy(900)
    sample(pointers = listOf(first.copy(x = first.x + 8), second))
    assertEquals(1, scheduler.tasks.size)
    scheduler.advanceBy(100)
    assertEquals(1, escapes)
  }

  @Test
  fun `lifting at 900 ms cancels and fresh two finger hold re-arms`() {
    sample(PrototypeEscapeAction.POINTER_DOWN)
    scheduler.advanceBy(900)
    sample(PrototypeEscapeAction.POINTER_UP, listOf(first))
    scheduler.advanceBy(100)
    assertEquals(0, escapes)
    sample(PrototypeEscapeAction.POINTER_DOWN)
    scheduler.advanceBy(1_000)
    assertEquals(1, escapes)
  }

  @Test
  fun `cancel disarms and a stale cancelled callback cannot reveal`() {
    sample(PrototypeEscapeAction.POINTER_DOWN)
    val stale = scheduler.tasks.last().block
    sample(PrototypeEscapeAction.CANCEL, emptyList())
    stale()
    scheduler.advanceBy(1_000)
    assertEquals(0, escapes)
    assertEquals(1, scheduler.cancelled)
    sample(PrototypeEscapeAction.POINTER_DOWN)
    scheduler.advanceBy(1_000)
    assertEquals(1, escapes)
    assertTrue(sample(PrototypeEscapeAction.CANCEL, emptyList()))
    assertFalse(sample(PrototypeEscapeAction.DOWN, listOf(first)))
  }
}
