package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.OverlayManager
import kotlin.math.roundToInt

/**
 * A non-focusable window is stacked above the keyboard unless it also opts out of input-method
 * interaction, so a non-focusable app-layer prototype adds FLAG_ALT_FOCUSABLE_IM to stay below it.
 * A window that takes focus for a text field is focusable and needs neither flag.
 */
private fun focusFlags(
  layer: PrototypeWindowLayer,
  hasTextField: Boolean,
  hasStackBack: Boolean,
): Int =
  when {
    hasTextField -> 0
    // Back alone takes key focus, without attaching this window to the IME. NOT_TOUCH_MODAL
    // remains set below. Open question: verify app-layer outside-touch pass-through on a device
    // while stack Back takes focus, including Android 12's untrusted overlay policy.
    hasStackBack -> WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM
    layer == PrototypeWindowLayer.APP ->
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM
    else -> WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
  }

/**
 * Edge-to-edge window bounds deliberately ignore safe areas; node-level insets are a renderer
 * concern. The highlight overlay's API-guarded cutout policy keeps offsets in true screen
 * coordinates, including cutouts (#9154). Density is supplied by the host's display context.
 * Accessibility overlays are trusted for touch pass-through on Android 12+, unlike application
 * prototypes ([PrototypeWindowLayer.APP]). This builder never consults SYSTEM_ALERT_WINDOW. Only a
 * fullscreen placement with [opaque] true uses an opaque pixel format; all other windows retain
 * translucency. The caller must account for authored surface opacity and host chrome.
 */
@SuppressLint("NewApi")
fun prototypeLayoutParams(
  placement: PrototypePlacement,
  hasTextField: Boolean,
  density: Float,
  sdkInt: Int,
  layer: PrototypeWindowLayer = PrototypeWindowLayer.SYSTEM,
  /** Keyboard height from the screen bottom (#10262); only a bottom sheet is moved by it. */
  imeLiftPx: Int = 0,
  hasStackBack: Boolean = false,
  opaque: Boolean = false,
  surfaceId: String? = null,
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
        focusFlags(layer, hasTextField, hasStackBack),
      if (opaque && placement is PrototypePlacement.Fullscreen) PixelFormat.OPAQUE
      else PixelFormat.TRANSLUCENT,
    )
    .apply {
      title = prototypeWindowTitle(surfaceId)
      when (placement) {
        is PrototypePlacement.Fullscreen -> {
          width = match
          height = match
          gravity = Gravity.TOP or Gravity.START
        }
        is PrototypePlacement.Sheet -> {
          val size = (placement.sizeDp * density).roundToInt().coerceAtLeast(1)
          when (placement.edge) {
            PrototypePlacement.Edge.TOP,
            PrototypePlacement.Edge.BOTTOM -> {
              width = match
              height = size
              gravity =
                if (placement.edge == PrototypePlacement.Edge.TOP) Gravity.TOP else Gravity.BOTTOM
              if (placement.edge == PrototypePlacement.Edge.BOTTOM) {
                // A positive y lifts a bottom-gravity window. The host moves the window itself, so
                // the system must not also resize or pan it for its own text field.
                y = prototypeImeShiftPx(placement, imeLiftPx)
                softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
              }
            }
            PrototypePlacement.Edge.START,
            PrototypePlacement.Edge.END -> {
              width = size
              height = match
              gravity =
                if (placement.edge == PrototypePlacement.Edge.START) Gravity.START else Gravity.END
            }
          }
        }
        is PrototypePlacement.Floating -> {
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
