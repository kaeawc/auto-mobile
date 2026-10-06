package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.annotation.TargetApi
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.view.Display
import android.view.WindowManager

/** Narrow seam over DisplayManager: can this logical display host an overlay window right now? */
fun interface OverlayDisplayProvider {
  fun isAvailable(displayId: Int): Boolean
}

/**
 * Everything the host needs to attach a window to one display: a display-specific context (also
 * used to inflate the content, so density and insets are the display's own), its WindowManager, and
 * a density read taken afresh at every layout.
 */
class OverlayDisplayWindow(
  val context: Context,
  val windowManager: WindowManager,
  val density: () -> Float,
)

fun interface OverlayDisplayWindows {
  /** Null when the display is unknown, disconnected, or cannot take an accessibility overlay. */
  fun open(displayId: Int): OverlayDisplayWindow?
}

/**
 * Production display seams over [service]. Non-default displays use a window context created from
 * the display's own context (API 30+); the gesture routing already rejects non-default ids below
 * API 30 before they reach this class, so [open] returns null there rather than guessing.
 */
class AndroidOverlayDisplays(
  private val service: Context,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) : OverlayDisplayProvider, OverlayDisplayWindows {
  private fun display(displayId: Int): Display? =
    (service.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(displayId)

  override fun isAvailable(displayId: Int): Boolean =
    displayId == Display.DEFAULT_DISPLAY || display(displayId) != null

  @TargetApi(Build.VERSION_CODES.R)
  override fun open(displayId: Int): OverlayDisplayWindow? {
    if (sdkInt < Build.VERSION_CODES.R) return null
    val display = display(displayId) ?: return null
    val windowContext =
      service
        .createDisplayContext(display)
        .createWindowContext(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, null)
    val windowManager = windowContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    return windowManager?.let {
      OverlayDisplayWindow(windowContext, it) { windowContext.resources.displayMetrics.density }
    }
  }
}
