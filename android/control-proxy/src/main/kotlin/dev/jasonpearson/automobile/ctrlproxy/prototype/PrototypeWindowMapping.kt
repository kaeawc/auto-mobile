package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.Gravity
import dev.jasonpearson.automobile.protocol.PrototypeFloatingPlacement
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypePlacement as SpecPlacement
import dev.jasonpearson.automobile.protocol.PrototypeSheetPlacement
import dev.jasonpearson.automobile.protocol.PrototypeSpec

/**
 * `window.persistence: "device"` (#10494): the prototype survives the last client disconnecting and
 * the idle timeout. Absent or `session` keeps the session-scoped behaviour.
 */
fun isDevicePersistent(spec: PrototypeSpec): Boolean =
  when (spec.window.persistence) {
    null,
    "session" -> false
    "device" -> true
    else -> error("window.persistence: Unknown persistence")
  }

fun mapPrototypePlacement(placement: SpecPlacement): PrototypePlacement =
  when (placement) {
    is PrototypeFullscreenPlacement ->
      PrototypePlacement.Fullscreen(placement.scrim?.let(::prototypeColor))
    is PrototypeSheetPlacement ->
      PrototypePlacement.Sheet(
        when (placement.edge) {
          "top" -> PrototypePlacement.Edge.TOP
          "bottom" -> PrototypePlacement.Edge.BOTTOM
          else -> error("window.placement.edge: Unknown sheet edge")
        },
        renderWindowDp(placement.height, "window.placement.height"),
      )
    is PrototypeFloatingPlacement ->
      PrototypePlacement.Floating(
        prototypeGravity(placement.gravity),
        renderWindowDp(placement.offset.x, "window.placement.offset.x"),
        renderWindowDp(placement.offset.y, "window.placement.offset.y"),
      )
  }

private fun prototypeGravity(value: String): Int =
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
