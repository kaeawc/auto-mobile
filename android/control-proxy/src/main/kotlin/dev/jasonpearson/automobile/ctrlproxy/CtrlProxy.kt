package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.SystemClock
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
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeDisplays
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPrototypeScreenShapeSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidSavedPrototypeShortcuts
import dev.jasonpearson.automobile.ctrlproxy.prototype.BitmapPrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.ComposePrototypeFontLoader
import dev.jasonpearson.automobile.ctrlproxy.prototype.CoroutinePrototypeScheduler
import dev.jasonpearson.automobile.ctrlproxy.prototype.HostPrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PinnedPrototypeShortcuts
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetDirectory
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetStore
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBase64Decoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeFontCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeForegroundTracker
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeForegroundWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHiddenCapture
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHostLink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImeWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRefreshCoalescer
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStoragePersistence
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStorageStores
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeStores
import dev.jasonpearson.automobile.ctrlproxy.prototype.imeLiftPx
import dev.jasonpearson.automobile.ctrlproxy.prototype.isPrototypeWindow
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeForegroundOrUnscoped
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeIdOfTitle
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeStorageRoot
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.GlobalActionResult
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

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
class CtrlProxy : AccessibilityService() {

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
  internal val prototypePlatform by prototypePlatformDelegate

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
        if (isWebSocketRunning()) {
          webSocketServer.broadcast(response)
        }
      },
      logError = { message, error -> Log.e(TAG, message, error) },
    )

  internal val serviceScope: CoroutineScope =
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
  internal fun launchRequestScope(
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
        if (isWebSocketRunning()) {
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
  internal val resultBroadcaster =
    ResultBroadcaster(
      broadcastError = { response ->
        if (isWebSocketRunning()) {
          webSocketServer.broadcast(response)
        }
      },
      logError = { message, error -> Log.e(TAG, message, error) },
    )
  /**
   * The one path every request result takes to the wire (#11877): running check, broadcast guard,
   * perf flush and routing. Declared ahead of the eagerly built [textInputController].
   */
  private val hierarchyExtractFrames =
    HierarchyExtractFrameSender(
      transport = hierarchyExtractTransport(),
      resultBroadcaster = resultBroadcaster,
    )
  private val resultSender: ResultSender =
    GuardedResultSender(
      transport = guardedResultTransport(),
      resultBroadcaster = resultBroadcaster,
    )
  private val recompositionStore = RecompositionStore()
  private val frameMetricsStore = FrameMetricsStore()
  internal val workStats = CtrlProxyWorkStats()
  internal val viewHierarchyExtractor =
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

  internal val perfProvider = PerfProvider.instance
  private val timeProvider: TimeProvider = SystemTimeProvider()
  internal lateinit var webSocketServer: WebSocketServer
  internal val webSocketLifecycle = ServerLifecycle<WebSocketServer> { it.stop() }
  internal val deviceEvents =
    DeviceEventBroadcaster(
      deviceEventTransport(),
      timeProvider,
    )
  private lateinit var rotationProvenance: RotationProvenanceTracker
  private var deviceStateRegistration: AutoCloseable? = null
  internal val navigationEventAccumulator = NavigationEventAccumulator()
  internal val sdkEventBatchProcessor by lazy {
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
  internal lateinit var prototypeController: PrototypeController

  /** `via: "host"` prototype requests: sent over the socket to the latest connected host. */
  internal val hostPrototypeHttp =
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
  internal val prototypeForeground by lazy {
    PrototypeForegroundTracker(
      CoroutinePrototypeScheduler(serviceScope),
      ownPackage = packageName,
      foregroundNow = ::currentForegroundApp,
      onChanged = { refreshPrototypeWindowNow() },
    )
  }
  internal val prototypeResultSink =
    PrototypeResultBroadcaster(
      prototypeResultTransport(),
      resultBroadcaster,
      AndroidPrototypeScreenShapeSource(this),
    )
  // Asset bytes live in the cache directory, never in the heap; cleared with the prototype session.
  // Assets are owned by the observer session that uploaded them, and file deletion runs on IO so a
  // main-thread clear or lookup never touches the disk.
  internal val prototypeAssets by lazy {
    PrototypeAssetStore(
      PrototypeAssetDirectory(File(cacheDir, "prototype-assets")),
      session = {
        if (::webSocketServer.isInitialized) webSocketServer.observerSessionGeneration() else 0
      },
      fileWorker = Dispatchers.IO.asExecutor(),
    )
  }
  // Decoded bitmaps of stored assets, dropped as soon as the store replaces, removes or clears one.
  internal val prototypeImages by lazy {
    PrototypeImageCache(prototypeAssets, BitmapPrototypeImageDecoder()).also { images ->
      // The store has one listener slot, so fan a change out to both caches.
      prototypeAssets.setChangeListener { ids ->
        images.invalidate(ids)
        prototypeFonts.invalidate(ids)
      }
    }
  }
  // Loaded custom fonts (`fontFamily: {asset}`), dropped when the store changes an asset.
  internal val prototypeFonts by lazy {
    PrototypeFontCache(prototypeAssets, ComposePrototypeFontLoader())
  }
  // Values a spec's storage block keeps across shows (#12522); writes are coalesced on the service
  // scope and hit the disk on IO.
  internal val prototypeStorage by lazy {
    PrototypeStoragePersistence(
      PrototypeStorageStores.inDirectory(prototypeStorageRoot(filesDir)),
      CoroutinePrototypeScheduler(serviceScope),
    )
  }
  internal val savedPrototypeController by lazy {
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
  internal val prototypeAssetController by lazy {
    PrototypeAssetController(
      prototypeAssets,
      prototypeResultSink,
      PrototypeBase64Decoder { Base64.decode(it, Base64.DEFAULT) },
    )
  }
  internal lateinit var overlayManager: OverlayManager
  private val permissionManager by lazy { PermissionManager(this) }
  internal val globalActionController by lazy {
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
  internal val screenshotRequests by lazy {
    ScreenshotRequestHandler(
      host =
        object : ScreenshotRequestHandler.Host {
          override fun isRunning() = isWebSocketRunning()

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
          hierarchyExtractFrames.send(frame)
      },
    )
  }
  internal val permissionController by lazy {
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
  internal val caCertificateController by lazy {
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
  internal val settingsController by lazy {
    SettingsController(
      contentResolver = { contentResolver },
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  internal val packageController by lazy {
    PackageController(
      packageManager = { packageManager },
      currentUserId = CurrentUserId::current,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  internal val storageController by lazy {
    StorageController(
      manager = { storageSubscriptionManager },
      asyncActionRunner = asyncActionRunner,
      resultSender = resultSender,
      timeProvider = timeProvider,
      responseSender =
        object : StorageController.ResponseSender {
          override fun isRunning() = isWebSocketRunning()

          override suspend fun broadcast(message: String) {
            webSocketServer.broadcast(message)
          }

          override fun connectionCount() = webSocketServer.getConnectionCount()
        },
    )
  }
  internal val appDiscovery by lazy {
    AppDiscoveryController(
      source =
        object : AppDiscoveryController.Source {
          override fun resetKeystore(packageName: String, scope: String?, alias: String?) =
            dev.jasonpearson.automobile.ctrlproxy.storage.resetKeystore(
              this@CtrlProxy,
              packageName,
              scope,
              alias,
            )

          override fun keystore(packageName: String) =
            dev.jasonpearson.automobile.ctrlproxy.storage.discoverKeystore(
              this@CtrlProxy,
              packageName,
            )

          override fun sdkCapabilities(packageName: String, userId: Int?) =
            dev.jasonpearson.automobile.ctrlproxy.storage.discoverSdkCapabilities(
              this@CtrlProxy,
              packageName,
              userId,
            )
        },
      asyncActionRunner = asyncActionRunner,
      resultSender = resultSender,
      timeProvider = timeProvider,
    )
  }
  internal val clipboardController by lazy {
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
  internal val deviceInfoController by lazy {
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

          override fun isServerRunning() = isWebSocketRunning()

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
          ) = hierarchyExtractFrames.send(frame, externallyCorrelated)

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

          override fun isServerRunning() = isWebSocketRunning()

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
  internal val nodeActionController by lazy {
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
        },
      perfProvider = perfProvider,
      timeProvider = timeProvider,
      resultSender = resultSender,
    )
  }
  internal val focusController by lazy {
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
  internal val textInputController =
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
  internal val imeController by lazy {
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
  internal val sdkControlController by lazy {
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
            if (isWebSocketRunning()) {
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
  internal val gestureController =
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
  internal val frameContextGate =
    FrameContextGate(
      epoch = UUID.randomUUID().toString(),
      asyncActionRunner = asyncActionRunner,
      timeProvider = timeProvider,
      broadcast = { webSocketServer.broadcast(it) },
    )

  internal val staleFrames =
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

  private val accessibilityEvents =
    AccessibilityEventDispatcher(
      object : AccessibilityEventDispatcher.Host {
        override fun forgetRememberedInsert() = textInputController.forgetRememberedInsert()

        override fun onTextSelectionChanged(fromIndex: Int, toIndex: Int) =
          textInputController.onTextSelectionChanged(fromIndex, toIndex)

        override fun onWindowStateChanged(className: String?) {
          lastWindowClassName = className
        }

        override fun advanceFrameContext() = frameContextGate.advance()

        override fun connectionCount() =
          if (::webSocketServer.isInitialized) webSocketServer.getConnectionCount() else 0

        override fun recordInteraction(event: AccessibilityEvent, dispatch: InteractionDispatch) =
          interactionEventController.record(event, dispatch)

        override fun refreshHierarchy() = hierarchyController.onAccessibilityEvent()
      },
    )

  internal val ownWindowTypeMemo = OwnWindowTypeMemo(nowMs = SystemClock::elapsedRealtime)

  private fun currentFrameContext(): String = frameContextGate.current()

  internal val accessibilityFlags =
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
  internal var navigationEventJob: Job? = null

  // Job for collecting storage change events
  internal var storageChangeJob: Job? = null

  // Storage subscription manager for SharedPreferences inspection
  internal lateinit var storageSubscriptionManager: StorageSubscriptionManager

  // Logcat reader for automatic log capture
  internal var logcatReader: LogcatReader? = null
  internal var logEventBuffer: BoundedLogBuffer? = null

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
      isRunning = { isWebSocketRunning() },
      broadcast = { response -> webSocketServer.broadcast(response) },
    )

  private val packageReceiver =
    PackageEventReceiver(
      serviceScope,
      object : PackageEventHost {
        override fun isSystemApp(packageName: String) =
          packageManager.systemAppFlag(packageName) {
            Log.w(TAG, "Failed to resolve system flag for $packageName", it)
          }

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

  private val displayTransitions =
    DisplayTransitionRelay(
      object : DisplayTransitionRelay.Host {
        override fun launch(block: suspend () -> Unit) {
          serviceScope.launch { block() }
        }

        override fun isPrototypeReady() = ::prototypeController.isInitialized

        override suspend fun prototypeDisplayTransition(displayId: Int, removed: Boolean) {
          prototypeController.onDisplayTransition(displayId, removed)
        }

        override fun isServerRunning() = isWebSocketRunning()

        override suspend fun broadcast(frame: String) = webSocketServer.broadcast(frame)
      },
    )

  override fun onCreate() {
    super.onCreate()
    // Keep the production queue running from service creation, before any connection or request.
    gestureController.startThread()
  }

  // Lazy: needs the service context, and the controller built below outlives reconnects.
  internal val prototypeDisplays by lazy { AndroidPrototypeDisplays(this) }

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
          onTransition = displayTransitions::onTransition,
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
        prototypeController = createPrototypeController()
        // Service start: drop anything a previous process left in the cache directory.
        prototypeAssets.purgeLeftovers()
      }
      overlayManager.setPrototypeAttached(prototypeController.isShowing)

      // Commands first, then the SDK event receivers, before the slower service initialization
      // below. The SDK sender cannot detect an absent dynamic receiver, while
      // SdkEventBatchProcessor retains accepted events until the WebSocket starts.
      for ((name, receiver, filter) in
        listOf(
          Triple("Command", commandReceiver, ReceiverFilters.command()),
          Triple("Navigation event", navigationEventReceiver, ReceiverFilters.navigation()),
          Triple("Event batch", eventBatchReceiver, ReceiverFilters.eventBatch()),
          Triple("Recomposition", recompositionReceiver, ReceiverFilters.recomposition()),
          Triple("Frame metrics", frameMetricsReceiver, ReceiverFilters.frameMetrics()),
          Triple("Package", packageReceiver, ReceiverFilters.packages()),
          Triple(
            "Handled exception",
            handledExceptionReceiver,
            ReceiverFilters.handledException(),
          ),
          Triple("Crash", crashReceiver, ReceiverFilters.crash()),
          Triple("ANR", anrReceiver, ReceiverFilters.anr()),
        )) {
        registerExportedReceiver(receiver, filter)
        Log.d(TAG, "$name receiver registered")
      }

      // Screen on/off and unlock are protected system broadcasts, so this one is not exported. The
      // filter stays inline so lint can see that and accept the flagless registration.
      val screenStateFilter =
        IntentFilter().apply {
          addAction(Intent.ACTION_SCREEN_ON)
          addAction(Intent.ACTION_SCREEN_OFF)
          addAction(Intent.ACTION_USER_PRESENT)
        }
      registerReceiver(screenStateReceiver, screenStateFilter)
      Log.d(TAG, "Screen state receiver registered")

      hierarchyController.start()

      startStorageSubscription()

      startWebSocketServer()

      startEventIngestion()

      startLogcatForwarding()

      Log.d(TAG, "AutoMobile Accessibility Service connected successfully")
    } catch (e: Exception) {
      Log.e(TAG, "Error during service connection", e)
      // Service will continue running even if some initialization fails
    }
  }

  /**
   * Registers a receiver for broadcasts sent from other processes (the SDK in an app under test,
   * the daemon's ADB broadcasts, the package manager), exported as Android 13+ requires.
   */
  internal fun registerExportedReceiver(receiver: BroadcastReceiver, filter: IntentFilter) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(receiver, filter, RECEIVER_EXPORTED)
    } else {
      @SuppressLint("UnspecifiedRegisterReceiverFlag") registerReceiver(receiver, filter)
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

    releaseEach(
      listOf(
        "command" to commandReceiver,
        "navigation event" to navigationEventReceiver,
        "recomposition" to recompositionReceiver,
        "frame metrics" to frameMetricsReceiver,
        "package" to packageReceiver,
        "handled exception" to handledExceptionReceiver,
        "crash" to crashReceiver,
        "ANR" to anrReceiver,
        "event batch" to eventBatchReceiver,
        "screen state" to screenStateReceiver,
      ),
      release = { unregisterReceiver(it) },
      onFailure = { name, e -> Log.e(TAG, "Error unregistering $name receiver", e) },
    )

    if (::rotationProvenance.isInitialized) {
      rotationProvenance.close()
    }
    runCatching { deviceStateRegistration?.close() }
      .onFailure { Log.w(TAG, "Failed to unregister device-state listener", it) }
    deviceStateRegistration = null

    stopLogcatForwarding()

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

    stopEventIngestion()

    stopStorageSubscription()

    // Reset debouncer
    hierarchyController.resetDebouncer()

    stopWebSocketServer()

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

  /** The WebSocket server once [onServiceConnected] has created it; null before then. */
  internal val webSocketServerOrNull: WebSocketServer?
    get() = if (::webSocketServer.isInitialized) webSocketServer else null

  /** Whether the WebSocket server exists and is accepting connections. */
  internal fun isWebSocketRunning(): Boolean = webSocketServerOrNull?.isRunning() == true

  /**
   * The storage subscription manager once [onServiceConnected] has created it; null before then.
   */
  internal val storageSubscriptionManagerOrNull: StorageSubscriptionManager?
    get() = if (::storageSubscriptionManager.isInitialized) storageSubscriptionManager else null

  /** The inbound WebSocket commands, dispatched by [CtrlProxyMessageHandler]. */
  internal val actions: CtrlProxyActions = CtrlProxyActionRouter(this)

  internal fun queuedMessageHandler(
    delegate: WebSocketMessageHandler =
      CtrlProxyMessageHandler(actions = actions, log = { Log.w(TAG, it) }),
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
              isWebSocketRunning() && webSocketServer.hasRequestOwner(requestId)
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
    if (isWebSocketRunning()) {
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

  /** The application in front, from the accessibility windows; null when none qualifies. */
  private fun currentForegroundApp(): String? =
    prototypeForegroundOrUnscoped(
      readWindows = {
        windows.map {
          PrototypeForegroundWindow(it.type, it.isActive, it.root?.packageName?.toString())
        }
      },
      ownPackage = packageName,
    ) {
      Log.w(TAG, "Foreground app unavailable for prototype scoping", it)
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
  internal fun prototypeImeLiftPx(displayId: Int): Int {
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

  internal fun refreshPrototypeWindow() {
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
      accessibilityEvents.dispatch(event)
    } catch (e: Exception) {
      Log.e(TAG, "Error handling accessibility event", e)
      // Don't let event handling crash the service
    }
  }

  override fun onInterrupt() {
    Log.w(TAG, "Accessibility service interrupted")
  }

  private fun activeDisplayId(): Int = viewHierarchyExtractor.selectDisplayWindows(this).displayId

  private suspend fun handleCommand(intent: Intent) =
    hierarchyExtractCommands.handle(extractHierarchyCommand(intent))

  private fun sendResult(success: Boolean, data: String? = null, error: String? = null) =
    sendBroadcast(operationResultIntent(success, data, error, timeProvider.currentTimeMillis()))

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
