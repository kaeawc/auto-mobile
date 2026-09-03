package dev.jasonpearson.automobile.sdk.interaction

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.Window
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.MainThread
import dev.jasonpearson.automobile.sdk.AutoMobileSDK

/**
 * Automatic click tracking for all Activities via Window.Callback chaining.
 *
 * Intercepts dispatchTouchEvent on each Activity's window. On ACTION_UP (when the touch is a tap,
 * not a drag), finds the tapped element via the accessibility node tree and emits an interaction
 * event.
 *
 * Design:
 * - Uses `Window.Callback` delegation (`by delegate`) so ALL other callback methods are forwarded
 *   unchanged. This is the same pattern AppCompat uses.
 * - Chains with existing callbacks — if another library wraps the callback after us, both wrappers
 *   compose correctly via delegation.
 * - Works with Compose, XML Views, React Native, Flutter — any framework that uses Android's
 *   Activity/Window system.
 * - The accessibility node lookup on ACTION_UP adds ~0.1-0.5ms per tap. No overhead on drag/scroll
 *   gestures.
 *
 * Usage: call [initialize] once from AutoMobileSDK.initialize().
 */
internal object AutoMobileClickTracker {

  private const val TAG = "AutoMobileClickTracker"
  private const val TAP_SLOP_PX = 20 // Max movement to still be a tap
  private const val TAP_TIMEOUT_MS = 500L // Max duration for a tap

  /** Minimum interval between accessibility tree traversals to avoid piling up work. */
  private const val TAP_DEBOUNCE_MS = 100L

  private var isInitialized = false
  private var applicationId: String? = null
  private val handler = Handler(Looper.getMainLooper())
  private val wrappedActivities = java.util.WeakHashMap<Activity, Boolean>()
  @Volatile private var lastTapProcessedAt = 0L
  private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null

  @MainThread
  internal fun initialize(application: Application, appId: String?) {
    this.isInitialized = true
    this.applicationId = appId

    val callbacks =
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

        override fun onActivityStarted(activity: Activity) {}

        override fun onActivityResumed(activity: Activity) {
          // Wrap on resumed, not created — ensures window is fully set up
          // and that we wrap AFTER frameworks like AppCompat set their callback
          if (wrappedActivities[activity] != true) {
            wrapWindowCallback(activity)
            wrappedActivities[activity] = true
          }
        }

        override fun onActivityPaused(activity: Activity) {}

        override fun onActivityStopped(activity: Activity) {}

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

        override fun onActivityDestroyed(activity: Activity) {
          wrappedActivities.remove(activity)
        }
      }
    lifecycleCallbacks = callbacks
    application.registerActivityLifecycleCallbacks(callbacks)
  }

  /**
   * Unregisters the activity lifecycle callbacks and clears internal state. Safe to call even if
   * [initialize] was never called.
   */
  fun shutdown(context: Context) {
    val app = context.applicationContext as? Application ?: return
    lifecycleCallbacks?.let { app.unregisterActivityLifecycleCallbacks(it) }
    lifecycleCallbacks = null
    // Restore original Window.Callback on all wrapped activities so
    // tap dispatch no longer goes through SDK wrapper logic.
    for (activity in wrappedActivities.keys.toList()) {
      try {
        val window = activity.window ?: continue
        val current = window.callback
        if (current is ClickTrackingCallback) {
          window.callback = current.delegate
        }
      } catch (_: Exception) {
        // Activity may be finishing — ignore
      }
    }
    wrappedActivities.clear()
    isInitialized = false
    applicationId = null
    lastTapProcessedAt = 0L
  }

  private fun wrapWindowCallback(activity: Activity) {
    val window = activity.window ?: return
    val current = window.callback ?: return

    // Don't double-wrap
    if (current is ClickTrackingCallback) return

    window.callback = ClickTrackingCallback(current, window)
  }

  /**
   * Window.Callback wrapper that intercepts only dispatchTouchEvent. All other callbacks delegate
   * unchanged via Kotlin's `by delegate`.
   */
  private class ClickTrackingCallback(
    val delegate: Window.Callback,
    private val window: Window,
  ) : Window.Callback by delegate {

    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L

    override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
      if (event != null) {
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> {
            downX = event.rawX
            downY = event.rawY
            downTime = System.currentTimeMillis()
          }
          MotionEvent.ACTION_UP -> {
            val duration = System.currentTimeMillis() - downTime
            val dx = event.rawX - downX
            val dy = event.rawY - downY
            // Only track taps, not drags/scrolls
            if (dx * dx + dy * dy < TAP_SLOP_PX * TAP_SLOP_PX && duration < TAP_TIMEOUT_MS) {
              // Post to avoid adding latency to the touch event dispatch
              val tapX = event.rawX
              val tapY = event.rawY
              handler.post { emitTapEvent(tapX, tapY, duration) }
            }
          }
        }
      }
      // Always delegate — we observe, never block
      return delegate.dispatchTouchEvent(event)
    }

    private fun emitTapEvent(x: Float, y: Float, durationMs: Long) {
      if (!isInitialized || !AutoMobileSDK.isTrackingEnabled) return
      val now = System.currentTimeMillis()
      if (now - lastTapProcessedAt < TAP_DEBOUNCE_MS) return
      lastTapProcessedAt = now
      try {
        val decorView = window.decorView
        val info = findDeepestNodeAt(decorView, x.toInt(), y.toInt())

        val props = mutableMapOf<String, String>()
        props["x"] = x.toInt().toString()
        props["y"] = y.toInt().toString()

        if (info != null) {
          info.text?.toString()?.takeIf { it.isNotEmpty() }?.let { props["text"] = it }
          info.contentDescription
            ?.toString()
            ?.takeIf { it.isNotEmpty() }
            ?.let { props["contentDesc"] = it }
          info.viewIdResourceName?.let { props["resourceId"] = it }
          info.className?.toString()?.let { props["className"] = it }
          if (info.isClickable) props["clickable"] = "true"
          info.recycle()
        }

        // Log to logcat so the CtrlProxy logcat reader captures it
        Log.d(TAG, "_auto_tap ${props.entries.joinToString(" ") { "${it.key}=${it.value}" }}")
      } catch (e: Exception) {
        AutoMobileSDK.logger.d(TAG) { "Error tracking tap: ${e.message}" }
      }
    }

    /**
     * Walk the accessibility node tree to find the deepest (most specific) node at the given screen
     * coordinates.
     */
    private fun findDeepestNodeAt(view: View, x: Int, y: Int): AccessibilityNodeInfo? {
      val root =
        try {
          view.createAccessibilityNodeInfo()
        } catch (_: Exception) {
          null
        } ?: return null
      return findDeepest(root, x, y)
    }

    private fun findDeepest(node: AccessibilityNodeInfo, x: Int, y: Int): AccessibilityNodeInfo? {
      val rect = Rect()
      node.getBoundsInScreen(rect)
      if (!rect.contains(x, y)) {
        node.recycle()
        return null
      }
      // Check children (last child = topmost in z-order)
      for (i in node.childCount - 1 downTo 0) {
        val child =
          try {
            node.getChild(i)
          } catch (_: Exception) {
            null
          } ?: continue
        val result = findDeepest(child, x, y)
        if (result != null) {
          node.recycle()
          return result
        }
      }
      return node
    }
  }
}
