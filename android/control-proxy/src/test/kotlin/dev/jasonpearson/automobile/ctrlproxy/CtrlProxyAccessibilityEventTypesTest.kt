package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Guards issue #5467: CtrlProxy subscribes to exactly the event types its handler acts on plus the
 * types the platform AccessibilityCache needs to stay coherent, instead of TYPES_ALL_MASK.
 *
 * These tests drive the SHARED dispatch classifier ([interactionDispatchFor] /
 * [triggersHierarchyRefresh]) that the real onAccessibilityEvent handler now routes through, so a
 * new handler branch added without extending the mask fails here — the test exercises real dispatch
 * classification rather than comparing two handwritten lists.
 */
@RunWith(RobolectricTestRunner::class)
class CtrlProxyAccessibilityEventTypesTest {

  /**
   * Independent transcription of the interaction the handler's `when` performs per type. If a
   * future edit changes [interactionDispatchFor] without updating this expectation the test fails,
   * and if it adds a handled type without adding it to the subscribed mask the derivation tests
   * below fail.
   */
  private val expectedInteractionDispatch =
    mapOf(
      AccessibilityEvent.TYPE_VIEW_CLICKED to InteractionDispatch.TAP,
      AccessibilityEvent.TYPE_VIEW_LONG_CLICKED to InteractionDispatch.LONG_PRESS,
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED to InteractionDispatch.CONTENT_CHANGED,
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED to InteractionDispatch.NAVIGATE,
      AccessibilityEvent.TYPE_VIEW_SELECTED to InteractionDispatch.SELECT,
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED to InteractionDispatch.INPUT_TEXT,
      AccessibilityEvent.TYPE_VIEW_SCROLLED to InteractionDispatch.SCROLL,
    )

  private val expectedHierarchyRefreshTypes =
    setOf(
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
    )

  /** Representative high-frequency noise the service must NOT subscribe to. */
  private val droppedNoiseTypes =
    listOf(
      AccessibilityEvent.TYPE_VIEW_HOVER_ENTER,
      AccessibilityEvent.TYPE_VIEW_HOVER_EXIT,
      AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_START,
      AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_END,
      AccessibilityEvent.TYPE_TOUCH_INTERACTION_START,
      AccessibilityEvent.TYPE_TOUCH_INTERACTION_END,
      AccessibilityEvent.TYPE_GESTURE_DETECTION_START,
      AccessibilityEvent.TYPE_GESTURE_DETECTION_END,
      AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED,
    )

  @Test
  fun `classifier dispatches each handled interaction type as expected`() {
    for ((type, dispatch) in expectedInteractionDispatch) {
      assertEquals("dispatch for type $type", dispatch, interactionDispatchFor(type))
    }
  }

  @Test
  fun `classifier ignores noise types`() {
    for (type in droppedNoiseTypes) {
      assertNull("noise type $type must not dispatch an interaction", interactionDispatchFor(type))
      assertFalse("noise type $type must not trigger refresh", triggersHierarchyRefresh(type))
      assertFalse("noise type $type must not be handled", isHandledEventType(type))
    }
  }

  @Test
  fun `hierarchy-refresh trigger set matches the handler`() {
    for (type in expectedHierarchyRefreshTypes) {
      assertTrue("type $type should trigger a hierarchy refresh", triggersHierarchyRefresh(type))
    }
  }

  @Test
  fun `handled set is exactly the types the shared classifier acts on`() {
    val expectedHandled = expectedInteractionDispatch.keys + expectedHierarchyRefreshTypes
    assertEquals(expectedHandled, CtrlProxy.HANDLED_EVENT_TYPES.toSet())
    // Every derived handled type is genuinely acted on by the shared classifier.
    for (type in CtrlProxy.HANDLED_EVENT_TYPES) {
      assertTrue("derived handled type $type must be handled", isHandledEventType(type))
    }
  }

  @Test
  fun `framework cache-coherence types are retained for focus and node correctness`() {
    val expectedCacheTypes =
      setOf(
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED,
        AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
      )
    assertEquals(expectedCacheTypes, CtrlProxy.FRAMEWORK_CACHE_EVENT_TYPES.toSet())
    // These are deliberately NOT app-handled — they exist solely so AccessibilityCache stays
    // coherent (rootInActiveWindow / findFocus must not go stale after a focus-only transition).
    for (type in CtrlProxy.FRAMEWORK_CACHE_EVENT_TYPES) {
      assertFalse("cache type $type should not be app-handled", isHandledEventType(type))
      assertEquals(
        "mask must subscribe to cache type $type",
        type,
        CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK and type,
      )
    }
  }

  @Test
  fun `subscribed mask is exactly the union of handled and framework-cache sets`() {
    val union =
      (CtrlProxy.HANDLED_EVENT_TYPES + CtrlProxy.FRAMEWORK_CACHE_EVENT_TYPES).fold(0) { acc, type ->
        acc or type
      }
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
  fun `subscribed mask excludes representative dropped noise types`() {
    for (type in droppedNoiseTypes) {
      assertEquals(
        "mask must not subscribe to dropped noise type $type",
        0,
        CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK and type,
      )
    }
  }

  @Test
  fun `subscribed mask is a strict subset of TYPES_ALL_MASK`() {
    assertNotEquals(AccessibilityEvent.TYPES_ALL_MASK, CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK)
    assertEquals(
      "subscribed mask must be a subset of TYPES_ALL_MASK",
      0,
      CtrlProxy.SUBSCRIBED_EVENT_TYPES_MASK and AccessibilityEvent.TYPES_ALL_MASK.inv(),
    )
  }

  @Test
  fun `notification timeout is a modest positive coalescing window`() {
    // Must stay at or below the tightest interaction debounce so it never adds perceptible latency.
    assertTrue(CtrlProxy.ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS > 0)
    assertTrue(CtrlProxy.ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS <= 100L)
  }
}
