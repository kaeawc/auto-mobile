package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.PinchResult
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.TapCoordinatesResult
import kotlinx.serialization.json.JsonElement

internal fun swipeResultFrame(outcome: GestureFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    SwipeResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      gestureTimeMs = outcome.gestureTimeMs,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun dragResultFrame(outcome: GestureFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    DragResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      gestureTimeMs = outcome.gestureTimeMs,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun tapCoordinatesResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    TapCoordinatesResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun pinchResultFrame(outcome: GestureFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    PinchResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      gestureTimeMs = outcome.gestureTimeMs,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )
