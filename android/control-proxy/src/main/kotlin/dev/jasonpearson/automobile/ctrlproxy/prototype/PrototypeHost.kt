package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.AbstractComposeView
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import dev.jasonpearson.automobile.protocol.PrototypeSpecTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
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

/**
 * A capture taken by [PrototypeHost.withHiddenForCapture]. [prototypeExcluded] is true when no
 * prototype window was showing, or when one was hidden and the confirming frames rendered before
 * the capture; false when the hide could not be confirmed in time (the capture still ran).
 */
data class PrototypeHiddenCapture<T>(val value: T, val prototypeExcluded: Boolean)

/**
 * Opacity is a whole-view integer percentage; invalid values throw IllegalArgumentException.
 * [displayId] is the Android logical display the window attaches to; the default display keeps the
 * service context. A request for another display shows there or throws, and never falls back.
 */
data class PrototypeRequest(
  val placement: PrototypePlacement = PrototypePlacement.Floating(),
  /** True only while a text field is visible: the window is focusable (takes keys) just then. */
  val hasTextField: Boolean = false,
  val opacityPercent: Int = 100,
  val displayId: Int = Display.DEFAULT_DISPLAY,
  /**
   * The window type; changing it on a shown prototype adds a new window rather than relayouting.
   */
  val layer: PrototypeWindowLayer = PrototypeWindowLayer.SYSTEM,
  /**
   * The prototype outlives its host session (#10494), so host chrome always shows a close control
   * that a person holding the device can use, whatever the placement.
   */
  val persistent: Boolean = false,
  /** Dark or light host chrome as the spec paints it; null follows the device setting. */
  val darkTheme: Boolean? = null,
  /** The spec's render root and theme, so host chrome follows the spec; null uses the baseline. */
  val themeRoot: PrototypeRenderNode? = null,
  val specTheme: PrototypeSpecTheme? = null,
  val onHostDismiss: suspend () -> Unit = {},
  val content: @Composable () -> Unit = { PrototypeTestContent() },
) {
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

  /**
   * Removes immediately, allowing the app to regain focus. A window already detached counts as
   * removed; other failed removals are retryable.
   */
  suspend fun dismiss(): Boolean

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
 * While a text field is visible the window is focusable, and Back dismisses the prototype through
 * the request's `onHostDismiss` on [backScope], the same `user`-reason path as the fullscreen
 * dismiss row. Back arrives as a key event below API 33 and as an OnBackInvokedCallback (registered
 * through [backRegistrarFactory] only while focusable) from API 33; both call one target. Without a
 * visible text field the window is not focusable and never sees Back at all.
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
  }

  @Volatile private var window: Window? = null
  @Volatile private var placement: PrototypePlacement? = null
  @Volatile private var touchThroughToken: Any? = null
  private var destroyed = false
  private val gestureMutex = Mutex()
  private val captureMutex = Mutex()

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

  private fun showOnMain(request: PrototypeRequest): Boolean {
    if (destroyed || isBlocked()) return false
    val current = window
    // An in-place update keeps the window's own display target; a fresh context per update would
    // be created on every non-default-display request only to be discarded. A window's type cannot
    // change after it is added, so a layer change attaches a new window like a display change.
    val inPlace = current?.takeIf {
      it.displayId == request.displayId && it.request.layer == request.layer
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
      )
    if (touchThroughToken != null) {
      params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }
    // New content places its own anchored root again, so a replaced spec starts from its placement.
    inPlace?.anchoredOrigin = null
    return if (inPlace != null) updateInPlace(inPlace, request, params)
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
    current.back.sync(request.hasTextField)
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
      PrototypeComposeView(target.context, ::backDecision, ::dismissFromBack).apply {
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
      owner.destroy()
      view.disposeComposition()
      return false
    }
    window = added
    placement = request.placement
    owner.resume()
    replacing?.let(::retire)
    added.back.sync(request.hasTextField)
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
    old.back.release()
    old.owner.destroy()
    old.view.disposeComposition()
  }

  private fun applyContent(current: Window) {
    val request = current.request
    // Fullscreen chrome never inherits spec opacity, styles, clipping or modal sheets.
    current.view.alpha = prototypeHostChrome(request).windowAlpha
    val target = current.target
    val geometry = windowGeometry(current)
    current.view.setContent {
      CompositionLocalProvider(LocalPrototypeWindowGeometry provides geometry) {
        PrototypeWindowContent(request) {
          prototypeInsetFloor(request.placement, target.density(), target.navigationBarBottomPx())
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
    if (isBlocked()) return@onMain dismissOnMain()
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
      )
    current.anchoredOrigin?.let { applyAnchoredOrigin(params, it) }
    if (touchThroughToken != null)
      params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    return update(current, params)
  }

  override suspend fun setTextFieldVisible(visible: Boolean): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    val previous = current.request
    if (previous.hasTextField == visible) return@onMain true
    if (!visible) hideKeyboard(current.view)
    current.request = previous.copy(hasTextField = visible)
    val applied = relayoutOnMain(current)
    if (applied) current.back.sync(visible) else current.request = previous
    applied
  }

  /** Still focused here: ask the keyboard to go before the window stops being focusable. */
  @SuppressLint("NewApi")
  private fun hideKeyboard(view: View) {
    if (sdkInt >= 30) view.windowInsetsController?.hide(android.view.WindowInsets.Type.ime())
  }

  private fun backDecision(event: KeyEvent): PrototypeBackDecision =
    prototypeBackDecision(
      window?.request?.hasTextField == true,
      event.keyCode,
      event.action,
      event.isCanceled,
    )

  /** The one Back target for the key-event path and the predictive-back callback. */
  private fun dismissFromBack() {
    val request = window?.request?.takeIf { it.hasTextField } ?: return
    backScope.launch { request.onHostDismiss() }
  }

  override suspend fun setOpacity(percent: Int) {
    require(percent in 0..100) { "Opacity must be in 0..100" }
    mainThread.onMain {
      window?.let {
        it.request = it.request.copy(opacityPercent = percent)
        applyContent(it)
      }
    }
  }

  override suspend fun dismiss(): Boolean = mainThread.onMain { dismissOnMain() }

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
    current.back.release()
    current.owner.destroy()
    current.view.disposeComposition()
  }

  override suspend fun destroy(): Boolean = mainThread.onMain {
    destroyed = true
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
        if (!isBlocked()) view.visibility = View.VISIBLE
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
      if (isNotAttached(error)) {
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

  /** Back completed on a focusable prototype: dismiss it as the user. */
  DISMISS,
}

/**
 * Back reaches the prototype only while its window is focusable, which is exactly while a text
 * field is visible. Dismissal fires once, on the up half of an uncanceled press.
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
) : AbstractComposeView(context) {
  private val content = mutableStateOf<(@Composable () -> Unit)?>(null)

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

/** Temporary hard-coded content until the spec renderer supplies the request slot. */
@Composable
fun PrototypeTestContent() {
  Box(Modifier.padding(16.dp)) { Text("CtrlProxy prototype") }
}

/**
 * Host chrome is computed from placement and persistence only, outside the author-controlled render
 * tree. [closeVisible] is the compact close control a persistent non-fullscreen prototype carries
 * (fullscreen already has the dismiss row), so nobody holding the device is left without a way to
 * remove a prototype that outlived its session.
 */
data class PrototypeHostChrome(
  val dismissVisible: Boolean,
  val windowAlpha: Float,
  val contentAlpha: Float,
  val closeVisible: Boolean = false,
)

fun prototypeHostChrome(request: PrototypeRequest): PrototypeHostChrome {
  val fullscreen = request.placement is PrototypePlacement.Fullscreen
  val close = request.persistent && !fullscreen
  // Host controls never inherit spec opacity: only the authored content fades.
  val opaqueWindow = fullscreen || close
  val opacity = request.opacityPercent / 100f
  return PrototypeHostChrome(
    fullscreen,
    if (opaqueWindow) 1f else opacity,
    if (opaqueWindow) opacity else 1f,
    closeVisible = close,
  )
}

@Composable
internal fun PrototypeWindowContent(
  request: PrototypeRequest,
  insetFloor: () -> PrototypeInsetFloor,
) {
  // Read again when the configuration changes (rotation), which is when the bar moves.
  val configuration = LocalConfiguration.current
  val floor = remember(request.placement, configuration) { insetFloor() }
  val chrome = prototypeHostChrome(request)
  val scope = rememberCoroutineScope()
  PrototypeHostTheme(
    request.themeRoot,
    request.specTheme,
    request.darkTheme ?: isSystemInDarkTheme(),
  ) {
    PrototypeChrome(request, chrome, floor, scope)
  }
}

@Composable
private fun PrototypeChrome(
  request: PrototypeRequest,
  chrome: PrototypeHostChrome,
  floor: PrototypeInsetFloor,
  scope: CoroutineScope,
) {
  val fullscreen = request.placement as? PrototypePlacement.Fullscreen
  if (chrome.dismissVisible) {
    Column(Modifier.fillMaxSize()) {
      // Reserve inset-aware space and clip the spec below it. Modal scrims cannot cover it. The
      // bar is translucent, themed like the spec, and only as tall as its small button (#10437).
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
        TextButton(
          onClick = { scope.launch { request.onHostDismiss() } },
          modifier = Modifier.align(Alignment.CenterEnd).height(32.dp),
          contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
          colors = ButtonDefaults.textButtonColors(contentColor = dismissColors.content),
        ) {
          Text("Dismiss AutoMobile prototype", style = MaterialTheme.typography.labelMedium)
        }
      }
      Box(
        Modifier.weight(1f)
          .fillMaxWidth()
          .clipToBounds()
          .alpha(chrome.contentAlpha)
          .background(
            prototypeThemedColor(fullscreen?.scrim, fullscreen?.scrimSpec) ?: Color.Transparent,
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
  } else if (chrome.closeVisible) {
    Box {
      // Not `alpha`, which clips to this wrap-content box: anchored nodes are drawn outside it.
      Box(Modifier.graphicsLayer { alpha = chrome.contentAlpha }) {
        CompositionLocalProvider(LocalPrototypeInsetFloor provides floor) { request.content() }
      }
      // Drawn after the content so authored nodes cannot cover it.
      val closeColors = prototypeCloseColors(MaterialTheme.colorScheme)
      TextButton(
        onClick = { scope.launch { request.onHostDismiss() } },
        modifier = Modifier.align(Alignment.TopEnd).background(closeColors.background),
        colors = ButtonDefaults.textButtonColors(contentColor = closeColors.content),
      ) {
        Text("Close")
      }
    }
  } else
    Box { CompositionLocalProvider(LocalPrototypeInsetFloor provides floor) { request.content() } }
}
