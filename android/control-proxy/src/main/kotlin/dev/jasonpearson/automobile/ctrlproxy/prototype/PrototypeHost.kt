package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.AbstractComposeView
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

const val MIN_TOUCH_THROUGH_SETTLE_MILLIS = 100L
const val DEFAULT_TOUCH_THROUGH_SETTLE_MILLIS = MIN_TOUCH_THROUGH_SETTLE_MILLIS

/** How long a hide waits for the frames that confirm the window is gone before capturing anyway. */
const val DEFAULT_HIDE_FRAME_TIMEOUT_MILLIS = 500L

/** The longest a capture may keep the prototype hidden; the window is restored when it expires. */
const val DEFAULT_MAX_HIDDEN_MILLIS = 5_000L

/** Frames awaited after hiding: the one that applies the hide, then one drawn without it. */
internal const val HIDE_CONFIRM_FRAMES = 2
private const val ESCAPE_PILL_TOP_PADDING_DP = 8

/**
 * A capture taken by [PrototypeHost.withHiddenForCapture]. [prototypeExcluded] is true when no
 * prototype window was showing, or when one was hidden and the confirming frames rendered before
 * the capture; false when the hide could not be confirmed in time (the capture still ran).
 */
data class PrototypeHiddenCapture<T>(val value: T, val prototypeExcluded: Boolean)

/**
 * Opacity is an integer percentage; invalid values throw IllegalArgumentException. Windows with
 * host dismiss controls stay opaque and fade only authored content. [displayId] is the Android
 * logical display the window attaches to; the default display keeps the service context. A request
 * for another display shows there or throws, and never falls back.
 */
data class PrototypeRequest(
  val placement: PrototypePlacement = PrototypePlacement.Floating(),
  /** True only while an editable field is visible; navigation focus is tracked separately. */
  val hasTextField: Boolean = false,
  val opacityPercent: Int = 100,
  val displayId: Int = Display.DEFAULT_DISPLAY,
  /**
   * The window type; changing it on a shown prototype adds a new window rather than relayouting.
   */
  val layer: PrototypeWindowLayer = PrototypeWindowLayer.SYSTEM,
  /** Names the window so the hierarchy can attribute it to this surface. */
  val surfaceId: String? = null,
  /**
   * The prototype outlives its host session (#10494); non-fullscreen windows carry a close control.
   * The controller defaults persistent fullscreen specs to the bar unless chrome is explicit.
   */
  val persistent: Boolean = false,
  /**
   * The show's theme as the controller resolves it, live: host chrome and the content both draw in
   * its mode and follow its changes. Null draws baseline chrome in the device's mode.
   */
  val theme: StateFlow<PrototypeShownTheme>? = null,
  /** Direct host callers retain the legacy bar; the controller resolves the spec default. */
  val chrome: PrototypeWindowChrome = PrototypeWindowChrome.BAR,
  /**
   * The authored surface alone hides the whole window in every reachable mode. The theme is live,
   * so this must account for all reachable palettes, not just the currently shown one.
   */
  val opaqueSurface: Boolean = false,
  /** Foreground scoping belongs to this surface; locks remain a host-wide safety check. */
  val isSuspended: () -> Boolean = { false },
  /** Re-add a re-shown surface above its siblings while retaining its runtime state. */
  val bringToFront: Boolean = false,
  val onHostDismiss: suspend () -> Unit = {},
  /** Navigation takes Back even without an editable field; IME handling stays separate. */
  val transition: String = "none",
  val animateEnter: Boolean = true,
  val exitResources: PrototypeExitResources? = null,
  val exitMetadata: () -> PrototypeWindowMetadata? = { null },
  val motion: String? = null,
  val motionActivity: PrototypeMotionActivity? = null,
  val hasStackBack: Boolean = false,
  val onHostBack: (suspend () -> Unit)? = null,
  val content: @Composable () -> Unit = { PrototypeTestContent() },
) {
  val focusable: Boolean
    get() = hasTextField || hasStackBack

  init {
    require(opacityPercent in 0..100) { "Opacity must be in 0..100" }
    require(displayId >= 0) { "displayId must be non-negative: $displayId" }
  }
}

/**
 * Mutations suspend until executed on main (inline if already there, posted otherwise). Boolean
 * results report platform success; show/replace return false after destroy. Replace without a
 * window behaves as show. Read state is a snapshot, not a cross-thread compound transaction.
 */
interface PrototypeHost {
  /** Best synchronous baseline; the Compose window size corrects it after attachment. */
  @InternalAutoMobilePrototypeApi
  fun initialDeviceState(request: PrototypeRequest): kotlinx.serialization.json.JsonObject =
    kotlinx.serialization.json.JsonObject(emptyMap())

  /** True only during a temporary screenshot hide. */
  val isHiddenForCapture: Boolean
    get() = false

  val isShowing: Boolean
  val currentPlacement: PrototypePlacement?
  val isTouchThroughActive: Boolean

  suspend fun show(request: PrototypeRequest = PrototypeRequest()): Boolean

  suspend fun replace(request: PrototypeRequest): Boolean

  /**
   * Rebuilds only layout params, retaining the composition and its pager/scroll mechanics. A window
   * found detached is cleared and reported as failure (check [isShowing] to tell it from a
   * retryable failure).
   */
  suspend fun relayout(): Boolean

  /**
   * Flips whether the window may take input focus (a text field became visible or hidden) without
   * touching the composition. True when applied or when there is no window; a failure leaves the
   * previous setting, so the caller can retry. A detached window is reported like [relayout].
   */
  suspend fun setTextFieldVisible(visible: Boolean): Boolean

  /** Changes Back focusability without changing text-field or keyboard state. */
  suspend fun setStackBackEnabled(enabled: Boolean): Boolean

  /**
   * Removes immediately, allowing the app to regain focus. A window already detached counts as
   * removed; other failed removals are retryable.
   */
  suspend fun dismiss(): Boolean

  suspend fun dismissImmediately(): Boolean = dismiss()

  /**
   * Terminal for show/replace; dismiss may still retry a failed platform removal. Invalidates
   * pending restores, but does not cancel caller-owned gesture blocks.
   */
  suspend fun destroy(): Boolean

  /** Changes whole-view alpha in place; throws IllegalArgumentException outside 0..100. */
  suspend fun setOpacity(percent: Int)

  /**
   * Serializes gestures, waiting at least 100ms after making the live window untouchable. Restores
   * in NonCancellable, unless dismissed/destroyed. Show/replace preserve touch-through and the
   * active token; restoration clears NOT_TOUCHABLE from the newest layout params. A platform update
   * failure throws rather than dispatching a gesture that could silently hit the prototype. Failed
   * restoration leaves the active state set and throws; dismissal can recover it. If the window is
   * already detached, update failure clears the window and active state before throwing. Do not
   * nest on the same host.
   */
  suspend fun <T> withTouchThrough(
    settleMillis: Long = DEFAULT_TOUCH_THROUGH_SETTLE_MILLIS,
    block: suspend () -> T,
  ): T

  /**
   * Hides the window for one capture (#9305): makes it invisible, waits up to [frameTimeoutMillis]
   * for the frames that confirm it is gone, runs [block], then restores visibility in a
   * NonCancellable finally, also when [block] throws or the caller is cancelled. [block] may keep
   * the window hidden for at most [maxHiddenMillis]; past that it is cancelled, the window is
   * restored and IllegalStateException is thrown. Captures are serialized; without a window,
   * [block] runs as is.
   */
  suspend fun <T> withHiddenForCapture(
    frameTimeoutMillis: Long = DEFAULT_HIDE_FRAME_TIMEOUT_MILLIS,
    maxHiddenMillis: Long = DEFAULT_MAX_HIDDEN_MILLIS,
    block: suspend () -> T,
  ): PrototypeHiddenCapture<T>
}

/**
 * Standalone Compose host; it does not operate the highlight overlay.
 *
 * [onWindowAttached] runs immediately after a successful add. Service wiring re-adds highlights as
 * accessibility overlays so equal-type add order places them above this window; dismissal restores
 * their normal permission-based type. Highlight touch/focus flags stay unchanged. The callback must
 * not throw or re-enter the host.
 *
 * [onWindowLost] runs after an update found the window already detached and cleared it, from any
 * path (relayout, replace, touch-through). Service wiring uses it to schedule the controller's
 * restore-or-abandon pass promptly instead of waiting for an unrelated event. Same constraints.
 *
 * While a text field is visible or a stack can pop the window is focusable. Back first navigates
 * through the controller; without navigation it dismisses the prototype through the request's
 * `onHostDismiss` on [backScope], the same `user`-reason path as the fullscreen dismiss row. Back
 * arrives as a key event below API 33 and as an OnBackInvokedCallback (registered through
 * [backRegistrarFactory] only while focusable) from API 33; both call one target. Without a visible
 * text field or navigated stack the window is not focusable and never sees Back at all.
 *
 * [context] must be the service/display context used for the default display; [densityProvider]
 * defaults to its resources. A request for any other display takes its context, WindowManager and
 * density from [displayWindows] (an unknown display throws IllegalArgumentException from show and
 * replace, leaving the current window untouched). Relayout, touch-through and removal always use
 * the window's own display. All other platform access is constructor-injected. No permission probe
 * occurs.
 */
class DefaultPrototypeHost(
  private val context: Context,
  private val windowManager: WindowManager =
    context.getSystemService(Context.WINDOW_SERVICE) as WindowManager,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
  private val mainThread: PrototypeMainThread = AndroidPrototypeMainThread(),
  private val settleTimer: PrototypeSettleTimer = CoroutinePrototypeSettleTimer,
  private val densityProvider: () -> Float = { context.resources.displayMetrics.density },
  private val onWindowAttached: () -> Unit = {},
  private val onWindowLost: () -> Unit = {},
  private val isBlocked: () -> Boolean = { false },
  private val imeInset: PrototypeImeInset = NoPrototypeImeInset,
  private val displayWindows: PrototypeDisplayWindows = PrototypeDisplayWindows { _, _ -> null },
  private val backScope: CoroutineScope =
    CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
  private val backRegistrarFactory: (View) -> PrototypeBackCallbackRegistrar = { view ->
    if (sdkInt >= PROTOTYPE_BACK_CALLBACK_MIN_SDK) AndroidPrototypeBackRegistrar(view)
    else NoPrototypeBackCallbackRegistrar
  },
  private val frames: PrototypeFrameWaiter = ChoreographerPrototypeFrameWaiter,
  private val escapeSchedulerFactory: (View) -> PrototypeEscapeScheduler =
    ::viewPrototypeEscapeScheduler,
  private val escapeTouchSlop: (Context) -> Int = { ViewConfiguration.get(it).scaledTouchSlop },
  private val dispatchToContent: ((MotionEvent) -> Boolean)? = null,
  private val isViewAttached: (View) -> Boolean = { it.isAttachedToWindow },
) : PrototypeHost {
  private class Window(
    val view: PrototypeComposeView,
    val back: PrototypeBackBinding,
    val owner: PrototypeWindowOwner,
    val target: PrototypeDisplayWindow,
    val displayId: Int,
    var params: WindowManager.LayoutParams,
    var request: PrototypeRequest,
  ) {
    /** A floating window's screen position as its anchored root last placed it (#9316). */
    var anchoredOrigin: IntOffset? = null
    val visible = androidx.compose.runtime.mutableStateOf(true)
  }

  @Volatile private var window: Window? = null
  @Volatile private var placement: PrototypePlacement? = null
  @Volatile private var touchThroughToken: Any? = null
  private var destroyed = false
  private val gestureMutex = Mutex()
  private val captureMutex = Mutex()

  override val isHiddenForCapture: Boolean
    get() = window?.view?.visibility == View.INVISIBLE

  override val isShowing: Boolean
    get() = window != null

  override val currentPlacement: PrototypePlacement?
    get() = placement

  override val isTouchThroughActive: Boolean
    get() = touchThroughToken != null

  override suspend fun show(request: PrototypeRequest): Boolean = mainThread.onMain {
    showOnMain(request)
  }

  override suspend fun replace(request: PrototypeRequest): Boolean = show(request)

  /**
   * Only the system layer on the default display uses the service's own WindowManager: its default
   * token is the accessibility-overlay token, so a window added through it is stacked like an
   * accessibility overlay whatever its type. An app-layer window there would draw above the
   * notification shade and status bar (#10529), so it gets its own application-overlay window
   * context like any other display.
   */
  private fun windowFor(displayId: Int, layer: PrototypeWindowLayer): PrototypeDisplayWindow =
    if (displayId == Display.DEFAULT_DISPLAY && layer == PrototypeWindowLayer.SYSTEM) {
      PrototypeDisplayWindow(
        context,
        windowManager,
        navigationBarBottomPx = { navigationBarBottomPx(windowManager, sdkInt) },
        density = densityProvider,
      )
    } else {
      requireNotNull(displayWindows.open(displayId, layer)) {
        if (displayId == Display.DEFAULT_DISPLAY) "Cannot attach an app-layer window"
        else "Unknown or disconnected display: $displayId"
      }
    }

  @InternalAutoMobilePrototypeApi
  override fun initialDeviceState(
    request: PrototypeRequest,
  ): kotlinx.serialization.json.JsonObject =
    prototypeInitialDeviceState(windowFor(request.displayId, request.layer).context)

  private fun showOnMain(request: PrototypeRequest): Boolean =
    PrototypeTrace.section(PrototypeTrace.HOST_SHOW) {
      if (destroyed || isBlocked() || request.isSuspended()) return@section false
      val current = window
      // An in-place update keeps the window's own display target; a fresh context per update would
      // be created on every non-default-display request only to be discarded. A window's type and
      // accessibility title are fixed at add time, so a layer or surface id change attaches a new
      // window like a display change.
      val inPlace = current?.takeIf {
        it.displayId == request.displayId &&
          it.request.layer == request.layer &&
          it.request.surfaceId == request.surfaceId
      }
      val target = inPlace?.target ?: windowFor(request.displayId, request.layer)
      val params =
        prototypeLayoutParams(
          request.placement,
          request.hasTextField,
          target.density(),
          sdkInt,
          request.layer,
          imeLift(request),
          hasStackBack = request.hasStackBack,
          opaque = prototypeWindowOpaque(request),
          surfaceId = request.surfaceId,
        )
      if (touchThroughToken != null) {
        params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
      }
      // New content places its own anchored root again, so a replaced spec starts from its
      // placement.
      inPlace?.anchoredOrigin = null
      if (inPlace != null && !request.bringToFront) updateInPlace(inPlace, request, params)
      else addWindow(target, request, params, replacing = current)
    }

  /** The keyboard's reach for a bottom sheet; other placements never read it. */
  private fun imeLift(request: PrototypeRequest): Int =
    if (prototypeImeShiftPx(request.placement, 1) == 0) 0
    else
      try {
        imeInset.liftPx(request.displayId)
      } catch (error: Exception) {
        // Best-effort: an unreadable keyboard leaves the sheet at the screen edge, as before.
        Log.w(TAG, "Keyboard bounds unavailable; sheet stays at the screen edge", error)
        0
      }

  private fun updateInPlace(
    current: Window,
    request: PrototypeRequest,
    params: WindowManager.LayoutParams,
  ): Boolean {
    if (!update(current, params)) return false
    current.request = request
    placement = request.placement
    applyContent(current)
    current.back.sync(request.focusable)
    return true
  }

  /**
   * Attaches a new window on the request's display. A window being replaced on another display is
   * removed only after the new one is attached, so a failed add leaves the old prototype in place.
   */
  private fun addWindow(
    target: PrototypeDisplayWindow,
    request: PrototypeRequest,
    params: WindowManager.LayoutParams,
    replacing: Window?,
  ): Boolean {
    val owner = PrototypeWindowOwner()
    val view =
      PrototypeComposeView(
          target.context,
          ::backDecision,
          ::dismissFromBack,
          escapeSchedulerFactory,
          escapeTouchSlop(target.context),
          dispatchToContent,
        )
        .apply {
          setViewTreeLifecycleOwner(owner)
          setViewTreeSavedStateRegistryOwner(owner)
          setViewTreeViewModelStoreOwner(owner)
          setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        }
    val added =
      Window(
        view,
        PrototypeBackBinding(sdkInt, backRegistrarFactory(view), ::dismissFromBack),
        owner,
        target,
        request.displayId,
        params,
        request,
      )
    applyContent(added)
    try {
      target.windowManager.addView(view, params)
    } catch (error: Exception) {
      Log.e(TAG, "Failed to add prototype", error)
      view.releaseEscape()
      owner.destroy()
      view.disposeComposition()
      return false
    }
    window = added
    placement = request.placement
    owner.resume()
    replacing?.let { if (!windowMotionEnabled(it) || !beginExit(it)) retire(it) }
    added.back.sync(request.focusable)
    onWindowAttached()
    return true
  }

  /** Best-effort removal of a window superseded on another display; it is no longer tracked. */
  private fun retire(old: Window) {
    try {
      old.target.windowManager.removeViewImmediate(old.view)
    } catch (error: Exception) {
      // The old display may already be gone, taking its windows with it; nothing else to undo.
      Log.w(TAG, "Superseded prototype was already removed", error)
    }
    old.view.releaseEscape()
    old.back.release()
    old.owner.destroy()
    old.view.disposeComposition()
    old.request.motionActivity?.release(old)
    old.request.exitResources?.release(old.view)
  }

  private fun applyContent(current: Window) {
    val request = current.request
    // Fullscreen chrome never inherits spec opacity, styles, clipping or modal sheets.
    val chrome = prototypeHostChrome(request)
    current.view.alpha = chrome.windowAlpha
    current.view.configureEscape(chrome.escape)
    val target = current.target
    val geometry = windowGeometry(current)
    current.view.setContent {
      CompositionLocalProvider(LocalPrototypeWindowGeometry provides geometry) {
        PrototypeWindowMotion(
          current.visible.value,
          PrototypeWindowMotionSpec(
            request.transition,
            when (request.placement) {
              is PrototypePlacement.Sheet -> "sheet"
              is PrototypePlacement.Floating -> "floating"
              else -> "fullscreen"
            },
            (request.placement as? PrototypePlacement.Sheet)?.edge?.name?.lowercase() ?: "bottom",
            request.motion,
            request.animateEnter,
          ),
          request.motionActivity,
        ) {
          PrototypeWindowContent(request, current.view.escapeState) {
            prototypeInsetFloor(request.placement, target.density(), target.navigationBarBottomPx())
          }
        }
      }
    }
  }

  /**
   * Anchors are screen coordinates: nodes subtract the window's screen origin. A floating window
   * follows its anchored root instead, so it covers the anchor and nothing else (#9316).
   */
  private fun windowGeometry(current: Window): PrototypeWindowGeometry =
    PrototypeWindowGeometry(
      originOnScreen = { prototypeViewWindowOrigin(current.view) },
      moveTo =
        if (current.request.placement is PrototypePlacement.Floating)
          { origin ->
            moveAnchored(current, origin)
          }
        else null,
    )

  /** The current window's geometry, as its content sees it; null without a window. */
  internal fun currentWindowGeometry(): PrototypeWindowGeometry? = window?.let(::windowGeometry)

  /**
   * Called from layout, so the window update is posted rather than re-entering a traversal. An
   * unchanged origin is ignored, which also ends the relayout the move itself causes.
   */
  private fun moveAnchored(current: Window, origin: IntOffset) {
    if (current.anchoredOrigin == origin) return
    current.anchoredOrigin = origin
    mainThread.post {
      if (window !== current || current.anchoredOrigin != origin) return@post
      val params = copyParams(current.params)
      applyAnchoredOrigin(params, origin)
      update(current, params)
    }
  }

  override suspend fun relayout(): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    if (isBlocked() || current.request.isSuspended()) return@onMain dismissOnMain()
    relayoutOnMain(current)
  }

  private fun relayoutOnMain(current: Window): Boolean {
    val params =
      prototypeLayoutParams(
        current.request.placement,
        current.request.hasTextField,
        current.target.density(),
        sdkInt,
        current.request.layer,
        imeLift(current.request),
        hasStackBack = current.request.hasStackBack,
        opaque = prototypeWindowOpaque(current.request),
        surfaceId = current.request.surfaceId,
      )
    current.anchoredOrigin?.let { applyAnchoredOrigin(params, it) }
    if (touchThroughToken != null)
      params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    if (copyParams(current.params).copyFrom(params) == 0 && isViewAttached(current.view))
      return true
    return update(current, params)
  }

  override suspend fun setTextFieldVisible(visible: Boolean): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    val previous = current.request
    if (previous.hasTextField == visible) return@onMain true
    if (!visible) hideKeyboard(current.view)
    current.request = previous.copy(hasTextField = visible)
    val applied = relayoutOnMain(current)
    if (applied) current.back.sync(current.request.focusable) else current.request = previous
    applied
  }

  override suspend fun setStackBackEnabled(enabled: Boolean): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    val previous = current.request
    if (previous.hasStackBack == enabled) return@onMain true
    current.request = previous.copy(hasStackBack = enabled)
    val applied = relayoutOnMain(current)
    if (applied) current.back.sync(current.request.focusable) else current.request = previous
    applied
  }

  /** Still focused here: ask the keyboard to go before the window stops being focusable. */
  @SuppressLint("NewApi")
  private fun hideKeyboard(view: View) {
    if (sdkInt >= 30) view.windowInsetsController?.hide(android.view.WindowInsets.Type.ime())
  }

  private fun backDecision(event: KeyEvent): PrototypeBackDecision =
    prototypeBackDecision(
      window?.request?.focusable == true,
      event.keyCode,
      event.action,
      event.isCanceled,
    )

  /** The one Back target for the key-event path and the predictive-back callback. */
  private fun dismissFromBack() {
    val request = window?.request?.takeIf { it.focusable } ?: return
    backScope.launch { (request.onHostBack ?: request.onHostDismiss)() }
  }

  override suspend fun setOpacity(percent: Int) {
    require(percent in 0..100) { "Opacity must be in 0..100" }
    mainThread.onMain {
      window?.let {
        val previousRequest = it.request
        val newRequest = previousRequest.copy(opacityPercent = percent)
        it.request = newRequest
        if (prototypeWindowOpaque(previousRequest) != prototypeWindowOpaque(newRequest)) {
          relayoutOnMain(it)
        }
        applyContent(it)
      }
    }
  }

  override suspend fun dismiss(): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    if (!windowMotionEnabled(current)) return@onMain dismissOnMain()
    if (!beginExit(current)) return@onMain false
    touchThroughToken = null
    window = null
    placement = null
    true
  }

  override suspend fun dismissImmediately(): Boolean = mainThread.onMain {
    finishExits()
    dismissOnMain()
  }

  private fun finishExits() {
    exiting.toList().forEach(::retire)
    exiting.clear()
  }

  private fun windowMotionEnabled(current: Window): Boolean {
    val resolver = current.target.context.contentResolver
    return current.request.transition != "none" &&
      current.request.motion != "none" &&
      android.provider.Settings.Global.getFloat(
        resolver,
        android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
      ) != 0f &&
      android.provider.Settings.Global.getFloat(
        resolver,
        android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE,
        1f,
      ) != 0f
  }

  private val exiting = mutableSetOf<Window>()

  private fun beginExit(current: Window): Boolean {
    val params = WindowManager.LayoutParams().apply { copyFrom(current.params) }
    params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    if (!update(current, params)) return false
    current.visible.value = false
    current.back.release()
    exiting.add(current)
    current.request.motionActivity?.report(current, true)
    current.request.exitResources?.retain(
      current.view,
      { if (exiting.remove(current)) retire(current) },
      current.request.surfaceId,
      current.request.exitMetadata,
    )
    backScope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
      settleTimer.awaitSettle(400)
      mainThread.onMain { if (exiting.remove(current)) retire(current) }
    }
    return true
  }

  private fun dismissOnMain(): Boolean {
    val current = window ?: return true
    try {
      current.target.windowManager.removeViewImmediate(current.view)
    } catch (error: Exception) {
      if (isNotAttached(error)) {
        Log.w(TAG, "Prototype already detached; clearing window", error)
      } else {
        Log.e(TAG, "Failed to remove prototype; dismissal can be retried", error)
        return false
      }
    }
    clearWindow(current)
    return true
  }

  private fun clearWindow(current: Window) {
    touchThroughToken = null
    window = null
    placement = null
    current.view.releaseEscape()
    current.back.release()
    current.owner.destroy()
    current.view.disposeComposition()
  }

  override suspend fun destroy(): Boolean = mainThread.onMain {
    destroyed = true
    finishExits()
    touchThroughToken = null
    dismissOnMain()
  }

  override suspend fun <T> withTouchThrough(settleMillis: Long, block: suspend () -> T): T =
    gestureMutex.withLock {
      if (window == null) return@withLock block()
      val token = Any()
      try {
        val activated =
          withContext(NonCancellable) {
            mainThread.onMain {
              val current = window
              if (current == null || destroyed) false
              else {
                val params = copyParams(current.params)
                params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                check(update(current, params)) { "Failed to enable prototype touch-through" }
                touchThroughToken = token
                true
              }
            }
          }
        currentCoroutineContext().ensureActive()
        if (activated)
          settleTimer.awaitSettle(settleMillis.coerceAtLeast(MIN_TOUCH_THROUGH_SETTLE_MILLIS))
        currentCoroutineContext().ensureActive()
        block()
      } finally {
        withContext(NonCancellable) {
          mainThread.onMain {
            if (touchThroughToken === token) {
              val current = window
              if (current != null) {
                val params = copyParams(current.params)
                params.flags = params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
                check(update(current, params)) { "Failed to restore prototype touchability" }
              }
              touchThroughToken = null
            }
          }
        }
      }
    }

  override suspend fun <T> withHiddenForCapture(
    frameTimeoutMillis: Long,
    maxHiddenMillis: Long,
    block: suspend () -> T,
  ): PrototypeHiddenCapture<T> = captureMutex.withLock {
    val hidden = withContext(NonCancellable) { mainThread.onMain(::hideForCaptureOnMain) }
    if (hidden == null) return@withLock PrototypeHiddenCapture(block(), prototypeExcluded = true)
    try {
      val confirmed =
        withTimeoutOrNull(frameTimeoutMillis) { frames.awaitFrames(HIDE_CONFIRM_FRAMES) } != null
      if (!confirmed) Log.w(TAG, "Prototype hide unconfirmed after ${frameTimeoutMillis}ms")
      PrototypeHiddenCapture(captureWhileHidden(maxHiddenMillis, block), confirmed)
    } finally {
      withContext(NonCancellable) { restoreAfterCapture(hidden) }
    }
  }

  /** The view hidden for a capture, or null when no window is showing. */
  private fun hideForCaptureOnMain(): View? {
    val current = window ?: return null
    current.view.visibility = View.INVISIBLE
    return current.view
  }

  private suspend fun <T> captureWhileHidden(maxHiddenMillis: Long, block: suspend () -> T): T =
    try {
      withTimeout(maxHiddenMillis) { block() }
    } catch (error: TimeoutCancellationException) {
      throw IllegalStateException(
        "Capture kept the prototype hidden over ${maxHiddenMillis}ms",
        error,
      )
    }

  /**
   * Restores the hidden view itself: an in-place update kept it, and a window that replaced or
   * removed it in the meantime is unaffected (a detached view is harmless to touch). A capture hide
   * never re-shows a blocked prototype (lock screen, or suspended because its app left the
   * front, #10261): a window still attached then is removed as relayout would, and the controller's
   * own restore path shows it again once unblocked.
   */
  private suspend fun restoreAfterCapture(view: View) {
    try {
      mainThread.onMain {
        if (!isBlocked() && window?.request?.isSuspended?.invoke() != true)
          view.visibility = View.VISIBLE
        else if (window?.view === view) dismissOnMain()
      }
    } catch (error: Exception) {
      Log.e(TAG, "Failed to restore prototype after capture", error)
    }
  }

  private fun update(current: Window, params: WindowManager.LayoutParams): Boolean {
    try {
      current.target.windowManager.updateViewLayout(current.view, params)
    } catch (error: Exception) {
      Log.e(TAG, "Failed to update prototype", error)
      if (isNotAttached(error) && window === current) {
        clearWindow(current)
        onWindowLost()
      }
      return false
    }
    current.params = params
    return true
  }

  private fun isNotAttached(error: Exception) = error is IllegalArgumentException

  private fun copyParams(params: WindowManager.LayoutParams) =
    WindowManager.LayoutParams().apply { copyFrom(params) }

  companion object {
    private const val TAG = "PrototypeHost"
  }
}

/** Places a floating window's top-start corner at [origin], in screen px. */
private fun applyAnchoredOrigin(params: WindowManager.LayoutParams, origin: IntOffset) {
  params.gravity = Gravity.TOP or Gravity.START
  params.x = origin.x
  params.y = origin.y
}

enum class PrototypeBackDecision {
  /** Not ours: let the view tree and the platform handle the key. */
  PASS,

  /** Swallow the key without acting (the down half of a Back press, or a canceled up). */
  CONSUME,

  /** Back completed on a focusable prototype: dispatch to its pop-or-dismiss target. */
  DISMISS,
}

/**
 * Back reaches the prototype only while its window is focusable, which is exactly while a text
 * field is visible or stack navigation can pop. Dispatch fires once, on the up half of an
 * uncanceled press.
 */
fun prototypeBackDecision(
  focusable: Boolean,
  keyCode: Int,
  action: Int,
  canceled: Boolean,
): PrototypeBackDecision =
  when {
    !focusable || keyCode != KeyEvent.KEYCODE_BACK -> PrototypeBackDecision.PASS
    action == KeyEvent.ACTION_UP && !canceled -> PrototypeBackDecision.DISMISS
    else -> PrototypeBackDecision.CONSUME
  }

/**
 * The window's root view: the only place a non-activity window sees its Back key event. ComposeView
 * is final, so this mirrors its content hosting (state-held content, composition on attach) on
 * AbstractComposeView and keeps ComposeView's accessibility class name for hierarchy consumers.
 */
internal class PrototypeComposeView(
  context: Context,
  private val decide: (KeyEvent) -> PrototypeBackDecision,
  private val onBack: () -> Unit,
  escapeSchedulerFactory: (View) -> PrototypeEscapeScheduler = ::viewPrototypeEscapeScheduler,
  touchSlop: Int = ViewConfiguration.get(context).scaledTouchSlop,
  private val dispatchToContent: ((MotionEvent) -> Boolean)? = null,
  accessibilitySchedulerFactory: (View) -> PrototypeEscapeScheduler =
    ::viewPrototypeEscapeScheduler,
  nowMs: () -> Long = android.os.SystemClock::uptimeMillis,
) : AbstractComposeView(context) {
  private val content = mutableStateOf<(@Composable () -> Unit)?>(null)
  private val accessibilityCoalescer = PrototypeAccessibilityCoalescer(nowMs)
  private val accessibilityScheduler = accessibilitySchedulerFactory(this)
  private var cancelAccessibilityTrailing: (() -> Unit)? = null
  val escapeState = PrototypeEscapeState()
  private var escapeActive = false
  private var lastTouch: MotionEvent? = null
  private val escapeTracker =
    PrototypeEscapeTracker(touchSlop, escapeSchedulerFactory(this)) {
      // Recognition happens on the view thread, even if stationary fingers produce no MOVE.
      lastTouch?.let { event ->
        val cancel = MotionEvent.obtain(event)
        cancel.action = MotionEvent.ACTION_CANCEL
        try {
          dispatchContent(cancel)
        } finally {
          cancel.recycle()
        }
      }
      escapeState.reveal()
    }

  fun configureEscape(active: Boolean) {
    // In-place content/opacity changes must not interrupt a hold, swallow or pill timeout.
    if (escapeActive == active) return
    releaseEscape()
    escapeActive = active
  }

  fun releaseEscape() {
    escapeActive = false
    escapeTracker.reset()
    lastTouch?.recycle()
    lastTouch = null
    escapeState.hide()
  }

  override fun onDetachedFromWindow() {
    cancelAccessibilityTrailing?.invoke()
    cancelAccessibilityTrailing = null
    accessibilityCoalescer.reset()
    escapeTracker.reset()
    lastTouch?.recycle()
    lastTouch = null
    escapeState.hide()
    super.onDetachedFromWindow()
  }

  override fun onRequestSendAccessibilityEvent(
    child: View,
    event: android.view.accessibility.AccessibilityEvent,
  ): Boolean {
    if (!isCoalescibleAccessibilityEvent(event.eventType, event.contentChangeTypes)) {
      return super.onRequestSendAccessibilityEvent(child, event)
    }
    when (accessibilityCoalescer.onCoalescible()) {
      PrototypeAccessibilityCoalescer.Action.EMIT_NOW -> emitAccessibilitySubtreeChanged()
      PrototypeAccessibilityCoalescer.Action.SCHEDULE_TRAILING -> {
        cancelAccessibilityTrailing =
          accessibilityScheduler.schedule(accessibilityCoalescer.remainingMs()) {
            cancelAccessibilityTrailing = null
            accessibilityCoalescer.onTrailingFired()
            emitAccessibilitySubtreeChanged()
          }
      }
      PrototypeAccessibilityCoalescer.Action.NONE -> Unit
    }
    return false
  }

  private fun emitAccessibilitySubtreeChanged() {
    notifySubtreeAccessibilityStateChanged(
      this,
      this,
      android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE,
    )
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (!escapeActive) return dispatchContent(event)
    lastTouch?.recycle()
    lastTouch = MotionEvent.obtain(event)
    val swallow = escapeTracker.sample(prototypeEscapeAction(event), prototypeEscapePointers(event))
    val handled = if (swallow) true else dispatchContent(event)
    if (
      event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL
    ) {
      lastTouch?.recycle()
      lastTouch = null
    }
    return handled
  }

  private fun dispatchContent(event: MotionEvent): Boolean =
    dispatchToContent?.invoke(event) ?: super.dispatchTouchEvent(event)

  override var shouldCreateCompositionOnAttachedToWindow: Boolean = false
    private set

  @Composable
  override fun Content() {
    content.value?.invoke()
  }

  fun setContent(content: @Composable () -> Unit) {
    shouldCreateCompositionOnAttachedToWindow = true
    this.content.value = content
    if (isAttachedToWindow) createComposition()
  }

  override fun getAccessibilityClassName(): CharSequence = ComposeView::class.java.name

  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    when (decide(event)) {
      PrototypeBackDecision.PASS -> super.dispatchKeyEvent(event)
      PrototypeBackDecision.CONSUME -> true
      PrototypeBackDecision.DISMISS -> {
        onBack()
        true
      }
    }
}

/** A view-local scheduler: no global handler survives removal of the window. */
private fun viewPrototypeEscapeScheduler(view: View) = PrototypeEscapeScheduler { millis, block ->
  val callback = Runnable { block() }
  view.postDelayed(callback, millis)
  return@PrototypeEscapeScheduler {
    view.removeCallbacks(callback)
    Unit
  }
}

private fun prototypeEscapeAction(event: MotionEvent): PrototypeEscapeAction =
  when (event.actionMasked) {
    MotionEvent.ACTION_DOWN -> PrototypeEscapeAction.DOWN
    MotionEvent.ACTION_POINTER_DOWN -> PrototypeEscapeAction.POINTER_DOWN
    MotionEvent.ACTION_POINTER_UP -> PrototypeEscapeAction.POINTER_UP
    MotionEvent.ACTION_UP -> PrototypeEscapeAction.UP
    MotionEvent.ACTION_CANCEL -> PrototypeEscapeAction.CANCEL
    else -> PrototypeEscapeAction.MOVE
  }

private fun prototypeEscapePointers(event: MotionEvent): List<PrototypeEscapePointer> {
  if (
    event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL
  ) {
    return emptyList()
  }
  return (0 until event.pointerCount)
    .filterNot { event.actionMasked == MotionEvent.ACTION_POINTER_UP && it == event.actionIndex }
    .map { PrototypeEscapePointer(event.getPointerId(it), event.getX(it), event.getY(it)) }
}

/** Temporary hard-coded content until the spec renderer supplies the request slot. */
@Composable
fun PrototypeTestContent() {
  Box(Modifier.padding(16.dp)) { Text("CtrlProxy prototype") }
}

/**
 * Host chrome is computed from window options, outside the author-controlled render tree.
 * [closeVisible] is the compact close control a persistent non-fullscreen prototype carries.
 * Fullscreen has a dismiss row or [escape], whose pill and accessibility action let a person remove
 * even a prototype that outlived its session.
 */
data class PrototypeHostChrome(
  val dismissVisible: Boolean,
  val windowAlpha: Float,
  val contentAlpha: Float,
  val closeVisible: Boolean = false,
  val escape: Boolean = false,
)

internal fun prototypeWindowOpaque(request: PrototypeRequest): Boolean =
  request.opaqueSurface &&
    request.placement is PrototypePlacement.Fullscreen &&
    request.opacityPercent == 100 &&
    !prototypeHostChrome(request).dismissVisible

fun prototypeHostChrome(request: PrototypeRequest): PrototypeHostChrome {
  val fullscreen = request.placement is PrototypePlacement.Fullscreen
  val close = request.persistent && !fullscreen
  // Host controls never inherit spec opacity: only the authored content fades.
  val opaqueWindow = fullscreen || close
  val opacity = request.opacityPercent / 100f
  return PrototypeHostChrome(
    fullscreen && request.chrome == PrototypeWindowChrome.BAR,
    if (opaqueWindow) 1f else opacity,
    if (opaqueWindow) opacity else 1f,
    closeVisible = close,
    escape = fullscreen && request.chrome == PrototypeWindowChrome.NONE,
  )
}

@Composable
internal fun PrototypeWindowContent(
  request: PrototypeRequest,
  escapeState: PrototypeEscapeState = remember { PrototypeEscapeState() },
  insetFloor: () -> PrototypeInsetFloor,
) {
  // Read again when the configuration changes (rotation), which is when the bar moves.
  val configuration = LocalConfiguration.current
  val floor = remember(request.placement, configuration) { insetFloor() }
  val chrome = prototypeHostChrome(request)
  val scope = rememberCoroutineScope()
  val shown = request.theme?.collectAsState()?.value
  val touchExploration = prototypeTouchExplorationEnabled()
  val revealCounter = escapeState.revealCounter
  LaunchedEffect(revealCounter, chrome.escape, touchExploration) {
    if (chrome.escape && escapeState.revealed && !touchExploration) {
      delay(PROTOTYPE_ESCAPE_PILL_MILLIS)
      escapeState.hide()
    }
  }
  PrototypeHostTheme(shown) {
    PrototypeChrome(request, chrome, floor, scope, escapeState.revealed || touchExploration)
  }
}

@Composable
private fun PrototypeChrome(
  request: PrototypeRequest,
  chrome: PrototypeHostChrome,
  floor: PrototypeInsetFloor,
  scope: CoroutineScope,
  escapeVisible: Boolean,
) {
  val fullscreen = request.placement as? PrototypePlacement.Fullscreen
  if (chrome.dismissVisible) {
    Column(Modifier.fillMaxSize()) {
      // Reserve inset-aware space and clip the spec below it. Modal scrims cannot cover it. The
      // bar is translucent, themed like the spec, and only as tall as its close chip's hit target
      // (#10437, #15119).
      val dismissColors = prototypeDismissColors(MaterialTheme.colorScheme)
      Box(
        Modifier.fillMaxWidth()
          .background(dismissColors.background)
          .windowInsetsPadding(
            WindowInsets.systemBars
              .union(WindowInsets.displayCutout)
              .only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
          ),
      ) {
        PrototypeCloseChip(
          onClick = { scope.launch { request.onHostDismiss() } },
          modifier = Modifier.align(Alignment.CenterEnd),
        )
      }
      Box(
        Modifier.weight(1f)
          .fillMaxWidth()
          .clipToBounds()
          .alpha(chrome.contentAlpha)
          .background(
            prototypeThemedScrim(fullscreen?.scrim, fullscreen?.scrimSpec) ?: Color.Transparent,
          ),
      ) {
        CompositionLocalProvider(
          LocalPrototypeInsetFloor provides floor,
          LocalPrototypeFillsWindow provides true,
        ) {
          request.content()
        }
      }
    }
  } else if (chrome.escape) {
    PrototypeChromelessContent(request, chrome, floor, scope, escapeVisible)
  } else if (chrome.closeVisible) {
    Box {
      // Not `alpha`, which clips to this wrap-content box: anchored nodes are drawn outside it.
      Box(Modifier.graphicsLayer { alpha = chrome.contentAlpha }) {
        CompositionLocalProvider(LocalPrototypeInsetFloor provides floor) { request.content() }
      }
      // Drawn after the content so authored nodes cannot cover it.
      PrototypeCloseChip(
        onClick = { scope.launch { request.onHostDismiss() } },
        modifier =
          Modifier.align(Alignment.TopEnd)
            .windowInsetsPadding(
              WindowInsets.systemBars
                .union(WindowInsets.displayCutout)
                .only(WindowInsetsSides.Top + WindowInsetsSides.End),
            ),
      )
    }
  } else
    Box { CompositionLocalProvider(LocalPrototypeInsetFloor provides floor) { request.content() } }
}

/** Observe TalkBack changes for this composition, and release the platform listener with it. */
@Composable
private fun prototypeTouchExplorationEnabled(): Boolean {
  val context = LocalContext.current
  val manager =
    remember(context) {
      context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    }
  var enabled by remember(manager) { mutableStateOf(manager.isTouchExplorationEnabled) }
  DisposableEffect(manager) {
    val listener = AccessibilityManager.TouchExplorationStateChangeListener { enabled = it }
    manager.addTouchExplorationStateChangeListener(listener)
    enabled = manager.isTouchExplorationEnabled
    onDispose { manager.removeTouchExplorationStateChangeListener(listener) }
  }
  return enabled
}

@Composable
private fun PrototypeChromelessContent(
  request: PrototypeRequest,
  chrome: PrototypeHostChrome,
  floor: PrototypeInsetFloor,
  scope: CoroutineScope,
  escapeVisible: Boolean,
) {
  val fullscreen = request.placement as PrototypePlacement.Fullscreen
  // Keep dismiss semantics on an unfaded host wrapper, accessible even at opacity zero.
  Box(
    Modifier.fillMaxSize().semantics {
      dismiss(label = "Dismiss AutoMobile prototype") {
        scope.launch { request.onHostDismiss() }
        true
      }
    },
  ) {
    Box(
      Modifier.fillMaxSize()
        .clipToBounds()
        .alpha(chrome.contentAlpha)
        .background(
          prototypeThemedScrim(fullscreen.scrim, fullscreen.scrimSpec) ?: Color.Transparent,
        ),
    ) {
      CompositionLocalProvider(
        LocalPrototypeFillsWindow provides true,
        LocalPrototypeInsetFloor provides floor,
      ) {
        request.content()
      }
    }
    if (escapeVisible) {
      Box(
        Modifier.align(Alignment.TopCenter)
          .windowInsetsPadding(
            WindowInsets.systemBars
              .union(WindowInsets.displayCutout)
              .only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
          )
          .padding(top = ESCAPE_PILL_TOP_PADDING_DP.dp),
      ) {
        val colors = prototypeCloseColors(MaterialTheme.colorScheme)
        TextButton(
          onClick = { scope.launch { request.onHostDismiss() } },
          modifier = Modifier.background(colors.background, CircleShape),
          colors = ButtonDefaults.textButtonColors(contentColor = colors.content),
        ) {
          Text("Dismiss AutoMobile prototype", style = MaterialTheme.typography.labelMedium)
        }
      }
    }
  }
}
