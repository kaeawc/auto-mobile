package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Point
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.PowerManager
import android.provider.Settings
import android.text.Spanned
import android.text.style.ClickableSpan
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.awaitImeServiceReady
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles
import dev.jasonpearson.automobile.ctrlproxy.ime.session.SharedPreferencesKeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.FrameMetricsSnapshot
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.InteractionElement
import dev.jasonpearson.automobile.ctrlproxy.models.InteractionEvent
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionSnapshot
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SystemBarsInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemChromeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.MutablePerfEntry
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfRequestContext
import dev.jasonpearson.automobile.ctrlproxy.perf.SystemTimeProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDisplays
import dev.jasonpearson.automobile.ctrlproxy.prototype.BitmapPrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.ComposePrototypeFontLoader
import dev.jasonpearson.automobile.ctrlproxy.prototype.CoroutinePrototypeScheduler
import dev.jasonpearson.automobile.ctrlproxy.prototype.DefaultPrototypeHost
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetDirectory
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetStore
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBase64Decoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEventSink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeFontCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeForegroundTracker
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeForegroundWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHiddenCapture
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImeInset
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImeWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLifecycle
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeResultSink
import dev.jasonpearson.automobile.ctrlproxy.prototype.imeLiftPx
import dev.jasonpearson.automobile.ctrlproxy.prototype.isPrototypeWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeForegroundFromWindows
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import dev.jasonpearson.automobile.protocol.AnrData
import dev.jasonpearson.automobile.protocol.AnrEvent
import dev.jasonpearson.automobile.protocol.BroadcastEventData
import dev.jasonpearson.automobile.protocol.BroadcastEventResponse
import dev.jasonpearson.automobile.protocol.CrashData
import dev.jasonpearson.automobile.protocol.CrashEvent
import dev.jasonpearson.automobile.protocol.DeviceInfo
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.FrameMetricsData
import dev.jasonpearson.automobile.protocol.FrameMetricsEventResponse
import dev.jasonpearson.automobile.protocol.HandledExceptionData
import dev.jasonpearson.automobile.protocol.HandledExceptionEvent
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import dev.jasonpearson.automobile.protocol.KeyboardProfileBehaviorInfo
import dev.jasonpearson.automobile.protocol.KeyboardProfileInfo
import dev.jasonpearson.automobile.protocol.LifecycleEventData
import dev.jasonpearson.automobile.protocol.LifecycleEventResponse
import dev.jasonpearson.automobile.protocol.NavigationEventData
import dev.jasonpearson.automobile.protocol.NavigationEventResponse
import dev.jasonpearson.automobile.protocol.NetworkEventData
import dev.jasonpearson.automobile.protocol.NetworkEventResponse
import dev.jasonpearson.automobile.protocol.NodeSelector
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import dev.jasonpearson.automobile.protocol.ScreenshotResult as ProtocolScreenshotResult
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SdkHandledExceptionEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.protocol.SdkNotificationActionEvent
import dev.jasonpearson.automobile.protocol.SdkRecompositionSnapshotEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.WebSocketFrameData
import dev.jasonpearson.automobile.protocol.WebSocketFrameResponse
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import dev.jasonpearson.automobile.sdk.logging.AutoMobileLog
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.math.max
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

/**
 * Prefer the first resource-id match kept by the extractor's offscreen rule, falling back to the
 * original depth-first first match. The caller owns the root and the returned node; children
 * acquired during either pass are recycled unless returned.
 */
internal fun findNodeByResourceId(
  root: AccessibilityNodeInfo?,
  resourceId: String,
  screenDimensions: ScreenDimensions?,
): AccessibilityNodeInfo? {
  fun findMatch(node: AccessibilityNodeInfo?, requireOnScreen: Boolean): AccessibilityNodeInfo? {
    if (node == null) return null

    val nodeResourceId = node.viewIdResourceName
    if (
      nodeResourceId != null &&
        (nodeResourceId == resourceId || nodeResourceId.endsWith(":id/$resourceId"))
    ) {
      if (!requireOnScreen) return node
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      if (!ElementBounds(bounds).isCompletelyOffscreen(screenDimensions)) return node
    }

    for (i in 0 until node.childCount) {
      val child = node.getChild(i) ?: continue
      var found: AccessibilityNodeInfo? = null
      try {
        found = findMatch(child, requireOnScreen)
        if (found != null) return found
      } finally {
        if (found !== child) child.recycle()
      }
    }
    return null
  }

  // Invalid dimensions must retain the original first-match behavior without a bounds check.
  if (screenDimensions?.isValid() == true) {
    findMatch(root, requireOnScreen = true)?.let {
      return it
    }
  }
  return findMatch(root, requireOnScreen = false)
}

/** Resolve dimensions from the lookup root without querying or selecting other windows. */
internal fun findNodeByResourceIdOnRootDisplay(
  root: AccessibilityNodeInfo?,
  resourceId: String,
  dimensionsProvider: (Int) -> ScreenDimensions?,
): AccessibilityNodeInfo? {
  val dimensions =
    try {
      val displayId =
        if (root == null) {
          null
        } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
          Display.DEFAULT_DISPLAY
        } else {
          root.window?.let { window ->
            try {
              window.displayId
            } finally {
              window.recycle()
            }
          }
        }
      displayId?.let(dimensionsProvider)
    } catch (e: Exception) {
      Log.w("CtrlProxy", "Failed to get lookup root screen dimensions", e)
      null
    }
  return findNodeByResourceId(root, resourceId, dimensions)
}

internal data class NodeSelectorFields(
  val resourceId: String?,
  val testTag: String?,
  val uniqueId: String?,
  val collectionRow: Int?,
  val collectionColumn: Int?,
)

internal fun nodeSelectorMatches(selector: NodeSelector, fields: NodeSelectorFields): Boolean {
  if (!selector.hasCriteria()) return false
  if (
    selector.resourceId != null &&
      (fields.resourceId == null ||
        (fields.resourceId != selector.resourceId &&
          !fields.resourceId.endsWith(":id/${selector.resourceId}")))
  ) {
    return false
  }
  if (selector.testTag != null && fields.testTag != selector.testTag) return false
  if (selector.uniqueId != null && fields.uniqueId != selector.uniqueId) return false
  if (selector.collectionRow != null && fields.collectionRow != selector.collectionRow) return false
  if (selector.collectionColumn != null && fields.collectionColumn != selector.collectionColumn) {
    return false
  }
  return true
}

internal suspend fun startEventIngestionWhenReady(
  isRunning: () -> Boolean,
  pause: suspend () -> Unit,
  start: () -> Unit,
) {
  while (!isRunning()) pause()
  start()
}

internal fun nodeActionFailure(action: String, availableActionIds: Collection<Int>?): String? {
  val actionId = nodeActionId(action) ?: return "Unsupported accessibility action: $action"
  if (availableActionIds != null && actionId !in availableActionIds) {
    return "Accessibility action is unavailable: $action"
  }
  return null
}

/** What to do with a node action request given the node's current state (issue #10148). */
internal sealed interface NodeActionDecision {
  /** Send [actionId] to the node. */
  data class Perform(val actionId: Int) : NodeActionDecision

  /** The node is already in the requested state; no action is sent and the request succeeds. */
  data object AlreadySatisfied : NodeActionDecision

  /** The request cannot be honored; [message] is the failure reported to the host. */
  data class Refused(val message: String) : NodeActionDecision
}

/**
 * Accessibility focus is state, not a one-shot action: a node holding accessibility focus
 * advertises only ACTION_CLEAR_ACCESSIBILITY_FOCUS and an unfocused node only
 * ACTION_ACCESSIBILITY_FOCUS. So `focus` on an already-focused node and `clear_focus` on an
 * unfocused node are satisfied as-is, rather than refused as "unavailable". Every other case keeps
 * the availability check.
 */
internal fun decideNodeAction(
  action: String,
  isAccessibilityFocused: Boolean,
  availableActionIds: Collection<Int>?,
): NodeActionDecision {
  if (action == "focus" && isAccessibilityFocused) return NodeActionDecision.AlreadySatisfied
  if (action == "clear_focus" && !isAccessibilityFocused) return NodeActionDecision.AlreadySatisfied
  nodeActionFailure(action, availableActionIds)?.let {
    return NodeActionDecision.Refused(it)
  }
  val actionId = nodeActionId(action)
  return if (actionId == null) {
    NodeActionDecision.Refused("Unsupported accessibility action: $action")
  } else {
    NodeActionDecision.Perform(actionId)
  }
}

internal fun nodeActionId(action: String): Int? =
  when (action) {
    "click" -> AccessibilityNodeInfo.ACTION_CLICK
    "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
    "focus" -> AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
    "clear_focus" -> AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS
    "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
    "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
    else -> null
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
 * True only for an event from CtrlProxy's own overlay window: an accessibility-overlay window (the
 * highlight overlay or the prototype) or, while an application-layer prototype is up
 * ([appLayerShowing]), a `TYPE_SYSTEM` window, which is how the system reports that layer.
 * CtrlProxy's package also owns the CtrlProxy keyboard (`TYPE_INPUT_METHOD`) and `MainActivity`
 * (`TYPE_APPLICATION`), whose events must still advance `frameContext` and refresh the hierarchy,
 * so they are never skipped. Fails open: an unknown window type ([windowType] null) is processed,
 * because handling one extra event is safe while dropping a keyboard event leaves stale key
 * coordinates passing the staleness check.
 */
internal fun shouldSkipOwnOverlayEvent(
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
 * node, window not retrievable, or the node call throws). Reads the source node's window rather
 * than enumerating `windows`, so no window list is allocated per event.
 */
private fun ownEventWindowType(event: AccessibilityEvent): Int? {
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
 * Debounced-scroll accumulation ([CtrlProxy.pendingScrollDeltaX] / `Y` / package name) tagged with
 * the [WebSocketServer.observerSessionGeneration] it was accumulated under, modeled as an immutable
 * value so the cross-session discard is unit-testable.
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

internal fun navigationEventResponse(event: TimestampedNavigationEvent): NavigationEventResponse =
  NavigationEventResponse(
    timestamp = event.timestamp,
    event =
      NavigationEventData(
        destination = event.destination,
        source = event.source,
        arguments = event.arguments.takeIf { it.isNotEmpty() },
        metadata = event.metadata.takeIf { it.isNotEmpty() },
        applicationId = event.applicationId,
        sequenceNumber = event.sequenceNumber,
      ),
  )

/** Android multi-user range: a package uid is `userId * PER_USER_RANGE + appId`. */
internal const val PACKAGE_EVENT_USER_ID_RANGE = 100_000

/**
 * The Android user id for a package broadcast's `Intent.EXTRA_UID` (#10067). The extra is the
 * package's kernel uid (e.g. 10234 for user 0, 1010234 for user 10), not a user id; an absent extra
 * (`-1`) means the primary user.
 */
internal fun packageEventUserId(uid: Int): Int =
  if (uid >= 0) uid / PACKAGE_EVENT_USER_ID_RANGE else 0

/**
 * The `package_event` payload. `userId` is the Android user id; `uid` carries the raw package uid
 * when known and doubles as the marker that `userId` is a real user id: APKs that predate #10067
 * sent the uid in `userId` and no `uid`, which the host converts itself.
 */
internal fun packageEventJson(
  action: String,
  packageName: String,
  userId: Int,
  uid: Int?,
  isSystem: Boolean?,
  removedForAllUsers: Boolean,
): JsonObject = buildJsonObject {
  put("action", action)
  put("packageName", packageName)
  put("userId", userId)
  if (uid != null) {
    put("uid", uid)
  }
  if (isSystem != null) {
    put("isSystem", isSystem)
  }
  if (removedForAllUsers) {
    put("removedForAllUsers", true)
  }
}

internal fun crashEventTimestamp(reportedMs: Long, nowMs: Long): Long =
  if (reportedMs > 0) reportedMs else nowMs

internal fun crashEventResponse(
  timestamp: Long,
  exceptionClass: String,
  exceptionMessage: String?,
  stackTrace: String,
  threadName: String,
  currentScreen: String?,
  packageName: String,
  appVersion: String?,
  deviceModel: String,
  deviceManufacturer: String,
  osVersion: String,
  sdkInt: Int,
): CrashEvent =
  CrashEvent(
    timestamp = timestamp,
    event =
      CrashData(
        exceptionClass = exceptionClass,
        message = exceptionMessage,
        stackTrace = stackTrace,
        threadName = threadName,
        currentScreen = currentScreen,
        packageName = packageName,
        appVersion = appVersion,
        deviceInfo =
          DeviceInfo(
            model = deviceModel,
            manufacturer = deviceManufacturer,
            osVersion = osVersion,
            sdkInt = sdkInt,
          ),
      ),
  )

internal fun handledExceptionEventResponse(
  timestamp: Long,
  exceptionClass: String,
  exceptionMessage: String?,
  stackTrace: String,
  customMessage: String?,
  currentScreen: String?,
  packageName: String,
  appVersion: String?,
  deviceModel: String,
  deviceManufacturer: String,
  osVersion: String,
  sdkInt: Int,
): HandledExceptionEvent =
  HandledExceptionEvent(
    timestamp = timestamp,
    event =
      HandledExceptionData(
        exceptionClass = exceptionClass,
        message = exceptionMessage,
        stackTrace = stackTrace,
        customMessage = customMessage,
        currentScreen = currentScreen,
        packageName = packageName,
        appVersion = appVersion,
        deviceInfo =
          DeviceInfo(
            model = deviceModel,
            manufacturer = deviceManufacturer,
            osVersion = osVersion,
            sdkInt = sdkInt,
          ),
      ),
  )

/**
 * Owns the "serialize once → write file → broadcast → always release the frame-context entry"
 * sequence for a single hierarchy delivery (issue #5469 follow-up).
 *
 * Serialization was hoisted out of the writer/broadcaster's own try/catch so a change is serialized
 * at most once (the one [serialize] result is reused for both [write] and [broadcast]). That move
 * exposed a leak: [CtrlProxy.extractedHierarchyFrameContexts] is a strong-keyed identity map that
 * only the broadcaster removed from, so an encode failure (e.g. a NaN/Infinity `textSizeInPx`)
 * before the broadcast would retain a full hierarchy forever. Centralizing the sequence guarantees
 * [releaseFrameContext] runs in a `finally` even when [serialize] throws, so no call site can
 * serialize-then-leak.
 *
 * A failure in [serialize] (or [write]/[broadcast]) skips the remaining steps and rethrows so the
 * caller drops just that one frame; the frame-context entry is released regardless. This function
 * is pure over its injected seams — no Android or service state — so it is unit-testable with a
 * counting serializer and fake writer/broadcaster.
 */
internal suspend fun deliverHierarchyFrame(
  serialize: () -> String,
  write: (String) -> Unit,
  broadcast: suspend (String) -> Unit,
  releaseFrameContext: () -> Unit,
) {
  try {
    val serialized = serialize()
    write(serialized)
    broadcast(serialized)
  } finally {
    // Runs on every path: on success the broadcaster already removed the entry (this is a no-op
    // safety net); on a serialize/write/broadcast failure this is the only removal, closing the
    // leak. remove() is idempotent, so the redundant success-path call is harmless.
    releaseFrameContext()
  }
}

/**
 * Main AutoMobile Accessibility Service that provides view hierarchy extraction capabilities for
 * automated testing and UI interaction.
 */
class CtrlProxy : AccessibilityService(), CtrlProxyActions {

  companion object {
    private const val TAG = "CtrlProxy"

    // File name for app-scoped storage
    private const val HIERARCHY_FILE_NAME = "latest_hierarchy.json"
    private const val DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250L
    private const val REMEMBER_TTL_MS = 5_000L

    /**
     * The universe of accessibility event types we classify for subscription. [HANDLED_EVENT_TYPES]
     * is DERIVED by filtering this through the shared [isHandledEventType] classifier, so the
     * app-dispatched subscription set is computed from the exact predicate the handler dispatches
     * on — it cannot be hand-mis-copied out of sync with [interactionDispatchFor] /
     * [triggersHierarchyRefresh]. Extend this only if a handler branch ever dispatches on a type
     * not already listed here.
     */
    @Suppress("DEPRECATION")
    private val CANDIDATE_EVENT_TYPES: IntArray =
      intArrayOf(
        AccessibilityEvent.TYPE_VIEW_CLICKED,
        AccessibilityEvent.TYPE_VIEW_LONG_CLICKED,
        AccessibilityEvent.TYPE_VIEW_SELECTED,
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
        AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED,
        AccessibilityEvent.TYPE_VIEW_HOVER_ENTER,
        AccessibilityEvent.TYPE_VIEW_HOVER_EXIT,
        AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_START,
        AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_END,
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
        AccessibilityEvent.TYPE_VIEW_SCROLLED,
        AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
        AccessibilityEvent.TYPE_ANNOUNCEMENT,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED,
        AccessibilityEvent.TYPE_VIEW_TEXT_TRAVERSED_AT_MOVEMENT_GRANULARITY,
        AccessibilityEvent.TYPE_GESTURE_DETECTION_START,
        AccessibilityEvent.TYPE_GESTURE_DETECTION_END,
        AccessibilityEvent.TYPE_TOUCH_INTERACTION_START,
        AccessibilityEvent.TYPE_TOUCH_INTERACTION_END,
        AccessibilityEvent.TYPE_WINDOWS_CHANGED,
        AccessibilityEvent.TYPE_VIEW_CONTEXT_CLICKED,
        AccessibilityEvent.TYPE_ASSIST_READING_CONTEXT,
        AccessibilityEvent.TYPE_SPEECH_STATE_CHANGE,
        AccessibilityEvent.TYPE_VIEW_TARGETED_BY_SCROLL,
      )

    /**
     * App-dispatched event types [onAccessibilityEvent] acts on, DERIVED from the shared
     * [isHandledEventType] classifier over [CANDIDATE_EVENT_TYPES] rather than hand-listed, so it
     * stays in lockstep with the handler's `when` / hierarchy-refresh `if`.
     */
    val HANDLED_EVENT_TYPES: IntArray =
      CANDIDATE_EVENT_TYPES.filter { isHandledEventType(it) }.toIntArray()

    /**
     * Event types the platform `AccessibilityCache` / `AccessibilityInteractionClient` consume to
     * keep their node & focus caches coherent. We MUST stay subscribed to these even though
     * [onAccessibilityEvent] ignores them: the cache only invalidates its focus/node state for an
     * event when the service is subscribed to that event, so after a focus-only transition an
     * unsubscribed service would let `rootInActiveWindow` / `findFocus` return STALE nodes to
     * `observe` and `handleGetCurrentFocus` — the core AutoMobile read paths. Cross-checked against
     * AOSP `AccessibilityCache.onAccessibilityEvent`; the window/content/scroll/text/click/select
     * types that also invalidate the cache are already in [HANDLED_EVENT_TYPES], and the union
     * below absorbs the overlap.
     */
    val FRAMEWORK_CACHE_EVENT_TYPES: IntArray =
      intArrayOf(
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED,
        AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
      )

    /**
     * OS-level `eventTypes` subscription mask: the union of [HANDLED_EVENT_TYPES] and
     * [FRAMEWORK_CACHE_EVENT_TYPES], replacing the former `TYPES_ALL_MASK`. High-frequency noise
     * the service never consumes — hover, touch-exploration, touch-interaction, gesture-detection,
     * announcement, notification-state, text-traversal, context-click, speech-state, etc. — is no
     * longer delivered.
     */
    val SUBSCRIBED_EVENT_TYPES_MASK: Int =
      (HANDLED_EVENT_TYPES + FRAMEWORK_CACHE_EVENT_TYPES).fold(0) { acc, type -> acc or type }

    /**
     * `notificationTimeout` coalesces bursts of same-type events at the OS boundary before
     * delivery. 100 ms matches the tightest interaction debounce the handler already applies
     * ([inputTextDebounceMs]) and sits well under the scroll debounce (300 ms) and hierarchy
     * broadcast interval (250 ms), so it collapses event floods without adding perceptible latency
     * to the interaction/telemetry or hierarchy-refresh paths the debouncers rely on.
     */
    const val ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS = 100L

    // Broadcast actions
    const val ACTION_EXTRACT_HIERARCHY = "dev.jasonpearson.automobile.EXTRACT_HIERARCHY"

    // Result broadcast actions
    const val ACTION_OPERATION_RESULT = "dev.jasonpearson.automobile.OPERATION_RESULT"

    /**
     * Pure bitmask computation for [applyAccessibilityFlags], extracted so the equality check that
     * guards the disruptive `serviceInfo =` reassignment (see call site) is unit-testable without a
     * live [AccessibilityService]/Robolectric harness.
     */
    internal fun computeAccessibilityServiceFlags(
      currentFlags: Int,
      includeNotImportantViews: Boolean,
      reportViewIds: Boolean,
      retrieveInteractiveWindows: Boolean,
    ): Int {
      var flags = currentFlags

      flags =
        if (includeNotImportantViews) {
          flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        } else {
          flags and AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS.inv()
        }

      flags =
        if (reportViewIds) {
          flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        } else {
          flags and AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS.inv()
        }

      flags =
        if (retrieveInteractiveWindows) {
          flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        } else {
          flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS.inv()
        }

      return flags
    }

    /**
     * Preserves the legacy `systemInsets` contract for gesture callers while typed categories
     * remain available under `insets`. Pre-CtrlProxy observation merged system-gesture edges into
     * this field, and swipe/pinch still use it to avoid Android's back-gesture region.
     */
    internal fun legacySystemInsets(insets: ObservationInsetsInfo): SystemInsetsInfo? {
      val bars = insets.systemBars?.stable ?: return null
      val gestures = insets.systemGestures ?: return bars
      return SystemInsetsInfo(
        top = max(bars.top, gestures.top),
        bottom = max(bars.bottom, gestures.bottom),
        left = max(bars.left, gestures.left),
        right = max(bars.right, gestures.right),
      )
    }
  }

  /**
   * Emits a `type:"error"` frame when a `serviceScope.launch { … }` throws uncaught. Correlation is
   * recovered from [RequestIdContext], which request-correlated raw launches attach through
   * [launchRequestScope]. Its [ServiceScopeGuard.handler] is installed on [serviceScope] below.
   * `emitScope` resolves [serviceScope] lazily to break the scope↔handler construction cycle (the
   * handler re-launches its fallback broadcast on the same scope); the broadcast sink resolves
   * [webSocketServer] lazily because it is `lateinit` (assigned in [onServiceConnected]). See
   * [AsyncActionRunner] / [ResultBroadcaster] for the sibling seams on the dispatch and result-send
   * paths.
   */
  private val serviceScopeGuard: ServiceScopeGuard =
    ServiceScopeGuard(
      emitScope = { serviceScope },
      broadcastResponse = { response ->
        if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
          webSocketServer.broadcast(response)
        }
      },
      logError = { message, error -> Log.e(TAG, message, error) },
    )

  private val serviceScope: CoroutineScope =
    CoroutineScope(Dispatchers.IO + SupervisorJob() + serviceScopeGuard.handler)

  /**
   * The DEDICATED thread streamed gestures are driven on — deliberately NOT the main thread.
   * `StrokeDescription.continueStroke` must be issued promptly after the previous stroke completes
   * or the framework cancels the continued gesture; the main thread runs the accessibility-event
   * and hierarchy work (e.g. a ~460ms `hierarchyDebouncer` pass) that would stall a continuation
   * posted there long enough to trip that cancel. A private [HandlerGestureThread] keeps the
   * continuation cadence off that contention. The gesture state machine is single-threaded, so
   * every gesture mutation and pump is funnelled onto this one thread (see [GestureStreamSession]);
   * WebSocket requests arrive on [serviceScope]'s IO threads and hand their work here.
   */
  // Android constructs services without arguments. Resolve this after construction so tests can
  // supply a deterministic queue before onCreate, without starting a real HandlerThread.
  internal var gestureThreadFactory: () -> GestureThread = ::HandlerGestureThread
  private val gestureThread by lazy { gestureThreadFactory() }
  private val gestureHandler: Handler
    get() = gestureThread.handler

  internal var dragDeadline: GestureDeadline = GestureDeadline { delayMs, onTimeout ->
    val task = Runnable { onTimeout() }
    check(gestureHandler.postDelayed(task, delayMs)) { "Gesture thread rejected drag deadline" }
    val cancel: () -> Unit = { gestureHandler.removeCallbacks(task) }
    cancel
  }

  internal var dragResultReporter: (String?, GestureDispatchOutcome) -> Unit =
    { requestId, outcome ->
      if (outcome.completed) {
        Log.d(
          TAG,
          "Drag completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
        )
      } else {
        Log.w(TAG, "Drag failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
      }
      launchRequestScope(requestId) {
        broadcastDragResult(
          requestId,
          outcome.completed,
          outcome.error,
          outcome.totalTimeMs,
          outcome.gestureTimeMs,
        )
      }
    }

  private val gestureStreamRouter =
    GestureStreamRouter(
      runOnGestureThread = { gestureThread.post(it) },
      newSession = { onFinished ->
        GestureStreamSession(
          coordinator = GestureStreamCoordinator(),
          dispatcher = AccessibilityStrokeDispatcher(),
          runOnGestureThread = { gestureThread.post(it) },
          onFinished = onFinished,
        )
      },
      onResult = ::broadcastGestureResult,
      logWarning = { Log.w(TAG, it) },
    )

  private class ImeCommitState {
    val cancelled = AtomicBoolean(false)
    val finished = CompletableDeferred<ImeCommitResult>()
  }

  // Cancelled IDs remain tombstoned until service shutdown. Request IDs are UUIDs; retaining a
  // cancellation prevents a delayed request from starting after its cancellation was acknowledged.
  private val imeCommitStates = java.util.concurrent.ConcurrentHashMap<String, ImeCommitState>()

  /**
   * Launches request-correlated raw work with [RequestIdContext] attached so [serviceScopeGuard]
   * can emit a correlated error frame if the launch throws before a guarded result helper runs.
   */
  private fun launchRequestScope(
    requestId: String?,
    block: suspend CoroutineScope.() -> Unit,
  ): Job =
    serviceScope.launch(context = RequestIdContext(requestId) + PerfRequestContext(requestId)) {
      perfProvider.withRequestScope(requestId) {
        block()
      }
    }

  /**
   * Wraps fire-and-forget action launches so a throw inside the launched coroutine broadcasts a
   * correlated `type:"error"` frame instead of dying silently and hanging the daemon awaiter. See
   * [AsyncActionRunner] and issue #3023. The broadcast lambda resolves [webSocketServer] lazily
   * because it is `lateinit` (assigned in [onServiceConnected]).
   */
  private val asyncActionRunner =
    AsyncActionRunner(
      scope = serviceScope,
      broadcastResponse = { response ->
        if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
          webSocketServer.broadcast(response)
        }
      },
      logError = { message, error -> Log.e(TAG, message, error) },
    )

  /**
   * Guards every `broadcast*Result` / `broadcast*Error` / `broadcast*Response` helper so a throw
   * while *sending* a result (a socket write or serialization failure) emits a correlated
   * `type:"error"` frame instead of being logged and swallowed — closing the one-layer-down
   * silent-hang gap from issue #3045. The `broadcastError` sink resolves [webSocketServer] lazily
   * because it is `lateinit` (assigned in [onServiceConnected]), and no-ops when the server is not
   * running — there is then no socket to send the fallback on, so the awaiter falls back to its
   * timeout, the same as the double-failure tail. See [ResultBroadcaster].
   */
  private val resultBroadcaster =
    ResultBroadcaster(
      broadcastError = { response ->
        if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
          webSocketServer.broadcast(response)
        }
      },
      logError = { message, error -> Log.e(TAG, message, error) },
    )
  private val recompositionStore = RecompositionStore()
  private val frameMetricsStore = FrameMetricsStore()
  internal val workStats = CtrlProxyWorkStats()
  private val viewHierarchyExtractor =
    ViewHierarchyExtractor(
      recompositionStore,
      workStats,
      prototypeSuspended = {
        ::prototypeController.isInitialized && prototypeController.isSuspendedByForeground
      },
      ownPrototypeMetadata = { windowPackage, title ->
        // The prototype-type check already ran in the extractor; this confirms the window is ours.
        if (
          isPrototypeWindow(
            AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
            title,
            windowPackage,
            packageName,
          ) && ::prototypeController.isInitialized
        )
          prototypeController.windowMetadata()
        else null
      },
    )
  private val jsonCompact = Json {
    prettyPrint = false
    encodeDefaults = true
  }
  private val jsonLenient = Json { ignoreUnknownKeys = true }

  private fun webSocketFrameJson(
    type: String,
    timestamp: Long = System.currentTimeMillis(),
    requestId: String? = null,
    perfTiming: JsonElement? = null,
    buildContent: JsonObjectBuilder.() -> Unit,
  ): String =
    jsonCompact.encodeToString(
      buildJsonObject {
        put("type", type)
        put("timestamp", timestamp)
        if (requestId != null) {
          put("requestId", requestId)
        }
        buildContent()
        if (perfTiming != null) {
          put("perfTiming", perfTiming)
        }
      },
    )

  private val perfProvider = PerfProvider.instance
  private val timeProvider: TimeProvider = SystemTimeProvider()
  private lateinit var webSocketServer: WebSocketServer
  private val webSocketLifecycle = ServerLifecycle<WebSocketServer> { it.stop() }
  private lateinit var hierarchyDebouncer: HierarchyDebouncer
  private lateinit var rotationProvenance: RotationProvenanceTracker
  private var deviceStateRegistration: AutoCloseable? = null
  private val navigationEventAccumulator = NavigationEventAccumulator()
  private val sdkEventBatchProcessor by lazy {
    SdkEventBatchProcessor(
      scope = serviceScope,
      navigationEventAccumulator = navigationEventAccumulator,
      broadcastNavigationEvent = { event ->
        broadcastNavigationEvent(
          event,
          mode = WebSocketServer.BroadcastMode.Sync,
          waitForClient = true,
        )
      },
      broadcastSdkEvent = { event ->
        broadcastSdkEvent(
          event,
          mode = WebSocketServer.BroadcastMode.Sync,
          waitForClient = true,
        )
      },
    )
  }
  private lateinit var prototypeController: PrototypeController
  // Hides the prototype while another app is in front, restores it on return (#10261).
  private val prototypeForeground by lazy {
    PrototypeForegroundTracker(
      CoroutinePrototypeScheduler(serviceScope),
      ownPackage = packageName,
      foregroundNow = ::currentForegroundApp,
      onChanged = { refreshPrototypeWindowNow() },
    )
  }
  private val prototypeResultSink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) =
        sendWithMissingAssets(requestId, success, error, emptyList())

      override suspend fun sendWithMissingAssets(
        requestId: String?,
        success: Boolean,
        error: String?,
        missingAssets: List<String>,
      ) {
        if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
          resultBroadcaster.guard(requestId, "prototype_result") {
            webSocketServer.broadcastWithPerf { _ ->
              prototypeResultFrame(requestId, success, error, missingAssets)
            }
          }
        }
      }

      override suspend fun sendPrototypeStatus(
        requestId: String?,
        prototypes: List<PrototypeStatusEntry>,
        droppedEvents: Long,
      ) {
        if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
          resultBroadcaster.guard(requestId, "prototype_result") {
            webSocketServer.broadcastWithPerf { _ ->
              prototypeStatusFrame(requestId, prototypes, droppedEvents)
            }
          }
        }
      }
    }
  // Asset bytes live in the cache directory, never in the heap; cleared with the prototype session.
  // Assets are owned by the observer session that uploaded them, and file deletion runs on IO so a
  // main-thread clear or lookup never touches the disk.
  private val prototypeAssets by lazy {
    PrototypeAssetStore(
      PrototypeAssetDirectory(File(cacheDir, "prototype-assets")),
      session = {
        if (::webSocketServer.isInitialized) webSocketServer.observerSessionGeneration() else 0
      },
      fileWorker = Dispatchers.IO.asExecutor(),
    )
  }
  // Decoded bitmaps of stored assets, dropped as soon as the store replaces, removes or clears one.
  private val prototypeImages by lazy {
    PrototypeImageCache(prototypeAssets, BitmapPrototypeImageDecoder()).also { images ->
      // The store has one listener slot, so fan a change out to both caches.
      prototypeAssets.setChangeListener { ids ->
        images.invalidate(ids)
        prototypeFonts.invalidate(ids)
      }
    }
  }
  // Loaded custom fonts (`fontFamily: {asset}`), dropped when the store changes an asset.
  private val prototypeFonts by lazy {
    PrototypeFontCache(prototypeAssets, ComposePrototypeFontLoader())
  }
  private val prototypeAssetController by lazy {
    PrototypeAssetController(
      prototypeAssets,
      prototypeResultSink,
      PrototypeBase64Decoder { Base64.decode(it, Base64.DEFAULT) },
    )
  }
  private lateinit var overlayManager: OverlayManager
  private val permissionManager by lazy { PermissionManager(this) }
  private lateinit var overlayDrawer: OverlayDrawer
  private val clipboardManager by lazy {
    getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  }
  private val devicePolicyManager by lazy {
    getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
  }
  private val deviceAdminComponent by lazy {
    ComponentName(this, AutoMobileDeviceAdminReceiver::class.java)
  }
  @Volatile private var lastWindowClassName: String? = null
  /**
   * Changes immediately on a native UI event; capture and input share this device-owned context.
   */
  private val frameContext = AtomicLong(0)
  /** Fresh for every service process, preventing a restarted runner from reusing an old token. */
  private val frameContextEpoch = UUID.randomUUID().toString()

  private fun currentFrameContext(): String = "$frameContextEpoch:${frameContext.get()}"

  // A hierarchy has object identity for its short trip from extraction to broadcast. Retaining the
  // extraction-time token lets broadcast fail closed if an accessibility event intervenes.
  private val extractedHierarchyFrameContexts: MutableMap<ViewHierarchy, String> =
    Collections.synchronizedMap(IdentityHashMap<ViewHierarchy, String>())

  // Not an AccessibilityServiceInfo flag — read directly by extractHierarchyDirect/extractHierarchy
  // when calling into ViewHierarchyExtractor. Set via setAccessibilityFlags (--no-occlusion).
  @Volatile private var occlusionEnabled: Boolean = true

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

  // The WebSocketServer.observerSessionGeneration the pending scroll deltas were accumulated under.
  // A change means the observer set emptied and a new session began since the last sample (issue
  // #5470 review); the next scroll discards the stale accumulation instead of combining across
  // sessions. A concurrent client joining does NOT change it, so an in-flight scroll is preserved.
  @Volatile private var pendingScrollSessionGeneration: Int = 0

  private data class ScreenshotCapturePayload(
    val base64Image: String,
    val rotation: Int?,
    val displayId: Int,
    val panelUniqueId: String?,
    val captureDurationMs: Long,
    val encodeDurationMs: Long,
    val byteLength: Int,
    val base64Length: Int,
  )

  /**
   * Raw result of the platform takeScreenshot callback, carrying the failure code (issue #4927).
   */
  private sealed interface ScreenshotCallbackResult {
    data class Captured(val bitmap: Bitmap, val rotation: Int?) : ScreenshotCallbackResult

    data class Failed(val errorCode: Int?) : ScreenshotCallbackResult
  }

  /**
   * Outcome of [takeScreenshotAsync]: an encoded payload, or a failure that retains the platform
   * error code so the broadcast can surface a rate limit distinctly instead of a generic failure.
   */
  private sealed interface ScreenshotCaptureOutcome {
    data class Success(val payload: ScreenshotCapturePayload) : ScreenshotCaptureOutcome

    data class Failure(val errorCode: Int?) : ScreenshotCaptureOutcome
  }

  // Job for collecting hierarchy flow results
  private var hierarchyFlowJob: Job? = null

  // Job for collecting navigation event updates
  private var navigationEventJob: Job? = null

  // Job for collecting storage change events
  private var storageChangeJob: Job? = null

  // Storage subscription manager for SharedPreferences inspection
  private lateinit var storageSubscriptionManager: StorageSubscriptionManager

  // Logcat reader for automatic log capture
  private var logcatReader: LogcatReader? = null
  private var logEventBuffer: BoundedLogBuffer? = null

  private val commandReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null) {
          Log.w(TAG, "no intent")
          return
        }

        Log.d(TAG, "Received broadcast: ${intent.action}")

        serviceScope.launch {
          try {
            handleCommand(intent)
          } catch (e: CancellationException) {
            // Cooperative cancellation (service scope shutting down) must never become an error
            // result — let it propagate so the coroutine unwinds cleanly. Mirrors the inner
            // ACTION_EXTRACT_HIERARCHY rethrow (PR #3126), which would otherwise be re-swallowed
            // here (issue #3130).
            throw e
          } catch (e: Exception) {
            Log.e(TAG, "Error handling command: ${intent.action}", e)
            sendResult(success = false, error = e.message)
          }
        }
      }
    }

  private val navigationEventReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileSDK.ACTION_NAVIGATION_EVENT) {
          return
        }

        try {
          // Try type-safe deserialization first (new protocol)
          val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
          if (eventJson != null) {
            val event = SdkEventSerializer.navigationEventFromJson(eventJson)
            if (event != null) {
              Log.d(
                TAG,
                "Received navigation event (protocol): ${event.destination} from ${event.source} (app: ${event.applicationId})",
              )
              if (
                !sdkEventBatchProcessor.enqueueNavigationEvent(
                  destination = event.destination,
                  source = event.source.name,
                  arguments = event.arguments ?: emptyMap(),
                  metadata = event.metadata ?: emptyMap(),
                  applicationId = event.applicationId,
                  timestamp = event.timestamp,
                )
              ) {
                Log.w(TAG, "Dropping navigation event because the SDK event queue is full")
              }
              return
            }
          }

          // Fallback to legacy extras for backward compatibility
          val destination = intent.getStringExtra(AutoMobileSDK.EXTRA_DESTINATION) ?: return
          val source = intent.getStringExtra(AutoMobileSDK.EXTRA_SOURCE) ?: return
          val applicationId = intent.getStringExtra(AutoMobileSDK.EXTRA_APPLICATION_ID)

          // Extract arguments (prefixed with "arg_")
          val arguments = mutableMapOf<String, String>()
          val metadata = mutableMapOf<String, String>()

          intent.extras?.keySet()?.forEach { key ->
            when {
              key.startsWith("arg_") -> {
                intent.getStringExtra(key)?.let { value ->
                  arguments[key.removePrefix("arg_")] = value
                }
              }
              key.startsWith("meta_") -> {
                intent.getStringExtra(key)?.let { value ->
                  metadata[key.removePrefix("meta_")] = value
                }
              }
            }
          }

          Log.d(
            TAG,
            "Received navigation event (legacy): $destination from $source (app: $applicationId)",
          )
          if (
            !sdkEventBatchProcessor.enqueueNavigationEvent(
              destination = destination,
              source = source,
              arguments = arguments,
              metadata = metadata,
              applicationId = applicationId,
              timestamp = System.currentTimeMillis(),
            )
          ) {
            Log.w(TAG, "Dropping navigation event because the SDK event queue is full")
          }
        } catch (e: Exception) {
          Log.e(TAG, "Error handling navigation event broadcast", e)
        }
      }
    }

  private val recompositionReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT) {
          return
        }

        val payload = intent.getStringExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_SNAPSHOT) ?: return
        try {
          val snapshot = jsonLenient.decodeFromString(serializer<RecompositionSnapshot>(), payload)
          recompositionStore.updateSnapshot(snapshot)
        } catch (e: Exception) {
          Log.e(TAG, "Failed to parse recomposition snapshot", e)
        }
      }
    }

  private val frameMetricsReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT) {
          return
        }

        val payload = intent.getStringExtra(AutoMobileSDK.EXTRA_FRAME_METRICS_SNAPSHOT) ?: return
        try {
          val snapshot = jsonLenient.decodeFromString(serializer<FrameMetricsSnapshot>(), payload)
          frameMetricsStore.updateSnapshot(snapshot)
          // Forward live so the host can feed real app-frame data into perfSnapshot.
          if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
            val response =
              FrameMetricsEventResponse(
                timestamp = snapshot.timestamp,
                frameMetrics =
                  FrameMetricsData(
                    applicationId = snapshot.applicationId,
                    fps = snapshot.fps,
                    frameTimeMs = snapshot.frameTimeMs,
                    jankFrames = snapshot.jankFrames,
                    totalFrames = snapshot.totalFrames,
                  ),
              )
            serviceScope.launch { webSocketServer.broadcast(response) }
          }
        } catch (e: Exception) {
          Log.e(TAG, "Failed to parse frame metrics snapshot", e)
        }
      }
    }

  private val packageReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null) {
          return
        }

        val action = intent.action ?: return
        if (
          action != Intent.ACTION_PACKAGE_ADDED &&
            action != Intent.ACTION_PACKAGE_REMOVED &&
            action != Intent.ACTION_PACKAGE_REPLACED
        ) {
          return
        }

        val packageName = intent.data?.schemeSpecificPart ?: return
        val uid = intent.getIntExtra(Intent.EXTRA_UID, -1)
        val userId = packageEventUserId(uid)
        val isReplacing = intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)
        // EXTRA_REMOVED_FOR_ALL_USERS may not be available in all SDK versions, use string
        // literal
        val removedForAllUsers =
          intent.getBooleanExtra("android.intent.extra.REMOVED_FOR_ALL_USERS", false)

        val eventAction =
          when (action) {
            Intent.ACTION_PACKAGE_ADDED -> if (isReplacing) "replaced" else "added"
            Intent.ACTION_PACKAGE_REMOVED -> if (isReplacing) null else "removed"
            Intent.ACTION_PACKAGE_REPLACED -> "replaced"
            else -> null
          } ?: return

        val isSystem =
          if (eventAction == "removed") {
            null
          } else {
            resolveSystemApp(packageName)
          }

        Log.d(
          TAG,
          "Package event: $eventAction $packageName (userId=$userId, removedForAllUsers=$removedForAllUsers)",
        )

        serviceScope.launch {
          broadcastPackageEvent(
            eventAction,
            packageName,
            userId,
            uid.takeIf { it >= 0 },
            isSystem,
            removedForAllUsers,
          )
        }
      }
    }

  private val handledExceptionReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileFailures.ACTION_HANDLED_EXCEPTION) {
          return
        }

        try {
          // Try type-safe deserialization first (new protocol)
          val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
          if (eventJson != null) {
            val event = SdkEventSerializer.handledExceptionEventFromJson(eventJson)
            if (event != null) {
              Log.d(
                TAG,
                "Received handled exception (protocol): ${event.exceptionClass} from ${event.applicationId}",
              )

              serviceScope.launch {
                broadcastHandledExceptionEvent(
                  timestamp = event.timestamp,
                  exceptionClass = event.exceptionClass,
                  exceptionMessage = event.exceptionMessage,
                  stackTrace = event.stackTrace,
                  customMessage = event.customMessage,
                  currentScreen = event.currentScreen,
                  packageName = event.applicationId ?: "unknown",
                  appVersion = event.appVersion,
                  deviceModel = event.deviceInfo?.model ?: "unknown",
                  deviceManufacturer = event.deviceInfo?.manufacturer ?: "unknown",
                  osVersion = event.deviceInfo?.osVersion ?: "unknown",
                  sdkInt = event.deviceInfo?.sdkInt ?: 0,
                )
              }
              return
            }
          }

          // Fallback to legacy extras for backward compatibility
          val timestamp = intent.getLongExtra(AutoMobileFailures.EXTRA_TIMESTAMP, 0L)
          val exceptionClass =
            intent.getStringExtra(AutoMobileFailures.EXTRA_EXCEPTION_CLASS) ?: return
          val exceptionMessage = intent.getStringExtra(AutoMobileFailures.EXTRA_EXCEPTION_MESSAGE)
          val stackTrace = intent.getStringExtra(AutoMobileFailures.EXTRA_STACK_TRACE) ?: return
          val customMessage = intent.getStringExtra(AutoMobileFailures.EXTRA_CUSTOM_MESSAGE)
          val currentScreen = intent.getStringExtra(AutoMobileFailures.EXTRA_CURRENT_SCREEN)
          val packageName = intent.getStringExtra(AutoMobileFailures.EXTRA_PACKAGE_NAME) ?: return
          val appVersion = intent.getStringExtra(AutoMobileFailures.EXTRA_APP_VERSION)
          val deviceModel =
            intent.getStringExtra(AutoMobileFailures.EXTRA_DEVICE_MODEL) ?: "unknown"
          val deviceManufacturer =
            intent.getStringExtra(AutoMobileFailures.EXTRA_DEVICE_MANUFACTURER) ?: "unknown"
          val osVersion = intent.getStringExtra(AutoMobileFailures.EXTRA_OS_VERSION) ?: "unknown"
          val sdkInt = intent.getIntExtra(AutoMobileFailures.EXTRA_SDK_INT, 0)

          Log.d(TAG, "Received handled exception (legacy): $exceptionClass from $packageName")

          serviceScope.launch {
            broadcastHandledExceptionEvent(
              timestamp = timestamp,
              exceptionClass = exceptionClass,
              exceptionMessage = exceptionMessage,
              stackTrace = stackTrace,
              customMessage = customMessage,
              currentScreen = currentScreen,
              packageName = packageName,
              appVersion = appVersion,
              deviceModel = deviceModel,
              deviceManufacturer = deviceManufacturer,
              osVersion = osVersion,
              sdkInt = sdkInt,
            )
          }
        } catch (e: Exception) {
          Log.e(TAG, "Error handling handled exception broadcast", e)
        }
      }
    }

  private val crashReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileCrashes.ACTION_CRASH) {
          return
        }

        try {
          // Try type-safe deserialization first (new protocol)
          val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
          if (eventJson != null) {
            val event = SdkEventSerializer.crashEventFromJson(eventJson)
            if (event != null) {
              Log.d(
                TAG,
                "Received crash (protocol): ${event.exceptionClass} from ${event.applicationId}",
              )

              serviceScope.launch {
                broadcastCrashEvent(
                  timestamp = event.timestamp,
                  exceptionClass = event.exceptionClass,
                  exceptionMessage = event.exceptionMessage,
                  stackTrace = event.stackTrace,
                  threadName = event.threadName,
                  currentScreen = event.currentScreen,
                  packageName = event.applicationId ?: "unknown",
                  appVersion = event.appVersion,
                  deviceModel = event.deviceInfo?.model ?: "unknown",
                  deviceManufacturer = event.deviceInfo?.manufacturer ?: "unknown",
                  osVersion = event.deviceInfo?.osVersion ?: "unknown",
                  sdkInt = event.deviceInfo?.sdkInt ?: 0,
                )
              }
              return
            }
          }

          // Fallback to legacy extras for backward compatibility
          val timestamp = intent.getLongExtra(AutoMobileCrashes.EXTRA_TIMESTAMP, 0L)
          val exceptionClass =
            intent.getStringExtra(AutoMobileCrashes.EXTRA_EXCEPTION_CLASS) ?: return
          val exceptionMessage = intent.getStringExtra(AutoMobileCrashes.EXTRA_EXCEPTION_MESSAGE)
          val stackTrace = intent.getStringExtra(AutoMobileCrashes.EXTRA_STACK_TRACE) ?: return
          val threadName = intent.getStringExtra(AutoMobileCrashes.EXTRA_THREAD_NAME) ?: "unknown"
          val currentScreen = intent.getStringExtra(AutoMobileCrashes.EXTRA_CURRENT_SCREEN)
          val packageName = intent.getStringExtra(AutoMobileCrashes.EXTRA_PACKAGE_NAME) ?: return
          val appVersion = intent.getStringExtra(AutoMobileCrashes.EXTRA_APP_VERSION)
          val deviceModel = intent.getStringExtra(AutoMobileCrashes.EXTRA_DEVICE_MODEL) ?: "unknown"
          val deviceManufacturer =
            intent.getStringExtra(AutoMobileCrashes.EXTRA_DEVICE_MANUFACTURER) ?: "unknown"
          val osVersion = intent.getStringExtra(AutoMobileCrashes.EXTRA_OS_VERSION) ?: "unknown"
          val sdkInt = intent.getIntExtra(AutoMobileCrashes.EXTRA_SDK_INT, 0)

          Log.d(TAG, "Received crash (legacy): $exceptionClass from $packageName")

          serviceScope.launch {
            broadcastCrashEvent(
              timestamp = timestamp,
              exceptionClass = exceptionClass,
              exceptionMessage = exceptionMessage,
              stackTrace = stackTrace,
              threadName = threadName,
              currentScreen = currentScreen,
              packageName = packageName,
              appVersion = appVersion,
              deviceModel = deviceModel,
              deviceManufacturer = deviceManufacturer,
              osVersion = osVersion,
              sdkInt = sdkInt,
            )
          }
        } catch (e: Exception) {
          Log.e(TAG, "Error handling crash broadcast", e)
        }
      }
    }

  private val screenStateReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        refreshPrototypeWindow()
        when (intent?.action) {
          Intent.ACTION_SCREEN_ON -> {
            Log.i(TAG, "Screen turned ON, triggering hierarchy extraction")
            if (::hierarchyDebouncer.isInitialized) {
              hierarchyDebouncer.extractNow()
            }
          }
          Intent.ACTION_SCREEN_OFF -> {
            Log.i(TAG, "Screen turned OFF, triggering hierarchy extraction")
            if (::hierarchyDebouncer.isInitialized) {
              hierarchyDebouncer.extractNow()
            }
          }
        }
      }
    }

  private val anrBroadcastHandler =
    SdkAnrBroadcastHandler(
      enqueue = { event ->
        sdkEventBatchProcessor.enqueue(
          SdkEventBatch(timestamp = event.timestamp, events = listOf(event)),
        )
      },
      log =
        object : SdkEventBatchBroadcastHandler.LogSink {
          override fun debug(message: String) {
            Log.d(TAG, message)
          }

          override fun warn(message: String) {
            Log.w(TAG, message)
          }
        },
    )

  private val anrReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileAnr.ACTION_ANR) return
        try {
          val ordered = isOrderedBroadcast
          val setBroadcastResult = this::setResultCode
          anrBroadcastHandler.handle(
            intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON),
            object : SdkEventBatchBroadcastHandler.ResultSink {
              override val isOrdered = ordered

              override fun setResultCode(code: Int) {
                setBroadcastResult(code)
              }
            },
            deliveryId = intent.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID),
          )
        } catch (e: Exception) {
          Log.e(TAG, "Error handling ANR broadcast", e)
        }
      }
    }

  private val eventBatchBroadcastHandler =
    SdkEventBatchBroadcastHandler(
      enqueue = { batch -> sdkEventBatchProcessor.enqueue(batch) },
      log =
        object : SdkEventBatchBroadcastHandler.LogSink {
          override fun debug(message: String) {
            Log.d(TAG, message)
          }

          override fun warn(message: String) {
            Log.w(TAG, message)
          }
        },
    )

  private val eventBatchReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != SdkEventSerializer.ACTION_SDK_EVENT_BATCH) {
          return
        }

        try {
          val ordered = isOrderedBroadcast
          val setBroadcastResult = this::setResultCode
          eventBatchBroadcastHandler.handle(
            intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON),
            object : SdkEventBatchBroadcastHandler.ResultSink {
              override val isOrdered = ordered

              override fun setResultCode(code: Int) {
                setBroadcastResult(code)
              }
            },
            batchId = intent.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID),
          )
        } catch (e: Exception) {
          Log.e(TAG, "Error handling event batch broadcast", e)
        }
      }
    }

  override fun onCreate() {
    super.onCreate()
    // Keep the production queue running from service creation, before any connection or request.
    gestureThread
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    Log.d(TAG, "onServiceConnected")

    // Subscribe to SUBSCRIBED_EVENT_TYPES_MASK (the handled set plus the framework cache-coherence
    // set) instead of TYPES_ALL_MASK, so the OS stops delivering high-frequency events we only drop
    // while the AccessibilityCache still invalidates focus/node state correctly.
    // notificationTimeout
    // coalesces same-type floods at the OS boundary. flagIncludeNotImportantViews exposes
    // interactive
    // nodes (e.g. long-clickable ImageViews) that Android otherwise filters as decorative.
    serviceInfo = serviceInfo?.apply {
      eventTypes = SUBSCRIBED_EVENT_TYPES_MASK
      notificationTimeout = ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS
      flags =
        flags or
          AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
          AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
          AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    }

    try {
      val displaySignal =
        DisplayRotationChangeSignal(
          getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager,
          onTransition = { transition ->
            serviceScope.launch {
              if (::prototypeController.isInitialized) {
                prototypeController.onDisplayTransition(
                  transition.displayId,
                  removed = transition.change == "removed",
                )
              }
              if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
                webSocketServer.broadcast(displayTransitionFrame(transition))
              }
            }
          },
        )
      rotationProvenance = RotationProvenanceTracker(displaySignal)
      deviceStateRegistration =
        DeviceStateTransitions.register(this) { state ->
          displaySignal.emitDeviceState(state)
        }
      overlayDrawer = OverlayDrawer(screenDimensionsProvider = { getScreenDimensions() })
      overlayManager =
        OverlayManager(this, viewFactory = { HighlightOverlayView(it, overlayDrawer) })
      overlayDrawer.attachOverlayManager(overlayManager)
      if (!::prototypeController.isInitialized) {
        val prototypeDisplays = AndroidPrototypeDisplays(this)
        prototypeController =
          PrototypeController(
            DefaultPrototypeHost(
              context = this,
              displayWindows = prototypeDisplays,
              onWindowAttached = { overlayManager.setPrototypeAttached(true) },
              onWindowLost = ::refreshPrototypeWindow,
              isBlocked = ::isPrototypeBlocked,
              imeInset = PrototypeImeInset { displayId -> prototypeImeLiftPx(displayId) },
              backScope = serviceScope,
            ),
            prototypeResultSink,
            onDismissed = {
              withContext(Dispatchers.Main.immediate) {
                overlayManager.setPrototypeAttached(false)
              }
            },
            lifecycle =
              PrototypeLifecycle(
                CoroutinePrototypeScheduler(serviceScope),
                isBlocked = ::isPrototypeBlocked,
                observerSession = {
                  if (::webSocketServer.isInitialized) webSocketServer.observerSessionGeneration()
                  else 0
                },
                clientCount = {
                  // Unknown (server not up yet) counts as connected: never drop a prototype on a
                  // guess.
                  if (::webSocketServer.isInitialized) webSocketServer.getConnectionCount() else 1
                },
              ),
            eventSink =
              PrototypeEventSink { event ->
                if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
                  resultBroadcaster.guard(null, "prototype_event") {
                    webSocketServer.broadcastWithPerf { _ -> prototypeEventFrame(event) }
                  }
                }
              },
            displays = prototypeDisplays,
            clearAssets = { prototypeAssets.clear() },
            hasAsset = { prototypeAssets.lookup(it) != null },
            images = prototypeImages,
            // The host grants this appop before showing a window.layer "app" prototype.
            appLayerPermitted = {
              Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Settings.canDrawOverlays(this)
            },
            packageName = packageName,
            fonts = prototypeFonts,
            foreground = prototypeForeground,
          )
        // Service start: drop anything a previous process left in the cache directory.
        prototypeAssets.purgeLeftovers()
      }
      overlayManager.setPrototypeAttached(prototypeController.isShowing)

      // Register broadcast receiver for commands
      val commandFilter = IntentFilter().apply { addAction(ACTION_EXTRACT_HIERARCHY) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(commandReceiver, commandFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(commandReceiver, commandFilter)
      }

      // Register SDK event receivers before the slower service initialization below. The SDK
      // sender cannot detect an absent dynamic receiver, while SdkEventBatchProcessor retains
      // accepted events until the WebSocket starts.
      val navigationFilter =
        IntentFilter().apply { addAction(AutoMobileSDK.ACTION_NAVIGATION_EVENT) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(navigationEventReceiver, navigationFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(navigationEventReceiver, navigationFilter)
      }
      Log.d(TAG, "Navigation event receiver registered")

      val eventBatchFilter =
        IntentFilter().apply { addAction(SdkEventSerializer.ACTION_SDK_EVENT_BATCH) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(eventBatchReceiver, eventBatchFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(eventBatchReceiver, eventBatchFilter)
      }
      Log.d(TAG, "Event batch receiver registered")

      // Register broadcast receiver for recomposition snapshots
      val recompositionFilter =
        IntentFilter().apply { addAction(AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(recompositionReceiver, recompositionFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(recompositionReceiver, recompositionFilter)
      }
      Log.d(TAG, "Recomposition receiver registered")

      // Register broadcast receiver for frame-metrics snapshots (issue #5076)
      val frameMetricsFilter =
        IntentFilter().apply { addAction(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(frameMetricsReceiver, frameMetricsFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(frameMetricsReceiver, frameMetricsFilter)
      }
      Log.d(TAG, "Frame metrics receiver registered")

      // Register broadcast receiver for package changes
      val packageFilter =
        IntentFilter().apply {
          addAction(Intent.ACTION_PACKAGE_ADDED)
          addAction(Intent.ACTION_PACKAGE_REMOVED)
          addAction(Intent.ACTION_PACKAGE_REPLACED)
          addDataScheme("package")
        }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(packageReceiver, packageFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(packageReceiver, packageFilter)
      }
      Log.d(TAG, "Package receiver registered")

      // Register broadcast receiver for handled exceptions from SDK
      val handledExceptionFilter =
        IntentFilter().apply { addAction(AutoMobileFailures.ACTION_HANDLED_EXCEPTION) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(handledExceptionReceiver, handledExceptionFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(handledExceptionReceiver, handledExceptionFilter)
      }
      Log.d(TAG, "Handled exception receiver registered")

      // Register broadcast receiver for crashes from SDK
      val crashFilter = IntentFilter().apply { addAction(AutoMobileCrashes.ACTION_CRASH) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(crashReceiver, crashFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(crashReceiver, crashFilter)
      }
      Log.d(TAG, "Crash receiver registered")

      // Register broadcast receiver for ANRs from SDK
      val anrFilter = IntentFilter().apply { addAction(AutoMobileAnr.ACTION_ANR) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(anrReceiver, anrFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag") registerReceiver(anrReceiver, anrFilter)
      }
      Log.d(TAG, "ANR receiver registered")

      val screenStateFilter =
        IntentFilter().apply {
          addAction(Intent.ACTION_SCREEN_ON)
          addAction(Intent.ACTION_SCREEN_OFF)
          addAction(Intent.ACTION_USER_PRESENT)
        }
      registerReceiver(screenStateReceiver, screenStateFilter)
      Log.d(TAG, "Screen state receiver registered")

      // Initialize the smart hierarchy debouncer with structural hash comparison
      hierarchyDebouncer =
        HierarchyDebouncer(
          scope = serviceScope,
          timeProvider = timeProvider,
          perfProvider = perfProvider,
          quickDebounceMs = 5L,
          animationSkipWindowMs = 100L,
          unsolicitedIntervalMs = DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS,
          stats = workStats,
          onDiscardedHierarchy = { extractedHierarchyFrameContexts.remove(it) },
          extractHierarchy = { disableAllFiltering, snapshotOptions ->
            extractHierarchyDirect(disableAllFiltering, snapshotOptions)
          },
        )

      // Event-driven extraction is admitted before this collector at the configured interval.
      // Deliver every admitted result so extraction time cannot cause a final refresh to be lost.
      hierarchyFlowJob =
        hierarchyDebouncer.hierarchyFlow
          .onEach { result ->
            // Guard the whole body: serialization was hoisted here (issue #5469) out of
            // writeHierarchyToFile/broadcastHierarchyUpdate's own try/catch, so an encode failure
            // on
            // one frame (e.g. a NaN/Infinity textSizeInPx) would otherwise complete this collector
            // —
            // and it is never relaunched, silently losing all later unsolicited updates. Swallow so
            // one bad frame is dropped, not the whole flow.
            try {
              when (result) {
                is HierarchyResult.Changed -> {
                  Log.d(
                    TAG,
                    "Hierarchy changed (hash=${result.hash}, extraction=${result.extractionTimeMs}ms)",
                  )
                  // Serialize once for the debug file and wire; release frame context on failure.
                  deliverHierarchyFrame(
                    serialize = {
                      perfProvider.track("serializeHierarchy") {
                        jsonCompact.encodeToString(result.hierarchy)
                      }
                    },
                    write = { serialized ->
                      writeHierarchyToFile(result.hierarchy, serialized = serialized)
                    },
                    broadcast = { serialized ->
                      broadcastHierarchyUpdate(result.hierarchy, serialized = serialized)
                    },
                    releaseFrameContext = {
                      extractedHierarchyFrameContexts.remove(result.hierarchy)
                    },
                  )
                }
                is HierarchyResult.Unchanged -> {
                  Log.d(
                    TAG,
                    "Hierarchy unchanged (animation mode, skipped=${result.skippedEventCount})",
                  )
                  broadcastHierarchyUpdate(result.hierarchy)
                }
                is HierarchyResult.Error -> {
                  Log.w(TAG, "Hierarchy extraction error: ${result.message}")
                }
              }
            } catch (e: CancellationException) {
              // Let cooperative cancellation unwind the collector normally.
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Error handling hierarchy result — dropping this frame", e)
            }
          }
          .launchIn(serviceScope)

      // Initialize storage subscription manager for SharedPreferences inspection
      storageSubscriptionManager = StorageSubscriptionManager(this, scope = serviceScope)
      Log.d(TAG, "Storage subscription manager initialized")

      // Subscribe to storage change events and broadcast them
      storageChangeJob =
        storageSubscriptionManager.changeEvents
          .onEach { event ->
            Log.d(
              TAG,
              "Storage change: ${event.packageName}:${event.fileName} key=${event.key}",
            )
            broadcastStorageChange(event)
          }
          .launchIn(serviceScope)

      // Keep inbound blocking work off Ktor's read loops, preserving each connection's wire order.
      try {
        val queuedHandler = queuedMessageHandler()
        val prototypes = prototypeController
        webSocketServer =
          WebSocketServer(
            port = 8765,
            scope = serviceScope,
            messageHandler = queuedHandler,
            onClientDisconnected = { client ->
              queuedHandler.disconnect(client)
              gestureStreamRouter.cancelOwnedBy(client)
            },
            onClientCountChanged = { count, session ->
              serviceScope.launch { prototypes.onClientCountChanged(count, session) }
            },
            onClientConnected = { serviceScope.launch { prototypes.onClientConnected() } },
            onPermanentStartFailure = { disableSelf() },
          )
        webSocketLifecycle.replace(webSocketServer)
        webSocketServer.start()
      } catch (e: Exception) {
        Log.e(TAG, "Error initializing WebSocket server during service connection", e)
        disableSelf()
      }

      // Receivers may enqueue into the processor's bounded channel during bind retries. Do not
      // drain it, or publish accumulator events, until the listener can deliver them.
      serviceScope.launch {
        startEventIngestionWhenReady(
          isRunning = { webSocketServer.isRunning() },
          pause = { kotlinx.coroutines.delay(50L) },
        ) {
          navigationEventAccumulator.initialize()
          Log.d(TAG, "Navigation event accumulator initialized")
          navigationEventJob =
            navigationEventAccumulator.latestEvent
              .onEach { event ->
                if (event != null) {
                  Log.d(TAG, "Navigation event: ${event.destination} at ${event.timestamp}")
                  broadcastNavigationEvent(event)
                }
              }
              .launchIn(serviceScope)
          sdkEventBatchProcessor.start()
          Log.d(TAG, "SDK event batch processor started")
        }
      }

      // Start logcat reader for automatic log capture. Gate parsing on a connected client so a
      // chatty device is not regex-parsed while nobody is consuming logs.
      val logBuffer = BoundedLogBuffer(capacity = 128, stats = workStats)
      logEventBuffer = logBuffer
      serviceScope.launch {
        var reportedFailure = false
        for (response in logBuffer.channel) {
          try {
            if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
              webSocketServer.broadcast(response)
            }
            reportedFailure = false
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            if (!reportedFailure) Log.w(TAG, "Error broadcasting log event", e)
            reportedFailure = true
          }
        }
      }
      logcatReader =
        LogcatReader(
          onLogEvent = {},
          tryDeliver = logBuffer::offer,
          hasConsumer = {
            ::webSocketServer.isInitialized && webSocketServer.getConnectionCount() > 0
          },
          stats = workStats,
        )
      logcatReader?.start()
      Log.d(TAG, "Logcat reader started")

      Log.d(TAG, "AutoMobile Accessibility Service connected successfully")
    } catch (e: Exception) {
      Log.e(TAG, "Error during service connection", e)
      // Service will continue running even if some initialization fails
    }
  }

  override fun onUnbind(intent: Intent?): Boolean {
    // Android can reconnect this service in the same process before onDestroy runs.
    webSocketLifecycle.stop()
    if (::prototypeController.isInitialized) {
      // Dismiss (reason teardown) without terminal destruction: a same-process rebind reuses this
      // controller, and onServiceConnected has early-exit paths that would leave a destroyed one.
      CoroutineScope(Dispatchers.Main.immediate).launch { prototypeController.dismissForUnbind() }
    }
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    super.onDestroy()

    try {
      unregisterReceiver(commandReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering command receiver", e)
    }

    try {
      unregisterReceiver(navigationEventReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering navigation event receiver", e)
    }

    try {
      unregisterReceiver(recompositionReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering recomposition receiver", e)
    }

    try {
      unregisterReceiver(frameMetricsReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering frame metrics receiver", e)
    }

    try {
      unregisterReceiver(packageReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering package receiver", e)
    }

    try {
      unregisterReceiver(handledExceptionReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering handled exception receiver", e)
    }

    try {
      unregisterReceiver(crashReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering crash receiver", e)
    }

    try {
      unregisterReceiver(anrReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering ANR receiver", e)
    }

    try {
      unregisterReceiver(eventBatchReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering event batch receiver", e)
    }

    try {
      unregisterReceiver(screenStateReceiver)
    } catch (e: Exception) {
      Log.e(TAG, "Error unregistering screen state receiver", e)
    }

    if (::rotationProvenance.isInitialized) {
      rotationProvenance.close()
    }
    runCatching { deviceStateRegistration?.close() }
      .onFailure { Log.w(TAG, "Failed to unregister device-state listener", it) }
    deviceStateRegistration = null

    // Stop logcat reader
    logcatReader?.stop()
    logcatReader = null
    logEventBuffer?.channel?.close()
    logEventBuffer = null

    if (::overlayDrawer.isInitialized) {
      overlayDrawer.destroy()
    }

    if (::prototypeController.isInitialized) {
      // Independent of serviceScope cancellation below. Main-immediate runs inline when possible;
      // a pending request releases the controller mutex on cancellation, then cleanup resumes.
      CoroutineScope(Dispatchers.Main.immediate).launch { prototypeController.destroy() }
    }
    if (::overlayManager.isInitialized) {
      overlayManager.destroy()
    }

    // Cancel hierarchy flow subscription
    hierarchyFlowJob?.cancel()

    // Cancel navigation event flow subscription
    navigationEventJob?.cancel()

    // Cancel storage change flow subscription and clean up manager
    storageChangeJob?.cancel()
    if (::storageSubscriptionManager.isInitialized) {
      storageSubscriptionManager.destroy()
      Log.d(TAG, "Storage subscription manager destroyed")
    }

    // Reset debouncer
    if (::hierarchyDebouncer.isInitialized) {
      hierarchyDebouncer.reset()
    }

    // Stop WebSocket server
    if (::webSocketServer.isInitialized) {
      webSocketLifecycle.stop()
      Log.d(TAG, "WebSocket server stopped")
    }

    // close dispatches each cancel lift before this callback quits the gesture thread. The
    // platform's result callback need not arrive: the router has already closed and resolved
    // pending end results, and it ignores any late callback.
    teardownGestures(
      close = gestureStreamRouter::close,
      quitThread = { gestureThread.quitSafely() },
      cancelScope = { serviceScope.cancel() },
      onCloseFailure = { Log.w(TAG, "Failed to close streamed gestures", it) },
    )
    Log.d(TAG, "AutoMobile Accessibility Service destroyed")
  }

  // ===========================================================================
  // CtrlProxyActions — inbound WebSocket commands dispatched by CtrlProxyMessageHandler.
  // Each method delegates to the corresponding perform*/handle* implementation below.
  // ===========================================================================

  internal fun queuedMessageHandler(
    delegate: WebSocketMessageHandler =
      CtrlProxyMessageHandler(actions = this, log = { Log.w(TAG, it) }),
    scope: CoroutineScope = serviceScope,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    capacity: Int = INBOUND_COMMAND_CAPACITY,
  ): QueuedWebSocketMessageHandler {
    val commands =
      ConnectionCommandQueue(
        scope = scope,
        dispatcher = dispatcher,
        delegate = delegate,
        reply = ::replyToQueuedCommand,
        hasRequestOwner = { requestId ->
          ::webSocketServer.isInitialized &&
            webSocketServer.isRunning() &&
            webSocketServer.hasRequestOwner(requestId)
        },
        logError = { message, error -> Log.e(TAG, message, error) },
        logWarning = { message -> Log.w(TAG, message) },
        logDebug = { message -> Log.d(TAG, message) },
        capacity = capacity,
      )
    return QueuedWebSocketMessageHandler(delegate, commands)
  }

  /**
   * Ownership policy is supplied by the server before enqueue, never inferred after disconnect.
   * Owned replies use atomic owner routing; unowned errors are sent through the origin context.
   * Successful unowned results retain broadcast(response) behavior, including dropping an orphaned
   * correlation ID. Hierarchy frames without a correlation remain intentionally broadcast.
   */
  internal suspend fun replyToQueuedCommand(
    requestId: String?,
    response: WebSocketResponse,
    routing: QueuedReplyRouting,
  ) {
    if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
      if (
        routing == QueuedReplyRouting.OWNER &&
          requestId != null &&
          !webSocketServer.hasRequestOwner(requestId)
      ) {
        Log.d(TAG, "Dropping queued reply for disconnected or completed request $requestId")
      }
      // Always use atomic owner routing for owned replies, even if the owner just vanished.
      webSocketServer.broadcast(response)
    }
  }

  override suspend fun requestHierarchy(disableAllFiltering: Boolean, requestId: String?) =
    extractHierarchyNow(disableAllFiltering, requestId = requestId)

  override suspend fun requestHierarchy(
    disableAllFiltering: Boolean,
    maxDepth: Int?,
    maxNodes: Int?,
    displayId: Int?,
    requestId: String?,
  ) =
    extractHierarchyNow(
      disableAllFiltering,
      HierarchySnapshotOptions(
        maxDepth = maxDepth ?: 100,
        maxNodes = maxNodes ?: 10_000,
        displayId = displayId,
      ),
      requestId,
    )

  override fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) {
    var extractionRequested = false
    hierarchyDebouncer.extractIfStale(sinceTimestamp) {
      extractionRequested = true
      launchRequestScope(requestId) { extractHierarchyNow(requestId = requestId) }
        .invokeOnCompletion { cause ->
          // Also release when the service scope cancels the launch before extraction starts.
          if (cause is CancellationException && ::webSocketServer.isInitialized) {
            webSocketServer.releaseRequestOwner(requestId)
          }
        }
    }
    if (!extractionRequested && ::webSocketServer.isInitialized) {
      webSocketServer.releaseRequestOwner(requestId)
    }
  }

  override fun setHierarchyInterval(intervalMs: Long?) {
    val resolvedIntervalMs = intervalMs ?: DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS
    if (::hierarchyDebouncer.isInitialized) {
      hierarchyDebouncer.setUnsolicitedIntervalMs(resolvedIntervalMs)
    }
    Log.d(TAG, "Hierarchy broadcast interval set to ${resolvedIntervalMs}ms")
  }

  override fun requestScreenshot(requestId: String?) = broadcastScreenshot(requestId)

  override fun requestScreenshot(requestId: String?, displayId: Int?) =
    broadcastScreenshot(requestId, displayId)

  override fun requestScreenshot(requestId: String?, displayId: Int?, hidePrototypes: Boolean) =
    broadcastScreenshot(requestId, displayId, hidePrototypes)

  override fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.TAP)) return
    performTapCoordinates(requestId, x, y, 50L, frameContext, displayId, doubleTap = true)
  }

  override fun requestTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    duration: Long,
    frameContext: String?,
    displayId: Int?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.TAP)) return
    performTapCoordinates(requestId, x, y, duration, frameContext, displayId)
  }

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    frameContext: String?,
    displayId: Int?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.SWIPE)) return
    performSwipe(requestId, x1, y1, x2, y2, duration, frameContext, displayId)
  }

  override fun requestTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int,
    displayId: Int?,
  ) {
    performTwoFingerSwipe(requestId, x1, y1, x2, y2, duration, offset, displayId)
  }

  override fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
    frameContext: String?,
    displayId: Int?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.DRAG)) return
    performDrag(
      requestId,
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      frameContext,
      displayId,
    )
  }

  override fun requestPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
    displayId: Int?,
  ) {
    performPinch(
      requestId,
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      displayId,
    )
  }

  override fun requestGestureStart(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    displayId: Int?,
  ) {
    rememberedInsert = null
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      broadcastGestureResult(requestId, false, "Streaming gestures require Android 8.0 (API 26)")
      return
    }
    gestureStreamRouter.start(
      requestId,
      gestureId,
      x.toFloat(),
      y.toFloat(),
      displayId,
      CommandOriginContext.currentClient(),
    )
  }

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
  ) = requestSwipe(requestId, x1, y1, x2, y2, duration, null, null)

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    frameContext: String?,
  ) = requestSwipe(requestId, x1, y1, x2, y2, duration, frameContext, null)

  /**
   * The Android half of streaming gesture input: builds real `StrokeDescription`s and dispatches
   * them through the AccessibilityService, one continued stroke per [GestureSegment]. Kept a thin
   * seam so the continuation loop ([GestureStreamSession]) stays framework-free and unit-tested.
   * Requires API 26+ (the `willContinue` constructor and `continueStroke`); the caller guards.
   */
  @TargetApi(Build.VERSION_CODES.O)
  private inner class AccessibilityStrokeDispatcher :
    StrokeDispatcher<GestureDescription.StrokeDescription> {
    override fun initialStroke(segment: GestureSegment): GestureDescription.StrokeDescription =
      GestureDescription.StrokeDescription(
        segment.toPath(),
        0,
        segment.durationMs.coerceAtLeast(1L),
        segment.willContinue,
      )

    override fun continueStroke(
      previous: GestureDescription.StrokeDescription,
      segment: GestureSegment,
    ): GestureDescription.StrokeDescription =
      previous.continueStroke(
        segment.toPath(),
        0,
        segment.durationMs.coerceAtLeast(1L),
        segment.willContinue,
      )

    override fun dispatch(
      stroke: GestureDescription.StrokeDescription,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      displayId: Int?,
    ) = dispatchContinuing(stroke, onComplete, onFailed, onFailed, displayId)

    override fun dispatchContinuing(
      stroke: GestureDescription.StrokeDescription,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      onRejected: (error: String) -> Unit,
      displayId: Int?,
    ) {
      val gesture = gestureBuilder(displayId).addStroke(stroke).build()
      val dispatched =
        try {
          dispatchGesture(
            gesture,
            object : GestureResultCallback() {
              override fun onCompleted(gestureDescription: GestureDescription?) = onComplete()

              override fun onCancelled(gestureDescription: GestureDescription?) =
                onFailed("Streamed gesture stroke was cancelled")
            },
            gestureHandler,
          )
        } catch (e: Exception) {
          Log.e(TAG, "Error dispatching streamed gesture stroke", e)
          onRejected(e.message ?: "Failed to dispatch streamed gesture stroke")
          return
        }
      if (!dispatched) onRejected("Failed to dispatch streamed gesture stroke")
    }

    private fun GestureSegment.toPath(): Path =
      Path().apply {
        moveTo(from.x, from.y)
        lineTo(to.x, to.y)
      }
  }

  override fun requestGestureStart(requestId: String?, gestureId: String, x: Double, y: Double) {
    rememberedInsert = null
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // continueStroke is API 26+. Fail cleanly so the client falls back to an atomic swipe.
      broadcastGestureResult(requestId, false, "Streaming gestures require Android 8.0 (API 26)")
      return
    }
    gestureStreamRouter.start(
      requestId,
      gestureId,
      x.toFloat(),
      y.toFloat(),
      owner = CommandOriginContext.currentClient(),
    )
  }

  override fun requestGestureMove(requestId: String?, gestureId: String, x: Double, y: Double) {
    rememberedInsert = null
    gestureStreamRouter.move(requestId, gestureId, x.toFloat(), y.toFloat())
  }

  override fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) {
    rememberedInsert = null
    gestureStreamRouter.end(
      requestId,
      gestureId,
      x.toFloat(),
      y.toFloat(),
      cancel,
      requester = CommandOriginContext.currentClient(),
    )
  }

  /** Ack one streamed-gesture request, reusing the shared `swipe_result` frame. */
  private fun broadcastGestureResult(requestId: String?, success: Boolean, error: String?) {
    launchRequestScope(requestId) { broadcastSwipeResult(requestId, success, error, 0L, null) }
  }

  override fun requestTapCoordinates(requestId: String?, x: Double, y: Double, duration: Long) =
    requestTapCoordinates(requestId, x, y, duration, null, null)

  override fun requestTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    duration: Long,
    frameContext: String?,
  ) = requestTapCoordinates(requestId, x, y, duration, frameContext, null)

  override fun requestTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int,
  ) = performTwoFingerSwipe(requestId, x1, y1, x2, y2, duration, offset)

  override fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
  ) =
    requestDrag(
      requestId,
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      null,
      null,
    )

  override fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
    frameContext: String?,
  ) =
    requestDrag(
      requestId,
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      frameContext,
      null,
    )

  private enum class StaleFrameContextAction(val wireName: String) {
    TAP("tap"),
    SWIPE("swipe"),
    DRAG("drag"),
    SET_TEXT("set_text"),
    IME_ACTION("ime_action"),
    GLOBAL_ACTION("global_action"),
  }

  /**
   * Rejects an input that was mapped through a screen state the service has since observed change.
   */
  private fun rejectStaleFrameContext(
    requestId: String?,
    expected: String?,
    action: StaleFrameContextAction,
  ): Boolean {
    if (expected == null || expected == currentFrameContext()) return false
    val error =
      "Stale frame context for input/${action.wireName}; observe a fresh frame before retrying"
    launchRequestScope(requestId) { broadcastStaleFrameRejection(requestId, action, error) }
    return true
  }

  /**
   * Broadcasts the correlated stale-frame rejection for [action].
   *
   * A future [StaleFrameContextAction] added without its own branch must never route through no
   * branch and leave the caller to hang until timeout (issue #4577). At this module's Kotlin
   * language version the compiler already enforces that: a non-exhaustive `when` over the enum is a
   * compile error in statement or expression form. This is written expression-bodied so the
   * guarantee also survives lowering the language version below the level where non-exhaustive
   * `when` *statements* became errors (they are only warnings pre-2.0). Do not add an `else ->`
   * branch — it would defeat the check by making a missing action compile.
   */
  private suspend fun broadcastStaleFrameRejection(
    requestId: String?,
    action: StaleFrameContextAction,
    error: String,
  ) =
    when (action) {
      StaleFrameContextAction.TAP -> broadcastTapCoordinatesResult(requestId, false, error, 0)
      StaleFrameContextAction.SWIPE -> broadcastSwipeResult(requestId, false, error, 0, null)
      StaleFrameContextAction.DRAG -> broadcastDragResult(requestId, false, error, 0, null)
      StaleFrameContextAction.SET_TEXT -> broadcastSetTextResult(requestId, false, error, 0)
      StaleFrameContextAction.IME_ACTION ->
        broadcastImeActionResult(requestId, action.wireName, false, error, 0)
      StaleFrameContextAction.GLOBAL_ACTION ->
        webSocketServer.broadcast(
          dev.jasonpearson.automobile.protocol.GlobalActionResult(
            timestamp = System.currentTimeMillis(),
            requestId = requestId,
            success = false,
            action = action.wireName,
            totalTimeMs = 0,
            error = error,
          ),
        )
    }

  override fun requestPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
  ) =
    performPinch(
      requestId,
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
    )

  override suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
  ) = performSetText(requestId, text, resourceId, dismissKeyboard)

  override suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
    frameContext: String?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.SET_TEXT)) return
    performSetText(requestId, text, resourceId, dismissKeyboard)
  }

  override fun requestInsertTextState(requestId: String?) {
    // The host awaits this reply BEFORE dispatching ADB key events. No baseline is stored globally.
    launchRequestScope(requestId) {
      if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
        Log.d(TAG, "WebSocket server not running, skipping insert text state result broadcast")
        return@launchRequestScope
      }
      val node = findFocusedEditableNode(rootInActiveWindow)
      val state =
        try {
          if (
            node != null && node.refresh() && node.isEditable && node.isFocused && !node.isPassword
          ) {
            InsertTextSnapshot(
              node.text?.toString(),
              node.isShowingHintTextCompat(),
              node.textSelectionStart,
              node.textSelectionEnd,
            )
          } else null
        } finally {
          node?.recycle()
        }
      resultBroadcaster.guard(requestId, "insert_text_state_result") {
        webSocketServer.broadcastWithPerfSync { perfTiming ->
          webSocketFrameJson(
            "insert_text_state_result",
            requestId = requestId,
            perfTiming = perfTiming,
          ) {
            put("success", true)
            if (state != null) put("state", jsonCompact.encodeToJsonElement(state))
          }
        }
      }
    }
  }

  override fun requestInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
    precedingState: dev.jasonpearson.automobile.protocol.InsertTextState?,
  ) = performInsertText(requestId, text, expectedSuffix, acceptsCaretNotPlaced, precedingState)

  override fun requestInsertText(requestId: String?, text: String) =
    performInsertText(requestId, text, null, false)

  override fun requestInsertText(requestId: String?, text: String, expectedSuffix: String?) =
    performInsertText(requestId, text, expectedSuffix, false)

  override fun requestInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
  ) = performInsertText(requestId, text, expectedSuffix, acceptsCaretNotPlaced)

  override fun requestCommitText(requestId: String?, text: String, priorImeId: String?) =
    requestCommitText(requestId, text, priorImeId, ImeTextDelivery.COMMIT)

  override fun requestCommitText(
    requestId: String?,
    text: String,
    priorImeId: String?,
    delivery: ImeTextDelivery,
  ) = requestCommitText(requestId, text, priorImeId, delivery, null)

  override fun requestCommitText(
    requestId: String?,
    text: String,
    priorImeId: String?,
    delivery: ImeTextDelivery,
    timeoutMs: Long?,
  ) {
    rememberedInsert = null
    val start = System.currentTimeMillis()
    val state = requestId?.let { imeCommitStates.computeIfAbsent(it) { ImeCommitState() } }
    if (state?.cancelled?.get() == true) {
      launchRequestScope(requestId) {
        broadcastCommitTextResult(requestId, false, "IME commit cancelled", 0L, false)
      }
      return
    }
    launchRequestScope(requestId) {
      fun finish(result: ImeCommitResult) {
        state?.finished?.complete(result)
        if (state?.cancelled?.get() == false) imeCommitStates.remove(requestId, state)
      }
      // `ime set` can return before Android creates the InputMethodService. Give activation a
      // bounded window; the IME separately waits for its editor binding.
      val ime =
        awaitImeServiceReady(
          nowMs = android.os.SystemClock::uptimeMillis,
          delayMs = { kotlinx.coroutines.delay(it) },
          probe = { CtrlProxyIme.current() },
          isCancelled = { state?.cancelled?.get() == true },
        )
      if (state?.cancelled?.get() == true) {
        finish(ImeCommitResult(success = false, error = null))
        broadcastCommitTextResult(
          requestId,
          false,
          "IME commit cancelled",
          System.currentTimeMillis() - start,
          false,
        )
        return@launchRequestScope
      }
      if (ime == null) {
        finish(ImeCommitResult(success = false, error = null))
        broadcastCommitTextResult(
          requestId,
          false,
          "IME service did not start within timeout",
          System.currentTimeMillis() - start,
          false,
        )
        return@launchRequestScope
      }
      ime.commitText(text, priorImeId, { state?.cancelled?.get() == true }, delivery, timeoutMs) {
        result ->
        finish(result)
        launchRequestScope(requestId) {
          broadcastCommitTextResult(
            requestId,
            result.success,
            result.error,
            System.currentTimeMillis() - start,
            result.partialApplication,
            result.committedUnits,
          )
        }
      }
    }
  }

  override fun requestCancelImeCommit(requestId: String?, targetRequestId: String) {
    val tombstone =
      ImeCommitState().apply {
        cancelled.set(true)
        finished.complete(ImeCommitResult(success = false, error = null))
      }
    val state = imeCommitStates.putIfAbsent(targetRequestId, tombstone) ?: tombstone
    state.cancelled.set(true)
    // An absent target is a tombstone: the original frame may still be queued on another socket.
    launchRequestScope(requestId) {
      val result = state.finished.await()
      resultBroadcaster.guard(requestId, "cancel_ime_commit_result") {
        webSocketServer.broadcastWithPerfSync { perfTiming ->
          webSocketFrameJson(
            "cancel_ime_commit_result",
            requestId = requestId,
            perfTiming = perfTiming,
          ) {
            put("success", true)
            put("targetRequestId", targetRequestId)
            put("partialApplication", result.partialApplication)
            if (result.committedUnits > 0) put("committedUnits", result.committedUnits)
          }
        }
      }
    }
  }

  override fun requestSetKeyboardProfile(requestId: String?, profileId: String) {
    val profile = KeyboardProfiles.byId(profileId)
    if (profile == null) {
      val expected = KeyboardProfiles.all.joinToString(", ") { it.id }
      launchRequestScope(requestId) {
        broadcastSetKeyboardProfileResult(
          requestId,
          false,
          error = "Unknown keyboard profile '$profileId'; expected one of: $expected",
        )
      }
      return
    }

    val store = SharedPreferencesKeyboardProfileStore(this)
    val previous = store.activeProfileId()
    val applied = CompletableDeferred<Boolean>()
    val live = CtrlProxyIme.setActiveProfile(profile.id) { applied.complete(it) }
    if (!live) {
      store.setActiveProfileId(profile.id)
      applied.complete(true)
    }
    launchRequestScope(requestId) {
      val success = applied.await()
      broadcastSetKeyboardProfileResult(
        requestId,
        success,
        if (success) profile.id else null,
        if (success) previous else null,
        if (success) null else "Failed to apply keyboard profile",
      )
    }
  }

  override fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) {
    val catalogVersion = KeyboardProfiles.negotiateCatalogVersion(supportedCatalogVersions)
    if (catalogVersion == null) {
      launchRequestScope(requestId) {
        broadcastKeyboardProfileCatalog(
          requestId = requestId,
          success = false,
          supportedCatalogVersions = KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
          error =
            "No mutually supported keyboard profile catalog version; device supports " +
              KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS.joinToString(", "),
        )
      }
      return
    }
    val profiles =
      KeyboardProfiles.all.map { profile ->
        KeyboardProfileInfo(
          id = profile.id,
          displayName = profile.displayName,
          version = profile.version,
          evidenceStatus = profile.evidenceStatus,
          evidenceNote = profile.evidenceNote,
          behavior =
            KeyboardProfileBehaviorInfo(
              composeWords = profile.behavior.composeWords,
              enterStrategy = profile.behavior.enterStrategy.name,
              backspaceStrategy = profile.behavior.backspaceStrategy.name,
              recomposeOnCursorMove = profile.behavior.recomposeOnCursorMove,
              recomposeOnBackspaceIntoWord = profile.behavior.recomposeOnBackspaceIntoWord,
              batchEdits = profile.behavior.batchEdits,
            ),
        )
      }
    val activeProfileId = SharedPreferencesKeyboardProfileStore(this).activeProfileId()
    launchRequestScope(requestId) {
      broadcastKeyboardProfileCatalog(
        requestId = requestId,
        success = true,
        catalogVersion = catalogVersion,
        supportedCatalogVersions = KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
        activeProfileId = activeProfileId,
        profiles = profiles,
      )
    }
  }

  override fun requestImeAction(requestId: String?, action: String) =
    performImeAction(requestId, action)

  override fun requestImeAction(requestId: String?, action: String, frameContext: String?) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.IME_ACTION)) return
    performImeAction(requestId, action)
  }

  override fun requestSelectAll(requestId: String?) = performSelectAll(requestId)

  override fun requestClickFocusedInput(requestId: String?) {
    rememberedInsert = null
    val startTime = System.currentTimeMillis()
    // Like performNodeAction, stay on the inbound command queue until settling and replying.
    try {
      val outcome =
        clickFocusedInput(
          findFocusedInput = {
            findNodeInDisplayWindows { root -> findFocusedEditableNode(root) }
          },
          click = { node ->
            nodeActionFailure("click", node.actionList?.map { it.id }) == null &&
              node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
          },
          recycle = { node -> node.recycle() },
          settleAfterClick = ::refreshHierarchyAfterNodeAction,
        )
      kotlinx.coroutines.runBlocking {
        broadcastActionResult(
          requestId,
          "click",
          outcome.success,
          outcome.error,
          System.currentTimeMillis() - startTime,
        )
      }
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      Log.e(TAG, "Focused input click failed", e)
      kotlinx.coroutines.runBlocking {
        broadcastActionResult(
          requestId,
          "click",
          false,
          e.message ?: "Focused input click failed",
          System.currentTimeMillis() - startTime,
        )
      }
    }
  }

  override fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
  ) = performNodeAction(requestId, action, resourceId, selector)

  override fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  ) = performAccessibilityLinkActivation(requestId, text, occurrence, selector)

  override fun requestClipboard(requestId: String?, action: String, text: String?) =
    performClipboard(requestId, action, text)

  override fun installCaCert(requestId: String?, certificate: String) =
    performInstallCaCertificate(requestId, certificate)

  override fun installCaCertFromPath(requestId: String?, devicePath: String) =
    performInstallCaCertificateFromPath(requestId, devicePath)

  override fun removeCaCert(requestId: String?, alias: String?, certificate: String?) =
    performRemoveCaCertificate(requestId, alias, certificate)

  override fun requestGlobalAction(requestId: String?, action: String) =
    performGlobalActionRequest(requestId, action)

  override fun requestGlobalAction(requestId: String?, action: String, frameContext: String?) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.GLOBAL_ACTION))
      return
    performGlobalActionRequest(requestId, action)
  }

  override fun validateFrameContext(requestId: String?, frameContext: String) {
    val matches = frameContext == currentFrameContext()
    asyncActionRunner.launch(requestId, "validate_frame_context") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.FrameContextValidationResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = matches,
          totalTimeMs = 0,
          error =
            if (matches) {
              null
            } else {
              "Stale frame context for input/key; observe a fresh frame before retrying"
            },
        ),
      )
    }
  }

  override fun requestDeviceInfo(requestId: String?) = performDeviceInfoRequest(requestId)

  override fun getDeviceOwnerStatus(requestId: String?) = performGetDeviceOwnerStatus(requestId)

  override fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) = handleGetPermission(requestId, permission, requestPermission)

  override fun setRecompositionTracking(enabled: Boolean) = setRecompositionTrackingEnabled(enabled)

  override fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) =
    applyAccessibilityFlags(
      includeNotImportantViews = includeNotImportantViews,
      reportViewIds = reportViewIds,
      retrieveInteractiveWindows = retrieveInteractiveWindows,
      occlusionEnabled = occlusionEnabled,
    )

  override fun setNetworkMockRules(requestId: String?, rulesJson: String) =
    broadcastNetworkMockRules(requestId, rulesJson)

  override fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) = broadcastNetworkErrorSimulation(enabled, errorType, limit, expiresAtEpochMs, remainingMs)

  override fun getCurrentFocus(requestId: String?) = handleGetCurrentFocus(requestId)

  override fun getTraversalOrder(requestId: String?) = handleGetTraversalOrder(requestId)

  override fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?) =
    handleAddHighlight(requestId, highlightId, shape)

  override fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
  ) {
    launchRequestScope(requestId) { prototypeController.show(requestId, spec, displayId, reset) }
  }

  override fun dismissPrototype(requestId: String?, id: String?, all: Boolean?) {
    launchRequestScope(requestId) { prototypeController.dismiss(requestId, id, all) }
  }

  override fun inspectPrototypes(requestId: String?) {
    launchRequestScope(requestId) { prototypeController.inspect(requestId) }
  }

  override fun putPrototypeAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) {
    launchRequestScope(requestId) {
      prototypeAssetController.put(requestId, id, mimeType, dataBase64)
    }
  }

  override fun removePrototypeAsset(requestId: String?, id: String) {
    launchRequestScope(requestId) { prototypeAssetController.remove(requestId, id) }
  }

  override fun listPreferenceFiles(requestId: String?, packageName: String) =
    handleListPreferenceFiles(requestId, packageName)

  override fun getPreferences(requestId: String?, packageName: String, fileName: String) =
    handleGetPreferences(requestId, packageName, fileName)

  override fun discoverKeystore(requestId: String?, packageName: String) {
    asyncActionRunner.launch(requestId, "discover_keystore") {
      val state =
        dev.jasonpearson.automobile.ctrlproxy.storage.discoverKeystore(this@CtrlProxy, packageName)
      resultBroadcaster.guard(requestId, "keystore_discovery") {
        webSocketServer.broadcast(
          dev.jasonpearson.automobile.protocol.KeystoreDiscoveryResult(
            timestamp = timeProvider.currentTimeMillis(),
            requestId = requestId,
            state = state,
          ),
        )
      }
    }
  }

  override fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) {
    asyncActionRunner.launch(requestId, "get_sdk_capabilities") {
      val state =
        dev.jasonpearson.automobile.ctrlproxy.storage.discoverSdkCapabilities(
          this@CtrlProxy,
          packageName,
          userId,
        )
      resultBroadcaster.guard(requestId, "sdk_capabilities") {
        webSocketServer.broadcast(
          dev.jasonpearson.automobile.protocol.SdkCapabilitiesResult(
            timestamp = timeProvider.currentTimeMillis(),
            requestId = requestId,
            state = state,
          ),
        )
      }
    }
  }

  override fun listDataStores(requestId: String?, packageName: String, adapterName: String) =
    handleListDataStores(requestId, packageName, adapterName)

  override fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) = handleGetDataStore(requestId, packageName, adapterName, storeName)

  override fun subscribeStorage(requestId: String?, packageName: String, fileName: String) =
    handleSubscribeStorage(requestId, packageName, fileName)

  override fun unsubscribeStorage(requestId: String?, packageName: String, fileName: String) =
    handleUnsubscribeStorage(requestId, packageName, fileName)

  override fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = handleGetPreference(requestId, packageName, fileName, key)

  override fun setPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) = handleSetPreference(requestId, packageName, fileName, key, value, type)

  override fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = handleRemovePreference(requestId, packageName, fileName, key)

  override fun clearPreferences(requestId: String?, packageName: String, fileName: String) =
    handleClearPreferences(requestId, packageName, fileName)

  override fun startRecording() {
    // Accepted for wire compatibility; currently has no effect on the device.
    Log.d(TAG, "Recording started")
  }

  override fun stopRecording() {
    // Accepted for wire compatibility; currently has no effect on the device.
    Log.d(TAG, "Recording stopped")
  }

  override fun requestSettingsGet(requestId: String?, namespace: String, key: String) =
    performSettingsRead(requestId, namespace, key)

  override fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) = performSettingsWrite(requestId, namespace, key, value, valueType)

  override fun requestSettingsList(requestId: String?, namespace: String) =
    performSettingsList(requestId, namespace)

  override fun requestInstalledPackages(requestId: String?, includeSystem: Boolean, userId: Int?) =
    performInstalledPackages(requestId, includeSystem, userId)

  override fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) = performPackageInfo(requestId, packageName, includePermissions)

  override fun requestLaunchIntent(requestId: String?, packageName: String) =
    performLaunchIntent(requestId, packageName)

  private fun setRecompositionTrackingEnabled(enabled: Boolean) {
    recompositionStore.setEnabled(enabled)
    broadcastRecompositionControl(enabled)
    Log.d(TAG, "Recomposition tracking ${if (enabled) "enabled" else "disabled"}")
  }

  private fun applyAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) {
    // occlusionEnabled isn't an AccessibilityServiceInfo flag, so store it unconditionally —
    // it must take effect even before serviceInfo is available (the early-return below).
    this.occlusionEnabled = occlusionEnabled

    val info =
      serviceInfo
        ?: run {
          Log.w(TAG, "Cannot apply accessibility flags — serviceInfo is null")
          return
        }

    val flags =
      computeAccessibilityServiceFlags(
        currentFlags = info.flags,
        includeNotImportantViews = includeNotImportantViews,
        reportViewIds = reportViewIds,
        retrieveInteractiveWindows = retrieveInteractiveWindows,
      )

    // Skip the reassignment when the computed bitmask matches what's already applied.
    // serviceInfo = info reconfigures a LIVE AccessibilityService on the system side, not a
    // local no-op - the client now re-invokes this on every ensureConnected() (not just fresh
    // connects), so without this guard every single tool call reconfigures the service even
    // when nothing changed, which was observed to disrupt in-flight hierarchy capture
    // (elements=0 on every observe for an entire run).
    if (flags == info.flags) {
      Log.d(TAG, "Accessibility flags unchanged (flags=$flags) - skipping serviceInfo reassignment")
      return
    }

    info.flags = flags
    serviceInfo = info

    Log.i(
      TAG,
      "Applied accessibility flags: " +
        "includeNotImportantViews=$includeNotImportantViews, " +
        "reportViewIds=$reportViewIds, " +
        "retrieveInteractiveWindows=$retrieveInteractiveWindows, " +
        "occlusionEnabled=$occlusionEnabled",
    )
  }

  private fun broadcastRecompositionControl(enabled: Boolean) {
    try {
      val intent =
        Intent(AutoMobileSDK.ACTION_RECOMPOSITION_CONTROL).apply {
          putExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_ENABLED, enabled)
        }
      sendBroadcast(intent)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to broadcast recomposition control", e)
    }
  }

  private fun broadcastNetworkMockRules(requestId: String?, rulesJson: String) {
    try {
      val intent =
        Intent(NetworkMockRuleStore.ACTION_NETWORK_MOCK_RULES).apply {
          putExtra(NetworkMockRuleStore.EXTRA_RULES_JSON, rulesJson)
        }
      if (requestId == null) {
        sendBroadcast(intent)
        Log.d(TAG, "Broadcast network mock rules")
        return
      }
      // The app's rule store answers an ordered broadcast through its result data (which rules the
      // device's regex engine rejected); forward that to the host as the correlated reply. An SDK
      // that predates the reply leaves the data null and the host reports "not confirmed".
      sendOrderedBroadcast(
        intent,
        null,
        object : BroadcastReceiver() {
          override fun onReceive(context: Context?, intent: Intent?) {
            replyNetworkMockRules(networkMockRulesResult(requestId, resultData))
          }
        },
        null,
        Activity.RESULT_OK,
        null,
        null,
      )
      Log.d(TAG, "Broadcast network mock rules (awaiting report)")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to broadcast network mock rules", e)
      if (requestId != null) {
        replyNetworkMockRules(
          networkMockRulesFailure(
            requestId,
            "Failed to broadcast network mock rules: ${e.message}",
          ),
        )
      }
    }
  }

  private fun replyNetworkMockRules(result: SetNetworkMockRulesResult) {
    if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
      serviceScope.launch { webSocketServer.broadcast(result) }
    }
  }

  private fun broadcastNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) {
    try {
      val intent =
        Intent(NetworkMockRuleStore.ACTION_NETWORK_ERROR_SIMULATION).apply {
          remainingMs?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_REMAINING_MS, it) }
          putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_ENABLED, enabled)
          errorType?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_TYPE, it) }
          limit?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_LIMIT, it) }
          expiresAtEpochMs?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_EXPIRES_AT, it) }
        }
      sendBroadcast(intent)
      Log.d(TAG, "Broadcast network error simulation: enabled=$enabled type=$errorType")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to broadcast network error simulation", e)
    }
  }

  private fun isPrototypeBlocked(): Boolean {
    val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
    // Missing safety services fail closed rather than allowing a prototype over an unknown lock
    // state.
    return keyguard?.isKeyguardLocked != false ||
      power?.isInteractive != true ||
      // Another app is in front: hidden like a lock, but tracked separately (#10261).
      prototypeForeground.suspended
  }

  /** The application in front, from the accessibility windows; null when none qualifies. */
  private fun currentForegroundApp(): String? =
    try {
      prototypeForegroundFromWindows(
        windows.map {
          PrototypeForegroundWindow(it.type, it.isActive, it.root?.packageName?.toString())
        },
        packageName,
      )
    } catch (error: Exception) {
      // Unreadable windows leave the prototype unscoped (shown everywhere) rather than hiding it.
      Log.w(TAG, "Foreground app unavailable for prototype scoping", error)
      null
    }

  /** Feeds a window-state event to prototype foreground scoping, only while a prototype exists. */
  private fun trackPrototypeForeground(event: AccessibilityEvent, eventPackage: String?) {
    if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
    if (!::prototypeController.isInitialized) return
    if (!prototypeController.isShowing && !prototypeController.isSuspendedByForeground) return
    prototypeForeground.onWindowEvent(eventPackage, ownEventWindowType(event))
  }

  /** The keyboard's reach up from [displayId]'s bottom edge, from its accessibility window. */
  private fun prototypeImeLiftPx(displayId: Int): Int {
    val screen = getScreenDimensions(displayId) ?: return 0
    val windows =
      viewHierarchyExtractor.windowsForDisplay(this, displayId).map {
        val bounds = Rect()
        it.getBoundsInScreen(bounds)
        PrototypeImeWindow(it.type, bounds.top, bounds.bottom)
      }
    return imeLiftPx(windows, screen.height)
  }

  private suspend fun refreshPrototypeWindowNow() {
    if (::prototypeController.isInitialized) prototypeController.onConfigurationChanged()
  }

  private fun refreshPrototypeWindow() {
    if (::prototypeController.isInitialized) {
      val controller = prototypeController
      serviceScope.launch { controller.onConfigurationChanged() }
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    refreshPrototypeWindow()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event == null) {
      Log.w(TAG, "onAccessibilityEvent: no event")
      return
    }

    // Prototype animations must not feed the hierarchy debouncer or navigation tracking. Only the
    // prototype's OWN accessibility-overlay windows are dropped: this package also owns the
    // CtrlProxy
    // keyboard (input-method window) and MainActivity, whose events must keep advancing
    // frameContext
    // and feeding the hierarchy push. The window type is resolved only for own-package events.
    val eventPackage = event.packageName?.toString()
    val ownWindowType = if (eventPackage == packageName) ownEventWindowType(event) else null
    val appLayerShowing =
      ::prototypeController.isInitialized && prototypeController.isAppLayerShowing
    if (shouldSkipOwnOverlayEvent(eventPackage, packageName, ownWindowType, appLayerShowing)) return
    // A window appearing in an app is the cheapest sign its process (re)started; an open storage
    // subscription uses it to re-arm the app-side listener a restart wiped (#10069). A map miss
    // for every package without a subscription, so this is free on the hot path.
    if (
      eventPackage != null &&
        event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
        ::storageSubscriptionManager.isInitialized
    ) {
      storageSubscriptionManager.onPackageActivity(eventPackage)
    }
    trackPrototypeForeground(event, eventPackage)
    if (
      event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
        event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED
    )
      refreshPrototypeWindow()

    try {
      when (event.eventType) {
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
        AccessibilityEvent.TYPE_WINDOWS_CHANGED,
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED -> rememberedInsert = null
        AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> {
          val caret = rememberedInsert?.second?.caret
          if (
            caret != null &&
              (event.fromIndex != caret.reportedStart || event.toIndex != caret.reportedEnd)
          ) {
            rememberedInsert = null
          }
        }
      }
      if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
        lastWindowClassName = event.className?.toString()
      }

      // Advance the frameContext staleness token on every UI-changing event REGARDLESS of observers
      // (issue #5470 review). If it froze while unobserved, a token minted before the last client
      // disconnected could still pass the daemon/runner staleness check after reconnect even though
      // the screen changed during the gap, aiming an input action at the wrong UI state. This is a
      // cheap atomic increment maintaining the invariant; only the expensive work below is gated.
      if (advancesFrameContext(event.eventType)) {
        frameContext.incrementAndGet()
      }

      val connectionCount =
        if (::webSocketServer.isInitialized) webSocketServer.getConnectionCount() else 0

      // "Is anyone observing?" gate (issue #5470). Both the interaction/scroll recording below and
      // the debounced hierarchy refresh further down are PUSH work only a connected client
      // consumes, so with zero connections we skip them — before touching event.source, allocating,
      // extracting, or hashing. The frameContext token above still advanced. Stale cross-session
      // scroll deltas are discarded at scroll-accumulation time via accumulatePendingScroll (keyed
      // on the observer-session generation), so no observer-gap cleanup is needed here. The pull
      // path (request_hierarchy) does not go through here and stays functional with zero observers.
      val work = accessibilityEventWorkFor(event.eventType, connectionCount)

      // Broadcast interaction events for telemetry tracking. Classification is routed through the
      // shared [interactionDispatchFor] so the subscribed event-type mask (derived from the same
      // classifier) can never drift from what this `when` actually acts on.
      when (work.interaction) {
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
          val now = System.currentTimeMillis()
          if (now - lastInputTextBroadcastMs >= inputTextDebounceMs) {
            lastInputTextBroadcastMs = now
            recordInteractionEvent(event, "inputText")
          }
        }
        // frameContext already advanced above (unconditionally); here we only do the gated,
        // expensive scroll recording, which runs solely when observed.
        InteractionDispatch.SCROLL -> recordDebouncedScroll(event)
        null -> {} // event type this service does not act on
      }

      // Delegate to the smart debouncer for content/window changes (same shared classifier). The
      // debouncer uses structural hash comparison to detect animation vs real changes. Gated on an
      // observer (issue #5470): with no client connected, work.refreshesHierarchy is false, so the
      // extraction/hash is skipped. The frameContext token advanced unconditionally above.
      if (work.refreshesHierarchy) {
        if (::hierarchyDebouncer.isInitialized) {
          hierarchyDebouncer.onAccessibilityEvent()
        }
      }
    } catch (e: Exception) {
      Log.e(TAG, "Error handling accessibility event", e)
      // Don't let event handling crash the service
    }
  }

  override fun onInterrupt() {
    Log.w(TAG, "Accessibility service interrupted")
  }

  private fun recordInteractionEvent(event: AccessibilityEvent, type: String) {
    // Observer gate (issue #5470): early-return BEFORE reading event.source / getBoundsInScreen /
    // allocating when nobody is connected. onAccessibilityEvent already gates dispatch on the same
    // count; this is the defensive backstop for the scroll/debounced callers, and
    // getConnectionCount
    // > 0 also implies the server is running.
    if (!::webSocketServer.isInitialized || webSocketServer.getConnectionCount() <= 0) {
      return
    }

    val source =
      try {
        event.source
      } catch (_: Exception) {
        null
      }
    val bounds = source?.let {
      try {
        val rect = Rect()
        it.getBoundsInScreen(rect)
        ElementBounds(rect)
      } catch (_: Exception) {
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
        // Fallback: extract what we can from the AccessibilityEvent itself
        val eventText = event.text?.joinToString("") { it.toString() }?.takeIf { it.isNotEmpty() }
        val eventDesc = event.contentDescription?.toString()
        val eventClass = event.className?.toString()
        if (eventText != null || eventDesc != null || eventClass != null) {
          InteractionElement(
            text = eventText,
            contentDescription = eventDesc,
            resourceId = null,
            className = eventClass,
            bounds = null,
          )
        } else null
      }
    try {
      source?.recycle()
    } catch (_: Exception) {
      /* already recycled */
    }

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
        timestamp = System.currentTimeMillis(),
        packageName = event.packageName?.toString(),
        screenClassName = lastWindowClassName,
        element = element,
        text = textValue,
        scrollDeltaX = scrollDeltaX,
        scrollDeltaY = scrollDeltaY,
      )

    serviceScope.launch {
      try {
        broadcastInteractionEvent(interaction)
      } catch (e: CancellationException) {
        // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3130).
        throw e
      } catch (e: Exception) {
        Log.e(TAG, "Error broadcasting interaction event", e)
      }
    }
  }

  /**
   * Debounce scroll events — accumulate deltas and emit once scrolling stops. TYPE_VIEW_SCROLLED
   * fires many times per scroll gesture (every frame).
   */
  private fun recordDebouncedScroll(event: AccessibilityEvent) {
    val now = System.currentTimeMillis()
    // Only observed events reach here (the onAccessibilityEvent gate), so observerSessionGeneration
    // reflects the current session. Fold this sample in through accumulatePendingScroll, which
    // discards any accumulation tagged with a prior session first — closing the event-free-gap hole
    // where a disconnect+reconnect between samples would otherwise let stale deltas combine with
    // the
    // first post-reconnect scroll (issue #5470 review). The generation is stable while any client
    // stays connected, so a concurrent client joining mid-scroll does not drop the in-flight
    // deltas.
    // Store extracted fields, not the event reference (Android recycles it).
    val sampleDeltaX = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) event.scrollDeltaX else 0
    val sampleDeltaY = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) event.scrollDeltaY else 0
    val currentGeneration =
      if (::webSocketServer.isInitialized) webSocketServer.observerSessionGeneration() else 0
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
    val now = System.currentTimeMillis()
    if (now - lastA11yFocusTapMs >= a11yFocusTapDebounceMs) {
      lastA11yFocusTapMs = now
      recordInteractionEvent(event, type)
    }
  }

  private suspend fun broadcastInteractionEvent(interaction: InteractionEvent) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping interaction event broadcast")
      return
    }

    webSocketServer.broadcast(
      webSocketFrameJson("interaction_event", timestamp = interaction.timestamp) {
        put("event", jsonCompact.encodeToJsonElement(interaction))
      },
    )
  }

  private fun resolveSystemApp(packageName: String): Boolean? {
    return try {
      val appInfo = packageManager.getApplicationInfo(packageName, 0)
      (appInfo.flags and
        (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0
    } catch (e: Exception) {
      Log.w(TAG, "Failed to resolve system flag for $packageName", e)
      null
    }
  }

  private suspend fun broadcastPackageEvent(
    action: String,
    packageName: String,
    userId: Int,
    uid: Int?,
    isSystem: Boolean?,
    removedForAllUsers: Boolean,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping package event broadcast")
      return
    }

    try {
      val timestamp = System.currentTimeMillis()
      val message =
        webSocketFrameJson("package_event", timestamp = timestamp) {
          put(
            "event",
            packageEventJson(action, packageName, userId, uid, isSystem, removedForAllUsers),
          )
        }
      webSocketServer.broadcast(message)
      Log.d(TAG, "Broadcasted package event to ${webSocketServer.getConnectionCount()} clients")
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting package event", e)
    }
  }

  /** Get current screen dimensions for offscreen filtering. */
  @Suppress("DEPRECATION")
  private fun getScreenDimensions(displayId: Int = Display.DEFAULT_DISPLAY): ScreenDimensions? {
    return try {
      if (displayId != Display.DEFAULT_DISPLAY && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val displayManager =
          getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager
        val display = displayManager?.getDisplay(displayId) ?: return null
        val size = Point()
        display.getRealSize(size)
        return ScreenDimensions(size.x, size.y)
      }
      val windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
      if (windowManager != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val bounds = windowManager.currentWindowMetrics.bounds
          ScreenDimensions(bounds.width(), bounds.height())
        } else {
          val displayMetrics = DisplayMetrics()
          windowManager.defaultDisplay.getRealMetrics(displayMetrics)
          ScreenDimensions(displayMetrics.widthPixels, displayMetrics.heightPixels)
        }
      } else {
        null
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get screen dimensions", e)
      null
    }
  }

  private fun activeDisplayId(): Int = viewHierarchyExtractor.selectDisplayWindows(this).displayId

  private fun panelUniqueId(displayId: Int): String? =
    (getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager)
      ?.getDisplay(displayId)
      .let(::panelUniqueIdOf)

  /** Get the top system inset (status bar height) for coordinate adjustment. */
  @Suppress("DEPRECATION")
  private fun getTopSystemInset(): Int {
    return try {
      val windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
      if (windowManager != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val metrics = windowManager.currentWindowMetrics
          val insets =
            metrics.windowInsets.getInsetsIgnoringVisibility(
              android.view.WindowInsets.Type.systemBars(),
            )
          insets.top
        } else {
          val resourceId = resources.getIdentifier("status_bar_height", "dimen", "android")
          if (resourceId > 0) resources.getDimensionPixelSize(resourceId) else 0
        }
      } else {
        0
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get top system inset", e)
      0
    }
  }

  /** Get current display rotation. Returns 0=portrait, 1=landscape90, 2=reverse, 3=landscape270. */
  @Suppress("DEPRECATION")
  private fun getRotation(): Int {
    return getRotationOrNull() ?: 0
  }

  /**
   * Read the display rotation without inventing portrait when the display is unavailable.
   * Screenshot capture provenance uses this nullable form: an unknown rotation must make desktop
   * control fail closed, unlike the older diagnostic hierarchy/device-info fields that retain their
   * 0 fallback.
   */
  @Suppress("DEPRECATION")
  private fun getRotationOrNull(displayId: Int = Display.DEFAULT_DISPLAY): Int? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Use DisplayManager for AccessibilityService context (can't use context.display)
        val displayManager =
          getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager
        displayManager?.getDisplay(displayId)?.rotation
      } else {
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        windowManager?.defaultDisplay?.rotation
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get rotation", e)
      null
    }
  }

  /** Supplies each requested display's inset categories and [SystemChromeInfo] visibility. */
  private val displayInsetsProvider: DisplayInsetsProvider by lazy {
    createDisplayInsetsProvider(this)
  }

  /** Get typed current-window inset metadata for coordinate and layout inspection. */
  @Suppress("DEPRECATION")
  private fun getObservationInsets(
    screenDimensions: ScreenDimensions?,
    displayId: Int = Display.DEFAULT_DISPLAY,
  ): ObservationInsetsInfo {
    if (displayId != Display.DEFAULT_DISPLAY) {
      return displayInsetsProvider.insetsFor(displayId, screenDimensions)
    }
    return try {
      val windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
      if (windowManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val metrics = windowManager.currentWindowMetrics
        val windowInsets = metrics.windowInsets
        observationInsetsFromWindowInsets(windowInsets, screenDimensions)
      } else {
        // API 24-29 cannot provide the typed WindowInsets categories from this service context.
        val statusBarId = resources.getIdentifier("status_bar_height", "dimen", "android")
        val navBarId = resources.getIdentifier("navigation_bar_height", "dimen", "android")
        val statusBarHeight =
          if (statusBarId > 0) resources.getDimensionPixelSize(statusBarId) else 0
        val navBarHeight = if (navBarId > 0) resources.getDimensionPixelSize(navBarId) else 0
        val bars =
          SystemInsetsInfo(top = statusBarHeight, bottom = navBarHeight, left = 0, right = 0)
        ObservationInsetsInfo(
          source = "android-resource-fallback",
          systemBars = SystemBarsInsetsInfo(visible = bars, stable = bars),
          displayCutoutInfo = DisplayCutoutInfo.unknown(),
        )
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get system insets", e)
      ObservationInsetsInfo(
        available = false,
        source = "unavailable",
        units = "unknown",
        displayCutoutInfo = DisplayCutoutInfo.unknown(),
      )
    }
  }

  /** Get device wakefulness state: "Awake", "Asleep", or "Dozing". */
  private fun getWakefulness(): String {
    return try {
      val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (powerManager == null) {
        "Awake"
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && powerManager.isDeviceIdleMode) {
        "Dozing"
      } else if (powerManager.isInteractive) {
        "Awake"
      } else {
        "Asleep"
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get wakefulness", e)
      "Awake"
    }
  }

  /**
   * Get the foreground activity component name using accessibility service state. Uses
   * rootInActiveWindow (reliable on all API levels) + lastWindowClassName from
   * TYPE_WINDOW_STATE_CHANGED events, avoiding the restricted ActivityManager.getRunningTasks()
   * API.
   */
  private fun getForegroundActivity(
    rootPackage: String? = null,
    windowClass: String? = null,
  ): String? {
    return try {
      val pkg = rootPackage
      val className = windowClass
      if (pkg != null && className != null) {
        if (isFrameworkViewClass(className)) {
          // Accessibility reports the root View class for many app windows,
          // which is not the resumed Activity and must not shadow the ADB
          // fallback on the host.
          return null
        }
        // Use short class name format if it starts with the package
        val shortName =
          if (className.startsWith(pkg)) {
            className.removePrefix(pkg)
          } else {
            className
          }
        "$pkg/$shortName"
      } else {
        // Don't return package-only value — it produces an empty activityName
        // in ObserveScreen and prevents the ADB fallback from filling the real one
        null
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get foreground activity", e)
      null
    }
  }

  private fun isFrameworkViewClass(className: String): Boolean =
    className.startsWith("android.widget.") ||
      className.startsWith("android.view.") ||
      className.endsWith("DecorView")

  /** Get display density in DPI. */
  private fun getDensity(): Int {
    return try {
      resources.displayMetrics.densityDpi
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get density", e)
      0
    }
  }

  /** Check if running on an emulator. */
  /**
   * Runtime `AccessibilityServiceInfo.isAccessibilityTool` of this bound service (#6233). The
   * getter exists from API 31; below that (or without serviceInfo) the value is unknown (null).
   */
  private fun getAccessibilityTool(): Boolean? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) serviceInfo?.isAccessibilityTool else null

  private fun getIsEmulator(): Boolean {
    return (Build.FINGERPRINT.startsWith("generic") ||
      Build.FINGERPRINT.startsWith("unknown") ||
      Build.MODEL.contains("google_sdk") ||
      Build.MODEL.contains("Emulator") ||
      Build.MODEL.contains("Android SDK built for x86") ||
      Build.MANUFACTURER.contains("Genymotion") ||
      Build.HARDWARE.contains("goldfish") ||
      Build.HARDWARE.contains("ranchu") ||
      Build.PRODUCT.contains("sdk_gphone") ||
      Build.PRODUCT.contains("emulator") ||
      Build.PRODUCT.contains("simulator"))
  }

  /**
   * Execute a global action (back, home, recents, etc.) via the accessibility service. Returns true
   * if the action was dispatched successfully.
   */
  private fun executeGlobalAction(action: String): Boolean {
    val actionId =
      when (action.lowercase()) {
        "back" -> GLOBAL_ACTION_BACK
        "home" -> GLOBAL_ACTION_HOME
        "recent",
        "recents" -> GLOBAL_ACTION_RECENTS
        "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
        "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
        "lock_screen" ->
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            GLOBAL_ACTION_LOCK_SCREEN
          } else {
            return false
          }
        else -> return false
      }
    return performGlobalAction(actionId)
  }

  /** Handle a request_global_action WebSocket message. */
  private fun performGlobalActionRequest(requestId: String?, action: String) {
    rememberedInsert = null
    val startTime = System.currentTimeMillis()
    val success = executeGlobalAction(action)
    val totalTimeMs = System.currentTimeMillis() - startTime
    asyncActionRunner.launch(requestId, "request_global_action") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.GlobalActionResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          action = action,
          totalTimeMs = totalTimeMs,
          error = if (!success) "Unsupported or failed action: $action" else null,
        ),
      )
    }
  }

  /** Handle a request_device_info WebSocket message. */
  private fun performDeviceInfoRequest(requestId: String?) {
    val startTime = System.currentTimeMillis()
    val screenDimensions = getScreenDimensions()
    val foreground = getForegroundActivity()
    val totalTimeMs = System.currentTimeMillis() - startTime
    asyncActionRunner.launch(requestId, "request_device_info") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.DeviceInfoResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = true,
          screenWidth = screenDimensions?.width,
          screenHeight = screenDimensions?.height,
          density = getDensity(),
          rotation = getRotation(),
          sdkInt = Build.VERSION.SDK_INT,
          deviceModel = Build.MODEL,
          isEmulator = getIsEmulator(),
          wakefulness = getWakefulness(),
          foregroundActivity = foreground,
          totalTimeMs = totalTimeMs,
        ),
      )
    }
  }

  /**
   * Direct hierarchy extraction without debouncing. Used by the HierarchyDebouncer. Extracts from
   * all visible windows to capture popups, toolbars, etc.
   */
  private fun extractHierarchyDirect(
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  ): ViewHierarchy? {
    val contextAtExtractionStart = currentFrameContext()
    // Bracket every input acquisition and the extraction itself. If rotation changes anywhere in
    // that interval, hierarchy geometry cannot be proven to match a single display orientation.
    val selected = viewHierarchyExtractor.selectDisplayWindows(this, snapshotOptions.displayId)
    val targetDisplayId = selected.displayId
    val rotationCapture = rotationProvenance.beginCapture(targetDisplayId)
    val rotationAtCaptureStart = getRotationOrNull(targetDisplayId)
    val allWindows = selected.windows
    val rootNode =
      viewHierarchyExtractor.rootForDisplay(rootInActiveWindow, allWindows, targetDisplayId)
    // Capture foreground info atomically with rootNode to avoid race conditions
    // where the app state changes between hierarchy extraction and getForegroundActivity()
    val capturedRootPackage = rootNode?.packageName?.toString()
    val capturedWindowClass = lastWindowClassName
    val screenDimensions = getScreenDimensions(targetDisplayId)
    val insets = getObservationInsets(screenDimensions, targetDisplayId)

    if (allWindows.isNullOrEmpty() && rootNode == null) {
      Log.w(TAG, "No windows or root node available for extraction")
      return null
    }

    // Use multi-window extraction if windows are available, otherwise fall back to single window
    val hierarchy =
      if (!allWindows.isNullOrEmpty()) {
        Log.d(
          TAG,
          "Extracting from ${allWindows.size} windows " +
            "(disableAllFiltering: $disableAllFiltering, occlusionEnabled: $occlusionEnabled)",
        )
        viewHierarchyExtractor.extractFromAllWindows(
          allWindows,
          rootNode,
          null,
          screenDimensions,
          true,
          disableAllFiltering,
          occlusionEnabled,
          snapshotOptions = snapshotOptions,
          displayId = targetDisplayId,
          panelUniqueId = panelUniqueId(targetDisplayId),
        )
      } else {
        viewHierarchyExtractor.extractFromActiveWindow(
          rootNode,
          null,
          screenDimensions,
          true,
          disableAllFiltering,
          snapshotOptions = snapshotOptions,
          displayId = targetDisplayId,
          panelUniqueId = panelUniqueId(targetDisplayId),
        )
      }

    if (snapshotOptions.isCancelled()) {
      // A cancelled snapshot will not be delivered; do not retain its frame-context entry.
      Log.d(TAG, "Discarding cancelled direct hierarchy extraction")
      return null
    }

    val rotation =
      rotationProvenance.rotationIfUnchanged(
        rotationCapture,
        rotationAtCaptureStart,
        getRotationOrNull(targetDisplayId),
        targetDisplayId,
      )
    // Bounding rectangles are only meaningful relative to the same orientation
    // as screenDimensions. Keep the established edge insets, but avoid emitting
    // stale geometry when the capture's orientation could not be proven.
    val captureInsets =
      if (rotation == null) {
        insets.copy(displayCutoutInfo = DisplayCutoutInfo.unknown())
      } else {
        insets
      }

    // Add device metadata to the hierarchy (eliminates need for dumpsys calls on client)
    val wakefulness = getWakefulness()
    val foreground = getForegroundActivity(capturedRootPackage, capturedWindowClass)
    val density = getDensity()
    val enriched =
      HierarchyMetadataBuilder.enrich(
        hierarchy,
        HierarchyMetadata(
          displayId = targetDisplayId,
          panelUniqueId = panelUniqueId(targetDisplayId),
          screenWidth = screenDimensions?.width,
          screenHeight = screenDimensions?.height,
          rotation = rotation,
          systemInsets = legacySystemInsets(captureInsets),
          insets = captureInsets,
          wakefulness = wakefulness,
          foregroundActivity = foreground,
          density = density,
          sdkInt = Build.VERSION.SDK_INT,
          deviceModel = Build.MODEL,
          isEmulator = getIsEmulator(),
          accessibilityTool = getAccessibilityTool(),
        ),
      )
    val hierarchyWithScaleMetadata = withScaleMetadata(enriched, screenDimensions)
    if (hierarchyWithScaleMetadata != null && contextAtExtractionStart == currentFrameContext()) {
      extractedHierarchyFrameContexts[hierarchyWithScaleMetadata] = contextAtExtractionStart
    }
    return hierarchyWithScaleMetadata
  }

  /**
   * Apply the additive #4548 scale metadata to a hierarchy response. Android accessibility bounds
   * and screenshots are both physical pixels, so the bounds->pixel ratio is exactly 1 and the pixel
   * dimensions equal the reported screen dimensions; the fields are omitted (null) when screen
   * dimensions are unavailable. EVERY route that produces a hierarchy response — the debounced
   * direct extraction ([extractHierarchyDirect]) AND the ADB EXTRACT_HIERARCHY broadcast
   * ([extractHierarchy]) — passes through here, so the daemon can retain the metadata regardless of
   * which route delivered the hierarchy (#4548).
   */
  private fun withScaleMetadata(
    hierarchy: ViewHierarchy?,
    screenDimensions: ScreenDimensions?,
  ): ViewHierarchy? =
    hierarchy?.copy(
      nativeScale = if (screenDimensions != null) 1f else null,
      pixelWidth = screenDimensions?.width,
      pixelHeight = screenDimensions?.height,
    )

  /**
   * Extract hierarchy immediately and broadcast synchronously, bypassing the debouncer and the
   * SharedFlow async path. Used for explicit WebSocket requests where the daemon is waiting for
   * fresh data. Matches the sync=true pattern used by tap/setText/imeAction handlers.
   */
  private suspend fun extractHierarchyNow(
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
    requestId: String? = null,
  ) {
    Log.d(TAG, "extractHierarchyNow (disableAllFiltering: $disableAllFiltering)")
    val commandJob = currentCoroutineContext()[Job]
    val cancellableOptions =
      snapshotOptions.copy(
        isCancelled = {
          snapshotOptions.isCancelled() ||
            commandJob?.isActive == false ||
            serviceScope.coroutineContext[Job]?.isActive == false
        },
      )
    try {
      val hierarchy =
        try {
          hierarchyDebouncer.extractImmediately(
            skipFlowEmit = true,
            disableAllFiltering = disableAllFiltering,
            snapshotOptions = cancellableOptions,
          )
        } catch (e: CancellationException) {
          // Command cancellation must unwind; an independently cancelled snapshot returns null.
          throw e
        } catch (e: Exception) {
          Log.e(TAG, "Error extracting WebSocket hierarchy for requestId=$requestId", e)
          if (requestId == null) throw e
          commandJob?.let { it.ensureActive() }
          serviceScope.coroutineContext[Job]?.ensureActive()
          broadcastHierarchyExtractFrame(
            HierarchyExtractErrorFrames.thrownFrame(requestId, e),
            externallyCorrelated = false,
          )
          if (::webSocketServer.isInitialized) webSocketServer.releaseRequestOwner(requestId)
          // The extraction failure is settled here, so neither the queue nor scope guard replies.
          return
        }
      if (hierarchy != null) {
        // Explicit request: force-write the file and broadcast, serializing the tree once (#5469).
        // Routed through deliverHierarchyFrame so the frame-context entry is released even if the
        // encode throws (leak fix).
        deliverHierarchyFrame(
          serialize = {
            commandJob?.ensureActive()
            perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }
          },
          write = { serialized -> writeHierarchyToFile(hierarchy, serialized = serialized) },
          broadcast = { serialized ->
            broadcastHierarchyUpdate(
              hierarchy,
              sync = true,
              serialized = serialized,
              requestId = requestId,
              routeByRequestId = false,
            )
          },
          releaseFrameContext = { extractedHierarchyFrameContexts.remove(hierarchy) },
        )
      } else {
        commandJob?.ensureActive()
        serviceScope.coroutineContext[Job]?.ensureActive()
        broadcastHierarchyExtractFrame(
          HierarchyExtractErrorFrames.nullResultFrame(requestId),
          externallyCorrelated = false,
        )
      }
      if (::webSocketServer.isInitialized) webSocketServer.releaseRequestOwner(requestId)
    } catch (e: CancellationException) {
      if (::webSocketServer.isInitialized) webSocketServer.releaseRequestOwner(requestId)
      throw e
    }
  }

  /**
   * Writes the hierarchy to a file for synchronous access. Callers that already serialized the tree
   * for the wire frame pass that exact compact string via [serialized] so a single change is never
   * serialized twice (issue #5469); the file therefore holds the same canonical form as the wire.
   */
  private fun writeHierarchyToFile(
    hierarchy: ViewHierarchy,
    filename: String = HIERARCHY_FILE_NAME,
    serialized: String? = null,
  ) {
    try {
      val jsonString = serialized ?: jsonCompact.encodeToString(hierarchy)
      val jsonBytes = jsonString.toByteArray()
      openFileOutput(filename, Context.MODE_PRIVATE).use { output ->
        Log.d(TAG, "Writing ${jsonBytes.size} bytes to $filename")
        output.write(jsonBytes)
        output.flush()
      }
    } catch (e: Exception) {
      Log.e(TAG, "Error writing hierarchy to file: $filename", e)
    }
  }

  private suspend fun handleCommand(intent: Intent) {
    // Clean up any lingering UUID-based hierarchy files before processing new requests
    cleanupUuidHierarchyFiles()

    when (intent.action) {
      ACTION_EXTRACT_HIERARCHY -> {
        val uuid = intent.getStringExtra("uuid")
        if (uuid.isNullOrBlank()) {
          // No uuid to correlate a WebSocket error frame to, so only the legacy ADB result is sent.
          sendResult(success = false, error = "UUID parameter is required")
          return
        }

        // The daemon's ADB-broadcast hierarchy fallback awaits this uuid over the WebSocket in
        // waitForFreshData. On extraction failure we send a correlated error frame keyed by the
        // uuid so that wait fails fast rather than hanging to timeout, closing the last member of
        // the #3032/#3061 hang class (issue #3089). The legacy ADB result broadcast is retained.
        try {
          val textFilter = intent.getStringExtra("text")
          val disableAllFiltering = intent.getBooleanExtra("disableAllFiltering", false)
          val hierarchy = extractHierarchy(textFilter, disableAllFiltering)
          if (hierarchy != null) {
            val filename = "hierarchy_$uuid.json"
            // Explicit request: serialize once and reuse for the file and the wire frame (#5469).
            // Routed through deliverHierarchyFrame so the frame-context entry is released even if
            // the encode throws (leak fix) — the outer catch still reports the failure frame.
            deliverHierarchyFrame(
              serialize = {
                perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }
              },
              write = { serialized ->
                writeHierarchyToFile(hierarchy, filename, serialized = serialized)
              },
              broadcast = { serialized ->
                broadcastHierarchyUpdate(hierarchy, serialized = serialized, requestId = uuid)
              },
              releaseFrameContext = { extractedHierarchyFrameContexts.remove(hierarchy) },
            )

            val message =
              if (textFilter != null) {
                "Hierarchy extracted with text filter: '$textFilter', saved as $filename"
              } else {
                "Hierarchy extracted successfully, saved as $filename"
              }
            sendResult(success = true, data = message)
          } else {
            sendResult(success = false, error = HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR)
            broadcastHierarchyExtractFrame(HierarchyExtractErrorFrames.nullResultFrame(uuid))
          }
        } catch (e: CancellationException) {
          // Cooperative cancellation (service scope shutting down) must never be converted into an
          // error frame — let it propagate so the coroutine unwinds cleanly.
          throw e
        } catch (e: Exception) {
          Log.e(TAG, "Error extracting hierarchy for uuid=$uuid", e)
          sendResult(success = false, error = CorrelatedErrorReporter.causeOf(e))
          broadcastHierarchyExtractFrame(HierarchyExtractErrorFrames.thrownFrame(uuid, e))
        }
      }
    }
  }

  private fun extractHierarchy(
    textFilter: String? = null,
    disableAllFiltering: Boolean = false,
  ): ViewHierarchy? {
    val contextAtExtractionStart = currentFrameContext()
    // This is the synchronous ADB-broadcast fallback, not the debounced direct route above. It
    // must bracket the same inputs and extraction so the fallback never publishes a hierarchy
    // whose geometry and rotation came from different display states.
    val selected = viewHierarchyExtractor.selectDisplayWindows(this)
    val targetDisplayId = selected.displayId
    val rotationCapture = rotationProvenance.beginCapture(targetDisplayId)
    val rotationAtCaptureStart = getRotationOrNull(targetDisplayId)
    val allWindows = selected.windows
    val rootNode =
      viewHierarchyExtractor.rootForDisplay(rootInActiveWindow, allWindows, targetDisplayId)
    val capturedRootPackage = rootNode?.packageName?.toString()
    val capturedWindowClass = lastWindowClassName
    val screenDimensions = getScreenDimensions(targetDisplayId)
    val insets = getObservationInsets(screenDimensions, targetDisplayId)

    if (allWindows.isNullOrEmpty() && rootNode == null) {
      return null
    }

    val hierarchy =
      if (!allWindows.isNullOrEmpty()) {
        Log.d(
          TAG,
          "extractHierarchy from ${allWindows.size} windows " +
            "(disableAllFiltering: $disableAllFiltering, occlusionEnabled: $occlusionEnabled)",
        )
        viewHierarchyExtractor.extractFromAllWindows(
          allWindows,
          rootNode,
          textFilter,
          screenDimensions,
          true,
          disableAllFiltering,
          occlusionEnabled,
          displayId = targetDisplayId,
          panelUniqueId = panelUniqueId(targetDisplayId),
        )
      } else {
        viewHierarchyExtractor.extractFromActiveWindow(
          rootNode,
          textFilter,
          screenDimensions,
          true,
          disableAllFiltering,
          displayId = targetDisplayId,
          panelUniqueId = panelUniqueId(targetDisplayId),
        )
      }
    val rotation =
      rotationProvenance.rotationIfUnchanged(
        rotationCapture,
        rotationAtCaptureStart,
        getRotationOrNull(targetDisplayId),
        targetDisplayId,
      )
    val captureInsets =
      if (rotation == null) insets.copy(displayCutoutInfo = DisplayCutoutInfo.unknown()) else insets
    val enriched =
      HierarchyMetadataBuilder.enrich(
        hierarchy,
        HierarchyMetadata(
          displayId = targetDisplayId,
          panelUniqueId = panelUniqueId(targetDisplayId),
          screenWidth = screenDimensions?.width,
          screenHeight = screenDimensions?.height,
          rotation = rotation,
          systemInsets = legacySystemInsets(captureInsets),
          insets = captureInsets,
          wakefulness = getWakefulness(),
          foregroundActivity = getForegroundActivity(capturedRootPackage, capturedWindowClass),
          density = getDensity(),
          sdkInt = Build.VERSION.SDK_INT,
          deviceModel = Build.MODEL,
          isEmulator = getIsEmulator(),
          accessibilityTool = getAccessibilityTool(),
        ),
      )
    val hierarchyWithScaleMetadata = withScaleMetadata(enriched, screenDimensions)
    if (hierarchyWithScaleMetadata != null && contextAtExtractionStart == currentFrameContext()) {
      extractedHierarchyFrameContexts[hierarchyWithScaleMetadata] = contextAtExtractionStart
    }
    return hierarchyWithScaleMetadata
  }

  private fun sendResult(success: Boolean, data: String? = null, error: String? = null) {
    val resultIntent =
      Intent(ACTION_OPERATION_RESULT).apply {
        putExtra("success", success)
        putExtra("timestamp", System.currentTimeMillis())
        data?.let { putExtra("data", it) }
        error?.let { putExtra("error", it) }
      }
    sendBroadcast(resultIntent)
  }

  /**
   * Emit the correlated WebSocket `type:"error"` [frame] for a failed `EXTRACT_HIERARCHY`
   * broadcast, keyed by the broadcast's `sync_` `requestId` uuid. A null [frame] (blank/absent
   * uuid, or a cancellation the caller rethrows — see [HierarchyExtractErrorFrames]) is a no-op.
   *
   * The daemon's ADB-broadcast hierarchy fallback awaits that uuid in `waitForFreshData` over this
   * same WebSocket (the response channel the success-path `hierarchy_update` push also travels on).
   * Before issue #3089 a broadcast-handler failure only sent an ADB [ACTION_OPERATION_RESULT]
   * result that the daemon's wait could not correlate, so it degraded to a full timeout. Emitting
   * this frame closes that last member of the #3032/#3061 `waitForFreshData` hang class, mirroring
   * the WebSocket `req_`/`stale_` paths and the #2985 decode/handler error envelope.
   *
   * Routed through [ResultBroadcaster.guard] so a throw while *sending* this frame degrades to the
   * daemon's timeout rather than escaping the receiver coroutine (issue #3045 / #3085).
   */
  private suspend fun broadcastHierarchyExtractFrame(
    frame: ErrorResponse?,
    externallyCorrelated: Boolean = true,
  ) {
    // A null frame means there was nothing to correlate (blank/absent uuid, or a cooperative
    // cancellation that must propagate); HierarchyExtractErrorFrames already made that decision, so
    // there is no WebSocket frame to send here. See issue #3131.
    if (frame == null) return
    resultBroadcaster.guard(frame.requestId, "hierarchy_extract_error") {
      if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
        if (externallyCorrelated) webSocketServer.broadcastExternallyCorrelatedResponse(frame)
        else webSocketServer.broadcast(frame)
      }
    }
  }

  /**
   * Broadcast hierarchy update to WebSocket clients (suspend function for proper ordering).
   *
   * @param sync If true, enqueues for each client in call order; each client's sender drains its
   *   queue FIFO. Returns before socket delivery.
   */
  private suspend fun broadcastHierarchyUpdate(
    hierarchy: ViewHierarchy,
    sync: Boolean = false,
    serialized: String? = null,
    requestId: String? = null,
    routeByRequestId: Boolean = false,
  ) {
    val contextAtExtraction = extractedHierarchyFrameContexts.remove(hierarchy)
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping broadcast")
      return
    }

    try {
      // Reuse the string the caller already serialized for the disk file when present, so a single
      // change is serialized at most once (issue #5469); otherwise serialize the wire form here.
      val jsonString =
        serialized
          ?: perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }

      val messageBuilder: (kotlinx.serialization.json.JsonElement?) -> String = { perfTiming ->
        buildString {
          append(
            """{"type":"hierarchy_update","timestamp":${System.currentTimeMillis()},"data":$jsonString""",
          )
          if (requestId != null) {
            append(""","requestId":${jsonCompact.encodeToString(requestId)}""")
          }
          if (contextAtExtraction != null && contextAtExtraction == currentFrameContext()) {
            append(""","frameContext":"$contextAtExtraction"""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
      }

      withContext(PerfRequestContext(null)) {
        if (sync) {
          // Enqueue in call order; each client's sender preserves FIFO without waiting for
          // delivery.
          webSocketServer.broadcastWithPerfSync(
            routeByRequestId = routeByRequestId,
            messageBuilder = messageBuilder,
          )
        } else {
          // Async broadcast - for normal event-driven updates
          webSocketServer.broadcastWithPerf(
            routeByRequestId = routeByRequestId,
            messageBuilder = messageBuilder,
          )
        }
      }
      Log.d(
        TAG,
        "Broadcasted hierarchy update to ${webSocketServer.getConnectionCount()} clients (sync=$sync)",
      )
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting hierarchy update", e)
    }
  }

  /** Clean up any existing UUID-based hierarchy files */
  private fun cleanupUuidHierarchyFiles() {
    try {
      val filesDir = filesDir
      val files = filesDir.listFiles() ?: return

      var deletedCount = 0
      files.forEach { file ->
        if (
          file.name.startsWith("hierarchy_") &&
            file.name.endsWith(".json") &&
            file.name != HIERARCHY_FILE_NAME
        ) {
          if (file.delete()) {
            deletedCount++
            Log.d(TAG, "Deleted old hierarchy file: ${file.name}")
          } else {
            Log.w(TAG, "Failed to delete hierarchy file: ${file.name}")
          }
        }
      }

      if (deletedCount > 0) {
        Log.i(TAG, "Cleaned up $deletedCount old UUID hierarchy files")
      }
    } catch (e: Exception) {
      Log.e(TAG, "Error cleaning up UUID hierarchy files", e)
      // Don't let cleanup errors prevent the main operation
    }
  }

  /**
   * Takes a screenshot and returns it as a base64-encoded JPEG plus capture diagnostics. Requires
   * Android R (API 30) or higher. Runs on IO dispatcher to avoid blocking the main thread.
   */
  private suspend fun takeScreenshotAsync(
    targetDisplayId: Int,
    quality: Int = 80,
  ): ScreenshotCaptureOutcome {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      Log.w(TAG, "Screenshot API requires Android R (API 30) or higher")
      return ScreenshotCaptureOutcome.Failure(null)
    }

    return withContext(Dispatchers.IO) {
      try {
        val startTime = System.currentTimeMillis()

        // Use suspendCancellableCoroutine to bridge callback-based API
        val rotationCapture = rotationProvenance.beginCapture(targetDisplayId)
        val rotationAtCaptureStart = getRotationOrNull(targetDisplayId)
        val captured =
          suspendCancellableCoroutine<ScreenshotCallbackResult> { continuation ->
            takeScreenshot(
              targetDisplayId,
              mainExecutor,
              object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                  val hardwareBitmap =
                    Bitmap.wrapHardwareBuffer(
                      screenshot.hardwareBuffer,
                      screenshot.colorSpace,
                    )
                  screenshot.hardwareBuffer.close()
                  if (hardwareBitmap == null) {
                    continuation.resume(ScreenshotCallbackResult.Failed(null))
                    return
                  }
                  // A display change makes the pixels' orientation ambiguous. Preserve that
                  // ambiguity as null so desktop control fails closed rather than guessing.
                  val rotation =
                    rotationProvenance.rotationIfUnchanged(
                      rotationCapture,
                      rotationAtCaptureStart,
                      getRotationOrNull(targetDisplayId),
                      targetDisplayId,
                    )
                  continuation.resume(ScreenshotCallbackResult.Captured(hardwareBitmap, rotation))
                }

                override fun onFailure(errorCode: Int) {
                  // Retain the platform error code so the broadcast can distinguish a rate limit
                  // (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) from a real failure (issue #4927).
                  Log.e(TAG, "Screenshot failed with error code: $errorCode")
                  continuation.resume(ScreenshotCallbackResult.Failed(errorCode))
                }
              },
            )
          }

        if (captured is ScreenshotCallbackResult.Failed) {
          Log.e(TAG, "Failed to capture screenshot bitmap (errorCode=${captured.errorCode})")
          return@withContext ScreenshotCaptureOutcome.Failure(captured.errorCode)
        }

        val (bitmap, rotation) = captured as ScreenshotCallbackResult.Captured

        val screenshotTime = System.currentTimeMillis() - startTime
        Log.d(TAG, "Screenshot captured in ${screenshotTime}ms (${bitmap.width}x${bitmap.height})")

        // Convert to JPEG bytes on IO thread
        val encodeStart = System.currentTimeMillis()
        val outputStream = ByteArrayOutputStream()

        // Convert hardware bitmap to software bitmap for compression
        val softwareBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, false)
        bitmap.recycle()

        softwareBitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
        softwareBitmap.recycle()

        val jpegBytes = outputStream.toByteArray()
        val base64String = Base64.encodeToString(jpegBytes, Base64.NO_WRAP)

        val encodeTime = System.currentTimeMillis() - encodeStart
        val totalTime = System.currentTimeMillis() - startTime

        Log.d(
          TAG,
          "Screenshot encoded: ${jpegBytes.size} bytes -> ${base64String.length} base64 chars in ${encodeTime}ms (total: ${totalTime}ms)",
        )

        ScreenshotCaptureOutcome.Success(
          ScreenshotCapturePayload(
            base64Image = base64String,
            rotation = rotation,
            displayId = targetDisplayId,
            panelUniqueId = panelUniqueId(targetDisplayId),
            captureDurationMs = screenshotTime,
            encodeDurationMs = encodeTime,
            byteLength = jpegBytes.size,
            base64Length = base64String.length,
          ),
        )
      } catch (e: CancellationException) {
        // The awaiting caller is being cancelled — rethrow instead of converting the cancellation
        // into a null screenshot (#3191).
        throw e
      } catch (e: Exception) {
        Log.e(TAG, "Error taking screenshot", e)
        ScreenshotCaptureOutcome.Failure(null)
      }
    }
  }

  /**
   * Dispatch a built gesture and centralize the callback/perf lifecycle shared by every gesture
   * action. The caller owns gesture construction and result broadcasting; this helper owns the
   * `dispatchGesture` perf operation, callback result conversion, and guaranteed outer perf close.
   */
  private fun dispatchGestureWithResult(
    perfLabel: String,
    gesture: GestureDescription,
    requestId: String?,
    startTimeMs: Long,
    gestureBuiltTimeMs: Long,
    frameContext: String? = null,
    beforeCompletedResult: () -> Unit = {},
    onResult: (GestureDispatchOutcome) -> Unit,
  ) {
    rememberedInsert = null
    val lifecycle =
      GestureDispatchLifecycle(
        startTimeMs = startTimeMs,
        gestureBuiltTimeMs = gestureBuiltTimeMs,
        nowMs = { System.currentTimeMillis() },
        startOperation = { perfProvider.startOperation(it) },
        endOperation = { perfProvider.endOperation(it) },
        endPerfBlock = { perfProvider.end() },
      )

    lifecycle.startDispatch()
    if (frameContext != null && frameContext != currentFrameContext()) {
      lifecycle.failed(
        IllegalStateException("Stale frame context; observe a fresh frame before retrying"),
        onResult,
      )
      return
    }
    val dispatched =
      try {
        dispatchGesture(
          gesture,
          object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
              lifecycle.completed(beforeResult = beforeCompletedResult, onResult = onResult)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
              lifecycle.cancelled(onResult)
            }
          },
          gestureHandler,
        )
      } catch (e: Exception) {
        Log.e(TAG, "Error dispatching $perfLabel gesture (requestId=$requestId)", e)
        lifecycle.failed(e, onResult)
        return
      }

    if (!dispatched) {
      Log.e(TAG, "Failed to dispatch $perfLabel gesture (requestId=$requestId)")
      lifecycle.notDispatched(onResult)
    }
  }

  /** Preserve legacy routing when absent; explicit displays share the validated API gate. */
  private fun gestureBuilder(displayId: Int?): GestureDescription.Builder =
    GestureDescription.Builder().apply {
      GestureDisplayRouting.apply(displayId, Build.VERSION.SDK_INT) { id ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setDisplayId(id)
      }
    }

  /**
   * Perform a swipe gesture using AccessibilityService's dispatchGesture API. This is significantly
   * faster than ADB's input swipe command.
   */
  private fun performSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    frameContext: String? = null,
    displayId: Int? = null,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performSwipe: ($x1, $y1) -> ($x2, $y2) duration=${duration}ms")
    perfProvider.serial("performSwipe")

    try {
      // Create the swipe path
      perfProvider.startOperation("buildPath")
      val path =
        Path().apply {
          moveTo(x1.toFloat(), y1.toFloat())
          lineTo(x2.toFloat(), y2.toFloat())
        }

      // Build the gesture description
      val gesture =
        gestureBuilder(displayId)
          .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
          .build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = System.currentTimeMillis()
      Log.d(TAG, "Gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        "performSwipe",
        gesture,
        requestId,
        startTime,
        gestureBuiltTime,
        frameContext,
      ) { outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Swipe completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          launchRequestScope(requestId) {
            broadcastSwipeResult(
              requestId,
              true,
              null,
              outcome.totalTimeMs,
              outcome.gestureTimeMs,
            )
          }
        } else {
          Log.w(TAG, "Swipe failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          launchRequestScope(requestId) {
            broadcastSwipeResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
          }
        }
      }
    } catch (e: Exception) {
      perfProvider.end() // end performSwipe block
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing swipe", e)
      launchRequestScope(requestId) {
        broadcastSwipeResult(requestId, false, e.message, errorTime - startTime, null)
      }
    }
  }

  /**
   * Perform a drag gesture using AccessibilityService's dispatchGesture API.
   *
   * @param requestId Optional request ID for response correlation
   * @param x1 Starting X coordinate
   * @param y1 Starting Y coordinate
   * @param x2 Ending X coordinate
   * @param y2 Ending Y coordinate
   * @param pressDurationMs Press duration before dragging in milliseconds
   * @param dragDurationMs Drag duration in milliseconds
   * @param holdDurationMs Hold duration after dragging in milliseconds
   */
  private fun performDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
    frameContext: String? = null,
    displayId: Int? = null,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(
      TAG,
      "performDrag: ($x1, $y1) -> ($x2, $y2) press=${pressDurationMs}ms drag=${dragDurationMs}ms hold=${holdDurationMs}ms",
    )
    // Chained callbacks cross threads. Own these entries by request rather than leaving an IO
    // thread's perf stack open and trying to close it from the gesture thread.
    val dragPerf =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        MutablePerfEntry("performDrag", startTime, requestId).apply {
          children.add(MutablePerfEntry("buildPath", System.currentTimeMillis(), requestId))
        }
      } else null
    if (dragPerf == null) perfProvider.serial("performDrag")

    try {
      if (dragPerf == null) perfProvider.startOperation("buildPath")
      val gestureBuilder = gestureBuilder(displayId)
      val startX = x1.toFloat()
      val startY = y1.toFloat()
      val endX = x2.toFloat()
      val endY = y2.toFloat()

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        // Pre-API-26 GestureDescription has no stroke continuation (the willContinue
        // StrokeDescription constructor is API 26+), so press/drag/hold cannot be
        // chained as one continuous touch. Approximate with a single stroke covering
        // the combined duration. Previously this path threw NoSuchMethodError.
        val totalDurationMs = maxOf(1L, pressDurationMs + dragDurationMs + holdDurationMs)
        val dragPath =
          Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
          }
        gestureBuilder.addStroke(GestureDescription.StrokeDescription(dragPath, 0, totalDurationMs))
        Log.d(
          TAG,
          "Legacy (<API 26) single-stroke drag: ($startX, $startY) -> ($endX, $endY), duration=${totalDurationMs}ms",
        )
      } else {
        val plan =
          dragStrokePlan(
            GesturePoint(startX, startY),
            GesturePoint(endX, endY),
            pressDurationMs,
            dragDurationMs,
            holdDurationMs,
          )
        val ownedPerf = requireNotNull(dragPerf)
        val gestureBuiltTime = System.currentTimeMillis()
        ownedPerf.children.single().endTime = gestureBuiltTime
        val dispatchPerf = MutablePerfEntry("dispatchGesture", gestureBuiltTime, requestId)
        val lifecycle =
          GestureDispatchLifecycle(
            startTimeMs = startTime,
            gestureBuiltTimeMs = gestureBuiltTime,
            nowMs = { System.currentTimeMillis() },
            startOperation = { ownedPerf.children.add(dispatchPerf) },
            endOperation = { dispatchPerf.endTime = System.currentTimeMillis() },
            endPerfBlock = {
              ownedPerf.endTime = System.currentTimeMillis()
              perfProvider.complete(ownedPerf)
            },
          )
        rememberedInsert = null
        lifecycle.startDispatch()
        val onResult: (GestureDispatchOutcome) -> Unit = { dragResultReporter(requestId, it) }
        val posted = gestureThread.post {
          // Check once immediately before DOWN; this gesture's own events may advance the token.
          if (frameContext != null && frameContext != currentFrameContext()) {
            lifecycle.failed(
              IllegalStateException("Stale frame context; observe a fresh frame before retrying"),
              onResult,
            )
          } else {
            DragStrokeSession(
                plan = plan,
                dispatcher = AccessibilityStrokeDispatcher(),
                deadline = dragDeadline,
                displayId = displayId,
                logError = { Log.e(TAG, "Error dispatching drag stroke", it) },
                onFinished = { success, error ->
                  if (success) lifecycle.completed(onResult = onResult)
                  else lifecycle.failed(IllegalStateException(error ?: "Drag failed"), onResult)
                },
                nowMs = android.os.SystemClock::elapsedRealtime,
              )
              .start()
          }
        }
        if (!posted) lifecycle.notDispatched(onResult)
        return
      }
      val gesture = gestureBuilder.build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = System.currentTimeMillis()
      Log.d(TAG, "Drag gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        "performDrag",
        gesture,
        requestId,
        startTime,
        gestureBuiltTime,
        frameContext,
      ) { outcome ->
        dragResultReporter(requestId, outcome)
      }
    } catch (e: Exception) {
      val errorTime = System.currentTimeMillis()
      if (dragPerf == null) perfProvider.end()
      else {
        dragPerf.children.forEach { if (it.endTime == null) it.endTime = errorTime }
        dragPerf.endTime = errorTime
        perfProvider.complete(dragPerf)
      }
      Log.e(TAG, "Error performing drag", e)
      dragResultReporter(
        requestId,
        GestureDispatchOutcome(
          false,
          errorTime - startTime,
          null,
          e.message ?: "Failed to perform drag",
        ),
      )
    }
  }

  /**
   * Perform a tap at specific coordinates using AccessibilityService's dispatchGesture API. This is
   * significantly faster than ADB input tap and more precise than resource-id lookup.
   *
   * @param requestId Optional request ID for response correlation
   * @param x X coordinate to tap
   * @param y Y coordinate to tap
   * @param duration Duration of the tap in milliseconds (default 10ms for a quick tap)
   */
  private fun performTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    duration: Long = 10,
    frameContext: String? = null,
    displayId: Int? = null,
    doubleTap: Boolean = false,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performTapCoordinates: ($x, $y) duration=${duration}ms")
    perfProvider.serial("performTapCoordinates")

    try {
      // Create a tap path (single point, no movement)
      perfProvider.startOperation("buildPath")
      val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }

      // Build the gesture description
      val builder =
        gestureBuilder(displayId).addStroke(GestureDescription.StrokeDescription(path, 0, duration))
      if (doubleTap) {
        // Fixed 100ms release-to-press gap, independent of host reply latency.
        builder.addStroke(GestureDescription.StrokeDescription(path, duration + 100L, duration))
      }
      val gesture = builder.build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = System.currentTimeMillis()
      Log.d(TAG, "Tap gesture built in ${gestureBuiltTime - startTime}ms")

      var freshHierarchy: ViewHierarchy? = null
      dispatchGestureWithResult(
        "performTapCoordinates",
        gesture,
        requestId,
        startTime,
        gestureBuiltTime,
        frameContext,
        beforeCompletedResult = {
          // Wait for UI to settle after tap, then extract fresh hierarchy.
          freshHierarchy =
            hierarchyDebouncer.extractAfterQuiescence(
              quiescenceMs = HierarchyQuiescence.POLL_MS,
              maxWaitMs = HierarchyQuiescence.TIMEOUT_MS,
              pollIntervalMs = 10L,
              snapshotOptions = HierarchySnapshotOptions(displayId = displayId),
            )
        },
      ) { outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Tap completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          launchRequestScope(requestId) {
            freshHierarchy?.let { broadcastHierarchyUpdate(it, sync = true) }
            broadcastTapCoordinatesResult(requestId, true, null, outcome.totalTimeMs)
          }
        } else {
          Log.w(TAG, "Tap failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          launchRequestScope(requestId) {
            broadcastTapCoordinatesResult(requestId, false, outcome.error, outcome.totalTimeMs)
          }
        }
      }
    } catch (e: Exception) {
      perfProvider.end() // end performTapCoordinates block
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing tap", e)
      launchRequestScope(requestId) {
        broadcastTapCoordinatesResult(requestId, false, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Perform a two-finger swipe gesture for TalkBack mode scrolling. This allows scrolling content
   * without moving the TalkBack focus cursor.
   *
   * @param requestId Optional request ID for response correlation
   * @param x1 Starting X coordinate
   * @param y1 Starting Y coordinate
   * @param x2 Ending X coordinate
   * @param y2 Ending Y coordinate
   * @param duration Duration of the swipe in milliseconds
   * @param offset Horizontal offset between the two fingers (default 100px)
   */
  private fun performTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int = 100,
    displayId: Int? = null,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(
      TAG,
      "performTwoFingerSwipe: ($x1, $y1) -> ($x2, $y2) duration=${duration}ms, offset=${offset}px",
    )
    perfProvider.serial("performTwoFingerSwipe")

    try {
      // Create two parallel paths for the two fingers
      perfProvider.startOperation("buildPaths")
      val path1 =
        Path().apply {
          moveTo(x1.toFloat(), y1.toFloat())
          lineTo(x2.toFloat(), y2.toFloat())
        }

      val path2 =
        Path().apply {
          moveTo((x1 + offset).toFloat(), y1.toFloat())
          lineTo((x2 + offset).toFloat(), y2.toFloat())
        }

      // Build the gesture description with two strokes
      val gesture =
        gestureBuilder(displayId)
          .addStroke(GestureDescription.StrokeDescription(path1, 0, duration))
          .addStroke(GestureDescription.StrokeDescription(path2, 0, duration))
          .build()
      perfProvider.endOperation("buildPaths")

      val gestureBuiltTime = System.currentTimeMillis()
      Log.d(TAG, "Two-finger gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        "performTwoFingerSwipe",
        gesture,
        requestId,
        startTime,
        gestureBuiltTime,
      ) { outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Two-finger swipe completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          launchRequestScope(requestId) {
            broadcastSwipeResult(
              requestId,
              true,
              null,
              outcome.totalTimeMs,
              outcome.gestureTimeMs,
            )
          }
        } else {
          Log.w(TAG, "Two-finger swipe failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          launchRequestScope(requestId) {
            broadcastSwipeResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
          }
        }
      }
    } catch (e: Exception) {
      perfProvider.end() // end performTwoFingerSwipe block
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing two-finger swipe", e)
      launchRequestScope(requestId) {
        broadcastSwipeResult(requestId, false, e.message, errorTime - startTime, null)
      }
    }
  }

  /** Perform a pinch gesture using AccessibilityService's dispatchGesture API. */
  private fun performPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
    displayId: Int? = null,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(
      TAG,
      "performPinch: center=($centerX,$centerY) start=$distanceStart end=$distanceEnd rotation=$rotationDegrees duration=${duration}ms",
    )
    perfProvider.serial("performPinch")

    try {
      perfProvider.startOperation("buildPath")
      // Geometry is extracted into computePinchPoints so it stays unit testable (see
      // PinchGeometryTest) and stays in sync with the iOS runner. rotationDegrees rotates the
      // finger axis *during* the pinch (start horizontal, end rotated); see issue #2911.
      val points = computePinchPoints(centerX, centerY, distanceStart, distanceEnd, rotationDegrees)

      val path1 =
        Path().apply {
          moveTo(points.startX1, points.startY1)
          lineTo(points.endX1, points.endY1)
        }
      val path2 =
        Path().apply {
          moveTo(points.startX2, points.startY2)
          lineTo(points.endX2, points.endY2)
        }

      val gesture =
        gestureBuilder(displayId)
          .addStroke(GestureDescription.StrokeDescription(path1, 0, duration))
          .addStroke(GestureDescription.StrokeDescription(path2, 0, duration))
          .build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = System.currentTimeMillis()
      Log.d(TAG, "Pinch gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult("performPinch", gesture, requestId, startTime, gestureBuiltTime) {
        outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Pinch completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          launchRequestScope(requestId) {
            broadcastPinchResult(
              requestId,
              true,
              null,
              outcome.totalTimeMs,
              outcome.gestureTimeMs,
            )
          }
        } else {
          Log.w(TAG, "Pinch failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          launchRequestScope(requestId) {
            broadcastPinchResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
          }
        }
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing pinch", e)
      launchRequestScope(requestId) {
        broadcastPinchResult(requestId, false, e.message, errorTime - startTime, null)
      }
    }
  }

  /**
   * Perform text input using AccessibilityService's ACTION_SET_TEXT. This is significantly faster
   * than ADB's input text command.
   */
  private suspend fun performSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean = false,
  ) {
    rememberedInsert = null
    val startTime = System.currentTimeMillis()
    // Never log the text: the target may be a password field.
    Log.d(TAG, "performSetText: ${text.length} chars resourceId=$resourceId")
    perfProvider.serial("performSetText")

    try {
      perfProvider.startOperation("findNode")
      val root = rootInActiveWindow
      var foundTargetNode: android.view.accessibility.AccessibilityNodeInfo? = null
      try {
        foundTargetNode =
          if (resourceId != null) {
            // Find node by resource-id
            findNodeByResourceIdOnRootDisplay(root, resourceId, ::getScreenDimensions)
          } else {
            // Find currently focused input node
            findFocusedEditableNode(root)
          }
      } finally {
        if (root !== foundTargetNode) {
          root?.recycle()
        }
      }
      val targetNode = foundTargetNode
      perfProvider.endOperation("findNode")

      if (targetNode == null) {
        perfProvider.end()
        val errorTime = System.currentTimeMillis()
        val error =
          if (resourceId != null) {
            "No node found with resource-id: $resourceId"
          } else {
            "No focused editable node found"
          }
        Log.w(TAG, error)
        launchRequestScope(requestId) {
          broadcastSetTextResult(requestId, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("setText")
      val arguments =
        android.os.Bundle().apply {
          putCharSequence(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            text,
          )
        }
      val success =
        try {
          targetNode.performAction(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
            arguments,
          )
        } finally {
          targetNode.recycle()
        }
      perfProvider.endOperation("setText")
      perfProvider.end()

      Log.d(TAG, "Set text completed: success=$success")

      // Dismiss the soft keyboard if requested.
      // When enabled (via --dismiss-keyboard-after-input or per-call dismissKeyboard param),
      // SHOW_MODE_HIDDEN suppresses the keyboard globally for the accessibility service.
      // This prevents the keyboard from stealing touch events and accessibility focus
      // from UI elements behind it during subsequent tapOn steps.
      if (success && dismissKeyboard) {
        try {
          softKeyboardController.setShowMode(
            android.accessibilityservice.AccessibilityService.SHOW_MODE_HIDDEN,
          )
          Log.d(TAG, "[KeyboardDismiss] Set SHOW_MODE_HIDDEN after text injection")
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          Log.w(TAG, "[KeyboardDismiss] softKeyboardController failed", e)
        }
      }

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "Set text completed in ${totalTime}ms")
      // ACTION_SET_TEXT and the requested keyboard state are complete, so acknowledge before
      // optional hierarchy work. Waiting for quiescence/extraction first can turn a completed
      // write into a host-side timeout.
      broadcastSetTextResult(
        requestId,
        success,
        if (success) null else "performAction returned false",
        totalTime,
      )

      if (success) refreshHierarchyAfterTextInput()
    } catch (e: CancellationException) {
      perfProvider.end()
      throw e
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing set text", e)
      broadcastSetTextResult(requestId, false, e.message, errorTime - startTime)
    }
  }

  /**
   * Publishes the settled text state after a successful text mutation without delaying its result.
   */
  private fun refreshHierarchyAfterTextInput() {
    serviceScope.launch {
      try {
        val freshHierarchy =
          hierarchyDebouncer.extractAfterQuiescenceSuspending(
            quiescenceMs = HierarchyQuiescence.POLL_MS,
            maxWaitMs = HierarchyQuiescence.TIMEOUT_MS,
            pollIntervalMs = 10L,
          )
        if (freshHierarchy != null) {
          broadcastHierarchyUpdate(freshHierarchy, sync = true)
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "Failed to refresh hierarchy after text input", e)
      }
    }
  }

  private data class InsertNodeKey(
    val windowId: Int,
    val packageName: String?,
    val className: String?,
    val viewId: String?,
  )

  private data class RememberedCaretAt(val caret: RememberedCaret, val atMs: Long)

  // Compose may expose no stable view ID. Exact text AND reported selection, command/event
  // invalidation, and a 5s TTL bound reuse to a continuation of the previous insert.
  @Volatile private var rememberedInsert: Pair<InsertNodeKey, RememberedCaretAt>? = null

  /**
   * Insert text at the focused field's current selection using accessibility actions.
   *
   * Android exposes replacement through ACTION_SET_TEXT but no separate insert primitive. Build the
   * new value from the node's UTF-16 selection range, then restore the caret immediately after the
   * inserted text. This matches ordinary typing: a collapsed selection inserts at the caret, while
   * a non-empty selection is replaced. If the selection is invalid, refresh the node once and
   * append at the end of its current text if the refreshed selection is still invalid.
   */
  private fun performInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
    precedingState: InsertTextSnapshot? = null,
  ) {
    val startTime = System.currentTimeMillis()
    perfProvider.serial("performInsertText")

    var nodeToRecycle: android.view.accessibility.AccessibilityNodeInfo? = null
    val warnings = mutableListOf<String>()
    var textMutated = false
    try {
      val originalNode = findFocusedEditableNode(rootInActiveWindow)
      if (originalNode == null) {
        rememberedInsert = null
        perfProvider.end()
        launchRequestScope(requestId) {
          broadcastInsertTextResult(
            requestId,
            false,
            "No focused editable node found",
            System.currentTimeMillis() - startTime,
          )
        }
        return
      }

      var targetNode: android.view.accessibility.AccessibilityNodeInfo = originalNode
      nodeToRecycle = targetNode
      if (targetNode.isPassword) {
        rememberedInsert = null
        targetNode.recycle()
        nodeToRecycle = null
        perfProvider.end()
        kotlinx.coroutines.runBlocking {
          broadcastInsertTextResult(
            requestId,
            false,
            "Cannot insert text into a password field without exposing its original value",
            System.currentTimeMillis() - startTime,
          )
        }
        return
      }

      fun nodeKey() =
        InsertNodeKey(
          targetNode.windowId,
          targetNode.packageName?.toString(),
          targetNode.className?.toString(),
          targetNode.viewIdResourceName,
        )

      fun readFreshSnapshot(): InsertTextSnapshot? {
        if (nodeToRecycle == null) return null
        if (!targetNode.refresh()) {
          val replacementNode = findFocusedEditableNode(rootInActiveWindow)
          targetNode.recycle()
          nodeToRecycle = replacementNode
          if (replacementNode == null) {
            rememberedInsert = null
            return null
          }
          targetNode = replacementNode
        }
        // Re-found nodes may be password/non-editable fields. Never read their text or mutate them.
        if (!targetNode.isEditable || !targetNode.isFocused || targetNode.isPassword) {
          rememberedInsert = null
          return null
        }
        if (rememberedInsert?.first != nodeKey()) rememberedInsert = null
        return InsertTextSnapshot(
          targetNode.text?.toString(),
          targetNode.isShowingHintTextCompat(),
          targetNode.textSelectionStart,
          targetNode.textSelectionEnd,
        )
      }

      // Every insert, including a caret-warning remainder, plans against a refreshed node.
      var snapshot = readFreshSnapshot()
      val waitStarted = android.os.SystemClock.uptimeMillis()
      val remembered = rememberedInsert?.takeIf {
        it.first == nodeKey() &&
          android.os.SystemClock.uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS
      }
      if (remembered == null) rememberedInsert = null
      val rememberedTextMatched = remembered?.let {
        snapshot?.let { s -> !s.isShowingHintText && s.text.orEmpty() == it.second.caret.text }
      }
      if (remembered != null && snapshot != null && rememberedTextMatched == false) {
        val matched =
          awaitPrecedingInput(
            expectedSuffix = "",
            readSnapshot = { readFreshSnapshot().also { snapshot = it } },
            nowMs = { android.os.SystemClock.uptimeMillis() },
            pause = { ms -> kotlinx.coroutines.runBlocking { kotlinx.coroutines.delay(ms) } },
            matches = { s ->
              nodeKey() == remembered.first &&
                !s.isShowingHintText &&
                s.text.orEmpty() == remembered.second.caret.text
            },
          )
        if (!matched) {
          rememberedInsert = null
          warnings.add(
            "The field changed since the previous insert; its text did not match within 300ms, so the reported selection was used",
          )
        }
      }
      if (snapshot != null && shouldWaitForPrecedingInput(expectedSuffix)) {
        val observed =
          awaitPrecedingInput(
            expectedSuffix = requireNotNull(expectedSuffix),
            baseline = precedingState,
            readSnapshot = { readFreshSnapshot().also { snapshot = it } },
            nowMs = { android.os.SystemClock.uptimeMillis() },
            pause = { ms -> kotlinx.coroutines.runBlocking { kotlinx.coroutines.delay(ms) } },
          )
        if (!observed) {
          warnings.add(
            "Preceding key-event input was not observed in the field within 300ms; the inserted text was planned against the latest observed value, so earlier input may have been overwritten",
          )
        }
      }
      AutoMobileLog.d(
        TAG,
        "insertText rememberedTextMatchedInitially=${rememberedTextMatched == true} rememberedTextMatchedAfterWait=${remembered != null && snapshot?.text == remembered.second.caret.text && snapshot?.isShowingHintText == false} waitMs=${android.os.SystemClock.uptimeMillis() - waitStarted}",
      )
      val liveSnapshot = snapshot
      if (liveSnapshot == null) {
        val error =
          when {
            nodeToRecycle == null -> "No focused editable node found"
            targetNode.isPassword ->
              "Cannot insert text into a password field without exposing its original value"
            !targetNode.isEditable -> "Focused node is not editable"
            else -> "No focused editable node found"
          }
        nodeToRecycle?.recycle()
        nodeToRecycle = null
        rememberedInsert = null
        perfProvider.end()
        kotlinx.coroutines.runBlocking {
          broadcastInsertTextResult(
            requestId,
            false,
            error,
            System.currentTimeMillis() - startTime,
            warning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" "),
          )
        }
        return
      }
      // Reuse only when no command/event invalidated the same entry during polling.
      val caret =
        rememberedInsert
          ?.takeIf {
            it == remembered &&
              android.os.SystemClock.uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS
          }
          ?.second
          ?.caret
      val plan =
        planInsertText(
          liveSnapshot.text,
          liveSnapshot.isShowingHintText,
          liveSnapshot.selectionStart,
          liveSnapshot.selectionEnd,
          text,
          caret,
        )
      if (!plan.usedRememberedCaret) rememberedInsert = null
      val precedingWarning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" ")
      AutoMobileLog.d(
        TAG,
        "insertText selectionBeforeStart=${liveSnapshot.selectionStart} selectionBeforeEnd=${liveSnapshot.selectionEnd} textLength=${liveSnapshot.text.orEmpty().length}",
      )

      val actionIds = targetNode.actionList.map { it.id }.toSet()
      AutoMobileLog.d(
        TAG,
        "insertText selectionActionListed=${android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION in actionIds}",
      )
      val requiredActions =
        if (plan.usedFallbackCaret || plan.usedRememberedCaret) {
          mapOf(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT to "ACTION_SET_TEXT",
          )
        } else {
          mapOf(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT to "ACTION_SET_TEXT",
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION to
              "ACTION_SET_SELECTION",
          )
        }
      val unsupportedAction = requiredActions.entries.firstOrNull { it.key !in actionIds }
      if (unsupportedAction != null) {
        targetNode.recycle()
        nodeToRecycle = null
        perfProvider.end()
        kotlinx.coroutines.runBlocking {
          broadcastInsertTextResult(
            requestId,
            false,
            "Focused editable node does not support ${unsupportedAction.value}",
            System.currentTimeMillis() - startTime,
            warning = precedingWarning,
          )
        }
        return
      }

      val setTextArguments =
        android.os.Bundle().apply {
          putCharSequence(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            plan.updatedText,
          )
        }
      val setTextSucceeded =
        targetNode.performAction(
          android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
          setTextArguments,
        )
      textMutated = setTextSucceeded
      // Compose may acknowledge SET_TEXT before its semantics reflect the replacement. Wait
      // briefly on the same node before reading selection support and placing the caret (#10414).
      val mutationNodeKey = nodeKey()
      fun readMutationSnapshot(): InsertTextSnapshot? {
        // After writing, never re-find and move a caret in a different focused field.
        if (
          !targetNode.refresh() ||
            nodeKey() != mutationNodeKey ||
            !targetNode.isEditable ||
            !targetNode.isFocused ||
            targetNode.isPassword
        )
          return null
        return InsertTextSnapshot(
          targetNode.text?.toString(),
          targetNode.isShowingHintTextCompat(),
          targetNode.textSelectionStart,
          targetNode.textSelectionEnd,
        )
      }
      val afterSetText =
        if (setTextSucceeded) {
          awaitInsertTextMutation(
            plan,
            readSnapshot = ::readMutationSnapshot,
            nowMs = { android.os.SystemClock.uptimeMillis() },
            pause = { ms -> kotlinx.coroutines.runBlocking { kotlinx.coroutines.delay(ms) } },
          )
        } else null
      AutoMobileLog.d(
        TAG,
        "insertText selectionAfterSetTextStart=${afterSetText?.selectionStart ?: -1} selectionAfterSetTextEnd=${afterSetText?.selectionEnd ?: -1}",
      )
      val selectionAttempted =
        setTextSucceeded &&
          afterSetText != null &&
          android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION in
            targetNode.actionList.map { it.id }
      val selectionReturned =
        if (selectionAttempted) {
          val selectionArguments =
            android.os.Bundle().apply {
              putInt(
                android.view.accessibility.AccessibilityNodeInfo
                  .ACTION_ARGUMENT_SELECTION_START_INT,
                plan.caret,
              )
              putInt(
                android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,
                plan.caret,
              )
            }
          targetNode.performAction(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION,
            selectionArguments,
          )
        } else false
      // A widget may reject SET_SELECTION when SET_TEXT already placed the caret correctly.
      val observedSelection =
        if (selectionAttempted && !selectionReturned) readMutationSnapshot() else afterSetText
      val selectionSucceeded =
        insertTextSelectionSucceeded(
          setTextSucceeded,
          selectionAttempted,
          selectionReturned,
          plan,
          observedSelection,
        )
      AutoMobileLog.d(
        TAG,
        "insertText selectionAttempted=$selectionAttempted selectionReturned=$selectionReturned",
      )
      // Record the reported selection after placement, including the rejected-action refresh.
      val afterSelection =
        if (afterSetText != null)
          InsertTextSnapshot(
            targetNode.text?.toString(),
            targetNode.isShowingHintTextCompat(),
            targetNode.textSelectionStart,
            targetNode.textSelectionEnd,
          )
        else null
      val outcome =
        insertTextOutcome(
          setTextSucceeded,
          selectionAttempted,
          selectionSucceeded,
          precedingWarning,
          acceptsCaretNotPlaced,
        )
      rememberedInsert = afterSelection?.let { s ->
        nextRememberedCaret(outcome, plan, s.selectionStart, s.selectionEnd)?.let {
          nodeKey() to RememberedCaretAt(it, android.os.SystemClock.uptimeMillis())
        }
      }
      nodeToRecycle?.recycle()
      nodeToRecycle = null
      perfProvider.end()

      kotlinx.coroutines.runBlocking {
        broadcastInsertTextResult(
          requestId,
          outcome.success,
          outcome.error,
          System.currentTimeMillis() - startTime,
          outcome.partialApplication,
          outcome.warning,
          outcome.caretPlaced,
          if (setTextSucceeded && acceptsCaretNotPlaced) plan.updatedText.length else null,
        )
      }
      if (setTextSucceeded) refreshHierarchyAfterTextInput()
    } catch (e: Exception) {
      rememberedInsert = null
      nodeToRecycle?.recycle()
      perfProvider.end()
      Log.e(TAG, "Error inserting text", e)
      kotlinx.coroutines.runBlocking {
        broadcastInsertTextResult(
          requestId,
          false,
          e.message,
          System.currentTimeMillis() - startTime,
          partialApplication = textMutated,
          warning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" "),
        )
      }
    }
  }

  internal enum class ImeActionStep(val error: String? = null, val approximated: Boolean? = null) {
    NO_FOCUSED_EDITABLE("No focused editable node found for IME action"),
    NEXT(approximated = true),
    PREVIOUS(approximated = true),
    EDITOR_NEXT,
    EDITOR_PREVIOUS,
    IME_ENTER,
    KEYCODE_ENTER,
    UNSUPPORTED;

    companion object {
      fun select(
        action: String,
        hasFocusedEditable: Boolean,
        sdkInt: Int,
        hasImeConnection: Boolean = false,
      ): ImeActionStep {
        if (hasImeConnection) {
          if (action == "next") return EDITOR_NEXT
          if (action == "previous") return EDITOR_PREVIOUS
        }
        if (!hasFocusedEditable) {
          return NO_FOCUSED_EDITABLE
        }
        return when (action) {
          "next" -> NEXT
          "previous" -> PREVIOUS
          "done",
          "go",
          "send",
          "search" -> if (sdkInt >= android.os.Build.VERSION_CODES.R) IME_ENTER else KEYCODE_ENTER
          else -> UNSUPPORTED
        }
      }
    }
  }

  /**
   * Dispatch navigation through the active IME when possible, otherwise approximate it with focus
   * traversal. Other keyboard actions retain their AccessibilityService handling.
   */
  private fun performImeAction(requestId: String?, action: String) {
    rememberedInsert = null
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performImeAction: action='$action'")
    perfProvider.serial("performImeAction")

    var root: android.view.accessibility.AccessibilityNodeInfo? = null
    var focusedNode: android.view.accessibility.AccessibilityNodeInfo? = null
    var approximated: Boolean? = null
    try {
      perfProvider.startOperation("findFocusedNode")
      root = rootInActiveWindow
      focusedNode = findFocusedEditableNode(root)
      perfProvider.endOperation("findFocusedNode")

      val navigationActionId =
        when (action) {
          "next" -> android.view.inputmethod.EditorInfo.IME_ACTION_NEXT
          "previous" -> android.view.inputmethod.EditorInfo.IME_ACTION_PREVIOUS
          else -> null
        }
      val editorActionResult =
        if (navigationActionId != null) {
          kotlinx.coroutines.runBlocking {
            CtrlProxyIme.current()?.performNavigationAction(navigationActionId)
          }
        } else null
      // Accessibility nodes expose no configured imeOptions. ACTION_IME_ENTER alone does not
      // prove the editor is configured for NEXT, so an unavailable IME uses traversal.
      val step =
        ImeActionStep.select(
          action,
          focusedNode != null,
          android.os.Build.VERSION.SDK_INT,
          hasImeConnection = editorActionResult != null,
        )
      approximated = step.approximated
      val error = step.error
      if (error != null) {
        perfProvider.end()
        val errorTime = System.currentTimeMillis()
        Log.w(TAG, error)
        launchRequestScope(requestId) {
          broadcastImeActionResult(requestId, action, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("executeAction")
      val success =
        when (step) {
          ImeActionStep.EDITOR_NEXT,
          ImeActionStep.EDITOR_PREVIOUS -> editorActionResult == true
          ImeActionStep.NEXT -> {
            // Find next focusable element and focus it
            val nextNode = findNextFocusableNode(root, focusedNode!!)
            if (nextNode != null) {
              val focusSuccess =
                nextNode.performAction(
                  android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS,
                )
              nextNode.recycle()
              focusSuccess
            } else {
              Log.w(TAG, "No next focusable node found")
              false
            }
          }
          ImeActionStep.PREVIOUS -> {
            // Find previous focusable element and focus it
            val prevNode = findPreviousFocusableNode(root, focusedNode!!)
            if (prevNode != null) {
              val focusSuccess =
                prevNode.performAction(
                  android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS,
                )
              prevNode.recycle()
              focusSuccess
            } else {
              Log.w(TAG, "No previous focusable node found")
              false
            }
          }
          ImeActionStep.IME_ENTER -> {
            // API 30+: Use ACTION_IME_ENTER for proper IME action handling
            @Suppress("NewApi")
            val actionId =
              android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER
                .id
            val imeResult = focusedNode!!.performAction(actionId)
            Log.d(TAG, "ACTION_IME_ENTER result: $imeResult")
            imeResult
          }
          ImeActionStep.KEYCODE_ENTER -> {
            // Pre-API 30: Fall back to pressing Enter key via input shell command
            // This is less reliable but works on older devices
            Log.d(TAG, "Pre-API 30: falling back to KEYCODE_ENTER")
            try {
              Runtime.getRuntime().exec(arrayOf("input", "keyevent", "66")).waitFor() == 0
            } catch (e: Exception) {
              Log.e(TAG, "Failed to send KEYCODE_ENTER", e)
              false
            }
          }
          else -> {
            Log.w(TAG, "Unknown IME action: $action")
            false
          }
        }
      perfProvider.endOperation("executeAction")

      perfProvider.end()

      Log.d(TAG, "IME action completed: success=$success")

      // Wait for UI to settle, then extract fresh hierarchy
      if (success) {
        val freshHierarchy =
          hierarchyDebouncer.extractAfterQuiescence(
            quiescenceMs = HierarchyQuiescence.POLL_MS,
            maxWaitMs = HierarchyQuiescence.TIMEOUT_MS,
            pollIntervalMs = 10L,
          )
        if (freshHierarchy != null) {
          kotlinx.coroutines.runBlocking { broadcastHierarchyUpdate(freshHierarchy, sync = true) }
        }
      }

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "IME action total time: ${totalTime}ms")

      kotlinx.coroutines.runBlocking {
        broadcastImeActionResult(
          requestId,
          action,
          success,
          if (success) null else "Action failed",
          totalTime,
          approximated,
        )
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing IME action", e)
      kotlinx.coroutines.runBlocking {
        broadcastImeActionResult(
          requestId,
          action,
          false,
          e.message,
          errorTime - startTime,
          approximated,
        )
      }
    } finally {
      if (focusedNode !== root) {
        focusedNode?.recycle()
      }
      root?.recycle()
    }
  }

  /**
   * Perform select all text using AccessibilityService's ACTION_SET_SELECTION. This is
   * significantly faster than using ADB double-tap gestures.
   */
  private fun performSelectAll(requestId: String?) {
    rememberedInsert = null
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performSelectAll")
    perfProvider.serial("performSelectAll")

    try {
      perfProvider.startOperation("findFocusedNode")
      val focusedNode = findFocusedEditableNode(rootInActiveWindow)
      perfProvider.endOperation("findFocusedNode")

      if (focusedNode == null) {
        perfProvider.end()
        val errorTime = System.currentTimeMillis()
        val error = "No focused editable node found"
        Log.w(TAG, error)
        kotlinx.coroutines.runBlocking {
          broadcastSelectAllResult(requestId, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("setSelection")
      // Get the text length to set selection from 0 to end
      val text = focusedNode.text
      val plan =
        planSelectAll(
          text?.length ?: 0,
          focusedNode.isShowingHintTextCompat(),
          focusedNode.textSelectionStart,
          focusedNode.textSelectionEnd,
        )
      val textLength = plan.textLength

      val outcome =
        if (plan.shouldPerformAction) {
          // Use ACTION_SET_SELECTION with start=0 and end=textLength to select all
          val arguments =
            android.os.Bundle().apply {
              putInt(
                android.view.accessibility.AccessibilityNodeInfo
                  .ACTION_ARGUMENT_SELECTION_START_INT,
                0,
              )
              putInt(
                android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,
                textLength,
              )
            }
          val actionSucceeded =
            focusedNode.performAction(
              android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION,
              arguments,
            )
          val selectionRefreshed = !actionSucceeded && focusedNode.refresh()
          selectAllOutcome(
            textLength,
            actionSucceeded,
            selectionRefreshed,
            if (selectionRefreshed) focusedNode.textSelectionStart else -1,
            if (selectionRefreshed) focusedNode.textSelectionEnd else -1,
          )
        } else {
          // No text to select, or all text is already selected
          if (textLength == 0) Log.d(TAG, "No text in focused node to select")
          SelectAllOutcome(true, null)
        }
      val success = outcome.success

      focusedNode.recycle()
      perfProvider.endOperation("setSelection")
      perfProvider.end()

      Log.d(TAG, "Select all completed: success=$success, textLength=$textLength")

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "Select all total time: ${totalTime}ms")

      kotlinx.coroutines.runBlocking {
        broadcastSelectAllResult(
          requestId,
          success,
          outcome.error,
          totalTime,
        )
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing select all", e)
      kotlinx.coroutines.runBlocking {
        broadcastSelectAllResult(requestId, false, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Perform an accessibility action on a node selected from observed stable fields. Resource ID is
   * preserved as the legacy selector; newer clients can additionally use test tags, Android unique
   * IDs, and collection coordinates.
   */
  private fun performAccessibilityLinkActivation(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  ) {
    val startTime = System.currentTimeMillis()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      launchRequestScope(requestId) {
        broadcastActionResult(
          requestId,
          "activate_accessibility_link",
          false,
          "Semantic accessibility links require Android API 26 or later",
          System.currentTimeMillis() - startTime,
        )
      }
      return
    }
    if (text.isBlank() || occurrence < 0) {
      launchRequestScope(requestId) {
        broadcastActionResult(
          requestId,
          "activate_accessibility_link",
          false,
          "Link text must be non-blank and occurrence must be non-negative",
          System.currentTimeMillis() - startTime,
        )
      }
      return
    }

    try {
      val root = rootInActiveWindow
      val owner = selector?.let { sel -> findNodeInDisplayWindows { findNodeBySelector(it, sel) } }
      if (selector != null && owner == null) {
        throw IllegalStateException("Selected link owner is no longer present")
      }
      var matched = 0
      var activated = false
      var activationError: String? = null
      fun visit(node: AccessibilityNodeInfo?) {
        if (node == null || activated) return
        val nodeText = node.text as? Spanned
        if (nodeText != null) {
          nodeText
            .getSpans(0, nodeText.length, ClickableSpan::class.java)
            .sortedBy { nodeText.getSpanStart(it) }
            .forEach { span ->
              if (activated) return@forEach
              val start = nodeText.getSpanStart(span)
              val end = nodeText.getSpanEnd(span)
              val spanText = nodeText.subSequence(start, end).toString()
              if (spanText.equals(text, ignoreCase = true)) {
                if (matched++ == occurrence) {
                  try {
                    // Accessibility exposes ClickableSpan only from API 26. Invoke its public
                    // contract; no coordinate, reflection, or whole-node fallback is permitted.
                    span.onClick(View(this))
                    activated = true
                  } catch (error: Exception) {
                    activationError = error.message ?: error.javaClass.simpleName
                  }
                }
              }
            }
        }
        for (index in 0 until node.childCount) {
          node.getChild(index)?.let { child ->
            try {
              visit(child)
            } finally {
              child.recycle()
            }
          }
        }
      }
      visit(owner ?: root)
      owner?.recycle()

      val error =
        when {
          activated -> null
          activationError != null -> "Semantic link activation failed: $activationError"
          else -> "No actionable semantic link matching '$text' at occurrence $occurrence"
        }
      launchRequestScope(requestId) {
        broadcastActionResult(
          requestId,
          "activate_accessibility_link",
          activated,
          error,
          System.currentTimeMillis() - startTime,
        )
      }
    } catch (error: Exception) {
      Log.w(TAG, "Semantic accessibility link activation failed", error)
      launchRequestScope(requestId) {
        broadcastActionResult(
          requestId,
          "activate_accessibility_link",
          false,
          error.message ?: error.javaClass.simpleName,
          System.currentTimeMillis() - startTime,
        )
      }
    }
  }

  /** Settle and publish a fresh hierarchy before acknowledging a successful node action. */
  private fun refreshHierarchyAfterNodeAction() {
    val freshHierarchy =
      hierarchyDebouncer.extractAfterQuiescence(
        quiescenceMs = HierarchyQuiescence.POLL_MS,
        maxWaitMs = HierarchyQuiescence.TIMEOUT_MS,
        pollIntervalMs = 10L,
      )
    if (freshHierarchy != null) {
      kotlinx.coroutines.runBlocking { broadcastHierarchyUpdate(freshHierarchy, sync = true) }
    }
  }

  private fun performNodeAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
  ) {
    rememberedInsert = null
    val startTime = System.currentTimeMillis()
    val effectiveSelector = selector?.takeIf { it.hasCriteria() }
    val targetDescription = effectiveSelector?.toString() ?: "resource-id: $resourceId"
    Log.d(TAG, "performAction: action='$action', target='$targetDescription'")
    perfProvider.serial("performAction")

    try {
      if (effectiveSelector == null && resourceId.isNullOrEmpty()) {
        perfProvider.end()
        val errorTime = System.currentTimeMillis()
        val error = "A resource-id or stable node selector is required for accessibility actions"
        Log.w(TAG, error)
        launchRequestScope(requestId) {
          broadcastActionResult(requestId, action, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("findNode")
      val targetNode = findNodeInDisplayWindows { root ->
        if (effectiveSelector != null) {
          findNodeBySelector(root, effectiveSelector)
        } else if (resourceId != null) {
          findNodeByResourceIdOnRootDisplay(root, resourceId, ::getScreenDimensions)
        } else {
          null
        }
      }
      perfProvider.endOperation("findNode")

      if (targetNode == null) {
        perfProvider.end()
        val errorTime = System.currentTimeMillis()
        val error = "Element not found with $targetDescription"
        Log.w(TAG, error)
        launchRequestScope(requestId) {
          broadcastActionResult(requestId, action, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("executeAction")
      val decision =
        decideNodeAction(
          action,
          targetNode.isAccessibilityFocused,
          targetNode.actionList?.map { it.id },
        )
      val alreadySatisfied = decision is NodeActionDecision.AlreadySatisfied
      val actionError = (decision as? NodeActionDecision.Refused)?.message
      val success =
        alreadySatisfied ||
          (decision is NodeActionDecision.Perform && targetNode.performAction(decision.actionId))
      perfProvider.endOperation("executeAction")

      targetNode.recycle()
      perfProvider.end()

      Log.d(TAG, "Action completed: success=$success")

      // Wait for UI to settle after click/long_click/scroll, then extract fresh hierarchy
      if (success && action in listOf("click", "long_click", "scroll_forward", "scroll_backward")) {
        refreshHierarchyAfterNodeAction()
      }

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "Action total time: ${totalTime}ms")

      kotlinx.coroutines.runBlocking {
        broadcastActionResult(
          requestId,
          action,
          success,
          if (success) null else actionError ?: "performAction returned false",
          totalTime,
          alreadySatisfied,
        )
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing action", e)
      kotlinx.coroutines.runBlocking {
        broadcastActionResult(requestId, action, false, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Perform clipboard operations using ClipboardManager and AccessibilityService. Supports copy,
   * paste, clear, and get operations.
   */
  private fun performClipboard(requestId: String?, action: String, text: String?) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performClipboard: action='$action'")
    perfProvider.serial("performClipboard")

    try {
      perfProvider.startOperation("executeClipboardAction")

      val (success, resultText, error) =
        when (action) {
          "copy" -> {
            if (text == null || text.isEmpty()) {
              Triple(false, null, "Text is required for copy action")
            } else {
              try {
                val clip = ClipData.newPlainText("AutoMobile", text)
                clipboardManager.setPrimaryClip(clip)
                Log.d(TAG, "Clipboard copy successful (${text.length} chars)")
                Triple(true, null, null)
              } catch (e: Exception) {
                Log.e(TAG, "Clipboard copy failed", e)
                Triple(false, null, "Copy failed: ${e.message}")
              }
            }
          }
          "get" -> {
            try {
              val readResult =
                CtrlProxyClipboard.readResultFromPrimaryClip(clipboardManager.primaryClip)
              if (readResult.success) {
                val clipText = readResult.text ?: ""
                if (clipText.isEmpty()) {
                  Log.d(TAG, "Clipboard is empty")
                } else {
                  Log.d(TAG, "Clipboard get successful (${clipText.length} chars)")
                }
                Triple(true, clipText, null)
              } else {
                val readError = readResult.error ?: "Clipboard read failed"
                Log.w(TAG, readError)
                Triple(false, null, readError)
              }
            } catch (e: Exception) {
              Log.e(TAG, "Clipboard get failed", e)
              Triple(false, null, "Get failed: ${e.message}")
            }
          }
          "clear" -> {
            try {
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                clipboardManager.clearPrimaryClip()
                Log.d(TAG, "Clipboard cleared using clearPrimaryClip()")
              } else {
                // Fallback for API < 28: set empty clip
                val emptyClip = ClipData.newPlainText("", "")
                clipboardManager.setPrimaryClip(emptyClip)
                Log.d(TAG, "Clipboard cleared using empty clip (API < 28)")
              }
              Triple(true, null, null)
            } catch (e: Exception) {
              Log.e(TAG, "Clipboard clear failed", e)
              Triple(false, null, "Clear failed: ${e.message}")
            }
          }
          "paste" -> {
            try {
              perfProvider.startOperation("findFocusedNode")
              val focusedNode = findFocusedEditableNode(rootInActiveWindow)
              perfProvider.endOperation("findFocusedNode")

              if (focusedNode == null) {
                Log.w(TAG, "No focused editable node found for paste")
                Triple(
                  false,
                  null,
                  "No focused input field found. Focus a text field before pasting.",
                )
              } else {
                perfProvider.startOperation("performPaste")
                val pasteSuccess =
                  focusedNode.performAction(
                    android.view.accessibility.AccessibilityNodeInfo.ACTION_PASTE,
                  )
                focusedNode.recycle()
                perfProvider.endOperation("performPaste")

                if (pasteSuccess) {
                  Log.d(TAG, "Clipboard paste successful")
                  Triple(true, null, null)
                } else {
                  Log.w(TAG, "Paste action returned false")
                  Triple(false, null, "Paste action failed")
                }
              }
            } catch (e: Exception) {
              Log.e(TAG, "Clipboard paste failed", e)
              Triple(false, null, "Paste failed: ${e.message}")
            }
          }
          else -> {
            Log.w(TAG, "Unknown clipboard action: $action")
            Triple(false, null, "Unknown action: $action")
          }
        }

      perfProvider.endOperation("executeClipboardAction")
      perfProvider.end()

      Log.d(TAG, "Clipboard action completed: action=$action, success=$success")

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "Clipboard total time: ${totalTime}ms")

      // Broadcast clipboard result
      kotlinx.coroutines.runBlocking {
        broadcastClipboardResult(requestId, action, success, resultText, error, totalTime)
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing clipboard operation", e)
      kotlinx.coroutines.runBlocking {
        broadcastClipboardResult(requestId, action, false, null, e.message, errorTime - startTime)
      }
    }
  }

  private fun performSettingsRead(requestId: String?, namespace: String, key: String) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performSettingsRead: namespace=$namespace key=$key")
    perfProvider.serial("performSettingsRead")

    var success = false
    var value: String? = null
    var found = false
    var error: String? = null

    try {
      perfProvider.startOperation("readSetting")
      value =
        when (namespace) {
          "system" -> Settings.System.getString(contentResolver, key)
          "secure" -> Settings.Secure.getString(contentResolver, key)
          "global" -> Settings.Global.getString(contentResolver, key)
          else -> {
            error = "Unknown namespace: $namespace"
            null
          }
        }
      perfProvider.endOperation("readSetting")
      if (error == null) {
        success = true
        found = value != null
      }
    } catch (e: SecurityException) {
      // Why: surface permission errors cleanly so the TS caller can fall back to ADB
      error = "SecurityException: ${e.message}"
      Log.w(TAG, "Settings read denied: $namespace/$key", e)
    } catch (e: Exception) {
      error = "Read failed: ${e.message}"
      Log.e(TAG, "Settings read failed: $namespace/$key", e)
    } finally {
      perfProvider.end()
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastSettingsGetResult(
          requestId,
          namespace,
          key,
          success,
          value,
          found,
          error,
          totalTime,
        )
      }
    }
  }

  private fun performSettingsWrite(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performSettingsWrite: namespace=$namespace key=$key valueType=$valueType")
    perfProvider.serial("performSettingsWrite")

    var success = false
    var error: String? = null

    try {
      perfProvider.startOperation("writeSetting")
      if (value == null) {
        success = writeSettingString(namespace, key, null)
      } else {
        success =
          when (valueType) {
            "int" -> {
              val intVal = value.toIntOrNull()
              if (intVal == null) {
                error = "Invalid int value: $value"
                false
              } else {
                writeSettingInt(namespace, key, intVal)
              }
            }
            "long" -> {
              val longVal = value.toLongOrNull()
              if (longVal == null) {
                error = "Invalid long value: $value"
                false
              } else {
                writeSettingLong(namespace, key, longVal)
              }
            }
            "float" -> {
              val floatVal = value.toFloatOrNull()
              if (floatVal == null) {
                error = "Invalid float value: $value"
                false
              } else {
                writeSettingFloat(namespace, key, floatVal)
              }
            }
            else -> writeSettingString(namespace, key, value)
          }
      }
      perfProvider.endOperation("writeSetting")
      if (!success && error == null) {
        error = "Unknown namespace: $namespace"
      }
    } catch (e: SecurityException) {
      // Why: writes to Settings.System require WRITE_SETTINGS; Secure/Global require system app.
      // Surface SecurityException so the TS client can fall back to ADB instead of crashing.
      error = "SecurityException: ${e.message}"
      Log.w(TAG, "Settings write denied: $namespace/$key", e)
    } catch (e: Exception) {
      error = "Write failed: ${e.message}"
      Log.e(TAG, "Settings write failed: $namespace/$key", e)
    } finally {
      perfProvider.end()
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastSettingsPutResult(requestId, namespace, key, success, error, totalTime)
      }
    }
  }

  private fun performSettingsList(requestId: String?, namespace: String) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performSettingsList: namespace=$namespace")
    perfProvider.serial("performSettingsList")

    var success = false
    var entries: Map<String, String>? = null
    var error: String? = null

    try {
      perfProvider.startOperation("listSettings")
      val uri =
        when (namespace) {
          "system" -> Settings.System.CONTENT_URI
          "secure" -> Settings.Secure.CONTENT_URI
          "global" -> Settings.Global.CONTENT_URI
          else -> null
        }
      if (uri == null) {
        error = "Unknown namespace: $namespace"
      } else {
        val map = HashMap<String, String>()
        contentResolver.query(uri, arrayOf("name", "value"), null, null, null)?.use { cursor ->
          val nameIdx = cursor.getColumnIndex("name")
          val valueIdx = cursor.getColumnIndex("value")
          if (nameIdx >= 0 && valueIdx >= 0) {
            while (cursor.moveToNext()) {
              val name = cursor.getString(nameIdx) ?: continue
              val v = cursor.getString(valueIdx) ?: ""
              map[name] = v
            }
          }
        }
        entries = map
        success = true
      }
      perfProvider.endOperation("listSettings")
    } catch (e: SecurityException) {
      error = "SecurityException: ${e.message}"
      Log.w(TAG, "Settings list denied: $namespace", e)
    } catch (e: Exception) {
      error = "List failed: ${e.message}"
      Log.e(TAG, "Settings list failed: $namespace", e)
    } finally {
      perfProvider.end()
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastSettingsListResult(requestId, namespace, success, entries, error, totalTime)
      }
    }
  }

  private fun writeSettingString(namespace: String, key: String, value: String?): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putString(contentResolver, key, value)
      "secure" -> Settings.Secure.putString(contentResolver, key, value)
      "global" -> Settings.Global.putString(contentResolver, key, value)
      else -> false
    }
  }

  private fun writeSettingInt(namespace: String, key: String, value: Int): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putInt(contentResolver, key, value)
      "secure" -> Settings.Secure.putInt(contentResolver, key, value)
      "global" -> Settings.Global.putInt(contentResolver, key, value)
      else -> false
    }
  }

  private fun writeSettingLong(namespace: String, key: String, value: Long): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putLong(contentResolver, key, value)
      "secure" -> Settings.Secure.putLong(contentResolver, key, value)
      "global" -> Settings.Global.putLong(contentResolver, key, value)
      else -> false
    }
  }

  private fun writeSettingFloat(namespace: String, key: String, value: Float): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putFloat(contentResolver, key, value)
      "secure" -> Settings.Secure.putFloat(contentResolver, key, value)
      "global" -> Settings.Global.putFloat(contentResolver, key, value)
      else -> false
    }
  }

  /**
   * Enumerate installed packages via PackageManager. Returns over WebSocket so callers can avoid
   * the per-call ADB round-trip cost of `pm list packages`.
   */
  private fun performInstalledPackages(requestId: String?, includeSystem: Boolean, userId: Int?) {
    val startTime = System.currentTimeMillis()
    // Why: android.os.UserHandle.myUserId() is technically @hide but stable; fall back
    // to userSerialNumber via UserManager if reflection ever breaks.
    val currentUserId =
      try {
        val cls = Class.forName("android.os.UserHandle")
        (cls.getDeclaredMethod("myUserId").invoke(null) as Int)
      } catch (e: Exception) {
        0
      }
    if (userId != null && userId != currentUserId) {
      kotlinx.coroutines.runBlocking {
        broadcastInstalledPackagesResult(
          requestId = requestId,
          success = false,
          userId = currentUserId,
          packages = emptyList(),
          error =
            "Requested userId=$userId differs from service userId=$currentUserId; ADB fallback required",
          totalTimeMs = System.currentTimeMillis() - startTime,
        )
      }
      return
    }

    try {
      val infos =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager.getInstalledPackages(
            android.content.pm.PackageManager.PackageInfoFlags.of(0L),
          )
        } else {
          @Suppress("DEPRECATION") packageManager.getInstalledPackages(0)
        }
      // Launchability comes from ONE batched MAIN/LAUNCHER query rather than a
      // per-package getLaunchIntentForPackage, which would accept MAIN/INFO and
      // disagree with the adb fallback for the same install (#6924 review).
      val launchablePackages = launchablePackageNames(packageManager)
      val records = mutableListOf<dev.jasonpearson.automobile.protocol.InstalledPackageRecord>()
      for (info in infos) {
        val isSystem =
          (info.applicationInfo?.flags ?: 0) and
            (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
        if (!includeSystem && isSystem) continue
        val versionCode =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
          else @Suppress("DEPRECATION") info.versionCode.toLong()
        // The same batched MAIN/LAUNCHER query that establishes launchability also carries the
        // label shown by launchers. Its helper falls back safely when an app disappears mid-list.
        val label =
          preferredInstalledPackageLabel(
            info.packageName,
            info.applicationInfo,
            launchablePackages,
            packageManager,
          )
        records.add(
          dev.jasonpearson.automobile.protocol.InstalledPackageRecord(
            packageName = info.packageName,
            isSystem = isSystem,
            versionName = info.versionName,
            versionCode = versionCode,
            label = label,
            launchable = launchablePackages?.packageNames?.contains(info.packageName),
          ),
        )
      }
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastInstalledPackagesResult(
          requestId = requestId,
          success = true,
          userId = currentUserId,
          packages = records,
          error = null,
          totalTimeMs = totalTime,
        )
      }
    } catch (e: Exception) {
      Log.e(TAG, "performInstalledPackages failed", e)
      kotlinx.coroutines.runBlocking {
        broadcastInstalledPackagesResult(
          requestId = requestId,
          success = false,
          userId = currentUserId,
          packages = emptyList(),
          error = "Failed to enumerate packages: ${e.message}",
          totalTimeMs = System.currentTimeMillis() - startTime,
        )
      }
    }
  }

  /** Read package metadata via PackageManager. */
  private fun performPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) {
    val startTime = System.currentTimeMillis()
    try {
      val flags = if (includePermissions) android.content.pm.PackageManager.GET_PERMISSIONS else 0
      val info =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager.getPackageInfo(
            packageName,
            android.content.pm.PackageManager.PackageInfoFlags.of(flags.toLong()),
          )
        } else {
          @Suppress("DEPRECATION") packageManager.getPackageInfo(packageName, flags)
        }

      val appInfo = info.applicationInfo
      val isSystem =
        (appInfo?.flags ?: 0) and
          (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
      val applicationLabel = appInfo?.let { packageManager.getApplicationLabel(it).toString() }
      val versionCode =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
      val installerPackage =
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            packageManager.getInstallSourceInfo(packageName).installingPackageName
          } else {
            @Suppress("DEPRECATION") packageManager.getInstallerPackageName(packageName)
          }
        } catch (e: Exception) {
          null
        }
      val allowBackup = appInfo?.let { (it.flags and ApplicationInfo.FLAG_ALLOW_BACKUP) != 0 }
      val requested = info.requestedPermissions?.toList().orEmpty()
      val flagsArray = info.requestedPermissionsFlags
      val granted = mutableMapOf<String, Boolean>()
      if (includePermissions && flagsArray != null) {
        for (i in requested.indices) {
          val isGranted =
            if (i < flagsArray.size) {
              (flagsArray[i] and android.content.pm.PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
            } else false
          granted[requested[i]] = isGranted
        }
      }
      val mainActivity =
        try {
          packageManager.getLaunchIntentForPackage(packageName)?.component?.flattenToShortString()
        } catch (e: Exception) {
          null
        }

      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastPackageInfoResult(
          requestId = requestId,
          success = true,
          packageName = packageName,
          isSystem = isSystem,
          applicationLabel = applicationLabel,
          versionName = info.versionName,
          versionCode = versionCode,
          installerPackage = installerPackage,
          firstInstallTime = info.firstInstallTime,
          lastUpdateTime = info.lastUpdateTime,
          allowBackup = allowBackup,
          requestedPermissions = requested,
          grantedPermissions = granted,
          mainActivity = mainActivity,
          error = null,
          totalTimeMs = totalTime,
        )
      }
    } catch (e: android.content.pm.PackageManager.NameNotFoundException) {
      kotlinx.coroutines.runBlocking {
        broadcastPackageInfoResult(
          requestId = requestId,
          success = false,
          packageName = packageName,
          isSystem = false,
          applicationLabel = null,
          versionName = null,
          versionCode = null,
          installerPackage = null,
          firstInstallTime = null,
          lastUpdateTime = null,
          allowBackup = null,
          requestedPermissions = emptyList(),
          grantedPermissions = emptyMap(),
          mainActivity = null,
          error = "Package not installed or not visible: $packageName",
          totalTimeMs = System.currentTimeMillis() - startTime,
        )
      }
    } catch (e: Exception) {
      Log.e(TAG, "performPackageInfo failed for $packageName", e)
      kotlinx.coroutines.runBlocking {
        broadcastPackageInfoResult(
          requestId = requestId,
          success = false,
          packageName = packageName,
          isSystem = false,
          applicationLabel = null,
          versionName = null,
          versionCode = null,
          installerPackage = null,
          firstInstallTime = null,
          lastUpdateTime = null,
          allowBackup = null,
          requestedPermissions = emptyList(),
          grantedPermissions = emptyMap(),
          mainActivity = null,
          error = "Failed to read package info: ${e.message}",
          totalTimeMs = System.currentTimeMillis() - startTime,
        )
      }
    }
  }

  /** Resolve the launcher activity component for a package. */
  private fun performLaunchIntent(requestId: String?, packageName: String) {
    val startTime = System.currentTimeMillis()
    try {
      val intent = packageManager.getLaunchIntentForPackage(packageName)
      val component = intent?.component?.flattenToShortString()
      val totalTime = System.currentTimeMillis() - startTime
      val success = component != null
      kotlinx.coroutines.runBlocking {
        broadcastLaunchIntentResult(
          requestId = requestId,
          success = success,
          packageName = packageName,
          componentName = component,
          error = if (!success) "No launch intent for $packageName" else null,
          totalTimeMs = totalTime,
        )
      }
    } catch (e: Exception) {
      Log.e(TAG, "performLaunchIntent failed for $packageName", e)
      kotlinx.coroutines.runBlocking {
        broadcastLaunchIntentResult(
          requestId = requestId,
          success = false,
          packageName = packageName,
          componentName = null,
          error = "Failed to resolve launch intent: ${e.message}",
          totalTimeMs = System.currentTimeMillis() - startTime,
        )
      }
    }
  }

  /** Install a CA certificate via DevicePolicyManager (device owner only). */
  private fun performInstallCaCertificate(requestId: String?, certificate: String) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performInstallCaCertificate")
    perfProvider.serial("installCaCert")

    var success = false
    var alias: String? = null
    var error: String? = null

    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        error = "CA certificate install requires API 21+"
        return
      }

      val deviceOwnerError = validateDeviceOwnerStatus()
      if (deviceOwnerError != null) {
        error = deviceOwnerError
        return
      }

      perfProvider.startOperation("decodeCert")
      val certBytes = decodeCertificateBytes(certificate)
      perfProvider.endOperation("decodeCert")
      if (certBytes == null) {
        error = "Certificate payload is empty or invalid"
        return
      }

      alias = computeCertificateAlias(certBytes)

      perfProvider.startOperation("persistCert")
      val stored = writeCaCertToStorage(alias, certBytes)
      perfProvider.endOperation("persistCert")
      if (!stored) {
        error = "Failed to persist certificate for alias: $alias"
        return
      }

      perfProvider.startOperation("installCert")
      try {
        success = devicePolicyManager.installCaCert(deviceAdminComponent, certBytes)
      } finally {
        perfProvider.endOperation("installCert")
      }
      if (!success) {
        error = "DevicePolicyManager.installCaCert returned false"
      }
    } catch (e: Exception) {
      error = "Failed to install CA certificate: ${e.message}"
      Log.e(TAG, "Error installing CA certificate", e)
    } finally {
      if (!success && alias != null) {
        deleteCaCertFromStorage(alias)
      }
      perfProvider.end()
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastCaCertResult(requestId, "install", success, alias, error, totalTime)
      }
    }
  }

  /** Install a CA certificate from a device file path (device owner only). */
  private fun performInstallCaCertificateFromPath(requestId: String?, devicePath: String) {
    val startTime = System.currentTimeMillis()
    val payload = readCertificatePayloadFromPath(devicePath)
    if (payload == null) {
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastCaCertResult(
          requestId,
          "install",
          false,
          null,
          "Certificate file is empty or unreadable: $devicePath",
          totalTime,
        )
      }
      return
    }

    performInstallCaCertificate(requestId, payload)
  }

  /** Remove a CA certificate via DevicePolicyManager (device owner only). */
  private fun performRemoveCaCertificate(
    requestId: String?,
    alias: String?,
    certificate: String?,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performRemoveCaCertificate")
    perfProvider.serial("removeCaCert")

    var success = false
    var resolvedAlias: String? = alias
    var error: String? = null

    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        error = "CA certificate removal requires API 21+"
        return
      }

      val deviceOwnerError = validateDeviceOwnerStatus()
      if (deviceOwnerError != null) {
        error = deviceOwnerError
        return
      }

      perfProvider.startOperation("resolveCert")
      val certBytes =
        when {
          !alias.isNullOrBlank() -> {
            val stored = readCaCertFromStorage(alias)
            stored ?: certificate?.let { decodeCertificateBytes(it) }
          }
          !certificate.isNullOrBlank() -> decodeCertificateBytes(certificate)
          else -> null
        }
      perfProvider.endOperation("resolveCert")

      if (certBytes == null) {
        error =
          if (!alias.isNullOrBlank()) {
            "No stored certificate found for alias: $alias"
          } else {
            "Certificate payload is required for removal"
          }
        return
      }

      if (resolvedAlias.isNullOrBlank()) {
        resolvedAlias = computeCertificateAlias(certBytes)
      }

      val wasInstalled = isCaCertInstalled(certBytes)
      if (wasInstalled == false) {
        error = "CA certificate is not installed"
        return
      }

      perfProvider.startOperation("removeCert")
      try {
        devicePolicyManager.uninstallCaCert(deviceAdminComponent, certBytes)
      } finally {
        perfProvider.endOperation("removeCert")
      }
      val isInstalled = isCaCertInstalled(certBytes)
      success = isInstalled == false
      if (success) {
        resolvedAlias?.let { deleteCaCertFromStorage(it) }
      } else {
        error =
          if (isInstalled == null) {
            "Unable to confirm CA certificate removal"
          } else {
            "CA certificate still installed after uninstall"
          }
      }
    } catch (e: Exception) {
      error = "Failed to remove CA certificate: ${e.message}"
      Log.e(TAG, "Error removing CA certificate", e)
    } finally {
      perfProvider.end()
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastCaCertResult(requestId, "remove", success, resolvedAlias, error, totalTime)
      }
    }
  }

  private fun isCaCertInstalled(certBytes: ByteArray): Boolean? {
    return try {
      val installedCerts = devicePolicyManager.getInstalledCaCerts(deviceAdminComponent)
      installedCerts.any { it.contentEquals(certBytes) }
    } catch (e: Exception) {
      Log.w(TAG, "Unable to query installed CA certificates", e)
      null
    }
  }

  /** Report device owner status for the accessibility service package. */
  private fun performGetDeviceOwnerStatus(requestId: String?) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performGetDeviceOwnerStatus")
    perfProvider.serial("deviceOwnerStatus")

    var isDeviceOwner = false
    var isAdminActive = false
    var error: String? = null

    try {
      isDeviceOwner = devicePolicyManager.isDeviceOwnerApp(packageName)
      isAdminActive = devicePolicyManager.isAdminActive(deviceAdminComponent)
    } catch (e: Exception) {
      error = "Failed to read device owner status: ${e.message}"
      Log.e(TAG, "Error reading device owner status", e)
    } finally {
      perfProvider.end()
      val totalTime = System.currentTimeMillis() - startTime
      kotlinx.coroutines.runBlocking {
        broadcastDeviceOwnerStatusResult(
          requestId,
          isDeviceOwner,
          isAdminActive,
          error,
          totalTime,
        )
      }
    }
  }

  private fun validateDeviceOwnerStatus(): String? {
    if (!devicePolicyManager.isDeviceOwnerApp(packageName)) {
      return "Device owner is not active for $packageName"
    }
    if (!devicePolicyManager.isAdminActive(deviceAdminComponent)) {
      return "Device admin receiver is not active for $packageName"
    }
    return null
  }

  private fun decodeCertificateBytes(certificate: String): ByteArray? {
    val trimmed = certificate.trim()
    if (trimmed.isEmpty()) {
      return null
    }

    val pemHeader = "-----BEGIN CERTIFICATE-----"
    val pemFooter = "-----END CERTIFICATE-----"
    val normalized =
      if (trimmed.contains(pemHeader)) {
        trimmed.replace(pemHeader, "").replace(pemFooter, "").replace("\\s".toRegex(), "")
      } else {
        trimmed.replace("\\s".toRegex(), "")
      }

    return try {
      Base64.decode(normalized, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Failed to decode certificate payload", e)
      null
    }
  }

  private fun readCertificatePayloadFromPath(devicePath: String): String? {
    val certFile = File(devicePath)
    if (!certFile.exists() || !certFile.isFile) {
      Log.w(TAG, "Certificate file not found at $devicePath")
      return null
    }

    val bytes =
      try {
        certFile.readBytes()
      } catch (e: Exception) {
        Log.w(TAG, "Failed to read certificate file at $devicePath", e)
        return null
      }

    if (bytes.isEmpty()) {
      Log.w(TAG, "Certificate file is empty at $devicePath")
      return null
    }

    val text = bytes.toString(Charsets.UTF_8)
    val normalized = text.trim()
    if (normalized.contains("-----BEGIN CERTIFICATE-----")) {
      return normalized
    }

    val compact = normalized.replace("\\s".toRegex(), "")
    if (compact.isNotEmpty() && compact.matches(Regex("^[A-Za-z0-9+/=]+$"))) {
      return compact
    }

    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  private fun computeCertificateAlias(certBytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(certBytes)
    return digest.joinToString("") { formatHexByte(it) }
  }

  private fun writeCaCertToStorage(alias: String, certBytes: ByteArray): Boolean {
    val dir = File(filesDir, "ca_certs")
    if (!dir.exists() && !dir.mkdirs()) {
      Log.w(TAG, "Failed to create CA cert storage directory: ${dir.absolutePath}")
      return false
    }

    val certFile = File(dir, "$alias.der")
    return try {
      certFile.writeBytes(certBytes)
      true
    } catch (e: Exception) {
      Log.w(TAG, "Failed to write CA cert file: ${certFile.absolutePath}", e)
      false
    }
  }

  private fun readCaCertFromStorage(alias: String): ByteArray? {
    val certFile = File(File(filesDir, "ca_certs"), "$alias.der")
    if (!certFile.exists()) {
      return null
    }
    return try {
      certFile.readBytes()
    } catch (e: Exception) {
      Log.w(TAG, "Failed to read CA cert file: ${certFile.absolutePath}", e)
      null
    }
  }

  private fun deleteCaCertFromStorage(alias: String) {
    val certFile = File(File(filesDir, "ca_certs"), "$alias.der")
    if (!certFile.exists()) {
      return
    }
    if (!certFile.delete()) {
      Log.w(TAG, "Failed to delete CA cert file: ${certFile.absolutePath}")
    }
  }

  /** Find the next focusable node after the given node in document order. */
  private fun findNextFocusableNode(
    root: android.view.accessibility.AccessibilityNodeInfo?,
    currentNode: android.view.accessibility.AccessibilityNodeInfo,
  ): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null

    // Collect all focusable editable nodes in document order
    val focusableNodes = mutableListOf<android.view.accessibility.AccessibilityNodeInfo>()
    collectFocusableNodes(root, focusableNodes)

    // Find current node's position and return the next one
    var foundCurrent = false
    for (node in focusableNodes) {
      if (foundCurrent) {
        // This is the next node - return it (don't recycle it)
        // Recycle all remaining nodes
        focusableNodes.forEach { n -> if (n != node) n.recycle() }
        return node
      }
      if (isSameNode(node, currentNode)) {
        foundCurrent = true
      }
    }

    // If no next node found, recycle all collected nodes
    focusableNodes.forEach { it.recycle() }
    return null
  }

  /** Find the previous focusable node before the given node in document order. */
  private fun findPreviousFocusableNode(
    root: android.view.accessibility.AccessibilityNodeInfo?,
    currentNode: android.view.accessibility.AccessibilityNodeInfo,
  ): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null

    // Collect all focusable editable nodes in document order
    val focusableNodes = mutableListOf<android.view.accessibility.AccessibilityNodeInfo>()
    collectFocusableNodes(root, focusableNodes)

    // Find current node's position and return the previous one. Each copy is released exactly once.
    return selectPreviousFocusable(focusableNodes) { isSameNode(it, currentNode) }
  }

  /** Collect all focusable and editable nodes in document order (pre-order traversal). */
  private fun collectFocusableNodes(
    node: android.view.accessibility.AccessibilityNodeInfo,
    result: MutableList<android.view.accessibility.AccessibilityNodeInfo>,
  ) {
    // Approximate traversal must only include editors the user can reach.
    if (
      isImeFocusCandidate(
        ImeFocusCandidate(node.isEditable, node.isFocusable, node.isVisibleToUser, node.isEnabled),
      )
    ) {
      // Create a copy to add to our list (we'll recycle the originals as we traverse)
      result.add(android.view.accessibility.AccessibilityNodeInfo.obtain(node))
    }

    // Traverse children in order
    for (i in 0 until node.childCount) {
      val child = node.getChild(i) ?: continue
      collectFocusableNodes(child, result)
      child.recycle()
    }
  }

  /** Check if two AccessibilityNodeInfo objects refer to the same node. */
  private fun isSameNode(
    node1: android.view.accessibility.AccessibilityNodeInfo,
    node2: android.view.accessibility.AccessibilityNodeInfo,
  ): Boolean {
    // Compare by bounds and text/id since we can't reliably compare node objects directly
    val bounds1 = android.graphics.Rect()
    val bounds2 = android.graphics.Rect()
    node1.getBoundsInScreen(bounds1)
    node2.getBoundsInScreen(bounds2)
    return bounds1 == bounds2 &&
      node1.viewIdResourceName == node2.viewIdResourceName &&
      node1.text?.toString() == node2.text?.toString()
  }

  /**
   * Search the active window's root first, then the other windows the hierarchy extractor reports
   * for the active display (topmost first), for the first node [find] returns. The extractor's own
   * window enumeration is reused so node actions and focus read-back cannot disagree with
   * `observe`; the active window goes first so a bare id prefers the app over an IME/system window.
   */
  private fun findNodeInDisplayWindows(
    find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
  ): AccessibilityNodeInfo? =
    findNodeAcrossWindows(displayWindowsOrEmpty(), { rootInActiveWindow }, find)

  private fun displayWindowsOrEmpty(): List<AccessibilityWindowInfo> =
    try {
      viewHierarchyExtractor.selectDisplayWindows(this).windows
    } catch (e: Exception) {
      // Best-effort widening: on failure fall back to the active window alone, today's behaviour.
      Log.w(TAG, "Failed to enumerate display windows for node lookup", e)
      emptyList()
    }

  private fun findNodeBySelector(
    root: android.view.accessibility.AccessibilityNodeInfo?,
    selector: NodeSelector,
  ): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null

    if (matchesSelector(root, selector)) {
      return root
    }

    for (i in 0 until root.childCount) {
      val child = root.getChild(i) ?: continue
      val found = findNodeBySelector(child, selector)
      if (found != null) {
        if (found != child) {
          child.recycle()
        }
        return found
      }
      child.recycle()
    }

    return null
  }

  private fun matchesSelector(
    node: android.view.accessibility.AccessibilityNodeInfo,
    selector: NodeSelector,
  ): Boolean =
    nodeSelectorMatches(
      selector,
      NodeSelectorFields(
        resourceId = node.viewIdResourceName,
        testTag = extractTestTag(node),
        uniqueId = if (Build.VERSION.SDK_INT >= 33) node.uniqueId else null,
        collectionRow = node.collectionItemInfo?.rowIndex,
        collectionColumn = node.collectionItemInfo?.columnIndex,
      ),
    )

  private fun extractTestTag(node: android.view.accessibility.AccessibilityNodeInfo): String? {
    val extras = node.extras ?: return null
    val candidates =
      listOf(
        "androidx.compose.ui.semantics.testTag",
        "androidx.compose.ui.semantics.TestTag",
        "androidx.compose.ui.testTag",
        "testTag",
        "test-tag",
      )
    for (key in candidates) {
      val value = extras.get(key)?.toString()
      if (!value.isNullOrBlank()) {
        return value
      }
    }
    return extras
      .keySet()
      .firstOrNull { it.contains("testtag", ignoreCase = true) }
      ?.let { key ->
        extras.get(key)?.toString()
      }
  }

  /** Find the currently focused editable node. */
  private fun findFocusedEditableNode(
    root: android.view.accessibility.AccessibilityNodeInfo?,
  ): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null

    // First try to find the input-focused node
    val focusedNode = root.findFocus(android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT)
    if (focusedNode != null && focusedNode.isEditable) {
      return focusedNode
    }
    focusedNode?.recycle()

    // Fallback: search for any focused editable node in hierarchy
    return findFocusedEditableInHierarchy(root)
  }

  /** Recursively search for a focused editable node in the hierarchy. */
  private fun findFocusedEditableInHierarchy(
    node: android.view.accessibility.AccessibilityNodeInfo?,
  ): android.view.accessibility.AccessibilityNodeInfo? {
    if (node == null) return null

    // Check if this node is focused and editable
    if (node.isFocused && node.isEditable) {
      return node
    }

    // Search children
    for (i in 0 until node.childCount) {
      val child = node.getChild(i) ?: continue
      val found = findFocusedEditableInHierarchy(child)
      if (found != null) {
        if (found != child) {
          child.recycle()
        }
        return found
      }
      child.recycle()
    }

    return null
  }

  /** Broadcast set text result to WebSocket clients */
  private suspend fun broadcastSetTextResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping set text result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "set_text_result") {
      webSocketServer.broadcastWithPerfSync { perfTiming ->
        webSocketFrameJson("set_text_result", requestId = requestId, perfTiming = perfTiming) {
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(TAG, "Broadcasted set text result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  private suspend fun broadcastCommitTextResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    partialApplication: Boolean,
    committedUnits: Int = 0,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping commit text result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "commit_text_result") {
      webSocketServer.broadcastWithPerfSync { perfTiming ->
        webSocketFrameJson("commit_text_result", requestId = requestId, perfTiming = perfTiming) {
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (partialApplication) put("partialApplication", true)
          if (committedUnits > 0) put("committedUnits", committedUnits)
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(
        TAG,
        "Broadcasted commit text result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastSetKeyboardProfileResult(
    requestId: String?,
    success: Boolean,
    activeProfileId: String? = null,
    previousProfileId: String? = null,
    error: String? = null,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping keyboard profile result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "set_keyboard_profile_result") {
      webSocketServer.broadcastWithPerfSync { perfTiming ->
        webSocketFrameJson(
          "set_keyboard_profile_result",
          requestId = requestId,
          perfTiming = perfTiming,
        ) {
          put("success", success)
          if (activeProfileId != null) put("activeProfileId", activeProfileId)
          if (previousProfileId != null) put("previousProfileId", previousProfileId)
          if (error != null) put("error", error)
        }
      }
      Log.d(
        TAG,
        "Broadcasted keyboard profile result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastKeyboardProfileCatalog(
    requestId: String?,
    success: Boolean,
    catalogVersion: Int? = null,
    supportedCatalogVersions: List<Int>,
    activeProfileId: String? = null,
    profiles: List<KeyboardProfileInfo> = emptyList(),
    error: String? = null,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping keyboard profile catalog response")
      return
    }

    resultBroadcaster.guard(requestId, "keyboard_profiles_result") {
      webSocketServer.broadcastWithPerfSync { perfTiming ->
        webSocketFrameJson(
          "keyboard_profiles_result",
          requestId = requestId,
          perfTiming = perfTiming,
        ) {
          put("success", success)
          put("catalogId", "automobile_behavior_profiles")
          if (catalogVersion != null) put("catalogVersion", catalogVersion)
          put("supportedCatalogVersions", jsonCompact.encodeToJsonElement(supportedCatalogVersions))
          if (activeProfileId != null) put("activeProfileId", activeProfileId)
          if (success) put("profiles", jsonCompact.encodeToJsonElement(profiles))
          if (error != null) put("error", error)
        }
      }
    }
  }

  /** Broadcast insert text result to WebSocket clients. */
  private suspend fun broadcastInsertTextResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    partialApplication: Boolean = false,
    warning: String? = null,
    caretPlaced: Boolean? = null,
    resultingTextLength: Int? = null,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping insert text result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "insert_text_result") {
      webSocketServer.broadcastWithPerfSync { perfTiming ->
        webSocketFrameJson("insert_text_result", requestId = requestId, perfTiming = perfTiming) {
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (error != null) {
            put("error", error)
          }
          if (warning != null) put("warning", warning)
          if (caretPlaced != null) put("caretPlaced", caretPlaced)
          if (resultingTextLength != null) put("resultingTextLength", resultingTextLength)
          if (partialApplication) {
            put("partialApplication", true)
          }
        }
      }
    }
  }

  /** Broadcast IME action result to WebSocket clients */
  private suspend fun broadcastImeActionResult(
    requestId: String?,
    action: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    approximated: Boolean? = null,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping IME action result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "ime_action_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("ime_action_result", requestId = requestId, perfTiming = perfTiming) {
          if (approximated != null) put("approximated", approximated)
          put("action", action)
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(TAG, "Broadcasted IME action result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast select all result to WebSocket clients */
  private suspend fun broadcastSelectAllResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping select all result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "select_all_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("select_all_result", requestId = requestId, perfTiming = perfTiming) {
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(TAG, "Broadcasted select all result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast accessibility action result to WebSocket clients */
  private suspend fun broadcastActionResult(
    requestId: String?,
    action: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    alreadySatisfied: Boolean = false,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping action result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "action_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("action_result", requestId = requestId, perfTiming = perfTiming) {
          put("action", action)
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (error != null) {
            put("error", error)
          }
          if (alreadySatisfied) {
            put("alreadySatisfied", true)
          }
        }
      }
      Log.d(TAG, "Broadcasted action result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast clipboard result to WebSocket clients */
  private suspend fun broadcastClipboardResult(
    requestId: String?,
    action: String,
    success: Boolean,
    text: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping clipboard result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "clipboard_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("clipboard_result", requestId = requestId, perfTiming = perfTiming) {
          put("action", action)
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (text != null) {
            put("text", text)
          }
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(TAG, "Broadcasted clipboard result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  private suspend fun broadcastSettingsGetResult(
    requestId: String?,
    namespace: String,
    key: String,
    success: Boolean,
    value: String?,
    found: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return
    resultBroadcaster.guard(requestId, "settings_get_result") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.SettingsGetResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          namespace = namespace,
          key = key,
          value = value,
          found = found,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastSettingsPutResult(
    requestId: String?,
    namespace: String,
    key: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return
    resultBroadcaster.guard(requestId, "settings_put_result") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.SettingsPutResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          namespace = namespace,
          key = key,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastSettingsListResult(
    requestId: String?,
    namespace: String,
    success: Boolean,
    entries: Map<String, String>?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return
    resultBroadcaster.guard(requestId, "settings_list_result") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.SettingsListResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          namespace = namespace,
          entries = entries,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastInstalledPackagesResult(
    requestId: String?,
    success: Boolean,
    userId: Int,
    packages: List<dev.jasonpearson.automobile.protocol.InstalledPackageRecord>,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return
    resultBroadcaster.guard(requestId, "installed_packages_result") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.InstalledPackagesResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          userId = userId,
          packages = packages,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastPackageInfoResult(
    requestId: String?,
    success: Boolean,
    packageName: String,
    isSystem: Boolean,
    applicationLabel: String?,
    versionName: String?,
    versionCode: Long?,
    installerPackage: String?,
    firstInstallTime: Long?,
    lastUpdateTime: Long?,
    allowBackup: Boolean?,
    requestedPermissions: List<String>,
    grantedPermissions: Map<String, Boolean>,
    mainActivity: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return
    resultBroadcaster.guard(requestId, "package_info_result") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.PackageInfoResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          packageName = packageName,
          isSystem = isSystem,
          applicationLabel = applicationLabel,
          versionName = versionName,
          versionCode = versionCode,
          installerPackage = installerPackage,
          firstInstallTime = firstInstallTime,
          lastUpdateTime = lastUpdateTime,
          allowBackup = allowBackup,
          requestedPermissions = requestedPermissions,
          grantedPermissions = grantedPermissions,
          mainActivity = mainActivity,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastLaunchIntentResult(
    requestId: String?,
    success: Boolean,
    packageName: String,
    componentName: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return
    resultBroadcaster.guard(requestId, "launch_intent_result") {
      webSocketServer.broadcast(
        dev.jasonpearson.automobile.protocol.LaunchIntentResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          packageName = packageName,
          componentName = componentName,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  /** Broadcast CA certificate result to WebSocket clients */
  private suspend fun broadcastCaCertResult(
    requestId: String?,
    action: String,
    success: Boolean,
    alias: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping CA cert result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "ca_cert_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("ca_cert_result", requestId = requestId, perfTiming = perfTiming) {
          put("action", action)
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          if (alias != null) {
            put("alias", alias)
          }
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(TAG, "Broadcasted ca_cert_result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast device owner status result to WebSocket clients */
  private suspend fun broadcastDeviceOwnerStatusResult(
    requestId: String?,
    isDeviceOwner: Boolean,
    isAdminActive: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping device owner status broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "device_owner_status_result") {
      val success = error == null
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson(
          "device_owner_status_result",
          requestId = requestId,
          perfTiming = perfTiming,
        ) {
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          put("packageName", packageName)
          put("isDeviceOwner", isDeviceOwner)
          put("isAdminActive", isAdminActive)
          if (error != null) {
            put("error", error)
          }
        }
      }
      Log.d(
        TAG,
        "Broadcasted device_owner_status_result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  /** Broadcast permission result to WebSocket clients */
  private suspend fun broadcastPermissionResult(
    requestId: String?,
    result: PermissionManager.PermissionState,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping permission result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "permission_result") {
      val success = result.error == null
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("permission_result", requestId = requestId, perfTiming = perfTiming) {
          put("success", success)
          put("totalTimeMs", totalTimeMs)
          put("permission", result.permission)
          put("granted", result.granted)
          put("requestLaunched", result.requestLaunched)
          put("canRequest", result.canRequest)
          put("requiresSettings", result.requiresSettings)
          if (result.instructions != null) {
            put("instructions", result.instructions)
          }
          if (result.adbCommand != null) {
            put("adbCommand", result.adbCommand)
          }
          if (result.error != null) {
            put("error", result.error)
          }
        }
      }
      Log.d(TAG, "Broadcasted permission result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast swipe result to WebSocket clients */
  private suspend fun broadcastSwipeResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping swipe result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "swipe_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        swipeResultFrame(requestId, success, error, totalTimeMs, gestureTimeMs, perfTiming)
      }
      Log.d(TAG, "Broadcasted swipe result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast drag result to WebSocket clients */
  private suspend fun broadcastDragResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping drag result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "drag_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        dragResultFrame(requestId, success, error, totalTimeMs, gestureTimeMs, perfTiming)
      }
      Log.d(TAG, "Broadcasted drag result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast tap coordinates result to WebSocket clients */
  private suspend fun broadcastTapCoordinatesResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping tap coordinates result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "tap_coordinates_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        tapCoordinatesResultFrame(requestId, success, error, totalTimeMs, perfTiming)
      }
      Log.d(
        TAG,
        "Broadcasted tap coordinates result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  /** Broadcast pinch result to WebSocket clients */
  private suspend fun broadcastPinchResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    gestureTimeMs: Long?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping pinch result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "pinch_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        pinchResultFrame(requestId, success, error, totalTimeMs, gestureTimeMs, perfTiming)
      }
      Log.d(TAG, "Broadcasted pinch result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast screenshot to WebSocket clients */
  private fun broadcastScreenshot(
    requestId: String?,
    displayId: Int? = null,
    hidePrototypes: Boolean = false,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping screenshot broadcast")
      return
    }

    // Routed through asyncActionRunner: a throw in takeScreenshotAsync() (or the broadcast) would
    // otherwise be logged-and-swallowed here, emitting neither `screenshot` nor `screenshot_error`
    // and hanging the awaiting client until timeout (issue #3023).
    asyncActionRunner.launch(requestId, "screenshot") {
      val contextBeforeCapture = currentFrameContext()
      val targetDisplayId = displayId ?: activeDisplayId()
      val prototypesHidden: Boolean?
      val outcome =
        if (hidePrototypes) {
          val capture = captureWithPrototypeHidden(targetDisplayId)
          prototypesHidden = capture.prototypeExcluded
          capture.value
        } else {
          prototypesHidden = null
          takeScreenshotAsync(targetDisplayId)
        }
      val stableContext = contextBeforeCapture.takeIf { it == currentFrameContext() }
      when (outcome) {
        is ScreenshotCaptureOutcome.Success -> {
          val screenshot = outcome.payload
          webSocketServer.broadcast(
            ProtocolScreenshotResult(
              timestamp = System.currentTimeMillis(),
              requestId = requestId,
              data = screenshot.base64Image,
              format = "jpeg",
              rotation = screenshot.rotation,
              displayId = screenshot.displayId,
              panelUniqueId = screenshot.panelUniqueId,
              screenshotCaptureDurationMs = screenshot.captureDurationMs,
              screenshotEncodeDurationMs = screenshot.encodeDurationMs,
              screenshotByteLength = screenshot.byteLength,
              screenshotBase64Length = screenshot.base64Length,
              frameContext = stableContext?.toString(),
              prototypesHidden = prototypesHidden,
            ),
          )
          Log.d(TAG, "Broadcasted screenshot to ${webSocketServer.getConnectionCount()} clients")
        }
        is ScreenshotCaptureOutcome.Failure -> {
          // Surface a rate limit distinctly so the daemon classifies it as ctrlproxy_rate_limited
          // rather than a generic capture failure (issue #4927).
          val error = CtrlProxyScreenshotWire.errorMessageForCode(outcome.errorCode)
          webSocketServer.broadcast(
            screenshotErrorFrame(requestId, error, targetDisplayId, panelUniqueId(targetDisplayId)),
          )
        }
      }
    }
  }

  /**
   * Hide-capture-restore in one device-side step (#9305), so a host that gives up mid-request can
   * never leave the prototype hidden: the host restores in its own finally.
   */
  private suspend fun captureWithPrototypeHidden(
    targetDisplayId: Int,
  ): PrototypeHiddenCapture<ScreenshotCaptureOutcome> =
    if (::prototypeController.isInitialized)
      prototypeController.withHiddenForCapture { takeScreenshotAsync(targetDisplayId) }
    else PrototypeHiddenCapture(takeScreenshotAsync(targetDisplayId), prototypeExcluded = true)

  /** Broadcast navigation event to WebSocket clients using typed protocol */
  private suspend fun broadcastNavigationEvent(
    event: TimestampedNavigationEvent,
    mode: WebSocketServer.BroadcastMode = WebSocketServer.BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping navigation event broadcast")
      return
    }

    try {
      val response = navigationEventResponse(event)

      webSocketServer.broadcast(response, mode, waitForClient)
      Log.d(
        TAG,
        "Broadcasted navigation event to ${webSocketServer.getConnectionCount()} clients: ${event.destination}",
      )
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting navigation event", e)
    }
  }

  /** Broadcast handled exception event to WebSocket clients using typed protocol */
  private suspend fun broadcastHandledExceptionEvent(
    timestamp: Long,
    exceptionClass: String,
    exceptionMessage: String?,
    stackTrace: String,
    customMessage: String?,
    currentScreen: String?,
    packageName: String,
    appVersion: String?,
    deviceModel: String,
    deviceManufacturer: String,
    osVersion: String,
    sdkInt: Int,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping handled exception broadcast")
      return
    }

    try {
      // Fall back to now because the legacy intent timestamp extra defaults to 0.
      val response =
        handledExceptionEventResponse(
          timestamp = crashEventTimestamp(timestamp, System.currentTimeMillis()),
          exceptionClass = exceptionClass,
          exceptionMessage = exceptionMessage,
          stackTrace = stackTrace,
          customMessage = customMessage,
          currentScreen = currentScreen,
          packageName = packageName,
          appVersion = appVersion,
          deviceModel = deviceModel,
          deviceManufacturer = deviceManufacturer,
          osVersion = osVersion,
          sdkInt = sdkInt,
        )

      webSocketServer.broadcast(response)
      Log.d(
        TAG,
        "Broadcasted handled exception to ${webSocketServer.getConnectionCount()} clients: $exceptionClass",
      )
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting handled exception event", e)
    }
  }

  /** Broadcast crash event to WebSocket clients using typed protocol */
  private suspend fun broadcastCrashEvent(
    timestamp: Long,
    exceptionClass: String,
    exceptionMessage: String?,
    stackTrace: String,
    threadName: String,
    currentScreen: String?,
    packageName: String,
    appVersion: String?,
    deviceModel: String,
    deviceManufacturer: String,
    osVersion: String,
    sdkInt: Int,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping crash broadcast")
      return
    }

    try {
      // Fall back to now because the legacy intent timestamp extra defaults to 0.
      val response =
        crashEventResponse(
          timestamp = crashEventTimestamp(timestamp, System.currentTimeMillis()),
          exceptionClass = exceptionClass,
          exceptionMessage = exceptionMessage,
          stackTrace = stackTrace,
          threadName = threadName,
          currentScreen = currentScreen,
          packageName = packageName,
          appVersion = appVersion,
          deviceModel = deviceModel,
          deviceManufacturer = deviceManufacturer,
          osVersion = osVersion,
          sdkInt = sdkInt,
        )

      webSocketServer.broadcast(response)
      Log.i(
        TAG,
        "Broadcasted crash to ${webSocketServer.getConnectionCount()} clients: $exceptionClass on thread $threadName",
      )
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting crash event", e)
    }
  }

  /** Broadcast an individual SDK event from a batch to WebSocket clients. */
  private suspend fun broadcastSdkEvent(
    event: SdkEvent,
    mode: WebSocketServer.BroadcastMode = WebSocketServer.BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) return

    try {
      val response =
        when (event) {
          is SdkNetworkRequestEvent ->
            NetworkEventResponse(
              timestamp = event.timestamp,
              event =
                NetworkEventData(
                  url = event.url,
                  method = event.method,
                  statusCode = event.statusCode,
                  durationMs = event.durationMs,
                  requestBodySize = event.requestBodySize,
                  responseBodySize = event.responseBodySize,
                  protocol = event.protocol,
                  host = event.host,
                  path = event.path,
                  error = event.error,
                  applicationId = event.applicationId,
                  requestHeaders = event.requestHeaders,
                  responseHeaders = event.responseHeaders,
                  requestBody = event.requestBody,
                  responseBody = event.responseBody,
                  contentType = event.contentType,
                ),
            )
          is SdkWebSocketFrameEvent ->
            WebSocketFrameResponse(
              timestamp = event.timestamp,
              event =
                WebSocketFrameData(
                  connectionId = event.connectionId,
                  url = event.url,
                  direction = event.direction.name.lowercase(),
                  frameType = event.frameType.name.lowercase(),
                  payloadSize = event.payloadSize,
                  success = event.success,
                  applicationId = event.applicationId,
                ),
            )
          // SdkLogEvent no longer broadcast from SDK — logs captured via logcat reader
          is SdkLogEvent -> null
          is SdkBroadcastEvent ->
            BroadcastEventResponse(
              timestamp = event.timestamp,
              event =
                BroadcastEventData(
                  action = event.action,
                  categories = event.categories,
                  extraKeys = event.extraKeys,
                  applicationId = event.applicationId,
                ),
            )
          is SdkLifecycleEvent ->
            LifecycleEventResponse(
              timestamp = event.timestamp,
              event =
                LifecycleEventData(
                  kind = event.kind,
                  details = event.details,
                  applicationId = event.applicationId,
                ),
            )
          is SdkAnrEvent ->
            AnrEvent(
              timestamp = event.timestamp,
              event =
                AnrData(
                  pid = event.pid,
                  processName = event.processName,
                  importance = event.importance,
                  trace = event.trace,
                  reason = event.reason,
                  packageName = event.applicationId ?: "unknown",
                  appVersion = event.appVersion,
                  deviceInfo =
                    DeviceInfo(
                      model = event.deviceInfo?.model ?: "unknown",
                      manufacturer = event.deviceInfo?.manufacturer ?: "unknown",
                      osVersion = event.deviceInfo?.osVersion ?: "unknown",
                      sdkInt = event.deviceInfo?.sdkInt ?: 0,
                    ),
                ),
            )
          // Existing event types handled by their own receivers — skip here
          is SdkNavigationEvent,
          is SdkHandledExceptionEvent,
          is SdkCrashEvent,
          is SdkNotificationActionEvent,
          is SdkRecompositionSnapshotEvent,
          is SdkEventBatch -> null
        }

      response?.let { webSocketServer.broadcast(it, mode, waitForClient) }
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting SDK event", e)
    }
  }

  /** Get permission state and optionally request missing permissions. */
  private fun handleGetPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(
      TAG,
      "handleGetPermission (requestId: $requestId, permission: $permission, requestPermission: $requestPermission)",
    )

    asyncActionRunner.launch(requestId, "get_permission") {
      val result = permissionManager.getPermissionState(permission, requestPermission ?: true)
      val totalTime = System.currentTimeMillis() - startTime
      broadcastPermissionResult(requestId, result, totalTime)
    }
  }

  /**
   * Get the current accessibility focus element. Returns the element that currently has
   * accessibility focus (TalkBack cursor position).
   */
  private fun handleGetCurrentFocus(requestId: String?) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "handleGetCurrentFocus (requestId: $requestId)")
    perfProvider.serial("getCurrentFocus")

    try {
      perfProvider.startOperation("findFocus")
      val focusedNode = findNodeInDisplayWindows {
        it.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
      }
      perfProvider.endOperation("findFocus")

      if (focusedNode == null) {
        perfProvider.end()
        val totalTime = System.currentTimeMillis() - startTime
        Log.d(TAG, "No accessibility focus found")
        launchRequestScope(requestId) { broadcastCurrentFocusResult(requestId, null, totalTime) }
        return
      }

      perfProvider.startOperation("extractFocusInfo")
      // Extract focus element information
      val focusedElement = viewHierarchyExtractor.extractFocusedElementInfo(focusedNode)
      focusedNode.recycle()
      perfProvider.endOperation("extractFocusInfo")
      perfProvider.end()

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "Current focus extracted in ${totalTime}ms")

      launchRequestScope(requestId) {
        broadcastCurrentFocusResult(requestId, focusedElement, totalTime)
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error getting current focus", e)
      launchRequestScope(requestId) {
        broadcastCurrentFocusError(requestId, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Get the traversal order of focusable elements. Returns an ordered list of all
   * accessibility-focusable elements in TalkBack traversal order.
   */
  private fun handleGetTraversalOrder(requestId: String?) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "handleGetTraversalOrder (requestId: $requestId)")
    perfProvider.serial("getTraversalOrder")

    try {
      perfProvider.startOperation("extractTraversalOrder")
      val allWindows = windows
      val rootNode = rootInActiveWindow
      val screenDimensions = getScreenDimensions()

      if (allWindows.isNullOrEmpty() && rootNode == null) {
        perfProvider.endOperation("extractTraversalOrder")
        perfProvider.end()
        val totalTime = System.currentTimeMillis() - startTime
        Log.w(TAG, "No windows or root node available for traversal order extraction")
        launchRequestScope(requestId) {
          broadcastTraversalOrderError(requestId, "No windows available", totalTime)
        }
        return
      }

      // Extract traversal order using ViewHierarchyExtractor
      val traversalResult =
        if (!allWindows.isNullOrEmpty()) {
          viewHierarchyExtractor.extractTraversalOrderFromAllWindows(
            allWindows,
            rootNode,
            screenDimensions,
          )
        } else {
          viewHierarchyExtractor.extractTraversalOrderFromActiveWindow(rootNode, screenDimensions)
        }
      perfProvider.endOperation("extractTraversalOrder")
      perfProvider.end()

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(
        TAG,
        "Traversal order extracted: ${traversalResult.elements.size} elements in ${totalTime}ms",
      )

      launchRequestScope(requestId) {
        broadcastTraversalOrderResult(requestId, traversalResult, totalTime)
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error getting traversal order", e)
      launchRequestScope(requestId) {
        broadcastTraversalOrderError(requestId, e.message, errorTime - startTime)
      }
    }
  }

  private fun handleAddHighlight(
    requestId: String?,
    highlightId: String?,
    shape: HighlightShape?,
  ) {
    launchRequestScope(requestId) {
      if (!::overlayDrawer.isInitialized) {
        broadcastHighlightResponse(requestId, false, "Overlay drawer not initialized")
        return@launchRequestScope
      }

      val result =
        try {
          withContext(Dispatchers.Main) { overlayDrawer.addHighlight(highlightId, shape) }
        } catch (e: CancellationException) {
          // Let cooperative cancellation unwind cleanly rather than reporting a failed highlight
          // result (#3130).
          throw e
        } catch (e: Exception) {
          HighlightOperationResult(false, e.message ?: "Failed to add highlight")
        }

      broadcastHighlightResponse(requestId, result.success, result.error)
    }
  }

  private suspend fun broadcastHighlightResponse(
    requestId: String?,
    success: Boolean,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping highlight response broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "highlight_response") {
      val errorJson = jsonCompact.encodeToString<String?>(error)
      webSocketServer.broadcastWithPerf { perfTiming ->
        buildString {
          append("""{"type":"highlight_response","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","success":$success""")
          append(""","error":$errorJson""")
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
      }
      Log.d(
        TAG,
        "Broadcasted highlight response to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  /** Broadcast current focus result to WebSocket clients */
  private suspend fun broadcastCurrentFocusResult(
    requestId: String?,
    focusedElement: UIElementInfo?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping current focus result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "current_focus_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        buildString {
          append("""{"type":"current_focus_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","totalTimeMs":$totalTimeMs""")
          if (focusedElement != null) {
            val elementJson =
              jsonCompact.encodeToString(serializer<UIElementInfo>(), focusedElement)
            append(""","focusedElement":$elementJson""")
          } else {
            append(""","focusedElement":null""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
      }
      Log.d(
        TAG,
        "Broadcasted current focus result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  /** Broadcast current focus error to WebSocket clients */
  private suspend fun broadcastCurrentFocusError(
    requestId: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping current focus error broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "current_focus_error") {
      webSocketServer.broadcast(currentFocusErrorFrame(requestId, error, totalTimeMs))
      Log.d(
        TAG,
        "Broadcasted current focus error to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  /** Broadcast traversal order result to WebSocket clients */
  private suspend fun broadcastTraversalOrderResult(
    requestId: String?,
    traversalResult: dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping traversal order result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "traversal_order_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        buildString {
          append("""{"type":"traversal_order_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","totalTimeMs":$totalTimeMs""")
          val resultJson =
            jsonCompact.encodeToString(
              serializer<dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult>(),
              traversalResult,
            )
          append(""","result":$resultJson""")
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
      }
      Log.d(
        TAG,
        "Broadcasted traversal order result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  /** Broadcast traversal order error to WebSocket clients */
  private suspend fun broadcastTraversalOrderError(
    requestId: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping traversal order error broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "traversal_order_error") {
      webSocketServer.broadcast(traversalOrderErrorFrame(requestId, error, totalTimeMs))
      Log.d(
        TAG,
        "Broadcasted traversal order error to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  // ================= Storage Inspection Methods =================

  private fun handleListPreferenceFiles(requestId: String?, packageName: String) {
    Log.d(TAG, "handleListPreferenceFiles: requestId=$requestId, packageName=$packageName")
    asyncActionRunner.launch(requestId, "list_preference_files") {
      Log.d(TAG, "handleListPreferenceFiles: coroutine started, calling listPreferenceFiles")
      val result = storageSubscriptionManager.listPreferenceFiles(packageName)
      Log.d(TAG, "handleListPreferenceFiles: result=$result")
      result.fold(
        onSuccess = { files ->
          Log.d(TAG, "handleListPreferenceFiles: success, files count=${files.size}")
          broadcastPreferenceFilesResult(requestId, packageName, files, null)
        },
        onFailure = { error ->
          Log.e(TAG, "handleListPreferenceFiles: failure, error=${error.message}", error)
          broadcastPreferenceFilesResult(requestId, packageName, null, error.message)
        },
      )
    }
  }

  private fun handleGetPreferences(requestId: String?, packageName: String, fileName: String) {
    asyncActionRunner.launch(requestId, "get_preferences") {
      val result = storageSubscriptionManager.getPreferences(packageName, fileName)
      result.fold(
        onSuccess = { entries ->
          broadcastPreferencesResult(requestId, packageName, fileName, entries, null)
        },
        onFailure = { error ->
          broadcastPreferencesResult(requestId, packageName, fileName, null, error.message)
        },
      )
    }
  }

  private fun handleListDataStores(requestId: String?, packageName: String, adapterName: String) {
    asyncActionRunner.launch(requestId, "list_data_stores") {
      val result = storageSubscriptionManager.listDataStores(packageName, adapterName)
      result.fold(
        // DataStore descriptors reuse the SharedPreferences `preference_files` result envelope
        // (StorageResponse.FileList); the awaiting TS client disambiguates by requestId.
        onSuccess = { files ->
          broadcastPreferenceFilesResult(requestId, packageName, files, null)
        },
        onFailure = { error ->
          broadcastPreferenceFilesResult(requestId, packageName, null, error.message)
        },
      )
    }
  }

  private fun handleGetDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) {
    asyncActionRunner.launch(requestId, "get_data_store") {
      val result = storageSubscriptionManager.getDataStore(packageName, adapterName, storeName)
      result.fold(
        // Reuses the SharedPreferences `preferences` result envelope; storeName maps to fileName.
        onSuccess = { entries ->
          broadcastPreferencesResult(requestId, packageName, storeName, entries, null)
        },
        onFailure = { error ->
          broadcastPreferencesResult(requestId, packageName, storeName, null, error.message)
        },
      )
    }
  }

  private fun handleSubscribeStorage(requestId: String?, packageName: String, fileName: String) {
    asyncActionRunner.launch(requestId, "subscribe_storage") {
      val result = storageSubscriptionManager.subscribe(packageName, fileName)
      result.fold(
        onSuccess = { subscription ->
          broadcastSubscribeStorageResult(
            requestId,
            packageName,
            fileName,
            subscription.subscriptionId,
            null,
          )
        },
        onFailure = { error ->
          broadcastSubscribeStorageResult(requestId, packageName, fileName, null, error.message)
        },
      )
    }
  }

  private fun handleUnsubscribeStorage(requestId: String?, packageName: String, fileName: String) {
    asyncActionRunner.launch(requestId, "unsubscribe_storage") {
      val success = storageSubscriptionManager.unsubscribe(packageName, fileName)
      broadcastUnsubscribeStorageResult(requestId, packageName, fileName, success)
    }
  }

  private fun handleGetPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {
    asyncActionRunner.launch(requestId, "get_preference") {
      val result = storageSubscriptionManager.getPreference(packageName, fileName, key)
      result.fold(
        onSuccess = { entry ->
          broadcastGetPreferenceResult(requestId, packageName, fileName, key, entry, null)
        },
        onFailure = { error ->
          broadcastGetPreferenceResult(requestId, packageName, fileName, key, null, error.message)
        },
      )
    }
  }

  private fun handleSetPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) {
    asyncActionRunner.launch(requestId, "set_preference") {
      val result = storageSubscriptionManager.setPreference(packageName, fileName, key, value, type)
      result.fold(
        onSuccess = { broadcastSetPreferenceResult(requestId, packageName, fileName, key, null) },
        onFailure = { error ->
          broadcastSetPreferenceResult(requestId, packageName, fileName, key, error.message)
        },
      )
    }
  }

  private fun handleRemovePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {
    asyncActionRunner.launch(requestId, "remove_preference") {
      val result = storageSubscriptionManager.removePreference(packageName, fileName, key)
      result.fold(
        onSuccess = {
          broadcastRemovePreferenceResult(requestId, packageName, fileName, key, null)
        },
        onFailure = { error ->
          broadcastRemovePreferenceResult(requestId, packageName, fileName, key, error.message)
        },
      )
    }
  }

  private fun handleClearPreferences(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) {
    asyncActionRunner.launch(requestId, "clear_preferences") {
      val result = storageSubscriptionManager.clearPreferences(packageName, fileName)
      result.fold(
        onSuccess = { broadcastClearPreferencesResult(requestId, packageName, fileName, null) },
        onFailure = { error ->
          broadcastClearPreferencesResult(requestId, packageName, fileName, error.message)
        },
      )
    }
  }

  private suspend fun broadcastPreferenceFilesResult(
    requestId: String?,
    packageName: String,
    files: List<dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceFileInfo>?,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping preference files broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "preference_files") {
      val message = buildString {
        append("""{"type":"preference_files","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        if (files != null) {
          append(""","success":true,"files":${jsonCompact.encodeToString(files)}""")
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}""",
          )
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(TAG, "Broadcasted preference files to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  private suspend fun broadcastPreferencesResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    entries: List<dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry>?,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping preferences broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "preferences") {
      val message = buildString {
        append("""{"type":"preferences","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        if (entries != null) {
          append(""","success":true,"entries":${jsonCompact.encodeToString(entries)}""")
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}""",
          )
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(TAG, "Broadcasted preferences to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  private suspend fun broadcastSubscribeStorageResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    subscriptionId: String?,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping subscribe storage broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "subscribe_storage_result") {
      val message = buildString {
        append("""{"type":"subscribe_storage_result","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        if (subscriptionId != null) {
          append(
            ""","success":true,"subscriptionId":${jsonCompact.encodeToString(subscriptionId)}""",
          )
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}""",
          )
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted subscribe storage result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastUnsubscribeStorageResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    success: Boolean,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping unsubscribe storage broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "unsubscribe_storage_result") {
      val message = buildString {
        append("""{"type":"unsubscribe_storage_result","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","success":$success""")
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted unsubscribe storage result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastGetPreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    entry: dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry?,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping get preference broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "get_preference_result") {
      val message = buildString {
        append("""{"type":"get_preference_result","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","key":${jsonCompact.encodeToString(key)}""")
        if (error != null) {
          append(""","success":false,"found":false,"error":${jsonCompact.encodeToString(error)}""")
        } else if (entry != null) {
          append(""","success":true,"found":true""")
          if (entry.value != null) {
            append(""","value":${jsonCompact.encodeToString(entry.value)}""")
          } else {
            append(""","value":null""")
          }
          append(""","valueType":${jsonCompact.encodeToString(entry.type)}""")
        } else {
          append(""","success":true,"found":false""")
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted get preference result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastSetPreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping set preference broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "set_preference_result") {
      val message = buildString {
        append("""{"type":"set_preference_result","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","key":${jsonCompact.encodeToString(key)}""")
        if (error != null) {
          append(""","success":false,"error":${jsonCompact.encodeToString(error)}""")
        } else {
          append(""","success":true""")
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted set preference result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastRemovePreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping remove preference broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "remove_preference_result") {
      val message = buildString {
        append("""{"type":"remove_preference_result","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","key":${jsonCompact.encodeToString(key)}""")
        if (error != null) {
          append(""","success":false,"error":${jsonCompact.encodeToString(error)}""")
        } else {
          append(""","success":true""")
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted remove preference result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastClearPreferencesResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    error: String?,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping clear preferences broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "clear_preferences_result") {
      val message = buildString {
        append("""{"type":"clear_preferences_result","timestamp":${System.currentTimeMillis()}""")
        if (requestId != null) {
          append(""","requestId":"$requestId"""")
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        if (error != null) {
          append(""","success":false,"error":${jsonCompact.encodeToString(error)}""")
        } else {
          append(""","success":true""")
        }
        append("}")
      }
      webSocketServer.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted clear preferences result to ${webSocketServer.getConnectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastStorageChange(
    event: dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceChangeEvent,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping storage change broadcast")
      return
    }

    try {
      // Build the wire payload via the extracted, unit-tested encoder. It emits the
      // prior value so the TS telemetry ingest can skip its per-insert previous-value
      // lookup (#3000), quoting it by its OWN type so a removed/type-changed STRING
      // stays valid JSON. An absent prior value is emitted as JSON null.
      val message =
        dev.jasonpearson.automobile.ctrlproxy.storage.buildStorageChangedMessage(
          event,
          System.currentTimeMillis(),
          jsonCompact,
        )
      webSocketServer.broadcast(message)
      Log.d(TAG, "Broadcasted storage change to ${webSocketServer.getConnectionCount()} clients")
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting storage change", e)
    }
  }
}

internal data class ImeFocusCandidate(
  val isEditable: Boolean,
  val isFocusable: Boolean,
  val isVisibleToUser: Boolean,
  val isEnabled: Boolean,
)

internal fun isImeFocusCandidate(row: ImeFocusCandidate): Boolean =
  row.isEditable && row.isFocusable && row.isVisibleToUser && row.isEnabled

/** `isShowingHintText` is API 26+; older platforms cannot report it, so treat the text as real. */
private fun AccessibilityNodeInfo.isShowingHintTextCompat(): Boolean =
  Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isShowingHintText
