package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.Context
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.unit.dp
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import kotlinx.coroutines.NonCancellable
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
  val hasTextField: Boolean = false,
  val opacityPercent: Int = 100,
  val displayId: Int = Display.DEFAULT_DISPLAY,
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
  private val displayWindows: OverlayDisplayWindows = OverlayDisplayWindows { null },
) : InteractiveOverlayHost {
  private class Window(
    val view: ComposeView,
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

  private fun windowFor(displayId: Int): OverlayDisplayWindow =
    if (displayId == Display.DEFAULT_DISPLAY) {
      OverlayDisplayWindow(context, windowManager, densityProvider)
    } else {
      requireNotNull(displayWindows.open(displayId)) {
        "Unknown or disconnected display: $displayId"
      }
    }

  private fun showOnMain(request: InteractiveOverlayRequest): Boolean {
    if (destroyed || isBlocked()) return false
    val current = window
    // An in-place update keeps the window's own display target; a fresh context per update would
    // be created on every non-default-display request only to be discarded.
    val inPlace = current?.takeIf { it.displayId == request.displayId }
    val target = inPlace?.target ?: windowFor(request.displayId)
    val params =
      interactiveOverlayLayoutParams(
        request.placement,
        request.hasTextField,
        target.density(),
        sdkInt,
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
      ComposeView(target.context).apply {
        setViewTreeLifecycleOwner(owner)
        setViewTreeSavedStateRegistryOwner(owner)
        setViewTreeViewModelStoreOwner(owner)
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
      }
    val added = Window(view, owner, target, request.displayId, params, request)
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
    old.owner.destroy()
    old.view.disposeComposition()
  }

  private fun applyContent(current: Window) {
    val request = current.request
    // Fullscreen chrome never inherits spec opacity, styles, clipping or modal sheets.
    current.view.alpha = overlayHostChrome(request).windowAlpha
    current.view.setContent { InteractiveOverlayWindowContent(request) }
  }

  override suspend fun relayout(): Boolean = mainThread.onMain {
    val current = window ?: return@onMain true
    if (isBlocked()) return@onMain dismissOnMain()
    val params =
      interactiveOverlayLayoutParams(
        current.request.placement,
        current.request.hasTextField,
        current.target.density(),
        sdkInt,
      )
    if (touchThroughToken != null)
      params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    update(current, params)
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

/** Temporary hard-coded content until the spec renderer supplies the request slot. */
@Composable
fun InteractiveOverlayTestContent() {
  Box(Modifier.padding(16.dp)) { Text("CtrlProxy interactive overlay") }
}

/** Host chrome is computed from placement only, outside the author-controlled render tree. */
data class OverlayHostChrome(
  val dismissVisible: Boolean,
  val windowAlpha: Float,
  val contentAlpha: Float,
)

fun overlayHostChrome(request: InteractiveOverlayRequest): OverlayHostChrome {
  val fullscreen = request.placement is OverlayPlacement.Fullscreen
  val opacity = request.opacityPercent / 100f
  return OverlayHostChrome(
    fullscreen,
    if (fullscreen) 1f else opacity,
    if (fullscreen) opacity else 1f,
  )
}

@Composable
private fun InteractiveOverlayWindowContent(request: InteractiveOverlayRequest) {
  val chrome = overlayHostChrome(request)
  val fullscreen = request.placement as? OverlayPlacement.Fullscreen
  val scope = rememberCoroutineScope()
  if (chrome.dismissVisible) {
    Column(Modifier.fillMaxSize()) {
      // Reserve opaque, inset-aware space and clip the spec below it. Modal scrims cannot cover it.
      Box(
        Modifier.fillMaxWidth()
          .background(Color.White)
          .windowInsetsPadding(
            WindowInsets.systemBars
              .union(WindowInsets.displayCutout)
              .only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
          )
      ) {
        TextButton(
          onClick = { scope.launch { request.onHostDismiss() } },
          modifier = Modifier.align(Alignment.CenterEnd),
          colors = ButtonDefaults.textButtonColors(contentColor = Color.Black),
        ) {
          Text("Dismiss AutoMobile overlay")
        }
      }
      Box(
        Modifier.weight(1f)
          .fillMaxWidth()
          .clipToBounds()
          .alpha(chrome.contentAlpha)
          .background(fullscreen?.scrim ?: Color.Transparent)
      ) {
        request.content()
      }
    }
  } else Box { request.content() }
}
