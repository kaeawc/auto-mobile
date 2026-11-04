package dev.jasonpearson.automobile.wearfixture

/**
 * Crown-only picker state. Rotary scroll pixels accumulate until they cross [pixelsPerStep]; each
 * crossing moves one value, clamped at both ends. Touch never reaches this model.
 */
data class RotaryPickerModel(
  val valueCount: Int,
  val index: Int = 0,
  val pendingPixels: Float = 0f,
  val pixelsPerStep: Float = DEFAULT_PIXELS_PER_STEP,
) {
  init {
    require(valueCount > 0) { "valueCount must be positive" }
    require(pixelsPerStep > 0f) { "pixelsPerStep must be positive" }
    require(index in 0 until valueCount) { "index $index outside 0 until $valueCount" }
  }

  /** Positive pixels (clockwise) move forward, negative pixels move back. */
  fun onRotary(pixels: Float): RotaryPickerModel {
    val total = pendingPixels + pixels
    val steps = (total / pixelsPerStep).toInt()
    if (steps == 0) return copy(pendingPixels = total)
    val target = (index + steps).coerceIn(0, valueCount - 1)
    // At an end, drop the leftover so reversing direction responds on the next step.
    val leftover = if (target == index + steps) total - steps * pixelsPerStep else 0f
    return copy(index = target, pendingPixels = leftover)
  }

  companion object {
    const val DEFAULT_PIXELS_PER_STEP = 48f
  }
}
