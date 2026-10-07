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
 * The window layer an overlay is stacked on (#10496). [SYSTEM] is an accessibility overlay above
 * system UI, including the shade, keyboard and SystemUI's screenshot flash and preview. [APP] is an
 * application overlay just above apps, so all of those draw over it the way they do over a real
 * app; it needs SYSTEM_ALERT_WINDOW, which the controller checks before showing.
 */
@SuppressLint("InlinedApi") // APP is only requested on API 26+; the controller refuses it below.
enum class OverlayWindowLayer(val windowType: Int) {
  SYSTEM(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY),
  APP(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);

  companion object {
    /** Absent means [SYSTEM], the behaviour before layers existed. */
    fun fromWire(value: String?): OverlayWindowLayer =
      when (value) {
        null,
        "system" -> SYSTEM
        "app" -> APP
        else -> error("window.layer: Unknown layer")
      }
  }
}

/**
 * A non-focusable window is stacked above the keyboard unless it also opts out of input-method
 * interaction, so a non-focusable app-layer overlay adds FLAG_ALT_FOCUSABLE_IM to stay below it. A
 * window that takes focus for a text field is focusable and needs neither flag.
 */
private fun focusFlags(layer: OverlayWindowLayer, hasTextField: Boolean): Int =
  when {
    hasTextField -> 0
    layer == OverlayWindowLayer.APP ->
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM
    else -> WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
  }

/**
 * Edge-to-edge window bounds deliberately ignore safe areas; node-level insets are a renderer
 * concern. The highlight overlay's API-guarded cutout policy keeps offsets in true screen
 * coordinates, including cutouts (#9154). Density is supplied by the host's display context.
 * Accessibility overlays are trusted for touch pass-through on Android 12+, unlike application
 * overlays ([OverlayWindowLayer.APP]). This builder never consults SYSTEM_ALERT_WINDOW.
 */
@SuppressLint("NewApi")
fun interactiveOverlayLayoutParams(
  placement: OverlayPlacement,
  hasTextField: Boolean,
  density: Float,
  sdkInt: Int,
  layer: OverlayWindowLayer = OverlayWindowLayer.SYSTEM,
): WindowManager.LayoutParams {
  require(density.isFinite() && density > 0) { "Density must be positive and finite" }
  val match = WindowManager.LayoutParams.MATCH_PARENT
  val wrap = WindowManager.LayoutParams.WRAP_CONTENT
  return WindowManager.LayoutParams(
      wrap,
      wrap,
      layer.windowType,
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        focusFlags(layer, hasTextField),
      PixelFormat.TRANSLUCENT,
    )
    .apply {
      title = "AutoMobile Interactive Overlay"
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
