package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable

/** Bounds for a highlight shape. Pure Kotlin version without Android dependencies. */
@Serializable
data class HighlightBounds(
  val x: Int,
  val y: Int,
  val width: Int,
  val height: Int,
  val sourceWidth: Int? = null,
  val sourceHeight: Int? = null,
) {
  fun hasValidSize(): Boolean = width > 0 && height > 0
}

@Serializable
data class HighlightShape(
  val type: String,
  val bounds: HighlightBounds? = null,
)
