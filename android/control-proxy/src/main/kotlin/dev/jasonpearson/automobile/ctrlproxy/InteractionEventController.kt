package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.InteractionElement
import dev.jasonpearson.automobile.ctrlproxy.models.InteractionEvent
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.Json

/**
 * Accessibility-event interaction intake: records tap, scroll, navigate and text interactions for
 * connected observers, debouncing input text, state-change and scroll samples, and broadcasts them
 * as `interaction_event` frames. Event classification, the observer gate and the hierarchy
 * debouncer stay in CtrlProxy. Everything that needs the live service or the late-bound WebSocket
 * server comes through [Host]; debounce clocks are read from the injected [TimeProvider].
 */
internal class InteractionEventController(
  private val host: Host,
  private val timeProvider: TimeProvider,
  private val jsonCompact: Json,
) {
  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host {
    /** Connected WebSocket clients; 0 while the server is not yet created. */
    fun connectionCount(): Int

    /** The observer-session generation, or 0 while the server is not yet created. */
    fun observerSessionGeneration(): Int

    fun isServerRunning(): Boolean

    suspend fun broadcast(message: String)

    /** The class name of the last window-state change, if any. */
    fun lastWindowClassName(): String?

    /** Launches [block] on the service scope. */
    fun launchInServiceScope(block: suspend CoroutineScope.() -> Unit)
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  // Debounce timestamps — @Volatile since interaction events may trigger coroutines
  @Volatile private var lastInputTextBroadcastMs: Long = 0
  private val inputTextDebounceMs: Long = 100

  @Volatile private var lastA11yFocusTapMs: Long = 0
  private val a11yFocusTapDebounceMs: Long = 200

  // Debounce for scroll events — accumulate delta and emit once per gesture.
  // Store extracted fields instead of the raw AccessibilityEvent because
  // Android recycles events after onAccessibilityEvent returns.
  private var lastScrollBroadcastMs: Long = 0
  private val scrollDebounceMs: Long = 300
  @Volatile private var pendingScrollDeltaX: Int = 0
  @Volatile private var pendingScrollDeltaY: Int = 0
  private var pendingScrollPackageName: String? = null

  // The WebSocketServer.observerSessionGeneration the pending scroll deltas were accumulated
  // under.
  // A change means the observer set emptied and a new session began since the last sample (issue
  // #5470 review); the next scroll discards the stale accumulation instead of combining across
  // sessions. A concurrent client joining does NOT change it, so an in-flight scroll is
  // preserved.
  @Volatile private var pendingScrollSessionGeneration: Int = 0

  /** Records the interaction [dispatch] classified for [event]. */
  fun record(event: AccessibilityEvent, dispatch: InteractionDispatch) {
    when (dispatch) {
      InteractionDispatch.TAP -> recordInteractionEvent(event, "tap")
      InteractionDispatch.LONG_PRESS -> recordInteractionEvent(event, "longPress")
      // Compose doesn't fire TYPE_VIEW_CLICKED — detect taps via content changes
      // on clickable elements. CONTENT_CHANGE_TYPE_STATE_DESCRIPTION (64) fires
      // when Compose state changes (e.g., button click updates counter).
      // CONTENT_CHANGE_TYPE_CONTENT_DESCRIPTION (4) fires on many Compose interactions.
      InteractionDispatch.CONTENT_CHANGED -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          val ct = event.contentChangeTypes
          // State description change = likely user interaction (Compose state update)
          if (ct and AccessibilityEvent.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION != 0) {
            recordDebouncedInteraction(event, "stateChange")
          }
        }
      }
      InteractionDispatch.NAVIGATE -> recordInteractionEvent(event, "navigate")
      InteractionDispatch.SELECT -> recordInteractionEvent(event, "select")
      InteractionDispatch.INPUT_TEXT -> {
        val now = timeProvider.currentTimeMillis()
        if (now - lastInputTextBroadcastMs >= inputTextDebounceMs) {
          lastInputTextBroadcastMs = now
          recordInteractionEvent(event, "inputText")
        }
      }
      // frameContext already advanced (unconditionally) by the caller; here we only do the
      // gated,
      // expensive scroll recording, which runs solely when observed.
      InteractionDispatch.SCROLL -> recordDebouncedScroll(event)
    }
  }

  private fun recordInteractionEvent(event: AccessibilityEvent, type: String) {
    // Observer gate (issue #5470): early-return BEFORE reading event.source / getBoundsInScreen
    // /
    // allocating when nobody is connected. onAccessibilityEvent already gates dispatch on the
    // same
    // count; this is the defensive backstop for the scroll/debounced callers, and
    // getConnectionCount
    // > 0 also implies the server is running.
    if (host.connectionCount() <= 0) {
      return
    }

    val element = interactionElement(event)

    val textValue =
      if (type == "inputText") {
        val textList = event.text
        if (textList.isNullOrEmpty()) null
        else textList.joinToString(separator = "") { it.toString() }
      } else {
        null
      }

    val scrollDeltaX =
      if (type == "scroll" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pendingScrollDeltaX.takeIf { it != 0 } ?: event.scrollDeltaX
      } else {
        null
      }
    val scrollDeltaY =
      if (type == "scroll" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pendingScrollDeltaY.takeIf { it != 0 } ?: event.scrollDeltaY
      } else {
        null
      }

    val interaction =
      InteractionEvent(
        type = type,
        timestamp = timeProvider.currentTimeMillis(),
        packageName = event.packageName?.toString(),
        screenClassName = host.lastWindowClassName(),
        element = element,
        text = textValue,
        scrollDeltaX = scrollDeltaX,
        scrollDeltaY = scrollDeltaY,
      )

    host.launchInServiceScope {
      try {
        broadcastInteractionEvent(interaction)
      } catch (e: CancellationException) {
        // Let cooperative cancellation unwind cleanly rather than logging it as an error
        // (#3130).
        throw e
      } catch (e: java.io.IOException) {
        Log.e(TAG, "Error broadcasting interaction event", e)
      } catch (e: IllegalStateException) {
        Log.e(TAG, "Error broadcasting interaction event", e)
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Error broadcasting interaction event", e)
      }
    }
  }

  /**
   * Debounce scroll events — accumulate deltas and emit once scrolling stops. TYPE_VIEW_SCROLLED
   * fires many times per scroll gesture (every frame).
   */
  private fun recordDebouncedScroll(event: AccessibilityEvent) {
    val now = timeProvider.currentTimeMillis()
    // Only observed events reach here (the onAccessibilityEvent gate), so
    // observerSessionGeneration
    // reflects the current session. Fold this sample in through accumulatePendingScroll, which
    // discards any accumulation tagged with a prior session first — closing the event-free-gap
    // hole
    // where a disconnect+reconnect between samples would otherwise let stale deltas combine
    // with
    // the
    // first post-reconnect scroll (issue #5470 review). The generation is stable while any
    // client
    // stays connected, so a concurrent client joining mid-scroll does not drop the in-flight
    // deltas.
    // Store extracted fields, not the event reference (Android recycles it).
    val sampleDeltaX = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) event.scrollDeltaX else 0
    val sampleDeltaY = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) event.scrollDeltaY else 0
    val currentGeneration = host.observerSessionGeneration()
    val accumulated =
      accumulatePendingScroll(
        PendingScroll(
          pendingScrollDeltaX,
          pendingScrollDeltaY,
          pendingScrollPackageName,
          pendingScrollSessionGeneration,
        ),
        sampleDeltaX,
        sampleDeltaY,
        event.packageName?.toString(),
        currentGeneration,
      )
    pendingScrollDeltaX = accumulated.deltaX
    pendingScrollDeltaY = accumulated.deltaY
    pendingScrollPackageName = accumulated.packageName
    pendingScrollSessionGeneration = accumulated.sessionGeneration

    if (now - lastScrollBroadcastMs >= scrollDebounceMs) {
      lastScrollBroadcastMs = now
      recordInteractionEvent(event, "scroll")
      pendingScrollDeltaX = 0
      pendingScrollDeltaY = 0
      pendingScrollPackageName = null
    }
  }

  /**
   * Record an interaction event with debouncing to avoid duplicates. Used for
   * TYPE_VIEW_ACCESSIBILITY_FOCUSED which fires alongside TYPE_VIEW_CLICKED.
   */
  private fun recordDebouncedInteraction(event: AccessibilityEvent, type: String) {
    val now = timeProvider.currentTimeMillis()
    if (now - lastA11yFocusTapMs >= a11yFocusTapDebounceMs) {
      lastA11yFocusTapMs = now
      recordInteractionEvent(event, type)
    }
  }

  private suspend fun broadcastInteractionEvent(interaction: InteractionEvent) {
    if (!host.isServerRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping interaction event broadcast")
      return
    }

    host.broadcast(
      interactionEventFrame(interaction.timestamp, jsonCompact.encodeToString(interaction)),
    )
  }
}

private fun interactionElement(event: AccessibilityEvent): InteractionElement? {
  val source =
    try {
      event.source
    } catch (_: IllegalStateException) {
      null
    }
  val bounds = source?.let {
    try {
      val rect = Rect()
      it.getBoundsInScreen(rect)
      ElementBounds(rect)
    } catch (_: IllegalStateException) {
      null
    }
  }
  // Build element from source node, falling back to event-level data
  val element =
    if (source != null) {
      InteractionElement(
        text = source.text?.toString(),
        contentDescription = source.contentDescription?.toString(),
        resourceId = source.viewIdResourceName,
        className = source.className?.toString(),
        bounds = bounds,
      )
    } else {
      eventInteractionElement(event)
    }
  try {
    source?.recycle()
  } catch (_: IllegalStateException) {
    /* already recycled */

  }

  return element
}

private fun eventInteractionElement(event: AccessibilityEvent): InteractionElement? {
  // Fallback: extract what we can from the AccessibilityEvent itself
  val eventText = event.text.joinToString("") { it.toString() }.takeIf { it.isNotEmpty() }
  val eventDesc = event.contentDescription?.toString()
  val eventClass = event.className?.toString()
  return if (eventText != null || eventDesc != null || eventClass != null) {
    InteractionElement(
      text = eventText,
      contentDescription = eventDesc,
      resourceId = null,
      className = eventClass,
      bounds = null,
    )
  } else null
}
