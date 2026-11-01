package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo

internal suspend fun startEventIngestionWhenReady(
  isRunning: () -> Boolean,
  pause: suspend () -> Unit,
  start: () -> Unit,
) {
  while (!isRunning()) pause()
  start()
}

/**
 * The interaction [CtrlProxy.onAccessibilityEvent] records for an accessibility event type. This is
 * the single classification primitive shared by the handler's `when` and by the derivation of the
 * subscribed event-type mask (issue #5467), so the "handled set" and the "subscribed set" cannot
 * drift — a new dispatch branch here automatically flows into [CtrlProxy.HANDLED_EVENT_TYPES].
 */
internal enum class InteractionDispatch {
  TAP,
  LONG_PRESS,
  CONTENT_CHANGED,
  NAVIGATE,
  SELECT,
  INPUT_TEXT,
  SCROLL,
}

/**
 * The interaction the handler's `when` performs for [eventType], or null if it ignores the type.
 */
internal fun interactionDispatchFor(eventType: Int): InteractionDispatch? =
  when (eventType) {
    AccessibilityEvent.TYPE_VIEW_CLICKED -> InteractionDispatch.TAP
    AccessibilityEvent.TYPE_VIEW_LONG_CLICKED -> InteractionDispatch.LONG_PRESS
    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> InteractionDispatch.CONTENT_CHANGED
    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> InteractionDispatch.NAVIGATE
    AccessibilityEvent.TYPE_VIEW_SELECTED -> InteractionDispatch.SELECT
    AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> InteractionDispatch.INPUT_TEXT
    AccessibilityEvent.TYPE_VIEW_SCROLLED -> InteractionDispatch.SCROLL
    else -> null
  }

/** True when the handler feeds [eventType] to the hierarchy debouncer for a fresh capture. */
internal fun triggersHierarchyRefresh(eventType: Int): Boolean =
  when (eventType) {
    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
    AccessibilityEvent.TYPE_WINDOWS_CHANGED,
    AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> true
    else -> false
  }

/**
 * True when [CtrlProxy.onAccessibilityEvent] acts on [eventType] at all (interaction or refresh).
 */
internal fun isHandledEventType(eventType: Int): Boolean =
  interactionDispatchFor(eventType) != null || triggersHierarchyRefresh(eventType)

/**
 * The per-event push work [CtrlProxy.onAccessibilityEvent] should perform: which interaction (if
 * any) to record, and whether to schedule a debounced hierarchy refresh (extraction + structural
 * hash). Both are pure over the classification helpers plus the observer count.
 */
internal data class AccessibilityEventWork(
  val interaction: InteractionDispatch?,
  val refreshesHierarchy: Boolean,
) {
  companion object {
    /** Nothing to do — no interaction recording and no hierarchy refresh (the expensive work). */
    val NONE = AccessibilityEventWork(interaction = null, refreshesHierarchy = false)
  }
}

/**
 * True only for an event from CtrlProxy's own window: an accessibility-overlay window (the
 * highlight overlay or the prototype) or, while an application-layer prototype is up
 * ([appLayerShowing]), a `TYPE_SYSTEM` window, which is how the system reports that layer.
 * CtrlProxy's package also owns the CtrlProxy keyboard (`TYPE_INPUT_METHOD`) and `MainActivity`
 * (`TYPE_APPLICATION`), whose events must still advance `frameContext` and refresh the hierarchy,
 * so they are never skipped. Fails open: an unknown window type ([windowType] null) is processed,
 * because handling one extra event is safe while dropping a keyboard event leaves stale key
 * coordinates passing the staleness check.
 */
internal fun shouldSkipOwnWindowEvent(
  eventPackage: String?,
  ownPackage: String,
  windowType: Int?,
  appLayerShowing: Boolean = false,
): Boolean =
  eventPackage == ownPackage &&
    (windowType == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY ||
      (appLayerShowing && windowType == AccessibilityWindowInfo.TYPE_SYSTEM))

/**
 * Window type of the window [event] came from, or null when it cannot be determined (no source
 * node, window not retrievable, or the node call throws). This binder-cost resolver is invoked only
 * on a window-type memo miss. Reads the source node's window rather than enumerating `windows`.
 */
internal fun ownEventWindowType(event: AccessibilityEvent): Int? {
  val source =
    try {
      event.source
    } catch (_: Exception) {
      // Fail open: a source that cannot be read leaves the type unknown, so the event is processed.
      return null
    }
  if (source == null) return null
  return try {
    val window = source.window
    try {
      window?.type
    } finally {
      window?.recycle()
    }
  } catch (_: Exception) {
    // Fail open: a window that cannot be read leaves the type unknown, so the event is processed.
    null
  } finally {
    try {
      source.recycle()
    } catch (_: Exception) {
      /* already recycled */
    }
  }
}

/**
 * True when [eventType] changes the UI enough to advance the `frameContext` staleness token. This
 * is DELIBERATELY independent of the observer count (issue #5470 review): the token must keep
 * advancing even while nobody is connected, otherwise a token minted before the last client
 * disconnected could still pass the daemon/runner frame-context staleness check after a reconnect
 * even though the screen changed during the gap — aiming an input action at the wrong UI state. The
 * set is exactly the original bump sites: the hierarchy-refresh types plus a scroll. Advancing the
 * token is a cheap atomic increment; only the EXPENSIVE extraction/recording/broadcast is gated on
 * an observer.
 */
internal fun advancesFrameContext(eventType: Int): Boolean =
  triggersHierarchyRefresh(eventType) ||
    interactionDispatchFor(eventType) == InteractionDispatch.SCROLL

/**
 * Pure "is anyone observing" gate (issue #5470). The two biggest continuous-work paths in
 * [CtrlProxy.onAccessibilityEvent] — per-interaction accessibility-node recording and the debounced
 * full-hierarchy extraction + structural hash — are background PUSH work that only a connected
 * client ever consumes, so with zero observers they are skipped entirely. The `frameContext`
 * staleness token is NOT gated here (see [advancesFrameContext]); it keeps advancing regardless.
 *
 * This does NOT govern the on-demand PULL path (`request_hierarchy` → `extractImmediately`): that
 * extracts the live accessibility tree directly and reads none of the push-path side effects
 * (frameContext counter, debouncer hash/cache), so it stays fully correct with zero prior push
 * activity and zero observers. Gating is race-tolerant by design — the count may change between
 * this check and use, costing at most one extra or one skipped frame around a connect/disconnect
 * edge.
 */
internal fun accessibilityEventWorkFor(
  eventType: Int,
  connectionCount: Int,
): AccessibilityEventWork =
  if (connectionCount > 0) {
    AccessibilityEventWork(
      interaction = interactionDispatchFor(eventType),
      refreshesHierarchy = triggersHierarchyRefresh(eventType),
    )
  } else {
    AccessibilityEventWork.NONE
  }

/**
 * Debounced-scroll accumulation (pending scroll X / Y / package name in
 * [InteractionEventController]) tagged with the [WebSocketServer.observerSessionGeneration] it was
 * accumulated under, modeled as an immutable value so the cross-session discard is unit-testable.
 */
internal data class PendingScroll(
  val deltaX: Int,
  val deltaY: Int,
  val packageName: String?,
  val sessionGeneration: Int,
) {
  companion object {
    /** No accumulation yet, under no session. */
    val NONE = PendingScroll(deltaX = 0, deltaY = 0, packageName = null, sessionGeneration = 0)
  }
}

/**
 * Fold one scroll sample into the pending accumulation, FIRST discarding any accumulation that
 * belongs to a prior observer session (issue #5470 review — the event-free-gap hole in the earlier
 * fix). Scroll deltas accumulate across the ~300ms scroll debounce; if a client disconnects and a
 * new one connects before the next scroll — even with no accessibility event in between — the
 * previous session's deltas must NOT combine with the new session's first scroll and broadcast a
 * bogus combined value.
 *
 * [currentGeneration] is [WebSocketServer.observerSessionGeneration], which advances only on the
 * empty→non-empty edge. When it differs from the accumulation's tagged
 * [PendingScroll.sessionGeneration] the observer set emptied and a new session began since the last
 * sample, so we start from [PendingScroll.NONE] before adding this sample; when it matches — a
 * client stayed continuously connected, including when a concurrent client merely joined — the
 * in-flight accumulation is preserved and nothing is dropped. The check runs at sample time, so it
 * is correct regardless of whether any event fired during the gap.
 */
internal fun accumulatePendingScroll(
  current: PendingScroll,
  deltaX: Int,
  deltaY: Int,
  packageName: String?,
  currentGeneration: Int,
): PendingScroll {
  val base = if (current.sessionGeneration == currentGeneration) current else PendingScroll.NONE
  return PendingScroll(
    deltaX = base.deltaX + deltaX,
    deltaY = base.deltaY + deltaY,
    packageName = packageName,
    sessionGeneration = currentGeneration,
  )
}
