package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDeviceContract
import kotlin.math.roundToInt
import kotlinx.serialization.json.*

internal enum class PrototypeFold {
  NONE,
  FLAT,
  HALF_OPENED_HORIZONTAL,
  HALF_OPENED_VERTICAL,
}

internal data class PrototypeDeviceInput(
  val widthDp: Float,
  val heightDp: Float,
  val smallestWidthDp: Int,
  val fold: PrototypeFold,
  val hasPointer: Boolean,
  val release: String,
  val isPc: Boolean,
)

internal object PrototypeDeviceState {
  private val widthBounds = PrototypeDeviceContract.breakpoints("widthClass")
  private val heightBounds = PrototypeDeviceContract.breakpoints("heightClass")

  private fun sizeClass(value: Int, bounds: List<Int>): String =
    when {
      value < bounds[0] -> "compact"
      value < bounds[1] -> "medium"
      else -> "expanded"
    }

  fun snapshot(input: PrototypeDeviceInput): JsonObject = buildJsonObject {
    val width = input.widthDp.roundToInt().coerceIn(0, 65535)
    val height = input.heightDp.roundToInt().coerceIn(0, 65535)
    put(
      "device",
      buildJsonObject {
        put("os", "android")
        put("osVersion", input.release)
        put(
          "idiom",
          when {
            input.fold != PrototypeFold.NONE -> "foldable"
            input.isPc -> "desktop"
            input.smallestWidthDp >= 600 -> "tablet"
            else -> "phone"
          },
        )
        put("widthClass", sizeClass(width, widthBounds))
        put("heightClass", sizeClass(height, heightBounds))
        put("windowWidth", width)
        put("windowHeight", height)
        when (input.fold) {
          PrototypeFold.NONE -> Unit
          PrototypeFold.FLAT -> put("posture", "flat")
          PrototypeFold.HALF_OPENED_HORIZONTAL -> put("posture", "tabletop")
          PrototypeFold.HALF_OPENED_VERTICAL -> put("posture", "book")
        }
        put("pointer", input.hasPointer)
      },
    )
  }
}
