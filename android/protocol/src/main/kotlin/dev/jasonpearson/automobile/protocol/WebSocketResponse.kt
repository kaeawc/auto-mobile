package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Sealed class hierarchy for all outbound WebSocket messages from Android to MCP server.
 *
 * Messages are grouped into:
 * - Events: Push notifications (hierarchy updates, navigation, interactions)
 * - Results: Responses to specific requests
 */
@Serializable
sealed class WebSocketResponse {
  abstract val timestamp: Long
}

/**
 * A [WebSocketResponse] that answers one request and echoes its [requestId], so the server can
 * route it to that request's awaiter. Push events that answer no request do not implement it.
 * `CorrelatedResponseTest` fails when a response type declares `requestId` without implementing
 * this. See #11877.
 */
sealed interface CorrelatedResponse {
  val requestId: String?
}

// =============================================================================
// Connection
// =============================================================================

@Serializable
@SerialName("connected")
data class ConnectedResponse(
  val id: Int,
  val supportedCommands: List<String> = emptyList(),
  override val timestamp: Long = System.currentTimeMillis(),
) : WebSocketResponse()

// =============================================================================
// Protocol Error
// =============================================================================

/**
 * Structured protocol-boundary error, emitted when an inbound command fails to decode or a handler
 * throws while processing it. Correlated by [requestId] (best-effort extracted from the raw payload
 * when decode fails, so a client awaiting that id gets a fast, actionable failure instead of
 * hanging until timeout). Mirrors the iOS runner's `type:"error"` envelope. See issue #2985.
 */
@Serializable
@SerialName("error")
data class ErrorResponse(
  override val timestamp: Long = System.currentTimeMillis(),
  override val requestId: String? = null,
  val success: Boolean = false,
  val error: String,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Push Events (unsolicited messages)
// =============================================================================

/**
 * [data] is the serialized hierarchy, embedded on the wire as an object (#11877). [frameContext] is
 * present only when the hierarchy was extracted in the frame context that is still current.
 */
@Serializable
@SerialName("hierarchy_update")
data class HierarchyUpdateEvent(
  override val timestamp: Long,
  @Serializable(with = RawJsonSerializer::class) val data: String,
  override val requestId: String? = null,
  val frameContext: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("interaction_event")
data class InteractionEvent(
  override val timestamp: Long,
  /** Compact JSON text of the interaction; the wire embeds it as an object, not a quoted string. */
  @Serializable(with = PerfTimingJsonSerializer::class) val event: String,
) : WebSocketResponse()

@Serializable
@SerialName("package_event")
data class PackageEvent(
  override val timestamp: Long,
  val event: PackageEventData,
) : WebSocketResponse()

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PackageEventData(
  val action: String,
  val packageName: String,
  val userId: Int,
  val uid: Int? = null,
  val isSystem: Boolean? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val removedForAllUsers: Boolean = false,
)

/** A display's change (add/remove/rotation/fold); carries no requestId. */
@Serializable
@SerialName("display_transition")
data class DisplayTransitionEvent(
  override val timestamp: Long,
  val change: String,
  val displayId: Int,
  val panelUniqueId: String? = null,
  val panelFingerprint: DisplayPanelFingerprint? = null,
  val width: Int? = null,
  val height: Int? = null,
  val state: Int? = null,
  val rotation: Int? = null,
  val deviceState: Int? = null,
) : WebSocketResponse()

@Serializable data class DisplayPanelFingerprint(val width: Int, val height: Int)

@Serializable
@SerialName("navigation_event")
data class NavigationEventResponse(
  override val timestamp: Long,
  val event: NavigationEventData,
) : WebSocketResponse()

@Serializable
data class NavigationEventData(
  val destination: String,
  val source: String? = null,
  val arguments: Map<String, String>? = null,
  val metadata: Map<String, String>? = null,
  val applicationId: String? = null,
  /** Monotonically increasing sequence number for ordering */
  val sequenceNumber: Long? = null,
)

@Serializable
@SerialName("handled_exception_event")
data class HandledExceptionEvent(
  override val timestamp: Long,
  val event: HandledExceptionData,
) : WebSocketResponse()

/** Device information captured at the time of an exception. */
@Serializable
data class DeviceInfo(
  val model: String,
  val manufacturer: String,
  val osVersion: String,
  val sdkInt: Int,
)

@Serializable
data class HandledExceptionData(
  val exceptionClass: String,
  val message: String?,
  val stackTrace: String,
  val customMessage: String? = null,
  val currentScreen: String? = null,
  val packageName: String? = null,
  val appVersion: String? = null,
  val deviceInfo: DeviceInfo? = null,
  val applicationId: String? = null,
)

@Serializable
@SerialName("network_event")
data class NetworkEventResponse(
  override val timestamp: Long,
  val event: NetworkEventData,
) : WebSocketResponse()

@Serializable
data class NetworkEventData(
  val url: String,
  val method: String,
  val statusCode: Int = 0,
  val durationMs: Long = 0,
  val requestBodySize: Long = -1,
  val responseBodySize: Long = -1,
  val protocol: String? = null,
  val host: String? = null,
  val path: String? = null,
  val error: String? = null,
  val applicationId: String? = null,
  val requestHeaders: Map<String, String>? = null,
  val responseHeaders: Map<String, String>? = null,
  val requestBody: String? = null,
  val responseBody: String? = null,
  val contentType: String? = null,
)

@Serializable
@SerialName("websocket_frame_event")
data class WebSocketFrameResponse(
  override val timestamp: Long,
  val event: WebSocketFrameData,
) : WebSocketResponse()

@Serializable
data class WebSocketFrameData(
  val connectionId: String,
  val url: String,
  val direction: String,
  val frameType: String,
  val payloadSize: Long = 0,
  val success: Boolean = true,
  val applicationId: String? = null,
)

@Serializable
@SerialName("log_event")
data class LogEventResponse(
  override val timestamp: Long,
  val event: LogEventData,
) : WebSocketResponse()

@Serializable
data class LogEventData(
  val level: Int,
  val tag: String,
  val message: String,
  val pid: Int = 0,
  val tid: Int = 0,
  val applicationId: String? = null,
)

@Serializable
@SerialName("broadcast_event")
data class BroadcastEventResponse(
  override val timestamp: Long,
  val event: BroadcastEventData,
) : WebSocketResponse()

@Serializable
data class BroadcastEventData(
  val action: String,
  val categories: List<String>? = null,
  val extraKeys: Map<String, String>? = null,
  val applicationId: String? = null,
)

@Serializable
@SerialName("lifecycle_event")
data class LifecycleEventResponse(
  override val timestamp: Long,
  val event: LifecycleEventData,
) : WebSocketResponse()

@Serializable
data class LifecycleEventData(
  val kind: String,
  val details: Map<String, String>? = null,
  val applicationId: String? = null,
)

/**
 * Live per-frame performance rollup from the in-app `auto-mobile-sdk` `FrameMetricsCollector`
 * (issue #5076). Pushed as it arrives so the host can feed real app-frame fps/jank into the observe
 * `perfSnapshot`, superseding the host-side `dumpsys gfxinfo` scrape for SDK-integrated apps.
 * fps/frameTimeMs/ jankFrames are absent (null) for a window in which no frames rendered.
 */
@Serializable
@SerialName("frame_metrics_event")
data class FrameMetricsEventResponse(
  override val timestamp: Long,
  val frameMetrics: FrameMetricsData,
) : WebSocketResponse()

@Serializable
data class FrameMetricsData(
  val applicationId: String? = null,
  val fps: Double? = null,
  val frameTimeMs: Double? = null,
  val jankFrames: Int? = null,
  val totalFrames: Int,
)

/**
 * Encoded with explicit nulls (#11877): a null [key] is a file clear and a [JsonNull] [value] a
 * removal, so both stay on the wire. [previousValue] is omitted (Kotlin null) for a legacy SDK that
 * did not capture it and is [JsonNull] for a genuine "no prior value"; the host tells them apart.
 */
@Serializable
@SerialName("storage_changed")
@OptIn(ExperimentalSerializationApi::class)
data class StorageChangedEvent(
  override val timestamp: Long,
  val packageName: String,
  val fileName: String,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val data: String? = null, // Legacy JSON string
  val key: String? = null,
  val value: JsonElement? = null,
  val valueType: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val changeType: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val previousValue: JsonElement? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val eventTimestamp: Long? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val sequenceNumber: Long? = null,
) : WebSocketResponse()

@Serializable
@SerialName("crash_event")
data class CrashEvent(
  override val timestamp: Long,
  val event: CrashData,
) : WebSocketResponse()

@Serializable
data class CrashData(
  val exceptionClass: String,
  val message: String?,
  val stackTrace: String,
  val threadName: String,
  val currentScreen: String? = null,
  val packageName: String? = null,
  val appVersion: String? = null,
  val deviceInfo: DeviceInfo? = null,
  val applicationId: String? = null,
)

@Serializable
@SerialName("anr_event")
data class AnrEvent(
  override val timestamp: Long,
  val event: AnrData,
) : WebSocketResponse()

@Serializable
data class AnrData(
  /** Process ID that experienced the ANR */
  val pid: Int,
  /** Process name */
  val processName: String,
  /** Process importance when ANR occurred (FOREGROUND, VISIBLE, etc.) */
  val importance: String,
  /** Full thread dump from ApplicationExitInfo.traceInputStream */
  val trace: String?,
  /** Human-readable reason description */
  val reason: String,
  /** Package name of the app */
  val packageName: String? = null,
  /** App version */
  val appVersion: String? = null,
  /** Device information */
  val deviceInfo: DeviceInfo? = null,
)

// =============================================================================
// Screenshot Results
// =============================================================================

@Serializable
@SerialName("screenshot")
data class ScreenshotResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val displayId: Int? = null,
  val panelUniqueId: String? = null,
  val data: String, // Base64 encoded image
  val format: String = "jpeg",
  val width: Int? = null,
  val height: Int? = null,
  val frameContext: String? = null,
  /** Display rotation sampled when the screenshot capture completed (0..3). */
  val rotation: Int? = null,
  val screenshotCaptureDurationMs: Long? = null,
  val screenshotEncodeDurationMs: Long? = null,
  val screenshotByteLength: Int? = null,
  val screenshotBase64Length: Int? = null,
  /**
   * Answers a request that carried `hidePrototypes`: true when the image contains no CtrlProxy
   * prototype (none was showing, or it was hidden and a frame confirmed it gone), false when the
   * hide could not be confirmed before capture. Absent for requests without the flag.
   */
  val prototypesHidden: Boolean? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("screenshot_error")
data class ScreenshotErrorResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val error: String,
  val displayId: Int? = null,
  val panelUniqueId: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Gesture Results
// =============================================================================

@Serializable
@SerialName("swipe_result")
data class SwipeResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("tap_coordinates_result")
data class TapCoordinatesResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("drag_result")
data class DragResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("pinch_result")
data class PinchResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Text Input Results
// =============================================================================

@Serializable
@SerialName("set_text_result")
data class SetTextResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("commit_text_result")
data class CommitTextResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val partialApplication: Boolean = false,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val committedUnits: Int = 0,
  val insertedText: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val editorConsumed: Boolean = false,
  val trace: List<String>? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("insert_text_result")
data class InsertTextResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
  val warning: String? = null,
  val caretPlaced: Boolean? = null,
  val resultingTextLength: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val partialApplication: Boolean = false,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

/** The focused field's state; [state] is absent when no editable, non-password field has focus. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("insert_text_state_result")
data class InsertTextStateResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val success: Boolean = true,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val state: InsertTextState? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("cancel_ime_commit_result")
data class CancelImeCommitResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean = true,
  val targetRequestId: String,
  val partialApplication: Boolean,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val committedUnits: Int = 0,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

/**
 * Reply to `set_network_mock_rules` when the request carried a `requestId` (issue #10101).
 *
 * [rejectedMockIds] is null when no app confirmed the rules (an older SDK, or no SDK app), which
 * the host reports as "sent, not confirmed"; an empty list means every rule was installed.
 * [rejectedReasons] maps each rejected id to the device's own reason.
 */
@Serializable
@SerialName("set_network_mock_rules_result")
data class SetNetworkMockRulesResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean = true,
  val rejectedMockIds: List<String>? = null,
  val rejectedReasons: Map<String, String>? = null,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("set_keyboard_profile_result")
data class SetKeyboardProfileResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val success: Boolean,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val activeProfileId: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val previousProfileId: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
data class KeyboardProfileBehaviorInfo(
  val composeWords: Boolean,
  val enterStrategy: String,
  val backspaceStrategy: String,
  val recomposeOnCursorMove: Boolean,
  val recomposeOnBackspaceIntoWord: Boolean,
  val batchEdits: Boolean,
)

@Serializable
data class KeyboardProfileInfo(
  val id: String,
  val displayName: String,
  val version: Int,
  val evidenceStatus: String,
  val evidenceNote: String,
  val behavior: KeyboardProfileBehaviorInfo,
)

@Serializable
@SerialName("keyboard_profiles_result")
data class KeyboardProfileCatalogResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val catalogId: String,
  val catalogVersion: Int? = null,
  val supportedCatalogVersions: List<Int> = emptyList(),
  val activeProfileId: String? = null,
  /** Null on failure, where the wire omits the key; a successful catalog always lists them. */
  val profiles: List<KeyboardProfileInfo>? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("ime_action_result")
data class ImeActionResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val approximated: Boolean? = null,
  val action: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("select_all_result")
data class SelectAllResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Action Result
// =============================================================================

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("action_result")
data class ActionResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val success: Boolean,
  val action: String? = null,
  val totalTimeMs: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
  /**
   * The node was already in the requested state (e.g. focus on a focused node); nothing was sent.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val alreadySatisfied: Boolean = false,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Clipboard Result
// =============================================================================

@Serializable
@SerialName("clipboard_result")
data class ClipboardResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val action: String,
  val success: Boolean,
  val totalTimeMs: Long,
  val text: String? = null, // For 'get' action
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Settings Results
// =============================================================================

@Serializable
@SerialName("settings_get_result")
data class SettingsGetResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val namespace: String,
  val key: String,
  val value: String? = null,
  val found: Boolean = false,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("settings_put_result")
data class SettingsPutResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val namespace: String,
  val key: String,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("settings_list_result")
data class SettingsListResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val namespace: String,
  val entries: Map<String, String>? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Certificate Result
// =============================================================================

@Serializable
@SerialName("ca_cert_result")
data class CaCertResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val action: String, // install, remove
  val success: Boolean,
  val totalTimeMs: Long,
  val alias: String? = null,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Device Info Results
// =============================================================================

@Serializable
@SerialName("device_owner_status_result")
data class DeviceOwnerStatusResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val packageName: String? = null,
  val isDeviceOwner: Boolean,
  val isAdminActive: Boolean,
  val error: String? = null,
  @Serializable(with = PerfTimingJsonSerializer::class) val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("permission_result")
data class PermissionResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val success: Boolean,
  val permission: String,
  val granted: Boolean,
  val requestLaunched: Boolean = false,
  val canRequest: Boolean = false,
  val requiresSettings: Boolean = false,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val instructions: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val adbCommand: String? = null,
  val totalTimeMs: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Global Action Result
// =============================================================================

@Serializable
@SerialName("global_action_result")
data class GlobalActionResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val action: String,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("frame_context_validation_result")
data class FrameContextValidationResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Device Info Result
// =============================================================================

@Serializable
@SerialName("device_info_result")
data class DeviceInfoResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val screenWidth: Int? = null,
  val screenHeight: Int? = null,
  val density: Int? = null,
  val rotation: Int? = null,
  val sdkInt: Int? = null,
  val deviceModel: String? = null,
  val isEmulator: Boolean? = null,
  val wakefulness: String? = null,
  val foregroundActivity: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Accessibility Focus Results
// =============================================================================

/**
 * [focusedElement] is the serialized element, embedded on the wire as an object (#11877). A success
 * frame writes an explicit `null` when nothing has focus; an error frame omits it.
 */
@Serializable
@SerialName("current_focus_result")
@OptIn(ExperimentalSerializationApi::class)
data class CurrentFocusResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val totalTimeMs: Long,
  @Serializable(with = RawJsonSerializer::class) val focusedElement: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("traversal_order_result")
@OptIn(ExperimentalSerializationApi::class)
data class TraversalOrderResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val totalTimeMs: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val result: TraversalOrderData? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

/** [elements] are serialized elements, each embedded on the wire as an object (#11877). */
@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class TraversalOrderData(
  val elements: List<@Serializable(with = RawJsonSerializer::class) String>,
  val focusedIndex: Int?,
  val totalCount: Int,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val truncationReasons: List<String>? = null,
)

/** A success frame writes an explicit `"error":null`, so this is encoded with explicit nulls. */
@Serializable
@SerialName("highlight_response")
@OptIn(ExperimentalSerializationApi::class)
data class HighlightResponse(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val success: Boolean,
  val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  @Serializable(with = PerfTimingJsonSerializer::class)
  val perfTiming: String? = null,
) : WebSocketResponse(), CorrelatedResponse

/**
 * [missingAssets] is a warning, not a failure: after a successful `show_prototype` it lists the
 * asset ids the spec references that the device has no copy of (never uploaded, or cleared since),
 * so the host can re-upload them. It is omitted from the frame when empty or absent, so peers that
 * predate it see exactly the frame they always did.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("prototype_result")
data class PrototypeResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val error: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val missingAssets: List<String>? = null,
  /** Only the reply to `inspect_prototypes`: what the device is showing right now. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val prototypes: List<PrototypeStatusEntry>? = null,
  /** Only with [prototypes]: events dropped from the offline buffer since the service started. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val droppedEvents: Long? = null,
  /**
   * Only the reply to a successful `show_prototype`: the light or dark mode the prototype resolved
   * to (`prototype_appearance_v1`). Omitted by every other result and by older APKs.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val appearance: PrototypeAppearance? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val saved: SavedPrototypeInfo? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val savedPrototypes: List<SavedPrototypeEntry>? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val errorCode: SavedPrototypeErrorCode? = null,
  /** Only patch replies report revisions, including refusals for a matching shown prototype. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val revision: Long? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val conflict: PrototypePatchConflict? = null,
  /** Navigation state after a successful show; absent from other results. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val pages: Map<String, Int>? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val stacks: Map<String, PrototypeStackSnapshot>? = null,
  /** Only a successful show reply: why the existing prototype is hidden. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val hiddenReason: PrototypeHiddenReason? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val pin: SavedPrototypePinInfo? = null,
  /** Only the reply to `clear_prototype_storage`: how many stored keys were removed. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val cleared: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val fired: Int? = null,
  /**
   * Only the reply to a successful `show_prototype` whose spec has `window.backdrop`
   * (`prototype_backdrop_v1`): `blur` when what is behind the window was blurred, `fallback` when
   * the tonal fill was drawn instead.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val backdrop: String? = null,
  /**
   * A warning, like [missingAssets]: the `style.effects` entries of a successful show this device
   * cannot draw (`prototype_effects_v1`). Omitted when empty and by older APKs.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  val degradedEffects: List<PrototypeDegradedEffect>? = null,
) : WebSocketResponse(), CorrelatedResponse

/**
 * One `style.effects` entry the device does not draw. [reason] is `api` (the device is below the
 * effect's API floor, so the node renders unshaded) or `budget` (the effect took longer than 32 ms
 * a frame for 30 frames and its phase was frozen). [path] is the node's structural path.
 */
@Serializable
data class PrototypeDegradedEffect(val path: String, val type: String, val reason: String)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SavedPrototypeInfo(
  val id: String,
  val slug: String,
  val replaced: Boolean,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val shortcut: SavedPrototypeShortcutUpdate? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SavedPrototypePinInfo(
  val id: String,
  val status: SavedPrototypePinStatus,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val shortcut: SavedPrototypeShortcutUpdate? = null,
)

@Serializable
enum class SavedPrototypePinStatus {
  @SerialName("requested") REQUESTED,
  @SerialName("already_pinned") ALREADY_PINNED,
}

@Serializable
enum class SavedPrototypeShortcutUpdate {
  @SerialName("updated") UPDATED,
  @SerialName("rate_limited") RATE_LIMITED,
}

@Serializable
data class SavedPrototypeEntry(
  val id: String,
  val label: String,
  val slug: String,
  val savedAt: Long,
  val pinned: Boolean,
)

@Serializable
enum class SavedPrototypeErrorCode {
  @SerialName("pin_unsupported") PIN_UNSUPPORTED,
  @SerialName("device_locked") DEVICE_LOCKED,
  @SerialName("pin_failed") PIN_FAILED,
  @SerialName("invalid_id") INVALID_ID,
  @SerialName("invalid_label") INVALID_LABEL,
  @SerialName("spec_too_large") SPEC_TOO_LARGE,
  @SerialName("invalid_spec") INVALID_SPEC,
  @SerialName("invalid_asset_id") INVALID_ASSET_ID,
  @SerialName("duplicate_asset_id") DUPLICATE_ASSET_ID,
  @SerialName("unsupported_mime_type") UNSUPPORTED_MIME_TYPE,
  @SerialName("empty_asset") EMPTY_ASSET,
  @SerialName("asset_too_large") ASSET_TOO_LARGE,
  @SerialName("count_limit") COUNT_LIMIT,
  @SerialName("total_limit") TOTAL_LIMIT,
  @SerialName("missing_asset") MISSING_ASSET,
  @SerialName("saved_count_limit") SAVED_COUNT_LIMIT,
  @SerialName("storage_failure") STORAGE_FAILURE,
  @SerialName("unsupported_existing") UNSUPPORTED_EXISTING,
  @SerialName("not_found") NOT_FOUND,
  @SerialName("unsupported_format") UNSUPPORTED_FORMAT,
  @SerialName("internal_error") INTERNAL_ERROR,
  @SerialName("render_failed") RENDER_FAILED,
}

@Serializable
data class PrototypePatchConflict(val revision: Long, val state: Map<String, PrototypeScalar>)

@Serializable
enum class PrototypeHiddenReason {
  /** An attached app-layer window is absent from the accessibility windows on screen. */
  @SerialName("app_layer_window_hidden") APP_LAYER_WINDOW_HIDDEN,
  /** Locked, noninteractive, or unable to establish a safe device lock state. */
  @SerialName("device_blocked") DEVICE_BLOCKED,
}

@Serializable
enum class PrototypeAppearanceMode {
  @SerialName("light") LIGHT,
  @SerialName("dark") DARK,
}

/** Which step of the resolution order decided the mode, highest precedence first. */
@Serializable
enum class PrototypeAppearanceSource {
  /** The spec's `theme.mode` is `light` or `dark`. */
  @SerialName("explicit") EXPLICIT,
  /** The show's `appearance` override stood in for the system setting. */
  @SerialName("override") OVERRIDE,
  /** The luminance of the flat `theme.colors.background` (else `surface`) role override. */
  @SerialName("roleLuminance") ROLE_LUMINANCE,
  /** The first opaque authored background on the root chain. */
  @SerialName("authoredBackground") AUTHORED_BACKGROUND,
  /** The device's own light or dark setting. */
  @SerialName("system") SYSTEM,
}

/**
 * The appearance a shown prototype resolved to. [deviceDark] is the device's own setting whatever
 * decided [mode], so a host can tell a prototype that differs from the app behind it.
 */
@Serializable
data class PrototypeAppearance(
  val mode: PrototypeAppearanceMode,
  val source: PrototypeAppearanceSource,
  val deviceDark: Boolean,
)

/** Wire navigation snapshot; depth always equals the number of path entries. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PrototypeStackSnapshot(
  val path: List<String>,
  @EncodeDefault(EncodeDefault.Mode.ALWAYS) val depth: Int = path.size,
)

/**
 * One prototype the device is showing. [id] is the prototype id, which is its spec id.
 * [lastSequence] is the highest `prototype_event` sequence allocated for it, so a host resumes from
 * there without a rewind. [persistent] is true for `window.persistence: "device"`.
 */
@Serializable
data class PrototypeStatusEntry(
  val id: String,
  val persistent: Boolean,
  val state: Map<String, PrototypeScalar>,
  val pages: Map<String, Int> = emptyMap(),
  val lastSequence: Long,
  /**
   * True while the prototype's app is not in front: the window is hidden and untouchable, its state
   * kept, and it returns with the app. Omitted when false and by older APKs.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val suspended: Boolean = false,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val hiddenReason: PrototypeHiddenReason? = null,
  /** The mode it is drawn in right now (`prototype_appearance_v1`). Omitted by older APKs. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val appearance: PrototypeAppearance? = null,
  /** The shown spec's read-only data; absent when the spec has none. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val data: JsonObject? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  val stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
  /**
   * What the device stores for this prototype (`prototype_storage_v1`); absent without `storage`.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val storage: PrototypeStorageReport? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val timers: List<PrototypeTimerReport> = emptyList(),
  /** Node identity to permanent shader fallback reason; omitted when every shader is healthy. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val shaderFailures: Map<String, String> = emptyMap(),
  /** Effects not drawn right now (`prototype_effects_v1`); absent when every effect renders. */
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  val degradedEffects: List<PrototypeDegradedEffect> = emptyList(),
  /**
   * The last haptic and sound calls this prototype made, oldest first, at most 64
   * (`prototype_platform_haptics_v1`, `prototype_platform_sound_v1`); absent when it made none.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  val feedbackLog: List<PrototypeFeedbackEntry> = emptyList(),
)

/**
 * One `haptics.perform` or `sound.play` call. Exactly one of [effect] and [sound] is set; [nodeId]
 * is the node whose action made the call, null for a platform handler or when no single node owns
 * it; [timeMs] is the device clock; [suppressed] is true when a system setting or the ringer state
 * stopped the feedback from being produced.
 */
@Serializable
data class PrototypeFeedbackEntry(
  val timeMs: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val effect: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val sound: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val nodeId: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val suppressed: Boolean? = null,
)

/** Input validation vocabulary understood by this protocol version. */
const val PROTOTYPE_CHECKS_CAPABILITY = "prototype_checks_v1"

@Serializable
enum class PrototypeEventKind {
  @SerialName("emit") EMIT,
  @SerialName("change") CHANGE,
  @SerialName("validation_failed") VALIDATION_FAILED,
  /** A pager settled on another page: `name` is the pager id, the payload the new page index. */
  @SerialName("page_changed") PAGE_CHANGED,
  /** A stack changed top or depth: `name` is its id, payload is `{screen, depth}`. */
  @SerialName("screen_changed") SCREEN_CHANGED,
  @SerialName("dismissed") DISMISSED,
  /**
   * The resolved light or dark mode of a shown prototype changed (`prototype_appearance_v1`). The
   * payload is `{mode, source}`, with the values of [PrototypeAppearance]; `name` is null.
   */
  @SerialName("appearance_changed") APPEARANCE_CHANGED,
}

/** Unsolicited frame. Pager selection is separate from authored scalar state. */
@Serializable
@SerialName("prototype_event")
@OptIn(ExperimentalSerializationApi::class)
data class PrototypeEvent(
  override val timestamp: Long,
  val id: String,
  /**
   * Future emitter contract: per prototype id, monotonic starting at 1. Reconnects must not reset
   * it; hosts should treat lower-or-equal sequences for the same id as duplicates.
   */
  val sequence: Long,
  val kind: PrototypeEventKind,
  val name: String?,
  val payload: JsonElement?,
  val state: Map<String, PrototypeScalar>,
  val pages: Map<String, Int> = emptyMap(),
  @EncodeDefault(EncodeDefault.Mode.NEVER)
  val stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
  @EncodeDefault(EncodeDefault.Mode.NEVER) val context: JsonObject? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val contextTruncated: Boolean? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val validity: Map<String, Boolean>? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val keys: List<String>? = null,
) : WebSocketResponse() {
  init {
    require(contextTruncated != false) { "contextTruncated must be true or absent" }
  }
}

// =============================================================================
// Storage Results
// =============================================================================

@Serializable
@SerialName("keystore_discovery")
data class KeystoreDiscoveryResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val state: KeystoreDiscoveryState,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("sdk_capabilities")
data class SdkCapabilitiesResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val state: SdkCapabilitiesState,
) : WebSocketResponse(), CorrelatedResponse

// Storage results (#11877): field order is the wire order; absent optionals are omitted.

@Serializable
@SerialName("preference_files")
data class PreferenceFilesResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val success: Boolean,
  val files: List<StorageFileInfo>? = null,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

/** Encoded with explicit nulls so an entry's null `value` stays on the wire as `"value":null`. */
@Serializable
@SerialName("preferences")
@OptIn(ExperimentalSerializationApi::class)
data class PreferencesResult(
  override val timestamp: Long,
  @EncodeDefault(EncodeDefault.Mode.NEVER) override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val success: Boolean,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val entries: List<StorageEntry>? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("subscribe_storage_result")
data class SubscribeStorageResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val success: Boolean,
  val subscriptionId: String? = null,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("unsubscribe_storage_result")
data class UnsubscribeStorageResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val success: Boolean,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("get_preference_result")
data class GetPreferenceResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val key: String,
  val success: Boolean,
  val found: Boolean = false,
  val value: String? = null,
  val valueType: String? = null,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("set_preference_result")
data class SetPreferenceResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val key: String,
  val success: Boolean,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("remove_preference_result")
data class RemovePreferenceResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val key: String,
  val success: Boolean,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("clear_preferences_result")
data class ClearPreferencesResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val success: Boolean,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

// =============================================================================
// Package Manager Results
// =============================================================================

@Serializable
data class InstalledPackageRecord(
  val packageName: String,
  val isSystem: Boolean,
  val versionName: String? = null,
  val versionCode: Long? = null,
  /** Launcher label as a human sees it, from `PackageManager.getApplicationLabel` (#6798). */
  val label: String? = null,
  /**
   * Whether the package has a launchable entry point, i.e. `launchApp` can do something (#6798).
   */
  val launchable: Boolean? = null,
)

@Serializable
@SerialName("installed_packages_result")
data class InstalledPackagesResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val userId: Int,
  val packages: List<InstalledPackageRecord> = emptyList(),
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("package_info_result")
data class PackageInfoResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val isSystem: Boolean = false,
  val applicationLabel: String? = null,
  val versionName: String? = null,
  val versionCode: Long? = null,
  val installerPackage: String? = null,
  val firstInstallTime: Long? = null,
  val lastUpdateTime: Long? = null,
  val allowBackup: Boolean? = null,
  val requestedPermissions: List<String> = emptyList(),
  val grantedPermissions: Map<String, Boolean> = emptyMap(),
  val mainActivity: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable
@SerialName("launch_intent_result")
data class LaunchIntentResult(
  override val timestamp: Long,
  override val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val componentName: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse(), CorrelatedResponse

@Serializable data class PrototypeTimerReport(val id: String, val nextFireInMs: Long, val runs: Int)
