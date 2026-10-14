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
  fun `scrolling ignores content change types`() {
    for (changeTypes in listOf(0, AccessibilityEvent.CONTENT_CHANGE_TYPE_TEXT, -1)) {
      assertTrue(
        isCoalescibleAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SCROLLED, changeTypes),
      )
    }
  }

  @Test
  fun `undefined and subtree content changes are coalescible`() {
    for (changeTypes in listOf(0, AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE)) {
      assertTrue(
        isCoalescibleAccessibilityEvent(
          AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
          changeTypes,
        ),
      )
    }
  }

  @Test
  fun `announcement content changes pass through even when combined with subtree`() {
    val announcementTypes =
      listOf(
        AccessibilityEvent.CONTENT_CHANGE_TYPE_TEXT,
        AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_TITLE,
        AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED,
        AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_DISAPPEARED,
        AccessibilityEvent.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION,
        AccessibilityEvent.CONTENT_CHANGE_TYPE_CONTENT_DESCRIPTION,
      )
    for (changeTypes in announcementTypes) {
      assertFalse(
        isCoalescibleAccessibilityEvent(
          AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
          changeTypes,
        ),
      )
      assertFalse(
        isCoalescibleAccessibilityEvent(
          AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
          changeTypes or AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE,
        ),
      )
    }
  }

  @Test
  fun `unknown content change bits pass through`() {
    assertFalse(
      isCoalescibleAccessibilityEvent(
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
        Int.MIN_VALUE,
      ),
    )
  }

  @Test
  fun `other event types always pass through`() {
    for (eventType in
      listOf(
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
        AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      )) {
      assertFalse(isCoalescibleAccessibilityEvent(eventType, 0))
      assertFalse(
        isCoalescibleAccessibilityEvent(eventType, AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE),
      )
    }
  }
}
