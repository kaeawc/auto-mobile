package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.TargetApi
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.view.Display
import android.view.WindowManager

/** Narrow seam over DisplayManager: can this logical display host a prototype window right now? */
fun interface PrototypeDisplayProvider {
  fun isAvailable(displayId: Int): Boolean
}

/**
 * Everything the host needs to attach a window to one display: a display-specific context (also
 * used to inflate the content, so density and insets are the display's own), its WindowManager, and
 * a density read taken afresh at every layout. [navigationBarBottomPx] is the visible navigation
 * bar's height on this display, read afresh (0 when hidden or unknown).
 */
class PrototypeDisplayWindow(
  val context: Context,
  val windowManager: WindowManager,
  val navigationBarBottomPx: () -> Int = { 0 },
  val density: () -> Float,
)

fun interface PrototypeDisplayWindows {
  /**
   * Null when the display is unknown, disconnected, or cannot take a window of [layer]'s type. The
   * window context is created for that type, so a window added through it must use the same one.
   */
  fun open(displayId: Int, layer: PrototypeWindowLayer): PrototypeDisplayWindow?
}

/**
 * Production display seams over [service]. Every window opened here uses a window context created
 * from the display's own context for the layer's type (API 30+), never the service's own
 * WindowManager, whose accessibility-overlay token would stack an app-layer window above the
 * notification shade (#10529). The gesture routing already rejects non-default ids below API 30
 * before they reach this class, so [open] returns null there rather than guessing; an app-layer
 * window on the default display uses the application context's WindowManager there instead.
 */
class AndroidPrototypeDisplays(
  private val service: Context,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) : PrototypeDisplayProvider, PrototypeDisplayWindows {
  private fun display(displayId: Int): Display? =
    (service.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(displayId)

  override fun isAvailable(displayId: Int): Boolean =
    displayId == Display.DEFAULT_DISPLAY || display(displayId) != null

  @TargetApi(Build.VERSION_CODES.R)
  override fun open(displayId: Int, layer: PrototypeWindowLayer): PrototypeDisplayWindow? {
    if (sdkInt < Build.VERSION_CODES.R) {
      return if (displayId == Display.DEFAULT_DISPLAY && layer == PrototypeWindowLayer.APP) {
        applicationWindow()
      } else null
    }
    val display = display(displayId) ?: return null
    val windowContext =
      service.createDisplayContext(display).createWindowContext(layer.windowType, null)
    val windowManager = windowContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    return windowManager?.let {
      PrototypeDisplayWindow(
        windowContext,
        it,
        navigationBarBottomPx = { navigationBarBottomPx(it, sdkInt) },
        density = { windowContext.resources.displayMetrics.density },
      )
    }
  }

  private fun applicationWindow(): PrototypeDisplayWindow? {
    val app = service.applicationContext
    val windowManager = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    return windowManager?.let {
      PrototypeDisplayWindow(
        app,
        it,
        navigationBarBottomPx = { navigationBarBottomPx(it, sdkInt) },
        density = { app.resources.displayMetrics.density },
      )
    }
  }
}
