package dev.jasonpearson.automobile.ctrlproxy

import kotlin.math.ceil
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

/**
 * Both finger positions at one instant of a pinch. Finger 1 sits at the axis angle, finger 2
 * opposite.
 */
internal data class PinchFingerPositions(
  val x1: Float,
  val y1: Float,
  val x2: Float,
  val y2: Float,
)

/** Finest angular step of a rotating pinch path, in degrees. */
private const val PINCH_PATH_STEP_DEGREES = 10.0

/** Upper bound on path segments so a huge `rotationDegrees` cannot build an unbounded path. */
private const val PINCH_PATH_MAX_SEGMENTS = 36

/**
 * Number of straight segments each finger's path is split into. A pinch without rotation moves
 * along the shared axis, so its single straight segment is already exact. A rotating pinch must
 * follow an arc: a straight chord between the start and end points passes closer to the center than
 * either endpoint (a pure rotation would zoom in mid-gesture, issue #12996), so the arc is
 * approximated by one segment per [PINCH_PATH_STEP_DEGREES] of rotation. Mirrors the iOS
 * `ObjCExceptionCatcher_pinchSegmentCount`.
 */
internal fun pinchSegmentCount(rotationDegrees: Float): Int {
  val degrees = Math.abs(rotationDegrees.toDouble())
  if (!degrees.isFinite() || degrees == 0.0) return 1
  // Clamp in floating point before converting so a huge value can never overflow the Int.
  return ceil(degrees / PINCH_PATH_STEP_DEGREES)
    .coerceIn(1.0, PINCH_PATH_MAX_SEGMENTS.toDouble())
    .toInt()
}

/**
 * Finger positions after [fraction] (0..1) of the pinch: the axis angle and the radius are both
 * interpolated linearly, so a pure rotation keeps a constant radius and a combined pinch+rotate
 * traces a spiral. `fraction == 0` and `fraction == 1` equal the [computePinchPoints] start and end
 * points. Mirrors the iOS `ObjCExceptionCatcher_computePinchFingersAt`.
 */
internal fun computePinchFingerPositions(
  geometry: PinchStrokeGeometry,
  fraction: Double,
): PinchFingerPositions {
  val centerX = geometry.centerX
  val centerY = geometry.centerY
  val distanceStart = geometry.distanceStart
  val distanceEnd = geometry.distanceEnd
  val rotationDegrees = geometry.rotationDegrees

  val radius = (distanceStart + (distanceEnd - distanceStart) * fraction) / 2.0
  val angle = Math.toRadians(rotationDegrees.toDouble()) * fraction
  val dx = radius * cos(angle)
  val dy = radius * sin(angle)
  return PinchFingerPositions(
    (centerX + dx).toFloat(),
    (centerY + dy).toFloat(),
    (centerX - dx).toFloat(),
    (centerY - dy).toFloat(),
  )
}

/**
 * The intermediate points (excluding the start and end points) both fingers pass through, in order.
 * Empty when [pinchSegmentCount] is 1, i.e. the straight start-to-end line is the path.
 */
internal fun computePinchPathInterior(
  centerX: Double,
  centerY: Double,
  distanceStart: Double,
  distanceEnd: Double,
  rotationDegrees: Float,
): List<PinchFingerPositions> {
  val segments = pinchSegmentCount(rotationDegrees)
  return (1 until segments).map { index ->
    computePinchFingerPositions(
      PinchStrokeGeometry(
        centerX = centerX,
        centerY = centerY,
        distanceStart = distanceStart,
        distanceEnd = distanceEnd,
        rotationDegrees = rotationDegrees,
      ),
      fraction = index.toDouble() / segments,
    )
  }
}
