package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.InsertTextResult
import dev.jasonpearson.automobile.protocol.InsertTextState
import dev.jasonpearson.automobile.protocol.InsertTextStateResult
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
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private val resultFrameJson = Json {
  prettyPrint = false
  encodeDefaults = true
}

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

internal fun typedResultFrame(response: WebSocketResponse): String =
  omitNullsFrameJson.encodeToString<WebSocketResponse>(response)

internal fun insertTextResultFrame(
  outcome: InsertTextFrameResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    InsertTextResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      error = outcome.error,
      warning = outcome.warning,
      caretPlaced = outcome.caretPlaced,
      resultingTextLength = outcome.resultingTextLength,
      partialApplication = outcome.partialApplication,
      perfTiming = perfTiming?.toString(),
    ),
  )

/**
 * Encoded with explicit nulls, unlike the other typed frames: the hand-built state object wrote a
 * null `text` as `"text":null`, and a host reads that as "field empty", not "field unreadable".
 */
internal fun insertTextStateResultFrame(
  requestId: String?,
  state: InsertTextState?,
  perfTiming: JsonElement?,
): String =
  resultFrameJson.encodeToString<WebSocketResponse>(
    InsertTextStateResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      state = state,
      perfTiming = perfTiming?.toString(),
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
