/**
 * ctrlProxyProtocol - Typed request contract for the Android control-proxy WebSocket client.
 *
 * This module is the TypeScript mirror of the authoritative Kotlin wire contract in
 * `android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol/WebSocketRequest.kt`
 * (issue #2752 / PR #2771). Every interface here corresponds to a `@SerialName`'d data class
 * on the device; every field name/type/optionality is checked against that contract so the JSON
 * on the wire stays byte-identical and the device decodes it without change.
 *
 * Sends are constructed via the {@link ctrlProxyRequests} builders — each returns a typed
 * {@link CtrlProxyRequest} — and serialized through {@link serializeCtrlProxyRequest}. When a send
 * is built this way, a misspelled `type` or a malformed field set is a compile error rather than a
 * runtime failure on-device. This is a module-level convention, not a transport-level lock: the
 * underlying `ws.send(string)` still accepts any string, so a raw `JSON.stringify` could bypass the
 * layer. Enforcing it with a typed `sendRequest(request: CtrlProxyRequest)` transport chokepoint is
 * a possible follow-up (it would need to unify the delegates' differing not-connected semantics).
 *
 * SCOPE — Android control-proxy only.
 * - The gesture/text commands (`request_tap_coordinates`, `request_swipe`, `request_two_finger_swipe`,
 *   `request_drag`, `request_pinch`, `request_set_text`, `request_ime_action`, `request_select_all`)
 *   are emitted through the cross-platform shared `sendCommand()` / `createMessage()` path in
 *   `src/features/observe/DeviceServiceUtils.ts`. They are typed here for contract completeness
 *   (drift cross-check) but intentionally NOT re-routed, to avoid coupling the shared iOS client
 *   to the Android contract. Unifying that path is a possible follow-up.
 * - `request_hit_test` is device-supported but has no TS sender yet; typed here to keep the union
 *   equal to the device `@SerialName` set (the drift guard depends on that equality).
 * - The iOS client (`src/features/observe/ios/`) has its own hand-built sends that could get the
 *   same treatment separately.
 */

import type { HighlightShape } from "../../../models/VisualHighlight";
import type { ImeAction } from "../../../models/ImeActionResult";
import type { NetworkMockRuleSync } from "../../../server/networkMockRules";
import type { KeyValueType } from "../../storage/storageTypes";
import type { SettingsNamespace, SettingsValueType } from "./types";

// =============================================================================
// Hierarchy Requests
// =============================================================================

/** `@SerialName("request_hierarchy")` → `RequestHierarchy` */
export interface RequestHierarchyMessage {
  type: "request_hierarchy";
  requestId: string;
  disableAllFiltering: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * `@SerialName("request_hierarchy_if_stale")` → `RequestHierarchyIfStale`.
 * The device also accepts `disableAllFiltering` (default false); the TS client omits it.
 */
export interface RequestHierarchyIfStaleMessage {
  type: "request_hierarchy_if_stale";
  requestId: string;
  sinceTimestamp: number;
}

/** `@SerialName("set_hierarchy_interval")` -> `SetHierarchyInterval` */
export interface SetHierarchyIntervalMessage {
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
}

// =============================================================================
// Gesture Requests (emitted via the shared sendCommand/createMessage path)
// =============================================================================

/** `@SerialName("request_tap_coordinates")` → `RequestTapCoordinates` */
export interface RequestTapCoordinatesMessage {
  type: "request_tap_coordinates";
  requestId: string;
  x: number;
  y: number;
  duration: number;
}

/** `@SerialName("request_swipe")` → `RequestSwipe` */
export interface RequestSwipeMessage {
  type: "request_swipe";
  requestId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
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
}

/** `@SerialName("request_drag")` → `RequestDrag` (legacy holdTime/duration fields not sent) */
export interface RequestDragMessage {
  type: "request_drag";
  requestId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pressDurationMs: number;
  dragDurationMs: number;
  holdDurationMs: number;
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

/** `@SerialName("request_insert_text")` → `RequestInsertText` */
export interface RequestInsertTextMessage {
  type: "request_insert_text";
  requestId: string;
  text: string;
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
 * PRE-EXISTING LATENT BUG: the TS client sends only `subscriptionId` (a "packageName:fileName"
 * string), but the device handler needs `packageName`/`fileName` — so every unsubscribe currently
 * no-ops on the device (times out client-side). This type documents the wire message as it is
 * actually sent today; fixing the payload/handler is tracked as a separate device-side task. Do
 * not "fix" this here (it would change the wire and require a coordinated device change).
 * See the Kotlin `UnsubscribeStorage` doc comment for the device-side view.
 */
export interface UnsubscribeStorageMessage {
  type: "unsubscribe_storage";
  requestId: string;
  // TODO(#2752 follow-up): also send packageName/fileName so the device can resolve the
  // subscription; today only subscriptionId is sent and the device unsubscribe no-ops.
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
  type: "set_accessibility_flags";
  includeNotImportantViews: boolean;
  reportViewIds: boolean;
  retrieveInteractiveWindows: boolean;
  occlusionEnabled: boolean;
}

/** `@SerialName("set_network_mock_rules")` → `SetNetworkMockRules` (sent without requestId) */
export interface SetNetworkMockRulesMessage {
  type: "set_network_mock_rules";
  rules: NetworkMockRuleSync[];
}

/** `@SerialName("set_network_error_simulation")` → `SetNetworkErrorSimulation` (sent without requestId) */
export interface SetNetworkErrorSimulationMessage {
  type: "set_network_error_simulation";
  enabled: boolean;
  errorType: string | null;
  limit: number | null;
  expiresAtEpochMs: number | null;
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
// =============================================================================

/** `@SerialName("start_recording")` → `StartRecording` (sent without requestId) */
export interface StartRecordingMessage {
  type: "start_recording";
}

/** `@SerialName("stop_recording")` → `StopRecording` (sent without requestId) */
export interface StopRecordingMessage {
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
  | RequestInsertTextMessage
  | RequestImeActionMessage
  | RequestSelectAllMessage
  | RequestActionMessage
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
  | AddHighlightMessage
  | ListPreferenceFilesMessage
  | GetPreferencesMessage
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

/**
 * Every `@SerialName` accepted by `WebSocketRequest.kt`, transcribed by hand. The
 * `Record<CtrlProxyRequestType, true>` type forces this map to list exactly the union's
 * discriminators: adding a request type to the union without listing it here (or vice versa) is a
 * compile error, and a test asserts these keys equal the device's `@SerialName` set — read directly
 * from `WebSocketRequest.kt` (see ctrlProxyProtocol.test.ts), so a request type renamed/added on the
 * device fails the test rather than drifting silently.
 *
 * NOTE: this guards the request-type *set* (a type added/removed/renamed). It does NOT guard
 * per-field drift (a field renamed, or its optionality changed) — that fidelity is covered by the
 * byte-identical serialization assertions in ctrlProxyProtocol.test.ts. A future improvement is to
 * generate this contract from the Kotlin source so there is a single source of truth.
 */
const REQUEST_TYPE_REGISTRY: Record<CtrlProxyRequestType, true> = {
  request_hierarchy: true,
  request_hierarchy_if_stale: true,
  set_hierarchy_interval: true,
  request_screenshot: true,
  request_tap_coordinates: true,
  request_swipe: true,
  request_two_finger_swipe: true,
  request_drag: true,
  request_pinch: true,
  request_gesture_start: true,
  request_gesture_move: true,
  request_gesture_end: true,
  request_set_text: true,
  request_insert_text: true,
  request_ime_action: true,
  request_select_all: true,
  request_action: true,
  request_activate_accessibility_link: true,
  request_hit_test: true,
  request_clipboard: true,
  request_settings_get: true,
  request_settings_put: true,
  request_settings_list: true,
  install_ca_cert: true,
  install_ca_cert_from_path: true,
  remove_ca_cert: true,
  get_device_owner_status: true,
  get_permission: true,
  request_device_info: true,
  get_current_focus: true,
  get_traversal_order: true,
  add_highlight: true,
  list_preference_files: true,
  get_preferences: true,
  list_data_stores: true,
  get_data_store: true,
  subscribe_storage: true,
  unsubscribe_storage: true,
  get_preference: true,
  set_preference: true,
  remove_preference: true,
  clear_preferences: true,
  request_global_action: true,
  validate_frame_context: true,
  set_recomposition_tracking: true,
  set_accessibility_flags: true,
  set_network_mock_rules: true,
  set_network_error_simulation: true,
  request_installed_packages: true,
  request_package_info: true,
  request_launch_intent: true,
  start_recording: true,
  stop_recording: true,
};

/** All request `type` discriminators known to this contract (mirrors `WebSocketRequest.kt`). */
export const KNOWN_REQUEST_TYPES: readonly CtrlProxyRequestType[] = Object.keys(
  REQUEST_TYPE_REGISTRY,
) as CtrlProxyRequestType[];

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize a typed request to the exact JSON string sent on the wire. This is the single
 * serialization chokepoint for the Android control-proxy client — `undefined` fields are omitted
 * by `JSON.stringify` (matching the pre-migration send sites) while explicit `null`s are kept.
 */
export function serializeCtrlProxyRequest(request: CtrlProxyRequest): string {
  return JSON.stringify(request);
}

// =============================================================================
// Builders
// =============================================================================

/**
 * Typed builders for every Android control-proxy request with a direct (hand-built) send site.
 * Each returns the {@link CtrlProxyRequest} union member for its command; pass the result to
 * {@link serializeCtrlProxyRequest} to get the wire string. Field order matches the pre-migration
 * send sites so the serialized output is byte-identical.
 *
 * Gesture/text commands are absent by design — see the module doc comment (they go through the
 * shared cross-platform path).
 */
export const ctrlProxyRequests = {
  requestHierarchy(args: {
    requestId: string;
    disableAllFiltering: boolean;
    maxDepth?: number;
    maxNodes?: number;
  }): RequestHierarchyMessage {
    return {
      type: "request_hierarchy",
      requestId: args.requestId,
      disableAllFiltering: args.disableAllFiltering,
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
    };
  },

  requestHierarchyIfStale(args: {
    requestId: string;
    sinceTimestamp: number;
  }): RequestHierarchyIfStaleMessage {
    return {
      type: "request_hierarchy_if_stale",
      requestId: args.requestId,
      sinceTimestamp: args.sinceTimestamp,
    };
  },

  setHierarchyInterval(args: { intervalMs: number | null }): SetHierarchyIntervalMessage {
    return { type: "set_hierarchy_interval", intervalMs: args.intervalMs };
  },

  requestScreenshot(args: { requestId: string }): RequestScreenshotMessage {
    return { type: "request_screenshot", requestId: args.requestId };
  },

  requestAction(args: {
    requestId: string;
    action: string;
    resourceId?: string;
    selector?: RequestActionMessage["selector"];
  }): RequestActionMessage {
    return {
      type: "request_action",
      requestId: args.requestId,
      action: args.action,
      resourceId: args.resourceId,
      selector: args.selector,
    };
  },

  requestActivateAccessibilityLink(args: {
    requestId: string;
    text: string;
    occurrence: number;
    selector?: RequestActionMessage["selector"];
  }): RequestActivateAccessibilityLinkMessage {
    return {
      type: "request_activate_accessibility_link",
      requestId: args.requestId,
      text: args.text,
      occurrence: args.occurrence,
      selector: args.selector,
    };
  },

  requestClipboard(args: {
    requestId: string;
    action: "copy" | "paste" | "clear" | "get";
    text?: string;
  }): RequestClipboardMessage {
    return {
      type: "request_clipboard",
      requestId: args.requestId,
      action: args.action,
      text: args.text,
    };
  },

  requestSettingsGet(args: {
    requestId: string;
    namespace: SettingsNamespace;
    key: string;
  }): RequestSettingsGetMessage {
    return {
      type: "request_settings_get",
      requestId: args.requestId,
      namespace: args.namespace,
      key: args.key,
    };
  },

  requestSettingsPut(args: {
    requestId: string;
    namespace: SettingsNamespace;
    key: string;
    value: string | null;
    valueType: SettingsValueType;
  }): RequestSettingsPutMessage {
    return {
      type: "request_settings_put",
      requestId: args.requestId,
      namespace: args.namespace,
      key: args.key,
      value: args.value,
      valueType: args.valueType,
    };
  },

  requestSettingsList(args: {
    requestId: string;
    namespace: SettingsNamespace;
  }): RequestSettingsListMessage {
    return { type: "request_settings_list", requestId: args.requestId, namespace: args.namespace };
  },

  installCaCert(args: { requestId: string; certificate: string }): InstallCaCertMessage {
    return { type: "install_ca_cert", requestId: args.requestId, certificate: args.certificate };
  },

  installCaCertFromPath(args: {
    requestId: string;
    devicePath: string;
  }): InstallCaCertFromPathMessage {
    return {
      type: "install_ca_cert_from_path",
      requestId: args.requestId,
      devicePath: args.devicePath,
    };
  },

  removeCaCert(args: { requestId: string; alias: string }): RemoveCaCertMessage {
    return { type: "remove_ca_cert", requestId: args.requestId, alias: args.alias };
  },

  getDeviceOwnerStatus(args: { requestId: string }): GetDeviceOwnerStatusMessage {
    return { type: "get_device_owner_status", requestId: args.requestId };
  },

  getPermission(args: {
    requestId: string;
    permission: string;
    requestPermission: boolean;
  }): GetPermissionMessage {
    return {
      type: "get_permission",
      requestId: args.requestId,
      permission: args.permission,
      requestPermission: args.requestPermission,
    };
  },

  requestDeviceInfo(args: { requestId: string }): RequestDeviceInfoMessage {
    return { type: "request_device_info", requestId: args.requestId };
  },

  getCurrentFocus(args: { requestId: string }): GetCurrentFocusMessage {
    return { type: "get_current_focus", requestId: args.requestId };
  },

  getTraversalOrder(args: { requestId: string }): GetTraversalOrderMessage {
    return { type: "get_traversal_order", requestId: args.requestId };
  },

  addHighlight(args: {
    requestId: string;
    id?: string;
    shape?: HighlightShape;
  }): AddHighlightMessage {
    // Match the pre-migration send site: start with { type, requestId } and only attach id/shape
    // when truthy, so falsy values are omitted from the wire rather than serialized as null.
    const message: AddHighlightMessage = { type: "add_highlight", requestId: args.requestId };
    if (args.id) {
      message.id = args.id;
    }
    if (args.shape) {
      message.shape = args.shape;
    }
    return message;
  },

  listPreferenceFiles(args: {
    requestId: string;
    packageName: string;
  }): ListPreferenceFilesMessage {
    return {
      type: "list_preference_files",
      requestId: args.requestId,
      packageName: args.packageName,
    };
  },

  getPreferences(args: {
    requestId: string;
    packageName: string;
    fileName: string;
  }): GetPreferencesMessage {
    return {
      type: "get_preferences",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
    };
  },

  listDataStores(args: {
    requestId: string;
    packageName: string;
    adapterName: string;
  }): ListDataStoresMessage {
    return {
      type: "list_data_stores",
      requestId: args.requestId,
      packageName: args.packageName,
      adapterName: args.adapterName,
    };
  },

  getDataStore(args: {
    requestId: string;
    packageName: string;
    adapterName: string;
    storeName: string;
  }): GetDataStoreMessage {
    return {
      type: "get_data_store",
      requestId: args.requestId,
      packageName: args.packageName,
      adapterName: args.adapterName,
      storeName: args.storeName,
    };
  },

  subscribeStorage(args: {
    requestId: string;
    packageName: string;
    fileName: string;
  }): SubscribeStorageMessage {
    return {
      type: "subscribe_storage",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
    };
  },

  unsubscribeStorage(args: {
    requestId: string;
    subscriptionId: string;
  }): UnsubscribeStorageMessage {
    return {
      type: "unsubscribe_storage",
      requestId: args.requestId,
      subscriptionId: args.subscriptionId,
    };
  },

  getPreference(args: {
    requestId: string;
    packageName: string;
    fileName: string;
    key: string;
  }): GetPreferenceMessage {
    return {
      type: "get_preference",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
      key: args.key,
    };
  },

  setPreference(args: {
    requestId: string;
    packageName: string;
    fileName: string;
    key: string;
    value: string | null;
    valueType: KeyValueType;
  }): SetPreferenceMessage {
    return {
      type: "set_preference",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
      key: args.key,
      value: args.value,
      valueType: args.valueType,
    };
  },

  removePreference(args: {
    requestId: string;
    packageName: string;
    fileName: string;
    key: string;
  }): RemovePreferenceMessage {
    return {
      type: "remove_preference",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
      key: args.key,
    };
  },

  clearPreferences(args: {
    requestId: string;
    packageName: string;
    fileName: string;
  }): ClearPreferencesMessage {
    return {
      type: "clear_preferences",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
    };
  },

  requestGlobalAction(args: {
    requestId: string;
    action: string;
    frameContext?: string;
  }): RequestGlobalActionMessage {
    return {
      type: "request_global_action",
      requestId: args.requestId,
      action: args.action,
      frameContext: args.frameContext,
    };
  },

  validateFrameContext(args: {
    requestId: string;
    frameContext: string;
  }): ValidateFrameContextMessage {
    return {
      type: "validate_frame_context",
      requestId: args.requestId,
      frameContext: args.frameContext,
    };
  },

  setRecompositionTracking(args: {
    requestId: string;
    enabled: boolean;
  }): SetRecompositionTrackingMessage {
    return { type: "set_recomposition_tracking", requestId: args.requestId, enabled: args.enabled };
  },

  setAccessibilityFlags(args: {
    includeNotImportantViews: boolean;
    reportViewIds: boolean;
    retrieveInteractiveWindows: boolean;
    occlusionEnabled: boolean;
  }): SetAccessibilityFlagsMessage {
    return {
      type: "set_accessibility_flags",
      includeNotImportantViews: args.includeNotImportantViews,
      reportViewIds: args.reportViewIds,
      retrieveInteractiveWindows: args.retrieveInteractiveWindows,
      occlusionEnabled: args.occlusionEnabled,
    };
  },

  setNetworkMockRules(args: { rules: NetworkMockRuleSync[] }): SetNetworkMockRulesMessage {
    return { type: "set_network_mock_rules", rules: args.rules };
  },

  setNetworkErrorSimulation(args: {
    enabled: boolean;
    errorType?: string | null;
    limit?: number | null;
    expiresAtEpochMs?: number | null;
  }): SetNetworkErrorSimulationMessage {
    return {
      type: "set_network_error_simulation",
      enabled: args.enabled,
      errorType: args.errorType ?? null,
      limit: args.limit ?? null,
      expiresAtEpochMs: args.expiresAtEpochMs ?? null,
    };
  },

  requestInstalledPackages(args: {
    requestId: string;
    includeSystem: boolean;
    userId?: number | null;
  }): RequestInstalledPackagesMessage {
    return {
      type: "request_installed_packages",
      requestId: args.requestId,
      includeSystem: args.includeSystem,
      userId: args.userId ?? null,
    };
  },

  requestPackageInfo(args: {
    requestId: string;
    packageName: string;
    includePermissions: boolean;
  }): RequestPackageInfoMessage {
    return {
      type: "request_package_info",
      requestId: args.requestId,
      packageName: args.packageName,
      includePermissions: args.includePermissions,
    };
  },

  requestLaunchIntent(args: {
    requestId: string;
    packageName: string;
  }): RequestLaunchIntentMessage {
    return {
      type: "request_launch_intent",
      requestId: args.requestId,
      packageName: args.packageName,
    };
  },

  startRecording(): StartRecordingMessage {
    return { type: "start_recording" };
  },

  stopRecording(): StopRecordingMessage {
    return { type: "stop_recording" };
  },
} as const;
