package dev.jasonpearson.automobile.ctrlproxy

import android.annotation.TargetApi
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.Log
import android.view.WindowInsets
import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SystemBarsInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemChromeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo

internal interface DisplayInsetsProvider {
  fun insetsFor(displayId: Int, screenDimensions: ScreenDimensions?): ObservationInsetsInfo
}

/** The same mapping is used for the service window and a requested display's window metrics. */
@TargetApi(Build.VERSION_CODES.R)
internal fun observationInsetsFromWindowInsets(
  windowInsets: WindowInsets,
  screenDimensions: ScreenDimensions?,
): ObservationInsetsInfo {
  val displayCutout = windowInsets.displayCutout
  val displayCutoutInfo =
    if (displayCutout == null) {
      DisplayCutoutInfo.none()
    } else {
      DisplayCutoutInfo.fromBoundingRects(
        screenWidth = screenDimensions?.width ?: 0,
        screenHeight = screenDimensions?.height ?: 0,
        bounds = displayCutout.boundingRects.filterNot { it.isEmpty }.map(::ElementBounds),
      )
    }
  return ObservationInsetsInfo(
    systemBars =
      SystemBarsInsetsInfo(
        visible =
          toSystemInsetsInfo(windowInsets.getInsets(android.view.WindowInsets.Type.systemBars())),
        stable =
          toSystemInsetsInfo(
            windowInsets.getInsetsIgnoringVisibility(android.view.WindowInsets.Type.systemBars())
          ),
      ),
    displayCutout =
      toSystemInsetsInfo(
        windowInsets.getInsetsIgnoringVisibility(android.view.WindowInsets.Type.displayCutout())
      ),
    displayCutoutInfo = displayCutoutInfo,
    systemGestures =
      toSystemInsetsInfo(windowInsets.getInsets(android.view.WindowInsets.Type.systemGestures())),
    mandatorySystemGestures =
      toSystemInsetsInfo(
        windowInsets.getInsets(android.view.WindowInsets.Type.mandatorySystemGestures())
      ),
    tappableElement =
      toSystemInsetsInfo(windowInsets.getInsets(android.view.WindowInsets.Type.tappableElement())),
    systemChrome =
      SystemChromeInfo.fromAndroidBars(
        statusBarVisible = windowInsets.isVisible(android.view.WindowInsets.Type.statusBars()),
        navigationBarVisible =
          windowInsets.isVisible(android.view.WindowInsets.Type.navigationBars()),
      ),
  )
}

internal class WindowMetricsDisplayInsetsProvider(
  private val sdkInt: Int,
  private val windowInsetsFor: (Int) -> WindowInsets?,
) : DisplayInsetsProvider {
  override fun insetsFor(
    displayId: Int,
    screenDimensions: ScreenDimensions?,
  ): ObservationInsetsInfo {
    if (sdkInt < Build.VERSION_CODES.R) return unavailableInsets()
    return try {
      val windowInsets = windowInsetsFor(displayId) ?: return unavailableInsets()
      observationInsetsFromWindowInsets(windowInsets, screenDimensions)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get system insets for display $displayId", e)
      unavailableInsets()
    }
  }

  private companion object {
    const val TAG = "DisplayInsetsProvider"
  }
}

/** Resolve each capture afresh so a removed or reconfigured display cannot reuse stale insets. */
internal fun createDisplayInsetsProvider(context: Context): DisplayInsetsProvider =
  WindowMetricsDisplayInsetsProvider(
    sdkInt = Build.VERSION.SDK_INT,
    windowInsetsFor = { displayId ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val display = manager?.getDisplay(displayId)
        if (display == null) {
          null
        } else {
          val displayContext = context.createDisplayContext(display)
          val windowManager =
            displayContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
          windowManager?.currentWindowMetrics?.windowInsets
        }
      } else {
        null
      }
    },
  )

private fun unavailableInsets(): ObservationInsetsInfo =
  ObservationInsetsInfo(
    available = false,
    source = "unavailable",
    units = "unknown",
    displayCutoutInfo = DisplayCutoutInfo.unknown(),
  )

// Only reached from the API 30+ WindowInsets path (see WindowMetricsDisplayInsetsProvider).
@TargetApi(Build.VERSION_CODES.Q)
private fun toSystemInsetsInfo(insets: android.graphics.Insets): SystemInsetsInfo =
  SystemInsetsInfo(
    top = insets.top,
    bottom = insets.bottom,
    left = insets.left,
    right = insets.right,
  )
