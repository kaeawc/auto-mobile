package dev.jasonpearson.automobile.ctrlproxy

import kotlin.math.cos
import kotlin.math.sin

/** The four touch endpoints of a two-finger pinch: two start points and two end points. */
internal data class PinchPoints(
  val startX1: Float,
  val startY1: Float,
  val startX2: Float,
  val startY2: Float,
  val endX1: Float,
  val endY1: Float,
  val endX2: Float,
  val endY2: Float,
)

/**
 * Computes the two-finger pinch endpoints around [centerX], [centerY].
 *
 * `rotationDegrees` describes how far the finger axis rotates *during* the pinch, NOT the
 * orientation of a fixed pinch axis: the two fingers start on the horizontal axis (angle 0) and
 * move to an axis rotated by [rotationDegrees]. A non-zero value therefore produces a combined
 * pinch+rotate. For the common `rotationDegrees == 0` zoom case the start and end axes coincide.
 *
 * This convention is shared with the iOS runner's `ObjCExceptionCatcher_computePinchPoints`
 * (`ios/control-proxy/Sources/ObjCExceptionCatcher/`) so cross-platform pinch results match. Both
 * sides are now pinned by executable tests — `PinchGeometryTest` here and `PinchGeometryTests` on
 * iOS — which share a golden-vector table so a silent divergence in either fails loudly. See
 * issues #2911 / #2979. Pure trig with no Android dependencies so it stays unit testable.
 */
internal fun computePinchPoints(
  centerX: Double,
  centerY: Double,
  distanceStart: Double,
  distanceEnd: Double,
  rotationDegrees: Float,
): PinchPoints {
  val startRadius = distanceStart / 2.0
  val endRadius = distanceEnd / 2.0
  val startAngle = 0.0
  val endAngle = Math.toRadians(rotationDegrees.toDouble())

  fun pointAt(radius: Double, angleRad: Double): Pair<Float, Float> {
    val x = (centerX + radius * cos(angleRad)).toFloat()
    val y = (centerY + radius * sin(angleRad)).toFloat()
    return x to y
  }

  val (startX1, startY1) = pointAt(startRadius, startAngle)
  val (startX2, startY2) = pointAt(startRadius, Math.PI + startAngle)
  val (endX1, endY1) = pointAt(endRadius, endAngle)
  val (endX2, endY2) = pointAt(endRadius, Math.PI + endAngle)

  return PinchPoints(startX1, startY1, startX2, startY2, endX1, endY1, endX2, endY2)
}
