package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
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
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.SystemTimeProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
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
import dev.jasonpearson.automobile.protocol.LifecycleEventData
import dev.jasonpearson.automobile.protocol.LifecycleEventResponse
import dev.jasonpearson.automobile.protocol.NavigationEventData
import dev.jasonpearson.automobile.protocol.NavigationEventResponse
import dev.jasonpearson.automobile.protocol.NetworkEventData
import dev.jasonpearson.automobile.protocol.NetworkEventResponse
import dev.jasonpearson.automobile.protocol.NodeSelector
import dev.jasonpearson.automobile.protocol.ScreenshotResult as ProtocolScreenshotResult
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SdkHandledExceptionEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.protocol.SdkNotificationActionEvent
import dev.jasonpearson.automobile.protocol.SdkRecompositionSnapshotEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameData
import dev.jasonpearson.automobile.protocol.WebSocketFrameResponse
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.math.max
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

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

internal fun nodeActionFailure(action: String, availableActionIds: Collection<Int>?): String? {
  val actionId = nodeActionId(action) ?: return "Unsupported accessibility action: $action"
  if (availableActionIds != null && actionId !in availableActionIds) {
    return "Accessibility action is unavailable: $action"
  }
  return null
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
 * Main AutoMobile Accessibility Service that provides view hierarchy extraction capabilities for
 * automated testing and UI interaction.
 */
class CtrlProxy : AccessibilityService(), CtrlProxyActions {

  companion object {
    private const val TAG = "CtrlProxy"

    // File name for app-scoped storage
    private const val HIERARCHY_FILE_NAME = "latest_hierarchy.json"
    private const val DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250L

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
   * Launches request-correlated raw work with [RequestIdContext] attached so [serviceScopeGuard]
   * can emit a correlated error frame if the launch throws before a guarded result helper runs.
   */
  private fun launchRequestScope(
    requestId: String?,
    block: suspend CoroutineScope.() -> Unit,
  ): Job = serviceScope.launch(context = RequestIdContext(requestId), block = block)

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
  private val viewHierarchyExtractor = ViewHierarchyExtractor(recompositionStore)
  private val json = Json {
    prettyPrint = true
    encodeDefaults = true
  }
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
      }
    )

  private val perfProvider = PerfProvider.instance
  private val timeProvider: TimeProvider = SystemTimeProvider()
  private lateinit var webSocketServer: WebSocketServer
  private lateinit var hierarchyDebouncer: HierarchyDebouncer
  private lateinit var rotationProvenance: RotationProvenanceTracker
  private var hierarchyBroadcastThrottler: BroadcastThrottler? = null
  private val navigationEventAccumulator = NavigationEventAccumulator()
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
  private val extractedHierarchyFrameContexts =
    Collections.synchronizedMap(IdentityHashMap<ViewHierarchy, String>())

  @Volatile private var isRecording: Boolean = false

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

  private data class ScreenshotCapturePayload(
    val base64Image: String,
    val rotation: Int?,
    val captureDurationMs: Long,
    val encodeDurationMs: Long,
    val byteLength: Int,
    val base64Length: Int,
  )

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
              navigationEventAccumulator.addEvent(
                event.destination,
                event.source.name,
                event.arguments ?: emptyMap(),
                event.metadata ?: emptyMap(),
                event.applicationId,
              )
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
          navigationEventAccumulator.addEvent(
            destination,
            source,
            arguments,
            metadata,
            applicationId,
          )
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
        val userId = if (uid >= 0) uid else 0
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
          broadcastPackageEvent(eventAction, packageName, userId, isSystem, removedForAllUsers)
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

  private val anrReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != AutoMobileAnr.ACTION_ANR) {
          return
        }

        try {
          val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
          if (eventJson != null) {
            val event = SdkEventSerializer.anrEventFromJson(eventJson)
            if (event != null) {
              Log.d(TAG, "Received ANR: pid=${event.pid} from ${event.applicationId}")

              serviceScope.launch {
                broadcastAnrEvent(
                  timestamp = event.timestamp,
                  pid = event.pid,
                  processName = event.processName,
                  importance = event.importance,
                  trace = event.trace,
                  reason = event.reason,
                  packageName = event.applicationId ?: "unknown",
                  appVersion = event.appVersion,
                  deviceModel = event.deviceInfo?.model ?: "unknown",
                  deviceManufacturer = event.deviceInfo?.manufacturer ?: "unknown",
                  osVersion = event.deviceInfo?.osVersion ?: "unknown",
                  sdkInt = event.deviceInfo?.sdkInt ?: 0,
                )
              }
            }
          }
        } catch (e: Exception) {
          Log.e(TAG, "Error handling ANR broadcast", e)
        }
      }
    }

  private val eventBatchReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != SdkEventSerializer.ACTION_SDK_EVENT_BATCH) {
          return
        }

        try {
          val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON) ?: return
          val batch = SdkEventSerializer.eventBatchFromJson(eventJson) ?: return

          Log.d(TAG, "Received event batch with ${batch.events.size} events")

          serviceScope.launch {
            for (event in batch.events) {
              broadcastSdkEvent(event)
            }
          }
        } catch (e: Exception) {
          Log.e(TAG, "Error handling event batch broadcast", e)
        }
      }
    }

  override fun onServiceConnected() {
    super.onServiceConnected()
    Log.d(TAG, "onServiceConnected")

    // Ensure we receive ALL accessibility event types and include not-important views
    // (XML config may be cached). flagIncludeNotImportantViews exposes interactive nodes
    // (e.g. long-clickable ImageViews) that Android otherwise filters as decorative.
    serviceInfo = serviceInfo?.apply {
      eventTypes = AccessibilityEvent.TYPES_ALL_MASK
      flags =
        flags or
          AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
          AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
          AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    }

    try {
      rotationProvenance =
        RotationProvenanceTracker(
          DisplayRotationChangeSignal(
            getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager
          )
        )
      overlayDrawer = OverlayDrawer(screenDimensionsProvider = { getScreenDimensions() })
      overlayManager =
        OverlayManager(this, viewFactory = { HighlightOverlayView(it, overlayDrawer) })
      overlayDrawer.attachOverlayManager(overlayManager)

      // Register broadcast receiver for commands
      val commandFilter = IntentFilter().apply { addAction(ACTION_EXTRACT_HIERARCHY) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(commandReceiver, commandFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(commandReceiver, commandFilter)
      }

      // Register broadcast receiver for navigation events
      val navigationFilter =
        IntentFilter().apply { addAction(AutoMobileSDK.ACTION_NAVIGATION_EVENT) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(navigationEventReceiver, navigationFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(navigationEventReceiver, navigationFilter)
      }
      Log.d(TAG, "Navigation event receiver registered")

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

      // Register broadcast receiver for SDK event batches
      val eventBatchFilter =
        IntentFilter().apply { addAction(SdkEventSerializer.ACTION_SDK_EVENT_BATCH) }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(eventBatchReceiver, eventBatchFilter, RECEIVER_EXPORTED)
      } else {
        @SuppressLint("UnspecifiedRegisterReceiverFlag")
        registerReceiver(eventBatchReceiver, eventBatchFilter)
      }
      Log.d(TAG, "Event batch receiver registered")

      val screenStateFilter =
        IntentFilter().apply {
          addAction(Intent.ACTION_SCREEN_ON)
          addAction(Intent.ACTION_SCREEN_OFF)
        }
      registerReceiver(screenStateReceiver, screenStateFilter)
      Log.d(TAG, "Screen state receiver registered")

      // Initialize the navigation event accumulator
      navigationEventAccumulator.initialize()
      Log.d(TAG, "Navigation event accumulator initialized")

      // Subscribe to navigation events and broadcast them
      navigationEventJob =
        navigationEventAccumulator.latestEvent
          .onEach { event ->
            if (event != null) {
              Log.d(TAG, "Navigation event: ${event.destination} at ${event.timestamp}")
              broadcastNavigationEvent(event)
            }
          }
          .launchIn(serviceScope)

      // Initialize the smart hierarchy debouncer with structural hash comparison
      hierarchyDebouncer =
        HierarchyDebouncer(
          scope = serviceScope,
          timeProvider = timeProvider,
          perfProvider = perfProvider,
          quickDebounceMs = 5L,
          animationSkipWindowMs = 100L,
          extractHierarchy = { disableAllFiltering ->
            extractHierarchyDirect(disableAllFiltering)
          },
        )

      // Subscribe to hierarchy updates from the debouncer.
      // Throttle event-driven broadcasts to avoid saturating the ADB port-forwarding
      // pipe. The extraction itself stays fast (request_hierarchy uses extractNowBlocking
      // and bypasses this flow entirely), but unsolicited pushes are rate-limited so
      // on-demand requests have a clear pipe to travel through.
      val broadcastThrottler =
        BroadcastThrottler(timeProvider, minIntervalMs = DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS)
      hierarchyBroadcastThrottler = broadcastThrottler

      hierarchyFlowJob =
        hierarchyDebouncer.hierarchyFlow
          .onEach { result ->
            when (result) {
              is HierarchyResult.Changed -> {
                Log.d(
                  TAG,
                  "Hierarchy changed (hash=${result.hash}, extraction=${result.extractionTimeMs}ms)",
                )
                writeHierarchyToFile(result.hierarchy)
                if (broadcastThrottler.shouldBroadcast()) {
                  broadcastHierarchyUpdate(result.hierarchy)
                } else {
                  extractedHierarchyFrameContexts.remove(result.hierarchy)
                  Log.d(
                    TAG,
                    "Throttled event-driven broadcast (${broadcastThrottler.timeSinceLastBroadcastMs()}ms since last)",
                  )
                }
              }
              is HierarchyResult.Unchanged -> {
                Log.d(
                  TAG,
                  "Hierarchy unchanged (animation mode, skipped=${result.skippedEventCount})",
                )
                if (broadcastThrottler.shouldBroadcast()) {
                  broadcastHierarchyUpdate(result.hierarchy)
                } else {
                  extractedHierarchyFrameContexts.remove(result.hierarchy)
                  Log.d(
                    TAG,
                    "Throttled event-driven broadcast (${broadcastThrottler.timeSinceLastBroadcastMs()}ms since last)",
                  )
                }
              }
              is HierarchyResult.Error -> {
                Log.w(TAG, "Hierarchy extraction error: ${result.message}")
              }
            }
          }
          .launchIn(serviceScope)

      // Initialize storage subscription manager for SharedPreferences inspection
      storageSubscriptionManager = StorageSubscriptionManager(this)
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

      // Start the WebSocket server. This service implements CtrlProxyActions, so inbound requests
      // are dispatched straight to its perform*/handle* methods via CtrlProxyMessageHandler.
      webSocketServer =
        WebSocketServer(
          port = 8765,
          scope = serviceScope,
          messageHandler =
            CtrlProxyMessageHandler(
              actions = this,
              log = { message -> Log.w(TAG, message) },
            ),
        )
      webSocketServer.start()
      Log.d(TAG, "WebSocket server started on port 8765")

      // Start logcat reader for automatic log capture
      logcatReader = LogcatReader { response ->
        if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
          serviceScope.launch { webSocketServer.broadcast(response) }
        }
      }
      logcatReader?.start()
      Log.d(TAG, "Logcat reader started")

      Log.d(TAG, "AutoMobile Accessibility Service connected successfully")
    } catch (e: Exception) {
      Log.e(TAG, "Error during service connection", e)
      // Service will continue running even if some initialization fails
    }
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

    // Stop logcat reader
    logcatReader?.stop()
    logcatReader = null

    if (::overlayDrawer.isInitialized) {
      overlayDrawer.destroy()
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
      webSocketServer.stop()
      Log.d(TAG, "WebSocket server stopped")
    }

    Log.d(TAG, "AutoMobile Accessibility Service destroyed")
    serviceScope.cancel()
  }

  // ===========================================================================
  // CtrlProxyActions — inbound WebSocket commands dispatched by CtrlProxyMessageHandler.
  // Each method delegates to the corresponding perform*/handle* implementation below.
  // ===========================================================================

  override fun requestHierarchy(disableAllFiltering: Boolean) =
    extractHierarchyNow(disableAllFiltering)

  override fun requestHierarchyIfStale(sinceTimestamp: Long) =
    hierarchyDebouncer.extractIfStale(sinceTimestamp)

  override fun setHierarchyInterval(intervalMs: Long?) {
    val resolvedIntervalMs = intervalMs ?: DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS
    hierarchyBroadcastThrottler?.setMinIntervalMs(resolvedIntervalMs)
    Log.d(TAG, "Hierarchy broadcast interval set to ${resolvedIntervalMs}ms")
  }

  override fun requestScreenshot(requestId: String?) = broadcastScreenshot(requestId)

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
  ) = performSwipe(requestId, x1, y1, x2, y2, duration)

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    frameContext: String?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.SWIPE)) return
    performSwipe(requestId, x1, y1, x2, y2, duration, frameContext)
  }

  override fun requestTapCoordinates(requestId: String?, x: Double, y: Double, duration: Long) =
    performTapCoordinates(requestId, x, y, duration)

  override fun requestTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    duration: Long,
    frameContext: String?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.TAP)) return
    performTapCoordinates(requestId, x, y, duration, frameContext)
  }

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
  ) = performDrag(requestId, x1, y1, x2, y2, pressDurationMs, dragDurationMs, holdDurationMs)

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
    )
  }

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
    launchRequestScope(requestId) {
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
            )
          )
      }
    }
    return true
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

  override fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
  ) = performSetText(requestId, text, resourceId, dismissKeyboard)

  override fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
    frameContext: String?,
  ) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.SET_TEXT)) return
    performSetText(requestId, text, resourceId, dismissKeyboard)
  }

  override fun requestImeAction(requestId: String?, action: String) =
    performImeAction(requestId, action)

  override fun requestImeAction(requestId: String?, action: String, frameContext: String?) {
    if (rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.IME_ACTION)) return
    performImeAction(requestId, action)
  }

  override fun requestSelectAll(requestId: String?) = performSelectAll(requestId)

  override fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
  ) = performNodeAction(requestId, action, resourceId, selector)

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
        )
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

  override fun setNetworkMockRules(rulesJson: String) = broadcastNetworkMockRules(rulesJson)

  override fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
  ) = broadcastNetworkErrorSimulation(enabled, errorType, limit, expiresAtEpochMs)

  override fun getCurrentFocus(requestId: String?) = handleGetCurrentFocus(requestId)

  override fun getTraversalOrder(requestId: String?) = handleGetTraversalOrder(requestId)

  override fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?) =
    handleAddHighlight(requestId, highlightId, shape)

  override fun listPreferenceFiles(requestId: String?, packageName: String) =
    handleListPreferenceFiles(requestId, packageName)

  override fun getPreferences(requestId: String?, packageName: String, fileName: String) =
    handleGetPreferences(requestId, packageName, fileName)

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
    isRecording = true
    Log.d(TAG, "Recording started")
  }

  override fun stopRecording() {
    isRecording = false
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

  private fun broadcastNetworkMockRules(rulesJson: String) {
    try {
      val intent =
        Intent(NetworkMockRuleStore.ACTION_NETWORK_MOCK_RULES).apply {
          putExtra(NetworkMockRuleStore.EXTRA_RULES_JSON, rulesJson)
        }
      sendBroadcast(intent)
      Log.d(TAG, "Broadcast network mock rules")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to broadcast network mock rules", e)
    }
  }

  private fun broadcastNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
  ) {
    try {
      val intent =
        Intent(NetworkMockRuleStore.ACTION_NETWORK_ERROR_SIMULATION).apply {
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

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event == null) {
      Log.w(TAG, "onAccessibilityEvent: no event")
      return
    }

    try {
      // Log accessibility events for debugging
      if (event.packageName?.toString()?.contains("playground") == true) {
        Log.d(
          TAG,
          "A11Y event type=${event.eventType} class=${event.className} pkg=${event.packageName} text=${event.text} contentChange=${event.contentChangeTypes} action=${event.action}",
        )
      }

      if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
        lastWindowClassName = event.className?.toString()
      }

      // Broadcast interaction events for telemetry tracking.
      // Also track TYPE_VIEW_ACCESSIBILITY_FOCUSED which fires when Compose
      // moves accessibility focus after a tap (more reliable than TYPE_VIEW_CLICKED
      // for Compose UIs). Debounce at 200ms to avoid duplicate events.
      when (event.eventType) {
        AccessibilityEvent.TYPE_VIEW_CLICKED -> recordInteractionEvent(event, "tap")
        AccessibilityEvent.TYPE_VIEW_LONG_CLICKED -> recordInteractionEvent(event, "longPress")
        // Compose doesn't fire TYPE_VIEW_CLICKED — detect taps via content changes
        // on clickable elements. CONTENT_CHANGE_TYPE_STATE_DESCRIPTION (64) fires
        // when Compose state changes (e.g., button click updates counter).
        // CONTENT_CHANGE_TYPE_CONTENT_DESCRIPTION (4) fires on many Compose interactions.
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val ct = event.contentChangeTypes
            // State description change = likely user interaction (Compose state update)
            if (ct and AccessibilityEvent.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION != 0) {
              recordDebouncedInteraction(event, "stateChange")
            }
          }
        }
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> recordInteractionEvent(event, "navigate")
        AccessibilityEvent.TYPE_VIEW_SELECTED -> recordInteractionEvent(event, "select")
        AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> {
          val now = System.currentTimeMillis()
          if (now - lastInputTextBroadcastMs >= inputTextDebounceMs) {
            lastInputTextBroadcastMs = now
            recordInteractionEvent(event, "inputText")
          }
        }
        AccessibilityEvent.TYPE_VIEW_SCROLLED -> {
          frameContext.incrementAndGet()
          recordDebouncedScroll(event)
        }
      }

      // Delegate to the smart debouncer for content/window changes
      // The debouncer uses structural hash comparison to detect animation vs real changes
      if (
        event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
          event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
          event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED ||
          event.eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
      ) {
        frameContext.incrementAndGet()
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
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pendingScrollDeltaX += event.scrollDeltaX
      pendingScrollDeltaY += event.scrollDeltaY
    }
    // Store package name — don't hold the event reference (Android recycles it)
    pendingScrollPackageName = event.packageName?.toString()

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
      }
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
            buildJsonObject {
              put("action", action)
              put("packageName", packageName)
              put("userId", userId)
              if (isSystem != null) {
                put("isSystem", isSystem)
              }
              if (removedForAllUsers) {
                put("removedForAllUsers", true)
              }
            },
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
  private fun getScreenDimensions(): ScreenDimensions? {
    return try {
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
              android.view.WindowInsets.Type.systemBars()
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
  private fun getRotationOrNull(): Int? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Use DisplayManager for AccessibilityService context (can't use context.display)
        val displayManager =
          getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager
        displayManager?.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.rotation
      } else {
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        windowManager?.defaultDisplay?.rotation
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get rotation", e)
      null
    }
  }

  private fun toSystemInsetsInfo(insets: android.graphics.Insets): SystemInsetsInfo =
    SystemInsetsInfo(
      top = insets.top,
      bottom = insets.bottom,
      left = insets.left,
      right = insets.right,
    )

  /** Get typed current-window inset metadata for coordinate and layout inspection. */
  @Suppress("DEPRECATION")
  private fun getObservationInsets(): ObservationInsetsInfo {
    return try {
      val windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
      if (windowManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val metrics = windowManager.currentWindowMetrics
        val windowInsets = metrics.windowInsets
        ObservationInsetsInfo(
          systemBars =
            SystemBarsInsetsInfo(
              visible =
                toSystemInsetsInfo(
                  windowInsets.getInsets(android.view.WindowInsets.Type.systemBars())
                ),
              stable =
                toSystemInsetsInfo(
                  windowInsets.getInsetsIgnoringVisibility(
                    android.view.WindowInsets.Type.systemBars()
                  )
                ),
            ),
          displayCutout =
            toSystemInsetsInfo(
              windowInsets.getInsetsIgnoringVisibility(
                android.view.WindowInsets.Type.displayCutout()
              )
            ),
          systemGestures =
            toSystemInsetsInfo(
              windowInsets.getInsets(android.view.WindowInsets.Type.systemGestures())
            ),
          mandatorySystemGestures =
            toSystemInsetsInfo(
              windowInsets.getInsets(android.view.WindowInsets.Type.mandatorySystemGestures())
            ),
          tappableElement =
            toSystemInsetsInfo(
              windowInsets.getInsets(android.view.WindowInsets.Type.tappableElement())
            ),
          systemChrome =
            SystemChromeInfo.fromAndroidBars(
              statusBarVisible =
                windowInsets.isVisible(android.view.WindowInsets.Type.statusBars()),
              navigationBarVisible =
                windowInsets.isVisible(android.view.WindowInsets.Type.navigationBars()),
            ),
        )
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
        )
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get system insets", e)
      ObservationInsetsInfo(available = false, source = "unavailable", units = "unknown")
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
    val startTime = System.currentTimeMillis()
    val success = executeGlobalAction(action)
    val totalTimeMs = System.currentTimeMillis() - startTime
    asyncActionRunner.launch(requestId, "request_global_action") {
      webSocketServer?.broadcast(
        dev.jasonpearson.automobile.protocol.GlobalActionResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = success,
          action = action,
          totalTimeMs = totalTimeMs,
          error = if (!success) "Unsupported or failed action: $action" else null,
        )
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
      webSocketServer?.broadcast(
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
        )
      )
    }
  }

  /**
   * Direct hierarchy extraction without debouncing. Used by the HierarchyDebouncer. Extracts from
   * all visible windows to capture popups, toolbars, etc.
   */
  private fun extractHierarchyDirect(disableAllFiltering: Boolean = false): ViewHierarchy? {
    val contextAtExtractionStart = currentFrameContext()
    // Bracket every input acquisition and the extraction itself. If rotation changes anywhere in
    // that interval, hierarchy geometry cannot be proven to match a single display orientation.
    val rotationCapture = rotationProvenance.beginCapture()
    val rotationAtCaptureStart = getRotationOrNull()
    // Get all windows to capture popups, toolbars, and other floating windows
    val allWindows = windows
    val rootNode = rootInActiveWindow
    // Capture foreground info atomically with rootNode to avoid race conditions
    // where the app state changes between hierarchy extraction and getForegroundActivity()
    val capturedRootPackage = rootNode?.packageName?.toString()
    val capturedWindowClass = lastWindowClassName
    val screenDimensions = getScreenDimensions()
    val insets = getObservationInsets()

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
        )
      } else {
        viewHierarchyExtractor.extractFromActiveWindow(
          rootNode,
          null,
          screenDimensions,
          true,
          disableAllFiltering,
        )
      }

    val rotation =
      rotationProvenance.rotationIfUnchanged(
        rotationCapture,
        rotationAtCaptureStart,
        getRotationOrNull(),
      )

    // Add device metadata to the hierarchy (eliminates need for dumpsys calls on client)
    val wakefulness = getWakefulness()
    val foreground = getForegroundActivity(capturedRootPackage, capturedWindowClass)
    val density = getDensity()
    val enriched =
      hierarchy?.copy(
        screenWidth = screenDimensions?.width,
        screenHeight = screenDimensions?.height,
        rotation = rotation,
        systemInsets = legacySystemInsets(insets),
        insets = insets,
        wakefulness = wakefulness,
        foregroundActivity = foreground,
        density = density,
        sdkInt = Build.VERSION.SDK_INT,
        deviceModel = Build.MODEL,
        isEmulator = getIsEmulator(),
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
  private fun extractHierarchyNow(disableAllFiltering: Boolean = false) {
    Log.d(TAG, "extractHierarchyNow (disableAllFiltering: $disableAllFiltering)")
    val hierarchy =
      hierarchyDebouncer.extractNowBlocking(
        skipFlowEmit = true,
        disableAllFiltering = disableAllFiltering,
      )
    if (hierarchy != null) {
      writeHierarchyToFile(hierarchy)
      kotlinx.coroutines.runBlocking { broadcastHierarchyUpdate(hierarchy, sync = true) }
    }
  }

  /** Writes the hierarchy to a file for synchronous access */
  private fun writeHierarchyToFile(
    hierarchy: ViewHierarchy,
    filename: String = HIERARCHY_FILE_NAME,
  ) {
    try {
      val jsonString = json.encodeToString(hierarchy)
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
            writeHierarchyToFile(hierarchy, filename)

            // Broadcast to WebSocket clients
            broadcastHierarchyUpdate(hierarchy)

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
    val rotationCapture = rotationProvenance.beginCapture()
    val rotationAtCaptureStart = getRotationOrNull()
    val allWindows = windows
    val rootNode = rootInActiveWindow
    val screenDimensions = getScreenDimensions()

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
        )
      } else {
        viewHierarchyExtractor.extractFromActiveWindow(
          rootNode,
          textFilter,
          screenDimensions,
          true,
          disableAllFiltering,
        )
      }
    val rotation =
      rotationProvenance.rotationIfUnchanged(
        rotationCapture,
        rotationAtCaptureStart,
        getRotationOrNull(),
      )
    // The ADB EXTRACT_HIERARCHY route must carry the #4548 scale metadata too (this route does not
    // add the other device metadata, but the daemon retains scale metadata off any route).
    val hierarchyWithScaleMetadata =
      withScaleMetadata(hierarchy?.copy(rotation = rotation), screenDimensions)
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
  private suspend fun broadcastHierarchyExtractFrame(frame: ErrorResponse?) {
    // A null frame means there was nothing to correlate (blank/absent uuid, or a cooperative
    // cancellation that must propagate); HierarchyExtractErrorFrames already made that decision, so
    // there is no WebSocket frame to send here. See issue #3131.
    if (frame == null) return
    resultBroadcaster.guard(frame.requestId, "hierarchy_extract_error") {
      if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
        webSocketServer.broadcast(frame)
      }
    }
  }

  /**
   * Broadcast hierarchy update to WebSocket clients (suspend function for proper ordering).
   *
   * @param sync If true, waits for delivery to all clients before returning. Use for critical
   *   ordering.
   */
  private suspend fun broadcastHierarchyUpdate(hierarchy: ViewHierarchy, sync: Boolean = false) {
    val contextAtExtraction = extractedHierarchyFrameContexts.remove(hierarchy)
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping broadcast")
      return
    }

    try {
      val jsonString =
        perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }

      // Debug: Check if text labels are in the serialized hierarchy
      val hasTapText = jsonString.contains("\"text\":\"Tap\"")
      val hasDiscoverText = jsonString.contains("\"text\":\"Discover\"")
      Log.d(
        TAG,
        "[BROADCAST] Hierarchy contains: Tap=$hasTapText, Discover=$hasDiscoverText, size=${jsonString.length}",
      )

      val messageBuilder: (kotlinx.serialization.json.JsonElement?) -> String = { perfTiming ->
        buildString {
          append(
            """{"type":"hierarchy_update","timestamp":${System.currentTimeMillis()},"data":$jsonString"""
          )
          if (contextAtExtraction != null && contextAtExtraction == currentFrameContext()) {
            append(""","frameContext":"$contextAtExtraction"""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
      }

      if (sync) {
        // Synchronous broadcast - waits for delivery to ensure ordering
        webSocketServer.broadcastWithPerfSync(messageBuilder)
      } else {
        // Async broadcast - for normal event-driven updates
        webSocketServer.broadcastWithPerf(messageBuilder)
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
  private suspend fun takeScreenshotAsync(quality: Int = 80): ScreenshotCapturePayload? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      Log.w(TAG, "Screenshot API requires Android R (API 30) or higher")
      return null
    }

    return withContext(Dispatchers.IO) {
      try {
        val startTime = System.currentTimeMillis()

        // Use suspendCancellableCoroutine to bridge callback-based API
        val rotationCapture = rotationProvenance.beginCapture()
        val rotationAtCaptureStart = getRotationOrNull()
        val captured =
          suspendCancellableCoroutine<Pair<Bitmap, Int?>?> { continuation ->
            takeScreenshot(
              Display.DEFAULT_DISPLAY,
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
                    continuation.resume(null)
                    return
                  }
                  // A display change makes the pixels' orientation ambiguous. Preserve that
                  // ambiguity as null so desktop control fails closed rather than guessing.
                  val rotation =
                    rotationProvenance.rotationIfUnchanged(
                      rotationCapture,
                      rotationAtCaptureStart,
                      getRotationOrNull(),
                    )
                  continuation.resume(hardwareBitmap to rotation)
                }

                override fun onFailure(errorCode: Int) {
                  Log.e(TAG, "Screenshot failed with error code: $errorCode")
                  continuation.resume(null)
                }
              },
            )
          }

        if (captured == null) {
          Log.e(TAG, "Failed to capture screenshot bitmap")
          return@withContext null
        }

        val (bitmap, rotation) = captured

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

        ScreenshotCapturePayload(
          base64Image = base64String,
          rotation = rotation,
          captureDurationMs = screenshotTime,
          encodeDurationMs = encodeTime,
          byteLength = jpegBytes.size,
          base64Length = base64String.length,
        )
      } catch (e: CancellationException) {
        // The awaiting caller is being cancelled — rethrow instead of converting the cancellation
        // into a null screenshot (#3191).
        throw e
      } catch (e: Exception) {
        Log.e(TAG, "Error taking screenshot", e)
        null
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
          null,
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
        GestureDescription.Builder()
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
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(
      TAG,
      "performDrag: ($x1, $y1) -> ($x2, $y2) press=${pressDurationMs}ms drag=${dragDurationMs}ms hold=${holdDurationMs}ms",
    )
    perfProvider.serial("performDrag")

    try {
      perfProvider.startOperation("buildPath")
      val gestureBuilder = GestureDescription.Builder()
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
      } else if (pressDurationMs > 0) {
        // Phase 1: Press and hold at start position
        // Use zero-length path (moveTo + lineTo same point) for stationary touch
        val pressPath =
          Path().apply {
            moveTo(startX, startY)
            lineTo(startX, startY) // Zero-length path = stationary touch
          }
        val pressStroke = GestureDescription.StrokeDescription(pressPath, 0, pressDurationMs, true)
        gestureBuilder.addStroke(pressStroke)
        Log.d(
          TAG,
          "Stroke 1 (press): stationary at ($startX, $startY), startTime=0ms, duration=${pressDurationMs}ms, willContinue=true",
        )

        // Phase 2: Drag from start to end with 8 segments for more intermediate touch events
        val dragPath =
          Path().apply {
            moveTo(startX, startY)
            // Split the drag into 8 segments with variation in both X and Y to ensure hit
            // detection
            for (i in 1..8) {
              val t = i / 8.0f
              val baseX = startX + (endX - startX) * t
              val baseY = startY + (endY - startY) * t
              // Add alternating offsets to create a wavy path in both dimensions
              val xOffset = if (i % 2 == 0) 10f else -10f
              val yOffset = if (i % 2 == 0) -10f else 10f
              val x = baseX + xOffset
              val y = baseY + yOffset
              lineTo(x, y)
            }
          }
        val dragStroke =
          GestureDescription.StrokeDescription(
            dragPath,
            pressDurationMs,
            dragDurationMs,
            holdDurationMs > 0,
          )
        gestureBuilder.addStroke(dragStroke)
        Log.d(
          TAG,
          "Stroke 2 (drag): ($startX, $startY) -> ($endX, $endY), startTime=${pressDurationMs}ms, duration=${dragDurationMs}ms, willContinue=${holdDurationMs > 0}",
        )

        if (holdDurationMs > 0) {
          // Phase 3: Hold at end position
          val holdPath =
            Path().apply {
              moveTo(endX, endY)
              lineTo(endX, endY) // Zero-length path = stationary touch
            }
          val holdStroke =
            GestureDescription.StrokeDescription(
              holdPath,
              pressDurationMs + dragDurationMs,
              holdDurationMs,
              false,
            )
          gestureBuilder.addStroke(holdStroke)
          Log.d(
            TAG,
            "Stroke 3 (hold): stationary at ($endX, $endY), startTime=${pressDurationMs + dragDurationMs}ms, duration=${holdDurationMs}ms, willContinue=false",
          )
        }
      } else {
        // Single stroke drag without initial press
        val dragPath =
          Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
          }
        val dragStroke =
          GestureDescription.StrokeDescription(dragPath, 0, dragDurationMs, holdDurationMs > 0)
        gestureBuilder.addStroke(dragStroke)
        Log.d(
          TAG,
          "Single stroke drag: ($startX, $startY) -> ($endX, $endY), startTime=0ms, duration=${dragDurationMs}ms, willContinue=${holdDurationMs > 0}",
        )

        if (holdDurationMs > 0) {
          val holdPath =
            Path().apply {
              moveTo(endX, endY)
              lineTo(endX, endY)
            }
          val holdStroke =
            GestureDescription.StrokeDescription(holdPath, dragDurationMs, holdDurationMs, false)
          gestureBuilder.addStroke(holdStroke)
          Log.d(
            TAG,
            "Hold after drag: stationary at ($endX, $endY), startTime=${dragDurationMs}ms, duration=${holdDurationMs}ms, willContinue=false",
          )
        }
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
        if (outcome.completed) {
          Log.d(
            TAG,
            "Drag completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          launchRequestScope(requestId) {
            broadcastDragResult(
              requestId,
              true,
              null,
              outcome.totalTimeMs,
              outcome.gestureTimeMs,
            )
          }
        } else {
          Log.w(TAG, "Drag failed after ${outcome.totalTimeMs}ms: ${outcome.error}")
          launchRequestScope(requestId) {
            broadcastDragResult(requestId, false, outcome.error, outcome.totalTimeMs, null)
          }
        }
      }
    } catch (e: Exception) {
      perfProvider.end() // end performDrag block
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing drag", e)
      launchRequestScope(requestId) {
        broadcastDragResult(requestId, false, e.message, errorTime - startTime, null)
      }
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
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performTapCoordinates: ($x, $y) duration=${duration}ms")
    perfProvider.serial("performTapCoordinates")

    try {
      // Create a tap path (single point, no movement)
      perfProvider.startOperation("buildPath")
      val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }

      // Build the gesture description
      val gesture =
        GestureDescription.Builder()
          .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
          .build()
      perfProvider.endOperation("buildPath")

      val gestureBuiltTime = System.currentTimeMillis()
      Log.d(TAG, "Tap gesture built in ${gestureBuiltTime - startTime}ms")

      dispatchGestureWithResult(
        "performTapCoordinates",
        gesture,
        requestId,
        startTime,
        gestureBuiltTime,
        frameContext,
        beforeCompletedResult = {
          // Wait for UI to settle after tap, then extract fresh hierarchy.
          val freshHierarchy =
            hierarchyDebouncer.extractAfterQuiescence(
              quiescenceMs = 50L,
              maxWaitMs = 500L,
              pollIntervalMs = 10L,
            )
          if (freshHierarchy != null) {
            kotlinx.coroutines.runBlocking { broadcastHierarchyUpdate(freshHierarchy, sync = true) }
          }
        },
      ) { outcome ->
        if (outcome.completed) {
          Log.d(
            TAG,
            "Tap completed: gesture=${outcome.gestureTimeMs}ms, total=${outcome.totalTimeMs}ms",
          )
          launchRequestScope(requestId) {
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
        GestureDescription.Builder()
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
        GestureDescription.Builder()
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
  private fun performSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean = false,
  ) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performSetText: text='${text.take(20)}...' resourceId=$resourceId")
    perfProvider.serial("performSetText")

    try {
      perfProvider.startOperation("findNode")
      val targetNode =
        if (resourceId != null) {
          // Find node by resource-id
          findNodeByResourceId(rootInActiveWindow, resourceId)
        } else {
          // Find currently focused input node
          findFocusedEditableNode(rootInActiveWindow)
        }
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
        targetNode.performAction(
          android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
          arguments,
        )
      targetNode.recycle()
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
            android.accessibilityservice.AccessibilityService.SHOW_MODE_HIDDEN
          )
          Log.d(TAG, "[KeyboardDismiss] Set SHOW_MODE_HIDDEN after text injection")
        } catch (e: Exception) {
          Log.w(TAG, "[KeyboardDismiss] softKeyboardController failed", e)
        }
      }

      // Trigger a hierarchy refresh after successful text input
      // This ensures the next observe will get the updated text
      if (success) {
        // Wait for UI to settle (no accessibility events for 50ms), then extract hierarchy
        // This dynamically adapts to how long validation/animations take, instead of using a fixed
        // delay
        // Flow emissions are suppressed during this to prevent race conditions with debounced
        // broadcasts
        val freshHierarchy =
          hierarchyDebouncer.extractAfterQuiescence(
            quiescenceMs = 50L, // Wait for 50ms of no events
            maxWaitMs = 500L, // But don't wait more than 500ms total
            pollIntervalMs = 10L, // Check every 10ms
          )
        if (freshHierarchy != null) {
          // Broadcast hierarchy synchronously (sync=true) to ensure it arrives before
          // set_text_result
          kotlinx.coroutines.runBlocking { broadcastHierarchyUpdate(freshHierarchy, sync = true) }
        }
      }

      val totalTime = System.currentTimeMillis() - startTime
      Log.d(TAG, "Set text total time: ${totalTime}ms")

      // Broadcast set_text_result synchronously to ensure ordering after hierarchy
      kotlinx.coroutines.runBlocking {
        broadcastSetTextResult(
          requestId,
          success,
          if (success) null else "performAction returned false",
          totalTime,
        )
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing set text", e)
      kotlinx.coroutines.runBlocking {
        broadcastSetTextResult(requestId, false, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Perform IME action using AccessibilityService. This properly handles focus movement
   * (next/previous) and keyboard actions (done/go/search/send).
   */
  private fun performImeAction(requestId: String?, action: String) {
    val startTime = System.currentTimeMillis()
    Log.d(TAG, "performImeAction: action='$action'")
    perfProvider.serial("performImeAction")

    try {
      perfProvider.startOperation("findFocusedNode")
      val root = rootInActiveWindow
      val focusedNode = findFocusedEditableNode(root)
      perfProvider.endOperation("findFocusedNode")

      if (focusedNode == null && action in listOf("next", "previous")) {
        perfProvider.end()
        val errorTime = System.currentTimeMillis()
        val error = "No focused editable node found for IME action"
        Log.w(TAG, error)
        launchRequestScope(requestId) {
          broadcastImeActionResult(requestId, action, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("executeAction")
      val success =
        when (action) {
          "next" -> {
            // Find next focusable element and focus it
            val nextNode = findNextFocusableNode(root, focusedNode!!)
            if (nextNode != null) {
              val focusSuccess =
                nextNode.performAction(
                  android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS
                )
              nextNode.recycle()
              focusSuccess
            } else {
              Log.w(TAG, "No next focusable node found")
              false
            }
          }
          "previous" -> {
            // Find previous focusable element and focus it
            val prevNode = findPreviousFocusableNode(root, focusedNode!!)
            if (prevNode != null) {
              val focusSuccess =
                prevNode.performAction(
                  android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS
                )
              prevNode.recycle()
              focusSuccess
            } else {
              Log.w(TAG, "No previous focusable node found")
              false
            }
          }
          "done",
          "go",
          "send",
          "search" -> {
            // For these actions, trigger the IME's enter/submit action
            // This properly submits forms, navigates URLs, performs searches, etc.
            if (
              focusedNode != null &&
                android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R
            ) {
              // API 30+: Use ACTION_IME_ENTER for proper IME action handling
              @Suppress("NewApi")
              val actionId =
                android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
                  .ACTION_IME_ENTER
                  .id
              val imeResult = focusedNode.performAction(actionId)
              Log.d(TAG, "ACTION_IME_ENTER result: $imeResult")
              imeResult
            } else if (focusedNode != null) {
              // Pre-API 30: Fall back to pressing Enter key via input shell command
              // This is less reliable but works on older devices
              Log.d(TAG, "Pre-API 30: falling back to KEYCODE_ENTER")
              try {
                Runtime.getRuntime().exec(arrayOf("input", "keyevent", "66")).waitFor() == 0
              } catch (e: Exception) {
                Log.e(TAG, "Failed to send KEYCODE_ENTER", e)
                false
              }
            } else {
              // No focused node - fall back to global back action
              Log.w(TAG, "No focused node for IME action, falling back to GLOBAL_ACTION_BACK")
              performGlobalAction(GLOBAL_ACTION_BACK)
            }
          }
          else -> {
            Log.w(TAG, "Unknown IME action: $action")
            false
          }
        }
      perfProvider.endOperation("executeAction")

      focusedNode?.recycle()
      perfProvider.end()

      Log.d(TAG, "IME action completed: success=$success")

      // Wait for UI to settle, then extract fresh hierarchy
      if (success) {
        val freshHierarchy =
          hierarchyDebouncer.extractAfterQuiescence(
            quiescenceMs = 50L,
            maxWaitMs = 500L,
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
        )
      }
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = System.currentTimeMillis()
      Log.e(TAG, "Error performing IME action", e)
      kotlinx.coroutines.runBlocking {
        broadcastImeActionResult(requestId, action, false, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Perform select all text using AccessibilityService's ACTION_SET_SELECTION. This is
   * significantly faster than using ADB double-tap gestures.
   */
  private fun performSelectAll(requestId: String?) {
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
      val textLength = text?.length ?: 0

      val success =
        if (textLength > 0) {
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
          focusedNode.performAction(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION,
            arguments,
          )
        } else {
          // No text to select
          Log.d(TAG, "No text in focused node to select")
          true // Consider it a success - nothing to select
        }

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
          if (success) null else "performAction returned false",
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
  private fun performNodeAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
  ) {
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
      val root = rootInActiveWindow
      val targetNode =
        if (effectiveSelector != null) {
          findNodeBySelector(root, effectiveSelector)
        } else if (resourceId != null) {
          findNodeByResourceId(root, resourceId)
        } else {
          null
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
      val actionId = nodeActionId(action)
      val actionError = nodeActionFailure(action, targetNode.actionList?.map { it.id })
      val success = actionId != null && actionError == null && targetNode.performAction(actionId)
      perfProvider.endOperation("executeAction")

      targetNode.recycle()
      perfProvider.end()

      Log.d(TAG, "Action completed: success=$success")

      // Wait for UI to settle after click/long_click/scroll, then extract fresh hierarchy
      if (success && action in listOf("click", "long_click", "scroll_forward", "scroll_backward")) {
        val freshHierarchy =
          hierarchyDebouncer.extractAfterQuiescence(
            quiescenceMs = 50L,
            maxWaitMs = 500L,
            pollIntervalMs = 10L,
          )
        if (freshHierarchy != null) {
          kotlinx.coroutines.runBlocking { broadcastHierarchyUpdate(freshHierarchy, sync = true) }
        }
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
                    android.view.accessibility.AccessibilityNodeInfo.ACTION_PASTE
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
            android.content.pm.PackageManager.PackageInfoFlags.of(0L)
          )
        } else {
          @Suppress("DEPRECATION") packageManager.getInstalledPackages(0)
        }
      val records = mutableListOf<dev.jasonpearson.automobile.protocol.InstalledPackageRecord>()
      for (info in infos) {
        val isSystem =
          (info.applicationInfo?.flags ?: 0) and
            (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
        if (!includeSystem && isSystem) continue
        val versionCode =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
          else @Suppress("DEPRECATION") info.versionCode.toLong()
        records.add(
          dev.jasonpearson.automobile.protocol.InstalledPackageRecord(
            packageName = info.packageName,
            isSystem = isSystem,
            versionName = info.versionName,
            versionCode = versionCode,
          )
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
    return digest.joinToString("") { "%02x".format(it) }
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

    // Find current node's position and return the previous one
    var previousNode: android.view.accessibility.AccessibilityNodeInfo? = null
    for (node in focusableNodes) {
      if (isSameNode(node, currentNode)) {
        // Recycle all nodes except the previous one
        focusableNodes.forEach { n -> if (n != previousNode) n.recycle() }
        return previousNode
      }
      previousNode?.recycle()
      previousNode = node
    }

    // If current node not found, recycle all
    focusableNodes.forEach { it.recycle() }
    return null
  }

  /** Collect all focusable and editable nodes in document order (pre-order traversal). */
  private fun collectFocusableNodes(
    node: android.view.accessibility.AccessibilityNodeInfo,
    result: MutableList<android.view.accessibility.AccessibilityNodeInfo>,
  ) {
    // A node is a valid IME target if it's editable and focusable
    if (node.isEditable && node.isFocusable) {
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

  /** Find a node by resource-id, searching recursively through the hierarchy. */
  private fun findNodeByResourceId(
    root: android.view.accessibility.AccessibilityNodeInfo?,
    resourceId: String,
  ): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null

    // Check if this node matches
    val nodeResourceId = root.viewIdResourceName
    if (
      nodeResourceId != null &&
        (nodeResourceId == resourceId || nodeResourceId.endsWith(":id/$resourceId"))
    ) {
      return root
    }

    // Search children
    for (i in 0 until root.childCount) {
      val child = root.getChild(i) ?: continue
      val found = findNodeByResourceId(child, resourceId)
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
    root: android.view.accessibility.AccessibilityNodeInfo?
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
    node: android.view.accessibility.AccessibilityNodeInfo?
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
      webSocketServer.broadcastWithPerf { perfTiming ->
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

  /** Broadcast IME action result to WebSocket clients */
  private suspend fun broadcastImeActionResult(
    requestId: String?,
    action: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping IME action result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "ime_action_result") {
      webSocketServer.broadcastWithPerf { perfTiming ->
        webSocketFrameJson("ime_action_result", requestId = requestId, perfTiming = perfTiming) {
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
        )
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
        )
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
        )
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
        )
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
        )
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
        )
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
        buildString {
          append("""{"type":"swipe_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","success":$success""")
          append(""","totalTimeMs":$totalTimeMs""")
          if (gestureTimeMs != null) {
            append(""","gestureTimeMs":$gestureTimeMs""")
          }
          if (error != null) {
            append(""","error":"$error"""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
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
        buildString {
          append("""{"type":"drag_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","success":$success""")
          append(""","totalTimeMs":$totalTimeMs""")
          if (gestureTimeMs != null) {
            append(""","gestureTimeMs":$gestureTimeMs""")
          }
          if (error != null) {
            append(""","error":"$error"""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
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
        buildString {
          append("""{"type":"tap_coordinates_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","success":$success""")
          append(""","totalTimeMs":$totalTimeMs""")
          if (error != null) {
            append(""","error":"$error"""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
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
        buildString {
          append("""{"type":"pinch_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","success":$success""")
          append(""","totalTimeMs":$totalTimeMs""")
          if (gestureTimeMs != null) {
            append(""","gestureTimeMs":$gestureTimeMs""")
          }
          if (error != null) {
            append(""","error":"$error"""")
          }
          if (perfTiming != null) {
            append(""","perfTiming":$perfTiming""")
          }
          append("}")
        }
      }
      Log.d(TAG, "Broadcasted pinch result to ${webSocketServer.getConnectionCount()} clients")
    }
  }

  /** Broadcast screenshot to WebSocket clients */
  private fun broadcastScreenshot(requestId: String?) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping screenshot broadcast")
      return
    }

    // Routed through asyncActionRunner: a throw in takeScreenshotAsync() (or the broadcast) would
    // otherwise be logged-and-swallowed here, emitting neither `screenshot` nor `screenshot_error`
    // and hanging the awaiting client until timeout (issue #3023).
    asyncActionRunner.launch(requestId, "screenshot") {
      val contextBeforeCapture = currentFrameContext()
      val screenshot = takeScreenshotAsync()
      val stableContext = contextBeforeCapture.takeIf { it == currentFrameContext() }
      if (screenshot != null) {
        webSocketServer.broadcast(
          ProtocolScreenshotResult(
            timestamp = System.currentTimeMillis(),
            requestId = requestId,
            data = screenshot.base64Image,
            format = "jpeg",
            rotation = screenshot.rotation,
            screenshotCaptureDurationMs = screenshot.captureDurationMs,
            screenshotEncodeDurationMs = screenshot.encodeDurationMs,
            screenshotByteLength = screenshot.byteLength,
            screenshotBase64Length = screenshot.base64Length,
            frameContext = stableContext?.toString(),
          )
        )
        Log.d(TAG, "Broadcasted screenshot to ${webSocketServer.getConnectionCount()} clients")
      } else {
        val errorMessage = buildString {
          append("""{"type":"screenshot_error","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","error":"Failed to capture screenshot"}""")
        }
        webSocketServer.broadcast(errorMessage)
      }
    }
  }

  /** Broadcast navigation event to WebSocket clients using typed protocol */
  private suspend fun broadcastNavigationEvent(event: TimestampedNavigationEvent) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping navigation event broadcast")
      return
    }

    try {
      val response =
        NavigationEventResponse(
          timestamp = System.currentTimeMillis(),
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

      webSocketServer.broadcast(response)
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
      val response =
        HandledExceptionEvent(
          timestamp = System.currentTimeMillis(),
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
      val response =
        CrashEvent(
          timestamp = System.currentTimeMillis(),
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

  /** Broadcast ANR event to WebSocket clients using typed protocol */
  private suspend fun broadcastAnrEvent(
    timestamp: Long,
    pid: Int,
    processName: String,
    importance: String,
    trace: String?,
    reason: String,
    packageName: String,
    appVersion: String?,
    deviceModel: String,
    deviceManufacturer: String,
    osVersion: String,
    sdkInt: Int,
  ) {
    if (!::webSocketServer.isInitialized || !webSocketServer.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping ANR broadcast")
      return
    }

    try {
      val response =
        AnrEvent(
          timestamp = timestamp,
          event =
            AnrData(
              pid = pid,
              processName = processName,
              importance = importance,
              trace = trace,
              reason = reason,
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

      webSocketServer.broadcast(response)
      Log.i(
        TAG,
        "Broadcasted ANR to ${webSocketServer.getConnectionCount()} clients: pid=$pid process=$processName",
      )
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting ANR event", e)
    }
  }

  /** Broadcast an individual SDK event from a batch to WebSocket clients. */
  private suspend fun broadcastSdkEvent(event: SdkEvent) {
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
          // Existing event types handled by their own receivers — skip here
          is SdkNavigationEvent,
          is SdkHandledExceptionEvent,
          is SdkCrashEvent,
          is SdkAnrEvent,
          is SdkNotificationActionEvent,
          is SdkRecompositionSnapshotEvent,
          is SdkEventBatch -> null
        }

      response?.let { webSocketServer.broadcast(it) }
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
      val rootNode = rootInActiveWindow
      val focusedNode = rootNode?.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
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
      webSocketServer.broadcast(
        buildString {
          append("""{"type":"current_focus_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","totalTimeMs":$totalTimeMs""")
          append(""","error":"${error ?: "Unknown error"}"""")
          append("}")
        }
      )
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
      webSocketServer.broadcast(
        buildString {
          append("""{"type":"traversal_order_result","timestamp":${System.currentTimeMillis()}""")
          if (requestId != null) {
            append(""","requestId":"$requestId"""")
          }
          append(""","totalTimeMs":$totalTimeMs""")
          append(""","error":"${error ?: "Unknown error"}"""")
          append("}")
        }
      )
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
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}"""
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
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}"""
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
            ""","success":true,"subscriptionId":${jsonCompact.encodeToString(subscriptionId)}"""
          )
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}"""
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
            val jsonValue =
              if (entry.type == "STRING") jsonCompact.encodeToString(entry.value) else entry.value
            append(""","value":$jsonValue""")
          } else {
            append(""","value":null""")
          }
          append(""","type":${jsonCompact.encodeToString(entry.type)}""")
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
    event: dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceChangeEvent
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
