package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.OverlayEvent
import dev.jasonpearson.automobile.protocol.OverlayResult
import dev.jasonpearson.automobile.protocol.OverlayStatusEntry
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val resultFrameJson = Json {
  prettyPrint = false
  encodeDefaults = true
}

private fun resultFrame(
  type: String,
  requestId: String?,
  perfTiming: JsonElement? = null,
  content: JsonObjectBuilder.() -> Unit,
): String =
  resultFrameJson.encodeToString(
    buildJsonObject {
      put("type", type)
      put("timestamp", System.currentTimeMillis())
      if (requestId != null) put("requestId", requestId)
      content()
      if (perfTiming != null) put("perfTiming", perfTiming)
    },
  )

internal fun swipeResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  gestureTimeMs: Long?,
  perfTiming: JsonElement?,
): String =
  resultFrame("swipe_result", requestId, perfTiming) {
    put("success", success)
    put("totalTimeMs", totalTimeMs)
    if (gestureTimeMs != null) put("gestureTimeMs", gestureTimeMs)
    if (error != null) put("error", error)
  }

internal fun dragResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  gestureTimeMs: Long?,
  perfTiming: JsonElement?,
): String =
  resultFrame("drag_result", requestId, perfTiming) {
    put("success", success)
    put("totalTimeMs", totalTimeMs)
    if (gestureTimeMs != null) put("gestureTimeMs", gestureTimeMs)
    if (error != null) put("error", error)
  }

internal fun tapCoordinatesResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  perfTiming: JsonElement?,
): String =
  resultFrame("tap_coordinates_result", requestId, perfTiming) {
    put("success", success)
    put("totalTimeMs", totalTimeMs)
    if (error != null) put("error", error)
  }

internal fun pinchResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  gestureTimeMs: Long?,
  perfTiming: JsonElement?,
): String =
  resultFrame("pinch_result", requestId, perfTiming) {
    put("success", success)
    put("totalTimeMs", totalTimeMs)
    if (gestureTimeMs != null) put("gestureTimeMs", gestureTimeMs)
    if (error != null) put("error", error)
  }

internal fun screenshotErrorFrame(
  requestId: String?,
  error: String,
  displayId: Int? = null,
  panelUniqueId: String? = null,
): String =
  resultFrame("screenshot_error", requestId) {
    put("error", error)
    if (displayId != null) put("displayId", displayId)
    if (panelUniqueId != null) put("panelUniqueId", panelUniqueId)
  }

internal fun displayTransitionFrame(transition: DisplayTransition): String =
  resultFrame("display_transition", null) {
    put("change", transition.change)
    put("displayId", transition.displayId)
    if (transition.panelUniqueId != null) put("panelUniqueId", transition.panelUniqueId)
    if (transition.width != null) put("width", transition.width)
    if (transition.height != null) put("height", transition.height)
    if (transition.state != null) put("state", transition.state)
    if (transition.rotation != null) put("rotation", transition.rotation)
    if (transition.deviceState != null) put("deviceState", transition.deviceState)
  }

internal fun currentFocusErrorFrame(
  requestId: String?,
  error: String?,
  totalTimeMs: Long,
): String =
  resultFrame("current_focus_result", requestId) {
    put("totalTimeMs", totalTimeMs)
    put("error", error ?: "Unknown error")
  }

internal fun traversalOrderErrorFrame(
  requestId: String?,
  error: String?,
  totalTimeMs: Long,
): String =
  resultFrame("traversal_order_result", requestId) {
    put("totalTimeMs", totalTimeMs)
    put("error", error ?: "Unknown error")
  }

internal fun overlayResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  missingAssets: List<String> = emptyList(),
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    OverlayResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      error = error,
      missingAssets = missingAssets.ifEmpty { null },
    ),
  )

internal fun overlayStatusFrame(
  requestId: String?,
  overlays: List<OverlayStatusEntry>,
  droppedEvents: Long,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    OverlayResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = true,
      overlays = overlays,
      droppedEvents = droppedEvents,
    ),
  )

internal fun overlayEventFrame(event: OverlayEvent): String =
  resultFrameJson.encodeToString<WebSocketResponse>(event)

/**
 * The `set_network_mock_rules_result` for an app's ordered-broadcast [resultData] (issue #10101).
 * Null data means no app answered, so the rejection fields stay null and the host reports the rules
 * as sent but not confirmed; a report, even an empty one, confirms them.
 */
internal fun networkMockRulesResult(
  requestId: String?,
  resultData: String?,
): SetNetworkMockRulesResult {
  val report = NetworkMockRuleReportContract.decode(resultData)
  return SetNetworkMockRulesResult(
    timestamp = System.currentTimeMillis(),
    requestId = requestId,
    rejectedMockIds = report?.rejected?.map { it.mockId },
    rejectedReasons = report?.rejected?.associate { it.mockId to it.reason },
  )
}

internal fun networkMockRulesFailure(requestId: String?, error: String): SetNetworkMockRulesResult =
  SetNetworkMockRulesResult(
    timestamp = System.currentTimeMillis(),
    requestId = requestId,
    success = false,
    error = error,
  )
