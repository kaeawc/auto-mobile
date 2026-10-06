package dev.jasonpearson.automobile.ctrlproxy.overlay

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
 * The `showVariants` control row asks for `systemBars` safe-area padding on every edge. On the
 * device its top edge cleared the status bar but its bottom edge stayed under the gesture
 * navigation bar, in fullscreen and in `bottomCenter`, portrait and landscape: the navigation bar
 * inset never reached the overlay window's own Compose inset values. The display's window metrics
 * (the same source the observation's `insets` come from) do carry it, so the renderer takes the
 * larger of the two.
 */
internal data class OverlayInsetFloor(val bottom: Int = 0) {
  fun asComposeInsets(): ComposeWindowInsets = ComposeWindowInsets(0, 0, 0, bottom)

  companion object {
    val None = OverlayInsetFloor()
  }
}

internal val LocalOverlayInsetFloor = staticCompositionLocalOf { OverlayInsetFloor.None }

/**
 * The part of a [navigationBarBottomPx] tall bar that [placement]'s window sits behind. A window
 * sharing the screen's bottom edge (fullscreen, a bottom sheet, a full-height side sheet) is behind
 * all of it; a bottom-gravity floating window is behind what its offset has not lifted it out of (a
 * positive `y` moves a bottom-gravity window up); anything else is not behind the bar.
 */
internal fun overlayInsetFloor(
  placement: OverlayPlacement,
  density: Float,
  navigationBarBottomPx: Int,
): OverlayInsetFloor {
  val bar = navigationBarBottomPx.coerceAtLeast(0)
  val behindBar =
    when (placement) {
      is OverlayPlacement.Fullscreen -> bar
      is OverlayPlacement.Sheet -> if (placement.edge == OverlayPlacement.Edge.TOP) 0 else bar
      is OverlayPlacement.Floating ->
        if ((placement.gravity and Gravity.VERTICAL_GRAVITY_MASK) == Gravity.BOTTOM)
          (bar - (placement.offsetYDp * density).roundToInt()).coerceAtLeast(0)
        else 0
    }
  return OverlayInsetFloor(behindBar)
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
    Log.w(TAG, "Could not read the navigation bar inset; overlay content is not lifted", e)
    0
  }
}

private const val TAG = "OverlayInsetFloor"
