package dev.jasonpearson.automobile.sdk

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.FrameMetrics
import android.view.Window
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Collects the host app's real per-frame timing via [Window.OnFrameMetricsAvailableListener] (API
 * 24+) and broadcasts a 1s rollup (fps / average frame time / jank count) to the CtrlProxy,
 * mirroring [RecompositionTracker]'s control-receiver + broadcast shape.
 *
 * Because it runs INSIDE the app process it measures the app's own rendering, unlike the host-side
 * `dumpsys gfxinfo` scrape — the whole point of #5076. It attaches to each foreground Activity
 * window through [Application.ActivityLifecycleCallbacks] and delivers frame callbacks on a
 * dedicated background thread (the API forbids the main thread).
 */
internal object FrameMetricsCollector {
  private const val WINDOW_MS = 1000L
  private const val BROADCAST_INTERVAL_MS = 1000L

  /**
   * A frame slower than one 60Hz refresh interval counts as jank. Conservative default:
   * high-refresh displays render faster, so this never under-counts on 60Hz and only mildly
   * over-counts on 90/120Hz. `FrameMetrics.DEADLINE` (the exact budget) only exists on API 31+, so
   * a fixed threshold keeps the API-24 floor.
   */
  private const val JANK_THRESHOLD_MS = 16.7
  private const val NANOS_PER_MS = 1_000_000.0

  /** Bound on retained frame samples so a stalled broadcast can't grow the queue unbounded. */
  private const val MAX_SAMPLES = 1024

  private val enabled = AtomicBoolean(false)
  private val mainHandler = Handler(Looper.getMainLooper())
  private val controlReceiverRegistrar = NetworkControlReceiverRegistrar { _, intent ->
    if (intent?.action == AutoMobileSDK.ACTION_FRAME_METRICS_CONTROL) {
      setEnabled(intent.getBooleanExtra(AutoMobileSDK.EXTRA_FRAME_METRICS_ENABLED, false))
    }
  }
  private var context: Context? = null
  private var application: Application? = null

  // Frame callbacks must run off the main thread; this is that thread.
  private var metricsThread: HandlerThread? = null
  private var metricsHandler: Handler? = null

  // Timestamped per-frame TOTAL_DURATION values (ms), pruned to WINDOW_MS.
  private val samples = ConcurrentLinkedQueue<FrameSample>()

  // Windows we've attached a listener to, so we can detach exactly once.
  private val attachedWindows =
    Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap<Window, Boolean>()))

  internal data class FrameSample(val t: Long, val durationMs: Double)

  fun initialize(context: Context) {
    if (this.context != null) return
    val app = context.applicationContext
    this.context = app
    if (app is Application) {
      this.application = app
    }
    registerControlReceiver(app)
  }

  /** Tears down all state so resources are released and [initialize] can run again. */
  fun reset() {
    setEnabled(false)
    val ctx = context
    if (ctx != null) {
      controlReceiverRegistrar.unregister(ctx)
    }
    context = null
    application = null
  }

  internal fun isEnabled(): Boolean = enabled.get()

  internal fun setEnabled(isEnabled: Boolean) {
    if (enabled.getAndSet(isEnabled) == isEnabled) {
      return
    }
    if (isEnabled) {
      startMetricsThread()
      application?.registerActivityLifecycleCallbacks(activityCallbacks)
      scheduleBroadcast()
    } else {
      mainHandler.removeCallbacksAndMessages(null)
      application?.unregisterActivityLifecycleCallbacks(activityCallbacks)
      detachAllWindows()
      samples.clear()
      stopMetricsThread()
    }
  }

  private fun startMetricsThread() {
    if (metricsThread != null) return
    val thread = HandlerThread("automobile-frame-metrics").apply { start() }
    metricsThread = thread
    metricsHandler = Handler(thread.looper)
  }

  private fun stopMetricsThread() {
    metricsThread?.quitSafely()
    metricsThread = null
    metricsHandler = null
  }

  private fun scheduleBroadcast() {
    mainHandler.postDelayed(
      object : Runnable {
        override fun run() {
          if (!enabled.get()) return
          broadcastSnapshot()
          mainHandler.postDelayed(this, BROADCAST_INTERVAL_MS)
        }
      },
      BROADCAST_INTERVAL_MS,
    )
  }

  private fun broadcastSnapshot() {
    val ctx = context ?: return
    val now = System.currentTimeMillis()
    val payload = buildSnapshotJson(ctx.packageName, drainWindow(now), now)
    val intent =
      Intent(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT).apply {
        putExtra(AutoMobileSDK.EXTRA_FRAME_METRICS_SNAPSHOT, payload)
        setPackage(SdkConstants.CTRL_PROXY_PACKAGE)
      }
    ctx.sendBroadcast(intent)
  }

  /** Prune samples older than the window and return those still inside it. */
  private fun drainWindow(now: Long): List<FrameSample> {
    val cutoff = now - WINDOW_MS
    while (true) {
      val head = samples.peek() ?: break
      if (head.t >= cutoff) break
      samples.poll()
    }
    return samples.filter { it.t in cutoff..now }
  }

  /**
   * Build the broadcast payload from a window of frame samples. `fps` is `1000 / avgFrameTimeMs`
   * (per-frame smoothness, matching the host's dumpsys derivation and pairing with `jankFrames`).
   * When no frames rendered, only the metadata is present so the host reads fps/jank as unavailable
   * rather than 0. Package-visible and pure for unit testing.
   */
  internal fun buildSnapshotJson(
    applicationId: String,
    window: List<FrameSample>,
    now: Long,
  ): String {
    val json =
      JSONObject()
        .put("timestamp", now)
        .put("applicationId", applicationId)
        .put("totalFrames", window.size)
    if (window.isNotEmpty()) {
      val avgFrameTimeMs = window.sumOf { it.durationMs } / window.size
      val jankFrames = window.count { it.durationMs > JANK_THRESHOLD_MS }
      val fps = if (avgFrameTimeMs > 0) 1000.0 / avgFrameTimeMs else 0.0
      json.put("fps", fps).put("frameTimeMs", avgFrameTimeMs).put("jankFrames", jankFrames)
    }
    return json.toString()
  }

  // ---- per-Activity window attach/detach ----------------------------------

  private val frameListener = Window.OnFrameMetricsAvailableListener { _, frameMetrics, _ ->
    if (!enabled.get()) return@OnFrameMetricsAvailableListener
    val durationMs = frameMetrics.getMetric(FrameMetrics.TOTAL_DURATION) / NANOS_PER_MS
    samples.add(FrameSample(System.currentTimeMillis(), durationMs))
    // Bound the queue; a healthy broadcast prunes it every second.
    while (samples.size > MAX_SAMPLES) {
      samples.poll() ?: break
    }
  }

  private fun attachWindow(window: Window?) {
    val handler = metricsHandler ?: return
    if (window == null || !attachedWindows.add(window)) return
    try {
      window.addOnFrameMetricsAvailableListener(frameListener, handler)
    } catch (_: IllegalStateException) {
      // Window not ready for frame metrics; drop it from the attached set.
      attachedWindows.remove(window)
    }
  }

  private fun detachWindow(window: Window?) {
    if (window == null || !attachedWindows.remove(window)) return
    try {
      window.removeOnFrameMetricsAvailableListener(frameListener)
    } catch (_: IllegalArgumentException) {
      // Listener already removed — safe to ignore.
    }
  }

  private fun detachAllWindows() {
    synchronized(attachedWindows) {
      for (window in attachedWindows.toList()) {
        try {
          window.removeOnFrameMetricsAvailableListener(frameListener)
        } catch (_: IllegalArgumentException) {
          // Already removed.
        }
      }
      attachedWindows.clear()
    }
  }

  private val activityCallbacks =
    object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: Activity) = attachWindow(activity.window)

      override fun onActivityStopped(activity: Activity) = detachWindow(activity.window)

      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

      override fun onActivityResumed(activity: Activity) = Unit

      override fun onActivityPaused(activity: Activity) = Unit

      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

      override fun onActivityDestroyed(activity: Activity) = Unit
    }

  // ---- remote enable/disable control --------------------------------------

  private fun registerControlReceiver(context: Context) {
    controlReceiverRegistrar.register(context) {
      IntentFilter().apply { addAction(AutoMobileSDK.ACTION_FRAME_METRICS_CONTROL) }
    }
  }
}
