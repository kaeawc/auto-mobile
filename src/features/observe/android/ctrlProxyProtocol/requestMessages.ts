import type { AdvancePrototypeClockMessage } from "./prototypeMessages";
/** Android control-proxy request shapes and discriminated request union. */
import { type ClearPrototypeStorageMessage } from "../../../prototype/prototypeStorageWire";
import type { HighlightShape } from "../../../../models/VisualHighlight";
import type { ImeAction } from "../../../../models/ImeAction";
import type { NetworkMockRuleSync } from "../../../../utils/networkMockRules";
import type { KeyValueType } from "../../../storage/storageTypes";
import type { SettingsNamespace, SettingsValueType } from "../types";
import type {
  ShowPrototypeMessage,
  DismissPrototypeMessage,
  PatchPrototypeMessage,
  SavePrototypeMessage,
  ListSavedPrototypesMessage,
  DeleteSavedPrototypeMessage,
  PinSavedPrototypeMessage,
  InspectPrototypesMessage,
  PutPrototypeAssetMessage,
  RemovePrototypeAssetMessage,
} from "./prototypeMessages";

// =============================================================================
// Hierarchy Requests
// =============================================================================

/** `@SerialName("request_hierarchy")` → `RequestHierarchy` */
export interface RequestHierarchyMessage {
  type: "request_hierarchy";
  requestId: string;
  displayId?: number;
  disableAllFiltering: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * `@SerialName("request_hierarchy_if_stale")` → `RequestHierarchyIfStale`.
 * The device also accepts `disableAllFiltering` (default false); the TS client omits it.
 */
export interface RequestHierarchyIfStaleMessage {
  disableAllFiltering?: boolean;
  type: "request_hierarchy_if_stale";
  requestId: string;
  sinceTimestamp: number;
}

/** `@SerialName("set_hierarchy_interval")` -> `SetHierarchyInterval` */
export interface SetHierarchyIntervalMessage {
  requestId?: string;
  type: "set_hierarchy_interval";
  intervalMs: number | null;
}

// =============================================================================
// Screenshot Request
// =============================================================================

/** `@SerialName("request_screenshot")` → `RequestScreenshot` */
export interface RequestScreenshotMessage {
  type: "request_screenshot";
  requestId: string;
  displayId?: number;
  /** Hide CtrlProxy's prototype for this capture only; sent only under {@link SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY}. */
  hidePrototypes?: boolean;
}

// =============================================================================
// Gesture Requests (emitted via the shared sendCommand/createMessage path)
// =============================================================================

/** `@SerialName("request_tap_coordinates")` → `RequestTapCoordinates` */
export interface RequestTapCoordinatesMessage {
  frameContext?: string;
  doubleTap?: boolean;
  type: "request_tap_coordinates";
  requestId: string;
  x: number;
  y: number;
  duration: number;
  displayId?: number;
}

/** `@SerialName("request_swipe")` → `RequestSwipe` */
export interface RequestSwipeMessage {
  frameContext?: string;
  type: "request_swipe";
  requestId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
  displayId?: number;
}

/** `@SerialName("request_two_finger_swipe")` → `RequestTwoFingerSwipe` */
export interface RequestTwoFingerSwipeMessage {
  type: "request_two_finger_swipe";
  requestId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
  offset: number;
  displayId?: number;
  /** 2-5 fingers (default 2); above 2 requires the `multi_finger_gesture_v1` capability. */
  fingerCount?: number;
}

/** `@SerialName("request_drag")` → `RequestDrag` (legacy holdTime/duration fields not sent) */
export interface RequestDragMessage {
  frameContext?: string;
  holdTime?: number;
  duration?: number;
  type: "request_drag";
  requestId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pressDurationMs: number;
  dragDurationMs: number;
  holdDurationMs: number;
  displayId?: number;
}

/** `@SerialName("request_pinch")` → `RequestPinch` */
export interface RequestPinchMessage {
  type: "request_pinch";
  requestId: string;
  centerX: number;
  centerY: number;
  distanceStart: number;
  distanceEnd: number;
  rotationDegrees: number;
  duration: number;
  displayId?: number;
}

// =============================================================================
// Streaming Gesture Requests (emitted via the shared sendCommand/createMessage path)
// =============================================================================
//
// A real-time drag is a `request_gesture_start` (finger down), zero or more `request_gesture_move`
// (incremental travel) sharing one [gestureId], and one `request_gesture_end` (lift or cancel). The
// runner chains them into a single continued AccessibilityService gesture. Like taps, they carry no
// `frameContext` so a snapshot advancing mid-drag cannot reject an in-flight gesture as stale.

/** `@SerialName("request_gesture_start")` → `RequestGestureStart` (finger down) */
export interface RequestGestureStartMessage {
  type: "request_gesture_start";
  requestId?: string;
  gestureId: string;
  x: number;
  y: number;
  displayId?: number;
}

/** `@SerialName("request_gesture_move")` → `RequestGestureMove` (incremental travel) */
export interface RequestGestureMoveMessage {
  type: "request_gesture_move";
  requestId?: string;
  gestureId: string;
  x: number;
  y: number;
}

/** `@SerialName("request_gesture_end")` → `RequestGestureEnd` (lift, or cancel-in-place) */
export interface RequestGestureEndMessage {
  type: "request_gesture_end";
  requestId?: string;
  gestureId: string;
  x: number;
  y: number;
  cancel?: boolean;
}

// =============================================================================
// Text Input Requests (emitted via the shared sendCommand/createMessage path)
// =============================================================================

/** `@SerialName("request_set_text")` → `RequestSetText` */
export interface RequestSetTextMessage {
  type: "request_set_text";
  requestId: string;
  text: string;
  resourceId?: string;
  dismissKeyboard?: boolean;
  frameContext?: string;
}

export interface InsertTextState {
  text?: string | null;
  isShowingHintText: boolean;
  selectionStart: number;
  selectionEnd: number;
}

/** `@SerialName("request_insert_text_state")` → `RequestInsertTextState` */
export interface RequestInsertTextStateMessage {
  type: "request_insert_text_state";
  requestId: string;
}

/** `@SerialName("request_insert_text")` → `RequestInsertText` */
export interface RequestInsertTextMessage {
  type: "request_insert_text";
  requestId: string;
  text: string;
  expectedSuffix?: string;
  precedingState?: InsertTextState;
  acceptsCaretNotPlaced?: boolean;
}

/** `@SerialName("request_commit_text")` → `RequestCommitText` */
export interface RequestCommitTextMessage {
  type: "request_commit_text";
  requestId: string;
  text: string;
  priorImeId?: string;
  /**
   * `commit` uses realistic typing pauses so editors can react to typed input.
   * `clearField` clears through the editor connection before realistic typing, preserving
   * autocomplete, markdown/autoformat shortcuts, and mention chips in a rich-text composer.
   */
  delivery?: "commit" | "keyEvents" | "clearField";
  timeoutMs?: number;
  trace?: true;
}

export interface RequestCancelImeCommitMessage {
  type: "request_cancel_ime_commit";
  requestId: string;
  targetRequestId: string;
}

/** `@SerialName("request_set_keyboard_profile")` → `RequestSetKeyboardProfile` */
export interface RequestSetKeyboardProfileMessage {
  type: "request_set_keyboard_profile";
  requestId: string;
  profileId: string;
}

/** `@SerialName("request_list_keyboard_profiles")` → `RequestListKeyboardProfiles` */
export interface RequestListKeyboardProfilesMessage {
  type: "request_list_keyboard_profiles";
  requestId: string;
  supportedCatalogVersions: number[];
}

/** `@SerialName("request_ime_action")` → `RequestImeAction` */
export interface RequestImeActionMessage {
  type: "request_ime_action";
  requestId: string;
  action: ImeAction;
  frameContext?: string;
}

/** `@SerialName("request_select_all")` → `RequestSelectAll` */
export interface RequestSelectAllMessage {
  type: "request_select_all";
  requestId: string;
}

// =============================================================================
// Node Action Requests
// =============================================================================

/**
 * `@SerialName("request_action")` → `RequestAction`.
 * `selector` is additive; `resourceId` remains for backwards compatibility.
 */
export interface RequestActionMessage {
  boundsLeft?: number;
  boundsTop?: number;
  boundsRight?: number;
  boundsBottom?: number;
  type: "request_action";
  requestId: string;
  action: string;
  resourceId?: string;
  selector?: {
    resourceId?: string;
    testTag?: string;
    uniqueId?: string;
    collectionRow?: number;
    collectionColumn?: number;
  };
  /** For action `custom`: the label of the app-defined accessibility action (#14077). */
  customAction?: string;
  /** For action `set_progress`: the ACTION_ARGUMENT_PROGRESS_VALUE to set (#14077). */
  progress?: number;
}

/** `@SerialName("request_click_focused_input")` → `RequestClickFocusedInput`. */
export interface RequestClickFocusedInputMessage {
  type: "request_click_focused_input";
  requestId: string;
}

/** `@SerialName("request_activate_accessibility_link")` → `RequestActivateAccessibilityLink` */
export interface RequestActivateAccessibilityLinkMessage {
  type: "request_activate_accessibility_link";
  requestId: string;
  text: string;
  occurrence: number;
  selector?: RequestActionMessage["selector"];
}

/**
 * `@SerialName("request_hit_test")` → `RequestHitTest`.
 * Device-supported but currently has no TS sender; typed here for contract completeness.
 */
export interface RequestHitTestMessage {
  type: "request_hit_test";
  requestId: string;
  x: number;
  y: number;
}

// =============================================================================
// Clipboard Request
// =============================================================================

/** `@SerialName("request_clipboard")` → `RequestClipboard` */
export interface RequestClipboardMessage {
  type: "request_clipboard";
  requestId: string;
  action: "copy" | "paste" | "clear" | "get";
  /** Required for the `copy` action; omitted otherwise. */
  text?: string;
}

// =============================================================================
// Settings Requests
// =============================================================================

/** `@SerialName("request_settings_get")` → `RequestSettingsGet` */
export interface RequestSettingsGetMessage {
  type: "request_settings_get";
  requestId: string;
  namespace: SettingsNamespace;
  key: string;
}

/** `@SerialName("request_settings_put")` → `RequestSettingsPut` (`value: null` deletes) */
export interface RequestSettingsPutMessage {
  type: "request_settings_put";
  requestId: string;
  namespace: SettingsNamespace;
  key: string;
  value: string | null;
  valueType: SettingsValueType;
}

/** `@SerialName("request_settings_list")` → `RequestSettingsList` */
export interface RequestSettingsListMessage {
  type: "request_settings_list";
  requestId: string;
  namespace: SettingsNamespace;
}

// =============================================================================
// Certificate Requests
// =============================================================================

/** `@SerialName("install_ca_cert")` → `InstallCaCert` */
export interface InstallCaCertMessage {
  type: "install_ca_cert";
  requestId: string;
  certificate: string;
}

/** `@SerialName("install_ca_cert_from_path")` → `InstallCaCertFromPath` */
export interface InstallCaCertFromPathMessage {
  type: "install_ca_cert_from_path";
  requestId: string;
  devicePath: string;
}

/**
 * `@SerialName("remove_ca_cert")` → `RemoveCaCert`.
 * The device accepts `alias` and/or `certificate` (both optional); the TS client sends `alias`.
 */
export interface RemoveCaCertMessage {
  type: "remove_ca_cert";
  requestId: string;
  alias?: string;
  certificate?: string;
}

// =============================================================================
// Device Info / Owner / Permission Requests
// =============================================================================

/** `@SerialName("get_device_owner_status")` → `GetDeviceOwnerStatus` */
export interface GetDeviceOwnerStatusMessage {
  type: "get_device_owner_status";
  requestId: string;
}

/**
 * `@SerialName("get_permission")` → `GetPermission`.
 * Kotlin declares `permission: String?` and `requestPermission: Boolean?`; the TS client always
 * sends a non-null `permission` and an explicit boolean `requestPermission`.
 */
export interface GetPermissionMessage {
  type: "get_permission";
  requestId: string;
  permission: string;
  requestPermission: boolean;
}

/** `@SerialName("request_device_info")` → `RequestDeviceInfo` */
export interface RequestDeviceInfoMessage {
  type: "request_device_info";
  requestId: string;
}

// =============================================================================
// Accessibility Focus Requests
// =============================================================================

/** `@SerialName("get_current_focus")` → `GetCurrentFocus` */
export interface GetCurrentFocusMessage {
  type: "get_current_focus";
  requestId: string;
}

/** `@SerialName("get_traversal_order")` → `GetTraversalOrder` */
export interface GetTraversalOrderMessage {
  type: "get_traversal_order";
  requestId: string;
}

// =============================================================================
// Highlight Request
// =============================================================================

/**
 * `@SerialName("add_highlight")` → `AddHighlight`.
 * `id`/`shape` are omitted when falsy, matching the pre-migration send site. `shape` must already
 * be normalized (integer bounds) by the caller.
 */
export interface AddHighlightMessage {
  type: "add_highlight";
  requestId: string;
  id?: string;
  shape?: HighlightShape;
}

// =============================================================================
// Storage Requests
// =============================================================================

/** `@SerialName("list_preference_files")` → `ListPreferenceFiles` */
export interface ListPreferenceFilesMessage {
  type: "list_preference_files";
  requestId: string;
  packageName: string;
}

/** `@SerialName("get_preferences")` → `GetPreferences` */
export interface GetPreferencesMessage {
  type: "get_preferences";
  requestId: string;
  packageName: string;
  fileName: string;
}

/** Discovers the app-owned read-only Keystore metadata bridge. */
export interface DiscoverKeystoreMessage {
  type: "discover_keystore";
  requestId: string;
  packageName: string;
}

/**
 * Reads the app SDK's capability and capture-policy snapshot (issue #5191). `userId` targets the
 * app instance in another Android user and is sent only when the service advertises
 * {@link SDK_CAPABILITIES_USER_ID_CAPABILITY}.
 */
export interface GetSdkCapabilitiesMessage {
  type: "get_sdk_capabilities";
  requestId: string;
  packageName: string;
  userId?: number;
}

/**
 * `@SerialName("list_data_stores")` → `ListDataStores`.
 *
 * Lists the Jetpack DataStore instances exposed by a host-registered adapter (issue #5192/#5573).
 * DataStore descriptors reuse the SharedPreferences `preference_files` result envelope
 * (`StorageResponse.FileList`, path emitted empty), disambiguated by `requestId`.
 */
export interface ListDataStoresMessage {
  type: "list_data_stores";
  requestId: string;
  packageName: string;
  adapterName: string;
}

/**
 * `@SerialName("get_data_store")` → `GetDataStore`.
 *
 * Reads all entries from a named DataStore instance. Reuses the SharedPreferences `preferences`
 * result envelope (`StorageResponse.Preferences`), disambiguated by `requestId`.
 */
export interface GetDataStoreMessage {
  type: "get_data_store";
  requestId: string;
  packageName: string;
  adapterName: string;
  storeName: string;
}

/** `@SerialName("subscribe_storage")` → `SubscribeStorage` */
export interface SubscribeStorageMessage {
  type: "subscribe_storage";
  requestId: string;
  packageName: string;
  fileName: string;
}

/**
 * `@SerialName("unsubscribe_storage")` → `UnsubscribeStorage`.
 *
 * The TS client sends only `subscriptionId` as the storage identifier: the "<packageName>:<fileName>"
 * id exactly as returned in `subscribe_storage_result`. The Kotlin handler in
 * `CtrlProxyMessageHandler.kt` resolves it through `StorageSubscription.parseId` in
 * `StorageModels.kt`, splitting on the FIRST ':' so file names may contain ':'.
 * The device also accepts explicit `packageName` and `fileName`; when both are supplied they
 * take precedence over `subscriptionId`, but the TS client does not send them. A malformed id
 * is logged and ignored device-side. `CtrlProxyMessageHandlerTest.kt` pins these rules, and
 * `CtrlProxyStorage.test.ts` pins the TS wire shape and subscribe-to-unsubscribe id flow.
 */
export interface UnsubscribeStorageMessage {
  packageName?: string;
  fileName?: string;
  type: "unsubscribe_storage";
  requestId: string;
  subscriptionId: string;
}

/** `@SerialName("get_preference")` → `GetPreference` */
export interface GetPreferenceMessage {
  type: "get_preference";
  requestId: string;
  packageName: string;
  fileName: string;
  key: string;
}

/** `@SerialName("set_preference")` → `SetPreference` (`value: null` allowed) */
export interface SetPreferenceMessage {
  type: "set_preference";
  requestId: string;
  packageName: string;
  fileName: string;
  key: string;
  value: string | null;
  valueType: KeyValueType;
}

/** `@SerialName("remove_preference")` → `RemovePreference` */
export interface RemovePreferenceMessage {
  type: "remove_preference";
  requestId: string;
  packageName: string;
  fileName: string;
  key: string;
}

/** `@SerialName("clear_preferences")` → `ClearPreferences` */
export interface ClearPreferencesMessage {
  type: "clear_preferences";
  requestId: string;
  packageName: string;
  fileName: string;
}

// =============================================================================
// Global Action Request
// =============================================================================

/** `@SerialName("request_global_action")` → `RequestGlobalAction` */
export interface RequestGlobalActionMessage {
  type: "request_global_action";
  requestId: string;
  action: string;
  frameContext?: string;
}

/** `@SerialName("validate_frame_context")` → `ValidateFrameContext` */
export interface ValidateFrameContextMessage {
  type: "validate_frame_context";
  requestId: string;
  frameContext: string;
}

// =============================================================================
// Configuration Requests (no requestId on the wire)
// =============================================================================

/** `@SerialName("set_recomposition_tracking")` → `SetRecompositionTracking` */
export interface SetRecompositionTrackingMessage {
  type: "set_recomposition_tracking";
  requestId: string;
  enabled: boolean;
}

/** `@SerialName("set_accessibility_flags")` → `SetAccessibilityFlags` (sent without requestId) */
export interface SetAccessibilityFlagsMessage {
  requestId?: string;
  type: "set_accessibility_flags";
  includeNotImportantViews: boolean;
  reportViewIds: boolean;
  retrieveInteractiveWindows: boolean;
  occlusionEnabled: boolean;
}

/**
 * `@SerialName("set_network_mock_rules")` → `SetNetworkMockRules`. Sent without requestId for the
 * fire-and-forget reconnect push; with one, a CtrlProxy advertising
 * {@link NETWORK_MOCK_RULES_REPORT_CAPABILITY} answers with `set_network_mock_rules_result`.
 */
export interface SetNetworkMockRulesMessage {
  type: "set_network_mock_rules";
  requestId?: string;
  rules: NetworkMockRuleSync[];
}

/** `@SerialName("set_network_error_simulation")` → `SetNetworkErrorSimulation` (sent without requestId) */
export interface SetNetworkErrorSimulationMessage {
  requestId?: string;
  type: "set_network_error_simulation";
  enabled: boolean;
  errorType: string | null;
  limit: number | null;
  /** Host-clock epoch; kept for SDKs that predate `remainingMs`. */
  expiresAtEpochMs: number | null;
  /** Time left, timed by the device's own monotonic clock; preferred when present (#10062). */
  remainingMs: number | null;
}

// =============================================================================
// Package Manager Requests
// =============================================================================

/** `@SerialName("request_installed_packages")` → `RequestInstalledPackages` (`userId: null` = all users) */
export interface RequestInstalledPackagesMessage {
  type: "request_installed_packages";
  requestId: string;
  includeSystem: boolean;
  userId: number | null;
}

/** `@SerialName("request_package_info")` → `RequestPackageInfo` */
export interface RequestPackageInfoMessage {
  type: "request_package_info";
  requestId: string;
  packageName: string;
  includePermissions: boolean;
}

/** `@SerialName("request_launch_intent")` → `RequestLaunchIntent` */
export interface RequestLaunchIntentMessage {
  type: "request_launch_intent";
  requestId: string;
  packageName: string;
}

// =============================================================================
// Recording Requests (no requestId on the wire)
// Both commands are kept for wire compatibility and currently have no effect on the device.
// =============================================================================

/** `@SerialName("start_recording")` → `StartRecording` (sent without requestId) */
export interface StartRecordingMessage {
  requestId?: string;
  type: "start_recording";
}

/** `@SerialName("stop_recording")` → `StopRecording` (sent without requestId) */
export interface StopRecordingMessage {
  requestId?: string;
  type: "stop_recording";
}

// =============================================================================
// Discriminated union
// =============================================================================

/**
 * Every request the Android control-proxy client can send. Discriminated on `type`, which maps
 * 1:1 to a `@SerialName` in `WebSocketRequest.kt`.
 */
export type CtrlProxyRequest =
  | RequestHierarchyMessage
  | RequestHierarchyIfStaleMessage
  | SetHierarchyIntervalMessage
  | RequestScreenshotMessage
  | RequestTapCoordinatesMessage
  | RequestSwipeMessage
  | RequestTwoFingerSwipeMessage
  | RequestDragMessage
  | RequestPinchMessage
  | RequestGestureStartMessage
  | RequestGestureMoveMessage
  | RequestGestureEndMessage
  | RequestSetTextMessage
  | RequestInsertTextStateMessage
  | RequestInsertTextMessage
  | RequestCommitTextMessage
  | RequestCancelImeCommitMessage
  | RequestSetKeyboardProfileMessage
  | RequestListKeyboardProfilesMessage
  | RequestImeActionMessage
  | RequestSelectAllMessage
  | RequestActionMessage
  | RequestClickFocusedInputMessage
  | RequestActivateAccessibilityLinkMessage
  | RequestHitTestMessage
  | RequestClipboardMessage
  | RequestSettingsGetMessage
  | RequestSettingsPutMessage
  | RequestSettingsListMessage
  | InstallCaCertMessage
  | InstallCaCertFromPathMessage
  | RemoveCaCertMessage
  | GetDeviceOwnerStatusMessage
  | GetPermissionMessage
  | RequestDeviceInfoMessage
  | GetCurrentFocusMessage
  | GetTraversalOrderMessage
  | ShowPrototypeMessage
  | DismissPrototypeMessage
  | InspectPrototypesMessage
  | PatchPrototypeMessage
  | SavePrototypeMessage
  | PinSavedPrototypeMessage
  | ListSavedPrototypesMessage
  | DeleteSavedPrototypeMessage
  | AdvancePrototypeClockMessage
  | ClearPrototypeStorageMessage
  | PutPrototypeAssetMessage
  | RemovePrototypeAssetMessage
  | AddHighlightMessage
  | ListPreferenceFilesMessage
  | GetPreferencesMessage
  | DiscoverKeystoreMessage
  | GetSdkCapabilitiesMessage
  | ListDataStoresMessage
  | GetDataStoreMessage
  | SubscribeStorageMessage
  | UnsubscribeStorageMessage
  | GetPreferenceMessage
  | SetPreferenceMessage
  | RemovePreferenceMessage
  | ClearPreferencesMessage
  | RequestGlobalActionMessage
  | ValidateFrameContextMessage
  | SetRecompositionTrackingMessage
  | SetAccessibilityFlagsMessage
  | SetNetworkMockRulesMessage
  | SetNetworkErrorSimulationMessage
  | RequestInstalledPackagesMessage
  | RequestPackageInfoMessage
  | RequestLaunchIntentMessage
  | StartRecordingMessage
  | StopRecordingMessage;

/** The `type` discriminator of any {@link CtrlProxyRequest}. */
export type CtrlProxyRequestType = CtrlProxyRequest["type"];
