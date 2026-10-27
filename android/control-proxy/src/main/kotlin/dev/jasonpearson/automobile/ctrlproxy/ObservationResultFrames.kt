package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.CurrentFocusResult
import dev.jasonpearson.automobile.protocol.HierarchyUpdateEvent
import dev.jasonpearson.automobile.protocol.HighlightResponse
import dev.jasonpearson.automobile.protocol.TraversalOrderData
import dev.jasonpearson.automobile.protocol.TraversalOrderResult
import kotlinx.serialization.json.JsonElement

/**
 * Typed focus, highlight and hierarchy frames (#11877). Each keeps the explicit nulls the
 * hand-built frame wrote (`"focusedElement":null`, `"focusedIndex":null`, a success
 * `"error":null`), so they are encoded with [explicitNullsResultFrame]. `ResultFramesGoldenTest`
 * pins the bytes.
 */
internal fun currentFocusResultFrame(
  timestamp: Long,
  requestId: String?,
  totalTimeMs: Long,
  focusedElementJson: String?,
  perfTiming: JsonElement?,
): String =
  explicitNullsResultFrame(
    CurrentFocusResult(
      timestamp = timestamp,
      requestId = requestId,
      totalTimeMs = totalTimeMs,
      focusedElement = focusedElementJson,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun traversalOrderResultFrame(
  timestamp: Long,
  requestId: String?,
  totalTimeMs: Long,
  result: TraversalOrderData,
  perfTiming: JsonElement?,
): String =
  explicitNullsResultFrame(
    TraversalOrderResult(
      timestamp = timestamp,
      requestId = requestId,
      totalTimeMs = totalTimeMs,
      result = result,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun highlightResponseFrame(
  timestamp: Long,
  requestId: String?,
  success: Boolean,
  error: String?,
  perfTiming: JsonElement?,
): String =
  explicitNullsResultFrame(
    HighlightResponse(
      timestamp = timestamp,
      requestId = requestId,
      success = success,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

/**
 * The `hierarchy_update` push (#11877). [hierarchyJson] is the already-serialized hierarchy,
 * written into the frame verbatim (never re-parsed), so a large tree costs no more than the old
 * builder.
 */
internal fun hierarchyUpdateFrame(
  timestamp: Long,
  hierarchyJson: String,
  requestId: String?,
  frameContext: String?,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    HierarchyUpdateEvent(
      timestamp = timestamp,
      data = hierarchyJson,
      requestId = requestId,
      frameContext = frameContext,
      perfTiming = perfTiming?.toString(),
    ),
  )
