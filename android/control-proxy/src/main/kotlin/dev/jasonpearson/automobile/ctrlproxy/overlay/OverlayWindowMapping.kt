package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.Gravity
import dev.jasonpearson.automobile.protocol.OverlayFloatingPlacement
import dev.jasonpearson.automobile.protocol.OverlayFullscreenPlacement
import dev.jasonpearson.automobile.protocol.OverlayPlacement as SpecPlacement
import dev.jasonpearson.automobile.protocol.OverlaySheetPlacement
import dev.jasonpearson.automobile.protocol.OverlaySpec

/**
 * `window.persistence: "device"` (#10494): the overlay survives the last client disconnecting and
 * the idle timeout. Absent or `session` keeps the session-scoped behaviour.
 */
fun isDevicePersistent(spec: OverlaySpec): Boolean =
  when (spec.window.persistence) {
    null,
    "session" -> false
    "device" -> true
    else -> error("window.persistence: Unknown persistence")
  }

fun mapOverlayPlacement(placement: SpecPlacement): OverlayPlacement =
  when (placement) {
    is OverlayFullscreenPlacement ->
      OverlayPlacement.Fullscreen(placement.scrim?.let(::overlayColor))
    is OverlaySheetPlacement ->
      OverlayPlacement.Sheet(
        when (placement.edge) {
          "top" -> OverlayPlacement.Edge.TOP
          "bottom" -> OverlayPlacement.Edge.BOTTOM
          else -> error("window.placement.edge: Unknown sheet edge")
        },
        renderWindowDp(placement.height, "window.placement.height"),
      )
    is OverlayFloatingPlacement ->
      OverlayPlacement.Floating(
        overlayGravity(placement.gravity),
        renderWindowDp(placement.offset.x, "window.placement.offset.x"),
        renderWindowDp(placement.offset.y, "window.placement.offset.y"),
      )
  }

private fun overlayGravity(value: String): Int =
  when (value) {
    "topStart" -> Gravity.TOP or Gravity.START
    "topCenter" -> Gravity.TOP or Gravity.CENTER_HORIZONTAL
    "topEnd" -> Gravity.TOP or Gravity.END
    "centerStart" -> Gravity.CENTER_VERTICAL or Gravity.START
    "center" -> Gravity.CENTER
    "centerEnd" -> Gravity.CENTER_VERTICAL or Gravity.END
    "bottomStart" -> Gravity.BOTTOM or Gravity.START
    "bottomCenter" -> Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
    "bottomEnd" -> Gravity.BOTTOM or Gravity.END
    else -> error("window.placement.gravity: Unknown gravity")
  }

private fun renderWindowDp(value: Double, path: String): Float {
  require(value.toFloat().isFinite()) { "$path: Size cannot be represented in Compose dp" }
  return value.toFloat()
}
