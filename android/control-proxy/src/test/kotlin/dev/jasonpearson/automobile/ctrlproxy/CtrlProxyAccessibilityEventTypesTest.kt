package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Guards issue #5467: CtrlProxy subscribes to exactly the accessibility event types
 * onAccessibilityEvent handles (SUBSCRIBED_EVENT_TYPES_MASK) instead of TYPES_ALL_MASK, so the OS
 * stops delivering events the handler only drops. These tests pin the subscribed mask to the
 * handled set so the two cannot silently drift.
 */
@RunWith(RobolectricTestRunner::class)
class CtrlProxyAccessibilityEventTypesTest {

  /**
   * The event types onAccessibilityEvent actually dispatches on, transcribed here independently of
   * production so a future edit to the handler that forgets to update HANDLED_EVENT_TYPES fails
   * this test. Keep in lockstep with the `when`/`if` branches in CtrlProxy.onAccessibilityEvent.
   */
  private val expectedHandledTypes =
    setOf(
      AccessibilityEvent.TYPE_VIEW_CLICKED,
      AccessibilityEvent.TYPE_VIEW_LONG_CLICKED,
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
      AccessibilityEvent.TYPE_VIEW_SCROLLED,
      AccessibilityEvent.TYPE_VIEW_SELECTED,
    )

  @Test
  fun `handled set matches the types the handler dispatches on`() {
    assertEquals(expectedHandledTypes, CtrlProxy.HANDLED_EVENT_TYPES.toSet())
  }

  @Test
  fun `subscribed mask is exactly the union of the handled set`() {
    val union = expectedHandledTypes.fold(0) { acc, type -> acc or type }
    assertEquals(union, CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK)
  }

  @Test
  fun `subscribed mask contains every handled type`() {
    for (type in CtrlProxy.HANDLED_EVENT_TYPES) {
      assertEquals(
        "mask must contain handled type $type",
        type,
        CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK and type,
      )
    }
  }

  @Test
  fun `subscribed mask excludes representative unhandled types`() {
    val unhandled =
      listOf(
        AccessibilityEvent.TYPE_VIEW_HOVER_ENTER,
        AccessibilityEvent.TYPE_VIEW_HOVER_EXIT,
        AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_START,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
      )
    for (type in unhandled) {
      assertEquals(
        "mask must not subscribe to unhandled type $type",
        0,
        CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK and type,
      )
    }
  }

  @Test
  fun `subscribed mask is narrower than TYPES_ALL_MASK`() {
    assertNotEquals(AccessibilityEvent.TYPES_ALL_MASK, CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK)
    assertTrue(
      "subscribed mask must be a strict subset of TYPES_ALL_MASK",
      CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK and AccessibilityEvent.TYPES_ALL_MASK.inv() == 0,
    )
  }

  @Test
  fun `notification timeout is a modest positive coalescing window`() {
    // Must stay at or below the tightest interaction debounce so it never adds perceptible latency.
    assertTrue(CtrlProxy.ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS > 0)
    assertTrue(CtrlProxy.ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS <= 100L)
  }
}
