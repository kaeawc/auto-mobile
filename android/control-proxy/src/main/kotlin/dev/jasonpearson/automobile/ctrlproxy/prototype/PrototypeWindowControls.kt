package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.pm.ActivityInfo
import android.view.WindowManager.LayoutParams
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * Controls belong to the overlay, so removing it releases them without changing device settings.
 */
data class PrototypeWindowControls(
  val keepScreenOn: Boolean = false,
  val brightness: Float = LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
  /** Requested orientation only: Android may ignore an overlay's request. */
  val orientation: String? = null,
  val statusBar: String? = null,
) {
  val statusBarSupport: String?
    get() = statusBar?.let { "unsupported" }
}

internal fun PrototypeWindow.controls() =
  PrototypeWindowControls(
    keepScreenOn = keepScreenOn == true,
    brightness =
      (brightness as? JsonPrimitive)?.intOrNull?.let { it / 100f }
        ?: LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
    orientation = orientation,
    statusBar = statusBar,
  )

/** Applies only window-local values to freshly built layout params, including on replacement. */
fun interface PrototypeWindowControlApplier {
  fun apply(params: LayoutParams, controls: PrototypeWindowControls)
}

object AndroidPrototypeWindowControlApplier : PrototypeWindowControlApplier {
  override fun apply(params: LayoutParams, controls: PrototypeWindowControls) {
    params.flags =
      if (controls.keepScreenOn) params.flags or LayoutParams.FLAG_KEEP_SCREEN_ON
      else params.flags and LayoutParams.FLAG_KEEP_SCREEN_ON.inv()
    params.screenBrightness = controls.brightness
    params.screenOrientation =
      when (controls.orientation) {
        "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      }
    // Overlays do not own the status bar; its requested style is reported as unsupported.
  }
}
