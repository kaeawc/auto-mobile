package dev.jasonpearson.automobile.ctrlproxy

/** Supported simultaneous finger counts for `request_two_finger_swipe`. */
internal const val MIN_MULTI_FINGER_COUNT = 2
internal const val MAX_MULTI_FINGER_COUNT = 5

/** One finger's straight stroke from its down point to its up point. */
internal data class FingerStroke(
  val startX: Float,
  val startY: Float,
  val endX: Float,
  val endY: Float,
)

/** The error for an unsupported finger count, or null when [fingerCount] is 2-5. */
internal fun multiFingerCountError(fingerCount: Int): String? =
  if (fingerCount in MIN_MULTI_FINGER_COUNT..MAX_MULTI_FINGER_COUNT) {
    null
  } else {
    "fingerCount must be $MIN_MULTI_FINGER_COUNT-$MAX_MULTI_FINGER_COUNT, got $fingerCount"
  }

/**
 * Computes one stroke per finger. Finger `i` is translated by `i * offset` pixels along X from the
 * first finger's path, the same layout the iOS runner uses (`fingerSpacing` in
 * `ObjCExceptionCatcher_synthesizeMultiFingerSwipe`), so both platforms agree. Identical start and
 * end points make a tap or, with a long duration, a long press.
 */
internal fun computeMultiFingerStrokes(
  x1: Double,
  y1: Double,
  x2: Double,
  y2: Double,
  offset: Int,
  fingerCount: Int,
): List<FingerStroke> =
  (0 until fingerCount).map { index ->
    val dx = (index * offset).toFloat()
    FingerStroke(x1.toFloat() + dx, y1.toFloat(), x2.toFloat() + dx, y2.toFloat())
  }
