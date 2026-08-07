package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Sealed class hierarchy for all inbound WebSocket messages from MCP server to Android.
 *
 * Each request type is a separate data class with only the fields it needs, replacing the flat
 * WebSocketRequest with 25+ optional fields.
 */
@Serializable
sealed class WebSocketRequest {
  abstract val requestId: String?
}

// =============================================================================
// Hierarchy Requests
// =============================================================================

@Serializable
@SerialName("request_hierarchy")
data class RequestHierarchy(
  override val requestId: String? = null,
  val disableAllFiltering: Boolean = false,
  val maxDepth: Int? = null,
  val maxNodes: Int? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_hierarchy_if_stale")
data class RequestHierarchyIfStale(
  override val requestId: String? = null,
  val sinceTimestamp: Long,
  val disableAllFiltering: Boolean = false,
) : WebSocketRequest()

@Serializable
@SerialName("set_hierarchy_interval")
data class SetHierarchyInterval(
  override val requestId: String? = null,
  val intervalMs: Long? = null,
) : WebSocketRequest()

// =============================================================================
// Screenshot Request
// =============================================================================

@Serializable
@SerialName("request_screenshot")
data class RequestScreenshot(override val requestId: String? = null) : WebSocketRequest()

// =============================================================================
// Gesture Requests
// =============================================================================

// Gesture coordinate fields are `Double` (not `Int`) so fractional/sub-pixel JSON numbers
// deserialize cleanly instead of throwing an opaque kotlinx decode error, symmetric to the iOS
// runner (#2909 / PR #2919). `Double` decodes both integer and fractional JSON, so the existing
// TS rounded path (roundCoordinates:true + Math.round, see CtrlProxyGestures.ts) is unaffected —
// integer payloads decode to identical `.0` values. Durations, `offset`, and `rotationDegrees` are
// not coordinates and keep their original types. See #2927.
@Serializable
@SerialName("request_tap_coordinates")
data class RequestTapCoordinates(
  override val requestId: String? = null,
  val x: Double,
  val y: Double,
  val duration: Long = 10L,
  val frameContext: String? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_swipe")
data class RequestSwipe(
  override val requestId: String? = null,
  val x1: Double,
  val y1: Double,
  val x2: Double,
  val y2: Double,
  val duration: Long = 300L,
  val frameContext: String? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_two_finger_swipe")
data class RequestTwoFingerSwipe(
  override val requestId: String? = null,
  val x1: Double,
  val y1: Double,
  val x2: Double,
  val y2: Double,
  val duration: Long = 300L,
  val offset: Int = 100,
) : WebSocketRequest()

@Serializable
@SerialName("request_drag")
data class RequestDrag(
  override val requestId: String? = null,
  val x1: Double,
  val y1: Double,
  val x2: Double,
  val y2: Double,
  val pressDurationMs: Long = 600L,
  val dragDurationMs: Long = 300L,
  val holdDurationMs: Long = 100L,
  val frameContext: String? = null,
  // Legacy field names for backward compatibility
  val holdTime: Long? = null,
  val duration: Long? = null,
) : WebSocketRequest() {
  /** Resolved press duration, using legacy holdTime as fallback */
  val resolvedPressDurationMs: Long
    get() = if (pressDurationMs == 600L && holdTime != null) holdTime else pressDurationMs

  /** Resolved drag duration, using legacy duration as fallback */
  val resolvedDragDurationMs: Long
    get() = if (dragDurationMs == 300L && duration != null) duration else dragDurationMs
}

@Serializable
@SerialName("request_pinch")
data class RequestPinch(
  override val requestId: String? = null,
  val centerX: Double,
  val centerY: Double,
  val distanceStart: Double,
  val distanceEnd: Double,
  /**
   * Degrees the two-finger axis rotates *during* the pinch (default 0): the axis starts horizontal
   * and ends rotated by this amount — a combined pinch+rotate, not a pinch along a fixed rotated
   * axis. Shared convention with the iOS runner. See issue #2911.
   */
  val rotationDegrees: Float = 0f,
  val duration: Long = 300L,
) : WebSocketRequest()

// =============================================================================
// Text Input Requests
// =============================================================================

@Serializable
@SerialName("request_set_text")
data class RequestSetText(
  override val requestId: String? = null,
  val text: String,
  val resourceId: String? = null,
  val dismissKeyboard: Boolean = false,
  val frameContext: String? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_ime_action")
data class RequestImeAction(
  override val requestId: String? = null,
  val action: String, // done, next, search, send, go, previous
  val frameContext: String? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_select_all")
data class RequestSelectAll(override val requestId: String? = null) : WebSocketRequest()

// =============================================================================
// Node Action Request
// =============================================================================

@Serializable
data class NodeSelector(
  val resourceId: String? = null,
  val testTag: String? = null,
  val uniqueId: String? = null,
  val collectionRow: Int? = null,
  val collectionColumn: Int? = null,
) {
  fun hasCriteria(): Boolean =
    (resourceId != null || testTag != null || uniqueId != null) &&
      ((collectionRow == null && collectionColumn == null) ||
        (collectionRow != null && collectionColumn != null))
}

@Serializable
@SerialName("request_action")
data class RequestAction(
  override val requestId: String? = null,
  val action: String, // e.g., long_click
  val resourceId: String? = null,
  val selector: NodeSelector? = null,
  val boundsLeft: Int? = null,
  val boundsTop: Int? = null,
  val boundsRight: Int? = null,
  val boundsBottom: Int? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_hit_test")
data class RequestHitTest(
  override val requestId: String? = null,
  val x: Int,
  val y: Int,
) : WebSocketRequest()

// =============================================================================
// Clipboard Request
// =============================================================================

@Serializable
@SerialName("request_clipboard")
data class RequestClipboard(
  override val requestId: String? = null,
  val action: String, // copy, paste, clear, get
  val text: String? = null, // Required for 'copy' action
) : WebSocketRequest()

// =============================================================================
// Settings Requests
// =============================================================================

@Serializable
@SerialName("request_settings_get")
data class RequestSettingsGet(
  override val requestId: String? = null,
  val namespace: String, // "system" | "secure" | "global"
  val key: String,
) : WebSocketRequest()

@Serializable
@SerialName("request_settings_put")
data class RequestSettingsPut(
  override val requestId: String? = null,
  val namespace: String, // "system" | "secure" | "global"
  val key: String,
  val value: String? = null, // null = delete
  val valueType: String = "string", // "string" | "int" | "long" | "float"
) : WebSocketRequest()

@Serializable
@SerialName("request_settings_list")
data class RequestSettingsList(
  override val requestId: String? = null,
  val namespace: String,
) : WebSocketRequest()

// =============================================================================
// Certificate Requests
// =============================================================================

@Serializable
@SerialName("install_ca_cert")
data class InstallCaCert(
  override val requestId: String? = null,
  val certificate: String,
) : WebSocketRequest()

@Serializable
@SerialName("install_ca_cert_from_path")
data class InstallCaCertFromPath(
  override val requestId: String? = null,
  val devicePath: String,
) : WebSocketRequest()

@Serializable
@SerialName("remove_ca_cert")
data class RemoveCaCert(
  override val requestId: String? = null,
  val alias: String? = null,
  val certificate: String? = null,
) : WebSocketRequest()

// =============================================================================
// Device Info Requests
// =============================================================================

@Serializable
@SerialName("get_device_owner_status")
data class GetDeviceOwnerStatus(override val requestId: String? = null) : WebSocketRequest()

@Serializable
@SerialName("get_permission")
data class GetPermission(
  override val requestId: String? = null,
  val permission: String?,
  val requestPermission: Boolean? = null,
) : WebSocketRequest()

// =============================================================================
// Accessibility Focus Requests
// =============================================================================

@Serializable
@SerialName("get_current_focus")
data class GetCurrentFocus(override val requestId: String? = null) : WebSocketRequest()

@Serializable
@SerialName("get_traversal_order")
data class GetTraversalOrder(override val requestId: String? = null) : WebSocketRequest()

// =============================================================================
// Highlight Request
// =============================================================================

@Serializable
@SerialName("add_highlight")
data class AddHighlight(
  override val requestId: String? = null,
  val id: String? = null,
  val shape: HighlightShape? = null,
) : WebSocketRequest()

// =============================================================================
// Storage Requests
// =============================================================================

@Serializable
@SerialName("list_preference_files")
data class ListPreferenceFiles(
  override val requestId: String? = null,
  val packageName: String,
) : WebSocketRequest()

@Serializable
@SerialName("get_preferences")
data class GetPreferences(
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
) : WebSocketRequest()

@Serializable
@SerialName("subscribe_storage")
data class SubscribeStorage(
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
) : WebSocketRequest()

@Serializable
@SerialName("unsubscribe_storage")
data class UnsubscribeStorage(
  override val requestId: String? = null,
  // The TS client sends only `subscriptionId` (formatted as "packageName:fileName"); packageName
  // and fileName are kept nullable so the real wire message decodes without throwing. When only
  // subscriptionId is present, CtrlProxyMessageHandler splits it on the first ':' to recover
  // packageName/fileName before dispatching the unsubscribe. See CtrlProxyMessageHandler for
  // details.
  val subscriptionId: String? = null,
  val packageName: String? = null,
  val fileName: String? = null,
) : WebSocketRequest()

@Serializable
@SerialName("get_preference")
data class GetPreference(
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val key: String,
) : WebSocketRequest()

@Serializable
@SerialName("set_preference")
data class SetPreference(
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val key: String,
  val value: String?,
  val valueType: String,
) : WebSocketRequest()

@Serializable
@SerialName("remove_preference")
data class RemovePreference(
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
  val key: String,
) : WebSocketRequest()

@Serializable
@SerialName("clear_preferences")
data class ClearPreferences(
  override val requestId: String? = null,
  val packageName: String,
  val fileName: String,
) : WebSocketRequest()

// =============================================================================
// Global Action Request
// =============================================================================

@Serializable
@SerialName("request_global_action")
data class RequestGlobalAction(
  override val requestId: String? = null,
  val action: String, // back, home, recent, notifications, power_dialog, lock_screen
  val frameContext: String? = null,
) : WebSocketRequest()

@Serializable
@SerialName("validate_frame_context")
data class ValidateFrameContext(
  override val requestId: String? = null,
  val frameContext: String,
) : WebSocketRequest()

// =============================================================================
// Device Info Request
// =============================================================================

@Serializable
@SerialName("request_device_info")
data class RequestDeviceInfo(override val requestId: String? = null) : WebSocketRequest()

// =============================================================================
// Configuration Requests
// =============================================================================

@Serializable
@SerialName("set_recomposition_tracking")
data class SetRecompositionTracking(
  override val requestId: String? = null,
  val enabled: Boolean,
) : WebSocketRequest()

@Serializable
@SerialName("set_accessibility_flags")
data class SetAccessibilityFlags(
  override val requestId: String? = null,
  val includeNotImportantViews: Boolean = true,
  val reportViewIds: Boolean = true,
  val retrieveInteractiveWindows: Boolean = true,
  val occlusionEnabled: Boolean = true,
) : WebSocketRequest()

@Serializable
@SerialName("set_network_mock_rules")
data class SetNetworkMockRules(
  override val requestId: String? = null,
  val rules: List<NetworkMockRuleDto>,
) : WebSocketRequest()

@Serializable
data class NetworkMockRuleDto(
  val mockId: String,
  val host: String,
  val path: String,
  val method: String,
  val limit: Int? = null,
  val remaining: Int? = null,
  val statusCode: Int,
  val responseHeaders: Map<String, String> = emptyMap(),
  val responseBody: String = "",
  val contentType: String = "application/json",
)

@Serializable
@SerialName("set_network_error_simulation")
data class SetNetworkErrorSimulation(
  override val requestId: String? = null,
  val enabled: Boolean,
  val errorType: String? = null,
  val limit: Int? = null,
  val expiresAtEpochMs: Long? = null,
) : WebSocketRequest()

// =============================================================================
// Package Manager Requests
// =============================================================================

@Serializable
@SerialName("request_installed_packages")
data class RequestInstalledPackages(
  override val requestId: String? = null,
  val includeSystem: Boolean = true,
  val userId: Int? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_package_info")
data class RequestPackageInfo(
  override val requestId: String? = null,
  val packageName: String,
  val includePermissions: Boolean = true,
) : WebSocketRequest()

@Serializable
@SerialName("request_launch_intent")
data class RequestLaunchIntent(
  override val requestId: String? = null,
  val packageName: String,
) : WebSocketRequest()

// =============================================================================
// Recording Requests
// =============================================================================

@Serializable
@SerialName("start_recording")
data class StartRecording(override val requestId: String? = null) : WebSocketRequest()

@Serializable
@SerialName("stop_recording")
data class StopRecording(override val requestId: String? = null) : WebSocketRequest()
