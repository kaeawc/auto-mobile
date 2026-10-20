package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.CaCertResult
import dev.jasonpearson.automobile.protocol.CancelImeCommitResult
import dev.jasonpearson.automobile.protocol.ClipboardResult
import dev.jasonpearson.automobile.protocol.CommitTextResult
import dev.jasonpearson.automobile.protocol.CurrentFocusResult
import dev.jasonpearson.automobile.protocol.DeviceOwnerStatusResult
import dev.jasonpearson.automobile.protocol.DisplayPanelFingerprint
import dev.jasonpearson.automobile.protocol.DisplayTransitionEvent
import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.ImeActionResult
import dev.jasonpearson.automobile.protocol.InsertTextResult
import dev.jasonpearson.automobile.protocol.InsertTextState
import dev.jasonpearson.automobile.protocol.InsertTextStateResult
import dev.jasonpearson.automobile.protocol.InteractionEvent
import dev.jasonpearson.automobile.protocol.KeyboardProfileCatalogResult
import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.PackageEvent
import dev.jasonpearson.automobile.protocol.PackageEventData
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
import dev.jasonpearson.automobile.protocol.ScreenshotErrorResult
import dev.jasonpearson.automobile.protocol.SelectAllResult
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.SetTextResult
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.TapCoordinatesResult
import dev.jasonpearson.automobile.protocol.TraversalOrderResult
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

private fun typedResultFrame(response: WebSocketResponse): String =
  omitNullsFrameJson.encodeToString<WebSocketResponse>(response)

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

internal fun clipboardResultFrame(outcome: ClipboardFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    ClipboardResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      action = outcome.action,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      text = outcome.text,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun caCertResultFrame(outcome: CaCertificateResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    CaCertResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      action = outcome.action,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      alias = outcome.alias,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun deviceOwnerStatusResultFrame(
  outcome: DeviceOwnerResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    DeviceOwnerStatusResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.error == null,
      totalTimeMs = outcome.totalTimeMs,
      packageName = outcome.packageName,
      isDeviceOwner = outcome.isDeviceOwner,
      isAdminActive = outcome.isAdminActive,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun imeActionResultFrame(outcome: ImeActionFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    ImeActionResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      approximated = outcome.approximated,
      action = outcome.action,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun selectAllResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    SelectAllResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
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
  typedResultFrame(
    ScreenshotErrorResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      error = error,
      displayId = displayId,
      panelUniqueId = panelUniqueId,
    ),
  )

internal fun displayTransitionFrame(transition: DisplayTransition): String =
  typedResultFrame(
    DisplayTransitionEvent(
      timestamp = System.currentTimeMillis(),
      change = transition.change,
      displayId = transition.displayId,
      panelUniqueId = transition.panelUniqueId,
      panelFingerprint =
        transition.panelFingerprint?.let { DisplayPanelFingerprint(it.width, it.height) },
      width = transition.width,
      height = transition.height,
      state = transition.state,
      rotation = transition.rotation,
      deviceState = transition.deviceState,
    ),
  )

/** [eventJson] is the compact JSON text of the interaction, embedded as an object. */
internal fun interactionEventFrame(timestamp: Long, eventJson: String): String =
  typedResultFrame(InteractionEvent(timestamp = timestamp, event = eventJson))

/**
 * The `package_event` payload. `userId` is the Android user id; `uid` carries the raw package uid
 * when known and doubles as the marker that `userId` is a real user id: APKs that predate #10067
 * sent the uid in `userId` and no `uid`, which the host converts itself.
 */
internal fun packageEventFrame(outcome: PackageEventResult): String =
  typedResultFrame(
    PackageEvent(
      timestamp = outcome.timestamp,
      event =
        PackageEventData(
          outcome.action,
          outcome.packageName,
          outcome.userId,
          outcome.uid,
          outcome.isSystem,
          outcome.removedForAllUsers,
        ),
    ),
  )

internal fun setTextResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    SetTextResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

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

internal fun commitTextResultFrame(
  outcome: CommitTextFrameResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    CommitTextResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      partialApplication = outcome.partialApplication,
      committedUnits = outcome.committedUnits,
      insertedText = outcome.insertedText,
      editorConsumed = outcome.editorConsumed,
      trace = outcome.trace,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun cancelImeCommitResultFrame(
  requestId: String?,
  targetRequestId: String,
  partialApplication: Boolean,
  committedUnits: Int,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    CancelImeCommitResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      targetRequestId = targetRequestId,
      partialApplication = partialApplication,
      committedUnits = committedUnits,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun keyboardProfilesResultFrame(
  outcome: KeyboardProfilesResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    KeyboardProfileCatalogResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      catalogId = "automobile_behavior_profiles",
      catalogVersion = outcome.catalogVersion,
      supportedCatalogVersions = outcome.supportedCatalogVersions,
      activeProfileId = outcome.activeProfileId,
      profiles = if (outcome.success) outcome.profiles else null,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

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
