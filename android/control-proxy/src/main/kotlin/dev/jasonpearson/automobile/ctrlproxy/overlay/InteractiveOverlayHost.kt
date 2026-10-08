package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.Display
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
import androidx.compose.ui.platform.AbstractComposeView
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.unit.dp
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

const val MIN_TOUCH_THROUGH_SETTLE_MILLIS = 100L
const val DEFAULT_TOUCH_THROUGH_SETTLE_MILLIS = MIN_TOUCH_THROUGH_SETTLE_MILLIS

/**
 * Opacity is a whole-view integer percentage; invalid values throw IllegalArgumentException.
 * [displayId] is the Android logical display the window attaches to; the default display keeps the
 * service context. A request for another display shows there or throws, and never falls back.
 */
data class InteractiveOverlayRequest(
  val placement: OverlayPlacement = OverlayPlacement.Floating(),
  /** True only while a text field is visible: the window is focusable (takes keys) just then. */
  val hasTextField: Boolean = false,
  val opacityPercent: Int = 100,
  val displayId: Int = Display.DEFAULT_DISPLAY,
  /** The window type; changing it on a shown overlay adds a new window rather than relayouting. */
  val layer: OverlayWindowLayer = OverlayWindowLayer.SYSTEM,
  /**
   * The overlay outlives its host session (#10494), so host chrome always shows a close control
   * that a person holding the device can use, whatever the placement.
   */
  val persistent: Boolean = false,
  /** Dark or light host chrome as the spec paints it; null follows the device setting. */
  val darkTheme: Boolean? = null,
  val onHostDismiss: suspend () -> Unit = {},
  val content: @Composable () -> Unit = { InteractiveOverlayTestContent() },
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
interface InteractiveOverlayHost {
  val isShowing: Boolean
  val currentPlacement: OverlayPlacement?
  val isTouchThroughActive: Boolean

  suspend fun show(request: InteractiveOverlayRequest = InteractiveOverlayRequest()): Boolean

  suspend fun replace(request: InteractiveOverlayRequest): Boolean

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
   * failure throws rather than dispatching a gesture that could silently hit the overlay. Failed
   * restoration leaves the active state set and throws; dismissal can recover it. If the window is
   * already detached, update failure clears the window and active state before throwing. Do not
   * nest on the same host.
   */
  suspend fun <T> withTouchThrough(
    settleMillis: Long = DEFAULT_TOUCH_THROUGH_SETTLE_MILLIS,
    block: suspend () -> T,
  ): T
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
 * While a text field is visible the window is focusable, and Back dismisses the overlay through the
 * request's `onHostDismiss` on [backScope], the same `user`-reason path as the fullscreen dismiss
 * row. Back arrives as a key event below API 33 and as an OnBackInvokedCallback (registered through
 * [backRegistrarFactory] only while focusable) from API 33; both call one target. Without a visible
 * text field the window is not focusable and never sees Back at all.
 *
 * [context] must be the service/display context used for the default display; [densityProvider]
 * defaults to its resources. A request for any other display takes its context, WindowManager and
 * density from [displayWindows] (an unknown display throws IllegalArgumentException from show and
 * replace, leaving the current window untouched). Relayout, touch-through and removal always use
 * the window's own display. All other platform access is constructor-injected. No permission probe
 * occurs.
 */
class DefaultInteractiveOverlayHost(
  private val context: Context,
  private val windowManager: WindowManager =
    context.getSystemService(Context.WINDOW_SERVICE) as WindowManager,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
  private val mainThread: OverlayMainThread = AndroidOverlayMainThread(),
  private val settleTimer: OverlaySettleTimer = CoroutineOverlaySettleTimer,
  private val densityProvider: () -> Float = { context.resources.displayMetrics.density },
  private val onWindowAttached: () -> Unit = {},
  private val onWindowLost: () -> Unit = {},
  private val isBlocked: () -> Boolean = { false },
  private val displayWindows: OverlayDisplayWindows = OverlayDisplayWindows { _, _ -> null },
  private val backScope: CoroutineScope =
    CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
  private val backRegistrarFactory: (View) -> OverlayBackCallbackRegistrar = { view ->
    if (sdkInt >= OVERLAY_BACK_CALLBACK_MIN_SDK) AndroidOverlayBackRegistrar(view)
    else NoOverlayBackCallbackRegistrar
  },
) : InteractiveOverlayHost {
  private class Window(
    val view: OverlayComposeView,
    val back: OverlayBackBinding,
    val owner: OverlayWindowOwner,
    val target: OverlayDisplayWindow,
    val displayId: Int,
    var params: WindowManager.LayoutParams,
    var request: InteractiveOverlayRequest,
  )

  @Volatile private var window: Window? = null
  @Volatile private var placement: OverlayPlacement? = null
  @Volatile private var touchThroughToken: Any? = null
  private var destroyed = false
  private val gestureMutex = Mutex()

  override val isShowing: Boolean
    get() = window != null

  override val currentPlacement: OverlayPlacement?
    get() = placement

  override val isTouchThroughActive: Boolean
    get() = touchThroughToken != null

  override suspend fun show(request: InteractiveOverlayRequest): Boolean = mainThread.onMain {
    showOnMain(request)
  }

  override suspend fun replace(request: InteractiveOverlayRequest): Boolean = show(request)

  /**
   * Only the system layer on the default display uses the service's own WindowManager: its default
   * token is the accessibility-overlay token, so a window added through it is stacked like an
   * accessibility overlay whatever its type. An app-layer window there would draw above the
   * notification shade and status bar (#10529), so it gets its own application-overlay window
   * context like any other display.
   */
  private fun windowFor(displayId: Int, layer: OverlayWindowLayer): OverlayDisplayWindow =
    if (displayId == Display.DEFAULT_DISPLAY && layer == OverlayWindowLayer.SYSTEM) {
      OverlayDisplayWindow(
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

  private fun showOnMain(request: InteractiveOverlayRequest): Boolean {
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
      interactiveOverlayLayoutParams(
        request.placement,
        request.hasTextField,
        target.density(),
        sdkInt,
        request.layer,
      )
    if (touchThroughToken != null) {
      params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }
    return if (inPlace != null) updateInPlace(inPlace, request, params)
    else addWindow(target, request, params, replacing = current)
  }

  private fun updateInPlace(
    current: Window,
    request: InteractiveOverlayRequest,
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
   * removed only after the new one is attached, so a failed add leaves the old overlay in place.
   */
  private fun addWindow(
    target: OverlayDisplayWindow,
    request: InteractiveOverlayRequest,
    params: WindowManager.LayoutParams,
    replacing: Window?,
  ): Boolean {
    val owner = OverlayWindowOwner()
    val view =
      OverlayComposeView(target.context, ::backDecision, ::dismissFromBack).apply {
        setViewTreeLifecycleOwner(owner)
        setViewTreeSavedStateRegistryOwner(owner)
        setViewTreeViewModelStoreOwner(owner)
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
      }
    val added =
      Window(
        view,
        OverlayBackBinding(sdkInt, backRegistrarFactory(view), ::dismissFromBack),
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
      Log.e(TAG, "Failed to add interactive overlay", error)
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
      Log.w(TAG, "Superseded interactive overlay was already removed", error)
    }
    old.back.release()
    old.owner.destroy()
    old.view.disposeComposition()
  }

  private fun applyContent(current: Window) {
    val request = current.request
    // Fullscreen chrome never inherits spec opacity, styles, clipping or modal sheets.
    current.view.alpha = overlayHostChrome(request).windowAlpha
    val target = current.target
    current.view.setContent {
      InteractiveOverlayWindowContent(request) {
        overlayInsetFloor(request.placement, target.density(), target.navigationBarBottomPx())
      }
    }
  }

  override suspend fun relayout(): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    if (isBlocked()) return@onMain dismissOnMain()
    relayoutOnMain(current)
  }

  private fun relayoutOnMain(current: Window): Boolean {
    val params =
      interactiveOverlayLayoutParams(
        current.request.placement,
        current.request.hasTextField,
        current.target.density(),
        sdkInt,
        current.request.layer,
      )
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

  private fun backDecision(event: KeyEvent): OverlayBackDecision =
    overlayBackDecision(
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
        Log.w(TAG, "Interactive overlay already detached; clearing window", error)
      } else {
        Log.e(TAG, "Failed to remove interactive overlay; dismissal can be retried", error)
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
                check(update(current, params)) { "Failed to enable overlay touch-through" }
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
                check(update(current, params)) { "Failed to restore overlay touchability" }
              }
              touchThroughToken = null
            }
          }
        }
      }
    }

  private fun update(current: Window, params: WindowManager.LayoutParams): Boolean {
    try {
      current.target.windowManager.updateViewLayout(current.view, params)
    } catch (error: Exception) {
      Log.e(TAG, "Failed to update interactive overlay", error)
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
    private const val TAG = "InteractiveOverlayHost"
  }
}

enum class OverlayBackDecision {
  /** Not ours: let the view tree and the platform handle the key. */
  PASS,

  /** Swallow the key without acting (the down half of a Back press, or a canceled up). */
  CONSUME,

  /** Back completed on a focusable overlay: dismiss it as the user. */
  DISMISS,
}

/**
 * Back reaches the overlay only while its window is focusable, which is exactly while a text field
 * is visible. Dismissal fires once, on the up half of an uncanceled press.
 */
fun overlayBackDecision(
  focusable: Boolean,
  keyCode: Int,
  action: Int,
  canceled: Boolean,
): OverlayBackDecision =
  when {
    !focusable || keyCode != KeyEvent.KEYCODE_BACK -> OverlayBackDecision.PASS
    action == KeyEvent.ACTION_UP && !canceled -> OverlayBackDecision.DISMISS
    else -> OverlayBackDecision.CONSUME
  }

/**
 * The window's root view: the only place a non-activity window sees its Back key event. ComposeView
 * is final, so this mirrors its content hosting (state-held content, composition on attach) on
 * AbstractComposeView and keeps ComposeView's accessibility class name for hierarchy consumers.
 */
internal class OverlayComposeView(
  context: Context,
  private val decide: (KeyEvent) -> OverlayBackDecision,
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
      OverlayBackDecision.PASS -> super.dispatchKeyEvent(event)
      OverlayBackDecision.CONSUME -> true
      OverlayBackDecision.DISMISS -> {
        onBack()
        true
      }
    }
}

/** Temporary hard-coded content until the spec renderer supplies the request slot. */
@Composable
fun InteractiveOverlayTestContent() {
  Box(Modifier.padding(16.dp)) { Text("CtrlProxy interactive overlay") }
}

/**
 * Host chrome is computed from placement and persistence only, outside the author-controlled render
 * tree. [closeVisible] is the compact close control a persistent non-fullscreen overlay carries
 * (fullscreen already has the dismiss row), so nobody holding the device is left without a way to
 * remove an overlay that outlived its session.
 */
data class OverlayHostChrome(
  val dismissVisible: Boolean,
  val windowAlpha: Float,
  val contentAlpha: Float,
  val closeVisible: Boolean = false,
)

fun overlayHostChrome(request: InteractiveOverlayRequest): OverlayHostChrome {
  val fullscreen = request.placement is OverlayPlacement.Fullscreen
  val close = request.persistent && !fullscreen
  // Host controls never inherit spec opacity: only the authored content fades.
  val opaqueWindow = fullscreen || close
  val opacity = request.opacityPercent / 100f
  return OverlayHostChrome(
    fullscreen,
    if (opaqueWindow) 1f else opacity,
    if (opaqueWindow) opacity else 1f,
    closeVisible = close,
  )
}

@Composable
private fun InteractiveOverlayWindowContent(
  request: InteractiveOverlayRequest,
  insetFloor: () -> OverlayInsetFloor,
) {
  // Read again when the configuration changes (rotation), which is when the bar moves.
  val configuration = LocalConfiguration.current
  val floor = remember(request.placement, configuration) { insetFloor() }
  val chrome = overlayHostChrome(request)
  val fullscreen = request.placement as? OverlayPlacement.Fullscreen
  val scope = rememberCoroutineScope()
  if (chrome.dismissVisible) {
    Column(Modifier.fillMaxSize()) {
      // Reserve inset-aware space and clip the spec below it. Modal scrims cannot cover it. The
      // bar is translucent, themed like the spec, and only as tall as its small button (#10437).
      val dismissColors = overlayDismissColors(request.darkTheme ?: isSystemInDarkTheme())
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
          Text("Dismiss AutoMobile overlay", style = MaterialTheme.typography.labelMedium)
        }
      }
      Box(
        Modifier.weight(1f)
          .fillMaxWidth()
          .clipToBounds()
          .alpha(chrome.contentAlpha)
          .background(fullscreen?.scrim ?: Color.Transparent),
      ) {
        CompositionLocalProvider(LocalOverlayInsetFloor provides floor) { request.content() }
      }
    }
  } else if (chrome.closeVisible) {
    Box {
      Box(Modifier.alpha(chrome.contentAlpha)) {
        CompositionLocalProvider(LocalOverlayInsetFloor provides floor) { request.content() }
      }
      // Drawn after the content so authored nodes cannot cover it.
      TextButton(
        onClick = { scope.launch { request.onHostDismiss() } },
        modifier = Modifier.align(Alignment.TopEnd).background(Color.White),
        colors = ButtonDefaults.textButtonColors(contentColor = Color.Black),
      ) {
        Text("Close")
      }
    }
  } else
    Box { CompositionLocalProvider(LocalOverlayInsetFloor provides floor) { request.content() } }
}
