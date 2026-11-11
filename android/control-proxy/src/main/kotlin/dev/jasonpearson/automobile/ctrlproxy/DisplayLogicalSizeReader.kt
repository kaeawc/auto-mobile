package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.WindowManager
import java.util.concurrent.ConcurrentHashMap

internal fun interface DisplayLogicalSizeReader {
  /**
   * Effective logical display size in current rotation, independent of the process configuration;
   * null when unavailable or non-positive.
   */
  fun read(display: Display): Point?
}

/** Delivers the ids of removed displays until the returned handle is closed. */
internal fun interface DisplayRemovalSignal {
  /** Starts delivery; null when removals cannot be observed. */
  fun register(onRemoved: (Int) -> Unit): AutoCloseable?
}

/**
 * Reads the logical size through one window-context [WindowManager] per display, created on first
 * read and dropped when the display is removed, a read fails, or the reader closes. Without a
 * removal signal it falls back to a fresh window context per read. Every runtime failure returns
 * null so the caller falls back to the mode size; nothing escapes into the accessibility service.
 */
internal class CachingDisplayLogicalSizeReader(
  private val windowManagerFor: (Display) -> WindowManager?,
  private val removalSignal: DisplayRemovalSignal,
  private val sdkInt: () -> Int = { Build.VERSION.SDK_INT },
) : DisplayLogicalSizeReader, AutoCloseable {
  private val windowManagers = ConcurrentHashMap<Int, WindowManager>()
  private val lock = Any()
  private var removalHandle: AutoCloseable? = null
  private var removalUnavailable = false
  private var closed = false

  override fun read(display: Display): Point? {
    if (sdkInt() < Build.VERSION_CODES.S) return null
    val displayId = display.displayId
    return try {
      val windowManager = windowManagers[displayId] ?: createAndCache(display) ?: return null
      val bounds = windowManager.maximumWindowMetrics.bounds
      if (bounds.width() > 0 && bounds.height() > 0) Point(bounds.width(), bounds.height())
      else null
    } catch (@Suppress("TooGenericExceptionCaught") e: RuntimeException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      // The caller falls back to the mode size; a stale cached context is rebuilt next read.
      windowManagers.remove(displayId)
      Log.d(TAG, "Failed to get logical size for display $displayId", e)
      null
    }
  }

  /** Number of displays with a cached window context. */
  internal val cachedDisplayCount: Int
    get() = windowManagers.size

  override fun close() {
    val handle =
      synchronized(lock) {
        closed = true
        windowManagers.clear()
        removalHandle.also { removalHandle = null }
      }
    handle?.close()
  }

  private fun createAndCache(display: Display): WindowManager? {
    val windowManager = windowManagerFor(display) ?: return null
    return synchronized(lock) {
      if (closed || !ensureRemovalSignal()) windowManager
      else windowManagers.putIfAbsent(display.displayId, windowManager) ?: windowManager
    }
  }

  /** Called under [lock]. */
  private fun ensureRemovalSignal(): Boolean {
    if (removalHandle != null) return true
    if (removalUnavailable) return false
    removalHandle = removalSignal.register { displayId -> windowManagers.remove(displayId) }
    if (removalHandle == null) removalUnavailable = true
    return removalHandle != null
  }

  private companion object {
    const val TAG = "CtrlProxy"
  }
}

internal fun createDisplayLogicalSizeReader(context: Context): CachingDisplayLogicalSizeReader =
  CachingDisplayLogicalSizeReader(
    windowManagerFor = { display ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // A window context follows logical size overrides without inheriting the IME's process
        // bounds.
        context
          .createWindowContext(display, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, null)
          .getSystemService(WindowManager::class.java)
      } else {
        null
      }
    },
    removalSignal = displayManagerRemovalSignal(context),
  )

private fun displayManagerRemovalSignal(context: Context) = DisplayRemovalSignal { onRemoved ->
  val displayManager =
    context.getSystemService(DisplayManager::class.java) ?: return@DisplayRemovalSignal null
  val listener =
    object : DisplayManager.DisplayListener {
      override fun onDisplayAdded(displayId: Int) = Unit

      override fun onDisplayChanged(displayId: Int) = Unit

      override fun onDisplayRemoved(displayId: Int) = onRemoved(displayId)
    }
  // Reads run off the main thread, so callbacks need an explicit looper.
  displayManager.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
  AutoCloseable { displayManager.unregisterDisplayListener(listener) }
}
