package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.TargetApi
import android.os.Build
import android.util.Log
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowManager
import androidx.compose.foundation.layout.WindowInsets as ComposeWindowInsets
import androidx.compose.runtime.staticCompositionLocalOf
import kotlin.math.roundToInt

/**
 * Pixels at the window's bottom edge that the host guarantees content keeps clear of, whatever the
 * window's own inset dispatch reports (#10156).
 *
 * Content that asks for `systemBars` safe-area padding on every edge (first seen on a carousel's
 * control row) cleared the status bar at its top edge on the device, but its bottom edge stayed
 * under the gesture navigation bar, in fullscreen and in `bottomCenter`, portrait and landscape:
 * the navigation bar inset never reached the prototype window's own Compose inset values. The
 * display's window metrics (the same source the observation's `insets` come from) do carry it, so
 * the renderer takes the larger of the two.
 */
internal data class PrototypeInsetFloor(val bottom: Int = 0) {
  fun asComposeInsets(): ComposeWindowInsets = ComposeWindowInsets(0, 0, 0, bottom)

  companion object {
    val None = PrototypeInsetFloor()
  }
}

internal val LocalPrototypeInsetFloor = staticCompositionLocalOf { PrototypeInsetFloor.None }

/**
 * The part of a [navigationBarBottomPx] tall bar that [placement]'s window sits behind. A window
 * sharing the screen's bottom edge (fullscreen, a bottom sheet, a full-height side sheet) is behind
 * all of it; a bottom-gravity floating window is behind what its offset has not lifted it out of (a
 * positive `y` moves a bottom-gravity window up); anything else is not behind the bar.
 */
internal fun prototypeInsetFloor(
  placement: PrototypePlacement,
  density: Float,
  navigationBarBottomPx: Int,
): PrototypeInsetFloor {
  val bar = navigationBarBottomPx.coerceAtLeast(0)
  val behindBar =
    when (placement) {
      is PrototypePlacement.Fullscreen -> bar
      is PrototypePlacement.Sheet -> if (placement.edge == PrototypePlacement.Edge.TOP) 0 else bar
      is PrototypePlacement.Floating ->
        if ((placement.gravity and Gravity.VERTICAL_GRAVITY_MASK) == Gravity.BOTTOM)
          (bar - (placement.offsetYDp * density).roundToInt()).coerceAtLeast(0)
        else 0
    }
  return PrototypeInsetFloor(behindBar)
}

/**
 * The visible navigation bar's height at the screen bottom, 0 when the bar is hidden or the
 * platform cannot say (below API 30 there is no window-metrics inset API).
 */
@TargetApi(Build.VERSION_CODES.R)
internal fun navigationBarBottomPx(windowManager: WindowManager, sdkInt: Int): Int {
  if (sdkInt < Build.VERSION_CODES.R) return 0
  return try {
    windowManager.currentWindowMetrics.windowInsets
      .getInsets(WindowInsets.Type.navigationBars())
      .bottom
  } catch (e: Exception) {
    Log.w(TAG, "Could not read the navigation bar inset; prototype content is not lifted", e)
    0
  }
}

private const val TAG = "PrototypeInsetFloor"
