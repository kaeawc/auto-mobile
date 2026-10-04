package dev.jasonpearson.automobile.sdk.interaction

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import java.lang.ref.WeakReference

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

  /**
   * Catches up the Activity supplied by [context], including through ContextWrapper chains.
   * Application-only initialization cannot discover an already-resumed Activity until a later
   * pause/resume callback (or post-resume on API 29+) supplies it. A fully resumed Activity that
   * remains idle cannot be reached from an Application context alone.
   */
  @MainThread
  internal fun initialize(context: Context, appId: String?) {
    val application = context.applicationContext as? Application ?: return
    this.isInitialized = true
    this.applicationId = appId

    val callbacks =
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

        override fun onActivityStarted(activity: Activity) {}

        override fun onActivityResumed(activity: Activity) {
          // Wrap on resumed, not created — ensures window is fully set up
          // and that we wrap AFTER frameworks like AppCompat set their callback
          wrapWindowCallback(activity)
        }

        override fun onActivityPostResumed(activity: Activity) {
          // API 29+ delivers this after onPostResume, covering registration during onResume.
          wrapWindowCallback(activity)
        }

        override fun onActivityPaused(activity: Activity) {
          // A late Application-only init may first see this Activity pause. Its window is already
          // set up, so catch up now rather than waiting for another resume.
          wrapWindowCallback(activity)
        }

        override fun onActivityStopped(activity: Activity) {}

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

        override fun onActivityDestroyed(activity: Activity) {
          restoreWindowCallback(activity)
          wrappedActivities.remove(activity)
        }
      }
    lifecycleCallbacks = callbacks
    application.registerActivityLifecycleCallbacks(callbacks)

    val activity = findActivity(context) ?: return
    if (
      activity is LifecycleOwner &&
        !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    ) {
      // Initialization from onCreate must allow AppCompat to finish setting up its callback.
      val reference = WeakReference(activity)
      handler.post {
        if (isInitialized && lifecycleCallbacks === callbacks) {
          reference.get()?.let { wrapWindowCallback(it) }
        }
      }
    } else {
      wrapWindowCallback(activity)
    }
  }

  internal fun findActivity(context: Context): Activity? {
    var current = context
    val visited = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Context, Boolean>())
    while (visited.add(current)) {
      if (current is Activity) return current
      current = (current as? ContextWrapper)?.baseContext ?: return null
    }
    return null
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
      restoreWindowCallback(activity)
    }
    wrappedActivities.clear()
    isInitialized = false
    applicationId = null
    lastTapProcessedAt = 0L
  }

  private fun restoreWindowCallback(activity: Activity) {
    try {
      val window = activity.window ?: return
      val current = window.callback
      if (current is ClickTrackingCallback) window.callback = current.delegate
    } catch (error: Exception) {
      AutoMobileSDK.logger.w(TAG, error) { "Could not restore Activity window callback" }
    }
  }

  private fun wrapWindowCallback(activity: Activity) {
    if (activity.isDestroyed || wrappedActivities[activity] == true) return
    val window = activity.window ?: return
    val current = window.callback ?: return

    // Don't double-wrap
    if (current !is ClickTrackingCallback) {
      window.callback = ClickTrackingCallback(current, window)
    }
    wrappedActivities[activity] = true
  }

  /**
   * Window.Callback wrapper that intercepts only dispatchTouchEvent. All other callbacks delegate
   * unchanged via Kotlin's `by delegate`.
   */
  private class ClickTrackingCallback(
    val delegate: Window.Callback,
    private val window: Window,
  ) : Window.Callback by delegate {

    private val tapClassifier = TapGestureClassifier(TAP_SLOP_PX, TAP_TIMEOUT_MS)

    override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
      if (event != null) {
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> {
            tapClassifier.classify(
              TapGestureClassifier.Action.DOWN,
              event.rawX,
              event.rawY,
              event.eventTime,
            )
          }
          MotionEvent.ACTION_UP -> {
            val result =
              tapClassifier.classify(
                TapGestureClassifier.Action.UP,
                event.rawX,
                event.rawY,
                event.eventTime,
              )
            if (result is TapGestureClassifier.Result.Tap) {
              // Post to avoid adding latency to the touch event dispatch
              val tapX = result.x
              val tapY = result.y
              val duration = result.durationMs
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
