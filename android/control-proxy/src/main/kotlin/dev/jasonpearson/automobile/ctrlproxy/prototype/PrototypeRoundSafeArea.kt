package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlin.math.ceil
import kotlin.math.sqrt

/** Pixel insets of a centered square wholly inside the display's inscribed circle. */
internal data class PrototypeRoundSafeArea(val horizontal: Int = 0, val vertical: Int = 0)

/** Round inward, including odd display sizes, so even the target's corners remain visible. */
internal fun prototypeRoundSafeArea(
  width: Int,
  height: Int,
  screenRound: Boolean,
): PrototypeRoundSafeArea {
  require(width > 0 && height > 0) { "Display dimensions must be positive" }
  if (!screenRound) return PrototypeRoundSafeArea()
  val halfSide = minOf(width, height) / (2.0 * sqrt(2.0))
  return PrototypeRoundSafeArea(
    ceil(width / 2.0 - halfSide).toInt(),
    ceil(height / 2.0 - halfSide).toInt(),
  )
}
