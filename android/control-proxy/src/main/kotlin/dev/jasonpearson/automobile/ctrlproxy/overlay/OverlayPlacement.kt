package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.annotation.SuppressLint
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.WindowManager
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.ctrlproxy.OverlayManager
import kotlin.math.roundToInt

sealed interface OverlayPlacement {
  data class Fullscreen(val scrim: Color? = null) : OverlayPlacement

  data class Sheet(val edge: Edge, val sizeDp: Float) : OverlayPlacement {
    init {
      require(sizeDp.isFinite() && sizeDp > 0) { "Sheet size must be positive and finite" }
    }
  }

  data class Floating(
    val gravity: Int = Gravity.TOP or Gravity.START,
    val offsetXDp: Float = 0f,
    val offsetYDp: Float = 0f,
  ) : OverlayPlacement {
    init {
      require(offsetXDp.isFinite() && offsetYDp.isFinite()) { "Offsets must be finite" }
    }
  }

  enum class Edge {
    TOP,
    BOTTOM,
    START,
    END,
  }
}

/**
 * Edge-to-edge window bounds deliberately ignore safe areas; node-level insets are a renderer
 * concern. The highlight overlay's API-guarded cutout policy keeps offsets in true screen
 * coordinates, including cutouts (#9154). Density is supplied by the host's display context.
 * Accessibility overlays are trusted for touch pass-through on Android 12+, unlike application
 * overlays. This builder never consults SYSTEM_ALERT_WINDOW.
 */
@SuppressLint("NewApi")
fun interactiveOverlayLayoutParams(
  placement: OverlayPlacement,
  hasTextField: Boolean,
  density: Float,
  sdkInt: Int,
): WindowManager.LayoutParams {
  require(density.isFinite() && density > 0) { "Density must be positive and finite" }
  val match = WindowManager.LayoutParams.MATCH_PARENT
  val wrap = WindowManager.LayoutParams.WRAP_CONTENT
  return WindowManager.LayoutParams(
      wrap,
      wrap,
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        if (hasTextField) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    )
    .apply {
      title = INTERACTIVE_OVERLAY_WINDOW_TITLE
      when (placement) {
        is OverlayPlacement.Fullscreen -> {
          width = match
          height = match
          gravity = Gravity.TOP or Gravity.START
        }
        is OverlayPlacement.Sheet -> {
          val size = (placement.sizeDp * density).roundToInt().coerceAtLeast(1)
          when (placement.edge) {
            OverlayPlacement.Edge.TOP,
            OverlayPlacement.Edge.BOTTOM -> {
              width = match
              height = size
              gravity =
                if (placement.edge == OverlayPlacement.Edge.TOP) Gravity.TOP else Gravity.BOTTOM
            }
            OverlayPlacement.Edge.START,
            OverlayPlacement.Edge.END -> {
              width = size
              height = match
              gravity =
                if (placement.edge == OverlayPlacement.Edge.START) Gravity.START else Gravity.END
            }
          }
        }
        is OverlayPlacement.Floating -> {
          gravity = placement.gravity
          x = (placement.offsetXDp * density).roundToInt()
          y = (placement.offsetYDp * density).roundToInt()
        }
      }
      OverlayManager.resolveCutoutMode(sdkInt)?.let { layoutInDisplayCutoutMode = it }
      // Explicitly opt out of system-bar fitting where supported, including focusable windows.
      if (sdkInt >= 30) setFitInsetsTypes(0)
    }
}
