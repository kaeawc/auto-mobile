package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitRequest
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.ime.session.SharedPreferencesKeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfRequestContext
import dev.jasonpearson.automobile.ctrlproxy.perf.SystemTimeProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPinnedShortcutPlatform
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDeviceAppearance
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDeviceLocale
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDisplays
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeScreenShapeSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidSavedPrototypeShortcuts
import dev.jasonpearson.automobile.ctrlproxy.prototype.BitmapPrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.ComposePrototypeFontLoader
import dev.jasonpearson.automobile.ctrlproxy.prototype.CoroutinePrototypeScheduler
import dev.jasonpearson.automobile.ctrlproxy.prototype.DefaultPrototypeHost
import dev.jasonpearson.automobile.ctrlproxy.prototype.HostPrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PinnedPrototypeShortcuts
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetDirectory
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetStore
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBackdropSupport
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBackdrops
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBase64Decoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEventSink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeFontCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeForegroundTracker
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeForegroundWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHiddenCapture
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHostLink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClients
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImeInset
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImeWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLifecycle
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRefreshCoalescer
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStoragePersistence
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStorageStores
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowOnScreen
import dev.jasonpearson.automobile.ctrlproxy.prototype.RetrofitPrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeStores
import dev.jasonpearson.automobile.ctrlproxy.prototype.hasPrototypeTitle
import dev.jasonpearson.automobile.ctrlproxy.prototype.imeLiftPx
import dev.jasonpearson.automobile.ctrlproxy.prototype.isPrototypeWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeForegroundFromWindows
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeIdOfTitle
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeStorageRoot
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeWindowOnScreen
import dev.jasonpearson.automobile.ctrlproxy.prototype.validatePrototypeShaderUniforms
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import dev.jasonpearson.automobile.protocol.ActionResult
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.GlobalActionResult
import dev.jasonpearson.automobile.protocol.NodeSelector
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceOverride
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestInsertText
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.SetPreference
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

// AccessibilityEvent constants are inlined on every API level; preserve the subscribed values.
private const val SPEECH_STATE_CHANGE_EVENT = 0x02000000 // TYPE_SPEECH_STATE_CHANGE, API 33.
private const val VIEW_TARGETED_BY_SCROLL_EVENT =
  0x04000000 // TYPE_VIEW_TARGETED_BY_SCROLL, API 34.

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

/**
 * Main AutoMobile Accessibility Service that provides view hierarchy extraction capabilities for
 * automated testing and UI interaction.
 */
class CtrlProxy : AccessibilityService(), CtrlProxyActions {

  companion object {
    private const val TAG = "CtrlProxy"

    // File name for app-scoped storage

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
        SPEECH_STATE_CHANGE_EVENT,
        VIEW_TARGETED_BY_SCROLL_EVENT,
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
     * delivery. 100 ms matches the tightest interaction debounce the handler already applies (see
     * [InteractionEventController]) and sits well under the scroll debounce (300 ms) and hierarchy
     * broadcast interval (250 ms), so it collapses event floods without adding perceptible latency
     * to the interaction/telemetry or hierarchy-refresh paths the debouncers rely on.
     */
    const val ACCESSIBILITY_NOTIFICATION_TIMEOUT_MS = 100L

    // Broadcast actions
    const val ACTION_EXTRACT_HIERARCHY = "dev.jasonpearson.automobile.EXTRACT_HIERARCHY"

    // Result broadcast actions
    const val ACTION_OPERATION_RESULT = "dev.jasonpearson.automobile.OPERATION_RESULT"

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

  // Kept as a Lazy so teardown closes the service-owned modules only if they were ever created.
  private val prototypePlatformDelegate = lazy {
    dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeRuntimePlatform(
      this,
      dev.jasonpearson.automobile.prototype.AndroidPrototypeClipboard(
        this,
        object : dev.jasonpearson.automobile.prototype.PrototypeClipboardFocus {
          override suspend fun <T> read(block: () -> T): T =
            prototypeController.readClipboard(block)
        },
      ),
    )
  }
  private val prototypePlatform by prototypePlatformDelegate

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

  // Prototype cleanup must finish on Main even after serviceScope is cancelled during teardown.
  private val teardownScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  // Android constructs services without arguments. GestureController resolves this on first use
  // so tests can supply a deterministic queue before onCreate, without a real HandlerThread.
  internal var gestureThreadFactory: () -> GestureThread = ::HandlerGestureThread

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
  /**
   * The one path every request result takes to the wire (#11877): running check, broadcast guard,
   * perf flush and routing. Declared ahead of the eagerly built [textInputController].
   */
  private val resultSender: ResultSender =
    GuardedResultSender(
      transport =
        object : GuardedResultSender.Transport {
          override fun isRunning() = ::webSocketServer.isInitialized && webSocketServer.isRunning()

          override fun flushPerfTiming() = perfProvider.flush()

          override suspend fun sendFrame(frame: String) = webSocketServer.broadcast(frame)

          override suspend fun send(response: WebSocketResponse) =
            webSocketServer.broadcast(response)

          override fun connectionCount() = webSocketServer.getConnectionCount()
        },
      resultBroadcaster = resultBroadcaster,
    )
  private val recompositionStore = RecompositionStore()
  private val frameMetricsStore = FrameMetricsStore()
  internal val workStats = CtrlProxyWorkStats()
  private val viewHierarchyExtractor =
    ViewHierarchyExtractor(
      recompositionStore,
      workStats,
      // Read once when this service instance starts, not on each hierarchy capture. On from API 30;
      // the debug property overrides it (#13956).
      pruneBaselineWrappers = readBaselineWrapperPruningEnabled(),
      prototypeHiddenReason = { displayId, captured ->
        if (::prototypeController.isInitialized)
          prototypeController.hiddenReason(displayId, captured)
        else null
      },
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
          prototypeController.windowMetadata(prototypeIdOfTitle(title))
        else null
      },
    )
  private val jsonCompact = Json {
    prettyPrint = false
    encodeDefaults = true
  }
  private val jsonLenient = Json { ignoreUnknownKeys = true }

  private val perfProvider = PerfProvider.instance
  private val timeProvider: TimeProvider = SystemTimeProvider()
  private lateinit var webSocketServer: WebSocketServer
  private val webSocketLifecycle = ServerLifecycle<WebSocketServer> { it.stop() }
  private val deviceEvents =
    DeviceEventBroadcaster(
      object : DeviceEventTransport {
        override fun isRunning() = ::webSocketServer.isInitialized && webSocketServer.isRunning()

        override fun connectionCount() = webSocketServer.getConnectionCount()

        override suspend fun broadcast(message: String) = webSocketServer.broadcast(message)

        override suspend fun broadcast(
          response: WebSocketResponse,
          mode: WebSocketServer.BroadcastMode,
          waitForClient: Boolean,
        ) = webSocketServer.broadcast(response, mode, waitForClient)
      },
      timeProvider,
    )
  private lateinit var rotationProvenance: RotationProvenanceTracker
  private var deviceStateRegistration: AutoCloseable? = null
  private val navigationEventAccumulator = NavigationEventAccumulator()
  private val sdkEventBatchProcessor by lazy {
    SdkEventBatchProcessor(
      scope = serviceScope,
      navigationEventAccumulator = navigationEventAccumulator,
      broadcastNavigationEvent = { event ->
        deviceEvents.navigationEvent(
          event,
          mode = WebSocketServer.BroadcastMode.Sync,
          waitForClient = true,
        )
      },
      broadcastSdkEvent = { event ->
        deviceEvents.sdkEvent(
          event,
          mode = WebSocketServer.BroadcastMode.Sync,
          waitForClient = true,
        )
      },
    )
  }
  private lateinit var prototypeController: PrototypeController

  /** `via: "host"` prototype requests: sent over the socket to the latest connected host. */
  private val hostPrototypeHttp =
    HostPrototypeHttpClient(
      PrototypeHostLink { frame ->
        if (::webSocketServer.isInitialized) webSocketServer.sendToHost(frame) else null
      },
      cancelLink = { target, frame ->
        // A connection that has since closed is skipped by sendToClient.
        if (::webSocketServer.isInitialized && target is WebSocketServer.ConnectedClient) {
          webSocketServer.sendToClient(target, frame)
        }
      },
    )
  private val prototypeRefreshCoalescer =
    PrototypeRefreshCoalescer(
      launch = { action -> serviceScope.launch { action() } },
      action = { prototypeController.onConfigurationChanged() },
    )
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
    PrototypeResultBroadcaster(
      object : PrototypeResultTransport {
        override fun isRunning() = ::webSocketServer.isInitialized && webSocketServer.isRunning()

        override suspend fun broadcastFrame(buildFrame: () -> String) =
          webSocketServer.broadcastWithPerf { _ ->
            buildFrame()
          }
      },
      resultBroadcaster,
      AndroidPrototypeScreenShapeSource(this),
    )
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
  // Values a spec's storage block keeps across shows (#12522); writes are coalesced on the service
  // scope and hit the disk on IO.
  private val prototypeStorage by lazy {
    PrototypeStoragePersistence(
      PrototypeStorageStores.inDirectory(prototypeStorageRoot(filesDir)),
      CoroutinePrototypeScheduler(serviceScope),
    )
  }
  private val savedPrototypeController by lazy {
    SavedPrototypeController(
      SavedPrototypeStores.inDirectory(File(filesDir, "saved-prototypes")),
      prototypeAssets,
      AndroidSavedPrototypeShortcuts(this),
      prototypeResultSink,
      pinner = PinnedPrototypeShortcuts(AndroidPinnedShortcutPlatform(this)),
      // Deleting a saved prototype also removes the values its storage block kept.
      clearStorage = { id ->
        if (::prototypeController.isInitialized) prototypeController.clearStoredValues(id)
        else prototypeStorage.clear(id)
      },
    )
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
  private val globalActionController by lazy {
    GlobalActionController(
      host =
        object : GlobalActionController.Host {
          override fun performGlobalAction(actionId: Int) =
            this@CtrlProxy.performGlobalAction(actionId)

          override fun forgetRememberedInsert() = textInputController.forgetRememberedInsert()

          override suspend fun broadcast(result: GlobalActionResult) =
            webSocketServer.broadcast(result)
        },
      asyncActionRunner = asyncActionRunner,
      timeProvider = timeProvider,
    )
  }
  private val screenshotRequests by lazy {
    ScreenshotRequestHandler(
      host =
        object : ScreenshotRequestHandler.Host {
          override fun isRunning() = ::webSocketServer.isInitialized && webSocketServer.isRunning()

          override fun connectionCount() = webSocketServer.getConnectionCount()

          override suspend fun broadcast(response: WebSocketResponse) =
            webSocketServer.broadcast(response)

          override suspend fun broadcast(frame: String) = webSocketServer.broadcast(frame)

          override fun currentFrameContext() = this@CtrlProxy.currentFrameContext()

          override fun activeDisplayId() = this@CtrlProxy.activeDisplayId()

          override fun panelUniqueId(displayId: Int) = displayController.panelUniqueId(displayId)

          override suspend fun capture(displayId: Int) =
            dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeIconCapture.atRest {
              screenshotController.takeScreenshotAsync(displayId)
            }

          override suspend fun captureWithPrototypeHidden(displayId: Int) =
            this@CtrlProxy.captureWithPrototypeHidden(displayId)
        },
      asyncActionRunner = asyncActionRunner,
      timeProvider = timeProvider,
    )
  }
  private val hierarchyExtractCommands by lazy {
    HierarchyExtractCommandHandler(
      object : HierarchyExtractCommandHandler.Host {
        override fun cleanupUuidHierarchyFiles() = hierarchyController.cleanupUuidHierarchyFiles()

        override fun extractHierarchy(textFilter: String?, disableAllFiltering: Boolean) =
          hierarchyController.extractHierarchy(textFilter, disableAllFiltering)

        override fun serialize(hierarchy: ViewHierarchy) =
          perfProvider.track("serializeHierarchy") { jsonCompact.encodeToString(hierarchy) }

        override fun writeHierarchyToFile(
          hierarchy: ViewHierarchy,
          filename: String,
          serialized: String,
        ) = hierarchyController.writeHierarchyToFile(hierarchy, filename, serialized = serialized)

        override suspend fun broadcastHierarchyUpdate(
          hierarchy: ViewHierarchy,
          serialized: String,
          requestId: String,
        ) =
          hierarchyController.broadcastHierarchyUpdate(
            hierarchy,
            serialized = serialized,
            requestId = requestId,
          )

        override fun releaseFrameContext(hierarchy: ViewHierarchy) {
          hierarchyController.extractedHierarchyFrameContexts.remove(hierarchy)
        }

        override fun sendResult(success: Boolean, data: String?, error: String?) =
          this@CtrlProxy.sendResult(success, data, error)

        override suspend fun sendErrorFrame(frame: ErrorResponse?) =
          broadcastHierarchyExtractFrame(frame)
      },
    )
  }
  private val permissionController by lazy {
    PermissionController(
      permissions = { permission, request ->
        permissionManager.getPermissionState(permission, request)
      },
      asyncActionRunner = asyncActionRunner,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
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
  private val caCertificateController by lazy {
    CaCertificateController(
      dependencies =
        CaCertificateDependencies(
          devicePolicy =
            object : CaCertificateController.DevicePolicy {
              override fun isDeviceOwnerApp(packageName: String) =
                devicePolicyManager.isDeviceOwnerApp(packageName)

              override fun isAdminActive() = devicePolicyManager.isAdminActive(deviceAdminComponent)

              override fun installCaCert(certBytes: ByteArray) =
                devicePolicyManager.installCaCert(deviceAdminComponent, certBytes)

              override fun uninstallCaCert(certBytes: ByteArray) =
                devicePolicyManager.uninstallCaCert(deviceAdminComponent, certBytes)

              override fun getInstalledCaCerts(): List<ByteArray> =
                devicePolicyManager.getInstalledCaCerts(deviceAdminComponent)
            },
          packageName = packageName,
          filesDir = { filesDir },
        ),
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  private val settingsController by lazy {
    SettingsController(
      contentResolver = { contentResolver },
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  private val packageController by lazy {
    PackageController(
      packageManager = { packageManager },
      currentUserId = CurrentUserId::current,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  private val storageController by lazy {
    StorageController(
      manager = { storageSubscriptionManager },
      asyncActionRunner = asyncActionRunner,
      resultSender = resultSender,
      timeProvider = timeProvider,
      responseSender =
        object : StorageController.ResponseSender {
          override fun isRunning() = ::webSocketServer.isInitialized && webSocketServer.isRunning()

          override suspend fun broadcast(message: String) {
            webSocketServer.broadcast(message)
          }

          override fun connectionCount() = webSocketServer.getConnectionCount()
        },
    )
  }
  private val clipboardController by lazy {
    ClipboardController(
      clipboardManager = { clipboardManager },
      activeWindowRoot = { rootInActiveWindow },
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  private val displayController by lazy {
    DisplayController(
      host =
        object : DisplayController.Host {
          override fun displayManager() =
            getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager

          override fun windowManager() = getSystemService(Context.WINDOW_SERVICE) as? WindowManager

          private val insetsProvider by lazy { createDisplayInsetsProvider(this@CtrlProxy) }

          override fun displayInsetsProvider() = insetsProvider

          override fun frameworkDimenPx(name: String): Int {
            val id = resources.getIdentifier(name, "dimen", "android")
            return if (id > 0) resources.getDimensionPixelSize(id) else 0
          }

          override fun densityDpi() = resources.displayMetrics.densityDpi
        },
    )
  }
  private val deviceInfoController by lazy {
    DeviceInfoController(
      context = this,
      serviceInfo = { serviceInfo },
      displayController = displayController,
      asyncActionRunner = asyncActionRunner,
      broadcast = { webSocketServer.broadcast(it) },
    )
  }
  internal val hierarchyController by lazy {
    HierarchyController(
      host =
        object : HierarchyController.Host {
          override fun currentFrameContext() = this@CtrlProxy.currentFrameContext()

          override fun selectDisplayWindows(displayId: Int?) =
            viewHierarchyExtractor.selectDisplayWindows(this@CtrlProxy, displayId)

          override fun activeWindowRoot(): AccessibilityNodeInfo? = rootInActiveWindow

          override fun lastWindowClassName() = this@CtrlProxy.lastWindowClassName

          override fun rotationProvenance() = this@CtrlProxy.rotationProvenance

          override fun occlusionEnabled() = accessibilityFlags.occlusionEnabled

          override fun wakefulness() = deviceInfoController.getWakefulness()

          override fun foregroundActivity(rootPackage: String?, windowClass: String?) =
            deviceInfoController.getForegroundActivity(rootPackage, windowClass)

          override fun isEmulator() = deviceInfoController.getIsEmulator()

          override fun accessibilityTool() = deviceInfoController.getAccessibilityTool()

          override fun isServerRunning() =
            ::webSocketServer.isInitialized && webSocketServer.isRunning()

          override fun connectionCount() = webSocketServer.getConnectionCount()

          override fun releaseRequestOwner(requestId: String?) {
            if (::webSocketServer.isInitialized) webSocketServer.releaseRequestOwner(requestId)
          }

          override suspend fun broadcastHierarchyWithPerf(
            routeByRequestId: Boolean,
            messageBuilder: (perfTiming: JsonElement?) -> String,
          ) = webSocketServer.broadcastWithPerf(routeByRequestId, messageBuilder)

          override suspend fun broadcastHierarchyWithPerfSync(
            routeByRequestId: Boolean,
            messageBuilder: (perfTiming: JsonElement?) -> String,
          ) = webSocketServer.broadcastWithPerfSync(routeByRequestId, messageBuilder)

          override suspend fun broadcastHierarchyExtractFrame(
            frame: ErrorResponse?,
            externallyCorrelated: Boolean,
          ) = this@CtrlProxy.broadcastHierarchyExtractFrame(frame, externallyCorrelated)

          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) = this@CtrlProxy.launchRequestScope(requestId, block)

          override fun openFileOutput(filename: String, mode: Int) =
            this@CtrlProxy.openFileOutput(filename, mode)

          override fun filesDir() = this@CtrlProxy.filesDir
        },
      serviceScope = serviceScope,
      viewHierarchyExtractor = viewHierarchyExtractor,
      displayController = displayController,
      diagnostics =
        HierarchyDiagnosticsDependencies(
          perfProvider = perfProvider,
          timeProvider = timeProvider,
          workStats = workStats,
        ),
      jsonCompact = jsonCompact,
    )
  }
  private val screenshotController by lazy {
    ScreenshotController(
      host =
        object : ScreenshotController.Host {
          override fun takeScreenshot(displayId: Int, callback: TakeScreenshotCallback) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
              this@CtrlProxy.takeScreenshot(displayId, mainExecutor, callback)
            }
          }

          override fun rotationProvenance() = this@CtrlProxy.rotationProvenance
        },
      displayController = displayController,
      timeProvider = timeProvider,
    )
  }
  private val interactionEventController by lazy {
    InteractionEventController(
      host =
        object : InteractionEventController.Host {
          override fun connectionCount() =
            if (::webSocketServer.isInitialized) webSocketServer.getConnectionCount() else 0

          override fun observerSessionGeneration() =
            if (::webSocketServer.isInitialized) webSocketServer.observerSessionGeneration() else 0

          override fun isServerRunning() =
            ::webSocketServer.isInitialized && webSocketServer.isRunning()

          override suspend fun broadcast(message: String) {
            webSocketServer.broadcast(message)
          }

          override fun lastWindowClassName() = this@CtrlProxy.lastWindowClassName

          override fun launchInServiceScope(block: suspend CoroutineScope.() -> Unit) {
            serviceScope.launch(block = block)
          }
        },
      timeProvider = timeProvider,
      jsonCompact = jsonCompact,
    )
  }
  private val nodeActionController by lazy {
    NodeActionController(
      host =
        object : NodeActionController.Host {
          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) {
            this@CtrlProxy.launchRequestScope(requestId, block)
          }

          override fun activeWindowRoot(): AccessibilityNodeInfo? = rootInActiveWindow

          override fun findNodeInDisplayWindows(
            find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
          ) = this@CtrlProxy.findNodeInDisplayWindows(find)

          override fun screenDimensions(displayId: Int) =
            displayController.getScreenDimensions(displayId)

          override fun createView() = View(this@CtrlProxy)

          override suspend fun publishSettledHierarchy() {
            hierarchyController.publishSettledHierarchy()
          }

          override fun forgetRememberedInsert() = textInputController.forgetRememberedInsert()

          override suspend fun sendActionResult(outcome: NodeActionResult) =
            this@CtrlProxy.broadcastActionResult(
              outcome.requestId,
              outcome.action,
              outcome.success,
              outcome.error,
              outcome.totalTimeMs,
              outcome.alreadySatisfied,
            )
        },
      perfProvider = perfProvider,
      timeProvider = timeProvider,
    )
  }
  private val focusController by lazy {
    FocusController(
      host =
        object : FocusController.Host {
          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) {
            this@CtrlProxy.launchRequestScope(requestId, block)
          }

          override fun findAccessibilityFocusedNode() = findNodeInDisplayWindows {
            it.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
          }

          override fun extractFocusedElementInfo(node: AccessibilityNodeInfo) =
            viewHierarchyExtractor.extractFocusedElementInfo(node)

          override fun extractTraversalOrder(): TraversalOrderResult? {
            val allWindows = windows
            val rootNode = rootInActiveWindow
            val screenDimensions = displayController.getScreenDimensions()
            if (allWindows.isNullOrEmpty() && rootNode == null) return null
            return if (!allWindows.isNullOrEmpty()) {
              viewHierarchyExtractor.extractTraversalOrderFromAllWindows(
                allWindows,
                rootNode,
                screenDimensions,
              )
            } else {
              viewHierarchyExtractor.extractTraversalOrderFromActiveWindow(
                rootNode,
                screenDimensions,
              )
            }
          }

          override fun currentOverlayDrawer() =
            if (::overlayDrawer.isInitialized) overlayDrawer else null
        },
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      jsonCompact = jsonCompact,
      resultSender = resultSender,
    )
  }
  /**
   * Set text, insert text, IME actions and select all. Constructed eagerly (not `by lazy`) because
   * gesture, event and command paths invalidate its remembered insert caret from the first event.
   */
  private val textInputController =
    TextInputController(
      host =
        object : TextInputController.Host {
          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) {
            this@CtrlProxy.launchRequestScope(requestId, block)
          }

          override fun activeWindowRoot(): AccessibilityNodeInfo? = rootInActiveWindow

          override fun screenDimensions(displayId: Int) =
            displayController.getScreenDimensions(displayId)

          override fun hideSoftKeyboard() {
            softKeyboardController.setShowMode(AccessibilityService.SHOW_MODE_HIDDEN)
          }

          override suspend fun performImeNavigationAction(actionId: Int) =
            CtrlProxyIme.current()?.performNavigationAction(actionId)

          override fun sendKeycodeEnter() =
            Runtime.getRuntime().exec(arrayOf("input", "keyevent", "66")).waitFor() == 0

          override suspend fun publishSettledHierarchy() {
            hierarchyController.publishSettledHierarchy()
          }
        },
      serviceScope = serviceScope,
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      responses =
        TextInputResponseDependencies(
          jsonCompact = jsonCompact,
          resultSender = resultSender,
        ),
    )
  /** CtrlProxyIme commitText, its cancellation tombstones, and the keyboard profile requests. */
  private val imeController by lazy {
    ImeController(
      host =
        object : ImeController.Host {
          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) {
            this@CtrlProxy.launchRequestScope(requestId, block)
          }

          override fun currentIme(): ImeController.ImeTarget? =
            CtrlProxyIme.current()?.let { ime ->
              object : ImeController.ImeTarget {
                override fun commitText(
                  request: ImeCommitRequest,
                  onResult: (ImeCommitResult) -> Unit,
                ) = ime.commitText(request, onResult)
              }
            }

          override fun setActiveProfile(id: String, onComplete: (Boolean) -> Unit) =
            CtrlProxyIme.setActiveProfile(id, onComplete)

          override fun keyboardProfileStore(): KeyboardProfileStore =
            SharedPreferencesKeyboardProfileStore(this@CtrlProxy)

          override fun forgetRememberedInsert() = textInputController.forgetRememberedInsert()
        },
      timeProvider = timeProvider,
      jsonCompact = jsonCompact,
      resultSender = resultSender,
    )
  }
  /** Recomposition tracking, network mock rules and error simulation broadcasts to the app. */
  private val sdkControlController by lazy {
    SdkControlController(
      host =
        object : SdkControlController.Host {
          override fun sendBroadcast(intent: Intent) = this@CtrlProxy.sendBroadcast(intent)

          override fun sendOrderedBroadcast(intent: Intent, resultReceiver: BroadcastReceiver) =
            this@CtrlProxy.sendOrderedBroadcast(
              intent,
              null,
              resultReceiver,
              null,
              Activity.RESULT_OK,
              null,
              null,
            )

          override fun replyNetworkMockRules(result: SetNetworkMockRulesResult) {
            if (::webSocketServer.isInitialized && webSocketServer.isRunning()) {
              serviceScope.launch { webSocketServer.broadcast(result) }
            }
          }
        },
      recompositionStore = recompositionStore,
    )
  }
  /**
   * Tap, swipe, multi-finger, pinch, drag and streamed gestures plus their result frames, and the
   * dedicated gesture thread their callbacks run on.
   */
  private val gestureController =
    GestureController(
      host =
        object : GestureController.Host {
          override fun dispatchGesture(
            gesture: GestureDescription,
            callback: GestureResultCallback,
            handler: Handler,
          ) = this@CtrlProxy.dispatchGesture(gesture, callback, handler)

          override fun currentFrameContext() = this@CtrlProxy.currentFrameContext()

          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) {
            this@CtrlProxy.launchRequestScope(requestId, block)
          }

          override fun forgetRememberedInsert() = textInputController.forgetRememberedInsert()

          override suspend fun settledHierarchy(displayId: Int?) =
            hierarchyController.settledHierarchy(displayId)

          override suspend fun publishHierarchy(hierarchy: ViewHierarchy) =
            hierarchyController.broadcastHierarchyUpdate(hierarchy, sync = true)
        },
      scope = { serviceScope },
      reporting =
        GestureReportingDependencies(
          perfProvider = perfProvider,
          timeProvider = timeProvider,
          resultSender = resultSender,
        ),
      gestureThreadFactory = { gestureThreadFactory() },
    )
  @Volatile private var lastWindowClassName: String? = null
  private val frameContextGate =
    FrameContextGate(
      epoch = UUID.randomUUID().toString(),
      asyncActionRunner = asyncActionRunner,
      timeProvider = timeProvider,
      broadcast = { webSocketServer.broadcast(it) },
    )

  private val staleFrames =
    StaleFrameRejector(
      isStale = frameContextGate::isStale,
      host =
        object : StaleFrameRejector.Host {
          override fun launchRequestScope(
            requestId: String?,
            block: suspend CoroutineScope.() -> Unit,
          ) {
            this@CtrlProxy.launchRequestScope(requestId, block)
          }

          override suspend fun broadcastTapCoordinatesResult(
            requestId: String?,
            success: Boolean,
            error: String?,
            totalTimeMs: Long,
          ) =
            gestureController.broadcastTapCoordinatesResult(requestId, success, error, totalTimeMs)

          override suspend fun broadcastSwipeResult(
            requestId: String?,
            success: Boolean,
            error: String?,
            totalTimeMs: Long,
            gestureTimeMs: Long?,
          ) =
            gestureController.broadcastSwipeResult(
              requestId,
              success,
              error,
              totalTimeMs,
              gestureTimeMs,
            )

          override suspend fun broadcastDragResult(
            requestId: String?,
            success: Boolean,
            error: String?,
            totalTimeMs: Long,
            gestureTimeMs: Long?,
          ) =
            gestureController.broadcastDragResult(
              requestId,
              success,
              error,
              totalTimeMs,
              gestureTimeMs,
            )

          override suspend fun broadcastSetTextResult(
            requestId: String?,
            success: Boolean,
            error: String?,
            totalTimeMs: Long,
          ) = textInputController.broadcastSetTextResult(requestId, success, error, totalTimeMs)

          override suspend fun broadcastImeActionResult(outcome: ImeActionFrameResult) =
            textInputController.broadcastImeActionResult(outcome)

          override suspend fun broadcastGlobalActionResult(
            result: GlobalActionResult,
          ) = webSocketServer.broadcast(result)
        },
      timeProvider = timeProvider,
    )

  private val ownWindowTypeMemo = OwnWindowTypeMemo(nowMs = SystemClock::elapsedRealtime)

  private fun currentFrameContext(): String = frameContextGate.current()

  private val accessibilityFlags =
    AccessibilityFlagsController(
      object : AccessibilityFlagsController.Host {
        override fun updateServiceFlags(compute: (currentFlags: Int) -> Int?): Boolean {
          val info = serviceInfo ?: return false
          val flags = compute(info.flags) ?: return true
          info.flags = flags
          serviceInfo = info
          return true
        }
      },
    )

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
    CommandReceiver(
      serviceScope,
      object : CommandHost {
        override suspend fun handleCommand(intent: Intent) = this@CtrlProxy.handleCommand(intent)

        override fun sendFailure(error: String?) = sendResult(success = false, error = error)
      },
    )

  private val navigationEventReceiver =
    NavigationEventReceiver(
      sdkEventBatchProcessor = { sdkEventBatchProcessor },
      timeProvider = timeProvider,
    )

  private val recompositionReceiver =
    RecompositionSnapshotReceiver(
      jsonLenient = jsonLenient,
      recompositionStore = recompositionStore,
    )

  private val frameMetricsReceiver =
    FrameMetricsSnapshotReceiver(
      jsonLenient = jsonLenient,
      frameMetricsStore = frameMetricsStore,
      scope = serviceScope,
      isRunning = { ::webSocketServer.isInitialized && webSocketServer.isRunning() },
      broadcast = { response -> webSocketServer.broadcast(response) },
    )

  private val packageReceiver =
    PackageEventReceiver(
      serviceScope,
      object : PackageEventHost {
        override fun isSystemApp(packageName: String) = resolveSystemApp(packageName)

        override suspend fun onPackageEvent(event: PackageBroadcastEvent) =
          deviceEvents.packageEvent(event)
      },
    )

  private val failureReportHost =
    object : FailureReportHost {
      override suspend fun onHandledException(report: HandledExceptionReport) =
        deviceEvents.handledException(report)

      override suspend fun onCrash(report: CrashReport) = deviceEvents.crash(report)
    }

  private val handledExceptionReceiver = HandledExceptionReceiver(serviceScope, failureReportHost)

  private val crashReceiver = CrashReceiver(serviceScope, failureReportHost)

  private val screenStateReceiver =
    ScreenStateReceiver(
      object : ScreenStateHost {
        override fun refreshPrototypeWindow() = this@CtrlProxy.refreshPrototypeWindow()

        override fun extractHierarchyNow() = hierarchyController.extractNow()
      },
    )

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

  private val anrReceiver = AnrReceiver(anrBroadcastHandler)

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

  private val eventBatchReceiver = EventBatchReceiver(eventBatchBroadcastHandler)

  override fun onCreate() {
    super.onCreate()
    // Keep the production queue running from service creation, before any connection or request.
    gestureController.startThread()
  }

  // Lazy: needs the service context, and the controller built below outlives reconnects.
  private val prototypeDisplays by lazy { AndroidPrototypeDisplays(this) }

  override fun onServiceConnected() {
    super.onServiceConnected()
    Log.d(TAG, "onServiceConnected")
    // Overlay tokens exist only for displays present now; displays added later cannot host
    // prototype windows on Android 12L/13 (#15318).
    prototypeDisplays.onServiceBound()

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
      overlayDrawer =
        OverlayDrawer(screenDimensionsProvider = { displayController.getScreenDimensions() })
      overlayManager =
        OverlayManager(this, viewFactory = { HighlightOverlayView(it, overlayDrawer) })
      overlayDrawer.attachOverlayManager(overlayManager)
      if (!::prototypeController.isInitialized) {
        // Locks are shared safety facts; foreground suspension is request-local per surface.
        val prototypeWindowBlocked = {
          val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
          val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
          keyguard?.isKeyguardLocked != false || power?.isInteractive != true
        }
        val createPrototypeHost = {
          DefaultPrototypeHost(
            context = this,
            displayWindows = prototypeDisplays,
            onWindowAttached = {
              ownWindowTypeMemo.clear()
              overlayManager.setPrototypeAttached(true)
            },
            onWindowLost = ::refreshPrototypeWindow,
            isBlocked = prototypeWindowBlocked,
            imeInset = PrototypeImeInset { displayId -> prototypeImeLiftPx(displayId) },
            backScope = serviceScope,
          )
        }
        prototypeController =
          PrototypeController(
            createPrototypeHost(),
            prototypeResultSink,
            onDismissed = {
              ownWindowTypeMemo.clear()
              withContext(Dispatchers.Main.immediate) {
                overlayManager.setPrototypeAttached(false)
              }
            },
            lifecycle =
              PrototypeLifecycle(
                CoroutinePrototypeScheduler(serviceScope),
                isBlocked = prototypeWindowBlocked,
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
            storage = prototypeStorage,
            backdropSupport =
              PrototypeBackdropSupport {
                // Cross-window blur can be switched off at runtime (battery saver, developer
                // option).
                Build.VERSION.SDK_INT >= PrototypeBackdrops.MIN_BLUR_SDK &&
                  getSystemService(WindowManager::class.java)?.isCrossWindowBlurEnabled == true
              },
            windowOnScreen =
              PrototypeWindowOnScreen { displayId ->
                try {
                  val selected =
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                      // A null framework list is unavailable, rather than evidence of absence.
                      windows?.let {
                        if (displayId == Display.DEFAULT_DISPLAY) it else null
                      }
                    } else viewHierarchyExtractor.selectDisplayWindows(this, displayId).windows
                  prototypeWindowOnScreen(
                    selected,
                    hasTitle = { hasPrototypeTitle(it.type, it.title) },
                    rootPackage = { window ->
                      val root = window.root
                      try {
                        root?.packageName?.toString()
                      } finally {
                        root?.recycle()
                      }
                    },
                    ownPackage = packageName,
                  )
                } catch (error: Exception) {
                  Log.d(TAG, "Could not determine prototype window visibility", error)
                  null
                }
              },
            displays = prototypeDisplays,
            clearAssets = { prototypeAssets.clear() },
            hasAsset = { prototypeAssets.lookup(it) != null },
            validateShaders = { validatePrototypeShaderUniforms(it, prototypeAssets::lookup) },
            images = prototypeImages,
            // The host grants this appop before showing a window.layer "app" prototype.
            appLayerPermitted = {
              Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Settings.canDrawOverlays(this)
            },
            packageName = packageName,
            fonts = prototypeFonts,
            foreground = prototypeForeground,
            deviceAppearance = AndroidPrototypeDeviceAppearance(this),
            deviceLocale = AndroidPrototypeDeviceLocale(this),
            hostFactory = createPrototypeHost,
            httpClients =
              PrototypeHttpClients(
                host = hostPrototypeHttp,
                device = RetrofitPrototypeHttpClient(OkHttpClient()),
              ),
            requestScope = serviceScope,
            platform = prototypePlatform,
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

      hierarchyController.start()

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
            storageController.broadcastStorageChange(event)
          }
          .launchIn(serviceScope)

      // Keep inbound blocking work off Ktor's read loops, preserving each connection's wire order.
      try {
        val queuedHandler = queuedMessageHandler()
        val prototypes = prototypeController
        webSocketServer =
          WebSocketServer(
            port = 8765,
            platform = prototypePlatform,
            scope = serviceScope,
            options =
              WebSocketServerOptions(
                messageHandler = queuedHandler,
                onClientDisconnected = { client ->
                  queuedHandler.disconnect(client)
                  gestureController.cancelStreamsOwnedBy(client)
                  // Its in-flight host requests have no socket to answer on, even if another
                  // remains.
                  hostPrototypeHttp.onHostLost(client)
                },
                onClientCountChanged = { count, session ->
                  if (count == 0) hostPrototypeHttp.onHostLost()
                  serviceScope.launch { prototypes.onClientCountChanged(count, session) }
                },
                onPrototypeResponse = hostPrototypeHttp::onResponse,
                onClientConnected = { serviceScope.launch { prototypes.onClientConnected() } },
                onPermanentStartFailure = { disableSelf() },
              ),
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
                  deviceEvents.navigationEvent(event)
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
      teardownScope.launch { prototypeController.dismissForUnbind() }
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

    // Independent of serviceScope cancellation below. Main-immediate runs inline when possible;
    // a pending request releases the controller mutex on cancellation, then cleanup resumes. The
    // platform modules are shared by every surface, so they close once, after the controller.
    teardownScope.launch {
      if (::prototypeController.isInitialized) prototypeController.destroy()
      if (prototypePlatformDelegate.isInitialized()) {
        dev.jasonpearson.automobile.ctrlproxy.prototype.closePrototypeModules(prototypePlatform)
      }
    }
    if (::overlayManager.isInitialized) {
      overlayManager.destroy()
    }

    // Cancel hierarchy flow subscription
    hierarchyController.stop()

    // Cancel navigation event flow subscription
    navigationEventJob?.cancel()

    // Cancel storage change flow subscription and clean up manager
    storageChangeJob?.cancel()
    if (::storageSubscriptionManager.isInitialized) {
      storageSubscriptionManager.destroy()
      Log.d(TAG, "Storage subscription manager destroyed")
    }

    // Reset debouncer
    hierarchyController.resetDebouncer()

    // Stop WebSocket server
    if (::webSocketServer.isInitialized) {
      webSocketLifecycle.stop()
      Log.d(TAG, "WebSocket server stopped")
    }

    // close dispatches each cancel lift before this callback quits the gesture thread. The
    // platform's result callback need not arrive: the router has already closed and resolved
    // pending end results, and it ignores any late callback.
    teardownGestures(
      close = gestureController::closeStreams,
      quitThread = gestureController::quitThread,
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
        replies =
          ConnectionReplyDependencies(
            reply = ::replyToQueuedCommand,
            hasRequestOwner = { requestId ->
              ::webSocketServer.isInitialized &&
                webSocketServer.isRunning() &&
                webSocketServer.hasRequestOwner(requestId)
            },
          ),
        logging =
          ConnectionLogDependencies(
            logError = { message, error -> Log.e(TAG, message, error) },
            logWarning = { message -> Log.w(TAG, message) },
            logDebug = { message -> Log.d(TAG, message) },
          ),
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

  override suspend fun requestHierarchy(request: RequestHierarchy) =
    hierarchyController.requestHierarchy(request)

  override suspend fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) =
    hierarchyController.requestHierarchyIfStale(sinceTimestamp, requestId)

  override suspend fun setHierarchyInterval(intervalMs: Long?) =
    hierarchyController.setHierarchyInterval(intervalMs)

  override suspend fun requestScreenshot(request: RequestScreenshot) {
    val requestId = request.requestId
    val displayId = request.displayId
    val hidePrototypes = request.hidePrototypes

    screenshotRequests.broadcastScreenshot(requestId, displayId, hidePrototypes)
  }

  override suspend fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) {
    if (staleFrames.rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.TAP))
      return
    gestureController.performTapCoordinates(
      RequestTapCoordinates(
        requestId = requestId,
        x = x,
        y = y,
        duration = 50L,
        frameContext = frameContext,
        displayId = displayId,
        doubleTap = true,
      ),
    )
  }

  override suspend fun requestTapCoordinates(request: RequestTapCoordinates) {
    val requestId = request.requestId
    val frameContext = request.frameContext
    if (staleFrames.rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.TAP))
      return
    // A plain tap request is never a double tap; that arrives as its own request.
    gestureController.performTapCoordinates(request.copy(doubleTap = false))
  }

  override suspend fun requestSwipe(request: RequestSwipe) {
    val requestId = request.requestId
    val frameContext = request.frameContext
    if (staleFrames.rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.SWIPE))
      return
    gestureController.performSwipe(request)
  }

  override suspend fun requestTwoFingerSwipe(request: RequestTwoFingerSwipe) =
    gestureController.performTwoFingerSwipe(request)

  override suspend fun requestDrag(request: RequestDrag) {
    val requestId = request.requestId
    val frameContext = request.frameContext
    if (staleFrames.rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.DRAG))
      return
    // The drag reads the resolved durations, so the legacy holdTime/duration fields need no copy.
    gestureController.performDrag(request)
  }

  override suspend fun requestPinch(request: RequestPinch) = gestureController.performPinch(request)

  override suspend fun requestGestureStart(request: RequestGestureStart) =
    gestureController.startStream(request, requester = CommandOriginContext.currentClient())

  override suspend fun requestGestureMove(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
  ) {
    gestureController.moveStream(requestId, gestureId, x, y)
  }

  override suspend fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) {
    gestureController.endStream(
      RequestGestureEnd(
        requestId = requestId,
        gestureId = gestureId,
        x = x,
        y = y,
        cancel = cancel,
      ),
      requester = CommandOriginContext.currentClient(),
    )
  }

  override suspend fun requestSetText(request: RequestSetText) {
    val requestId = request.requestId
    val text = request.text
    val resourceId = request.resourceId
    val dismissKeyboard = request.dismissKeyboard
    val frameContext = request.frameContext

    if (
      staleFrames.rejectStaleFrameContext(requestId, frameContext, StaleFrameContextAction.SET_TEXT)
    )
      return
    textInputController.performSetText(requestId, text, resourceId, dismissKeyboard)
  }

  override suspend fun requestInsertTextState(requestId: String?) =
    textInputController.handleInsertTextState(requestId)

  override suspend fun requestInsertText(request: RequestInsertText) {
    val requestId = request.requestId
    val text = request.text
    val expectedSuffix = request.expectedSuffix
    val acceptsCaretNotPlaced = request.acceptsCaretNotPlaced
    val precedingState = request.precedingState

    textInputController.performInsertText(
      requestId,
      text,
      expectedSuffix,
      acceptsCaretNotPlaced,
      precedingState,
    )
  }

  override suspend fun requestCommitText(request: RequestCommitText) =
    imeController.requestCommitText(request)

  override suspend fun requestCancelImeCommit(requestId: String?, targetRequestId: String) =
    imeController.requestCancelImeCommit(requestId, targetRequestId)

  override suspend fun requestSetKeyboardProfile(requestId: String?, profileId: String) =
    imeController.requestSetKeyboardProfile(requestId, profileId)

  override suspend fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) = imeController.requestListKeyboardProfiles(requestId, supportedCatalogVersions)

  override suspend fun requestImeAction(request: RequestImeAction) {
    val requestId = request.requestId
    val action = request.action
    val frameContext = request.frameContext

    if (
      staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.IME_ACTION,
      )
    )
      return
    textInputController.performImeAction(requestId, action)
  }

  override suspend fun requestSelectAll(requestId: String?) =
    textInputController.performSelectAll(requestId)

  override suspend fun requestClickFocusedInput(requestId: String?) =
    nodeActionController.clickFocusedInputRequest(requestId)

  override suspend fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
    arguments: NodeActionArguments,
  ) = nodeActionController.performNodeAction(requestId, action, resourceId, selector, arguments)

  override suspend fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  ) = nodeActionController.performAccessibilityLinkActivation(requestId, text, occurrence, selector)

  override suspend fun requestClipboard(requestId: String?, action: String, text: String?) =
    clipboardController.performClipboard(requestId, action, text)

  override suspend fun installCaCert(requestId: String?, certificate: String) =
    caCertificateController.performInstallCaCertificate(requestId, certificate)

  override suspend fun installCaCertFromPath(requestId: String?, devicePath: String) =
    caCertificateController.performInstallCaCertificateFromPath(requestId, devicePath)

  override suspend fun removeCaCert(requestId: String?, alias: String?, certificate: String?) =
    caCertificateController.performRemoveCaCertificate(requestId, alias, certificate)

  override suspend fun requestGlobalAction(request: RequestGlobalAction) {
    val requestId = request.requestId
    val action = request.action
    val frameContext = request.frameContext

    if (
      staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.GLOBAL_ACTION,
      )
    )
      return
    globalActionController.performGlobalActionRequest(requestId, action)
  }

  override suspend fun validateFrameContext(requestId: String?, frameContext: String) =
    frameContextGate.validate(requestId, frameContext)

  override suspend fun requestDeviceInfo(requestId: String?) =
    deviceInfoController.performDeviceInfoRequest(requestId)

  override suspend fun getDeviceOwnerStatus(requestId: String?) =
    caCertificateController.performGetDeviceOwnerStatus(requestId)

  override suspend fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) = permissionController.getPermission(requestId, permission, requestPermission)

  override suspend fun setRecompositionTracking(enabled: Boolean) =
    sdkControlController.setRecompositionTrackingEnabled(enabled)

  override suspend fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) {
    accessibilityFlags.apply(
      includeNotImportantViews = includeNotImportantViews,
      reportViewIds = reportViewIds,
      retrieveInteractiveWindows = retrieveInteractiveWindows,
      occlusionEnabled = occlusionEnabled,
    )
  }

  override suspend fun setNetworkMockRules(requestId: String?, rulesJson: String) =
    sdkControlController.broadcastNetworkMockRules(requestId, rulesJson)

  override suspend fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) =
    sdkControlController.broadcastNetworkErrorSimulation(
      enabled,
      errorType,
      limit,
      expiresAtEpochMs,
      remainingMs,
    )

  override suspend fun getCurrentFocus(requestId: String?) =
    focusController.handleGetCurrentFocus(requestId)

  override suspend fun getTraversalOrder(requestId: String?) =
    focusController.handleGetTraversalOrder(requestId)

  override suspend fun addHighlight(
    requestId: String?,
    highlightId: String?,
    shape: HighlightShape?,
  ) = focusController.handleAddHighlight(requestId, highlightId, shape)

  override suspend fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
    appearance: PrototypeAppearanceOverride?,
    replaceOthers: Boolean,
    locale: String?,
  ) {
    launchRequestScope(requestId) {
      prototypeController.show(requestId, spec, displayId, reset, appearance, replaceOthers, locale)
    }
  }

  override suspend fun dismissPrototype(requestId: String?, id: String?, all: Boolean?) {
    launchRequestScope(requestId) { prototypeController.dismiss(requestId, id, all) }
  }

  override suspend fun savePrototype(
    requestId: String?,
    spec: PrototypeSpec,
    label: String,
    icon: String?,
  ) {
    launchRequestScope(requestId) { savedPrototypeController.save(requestId, spec, label, icon) }
  }

  override suspend fun pinSavedPrototype(requestId: String?, id: String, icon: String?) {
    launchRequestScope(requestId) { savedPrototypeController.pin(requestId, id, icon) }
  }

  override suspend fun listSavedPrototypes(requestId: String?) {
    launchRequestScope(requestId) { savedPrototypeController.list(requestId) }
  }

  override suspend fun deleteSavedPrototype(requestId: String?, id: String) {
    launchRequestScope(requestId) { savedPrototypeController.delete(requestId, id) }
  }

  override suspend fun advancePrototypeClock(requestId: String?, id: String, advanceTimeMs: Int) {
    launchRequestScope(requestId) { prototypeController.advanceClock(requestId, id, advanceTimeMs) }
  }

  override suspend fun clearPrototypeStorage(requestId: String?, id: String) {
    launchRequestScope(requestId) { prototypeController.clearStorage(requestId, id) }
  }

  override suspend fun patchPrototype(
    requestId: String?,
    id: String,
    baseRevision: Long?,
    ops: JsonArray,
  ) {
    launchRequestScope(requestId) { prototypeController.patch(requestId, id, baseRevision, ops) }
  }

  override suspend fun inspectPrototypes(requestId: String?) {
    launchRequestScope(requestId) { prototypeController.inspect(requestId) }
  }

  override suspend fun putPrototypeAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) {
    launchRequestScope(requestId) {
      prototypeAssetController.put(requestId, id, mimeType, dataBase64)
    }
  }

  override suspend fun removePrototypeAsset(requestId: String?, id: String) {
    launchRequestScope(requestId) { prototypeAssetController.remove(requestId, id) }
  }

  override suspend fun listPreferenceFiles(requestId: String?, packageName: String) =
    storageController.handleListPreferenceFiles(requestId, packageName)

  override suspend fun getPreferences(requestId: String?, packageName: String, fileName: String) =
    storageController.handleGetPreferences(requestId, packageName, fileName)

  override suspend fun discoverKeystore(requestId: String?, packageName: String) {
    asyncActionRunner.launch(requestId, "discover_keystore") {
      val state =
        dev.jasonpearson.automobile.ctrlproxy.storage.discoverKeystore(this@CtrlProxy, packageName)
      resultSender.send(requestId, "keystore_discovery", attachPerf = false) { _ ->
        dev.jasonpearson.automobile.protocol.KeystoreDiscoveryResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          state = state,
        )
      }
    }
  }

  override suspend fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) {
    asyncActionRunner.launch(requestId, "get_sdk_capabilities") {
      val state =
        dev.jasonpearson.automobile.ctrlproxy.storage.discoverSdkCapabilities(
          this@CtrlProxy,
          packageName,
          userId,
        )
      resultSender.send(requestId, "sdk_capabilities", attachPerf = false) { _ ->
        dev.jasonpearson.automobile.protocol.SdkCapabilitiesResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          state = state,
        )
      }
    }
  }

  override suspend fun listDataStores(
    requestId: String?,
    packageName: String,
    adapterName: String,
  ) = storageController.handleListDataStores(requestId, packageName, adapterName)

  override suspend fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) = storageController.handleGetDataStore(requestId, packageName, adapterName, storeName)

  override suspend fun subscribeStorage(requestId: String?, packageName: String, fileName: String) =
    storageController.handleSubscribeStorage(requestId, packageName, fileName)

  override suspend fun unsubscribeStorage(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) = storageController.handleUnsubscribeStorage(requestId, packageName, fileName)

  override suspend fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = storageController.handleGetPreference(requestId, packageName, fileName, key)

  override suspend fun setPreference(request: SetPreference) =
    storageController.handleSetPreference(request)

  override suspend fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = storageController.handleRemovePreference(requestId, packageName, fileName, key)

  override suspend fun clearPreferences(requestId: String?, packageName: String, fileName: String) =
    storageController.handleClearPreferences(requestId, packageName, fileName)

  override suspend fun startRecording() {
    // Accepted for wire compatibility; currently has no effect on the device.
    Log.d(TAG, "Recording started")
  }

  override suspend fun stopRecording() {
    // Accepted for wire compatibility; currently has no effect on the device.
    Log.d(TAG, "Recording stopped")
  }

  override suspend fun requestSettingsGet(requestId: String?, namespace: String, key: String) =
    settingsController.performSettingsRead(requestId, namespace, key)

  override suspend fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) = settingsController.performSettingsWrite(requestId, namespace, key, value, valueType)

  override suspend fun requestSettingsList(requestId: String?, namespace: String) =
    settingsController.performSettingsList(requestId, namespace)

  override suspend fun requestInstalledPackages(
    requestId: String?,
    includeSystem: Boolean,
    userId: Int?,
  ) = packageController.performInstalledPackages(requestId, includeSystem, userId)

  override suspend fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) = packageController.performPackageInfo(requestId, packageName, includePermissions)

  override suspend fun requestLaunchIntent(requestId: String?, packageName: String) =
    packageController.performLaunchIntent(requestId, packageName)

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
  private fun trackPrototypeForeground(
    event: AccessibilityEvent,
    eventPackage: String?,
    ownWindowType: Int?,
  ) {
    if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
    if (!::prototypeController.isInitialized) return
    if (!prototypeController.isShowing && !prototypeController.isSuspendedByForeground) return
    val windowType =
      if (eventPackage == packageName) ownWindowType
      else
        ownWindowTypeMemo.windowType(event.windowId, retryUnresolvedImmediately = true) {
          ownEventWindowType(event)
        }
    prototypeForeground.onWindowEvent(eventPackage, windowType)
  }

  private fun invalidateOwnWindowTypeMemo(event: AccessibilityEvent) {
    if (event.eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED) return
    val windowChanges =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) event.windowChanges else null
    if (invalidatesOwnWindowTypes(event.eventType, windowChanges)) ownWindowTypeMemo.clear()
  }

  /** The keyboard's reach up from [displayId]'s bottom edge, from its accessibility window. */
  private fun prototypeImeLiftPx(displayId: Int): Int {
    val screen = displayController.getScreenDimensions(displayId) ?: return 0
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
      prototypeRefreshCoalescer.request()
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

    invalidateOwnWindowTypeMemo(event)

    // Prototype animations must not feed the hierarchy debouncer or navigation tracking. Only the
    // own accessibility-overlay windows, or system windows while an app-layer prototype shows, are
    // dropped. The keyboard and MainActivity keep advancing frameContext and hierarchy pushes.
    // This filter touches neither the memo nor prototype state for foreign packages. Unknown types
    // fail open and are retried at a bounded rate by the filter. Prototype foreground tracking also
    // memoises foreign application windows' types, using positive entries only.
    val eventPackage = event.packageName?.toString()
    val ownWindowDecision =
      ownWindowEventDecision(
        OwnWindowEvent(eventPackage, packageName, event.windowId),
        memo = ownWindowTypeMemo,
        appLayerShowing = {
          ::prototypeController.isInitialized && prototypeController.isAppLayerShowing
        },
        resolve = { ownEventWindowType(event) },
      )
    if (ownWindowDecision.skip) return
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
    trackPrototypeForeground(event, eventPackage, ownWindowDecision.windowType)
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
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED ->
          textInputController.forgetRememberedInsert()
        AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED ->
          textInputController.onTextSelectionChanged(event.fromIndex, event.toIndex)
        else -> Unit
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
        frameContextGate.advance()
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
      // classifier) can never drift from what the controller actually acts on.
      work.interaction?.let { interactionEventController.record(event, it) }

      // Delegate to the smart debouncer for content/window changes (same shared classifier). The
      // debouncer uses structural hash comparison to detect animation vs real changes. Gated on an
      // observer (issue #5470): with no client connected, work.refreshesHierarchy is false, so the
      // extraction/hash is skipped. The frameContext token advanced unconditionally above.
      if (work.refreshesHierarchy) {
        hierarchyController.onAccessibilityEvent()
      }
    } catch (e: Exception) {
      Log.e(TAG, "Error handling accessibility event", e)
      // Don't let event handling crash the service
    }
  }

  override fun onInterrupt() {
    Log.w(TAG, "Accessibility service interrupted")
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

  private fun activeDisplayId(): Int = viewHierarchyExtractor.selectDisplayWindows(this).displayId

  private suspend fun handleCommand(intent: Intent) =
    hierarchyExtractCommands.handle(
      if (intent.action == ACTION_EXTRACT_HIERARCHY) {
        ExtractHierarchyCommand(
          uuid = intent.getStringExtra("uuid"),
          textFilter = intent.getStringExtra("text"),
          disableAllFiltering = intent.getBooleanExtra("disableAllFiltering", false),
        )
      } else {
        null
      },
    )

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

  /** Broadcast accessibility action result to WebSocket clients */
  private suspend fun broadcastActionResult(
    requestId: String?,
    action: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    alreadySatisfied: Boolean = false,
  ) {
    resultSender.send(requestId, "action_result") { perfTiming ->
      ActionResult(
        timestamp = System.currentTimeMillis(),
        requestId = requestId,
        success = success,
        action = action,
        totalTimeMs = totalTimeMs,
        error = error,
        perfTiming = perfTiming,
        alreadySatisfied = alreadySatisfied,
      )
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
      prototypeController.withHiddenForCapture {
        dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeIconCapture.atRest {
          screenshotController.takeScreenshotAsync(targetDisplayId)
        }
      }
    else
      PrototypeHiddenCapture(
        dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeIconCapture.atRest {
          screenshotController.takeScreenshotAsync(targetDisplayId)
        },
        prototypeExcluded = true,
      )
}

internal data class ImeFocusCandidate(
  val isEditable: Boolean,
  val isFocusable: Boolean,
  val isVisibleToUser: Boolean,
  val isEnabled: Boolean,
)

internal fun isImeFocusCandidate(row: ImeFocusCandidate): Boolean =
  row.isEditable && row.isFocusable && row.isVisibleToUser && row.isEnabled
