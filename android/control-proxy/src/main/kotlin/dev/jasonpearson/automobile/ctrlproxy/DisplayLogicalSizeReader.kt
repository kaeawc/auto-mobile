package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.graphics.Point
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.WindowManager

internal fun interface DisplayLogicalSizeReader {
  /**
   * Effective logical display size in current rotation, independent of the process configuration;
   * null when unavailable or non-positive.
   */
  fun read(display: Display): Point?
}

internal fun createDisplayLogicalSizeReader(context: Context): DisplayLogicalSizeReader =
  DisplayLogicalSizeReader { display ->
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@DisplayLogicalSizeReader null
    try {
      // A window context follows logical size overrides without inheriting the IME's process
      // bounds.
      val windowContext =
        context.createWindowContext(
          display,
          WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
          null,
        )
      val bounds =
        windowContext.getSystemService(WindowManager::class.java)?.maximumWindowMetrics?.bounds
      if (bounds != null && bounds.width() > 0 && bounds.height() > 0) {
        Point(bounds.width(), bounds.height())
      } else {
        null
      }
    } catch (e: IllegalArgumentException) {
      Log.w("CtrlProxy", "Failed to get logical size for display ${display.displayId}", e)
      null
    } catch (e: UnsupportedOperationException) {
      Log.w("CtrlProxy", "Failed to get logical size for display ${display.displayId}", e)
      null
    } catch (e: SecurityException) {
      Log.w("CtrlProxy", "Failed to get logical size for display ${display.displayId}", e)
      null
    }
  }
