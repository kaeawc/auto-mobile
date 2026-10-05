package dev.jasonpearson.automobile.ctrlproxy

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager

class OverlayManager(
  private val context: Context,
  private val windowManager: WindowManager =
    context.getSystemService(Context.WINDOW_SERVICE) as WindowManager,
  private val canDrawOverlays: (Context) -> Boolean = {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      Settings.canDrawOverlays(it)
    } else {
      true
    }
  },
  private val viewFactory: (Context) -> View = { HighlightOverlayView(it) },
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) {

  companion object {
    private const val TAG = "OverlayManager"

    internal fun resolveCutoutMode(sdkInt: Int): Int? =
      when {
        sdkInt < Build.VERSION_CODES.P -> null
        sdkInt < Build.VERSION_CODES.R ->
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        else -> WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      }
  }

  private var interactiveOverlayAttached = false
  private var overlayView: View? = null
  private var overlayAdded = false
  private var overlayVisible = false
  private var overlayLayoutParams: WindowManager.LayoutParams? = null

  fun show(): Boolean {
    val view = overlayView ?: viewFactory(context).also { overlayView = it }

    if (!overlayAdded) {
      val layoutParams =
        overlayLayoutParams ?: createLayoutParams().also { overlayLayoutParams = it }
      try {
        windowManager.addView(view, layoutParams)
        overlayAdded = true
      } catch (e: Exception) {
        Log.e(TAG, "Failed to add overlay view", e)
        return false
      }
    }

    view.visibility = View.VISIBLE
    overlayVisible = true
    return true
  }

  /**
   * Call on main after interactive addView: highlights use the same accessibility type and are
   * re-added last, above the interactive window. Preserve the view, drawing state and visibility.
   * Dismissal restores the normal permission-based type. Touch/focus flags never change.
   */
  fun setInteractiveOverlayAttached(attached: Boolean): Boolean {
    if (!attached && !interactiveOverlayAttached) return true
    interactiveOverlayAttached = attached
    val view = overlayView
    if (view != null && overlayAdded) {
      try {
        windowManager.removeViewImmediate(view)
      } catch (error: Exception) {
        Log.e(TAG, "Failed to restack highlight overlay", error)
        return false
      }
      overlayAdded = false
    }
    overlayLayoutParams = null
    if (view == null) return true
    val visible = overlayVisible
    val success = show()
    if (!visible) hide()
    return success
  }

  fun hide() {
    overlayView?.let { view ->
      view.visibility = View.GONE
      overlayVisible = false
    }
  }

  fun destroy() {
    val view = overlayView ?: return
    if (overlayAdded) {
      try {
        windowManager.removeViewImmediate(view)
      } catch (e: Exception) {
        Log.e(TAG, "Failed to remove overlay view", e)
      }
    }

    overlayView = null
    overlayAdded = false
    overlayVisible = false
    overlayLayoutParams = null
  }

  internal fun getOverlayViewForTest(): View? = overlayView

  internal fun isOverlayAddedForTest(): Boolean = overlayAdded

  internal fun isOverlayVisibleForTest(): Boolean = overlayVisible

  // Injected sdkInt defaults to the runtime API; resolveCutoutMode guards the API 28+ field.
  @SuppressLint("NewApi")
  private fun createLayoutParams(): WindowManager.LayoutParams {
    val overlayType = resolveOverlayType()
    return WindowManager.LayoutParams(
        WindowManager.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.MATCH_PARENT,
        overlayType,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
          WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
          WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
          WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
      )
      .apply {
        gravity = Gravity.TOP or Gravity.START
        x = 0
        y = 0
        title = "AutoMobile Overlay"
        resolveCutoutMode(sdkInt)?.let { mode -> layoutInDisplayCutoutMode = mode }
        // No setFitInsetsTypes(0): overlay layout flags normally ignore system-bar insets.
      }
  }

  private fun resolveOverlayType(): Int {
    return if (interactiveOverlayAttached) {
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
    } else if (canDrawOverlays(context)) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      Log.w(TAG, "SYSTEM_ALERT_WINDOW not granted; using accessibility overlay.")
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
    }
  }
}
