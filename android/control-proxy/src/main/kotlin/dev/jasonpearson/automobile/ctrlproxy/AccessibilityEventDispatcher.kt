package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent

/**
 * Routes an accessibility event that passed the own-window filter: caret bookkeeping and the
 * frame-context token always, and the push work (interaction recording, hierarchy refresh) only
 * while a client is connected.
 */
internal class AccessibilityEventDispatcher(private val host: Host) {
  /** The service state and collaborators an event updates. */
  interface Host {
    /** Drops the remembered insert caret; focus or window moves invalidate it. */
    fun forgetRememberedInsert()

    fun onTextSelectionChanged(fromIndex: Int, toIndex: Int)

    fun onWindowStateChanged(className: String?)

    fun advanceFrameContext()

    fun connectionCount(): Int

    fun recordInteraction(event: AccessibilityEvent, dispatch: InteractionDispatch)

    fun refreshHierarchy()
  }

  fun dispatch(event: AccessibilityEvent) {
    when (event.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      AccessibilityEvent.TYPE_VIEW_FOCUSED,
      AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
      AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED -> host.forgetRememberedInsert()
      AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED ->
        host.onTextSelectionChanged(event.fromIndex, event.toIndex)
      else -> Unit
    }
    if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
      host.onWindowStateChanged(event.className?.toString())
    }

    // Advance the frameContext staleness token on every UI-changing event REGARDLESS of observers
    // (issue #5470 review). If it froze while unobserved, a token minted before the last client
    // disconnected could still pass the daemon/runner staleness check after reconnect even though
    // the screen changed during the gap, aiming an input action at the wrong UI state. This is a
    // cheap atomic increment maintaining the invariant; only the expensive work below is gated.
    if (advancesFrameContext(event.eventType)) {
      host.advanceFrameContext()
    }

    // "Is anyone observing?" gate (issue #5470). Both the interaction/scroll recording below and
    // the debounced hierarchy refresh further down are PUSH work only a connected client consumes,
    // so with zero connections we skip them — before touching event.source, allocating, extracting,
    // or hashing. The frameContext token above still advanced. Stale cross-session scroll deltas
    // are discarded at scroll-accumulation time via accumulatePendingScroll (keyed on the
    // observer-session generation), so no observer-gap cleanup is needed here. The pull path
    // (request_hierarchy) does not go through here and stays functional with zero observers.
    val work = accessibilityEventWorkFor(event.eventType, host.connectionCount())

    // Interaction classification is routed through the shared [interactionDispatchFor] so the
    // subscribed event-type mask (derived from the same classifier) can never drift from what the
    // controller actually acts on.
    work.interaction?.let { host.recordInteraction(event, it) }

    // The debouncer uses structural hash comparison to detect animation vs real changes. With no
    // client connected, work.refreshesHierarchy is false, so the extraction/hash is skipped.
    if (work.refreshesHierarchy) {
      host.refreshHierarchy()
    }
  }
}
