package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Guards issue #5470: the two biggest continuous-work paths in onAccessibilityEvent —
 * per-interaction accessibility-node recording and the debounced full-hierarchy extraction +
 * structural hash — are gated on a connected client, while the on-demand pull path
 * (request_hierarchy) stays functional with zero observers and zero prior push activity.
 */
@RunWith(RobolectricTestRunner::class)
class CtrlProxyObserverGateTest {

  /** Event types exercising both gated push paths: an interaction and a hierarchy refresh. */
  private val interactionTypes =
    listOf(
      android.view.accessibility.AccessibilityEvent.TYPE_VIEW_CLICKED,
      android.view.accessibility.AccessibilityEvent.TYPE_VIEW_SCROLLED,
      android.view.accessibility.AccessibilityEvent.TYPE_VIEW_SELECTED,
    )

  private val refreshTypes =
    listOf(
      android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
      android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      android.view.accessibility.AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      android.view.accessibility.AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
    )

  @Test
  fun `zero connections skips all interaction and hierarchy push work`() {
    for (type in interactionTypes + refreshTypes) {
      val work = accessibilityEventWorkFor(type, connectionCount = 0)
      assertNull("type $type must record no interaction when unobserved", work.interaction)
      assertFalse(
        "type $type must trigger no hierarchy refresh when unobserved",
        work.refreshesHierarchy,
      )
    }
  }

  @Test
  fun `a connected client restores the classifier's normal dispatch and refresh`() {
    for (type in interactionTypes) {
      val work = accessibilityEventWorkFor(type, connectionCount = 1)
      assertEquals(
        "observed interaction dispatch must match the shared classifier for type $type",
        interactionDispatchFor(type),
        work.interaction,
      )
    }
    for (type in refreshTypes) {
      val work = accessibilityEventWorkFor(type, connectionCount = 1)
      assertTrue(
        "type $type must trigger a hierarchy refresh when observed",
        work.refreshesHierarchy,
      )
    }
  }

  @Test
  fun `gate is a strict greater-than-zero, not merely nonzero`() {
    // A defensive/hypothetical negative count is treated as unobserved, not as "some observer".
    assertEquals(
      AccessibilityEventWork.NONE,
      accessibilityEventWorkFor(interactionTypes.first(), -1),
    )
    assertEquals(AccessibilityEventWork.NONE, accessibilityEventWorkFor(refreshTypes.first(), 0))
  }

  /**
   * The pull path (request_hierarchy → extractNowBlocking) must produce a correct hierarchy without
   * any prior push activity: no onAccessibilityEvent() call, no frameContext bumps, a stale/zero
   * structural hash. extractNowBlocking extracts the live tree directly and returns it, so it reads
   * none of the push-path side effects the gate now skips. This mirrors
   * HierarchyDebouncerErrorEmitTest (no device required — the extractor is faked).
   */
  @Test
  fun `pull path extracts a fresh hierarchy with zero prior push activity`() {
    val extractCalls = AtomicInteger(0)
    val expected = ViewHierarchy(packageName = "com.example.pull")
    val debouncer =
      HierarchyDebouncer(
        scope = CoroutineScope(Dispatchers.Unconfined),
        extractHierarchy = { _: Boolean, _: HierarchySnapshotOptions ->
          extractCalls.incrementAndGet()
          expected
        },
      )

    // No onAccessibilityEvent() has ever run — the push path is fully idle/gated.
    val pulled = debouncer.extractNowBlocking(skipFlowEmit = true)

    assertNotNull("pull must return a hierarchy even with an idle push path", pulled)
    assertEquals("com.example.pull", pulled?.packageName)
    assertEquals(
      "pull must trigger a fresh extraction, not reuse push-path state",
      1,
      extractCalls.get(),
    )
  }
}
