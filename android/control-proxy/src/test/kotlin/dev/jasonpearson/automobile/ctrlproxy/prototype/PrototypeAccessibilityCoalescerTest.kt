package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityEvent
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAccessibilityCoalescer.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeAccessibilityCoalescerTest {
  private var now = 0L
  private val coalescer = PrototypeAccessibilityCoalescer({ now })

  @Test
  fun `a hundred event burst emits once and schedules exactly one trailing event`() {
    val actions =
      List(100) { index ->
        now = index.toLong()
        coalescer.onCoalescible()
      }
    assertEquals(Action.EMIT_NOW, actions[0])
    assertEquals(Action.SCHEDULE_TRAILING, actions[1])
    assertEquals(1, actions.count { it == Action.EMIT_NOW })
    assertEquals(1, actions.count { it == Action.SCHEDULE_TRAILING })
    assertEquals(98, actions.count { it == Action.NONE })
    assertEquals(151L, coalescer.remainingMs())
  }

  @Test
  fun `the trailing emission starts a new window`() {
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
    now = 10
    assertEquals(Action.SCHEDULE_TRAILING, coalescer.onCoalescible())
    assertEquals(240L, coalescer.remainingMs())
    now = 250
    coalescer.onTrailingFired()
    now = 251
    assertEquals(Action.SCHEDULE_TRAILING, coalescer.onCoalescible())
    assertEquals(249L, coalescer.remainingMs())
    assertEquals(Action.NONE, coalescer.onCoalescible())
  }

  @Test
  fun `an event at the quiet interval boundary emits immediately`() {
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
    now = 250
    assertEquals(0L, coalescer.remainingMs())
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
    now = 1_000
    assertEquals(0L, coalescer.remainingMs())
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
  }

  @Test
  fun `reset forgets both the pending callback and the last emission`() {
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
    now = 1
    assertEquals(Action.SCHEDULE_TRAILING, coalescer.onCoalescible())
    coalescer.reset()
    assertEquals(0L, coalescer.remainingMs())
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
    assertEquals(Action.SCHEDULE_TRAILING, coalescer.onCoalescible())
  }

  @Test
  fun `a late callback cannot lose its pending trailing emission`() {
    assertEquals(Action.EMIT_NOW, coalescer.onCoalescible())
    now = 1
    assertEquals(Action.SCHEDULE_TRAILING, coalescer.onCoalescible())
    now = 300
    assertEquals(0L, coalescer.remainingMs())
    assertEquals(Action.NONE, coalescer.onCoalescible())
    coalescer.onTrailingFired()
    assertEquals(Action.SCHEDULE_TRAILING, coalescer.onCoalescible())
  }

  @Test
  fun `only content changes and scrolling are coalescible`() {
    assertTrue(isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED))
    assertTrue(isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SCROLLED))
    assertFalse(isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED))
    assertFalse(isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED))
    assertFalse(isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED))
    assertFalse(isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_WINDOWS_CHANGED))
  }
}
