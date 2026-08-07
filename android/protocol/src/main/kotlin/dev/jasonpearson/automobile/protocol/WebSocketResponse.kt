package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
  val requestId: String? = null,
  val success: Boolean = false,
  val error: String,
) : WebSocketResponse()

// =============================================================================
// Push Events (unsolicited messages)
// =============================================================================

@Serializable
@SerialName("hierarchy_update")
data class HierarchyUpdateEvent(
  override val timestamp: Long,
  val data: String, // JSON string of hierarchy data
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("interaction_event")
data class InteractionEvent(
  override val timestamp: Long,
  val event: String, // JSON string of interaction event
) : WebSocketResponse()

@Serializable
@SerialName("package_event")
data class PackageEvent(
  override val timestamp: Long,
  val event: PackageEventData,
) : WebSocketResponse()

@Serializable
data class PackageEventData(
  val eventType: String,
  val packageName: String,
  val className: String? = null,
)

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

@Serializable
@SerialName("storage_changed")
data class StorageChangedEvent(
  override val timestamp: Long,
  val packageName: String,
  val fileName: String,
  val data: String, // JSON string of preferences
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
  val requestId: String? = null,
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
) : WebSocketResponse()

@Serializable
@SerialName("screenshot_error")
data class ScreenshotErrorResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val error: String,
) : WebSocketResponse()

// =============================================================================
// Gesture Results
// =============================================================================

@Serializable
@SerialName("swipe_result")
data class SwipeResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("tap_coordinates_result")
data class TapCoordinatesResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("drag_result")
data class DragResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("pinch_result")
data class PinchResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long? = null,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Text Input Results
// =============================================================================

@Serializable
@SerialName("set_text_result")
data class SetTextResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("ime_action_result")
data class ImeActionResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val action: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("select_all_result")
data class SelectAllResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Action Result
// =============================================================================

@Serializable
@SerialName("action_result")
data class ActionResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val action: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Clipboard Result
// =============================================================================

@Serializable
@SerialName("clipboard_result")
data class ClipboardResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val action: String,
  val text: String? = null, // For 'get' action
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Settings Results
// =============================================================================

@Serializable
@SerialName("settings_get_result")
data class SettingsGetResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val namespace: String,
  val key: String,
  val value: String? = null,
  val found: Boolean = false,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("settings_put_result")
data class SettingsPutResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val namespace: String,
  val key: String,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("settings_list_result")
data class SettingsListResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val namespace: String,
  val entries: Map<String, String>? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Certificate Result
// =============================================================================

@Serializable
@SerialName("ca_cert_result")
data class CaCertResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val action: String, // install, remove
  val alias: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Device Info Results
// =============================================================================

@Serializable
@SerialName("device_owner_status_result")
data class DeviceOwnerStatusResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val isDeviceOwner: Boolean,
  val isAdminActive: Boolean,
  val packageName: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("permission_result")
data class PermissionResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val permission: String,
  val granted: Boolean,
  val requestLaunched: Boolean = false,
  val canRequest: Boolean = false,
  val requiresSettings: Boolean = false,
  val instructions: String? = null,
  val adbCommand: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

// =============================================================================
// Global Action Result
// =============================================================================

@Serializable
@SerialName("global_action_result")
data class GlobalActionResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val action: String,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("frame_context_validation_result")
data class FrameContextValidationResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse()

// =============================================================================
// Device Info Result
// =============================================================================

@Serializable
@SerialName("device_info_result")
data class DeviceInfoResult(
  override val timestamp: Long,
  val requestId: String? = null,
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
) : WebSocketResponse()

// =============================================================================
// Accessibility Focus Results
// =============================================================================

@Serializable
@SerialName("current_focus_result")
data class CurrentFocusResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val focusedElement: String? = null, // JSON string of focused element
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("traversal_order_result")
data class TraversalOrderResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val result: TraversalOrderData? = null,
  val totalTimeMs: Long,
  val error: String? = null,
  val perfTiming: String? = null,
) : WebSocketResponse()

@Serializable
data class TraversalOrderData(
  val elements: List<String>, // JSON strings of elements
  val focusedIndex: Int?,
  val totalCount: Int,
)

@Serializable
@SerialName("highlight_response")
data class HighlightResponse(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val error: String? = null,
) : WebSocketResponse()

// =============================================================================
// Storage Results
// =============================================================================

@Serializable
@SerialName("preference_files")
data class PreferenceFilesResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val files: List<String>? = null,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("preferences")
data class PreferencesResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val data: String? = null, // JSON string of preferences
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("subscribe_storage_result")
data class SubscribeStorageResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("unsubscribe_storage_result")
data class UnsubscribeStorageResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("get_preference_result")
data class GetPreferenceResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val key: String,
  val value: String? = null,
  val type: String? = null,
  val found: Boolean = false,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("set_preference_result")
data class SetPreferenceResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val key: String,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("remove_preference_result")
data class RemovePreferenceResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val key: String,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("clear_preferences_result")
data class ClearPreferencesResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val fileName: String,
  val error: String? = null,
) : WebSocketResponse()

// =============================================================================
// Package Manager Results
// =============================================================================

@Serializable
data class InstalledPackageRecord(
  val packageName: String,
  val isSystem: Boolean,
  val versionName: String? = null,
  val versionCode: Long? = null,
)

@Serializable
@SerialName("installed_packages_result")
data class InstalledPackagesResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val userId: Int,
  val packages: List<InstalledPackageRecord> = emptyList(),
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse()

@Serializable
@SerialName("package_info_result")
data class PackageInfoResult(
  override val timestamp: Long,
  val requestId: String? = null,
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
) : WebSocketResponse()

@Serializable
@SerialName("launch_intent_result")
data class LaunchIntentResult(
  override val timestamp: Long,
  val requestId: String? = null,
  val success: Boolean,
  val packageName: String,
  val componentName: String? = null,
  val totalTimeMs: Long,
  val error: String? = null,
) : WebSocketResponse()
