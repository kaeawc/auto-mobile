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
  val displayId: Int? = null,
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
data class RequestScreenshot(
  override val requestId: String? = null,
  val displayId: Int? = null,
  /**
   * Hide CtrlProxy's prototype window for this capture only: hide, wait for a rendered frame,
   * capture, restore, all on the device in this one request
   * (`screenshot_hide_prototype_v1`, #9305). Older APKs ignore the field and capture with the
   * prototype showing.
   */
  val hidePrototypes: Boolean = false,
) : WebSocketRequest()

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
  val displayId: Int? = null,
  val doubleTap: Boolean = false,
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
  val displayId: Int? = null,
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
  val displayId: Int? = null,
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
  val displayId: Int? = null,
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
  val displayId: Int? = null,
) : WebSocketRequest()

// =============================================================================
// Streaming Gesture Requests
// =============================================================================
//
// A live drag is delivered as a stream of three request kinds sharing one [gestureId]: one
// `request_gesture_start` (finger down), zero or more `request_gesture_move` (incremental travel),
// and one `request_gesture_end` (lift or cancel). The runner chains them into a single continued
// AccessibilityService gesture (`StrokeDescription.willContinue`/`continueStroke`) so the device
// tracks the pointer in real time instead of receiving one atomic swipe on release.
//
// Deliberately frame-identity-free: like taps, these carry no `frameContext`, so a snapshot
// advancing mid-drag cannot reject an in-flight gesture as stale (issue: streaming gesture input).

@Serializable
@SerialName("request_gesture_start")
data class RequestGestureStart(
  override val requestId: String? = null,
  val gestureId: String,
  val x: Double,
  val y: Double,
  /** Fixed for the entire stream; move/end inherit this display from the session. */
  val displayId: Int? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_gesture_move")
data class RequestGestureMove(
  override val requestId: String? = null,
  val gestureId: String,
  val x: Double,
  val y: Double,
) : WebSocketRequest()

@Serializable
@SerialName("request_gesture_end")
data class RequestGestureEnd(
  override val requestId: String? = null,
  val gestureId: String,
  val x: Double,
  val y: Double,
  /** Abandon the drag and lift in place instead of completing at ([x], [y]). */
  val cancel: Boolean = false,
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
data class InsertTextState(
  val text: String? = null,
  val isShowingHintText: Boolean = false,
  val selectionStart: Int,
  val selectionEnd: Int,
)

@Serializable
@SerialName("request_insert_text_state")
data class RequestInsertTextState(override val requestId: String? = null) : WebSocketRequest()

@Serializable
@SerialName("request_insert_text")
data class RequestInsertText(
  override val requestId: String? = null,
  val text: String,
  val expectedSuffix: String? = null,
  val precedingState: InsertTextState? = null,
  val acceptsCaretNotPlaced: Boolean = false,
) : WebSocketRequest()

@Serializable
@SerialName("request_commit_text")
data class RequestCommitText(
  override val requestId: String? = null,
  val text: String,
  val priorImeId: String? = null,
  val delivery: ImeTextDelivery = ImeTextDelivery.COMMIT,
  val timeoutMs: Long? = null,
) : WebSocketRequest()

@Serializable
@SerialName("request_cancel_ime_commit")
data class RequestCancelImeCommit(
  override val requestId: String? = null,
  val targetRequestId: String,
) : WebSocketRequest()

@Serializable
@SerialName("request_set_keyboard_profile")
data class RequestSetKeyboardProfile(
  override val requestId: String? = null,
  val profileId: String,
) : WebSocketRequest()

@Serializable
@SerialName("request_list_keyboard_profiles")
data class RequestListKeyboardProfiles(
  override val requestId: String? = null,
  val supportedCatalogVersions: List<Int>,
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
@SerialName("request_click_focused_input")
data class RequestClickFocusedInput(override val requestId: String? = null) : WebSocketRequest()

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

/**
 * Activates a live [android.text.style.ClickableSpan] without degrading to a node or coordinate
 * tap. [selector] scopes the search to a uniquely re-resolved text owner when supplied.
 */
@Serializable
@SerialName("request_activate_accessibility_link")
data class RequestActivateAccessibilityLink(
  override val requestId: String? = null,
  val text: String,
  val occurrence: Int = 0,
  val selector: NodeSelector? = null,
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

// Agent-authored prototypes
/**
 * [displayId] is the Android logical display, with the same meaning as the gesture requests'
 * `displayId`. Absent/null means the service's default display (the pre-#9308 behaviour); hosts
 * only send it to a device advertising `prototype_display_id_v1`, because an older device would
 * ignore the unknown field and silently show the prototype on the wrong display.
 *
 * A show whose `spec.id` is the prototype already on screen replaces it in place: it keeps the
 * display it is on (ignoring [displayId]) and each pager's page. [reset] true starts it fresh
 * instead. Hosts send `reset` only when true; an older device ignores it and always starts fresh.
 */
@Serializable
@SerialName("show_prototype")
data class ShowPrototype(
  override val requestId: String? = null,
  val spec: PrototypeSpec,
  val displayId: Int? = null,
  val reset: Boolean = false,
) : WebSocketRequest()

@Serializable
@SerialName("dismiss_prototype")
data class DismissPrototype(
  override val requestId: String? = null,
  val id: String? = null,
  val all: Boolean? = null,
) : WebSocketRequest()

/**
 * Asks the device which prototypes it is showing. Answered by one `prototype_result` carrying
 * `prototypes`. Any events buffered while no host was connected (device-persistent
 * prototypes, #10494) are delivered first, as ordinary `prototype_event` frames. Hosts only send it
 * to a device advertising `prototype_persistence_replay_v1`.
 */
@Serializable
@SerialName("inspect_prototypes")
data class InspectPrototypes(override val requestId: String? = null) : WebSocketRequest()

/**
 * Uploads one prototype image asset, replacing any asset with the same [id]. [dataBase64] is the
 * encoded image (PNG, JPEG or WebP) in standard base64 without line breaks. Answered by one
 * `prototype_result`. [toString] never renders the payload, so a stray log line cannot dump bytes.
 */
@Serializable
@SerialName("put_prototype_asset")
data class PutPrototypeAsset(
  override val requestId: String? = null,
  val id: String,
  val mimeType: String,
  val dataBase64: String,
) : WebSocketRequest() {
  override fun toString(): String =
    "PutPrototypeAsset(requestId=$requestId, id=$id, mimeType=$mimeType, " +
      "dataBase64=<${dataBase64.length} chars>)"
}

/** Removes one prototype asset. Idempotent: removing an unknown [id] still succeeds. */
@Serializable
@SerialName("remove_prototype_asset")
data class RemovePrototypeAsset(override val requestId: String? = null, val id: String) :
  WebSocketRequest()

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

/** Discovers the app-owned read-only Keystore metadata bridge. */
@Serializable
@SerialName("discover_keystore")
data class DiscoverKeystore(
  override val requestId: String? = null,
  val packageName: String,
) : WebSocketRequest()

/**
 * Reads the app SDK's capability and capture-policy snapshot (issue #5191). [userId] names the
 * Android user (work or secondary profile) whose app instance to read; null reads the service's own
 * user. Hosts send it only to a service advertising `sdk_capabilities_user_id_v1`.
 */
@Serializable
@SerialName("get_sdk_capabilities")
data class GetSdkCapabilities(
  override val requestId: String? = null,
  val packageName: String,
  val userId: Int? = null,
) : WebSocketRequest()

/**
 * Lists the Jetpack DataStore instances exposed by a host-registered adapter (issue #5192/#5573).
 * DataStore descriptors reuse the SharedPreferences result shapes (StorageResponse.FileList, empty
 * path); only the request type is distinct so the device can route to the DataStore adapter.
 */
@Serializable
@SerialName("list_data_stores")
data class ListDataStores(
  override val requestId: String? = null,
  val packageName: String,
  val adapterName: String,
) : WebSocketRequest()

/** Reads all entries from a named DataStore instance (issue #5192/#5573). */
@Serializable
@SerialName("get_data_store")
data class GetDataStore(
  override val requestId: String? = null,
  val packageName: String,
  val adapterName: String,
  val storeName: String,
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
  /** Host-clock epoch. Kept for older SDKs; newer ones prefer [remainingMs]. */
  val expiresAtEpochMs: Long? = null,
  /** Time left on the simulation, measured by the receiver's own monotonic clock (#10062). */
  val remainingMs: Long? = null,
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
