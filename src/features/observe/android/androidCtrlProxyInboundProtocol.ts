import type { PanelFingerprint } from "../../../models/DisplayPanel";
import type { InsertTextState } from "./ctrlProxyProtocol";

import type { Element } from "../../../models";
import type { NavigationEvent } from "../../navigation/NavigationGraphManager";
import type { ScreenshotPerformanceMetadata } from "../ScreenshotMetadata";
import type { SdkAnrWirePayload, SdkCrashWirePayload } from "../crash/sdkCrashIngestion";
import type { AndroidHandledExceptionEvent as HandledExceptionEvent } from "./AndroidSdkEventIngestor";
import type {
  AndroidPackageEvent as PackageEvent,
  AndroidFrameMetricsEvent,
} from "./AndroidAppEventRecorder";
import type { PreferenceFile, KeyValueEntry, KeyValueType } from "../../storage/storageTypes";
import type { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import type { PrototypeEvent, PrototypeResult } from "./ctrlProxyProtocol";
import type {
  AccessibilityHierarchy,
  AccessibilityNode,
  SettingsNamespace,
  InstalledPackageRecord,
  AndroidPerfTiming,
} from "./types";

/**
 * Interface for interaction event from accessibility service
 */
export interface InteractionEvent {
  type:
    | "tap"
    | "longPress"
    | "swipe"
    | "inputText"
    | "select"
    | "navigate"
    | "scroll"
    | "touch"
    | "stateChange";
  timestamp: number;
  packageName?: string;
  screenClassName?: string;
  element?: Partial<Element>;
  text?: string;
  scrollDeltaX?: number;
  scrollDeltaY?: number;
}

/**
 * Base fields shared by most WebSocket messages from the accessibility service.
 */
export interface WsMessageBase {
  timestamp?: number;
  error?: string;
}

/**
 * Base fields for request/response messages that carry a requestId.
 */
export interface WsRequestBase extends WsMessageBase {
  requestId?: string | null;
  success: boolean;
  totalTimeMs: number;
  perfTiming?: AndroidPerfTiming[];
}

// ---------------------------------------------------------------------------
// Individual message types (discriminated on `type`)
// ---------------------------------------------------------------------------

export interface WsConnectedMessage extends WsMessageBase {
  id?: number;
  type: "connected";
  supportedCommands?: string[];
}

export interface WsHierarchyUpdateMessage extends WsMessageBase {
  type: "hierarchy_update";
  data: AccessibilityHierarchy;
  requestId?: string | null;
  perfTiming?: AndroidPerfTiming[];
  frameContext?: string;
}

export interface WsScreenshotMessage extends WsMessageBase, ScreenshotPerformanceMetadata {
  width?: number;
  height?: number;
  type: "screenshot";
  requestId?: string | null;
  data: string;
  format?: string;
  frameContext?: string;
  rotation?: number;
  displayId?: number | null;
  panelUniqueId?: string | null;
  prototypesHidden?: boolean | null;
}

export interface AndroidDisplayTransition {
  change: "added" | "changed" | "removed" | "device_state";
  displayId: number;
  panelUniqueId?: string;
  panelFingerprint?: PanelFingerprint;
  width?: number;
  height?: number;
  state?: number;
  rotation?: number;
  deviceState?: number;
}

export interface WsDisplayTransitionMessage extends WsMessageBase, AndroidDisplayTransition {
  type: "display_transition";
}

export interface WsScreenshotErrorMessage extends WsMessageBase {
  type: "screenshot_error";
  requestId?: string | null;
  displayId?: number | null;
  panelUniqueId?: string | null;
}

/**
 * Structured protocol-boundary error emitted by the runner when an inbound command fails to decode
 * or a handler throws (issue #2985). `requestId` is best-effort: null when the runner could not
 * correlate the failure (e.g. an unparseable payload).
 */
export interface WsErrorMessage extends WsMessageBase {
  type: "error";
  requestId?: string | null;
  success: false;
}

export interface WsSwipeResultMessage extends WsRequestBase {
  type: "swipe_result";
  gestureTimeMs?: number;
}

export interface WsTapCoordinatesResultMessage extends WsRequestBase {
  gestureTimeMs?: number;
  type: "tap_coordinates_result";
}

export interface WsDragResultMessage extends WsRequestBase {
  type: "drag_result";
  gestureTimeMs?: number;
}

export interface WsPinchResultMessage extends WsRequestBase {
  type: "pinch_result";
  gestureTimeMs?: number;
}

export interface WsSetTextResultMessage extends WsRequestBase {
  type: "set_text_result";
}

export interface WsCommitTextResultMessage extends WsRequestBase {
  type: "commit_text_result";
  trace?: unknown;
  insertedText?: string;
  editorConsumed?: boolean;
  partialApplication?: boolean;
  committedUnits?: number;
}

export interface WsCancelImeCommitResultMessage extends WsRequestBase {
  type: "cancel_ime_commit_result";
  targetRequestId?: string;
  partialApplication?: boolean;
  committedUnits?: number;
}

export interface WsSetKeyboardProfileResultMessage extends Omit<WsRequestBase, "totalTimeMs"> {
  type: "set_keyboard_profile_result";
  activeProfileId?: string;
  previousProfileId?: string;
}

export interface WsSetNetworkMockRulesResultMessage extends WsMessageBase {
  type: "set_network_mock_rules_result";
  requestId?: string | null;
  success?: boolean;
  /** Absent: no app confirmed the rules. Present (even empty): the app compiled the list. */
  rejectedMockIds?: string[];
  rejectedReasons?: Record<string, string>;
}

export interface WsKeyboardProfilesResultMessage extends WsMessageBase {
  perfTiming?: AndroidPerfTiming[];
  type: "keyboard_profiles_result";
  requestId?: string | null;
  success: boolean;
  catalogId: string;
  catalogVersion?: number;
  supportedCatalogVersions?: number[];
  activeProfileId?: string;
  profiles?: KeyboardProfileCatalog["profiles"];
}

export interface WsInsertTextStateResultMessage extends WsRequestBase {
  type: "insert_text_state_result";
  state?: InsertTextState;
}

export interface WsInsertTextResultMessage extends WsRequestBase {
  type: "insert_text_result";
  partialApplication?: boolean;
  warning?: string;
  caretPlaced?: boolean;
  resultingTextLength?: number;
}

export interface WsImeActionResultMessage extends WsRequestBase {
  type: "ime_action_result";
  action?: string;
  approximated?: boolean;
}

export interface WsSelectAllResultMessage extends WsRequestBase {
  type: "select_all_result";
}

export interface WsActionResultMessage extends WsRequestBase {
  type: "action_result";
  action?: string;
  alreadySatisfied?: boolean;
}

export interface WsClipboardResultMessage extends WsRequestBase {
  type: "clipboard_result";
  action: "copy" | "paste" | "clear" | "get";
  text?: string;
}

export interface WsSettingsGetResultMessage extends WsRequestBase {
  type: "settings_get_result";
  namespace: SettingsNamespace;
  key: string;
  value?: string;
  found?: boolean;
}

export interface WsSettingsPutResultMessage extends WsRequestBase {
  type: "settings_put_result";
  namespace: SettingsNamespace;
  key: string;
}

export interface WsSettingsListResultMessage extends WsRequestBase {
  type: "settings_list_result";
  namespace: SettingsNamespace;
  entries?: Record<string, string>;
}

export interface WsCaCertResultMessage extends WsRequestBase {
  type: "ca_cert_result";
  action: "install" | "remove";
  alias?: string;
}

export interface WsDeviceOwnerStatusResultMessage extends WsRequestBase {
  type: "device_owner_status_result";
  isDeviceOwner?: boolean;
  isAdminActive?: boolean;
  packageName?: string;
}

export interface WsPermissionResultMessage extends WsRequestBase {
  type: "permission_result";
  permission?: string;
  granted?: boolean;
  requestLaunched?: boolean;
  canRequest?: boolean;
  requiresSettings?: boolean;
  instructions?: string;
  adbCommand?: string;
}

export interface WsCurrentFocusResultMessage extends WsMessageBase {
  perfTiming?: AndroidPerfTiming[];
  type: "current_focus_result";
  requestId?: string | null;
  // Both the success broadcaster and currentFocusErrorFrame always emit this field.
  totalTimeMs: number;
  focusedElement?: AccessibilityNode | null;
}

export interface WsTraversalOrderResultMessage extends WsMessageBase {
  perfTiming?: AndroidPerfTiming[];
  type: "traversal_order_result";
  requestId?: string | null;
  // Both the success broadcaster and traversalOrderErrorFrame always emit this field.
  totalTimeMs: number;
  result?: {
    elements: AccessibilityNode[];
    focusedIndex: number | null;
    totalCount: number;
    truncationReasons?: string[];
  };
}

export interface WsPrototypeResultMessage extends Omit<PrototypeResult, "requestId"> {
  pages?: Record<string, number>;
  type: "prototype_result";
  requestId?: string | null;
}

export type WsPrototypeEventMessage = Omit<PrototypeEvent, "name" | "payload"> & {
  name?: PrototypeEvent["name"];
  payload?: PrototypeEvent["payload"];
};

export interface WsHighlightResponseMessage extends WsMessageBase {
  type: "highlight_response";
  requestId?: string | null;
  success?: boolean;
}

export interface WsGlobalActionResultMessage extends WsMessageBase {
  type: "global_action_result";
  requestId?: string | null;
  success?: boolean;
  action?: string;
  totalTimeMs?: number;
}

export interface WsFrameContextValidationResultMessage extends WsMessageBase {
  type: "frame_context_validation_result";
  requestId?: string | null;
  success?: boolean;
  totalTimeMs?: number;
}

export interface WsDeviceInfoResultMessage extends WsMessageBase {
  type: "device_info_result";
  requestId?: string | null;
  success?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  density?: number;
  rotation?: number;
  sdkInt?: number;
  deviceModel?: string;
  isEmulator?: boolean;
  wakefulness?: string;
  foregroundActivity?: string;
  totalTimeMs?: number;
}

export interface WsKeystoreDiscoveryMessage extends WsMessageBase {
  type: "keystore_discovery";
  requestId?: string | null;
  state: unknown;
}

export interface WsSdkCapabilitiesMessage extends WsMessageBase {
  type: "sdk_capabilities";
  requestId?: string | null;
  state: unknown;
}

export interface WsPreferenceFilesMessage extends WsMessageBase {
  packageName?: string;
  type: "preference_files";
  requestId?: string | null;
  success?: boolean;
  files?: PreferenceFile[];
  totalTimeMs?: number;
}

export interface WsPreferencesMessage extends WsMessageBase {
  packageName?: string;
  fileName?: string;
  data?: string;
  type: "preferences";
  requestId?: string | null;
  success?: boolean;
  entries?: KeyValueEntry[];
  totalTimeMs?: number;
}

export interface WsSubscribeStorageResultMessage extends WsMessageBase {
  type: "subscribe_storage_result";
  requestId?: string | null;
  success?: boolean;
  // The device sends the subscription as flat fields, not a nested `subscription` object.
  packageName?: string;
  fileName?: string;
  subscriptionId?: string;
  totalTimeMs?: number;
}

export interface WsUnsubscribeStorageResultMessage extends WsMessageBase {
  packageName?: string;
  fileName?: string;
  type: "unsubscribe_storage_result";
  requestId?: string | null;
  success?: boolean;
  totalTimeMs?: number;
}

export interface WsGetPreferenceResultMessage extends WsMessageBase {
  packageName?: string;
  fileName?: string;
  type: "get_preference_result";
  requestId?: string | null;
  success?: boolean;
  found?: boolean;
  key?: string;
  value?: string;
  valueType?: KeyValueType;
  totalTimeMs?: number;
}

export interface WsSetPreferenceResultMessage extends WsMessageBase {
  packageName?: string;
  fileName?: string;
  key?: string;
  type: "set_preference_result";
  requestId?: string | null;
  success?: boolean;
  totalTimeMs?: number;
}

export interface WsRemovePreferenceResultMessage extends WsMessageBase {
  packageName?: string;
  fileName?: string;
  key?: string;
  type: "remove_preference_result";
  requestId?: string | null;
  success?: boolean;
  totalTimeMs?: number;
}

export interface WsClearPreferencesResultMessage extends WsMessageBase {
  packageName?: string;
  fileName?: string;
  type: "clear_preferences_result";
  requestId?: string | null;
  success?: boolean;
  totalTimeMs?: number;
}

export interface WsInstalledPackagesResultMessage extends WsMessageBase {
  type: "installed_packages_result";
  requestId?: string | null;
  success?: boolean;
  userId?: number;
  packages?: InstalledPackageRecord[];
  totalTimeMs?: number;
}

export interface WsPackageInfoResultMessage extends WsMessageBase {
  type: "package_info_result";
  requestId?: string | null;
  success?: boolean;
  packageName?: string;
  isSystem?: boolean;
  applicationLabel?: string;
  versionName?: string;
  versionCode?: number;
  installerPackage?: string;
  firstInstallTime?: number;
  lastUpdateTime?: number;
  allowBackup?: boolean;
  requestedPermissions?: string[];
  grantedPermissions?: Record<string, boolean>;
  mainActivity?: string;
  totalTimeMs?: number;
}

export interface WsLaunchIntentResultMessage extends WsMessageBase {
  type: "launch_intent_result";
  requestId?: string | null;
  success?: boolean;
  packageName?: string;
  componentName?: string;
  totalTimeMs?: number;
}

export interface WsNavigationEventMessage extends WsMessageBase {
  type: "navigation_event";
  event?: NavigationEvent;
}

export interface WsPackageEventMessage extends WsMessageBase {
  type: "package_event";
  event?: PackageEvent;
}

export interface WsInteractionEventMessage extends WsMessageBase {
  type: "interaction_event";
  event?: InteractionEvent;
}

export interface WsHandledExceptionEventMessage extends WsMessageBase {
  type: "handled_exception_event";
  event?: HandledExceptionEvent;
}

export interface WsCrashEventMessage extends WsMessageBase {
  type: "crash_event";
  event?: SdkCrashWirePayload;
}

export interface WsAnrEventMessage extends WsMessageBase {
  type: "anr_event";
  event?: SdkAnrWirePayload;
}

/** Real per-frame metrics from the in-app SDK FrameMetricsCollector (issue #5076). */
export interface WsFrameMetricsMessage extends WsMessageBase {
  type: "frame_metrics_event";
  frameMetrics?: AndroidFrameMetricsEvent;
}

export interface WsNetworkEventMessage extends WsMessageBase {
  type: "network_event";
  event?: {
    applicationId?: string;
    url: string;
    method: string;
    statusCode?: number;
    durationMs?: number;
    requestBodySize?: number;
    responseBodySize?: number;
    protocol?: string;
    host?: string;
    path?: string;
    error?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: string;
    responseBody?: string;
    contentType?: string;
  };
}

export interface WsWebSocketFrameEventMessage extends WsMessageBase {
  type: "websocket_frame_event";
  event?: {
    applicationId?: string;
    frameType?: string;
    connectionId?: string;
    url?: string;
    direction?: string;
    payloadSize?: number;
    success?: boolean;
  };
}

export interface WsLogEventMessage extends WsMessageBase {
  type: "log_event";
  event?: {
    applicationId?: string;
    level?: number;
    tag?: string;
    message?: string;
    filterName?: string;
  };
}

export interface WsBroadcastEventMessage extends WsMessageBase {
  type: "broadcast_event";
  event?: {
    applicationId?: string;
    action?: string;
    extraKeys?: Record<string, string>;
  };
}

export interface WsLifecycleEventMessage extends WsMessageBase {
  type: "lifecycle_event";
  event?: {
    applicationId?: string;
    kind?: string;
    details?: Record<string, string>;
  };
}

export interface WsStorageChangedMessage extends WsMessageBase {
  data?: string;
  eventTimestamp?: number;
  type: "storage_changed";
  packageName?: string;
  fileName?: string;
  key?: string | null;
  value?: string | null;
  valueType?: KeyValueType;
  sequenceNumber?: number;
  /** Device change kind: "add", "modify", or "remove"; absent on legacy frames. */
  changeType?: string;
  // Prior value for this key, emitted by runners that capture it on-device
  // (#3000). Absent on legacy runners; an explicit null means "no prior value".
  previousValue?: string | null;
}

/** Telemetry `recordStorageEvent` input shape built from a `storage_changed` wire message. */
export interface StorageTelemetryInput {
  timestamp: number;
  applicationId: string | null;
  fileName: string;
  key: string | null;
  value: string | null;
  valueType: KeyValueType;
  changeType: string;
  previousValue?: string | null;
}

/**
 * Discriminated union of all WebSocket messages from the accessibility service.
 * The `type` field is the discriminant.
 */
export type WebSocketMessage =
  | WsConnectedMessage
  | WsHierarchyUpdateMessage
  | WsScreenshotMessage
  | WsDisplayTransitionMessage
  | WsScreenshotErrorMessage
  | WsErrorMessage
  | WsSwipeResultMessage
  | WsTapCoordinatesResultMessage
  | WsDragResultMessage
  | WsPinchResultMessage
  | WsSetTextResultMessage
  | WsCommitTextResultMessage
  | WsCancelImeCommitResultMessage
  | WsSetKeyboardProfileResultMessage
  | WsSetNetworkMockRulesResultMessage
  | WsKeyboardProfilesResultMessage
  | WsInsertTextStateResultMessage
  | WsInsertTextResultMessage
  | WsImeActionResultMessage
  | WsSelectAllResultMessage
  | WsActionResultMessage
  | WsClipboardResultMessage
  | WsSettingsGetResultMessage
  | WsSettingsPutResultMessage
  | WsSettingsListResultMessage
  | WsCaCertResultMessage
  | WsDeviceOwnerStatusResultMessage
  | WsPermissionResultMessage
  | WsCurrentFocusResultMessage
  | WsTraversalOrderResultMessage
  | WsPrototypeResultMessage
  | WsPrototypeEventMessage
  | WsHighlightResponseMessage
  | WsGlobalActionResultMessage
  | WsDeviceInfoResultMessage
  | WsKeystoreDiscoveryMessage
  | WsSdkCapabilitiesMessage
  | WsPreferenceFilesMessage
  | WsPreferencesMessage
  | WsSubscribeStorageResultMessage
  | WsUnsubscribeStorageResultMessage
  | WsGetPreferenceResultMessage
  | WsSetPreferenceResultMessage
  | WsRemovePreferenceResultMessage
  | WsClearPreferencesResultMessage
  | WsInstalledPackagesResultMessage
  | WsPackageInfoResultMessage
  | WsLaunchIntentResultMessage
  | WsFrameContextValidationResultMessage
  | WsNavigationEventMessage
  | WsPackageEventMessage
  | WsInteractionEventMessage
  | WsHandledExceptionEventMessage
  | WsCrashEventMessage
  | WsAnrEventMessage
  | WsFrameMetricsMessage
  | WsNetworkEventMessage
  | WsWebSocketFrameEventMessage
  | WsLogEventMessage
  | WsBroadcastEventMessage
  | WsLifecycleEventMessage
  | WsStorageChangedMessage;

export type WebSocketMessageHandlers = {
  [Type in WebSocketMessage["type"]]: (
    message: Extract<WebSocketMessage, { type: Type }>,
  ) => void | Promise<void>;
};
