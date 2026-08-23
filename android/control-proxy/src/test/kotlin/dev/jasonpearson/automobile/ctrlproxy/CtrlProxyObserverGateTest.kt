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

  // ---------------------------------------------------------------------------
  // Review regressions (issue #5470): the gate must skip only expensive work, not
  // invariant-maintaining bookkeeping.
  // ---------------------------------------------------------------------------

  /**
   * Bug 1: the frameContext staleness token must keep advancing on UI-changing events even with
   * zero observers. [advancesFrameContext] is the pure decision the call site increments on, and it
   * takes NO connection count — so the token advances regardless of how many clients are connected.
   * Were it gated, a stale pre-disconnect token could survive a UI change across an observer gap
   * and wrongly pass the reconnect staleness check.
   */
  @Test
  fun `frameContext advances on UI-change events independent of observers`() {
    // The bump set is exactly the scroll interaction plus every hierarchy-refresh type — and the
    // decision does not consult the connection count, so it holds at zero observers.
    assertTrue(
      "scroll must advance frameContext",
      advancesFrameContext(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_SCROLLED),
    )
    for (type in refreshTypes) {
      assertTrue("refresh type $type must advance frameContext", advancesFrameContext(type))
    }
    // Non-UI-changing interactions (a click/select) do not advance the token, matching the original
    // bump sites (only scroll among interactions bumped).
    assertFalse(
      "a click must not advance frameContext",
      advancesFrameContext(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_CLICKED),
    )
    assertFalse(
      "a select must not advance frameContext",
      advancesFrameContext(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_SELECTED),
    )
    // Same event types, evaluated as if unobserved: advancesFrameContext ignores observers
    // entirely,
    // so the token still advances (call site bumps unconditionally on these).
    assertEquals(
      "advancesFrameContext must match the exact refresh + scroll bump set",
      refreshTypes.toSet() + android.view.accessibility.AccessibilityEvent.TYPE_VIEW_SCROLLED,
      (refreshTypes + interactionTypes).filter { advancesFrameContext(it) }.toSet(),
    )
  }

  /**
   * Bug 2: a still-connected client's in-flight scroll accumulation must never be dropped — while
   * the observer-session generation is unchanged, successive samples add together as before.
   */
  @Test
  fun `pending scroll accumulates within a single observer session`() {
    val generation = 7
    var pending = PendingScroll.NONE
    pending =
      accumulatePendingScroll(pending, deltaX = 10, deltaY = -5, packageName = "com.a", generation)
    pending =
      accumulatePendingScroll(pending, deltaX = 4, deltaY = -1, packageName = "com.a", generation)

    assertEquals("deltas combine within a session", 14, pending.deltaX)
    assertEquals(-6, pending.deltaY)
    assertEquals("com.a", pending.packageName)
    assertEquals(generation, pending.sessionGeneration)
  }

  /**
   * Bug 2 (event-free gap): pending deltas accumulated under one observer session must NOT combine
   * with the first scroll of a NEW session. The discard is keyed on the observer-session
   * generation, which advances after the observer set empties and a new client connects —
   * regardless of whether any accessibility event fired in the gap — so "accumulate under
   * generation 7, next sample under generation 8" models a disconnect+reconnect with no intervening
   * event.
   */
  @Test
  fun `pending scroll deltas do not combine across an observer session change`() {
    // Session 7: an in-flight scroll accumulates but has not yet been flushed/broadcast.
    val stale =
      accumulatePendingScroll(
        PendingScroll.NONE,
        deltaX = 40,
        deltaY = -120,
        packageName = "com.old.session",
        currentGeneration = 7,
      )
    assertEquals(40, stale.deltaX)

    // The only client disconnects and a new one connects with NO event in between: the generation
    // has advanced to 8 by the time the first post-reconnect scroll sample arrives.
    val firstAfterReconnect =
      accumulatePendingScroll(
        stale,
        deltaX = 3,
        deltaY = 9,
        packageName = "com.new.session",
        currentGeneration = 8,
      )

    // Must start clean from the new sample, NOT 40 + 3 / -120 + 9.
    assertEquals("stale deltaX must be discarded, not combined", 3, firstAfterReconnect.deltaX)
    assertEquals("stale deltaY must be discarded, not combined", 9, firstAfterReconnect.deltaY)
    assertEquals("com.new.session", firstAfterReconnect.packageName)
    assertEquals(8, firstAfterReconnect.sessionGeneration)
  }

  /**
   * Regression (Codex on the epoch approach): a SECOND concurrent client joining while the first is
   * still connected must NOT reset a still-accumulating scroll. Because the observer-session
   * generation is stable for as long as any client stays connected (it advances only on the
   * empty→non-empty edge, not on a 1→2 join), the tagged generation is unchanged and the in-flight
   * deltas keep accumulating rather than being truncated for every client.
   */
  @Test
  fun `a concurrent second client does not reset an in-flight scroll`() {
    val generation = 5 // stable while >= 1 client stays connected, including across a 1 -> 2 join
    var pending = PendingScroll.NONE
    pending =
      accumulatePendingScroll(pending, deltaX = 30, deltaY = 0, packageName = "com.a", generation)
    // A second client connects mid-scroll — generation is unchanged (no empty->non-empty edge).
    pending =
      accumulatePendingScroll(pending, deltaX = 12, deltaY = 0, packageName = "com.a", generation)

    assertEquals(
      "in-flight deltas must keep accumulating across a concurrent join",
      42,
      pending.deltaX,
    )
    assertEquals(generation, pending.sessionGeneration)
  }
}
