package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.CurrentFocusResult
import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.PinchResult
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import dev.jasonpearson.automobile.protocol.PrototypePatchConflict
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode
import dev.jasonpearson.automobile.protocol.SavedPrototypeInfo
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.TapCoordinatesResult
import dev.jasonpearson.automobile.protocol.TraversalOrderResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
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

/**
 * The hand-built frames omitted absent optionals, so these typed classes are encoded with
 * `explicitNulls = false` rather than per-field `@EncodeDefault(NEVER)`: the latter would alter the
 * response fixture, which encodes the same classes with explicit nulls.
 */
private val omitNullsFrameJson = Json {
  prettyPrint = false
  encodeDefaults = true
  explicitNulls = false
}

private fun typedResultFrame(response: WebSocketResponse): String =
  omitNullsFrameJson.encodeToString<WebSocketResponse>(response)

/**
 * Content of an `insert_text_result` frame. The envelope (type, timestamp, requestId, perfTiming)
 * is added by the response sender, so this encodes only the body, in the order the hand-built frame
 * wrote it. It is deliberately not a [WebSocketResponse] subclass: that would add a response to the
 * published wire-contract fixture, which this refactor must leave byte-identical.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
internal data class InsertTextResultBody(
  val success: Boolean,
  val totalTimeMs: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val warning: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val caretPlaced: Boolean? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val resultingTextLength: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val partialApplication: Boolean = false,
) {
  fun putInto(builder: JsonObjectBuilder) {
    resultFrameJson.encodeToJsonElement(serializer(), this).jsonObject.forEach { (key, value) ->
      builder.put(key, value)
    }
  }
}

internal fun swipeResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  gestureTimeMs: Long?,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    SwipeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      gestureTimeMs = gestureTimeMs,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun dragResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  gestureTimeMs: Long?,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    DragResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      gestureTimeMs = gestureTimeMs,
      error = error,
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

internal fun pinchResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  gestureTimeMs: Long?,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    PinchResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      gestureTimeMs = gestureTimeMs,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

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
    transition.panelFingerprint?.let { fingerprint ->
      put(
        "panelFingerprint",
        buildJsonObject {
          put("width", fingerprint.width)
          put("height", fingerprint.height)
        },
      )
    }
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
  typedResultFrame(
    CurrentFocusResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      totalTimeMs = totalTimeMs,
      error = error ?: "Unknown error",
    ),
  )

internal fun traversalOrderErrorFrame(
  requestId: String?,
  error: String?,
  totalTimeMs: Long,
): String =
  typedResultFrame(
    TraversalOrderResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      totalTimeMs = totalTimeMs,
      error = error ?: "Unknown error",
    ),
  )

internal fun prototypeResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  missingAssets: List<String> = emptyList(),
  appearance: PrototypeAppearance? = null,
  revision: Long? = null,
  conflict: PrototypePatchConflict? = null,
  pages: Map<String, Int>? = null,
  stacks: Map<String, PrototypeStackSnapshot>? = null,
  hiddenReason: PrototypeHiddenReason? = null,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      error = error,
      missingAssets = missingAssets.ifEmpty { null },
      appearance = appearance,
      revision = revision,
      conflict = conflict,
      pages = pages,
      stacks = stacks,
      hiddenReason = hiddenReason,
    ),
  )

internal fun prototypePinnedFrame(
  requestId: String?,
  pin: dev.jasonpearson.automobile.protocol.SavedPrototypePinInfo,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = true,
      pin = pin,
    ),
  )

internal fun prototypeSavedFrame(requestId: String?, saved: SavedPrototypeInfo): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = true,
      saved = saved,
    ),
  )

internal fun prototypeSavedListFrame(
  requestId: String?,
  entries: List<SavedPrototypeEntry>,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = true,
      savedPrototypes = entries,
    ),
  )

internal fun prototypeClearedFrame(requestId: String?, cleared: Int): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = true,
      cleared = cleared,
    ),
  )

internal fun prototypeRefusalFrame(
  requestId: String?,
  code: SavedPrototypeErrorCode,
  error: String,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = false,
      errorCode = code,
      error = error,
    ),
  )

internal fun prototypeStatusFrame(
  requestId: String?,
  prototypes: List<PrototypeStatusEntry>,
  droppedEvents: Long,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    PrototypeResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = true,
      prototypes = prototypes,
      droppedEvents = droppedEvents,
    ),
  )

internal fun prototypeEventFrame(event: PrototypeEvent): String =
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
