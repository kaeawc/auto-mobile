package dev.jasonpearson.automobile.ctrlproxy.prototype

/** Applies the rotation first, then mirrors horizontally in the rotated image. */
internal data class PrototypeExifOrientation(
  val rotationDegrees: Int,
  val flipHorizontal: Boolean,
) {
  val swapsAxes: Boolean
    get() = rotationDegrees == 90 || rotationDegrees == 270

  /** [target] in the source image's axes, so sampling compares like with like before rotating. */
  fun sourceTarget(target: PrototypeImageTarget): PrototypeImageTarget =
    if (swapsAxes) PrototypeImageTarget(target.heightPx, target.widthPx) else target
}

internal fun prototypeExifOrientation(tag: Int): PrototypeExifOrientation =
  when (tag) {
    2 -> PrototypeExifOrientation(0, true)
    3 -> PrototypeExifOrientation(180, false)
    4 -> PrototypeExifOrientation(180, true)
    5 -> PrototypeExifOrientation(90, true)
    6 -> PrototypeExifOrientation(90, false)
    7 -> PrototypeExifOrientation(270, true)
    8 -> PrototypeExifOrientation(270, false)
    else -> PrototypeExifOrientation(0, false)
  }
