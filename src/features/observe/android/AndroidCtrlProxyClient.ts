import type { HierarchyReadOptions } from "../interfaces/ViewHierarchy";
/**
 * AndroidCtrlProxyClient - Main client for Android accessibility service.
 *
 * This client provides a unified interface to the Android accessibility service
 * via WebSocket connection. It uses composition with delegate modules to handle
 * specific functionality:
 *
 * - CtrlProxyGestures: Swipe, tap, drag, pinch operations
 * - CtrlProxyText: setText, clearText, IME actions, select all
 * - CtrlProxyHierarchy: Hierarchy retrieval, caching, conversion
 * - CtrlProxyStorage: SharedPreferences operations
 * - CtrlProxyCertificates: CA cert install/remove, permissions
 * - CtrlProxyFocus: TalkBack focus, traversal order
 * - CtrlProxyHighlights: Visual highlight overlays
 */

import type { InsertTextState } from "./ctrlProxyProtocol";
import { join } from "node:path";
import WebSocket from "ws";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger, type Logger } from "../../../utils/logger";
import { displayTransitions } from "../DisplayTransition";
import { linkWindowRoots } from "../linkWindowRoots";
import { rewriteUnknownCommandError } from "../shared/rewriteUnknownCommandError";
import { CtrlProxyForwardingLeaseConflictError } from "../shared/CtrlProxyForwardingLeaseConflictError";
import {
  BootedDevice,
  ImeAction,
  ViewHierarchyResult,
  ScreenScaleMetadata,
  CurrentFocusResult,
  TraversalOrderResult,
  Element,
  HighlightOperationResult,
  HighlightShape,
  toActionableError,
  nodeAttributes,
} from "../../../models";
import { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import type { ProxySetupResult } from "../../../utils/interfaces/ProxyManager";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { exponentialBackoff, fixedBackoff } from "../../../utils/Backoff";
import { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import {
  NavigationGraphManager,
  NavigationEvent,
  type NavigationBuildContext,
} from "../../navigation/NavigationGraphManager";
import {
  createContentHashProvider,
  type ContentHashProvider,
} from "../../../utils/ContentHashProvider";
import { NavigationScreenshotManager } from "../../navigation/NavigationScreenshotManager";
import { HierarchyNavigationDetector } from "../../navigation/HierarchyNavigationDetector";
import { isDeepStrictEqual } from "node:util";
import { InstalledAppsRepository, InstalledAppsStore } from "../../../db/installedAppsRepository";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../../db/installedAppsCacheWriteCoordinator";
import { DefaultWorkProfileMonitor, WorkProfileMonitor } from "../../../utils/WorkProfileMonitor";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { requireBootedDevice } from "../../../devices/requireBootedDevice";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import {
  TrackedScreenGeometry,
  screenshotBindingPushOptions,
  type ScreenGeometryBinding,
} from "../TrackedScreenGeometry";
import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import { COORDINATE_SPACE_PX } from "../../../daemon/canonicalPixels";
import {
  ScreenshotBackoffScheduler,
  DefaultScreenshotBackoffScheduler,
  ScreenshotCaptureResult,
  computeChecksum,
} from "../ScreenshotBackoffScheduler";
import {
  ANDROID_ADB_SCREENSHOT_METADATA,
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
  type ScreenshotFallbackReason,
  type ScreenshotMetadata,
  type ScreenshotPerformanceMetadata,
} from "../ScreenshotMetadata";
import {
  CTRLPROXY_RATE_LIMITED_ERROR,
  CTRLPROXY_SCREENSHOT_TIMEOUT_ERROR,
  fallbackReasonForCtrlProxyFailure,
} from "./screenshotFallbackReason";
import {
  AndroidPhysicalDisplayIdResolver,
  decodePngBase64Output,
  withAndroidScreenshotCaptureLock,
} from "./AndroidPhysicalDisplayId";
import {
  normalizeAnr,
  normalizeCrash,
  withResolvedTimestamp,
  type SdkAnrPayload,
  type SdkAnrWirePayload,
  type SdkCrashPayload,
  type SdkCrashWirePayload,
} from "../crash/sdkCrashIngestion";
import { AndroidSdkEventIngestor, DefaultAndroidSdkEventIngestor } from "./AndroidSdkEventIngestor";
import { FailureEventRepository } from "../../../db/failureEventRepository";
import type { CrashEventSink } from "../../../utils/interfaces/CrashMonitor";
import { serverConfig } from "../../../utils/ServerConfig";
import { TelemetryRecorder } from "../../telemetry/TelemetryRecorder";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import { getSdkFrameMetricsStore } from "../../performance/SdkFrameMetricsStore";
import { registerDeviceIncarnationListener } from "../../../utils/deviceIncarnation";
import type { StackTraceElement } from "../../../server/failuresResources";
import { NetworkState } from "../../../server/NetworkState";
import { buildNetworkMockRules } from "../../../server/networkMockRules";
import {
  ANDROID_CAPABILITY_GATED_COMMANDS,
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
  ANDROID_REQUEST_ID_ECHO_CAPABILITY,
  ANDROID_REQUEST_ID_RESPONSE_TYPES,
  OVERLAY_DISPLAY_CAPABILITY,
  ctrlProxyMissingRequestIdError,
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
} from "./ctrlProxyProtocol";
import type {
  PreferenceFile,
  KeyValueEntry,
  KeyValueType,
  StorageSubscription,
  StorageChangedEvent,
} from "../../storage/storageTypes";
import {
  DeviceServiceClient,
  ObserverPendingRequestTimeoutError,
  WebSocketFactory,
  defaultWebSocketFactory,
  rethrowRealCtrlProxyWebSocketInTestError,
} from "../DeviceServiceClient";
import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import { daemonDeviceAdmissionGate } from "../../../utils/deviceAdmissionGate";
import type { SetTextOptions } from "../DeviceService";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";
import { RetryExecutor, defaultRetryExecutor } from "../../../utils/retry/RetryExecutor";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { errorMessage } from "../../../utils/describeUnknownError";
import { screenshotTempIdToken } from "../../../utils/screenshot/screenshotFormats";
import { shellQuote } from "../../../utils/shellQuote";
import {
  readLockOwnerPid,
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../../utils/fileLock";
import { ensureSecureSharedAutoMobileDirSync } from "../../../utils/tempDir";

// Import delegates
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyText, imeCommitUnitFields, type ImeCommitActionResult } from "./CtrlProxyText";
import type { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import { CtrlProxyCertificates, type CertificateFileSystem } from "./CtrlProxyCertificates";
import { CtrlProxyFocus } from "./CtrlProxyFocus";
import { CtrlProxyOverlays, type OverlayAssetRequestOptions } from "./CtrlProxyOverlays";
import type { OverlaySpec } from "../../overlay/overlaySpec";
import type { OverlayAssetUpload } from "../../overlay/overlayAssets";
import type {
  OverlayAssetResult,
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
  OverlayUpdate,
} from "./ctrlProxyProtocol";
import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import {
  CtrlProxyPackages,
  packageEventAndroidUserId,
  type PackageInfoOptions,
} from "./CtrlProxyPackages";

// Import types
import type { DelegateContext } from "../shared/types";
import type {
  HierarchyDelegateContext,
  CertificatesDelegateContext,
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
  AccessibilityNode,
  CachedHierarchy,
  ScreenshotResult,
  A11ySwipeResult,
  A11yTapCoordinatesResult,
  A11yDragResult,
  A11yPinchResult,
  A11ySetTextResult,
  A11yImeActionResult,
  A11ySelectAllResult,
  A11yActionResult,
  AccessibilityNodeSelector,
  A11yClipboardResult,
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yPermissionResult,
  A11ySettingsGetResult,
  A11ySettingsPutResult,
  A11ySettingsListResult,
  SettingsNamespace,
  SettingsValueType,
  A11yInstalledPackagesResult,
  A11yPackageInfoResult,
  A11yLaunchIntentResult,
  InstalledPackageRecord,
  AndroidPerfTiming,
  HierarchySyncDiagnostics,
  ObserverHierarchyRequestOptions,
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
 * Interface for package event from accessibility service
 */
interface PackageEvent {
  action: "added" | "removed" | "replaced";
  packageName: string;
  /** Android user id; APKs before #10067 sent the package uid here. */
  userId: number;
  /** Raw package uid; present only on APKs whose `userId` is a real user id (#10067). */
  uid?: number | null;
  isSystem?: boolean | null;
  removedForAllUsers?: boolean | null;
}

/**
 * Interface for handled exception event from SDK
 */
interface HandledExceptionEvent {
  timestamp?: number;
  exceptionClass: string;
  /** The wire name the device writes (#10068). */
  message?: string | null;
  /** Legacy name from before #10068; read only when `message` is absent. */
  exceptionMessage?: string;
  stackTrace: string;
  customMessage?: string;
  currentScreen?: string;
  packageName: string;
  appVersion?: string;
  deviceInfo: {
    model: string;
    manufacturer: string;
    osVersion: string;
    sdkInt: number;
  };
}

/**
 * Base fields shared by most WebSocket messages from the accessibility service.
 */
interface WsMessageBase {
  timestamp?: number;
  error?: string;
}

/**
 * Base fields for request/response messages that carry a requestId.
 */
interface WsRequestBase extends WsMessageBase {
  requestId: string;
  success: boolean;
  totalTimeMs: number;
  perfTiming?: AndroidPerfTiming[];
}

// ---------------------------------------------------------------------------
// Individual message types (discriminated on `type`)
// ---------------------------------------------------------------------------

interface WsConnectedMessage extends WsMessageBase {
  type: "connected";
  supportedCommands?: string[];
}

interface WsHierarchyUpdateMessage extends WsMessageBase {
  type: "hierarchy_update";
  data: AccessibilityHierarchy;
  requestId?: string | null;
  perfTiming?: AndroidPerfTiming[];
  frameContext?: string;
}

interface WsScreenshotMessage extends WsMessageBase, ScreenshotPerformanceMetadata {
  type: "screenshot";
  requestId: string;
  data: string;
  format?: string;
  frameContext?: string;
  rotation?: number;
  displayId?: number | null;
  panelUniqueId?: string | null;
}

export interface AndroidDisplayTransition {
  change: "added" | "changed" | "removed" | "device_state";
  displayId: number;
  panelUniqueId?: string;
  width?: number;
  height?: number;
  state?: number;
  rotation?: number;
  deviceState?: number;
}

interface WsDisplayTransitionMessage extends WsMessageBase, AndroidDisplayTransition {
  type: "display_transition";
}

export function displayTransitionFromWire(value: unknown): AndroidDisplayTransition | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    !["added", "changed", "removed", "device_state"].includes(String(event.change)) ||
    !Number.isInteger(event.displayId)
  ) {
    return null;
  }
  const result: AndroidDisplayTransition = {
    change: event.change as AndroidDisplayTransition["change"],
    displayId: event.displayId as number,
  };
  if (typeof event.panelUniqueId === "string") {
    result.panelUniqueId = event.panelUniqueId;
  }
  if (typeof event.width === "number") {
    result.width = event.width;
  }
  if (typeof event.height === "number") {
    result.height = event.height;
  }
  if (typeof event.state === "number") {
    result.state = event.state;
  }
  if (Number.isInteger(event.rotation)) {
    result.rotation = event.rotation as number;
  }
  if (typeof event.deviceState === "number") {
    result.deviceState = event.deviceState;
  }
  return result;
}

interface WsScreenshotErrorMessage extends WsMessageBase {
  type: "screenshot_error";
  requestId: string;
  displayId?: number | null;
  panelUniqueId?: string | null;
}

function screenshotPerformanceMetadataFrom(
  metadata: ScreenshotPerformanceMetadata,
): ScreenshotPerformanceMetadata {
  return {
    screenshotCaptureDurationMs: metadata.screenshotCaptureDurationMs,
    screenshotEncodeDurationMs: metadata.screenshotEncodeDurationMs,
    screenshotByteLength: metadata.screenshotByteLength,
    screenshotBase64Length: metadata.screenshotBase64Length,
  };
}

/**
 * Structured protocol-boundary error emitted by the runner when an inbound command fails to decode
 * or a handler throws (issue #2985). `requestId` is best-effort: null when the runner could not
 * correlate the failure (e.g. an unparseable payload).
 */
interface WsErrorMessage extends WsMessageBase {
  type: "error";
  requestId: string | null;
  success: false;
}

interface WsSwipeResultMessage extends WsRequestBase {
  type: "swipe_result";
  gestureTimeMs?: number;
}

interface WsTapCoordinatesResultMessage extends WsRequestBase {
  type: "tap_coordinates_result";
}

interface WsDragResultMessage extends WsRequestBase {
  type: "drag_result";
  gestureTimeMs?: number;
}

interface WsPinchResultMessage extends WsRequestBase {
  type: "pinch_result";
  gestureTimeMs?: number;
}

interface WsSetTextResultMessage extends WsRequestBase {
  type: "set_text_result";
}

interface WsCommitTextResultMessage extends WsRequestBase {
  type: "commit_text_result";
  partialApplication?: boolean;
  committedUnits?: number;
}

interface WsCancelImeCommitResultMessage extends WsRequestBase {
  type: "cancel_ime_commit_result";
  targetRequestId?: string;
  partialApplication?: boolean;
  committedUnits?: number;
}

interface WsSetKeyboardProfileResultMessage extends WsRequestBase {
  type: "set_keyboard_profile_result";
  activeProfileId?: string;
  previousProfileId?: string;
}

interface WsKeyboardProfilesResultMessage extends WsMessageBase {
  type: "keyboard_profiles_result";
  requestId: string;
  success: boolean;
  catalogId: string;
  catalogVersion?: number;
  supportedCatalogVersions?: number[];
  activeProfileId?: string;
  profiles?: KeyboardProfileCatalog["profiles"];
}

interface WsInsertTextStateResultMessage extends WsRequestBase {
  type: "insert_text_state_result";
  state?: InsertTextState;
}

interface WsInsertTextResultMessage extends WsRequestBase {
  type: "insert_text_result";
  partialApplication?: boolean;
  warning?: string;
  caretPlaced?: boolean;
  resultingTextLength?: number;
}

interface WsImeActionResultMessage extends WsRequestBase {
  type: "ime_action_result";
  action: string;
}

interface WsSelectAllResultMessage extends WsRequestBase {
  type: "select_all_result";
}

interface WsActionResultMessage extends WsRequestBase {
  type: "action_result";
  action: string;
}

interface WsClipboardResultMessage extends WsRequestBase {
  type: "clipboard_result";
  action: "copy" | "paste" | "clear" | "get";
  text?: string;
}

interface WsSettingsGetResultMessage extends WsRequestBase {
  type: "settings_get_result";
  namespace: SettingsNamespace;
  key: string;
  value?: string;
  found?: boolean;
}

interface WsSettingsPutResultMessage extends WsRequestBase {
  type: "settings_put_result";
  namespace: SettingsNamespace;
  key: string;
}

interface WsSettingsListResultMessage extends WsRequestBase {
  type: "settings_list_result";
  namespace: SettingsNamespace;
  entries?: Record<string, string>;
}

interface WsCaCertResultMessage extends WsRequestBase {
  type: "ca_cert_result";
  action: "install" | "remove";
  alias?: string;
}

interface WsDeviceOwnerStatusResultMessage extends WsRequestBase {
  type: "device_owner_status_result";
  isDeviceOwner?: boolean;
  isAdminActive?: boolean;
  packageName?: string;
}

interface WsPermissionResultMessage extends WsRequestBase {
  type: "permission_result";
  permission?: string;
  granted?: boolean;
  requestLaunched?: boolean;
  canRequest?: boolean;
  requiresSettings?: boolean;
  instructions?: string;
  adbCommand?: string;
}

interface WsCurrentFocusResultMessage extends WsMessageBase {
  type: "current_focus_result";
  requestId: string;
  // Both the success broadcaster and currentFocusErrorFrame always emit this field.
  totalTimeMs: number;
  focusedElement?: AccessibilityNode | null;
}

interface WsTraversalOrderResultMessage extends WsMessageBase {
  type: "traversal_order_result";
  requestId: string;
  // Both the success broadcaster and traversalOrderErrorFrame always emit this field.
  totalTimeMs: number;
  result?: {
    elements: AccessibilityNode[];
    focusedIndex: number | null;
    totalCount: number;
    truncationReasons?: string[];
  };
}

interface WsOverlayResultMessage extends OverlayResult {
  type: "overlay_result";
  requestId: string;
}
type WsOverlayEventMessage = OverlayEvent;

interface WsHighlightResponseMessage extends WsMessageBase {
  type: "highlight_response";
  requestId: string;
  success?: boolean;
}

interface WsGlobalActionResultMessage extends WsMessageBase {
  type: "global_action_result";
  requestId: string;
  success?: boolean;
  action?: string;
  totalTimeMs?: number;
}

interface WsFrameContextValidationResultMessage extends WsMessageBase {
  type: "frame_context_validation_result";
  requestId: string;
  success?: boolean;
  totalTimeMs?: number;
}

interface WsDeviceInfoResultMessage extends WsMessageBase {
  type: "device_info_result";
  requestId: string;
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

interface WsKeystoreDiscoveryMessage extends WsMessageBase {
  type: "keystore_discovery";
  requestId: string;
  state: unknown;
}

interface WsPreferenceFilesMessage extends WsMessageBase {
  type: "preference_files";
  requestId: string;
  success?: boolean;
  files?: PreferenceFile[];
  totalTimeMs?: number;
}

interface WsPreferencesMessage extends WsMessageBase {
  type: "preferences";
  requestId: string;
  success?: boolean;
  entries?: KeyValueEntry[];
  totalTimeMs?: number;
}

interface WsSubscribeStorageResultMessage extends WsMessageBase {
  type: "subscribe_storage_result";
  requestId: string;
  success?: boolean;
  // The device sends the subscription as flat fields, not a nested `subscription` object.
  packageName?: string;
  fileName?: string;
  subscriptionId?: string;
  totalTimeMs?: number;
}

interface WsUnsubscribeStorageResultMessage extends WsMessageBase {
  type: "unsubscribe_storage_result";
  requestId: string;
  success?: boolean;
  totalTimeMs?: number;
}

interface WsGetPreferenceResultMessage extends WsMessageBase {
  type: "get_preference_result";
  requestId: string;
  success?: boolean;
  found?: boolean;
  key?: string;
  value?: string;
  valueType?: KeyValueType;
  totalTimeMs?: number;
}

interface WsSetPreferenceResultMessage extends WsMessageBase {
  type: "set_preference_result";
  requestId: string;
  success?: boolean;
  totalTimeMs?: number;
}

interface WsRemovePreferenceResultMessage extends WsMessageBase {
  type: "remove_preference_result";
  requestId: string;
  success?: boolean;
  totalTimeMs?: number;
}

interface WsClearPreferencesResultMessage extends WsMessageBase {
  type: "clear_preferences_result";
  requestId: string;
  success?: boolean;
  totalTimeMs?: number;
}

interface WsInstalledPackagesResultMessage extends WsMessageBase {
  type: "installed_packages_result";
  requestId: string;
  success?: boolean;
  userId?: number;
  packages?: InstalledPackageRecord[];
  totalTimeMs?: number;
}

interface WsPackageInfoResultMessage extends WsMessageBase {
  type: "package_info_result";
  requestId: string;
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

interface WsLaunchIntentResultMessage extends WsMessageBase {
  type: "launch_intent_result";
  requestId: string;
  success?: boolean;
  packageName?: string;
  componentName?: string;
  totalTimeMs?: number;
}

interface WsNavigationEventMessage extends WsMessageBase {
  type: "navigation_event";
  event?: NavigationEvent;
}

interface WsPackageEventMessage extends WsMessageBase {
  type: "package_event";
  event?: PackageEvent;
}

interface WsInteractionEventMessage extends WsMessageBase {
  type: "interaction_event";
  event?: InteractionEvent;
}

interface WsHandledExceptionEventMessage extends WsMessageBase {
  type: "handled_exception_event";
  event?: HandledExceptionEvent;
}

interface WsCrashEventMessage extends WsMessageBase {
  type: "crash_event";
  event?: SdkCrashWirePayload;
}

interface WsAnrEventMessage extends WsMessageBase {
  type: "anr_event";
  event?: SdkAnrWirePayload;
}

/** Real per-frame metrics from the in-app SDK FrameMetricsCollector (issue #5076). */
interface WsFrameMetricsMessage extends WsMessageBase {
  type: "frame_metrics_event";
  frameMetrics?: {
    applicationId?: string;
    fps?: number;
    frameTimeMs?: number;
    jankFrames?: number;
    totalFrames?: number;
  };
}

interface WsNetworkEventMessage extends WsMessageBase {
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

interface WsWebSocketFrameEventMessage extends WsMessageBase {
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

interface WsLogEventMessage extends WsMessageBase {
  type: "log_event";
  event?: {
    applicationId?: string;
    level?: number;
    tag?: string;
    message?: string;
    filterName?: string;
  };
}

interface WsBroadcastEventMessage extends WsMessageBase {
  type: "broadcast_event";
  event?: {
    applicationId?: string;
    action?: string;
    extraKeys?: Record<string, string>;
  };
}

interface WsLifecycleEventMessage extends WsMessageBase {
  type: "lifecycle_event";
  event?: {
    applicationId?: string;
    kind?: string;
    details?: Record<string, string>;
  };
}

interface WsStorageChangedMessage extends WsMessageBase {
  type: "storage_changed";
  packageName?: string;
  fileName?: string;
  key?: string | null;
  value?: string | null;
  valueType?: KeyValueType;
  sequenceNumber?: number;
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
 * WebSocket message types that carry an SDK telemetry event to be fanned out to
 * `TelemetryRecorder` via {@link AndroidSdkEventIngestor.recordSdkEvent} (#2764).
 * `custom_event` is the runtime-only exception to the typed `WebSocketMessage` union.
 */
const SDK_TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "network_event",
  "websocket_frame_event",
  "log_event",
  "broadcast_event",
  "lifecycle_event",
  "custom_event",
]);

/**
 * Build the telemetry `recordStorageEvent` input from a `storage_changed` wire
 * message, normalizing its value to the string contract used by storage updates.
 * Unsafe legacy bare LONG values are logged and rejected. The runner-supplied
 * `previousValue` is threaded through ONLY when the
 * wire message carries it (`!== undefined`), so the repository's
 * `previousValue !== undefined` guard falls through to the per-insert auto-lookup
 * for legacy runners that omit it (#3000). An explicit null ("no prior value")
 * is honored verbatim and also skips the lookup.
 */
export function storageTelemetryInputFromWire(
  message: WsStorageChangedMessage,
  resolvedTimestamp: number,
): StorageTelemetryInput | undefined {
  const normalizedValue = normalizeStorageWireValue(message.value, message.valueType);
  if (normalizedValue === undefined) {
    logger.warn(
      `[CTRL_PROXY] Ignoring unsafe legacy LONG storage value for telemetry ${message.packageName ?? "unknown"}/${message.fileName ?? "unknown"}`,
    );
    return undefined;
  }
  const input: StorageTelemetryInput = {
    timestamp: resolvedTimestamp,
    applicationId: message.packageName ?? null,
    fileName: message.fileName ?? "",
    key: message.key ?? null,
    value: normalizedValue,
    valueType: message.valueType ?? "STRING",
    changeType: message.changeType ?? "modify",
  };
  if (message.previousValue !== undefined) {
    input.previousValue = message.previousValue;
  }
  return input;
}

/**
 * Normalize a `storage_changed` wire value to the JSON-encoded string that
 * `StorageChangedEvent.value` and every downstream consumer expect.
 *
 * The CtrlProxy runner emits `value` as a raw JSON fragment: a quoted string for
 * STRING preferences, but a bare JSON number / boolean / array for INT, LONG,
 * FLOAT, BOOLEAN, and STRING_SET. `JSON.parse` on the wire frame therefore yields
 * a JS `number`/`boolean`/`array` for those types, not a string. Forwarding that
 * runtime value unchanged makes the desktop `storage_update` frame fail
 * kotlinx-serialization decoding (its `StorageEventData.value` is `String?`), so
 * live updates silently drop for every non-string preference type (#4709 review).
 * Re-encoding non-strings with `JSON.stringify` restores the string contract:
 * `42` -> `"42"`, `true` -> `"true"`, `["a","b"]` -> `'["a","b"]'` — each of which
 * the desktop `parseKeyValue` decodes back to its declared type. A legacy runner can send LONG
 * as a bare JSON number; JavaScript has already rounded unsafe values by the time this function
 * receives them, so return `undefined` to make callers reject rather than forward corrupted data.
 */
export function normalizeStorageWireValue(
  value: unknown,
  valueType?: string,
): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (valueType === "LONG" && typeof value === "number" && !Number.isSafeInteger(value)) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

interface JsonParseContext {
  source?: string;
}

/**
 * Parse a CtrlProxy frame without rounding legacy bare 64-bit storage values. Modern runners quote
 * LONG values, but older runners sent them as JSON numbers. Bun's standard JSON.parse source
 * context exposes the original numeric token before IEEE-754 conversion loses digits.
 */
export function parseCtrlProxyJson<T>(text: string): T {
  return JSON.parse(text, (key: string, value: unknown, context?: JsonParseContext): unknown => {
    if (
      (key === "value" || key === "previousValue") &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context?.source
    ) {
      return context.source;
    }
    return value;
  });
}

/**
 * Discriminated union of all WebSocket messages from the accessibility service.
 * The `type` field is the discriminant.
 */
type WebSocketMessage =
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
  | WsOverlayResultMessage
  | WsOverlayEventMessage
  | WsHighlightResponseMessage
  | WsGlobalActionResultMessage
  | WsDeviceInfoResultMessage
  | WsKeystoreDiscoveryMessage
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

type WebSocketMessageHandlers = {
  [Type in WebSocketMessage["type"]]: (
    message: Extract<WebSocketMessage, { type: Type }>,
  ) => void | Promise<void>;
};

/**
 * Interface for accessibility service providing Android UI hierarchy and interaction capabilities
 */
export interface AndroidCtrlProxy extends CtrlProxyClient {
  setRecompositionTrackingEnabled(
    enabled: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void>;

  getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
  ): Promise<AccessibilityHierarchyResponse>;

  requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
    diagnostics?: HierarchySyncDiagnostics,
  ): Promise<{
    hierarchy: AccessibilityHierarchy;
    perfTiming?: AndroidPerfTiming[];
    frameContext?: string;
  } | null>;

  requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{
    hierarchy: AccessibilityHierarchy;
    perfTiming?: AndroidPerfTiming[];
    frameContext?: string;
  } | null>;

  convertToViewHierarchyResult(accessibilityHierarchy: AccessibilityHierarchy): ViewHierarchyResult;

  requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult>;

  requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yTapCoordinatesResult>;

  requestDrag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    pressDurationMs: number,
    dragDurationMs: number,
    holdDurationMs: number,
    timeoutMs: number,
    frameContext?: string,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
    onDispatch?: () => void,
  ): Promise<A11yDragResult>;

  requestPinch(
    centerX: number,
    centerY: number,
    distanceStart: number,
    distanceEnd: number,
    rotationDegrees: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yPinchResult>;

  requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult>;

  requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }>;

  requestInsertText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
    },
    transport?: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs">,
  ): Promise<A11ySetTextResult>;

  commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents" | "clearField",
  ): Promise<ImeCommitActionResult>;

  setKeyboardProfile(
    profileId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<{
    success: boolean;
    activeProfileId?: string;
    previousProfileId?: string;
    error?: string;
  }>;

  listKeyboardProfiles(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<KeyboardProfileCatalog>;

  requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySetTextResult>;

  requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yImeActionResult>;

  requestSelectAll(timeoutMs?: number, perf?: PerformanceTracker): Promise<A11ySelectAllResult>;

  requestAction(
    action: string,
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yActionResult>;

  requestClickFocusedInput(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;

  requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;

  supportsNodeActionSelectors(perf?: PerformanceTracker, signal?: AbortSignal): Promise<boolean>;

  supportsCommand(name: string): Promise<boolean>;

  requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yActionResult>;

  supportsAccessibilityLinkActivation(perf?: PerformanceTracker): Promise<boolean>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yClipboardResult>;

  requestSettingsGet(
    namespace: SettingsNamespace,
    key: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySettingsGetResult>;

  requestSettingsPut(
    namespace: SettingsNamespace,
    key: string,
    value: string | null,
    valueType?: SettingsValueType,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySettingsPutResult>;

  requestSettingsList(
    namespace: SettingsNamespace,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySettingsListResult>;

  requestInstallCaCertificate(
    certificate: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult>;

  requestInstallCaCertificateFromFile(
    certificatePath: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult>;

  requestRemoveCaCertificate(
    alias: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult>;

  requestDeviceOwnerStatus(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yDeviceOwnerStatusResult>;

  requestPermission(
    permission: string,
    requestPermission?: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yPermissionResult>;

  requestShowOverlay(
    spec: OverlaySpec,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
  ): Promise<OverlayResult>;
  requestUpdateOverlay(
    update: OverlayUpdate,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult>;
  requestDismissOverlay(
    target: OverlayDismiss,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult>;
  requestPutOverlayAsset(
    asset: OverlayAssetUpload,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult>;
  requestRemoveOverlayAsset(
    id: string,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult>;
  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void;

  requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult>;

  requestScreenshot(timeoutMs?: number, perf?: PerformanceTracker): Promise<ScreenshotResult>;

  requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<ScreenshotResult>;

  requestInstalledPackages(
    includeSystem?: boolean,
    userId?: number,
    timeoutMs?: number,
  ): Promise<A11yInstalledPackagesResult>;

  requestPackageInfo(
    packageName: string,
    options?: PackageInfoOptions,
    timeoutMs?: number,
  ): Promise<A11yPackageInfoResult>;

  requestLaunchIntent(packageName: string, timeoutMs?: number): Promise<A11yLaunchIntentResult>;
}

/**
 * verifyServiceReady stops retrying once the SAME correlated runner error text has been observed
 * on this many CONSECUTIVE verification attempts (issue #3097). A runner handler failure that
 * reproduces byte-identically after a retry delay is deterministic in practice — retrying to
 * exhaustion just burns the remaining `maxAttempts * (timeout + delay)` budget. Kept at 2 (not 1)
 * so a single handler error during service bring-up — where transient failures are expected —
 * always gets one retry before the loop concludes the failure is deterministic.
 */
const VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT = 2;

/** Isolation markers kept for hierarchy requests whose waiter already gave up. */
const MAX_RETAINED_HIERARCHY_REQUEST_MARKERS = 64;

/**
 * Process-held ownership claim for a device's CtrlProxy ADB forwards. The ADB
 * server is shared by AutoMobile processes, so its global forward listing alone
 * cannot identify which process owns a row.
 */
interface CtrlProxyForwardLease {
  tryAcquire(): boolean;
  release(): void;
  fork?(): CtrlProxyForwardLease;
  /**
   * PID of the process currently holding the lease, when a preceding
   * {@link tryAcquire} call returned `false` (issue #6260). Lets the caller
   * name the orphan in its actionable error instead of a bare "another
   * process owns this" message the client cannot act on.
   */
  getLastOwnerPid(): number | undefined;
}

class FileCtrlProxyForwardLease implements CtrlProxyForwardLease {
  private lockPath: string | null = null;
  private readonly ownerToken = defaultIdGenerator.next();
  private holders = 0;
  private acquired = false;
  private lastOwnerPid: number | undefined;

  public constructor(private readonly deviceId: string) {}

  private resolveLockPath(): string {
    if (this.lockPath === null) {
      // base64url makes arbitrary Android serials safe as one path segment.
      this.lockPath = join(
        // Agent-specific data directories are intentionally isolated, but a
        // default ADB server is shared across agents for this OS user.
        ensureSecureSharedAutoMobileDirSync("ctrlproxy-forwards"),
        `${Buffer.from(this.deviceId).toString("base64url")}.lock`,
      );
    }
    return this.lockPath;
  }

  public tryAcquire(): boolean {
    if (this.acquired) {
      return true;
    }
    this.acquired = this.acquireHolder();
    return this.acquired;
  }

  private acquireHolder(): boolean {
    if (this.holders > 0) {
      this.holders++;
      return true;
    }
    // Shutdown recovery can evict a singleton while its setup remains in flight.
    // Another client in this process must wait for that live lease, not reclaim it.
    const acquired = tryAcquireExclusiveLock(this.resolveLockPath(), {
      ownerToken: this.ownerToken,
    });
    this.holders = acquired ? 1 : 0;
    this.lastOwnerPid = acquired ? undefined : readLockOwnerPid(this.resolveLockPath());
    return acquired;
  }

  public release(): void {
    if (!this.acquired) {
      return;
    }
    this.acquired = false;
    this.releaseHolder();
  }

  private releaseHolder(): void {
    this.holders--;
    if (this.holders > 0) {
      return;
    }
    releaseExclusiveLock(this.resolveLockPath(), process.pid, this.ownerToken);
  }

  public getLastOwnerPid(): number | undefined {
    return this.lastOwnerPid;
  }

  /** A separate holder on the same process lease for one detached observer. */
  public fork(): CtrlProxyForwardLease {
    let acquired = false;
    return {
      tryAcquire: () => {
        if (!acquired) {
          acquired = this.acquireHolder();
        }
        return acquired;
      },
      release: () => {
        if (acquired) {
          acquired = false;
          this.releaseHolder();
        }
      },
      getLastOwnerPid: () => this.lastOwnerPid,
    };
  }
}

function portAllocationIdForClient(
  deviceId: string,
  transientObserver: boolean,
  ids: IdGenerator,
): string {
  return transientObserver ? `${deviceId}:observer:${ids.next()}` : deviceId;
}

/**
 * Actionable message for a CtrlProxy forwarding-lease conflict (issue #6260).
 * Named the owning PID when known, so a client is pointed at the orphan
 * process rather than left to guess or, worse, blame the device.
 */
function describeCtrlProxyForwardingLeaseConflict(
  deviceId: string,
  ownerPid: number | undefined,
): string {
  if (ownerPid !== undefined) {
    return (
      `Another AutoMobile process (PID ${ownerPid}) owns CtrlProxy forwarding for ${deviceId}. ` +
      `This is usually a stale/orphaned AutoMobile daemon left behind by an incomplete ` +
      `\`--daemon restart\` — stop it (\`kill ${ownerPid}\`) and retry.`
    );
  }
  return (
    `Another AutoMobile process owns CtrlProxy forwarding for ${deviceId}. This is usually a ` +
    `stale/orphaned AutoMobile daemon — run \`--daemon restart\` or find and stop it directly.`
  );
}

/**
 * Raise the appropriate error for a failed {@link CtrlProxyForwardLease.tryAcquire}
 * (issue #6260 / PRRT_kwDOP-GF5M6fuKn9). Split out of `setupPortForwarding` to keep
 * that method's branching complexity down; always throws.
 */
function throwCtrlProxyForwardingLeaseConflict(
  deviceId: string,
  ownerPid: number | undefined,
): never {
  if (ownerPid === process.pid) {
    // Same-process transient, NOT an orphan: shutdown recovery can evict a
    // singleton while its in-flight setup still holds the lease, so a
    // REPLACEMENT client constructed in THIS SAME process can observe its own
    // PID as the current owner. Naming and suggesting `kill` on that PID would
    // tell the caller to kill itself. This case must keep waiting for the live
    // in-process lease to release rather than reclaim it (see
    // `FileCtrlProxyForwardLease.tryAcquire` — reclaiming mid-setup would let
    // two instances race the same port forward), so throw the same plain,
    // non-actionable-kill error this path threw before this diagnostic existed
    // and let the caller's existing retry path recover once the lease frees.
    throw new Error(describeCtrlProxyForwardingLeaseConflict(deviceId, undefined));
  }
  // Named explicitly (issue #6260): this exact string is matched by
  // RunnerReadinessService to replace a generic, device-blaming
  // "runner did not become responsive" failure with the real, actionable
  // cause — a stale/orphaned AutoMobile process still holding forwarding
  // for this device, most commonly left behind by a `--daemon restart`
  // that could not confirm the previous daemon stopped.
  throw new CtrlProxyForwardingLeaseConflictError(
    describeCtrlProxyForwardingLeaseConflict(deviceId, ownerPid),
    ownerPid,
  );
}

class NoOpCtrlProxyForwardLease implements CtrlProxyForwardLease {
  public tryAcquire(): boolean {
    return true;
  }

  public release(): void {}

  public getLastOwnerPid(): undefined {
    return undefined;
  }
}

/**
 * Narrow Android manager seam for connection-failure escalation (issue #7532),
 * analogous to `IOSCtrlProxyClient`'s `serviceManagerFactory`. Exposes only what
 * recovery needs: the binding-health probe, the crashed/unbound rebind added by
 * #7470, a wait for an existing bind, and full setup for a service that is
 * missing or not installed at all. `AndroidCtrlProxyManager` implements all four.
 */
export interface AndroidServiceRecoveryManager {
  isAccessibilityServiceHealthy(): Promise<boolean>;
  rebindIfUnhealthy?(): Promise<boolean>;
  waitForAccessibilityServiceBinding?(): Promise<"already-bound" | "recovered" | "unhealthy">;
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;
}

export type AndroidServiceManagerFactory = (device: BootedDevice) => AndroidServiceRecoveryManager;

const defaultAndroidServiceManagerFactory: AndroidServiceManagerFactory = (device) =>
  AndroidCtrlProxyManager.getInstance(device);

/**
 * Client for interacting with the AutoMobile Accessibility Service via WebSocket.
 * Uses singleton pattern per device to maintain persistent WebSocket connection.
 */
/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const CTRL_PROXY_CLIENT_PURPOSE = "to drive the device through CtrlProxy";

export class AndroidCtrlProxyClient extends DeviceServiceClient implements AndroidCtrlProxy {
  /** Optional observer for display and posture changes. */
  onDisplayTransition?: (event: AndroidDisplayTransition) => void;
  private readonly streamedCaptureSequences = new WeakMap<object, number>();
  private static readonly DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250;

  private device: BootedDevice;
  private adb: AdbExecutor;
  private readonly physicalDisplayIdResolver: AndroidPhysicalDisplayIdResolver;
  private readonly idGenerator: IdGenerator;

  // Per-instance port allocation for multi-device support
  private localPort: number;
  private readonly ownsPortAllocation: boolean;
  private readonly portAllocationId: string;

  // Singleton instances per device
  private static instances: Map<string, AndroidCtrlProxyClient> = new Map();
  private static readonly activeObservers = new Set<AndroidCtrlProxyClient>();
  private static readonly retiredDeviceIds = new Set<string>();

  // Build/device provenance (#4984): lazily-built content-hash provider (cached by
  // (deviceId, packageId, versionCode)), the resolved build context per app (kept on
  // the per-device client so it survives session rebinds and is re-applied to the
  // current session's manager on every event), the set of apps whose resolution is
  // in flight, and a per-app generation bumped on package changes so a resolution
  // that started before an update can't apply a stale build.
  private contentHashProvider: ContentHashProvider | null = null;
  private resolvedBuildContexts: Map<string, NavigationBuildContext> = new Map();
  private buildContextInFlight: Set<string> = new Set();
  private buildContextGeneration: Map<string, number> = new Map();

  // Hierarchy caching (accessed by delegates via context)
  private cachedHierarchy: CachedHierarchy | null = null;

  // Android-specific state
  private portForwardingSetup: boolean = false;
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  readonly ctrlProxyForwardLease: CtrlProxyForwardLease;
  private ctrlProxyForwardLeaseReleaseScheduled: boolean = false;
  private inFlightConnection: Promise<boolean> | null = null;
  private cleanupHeldPort: number | null = null;
  private lastWebSocketTimeout: number = 0;
  // Terminal-close latch (#5493): set once by close() so the best-effort ADB
  // screencap fallback in captureScreenshotViaAdb() cannot outlive the client.
  // Distinct from a transient websocket disconnect (onConnectionClosed), which
  // must still allow the ADB fallback.
  private closed: boolean = false;
  private readonly inFlightMessageHandlers = new Set<Promise<void>>();
  // Match the bounded ADB forward-removal confirmation window during teardown.
  private static readonly INBOUND_HANDLER_DRAIN_TIMEOUT_MS = 2000;

  // Connection-failure escalation to service recovery (issue #7532). Counts
  // failures via the base class's onConnectAttemptFailed() hook, which fires
  // once per failed dial AND once per lost open connection (#7537), so both
  // count toward the threshold. Reset on a successful connect or a successful
  // recovery.
  private consecutiveConnectionFailures: number = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES_BEFORE_RECOVERY = 3;
  // Re-entry guard: a recovery burst that has not settled must not start a
  // second, overlapping recovery attempt.
  private isRecoveringService: boolean = false;
  /** A socket must survive this interval before it can rearm a restart. */
  private static readonly RESTART_REARM_STABILITY_MS = 2000;
  private restartRearmTimeout: NodeJS.Timeout | null = null;
  private pendingRecoveryStability:
    | {
        token: number;
        resolve: (stable: boolean) => void;
        eligible: boolean;
        stableSocket: WebSocket | null;
      }
    | undefined;
  /** One client exists per device; this budget gates both failure bursts and observe calls. */
  private readonly forcedRestartBudget: ForcedRestartBudget;
  public static readonly OBSERVE_RECOVERY_WAIT_MS = 10_000;
  private readonly serviceManagerFactory: AndroidServiceManagerFactory;

  // Delegate instances (lazy initialized)
  private _gestures: CtrlProxyGestures | null = null;
  private _text: CtrlProxyText | null = null;
  private _hierarchy: CtrlProxyHierarchy | null = null;
  private _storage: CtrlProxyStorage | null = null;
  private _certificates: CtrlProxyCertificates | null = null;
  private _focus: CtrlProxyFocus | null = null;
  private _overlays: CtrlProxyOverlays | null = null;
  private _highlights: CtrlProxyHighlights | null = null;
  private _packages: CtrlProxyPackages | null = null;

  // Interaction listeners
  private interactionListeners: Set<(event: InteractionEvent) => void> = new Set();
  private static readonly INTERACTION_NAVIGATION_WINDOW_MS = 5_000;
  private static readonly MAX_CACHED_INTERACTIONS = 100;
  // Recent interactions keyed by the app package reported on the wire.
  private lastInteractionByApp: Map<
    string,
    {
      type: string;
      elementText?: string;
      elementResourceId?: string;
      timestamp: number | undefined;
      receivedAtMs: number;
    }
  > = new Map();
  private installedAppsRepository: InstalledAppsStore | null = null;

  // Hierarchy navigation detector
  private sdkNavigationAppIds: Set<string> = new Set();
  private navigationWriteTail: Promise<void> = Promise.resolve();

  // Screenshot backoff scheduler
  private screenshotBackoffScheduler: ScreenshotBackoffScheduler | null = null;
  // Screen geometry derived from hierarchies, carrying whether the daemon has actually seen a
  // hierarchy with that geometry (issue #3348). See TrackedScreenGeometry.
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  readonly screenGeometry = new TrackedScreenGeometry();
  // Runner-reported scale metadata from the most recent hierarchy (#4548). Android reports
  // nativeScale 1 with pixel dims equal to its (already-pixel) screen dims. Retained for #4549;
  // null until a #4548-aware runner reports it. Nothing in current behavior reads it.
  private reportedScaleMetadata: ScreenScaleMetadata | null = null;
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  readonly hierarchyObservationStreamSuppressions = new Map<string, NodeJS.Timeout>();
  private readonly observerHierarchyRequestIds = new Map<string, boolean>();
  private readonly transientObserver: boolean;
  // Request ids whose screenshot responses must not be auto-pushed to the
  // observation stream. Scoped per-request so an unrelated in-flight screenshot
  // (e.g. backoff capture or MCP screenshot) cannot consume the suppression.
  private screenshotObservationStreamSuppressions: Set<string> = new Set();
  // Request ids cancelled after their screenshot frame was dispatched. The runner cannot retract a
  // request already on the wire, so a later response must be discarded rather than auto-pushed.
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  lateCancelledScreenshotRequestIds: Set<string> = new Set();
  private readonly pendingFocusedInputClickIds: Set<string> = new Set();

  // Capture identity bound to each in-flight screenshot request, keyed by requestId (issue #3348).
  // Recorded when the request is SENT and consumed when its response is pushed, so a hierarchy that
  // arrives while the frame is in flight cannot relabel it. Same-resolution navigation makes this
  // the only defence: the pixel dimensions are identical, so nothing about the frame reveals that
  // it belongs to the previous screen.
  private screenshotCaptureBindings: Map<string, ScreenGeometryBinding> = new Map();
  // Track whether the device supports accessibility service screenshots (API 30+).
  // null = unknown, true = supported, false = unsupported (fall back to ADB screencap).
  // Only marked unsupported after consecutive failures to avoid disabling on transient timeouts.
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  a11yScreenshotSupported: boolean | null = null;
  private a11yScreenshotFailures: number = 0;
  private a11yScreenshotUnsupportedSince: number | null = null;
  private static readonly A11Y_SCREENSHOT_MAX_FAILURES = 3;
  private static readonly A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS = 60_000;
  // Minimum interval between accessibility takeScreenshot() requests. The platform rate-limits
  // calls below its floor (~333ms, ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT); 350ms sits just
  // above it so a front-loaded backoff burst or an animation's restart storm cannot trip the
  // limit into needless ADB-screencap fallover (issue #4927).
  private static readonly A11Y_SCREENSHOT_MIN_INTERVAL_MS = 350;

  // Work profile monitor for polling profiles without accessibility service
  private workProfileMonitor: WorkProfileMonitor | null = null;
  private supportedCommands: Set<string> | null = null;
  private readonly rejectedCommands = new Set<string>();
  private static readonly HANDSHAKE_WAIT_TIMEOUT_MS = 2000;
  private static readonly HANDSHAKE_POLL_INTERVAL_MS = 50;
  // Matches iOS's CONNECTION_RESET_MS (set for #2695). The base default
  // (10000ms) outlives waitForConnection()'s default retry budget
  // (~2.7s), so a client that hit maxConnectionAttempts stays cooled down
  // well past a caller's next waitForConnection() even when the endpoint
  // has since recovered (issue #7538). Callers that just changed the
  // endpoint's state (setup, enable, rebind) should still call the base
  // class's resetConnectionBudget() rather than relying on this shorter
  // window alone.
  private static readonly CONNECTION_RESET_MS = 2000;

  // Track foreground package for crash monitoring
  private lastForegroundPackage: string | null = null;
  private lastLayoutTelemetryTimestamp = 0;

  private readonly crashEventSink: CrashEventSink;
  private readonly deviceConnectionLostNotifier: DeviceConnectionLostNotifier;
  private readonly certificateFileSystem: CertificateFileSystem | undefined;

  /**
   * Owns SDK telemetry/crash/ANR ingestion (issue #2764). Lazily built so it can
   * close over instance methods (`parseStackTrace`, session-bound nav manager);
   * injectable for tests.
   */
  private sdkEventIngestorInstance: AndroidSdkEventIngestor | null = null;
  private readonly loggerInstance: Logger;

  // Logging tag for base class
  protected readonly logTag = "ACCESSIBILITY_SERVICE";

  /**
   * Private constructor - use getInstance() instead
   */
  private constructor(
    device: BootedDevice,
    adb: AdbExecutor,
    webSocketFactory?: WebSocketFactory,
    timer?: Timer,
    installedAppsRepository?: InstalledAppsStore,
    retryExecutor?: RetryExecutor,
    crashEventSink?: CrashEventSink,
    deviceConnectionLostNotifier?: DeviceConnectionLostNotifier,
    sdkEventIngestor?: AndroidSdkEventIngestor,
    loggerInstance: Logger = logger,
    certificateFileSystem?: CertificateFileSystem,
    ctrlProxyForwardLease?: CtrlProxyForwardLease,
    serviceManagerFactory: AndroidServiceManagerFactory = defaultAndroidServiceManagerFactory,
    idGenerator: IdGenerator = defaultIdGenerator,
    transientObserver?: boolean,
  ) {
    super(
      timer ?? defaultTimer,
      webSocketFactory ?? defaultWebSocketFactory,
      { connectionResetMs: AndroidCtrlProxyClient.CONNECTION_RESET_MS },
      retryExecutor ?? defaultRetryExecutor,
    );
    this.forcedRestartBudget = new ForcedRestartBudget(this.timer);
    this.serviceManagerFactory = serviceManagerFactory;
    this.sdkEventIngestorInstance = sdkEventIngestor ?? null;
    this.loggerInstance = loggerInstance;
    this.device = device;
    this.adb = adb;
    this.idGenerator = idGenerator;
    this.transientObserver = transientObserver === true;
    this.autoReconnectEnabled = transientObserver !== true;
    this.physicalDisplayIdResolver = new AndroidPhysicalDisplayIdResolver({ timer: this.timer });
    this.installedAppsRepository = installedAppsRepository ?? null;
    this.crashEventSink = crashEventSink ?? new FailureEventRepository();
    this.deviceConnectionLostNotifier =
      deviceConnectionLostNotifier ?? observationStreamDeviceConnectionLostNotifier;
    this.certificateFileSystem = certificateFileSystem;
    this.ctrlProxyForwardLease =
      ctrlProxyForwardLease ?? new FileCtrlProxyForwardLease(device.deviceId);
    // A detached observer needs its own forward while a disconnected singleton
    // retains the device allocation for a later reconnect.
    this.portAllocationId = portAllocationIdForClient(
      device.deviceId,
      this.transientObserver,
      idGenerator,
    );
    this.ownsPortAllocation = PortManager.getPort(this.portAllocationId) === undefined;
    this.localPort = PortManager.allocate(this.portAllocationId, {
      reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
    });
    AndroidCtrlProxyManager.getInstance(device);
    AndroidCtrlProxyClient.trackObserver(this);
  }

  private static trackObserver(client: AndroidCtrlProxyClient): void {
    if (client.transientObserver) {
      AndroidCtrlProxyClient.activeObservers.add(client);
    }
  }

  /**
   * Get singleton instance for a device
   */
  /**
   * FUNNEL 2, alongside `AdbClientFactory`: this is the OTHER Android
   * device-client resolution, and it MEMOIZES, so a client built before the
   * quarantine would otherwise be handed straight back and keep driving whichever
   * runtime now answers on the serial without the factory seam ever being crossed
   * again ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  public static getInstance(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ): AndroidCtrlProxyClient {
    requireBootedDevice(device, "AndroidCtrlProxyClient.getInstance");
    daemonDeviceAdmissionGate.assertDeviceActionable(device.deviceId, CTRL_PROXY_CLIENT_PURPOSE);
    const deviceId = device.deviceId;
    if (AndroidCtrlProxyClient.retiredDeviceIds.has(deviceId)) {
      const existing = AndroidCtrlProxyClient.instances.get(deviceId);
      if (existing) {
        return existing;
      }
      const retired = new AndroidCtrlProxyClient(device, adbFactory.create(device));
      retired.closed = true;
      retired.autoReconnectEnabled = false;
      AndroidCtrlProxyClient.instances.set(deviceId, retired);
      return retired;
    }
    if (!AndroidCtrlProxyClient.instances.has(deviceId)) {
      logger.debug(`[CTRL_PROXY] Creating singleton for device: ${deviceId}`);
      AndroidCtrlProxyClient.instances.set(
        deviceId,
        new AndroidCtrlProxyClient(device, adbFactory.create(device)),
      );
    }
    return AndroidCtrlProxyClient.instances.get(deviceId)!;
  }

  public static getExistingInstance(deviceId: string): AndroidCtrlProxyClient | null {
    return AndroidCtrlProxyClient.instances.get(deviceId) ?? null;
  }

  /** A one-read client; never registers as an owner or recovers the service. */
  public static createForObservationRead(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    existing?: AndroidCtrlProxyClient,
  ): AndroidCtrlProxyClient {
    return new AndroidCtrlProxyClient(
      device,
      adbFactory.create(device),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      logger,
      undefined,
      existing?.ctrlProxyForwardLease.fork?.() ?? existing?.ctrlProxyForwardLease,
      defaultAndroidServiceManagerFactory,
      defaultIdGenerator,
      true,
    );
  }

  public connectForObservationRead(): Promise<boolean> {
    return super.ensureConnected();
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public static registerForTesting(client: AndroidCtrlProxyClient, deviceId: string): void {
    AndroidCtrlProxyClient.instances.set(deviceId, client);
  }

  /**
   * @internal Clear registry entries for isolated tests only. This closes
   * nothing and resets no ports, observers, or retired-device state. Unlike
   * resetInstances(), it avoids fire-and-forget close() cleanup that can run
   * real adb/socket work and avoids resetting PortManager's clock/allocations,
   * which some test files configure in beforeAll.
   */
  public static clearInstanceRegistryForTesting(): void {
    AndroidCtrlProxyClient.instances.clear();
  }

  /**
   * Evict the singleton for a device from the registry. `close()` disables
   * auto-reconnect permanently, so a detached instance left in the map would be
   * handed back to a device that later reuses the same serial (a re-booted
   * emulator) as a stale, non-reconnecting client. Removing it lets the next
   * `getInstance` build a fresh, auto-reconnect-enabled client.
   */
  public static removeInstance(deviceId: string): void {
    AndroidCtrlProxyClient.instances.delete(deviceId);
  }

  public static retireForShutdown(deviceId: string): void {
    AndroidCtrlProxyClient.retiredDeviceIds.add(deviceId);
    const client = AndroidCtrlProxyClient.instances.get(deviceId);
    if (client) {
      client.closed = true;
      client.autoReconnectEnabled = false;
    }
  }

  public static resumeAfterDeviceStart(deviceId: string): void {
    if (AndroidCtrlProxyClient.retiredDeviceIds.delete(deviceId)) {
      AndroidCtrlProxyClient.instances.delete(deviceId);
    }
  }

  /** Remove only the singleton captured before asynchronous incarnation cleanup began. */
  public static removeInstanceIfCurrent(deviceId: string, instance: AndroidCtrlProxyClient): void {
    if (AndroidCtrlProxyClient.getExistingInstance(deviceId) === instance) {
      AndroidCtrlProxyClient.removeInstance(deviceId);
    }
  }

  /** Close the old guest connection and remove its serial singleton. */
  public static async invalidateForDeviceIncarnation(deviceId: string): Promise<void> {
    const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
    try {
      await client?.close();
    } finally {
      if (client) {
        AndroidCtrlProxyClient.removeInstanceIfCurrent(deviceId, client);
      }
    }
  }

  /**
   * Evict this client before its asynchronous close can complete. Its port is
   * held so a replacement client cannot share an ADB forward with late cleanup.
   */
  public invalidateForShutdownRecovery(): void {
    if (AndroidCtrlProxyClient.getExistingInstance(this.device.deviceId) === this) {
      AndroidCtrlProxyClient.removeInstance(this.device.deviceId);
    }
    PortManager.releaseIfAllocated(this.portAllocationId, this.localPort);
    PortManager.holdForCleanup(this.localPort);
    this.cleanupHeldPort = this.localPort;
    // A replacement must recover even if this invalidated client's asynchronous
    // ADB cleanup is wedged. Its held port prevents the replacement from sharing
    // the forward while that cleanup eventually completes.
    this.releaseCtrlProxyForwardLeaseAfterConnectionSettles();
  }

  /**
   * Bind this client to a session for multi-agent NavigationGraphManager isolation.
   * Called when a tool execution context binds a session to this device.
   */
  public bindSession(sessionId: string): void {
    // Binding means this session is live again — clear any released-tombstone so a
    // reused uuid (e.g. setActiveDevice re-creating the session on another device)
    // gets its own manager rather than the unattributed global (#4984).
    NavigationGraphManager.clearReleasedSession(sessionId);
    if (this.boundSessionId !== sessionId) {
      // A per-device client routes nav events to whichever session bound last.
      // That is correct under the pool's one-device-one-live-session invariant
      // (a device is released before it is reassigned). Trace the transition off
      // a previously-bound session so a concurrent-share regression — two live
      // sessions driving one device — is diagnosable in the logs. Debug, not
      // warn: the common case (a released device rebinding to its next session)
      // is expected and must not be noisy.
      if (this.boundSessionId !== null) {
        logger.debug(
          `[AndroidCtrlProxyClient] Rebinding device ${this.device.deviceId} from session ` +
            `${this.boundSessionId} to ${sessionId}`,
        );
      }
      this.boundSessionId = sessionId;
      // Invalidate cached hierarchy detector so it picks up the new session's NavigationGraphManager
      if (this.hierarchyNavigationDetector) {
        this.hierarchyNavigationDetector.dispose();
        this.hierarchyNavigationDetector = null;
      }
    }
  }

  /**
   * Returns the session currently receiving this device's navigation events,
   * or null when the client is unbound.
   */
  public getBoundSessionId(): string | null {
    return this.boundSessionId;
  }

  /**
   * Returns the booted-device identity that constructed this client. Callers
   * use this after teardown to distinguish the original emulator incarnation
   * from a same-ID replacement.
   */
  public getBootedDeviceIdentity(): BootedDevice {
    return { ...this.device };
  }

  /**
   * Get the NavigationGraphManager for the bound session, or the global singleton.
   */
  private getNavigationGraphManager(): NavigationGraphManager {
    return this.boundSessionId
      ? NavigationGraphManager.getInstanceForSession(this.boundSessionId)
      : NavigationGraphManager.getInstance();
  }

  /**
   * Ensure the build/device provenance context for an app is applied to the CURRENT
   * session's navigation manager (#4984). Non-blocking.
   *
   * Re-applies an already-resolved context on every event: the per-device client
   * outlives session rebinds, so a context resolved under session A must still be
   * set on session B's fresh manager. Otherwise it kicks off a one-in-flight
   * resolution; a nav event arriving before it lands records under the default key.
   */
  private ensureBuildContext(appId: string): void {
    const resolved = this.resolvedBuildContexts.get(appId);
    if (resolved) {
      this.getNavigationGraphManager().setBuildContext(resolved);
      return;
    }
    // No resolved context on THIS client for the app: clear it from the currently
    // selected manager so a context left by a previous binding/selection (e.g. set on
    // the global manager while unbound, then not cleared when a later package_event
    // invalidated only the bound manager) is never served as stale (#4984). Falls to
    // the default/unattributed key until (re)resolution lands. Synchronous, so it
    // takes effect before this event's write reads provenance.
    this.getNavigationGraphManager().clearBuildContext(appId);
    if (this.buildContextInFlight.has(appId)) {
      return;
    }
    this.buildContextInFlight.add(appId);
    const startGeneration = this.buildContextGeneration.get(appId) ?? 0;

    const resolve = async (): Promise<void> => {
      try {
        if (this.closed) {
          // Provenance is optional; a closed client must not start deferred device work.
          logger.debug("[CTRL_PROXY] Skipping deferred build-context resolution after close");
          return;
        }
        const info = await this.requestPackageInfo(appId, { includePermissions: false }, 4000);
        if (this.closed) {
          // Missing provenance is safe; avoid a new ADB content-hash probe after release.
          logger.debug("[CTRL_PROXY] Skipping content-hash resolution after close");
          return;
        }
        // A transient package-info failure (timeout / success:false) must NOT be
        // cached as version 0 — that would attribute the whole install to a bogus
        // version until a package event. Defer; a later event retries.
        if (!info.success || typeof info.versionCode !== "number") {
          logger.debug(
            `[CTRL_PROXY] Package info unavailable for ${appId}; deferring build-context resolution`,
          );
          return;
        }
        const versionCode = info.versionCode;
        if (!this.contentHashProvider) {
          // Use the injected executor so tests with a fake adb never launch real
          // `adb`, and custom production executors aren't bypassed (#4984).
          this.contentHashProvider = createContentHashProvider(this.device, this.adb);
        }
        const contentHash = await this.contentHashProvider.resolveContentHash(
          this.device,
          appId,
          versionCode,
        );
        // Discard if a package change invalidated this app while we were resolving —
        // applying now would stamp observations with the pre-update build's hash.
        if ((this.buildContextGeneration.get(appId) ?? 0) !== startGeneration) {
          return;
        }
        if (contentHash === null) {
          // Unresolved hash: leave the default build key; a later event retries.
          return;
        }
        const context: NavigationBuildContext = {
          appId,
          deviceId: this.device.deviceId,
          versionCode,
          contentHash,
        };
        this.resolvedBuildContexts.set(appId, context);
        this.getNavigationGraphManager().setBuildContext(context);
      } catch (error) {
        // Best-effort provenance: log at warn (unexpected failure of a diagnostic
        // path per CLAUDE.md) and let mutations fall back to the default key.
        logger.warn(`[CTRL_PROXY] Build-context resolution failed for ${appId}: ${error}`);
      } finally {
        this.buildContextInFlight.delete(appId);
      }
    };

    // Defer the resolution to a macrotask so NO work runs inline with the current
    // WebSocket message handler (#4984/#2885). resolve() would otherwise call
    // requestPackageInfo synchronously — a WS send plus a RequestManager timeout
    // timer — which reorders the barrier-tracked navigation-graph write and the
    // socket-close cache invalidation on differently-scheduled runners (macOS/Windows
    // CI). Scheduling on the injected timer keeps the event handler's barrier
    // registration synchronous and first, with the hash resolving out-of-band.
    // Fire-and-forget: resolution only sets in-memory build context (no DB write),
    // so it is NOT enlisted in the DB-write shutdown barrier.
    this.timer.setTimeout(() => {
      void resolve();
    }, 0);
  }

  /**
   * Invalidate all cached build/content-hash provenance for an app (#4984), so its
   * next nav event re-resolves the hash. Called on a package add/replace/remove — a
   * rebuild+reinstall (including same-versionCode/different-content) must not keep
   * recording against the old build. Bumps the generation so an in-flight resolution
   * that started before the change is discarded rather than applying a stale build.
   */
  private invalidateBuildContext(appId: string): void {
    this.buildContextGeneration.set(appId, (this.buildContextGeneration.get(appId) ?? 0) + 1);
    this.resolvedBuildContexts.delete(appId);
    this.contentHashProvider?.invalidate(this.device.deviceId, appId);
    this.getNavigationGraphManager().clearBuildContext(appId);
  }

  /**
   * The SDK-event ingestor for this client (issue #2764). Built lazily so it can
   * close over instance methods and the session-bound navigation manager; a
   * test-injected instance short-circuits construction.
   */
  private getSdkEventIngestor(): AndroidSdkEventIngestor {
    if (!this.sdkEventIngestorInstance) {
      this.sdkEventIngestorInstance = new DefaultAndroidSdkEventIngestor({
        deviceId: this.device.deviceId,
        getNavigationScreenSource: () => this.getNavigationGraphManager(),
        parseStackTrace: (stackTrace, packageName) => this.parseStackTrace(stackTrace, packageName),
        now: () => this.timer.now(),
      });
    }
    return this.sdkEventIngestorInstance;
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    for (const instance of AndroidCtrlProxyClient.instances.values()) {
      instance.close().catch((error) => {
        const logger = instance.loggerInstance;
        // The local alias keeps the injected logger visible to the catch-convention lint rule.
        logger.warn(`[CTRL_PROXY] Instance reset cleanup failed: ${errorMessage(error)}`, error);
      });
    }
    AndroidCtrlProxyClient.instances.clear();
    AndroidCtrlProxyClient.activeObservers.clear();
    AndroidCtrlProxyClient.retiredDeviceIds.clear();
    PortManager.reset();
    logger.info("[CTRL_PROXY] Reset all singleton instances and port allocations");
  }

  /**
   * Create instance for testing with custom WebSocket factory
   */
  public static createForTesting(
    device: BootedDevice,
    adb: AdbExecutor,
    webSocketFactory: (url: string) => WebSocket,
    timer?: Timer,
    installedAppsRepository?: InstalledAppsStore,
    retryExecutor?: RetryExecutor,
    crashEventSink?: CrashEventSink,
    deviceConnectionLostNotifier?: DeviceConnectionLostNotifier,
    sdkEventIngestor?: AndroidSdkEventIngestor,
    loggerInstance?: Logger,
    certificateFileSystem?: CertificateFileSystem,
    screenshotBackoffScheduler?: ScreenshotBackoffScheduler,
    ctrlProxyForwardLease?: CtrlProxyForwardLease,
    serviceManagerFactory?: AndroidServiceManagerFactory,
    idGenerator?: IdGenerator,
    transientObserver = false,
  ): AndroidCtrlProxyClient {
    const client = new AndroidCtrlProxyClient(
      device,
      adb,
      webSocketFactory,
      timer,
      installedAppsRepository,
      retryExecutor,
      crashEventSink,
      deviceConnectionLostNotifier,
      sdkEventIngestor,
      loggerInstance,
      certificateFileSystem,
      ctrlProxyForwardLease ?? new NoOpCtrlProxyForwardLease(),
      serviceManagerFactory ?? defaultAndroidServiceManagerFactory,
      idGenerator,
      transientObserver,
    );
    // Test-only seam: pre-seed the lazily-built scheduler so tests can assert shared floor
    // accounting (noteCaptureStarted) without the live device-data-stream server. Not exposed on
    // the production getInstance path.
    if (screenshotBackoffScheduler) {
      client.screenshotBackoffScheduler = screenshotBackoffScheduler;
    }
    return client;
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public static createWithFileForwardLeaseForTesting(
    device: BootedDevice,
    adb: AdbExecutor,
    webSocketFactory: WebSocketFactory,
    timer: Timer,
  ): AndroidCtrlProxyClient {
    return new AndroidCtrlProxyClient(device, adb, webSocketFactory, timer);
  }

  // ===========================================================================
  // Delegate Context Factories
  // ===========================================================================

  private createHierarchyDelegateContext(): HierarchyDelegateContext {
    return {
      ...this.createDelegateContext(),
      device: this.device,
      adb: this.adb,
      getCachedHierarchy: () => this.cachedHierarchy,
      setCachedHierarchy: (h) => {
        this.cachedHierarchy = h;
      },
      getLastWebSocketTimeout: () => this.lastWebSocketTimeout,
      setLastWebSocketTimeout: (time) => {
        this.lastWebSocketTimeout = time;
      },
      markObserverHierarchyRequest: (requestId, options) => {
        this.observerHierarchyRequestIds.set(requestId, options?.isolateResponse ?? false);
        // Markers of unanswered requests outlive their waiter (a late reply must stay isolated);
        // evict the oldest so an unresponsive runner cannot grow the map without bound.
        while (this.observerHierarchyRequestIds.size > MAX_RETAINED_HIERARCHY_REQUEST_MARKERS) {
          const oldest = this.observerHierarchyRequestIds.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          this.observerHierarchyRequestIds.delete(oldest);
        }
      },
      unmarkObserverHierarchyRequest: (requestId) => {
        this.observerHierarchyRequestIds.delete(requestId);
      },
    };
  }

  protected override extraDelegateContextFields(): Partial<DelegateContext> {
    return {
      isCommandSupported: (messageType) => this.isCommandSupported(messageType),
      getSupportedCommands: () => this.getSupportedCommands(),
    };
  }

  private createCertificatesDelegateContext(): CertificatesDelegateContext {
    return {
      ...this.createDelegateContext(),
      adb: this.adb,
    };
  }

  // ===========================================================================
  // Delegate Getters (lazy initialization)
  // ===========================================================================

  private get gestures(): CtrlProxyGestures {
    return this.lazyDelegate(
      () => this._gestures,
      (value) => {
        this._gestures = value;
      },
      () => new CtrlProxyGestures(this.createDelegateContext()),
    );
  }

  private get text(): CtrlProxyText {
    return this.lazyDelegate(
      () => this._text,
      (value) => {
        this._text = value;
      },
      () => new CtrlProxyText(this.createDelegateContext()),
    );
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  get hierarchy(): CtrlProxyHierarchy {
    return this.lazyDelegate(
      () => this._hierarchy,
      (value) => {
        this._hierarchy = value;
      },
      () => new CtrlProxyHierarchy(this.createHierarchyDelegateContext()),
    );
  }

  private get storage(): CtrlProxyStorage {
    return this.lazyDelegate(
      () => this._storage,
      (value) => {
        this._storage = value;
      },
      () => new CtrlProxyStorage(this.createDelegateContext()),
    );
  }

  private get certificates(): CtrlProxyCertificates {
    return this.lazyDelegate(
      () => this._certificates,
      (value) => {
        this._certificates = value;
      },
      () =>
        new CtrlProxyCertificates(
          this.createCertificatesDelegateContext(),
          this.certificateFileSystem,
        ),
    );
  }

  private get focus(): CtrlProxyFocus {
    return this.lazyDelegate(
      () => this._focus,
      (value) => {
        this._focus = value;
      },
      () => new CtrlProxyFocus(this.createDelegateContext()),
    );
  }

  private get overlays(): CtrlProxyOverlays {
    return this.lazyDelegate(
      () => this._overlays,
      (value) => {
        this._overlays = value;
      },
      () => new CtrlProxyOverlays(this.createDelegateContext()),
    );
  }

  private get highlights(): CtrlProxyHighlights {
    return this.lazyDelegate(
      () => this._highlights,
      (value) => {
        this._highlights = value;
      },
      () => new CtrlProxyHighlights(this.createDelegateContext()),
    );
  }

  private get packages(): CtrlProxyPackages {
    return this.lazyDelegate(
      () => this._packages,
      (value) => {
        this._packages = value;
      },
      () => new CtrlProxyPackages(this.createDelegateContext()),
    );
  }

  async requestInstalledPackages(
    includeSystem: boolean = true,
    userId?: number,
    timeoutMs: number = 5000,
  ): Promise<A11yInstalledPackagesResult> {
    return this.packages.requestInstalledPackages(includeSystem, userId, timeoutMs);
  }

  async requestPackageInfo(
    packageName: string,
    options: PackageInfoOptions = {},
    timeoutMs: number = 5000,
  ): Promise<A11yPackageInfoResult> {
    return this.packages.requestPackageInfo(packageName, options, timeoutMs);
  }

  async requestLaunchIntent(
    packageName: string,
    timeoutMs: number = 5000,
  ): Promise<A11yLaunchIntentResult> {
    return this.packages.requestLaunchIntent(packageName, timeoutMs);
  }

  // ===========================================================================
  // DeviceServiceClient abstract method implementations
  // ===========================================================================

  protected getWebSocketUrl(): string {
    return `ws://127.0.0.1:${this.localPort}/ws`;
  }

  protected handleMessage(data: WebSocket.Data): Promise<void> {
    const handler = this.handleWebSocketMessage(data);
    this.inFlightMessageHandlers.add(handler);
    // Observe settlement without wrapping dispatch or moving its synchronous prefix.
    // The existing handleWebSocketMessage catch owns logging handler failures.
    void handler.then(
      () => this.inFlightMessageHandlers.delete(handler),
      () => this.inFlightMessageHandlers.delete(handler),
    );
    return handler;
  }

  /**
   * Defense in depth on top of onConnectionEstablished(): every caller that needs the
   * device connected already routes through ensureConnected() (getLatestHierarchy,
   * requestHierarchySync, etc.), so re-syncing accessibility flags here guarantees the
   * device has the current config before any hierarchy request goes out — regardless of
   * whether this call freshly opened the WebSocket (onConnectionEstablished fires) or
   * reused an already-open one (connectWebSocket's early-return skips it). Cost: the
   * allEnabled early-return in syncAccessibilityFlagsToDevice() skips the send entirely
   * in the common case (all flags default). When a flag IS disabled (e.g. --no-occlusion)
   * it re-sends the config on each call — a small, idempotent, order-preserved message,
   * kept deliberately simple as defense-in-depth so a reused connection can't drift.
   */
  public override async ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const connected = await super.ensureConnected(perf);
    if (connected) {
      this.syncAccessibilityFlagsToDevice();
    }
    return connected;
  }

  protected override async connectWebSocket(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const connection = super.connectWebSocket(perf);
    this.inFlightConnection = connection;
    try {
      return await connection;
    } finally {
      if (this.inFlightConnection === connection) {
        this.inFlightConnection = null;
      }
      if (this.closed) {
        await this.finishInvalidatedConnectionCleanup();
      }
    }
  }

  protected onConnectionEstablished(): void {
    if (this.transientObserver) {
      return;
    }
    // Reset failure escalation state on every successful connect (issue #7532).
    this.consecutiveConnectionFailures = 0;
    // A newly connected CtrlProxy may be a different runner or service version.
    this.resetA11yScreenshotSupport();
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
    }
    this.restartRearmTimeout = this.timer.setTimeout(() => {
      this.restartRearmTimeout = null;
      if (!this.isConnected()) {
        if (this.pendingRecoveryStability?.eligible) {
          this.failPendingRecoveryStability("WebSocket closed before stable reconnect");
        }
        return;
      }
      const pending = this.pendingRecoveryStability;
      if (pending) {
        pending.stableSocket = this.ws;
        this.completePendingRecoveryStability();
      } else if (this.forcedRestartBudget.snapshot().state !== "suspended") {
        this.forcedRestartBudget.recordSuccess();
      }
    }, AndroidCtrlProxyClient.RESTART_REARM_STABILITY_MS);
    this.syncNetworkStateToDevice();
    this.syncAccessibilityFlagsToDevice();
    // The runner loses its in-process content observers across a service restart while the desktop
    // Unix stream remains connected. The stream server retains the pane-owned subscriptions and
    // replays them on this new CtrlProxy connection.
    void getDeviceDataStreamServer()?.reapplyStorageSubscriptionsForDevice(this.device.deviceId);
    // Resume the screenshot keepalive after a (re)connect. onConnectionClosed()
    // cancels it; without restarting here, a transient drop on a STATIC screen
    // leaves the live view frozen forever (no UI change to retrigger a capture).
    // Subscriber-gated and idempotent, so this is a no-op when nobody is
    // watching and safe to call on every reconnect.
    this.startScreenshotBackoff();
  }

  /**
   * Push THIS device's mock rules and error simulation from the host store.
   * Runs on every (re)connect, and after a session release clears the store so
   * the device drops what that session installed (issue #10061).
   */
  public syncNetworkStateToDevice(): void {
    try {
      const state = NetworkState.getInstance();
      const deviceId = this.device.deviceId;

      // Always sync mock rules on reconnect, scoped to this device. The device
      // store keeps consumption per mockId across a re-push (#10060). Sending an
      // empty list clears stale rules that may linger from a previous connection.
      const rules = buildNetworkMockRules(state, deviceId);
      this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules })));

      // Always re-sync error simulation state (including disabled) so the
      // device doesn't keep stale simulation config from a previous connection
      const sim = state.getSimulation(deviceId);
      this.sendMessage(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.setNetworkErrorSimulation({
            enabled: sim !== null,
            errorType: sim?.errorType,
            limit: sim?.limit,
            expiresAtEpochMs: sim?.expiresAt,
          }),
        ),
      );
    } catch (e) {
      logger.debug(`[AndroidCtrlProxyClient] Failed to sync network state on reconnect: ${e}`);
    }
  }

  private syncAccessibilityFlagsToDevice(): void {
    try {
      const flags = serverConfig.getAccessibilityFlagsConfig();
      const allEnabled =
        flags.includeNotImportantViews &&
        flags.reportViewIds &&
        flags.retrieveInteractiveWindows &&
        flags.occlusionEnabled;
      // Diagnostic: without this, "did the push ever get attempted" is unanswerable from
      // logs alone — the only prior signal was the (info-level) send below, so a no-op
      // skip and "never called" were indistinguishable (issue occlusion-flag).
      logger.debug(
        `[AndroidCtrlProxyClient] syncAccessibilityFlagsToDevice invoked: allEnabled=${allEnabled}, ` +
          `occlusionEnabled=${flags.occlusionEnabled}`,
      );
      if (allEnabled) {
        return;
      }

      logger.info(
        `[AndroidCtrlProxyClient] Sending accessibility flags config: ` +
          `includeNotImportantViews=${flags.includeNotImportantViews}, ` +
          `reportViewIds=${flags.reportViewIds}, ` +
          `retrieveInteractiveWindows=${flags.retrieveInteractiveWindows}, ` +
          `occlusionEnabled=${flags.occlusionEnabled}`,
      );
      this.sendMessage(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.setAccessibilityFlags({
            includeNotImportantViews: flags.includeNotImportantViews,
            reportViewIds: flags.reportViewIds,
            retrieveInteractiveWindows: flags.retrieveInteractiveWindows,
            occlusionEnabled: flags.occlusionEnabled,
          }),
        ),
      );
    } catch (e) {
      logger.debug(
        `[AndroidCtrlProxyClient] Failed to sync accessibility flags on reconnect: ${e}`,
      );
    }
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public onConnectionClosed(): void {
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
      if (this.pendingRecoveryStability?.eligible) {
        this.failPendingRecoveryStability("WebSocket closed before stable reconnect");
      }
    }
    if (this.pendingRecoveryStability) {
      this.pendingRecoveryStability.stableSocket = null;
    }
    this.supportedCommands = null;
    this.rejectedCommands.clear();
    this.lateCancelledScreenshotRequestIds.clear();
    this.observerHierarchyRequestIds.clear();
    this.clearHierarchyObservationStreamSuppressions();
    this.cancelScreenshotBackoff();
    this._hierarchy?.rejectAllPendingHierarchy("WebSocket connection closed");
    // Issue #7540: the cache describes device UI state as of the closed connection, and the
    // recomposition-tracking latch describes what the runner's accessibility service instance
    // held. Both are connection-scoped: a runner restart (crash rebind, APK reinstall) behind
    // this close can hand the next connection a service with tracking off, and a stale tree
    // served after reconnect can describe UI state from before whatever triggered the restart.
    // Mirrors IOSCtrlProxyClient.onConnectionClosed() clearing `cachedHierarchy`.
    this.cachedHierarchy = null;
    this._hierarchy?.resetConnectionScopedState();
    if (this.transientObserver) {
      return;
    }
    void this.markInstalledAppsStale("websocket_closed");
    this.deviceConnectionLostNotifier.onDeviceConnectionLost(this.device.deviceId);

    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.dispose();
      this.hierarchyNavigationDetector = null;
    }

    // Revalidate build/device provenance across a disconnect (#4984): while the WS has
    // no client, a package_event has zero listeners, so an app could be replaced
    // unobserved. Invalidate every known app's cached context — clearing the resolved
    // context, the provider's hash cache, and bumping the generation so any in-flight
    // resolution is discarded — so the next nav event after reconnect re-resolves the
    // hash instead of attributing to the pre-update build indefinitely.
    for (const appId of this.knownBuildContextApps()) {
      this.invalidateBuildContext(appId);
    }

    // Stop work profile monitor when connection closes
    this.stopWorkProfileMonitor();
  }

  private failPendingRecoveryStability(reason: string): void {
    const pending = this.pendingRecoveryStability;
    if (pending) {
      this.pendingRecoveryStability = undefined;
      this.forcedRestartBudget.recordFailure(reason, pending.token);
      pending.resolve(false);
    }
  }

  private completePendingRecoveryStability(): void {
    const pending = this.pendingRecoveryStability;
    if (pending?.eligible && pending.stableSocket === this.ws && this.isConnected()) {
      this.pendingRecoveryStability = undefined;
      pending.resolve(this.forcedRestartBudget.recordSuccess(pending.token));
    }
  }

  /** Every app id with cached or in-flight build-context state (#4984). */
  private knownBuildContextApps(): string[] {
    return Array.from(
      new Set([...this.resolvedBuildContexts.keys(), ...this.buildContextInFlight]),
    );
  }

  /**
   * Escalate repeated connection failures to service recovery (issue #7532).
   * Fires once per failed dial AND once per lost open connection (#7537's
   * `onConnectAttemptFailed` funnel), so both refused dials and dropped
   * connections count toward the threshold — mirroring
   * `IOSCtrlProxyClient.onConnectAttemptFailed`. Disabled while auto-reconnect
   * is off or the client is closed.
   */
  protected override onConnectAttemptFailed(): void {
    if (this.closed || !this.autoReconnectEnabled) {
      return;
    }

    this.consecutiveConnectionFailures++;
    logger.info(
      `[AndroidCtrlProxyClient] Connection attempt failed (failure count: ${this.consecutiveConnectionFailures})`,
    );

    if (
      this.consecutiveConnectionFailures > 0 &&
      this.consecutiveConnectionFailures %
        AndroidCtrlProxyClient.MAX_CONSECUTIVE_FAILURES_BEFORE_RECOVERY ===
        0 &&
      !this.isRecoveringService
    ) {
      this.triggerServiceRecovery();
    }
  }

  /**
   * Trigger CtrlProxy accessibility-service recovery through the manager.
   * Called when repeated WebSocket connection failures indicate the service
   * may be crashed, unbound, or missing (issue #7532). Guarded by
   * `isRecoveringService` so a failure burst cannot start a second, overlapping
   * recovery while one is already in flight.
   */
  private triggerServiceRecovery(): void {
    if (this.isRecoveringService) {
      return;
    }
    const token = this.forcedRestartBudget.tryBeginAttempt();
    if (token === undefined) {
      return;
    }

    this.isRecoveringService = true;
    logger.info(
      `[AndroidCtrlProxyClient] Triggering CtrlProxy recovery after ${this.consecutiveConnectionFailures} connection failures`,
    );

    // A background reconnect can stabilize while the async health probe is
    // pending. Claim its stability signal with this recovery's token now.
    const replaceStabilityWaiter = (): Promise<boolean> => {
      this.pendingRecoveryStability?.resolve(false);
      return new Promise<boolean>((resolve) => {
        this.pendingRecoveryStability = { token, resolve, eligible: false, stableSocket: null };
      });
    };
    let stableConnection = replaceStabilityWaiter();

    const generation = this.connectionGeneration;
    const recovery = this.recoverAccessibilityService(generation, () => {
      stableConnection = replaceStabilityWaiter();
    })
      .then(async (outcome) => {
        if (this.closed || outcome === "failed" || outcome === "unavailable") {
          this.failPendingRecoveryStability(`service recovery ${outcome}`);
          this.forcedRestartBudget.recordFailure(`service recovery ${outcome}`, token);
          return false;
        }
        // A repaired service may clear the foreground connection cooldown;
        // the failure counter and restart budget reset only after reconnect.
        if (outcome === "repaired") {
          // Only an actual rebind/setup or a completed in-progress bind
          // justifies resetting the foreground cooldown early — the service
          // was demonstrably broken and is now fixed. When it was already
          // healthy (#6260: WS refused for an unrelated reason), leave the
          // connection budget alone so the cooldown still gates a background
          // reconnect instead of hammering a socket unrelated to service health.
          // resetConnectionBudget() (issue #7538) also clears the cooldown
          // clock and un-pauses a paused background reconnect, not just the
          // attempt counter.
          this.resetConnectionBudget();
        }
        if (this.pendingRecoveryStability) {
          this.pendingRecoveryStability.eligible = true;
          this.completePendingRecoveryStability();
        }
        logger.info(
          `[AndroidCtrlProxyClient] Recovery completed (${outcome}); reconnecting WebSocket`,
        );
        // Background reconnect respects the #7537 background-attempt cap
        // rather than consuming the caller's foreground connect budget.
        const connected =
          outcome === "repaired"
            ? await this.connectBackgroundWebSocketAfterRecovery(generation)
            : await this.connectBackgroundWebSocket();
        if (!connected) {
          logger.warn(
            `[AndroidCtrlProxyClient] WebSocket reconnect failed after CtrlProxy recovery`,
          );
        }
        if (!connected || !this.isConnected()) {
          this.failPendingRecoveryStability("WebSocket reconnect failed");
          return false;
        }
        if (this.pendingRecoveryStability && !this.restartRearmTimeout) {
          this.failPendingRecoveryStability("No stable WebSocket reconnect observed");
        }
        this.consecutiveConnectionFailures = 0;
        return await stableConnection;
      })
      .catch((error) => {
        this.failPendingRecoveryStability(String(error));
        this.forcedRestartBudget.recordFailure(String(error), token);
        logger.warn(`[AndroidCtrlProxyClient] CtrlProxy recovery failed: ${error}`);
        return false;
      })
      .finally(() => {
        // A superseded recovery must not clear a newer attempt's state.
        if (this.recoveryPromise === recovery) {
          this.isRecoveringService = false;
          this.recoveryPromise = null;
        }
      });
    this.recoveryPromise = recovery;
  }

  /** Retry the post-bind socket dial while the accessibility service finishes starting its server. */
  private async connectBackgroundWebSocketAfterRecovery(generation: number): Promise<boolean> {
    const startedAt = this.timer.now();
    const backoff = fixedBackoff(100);
    let attempt = 1;

    while (
      !this.closed &&
      generation === this.connectionGeneration &&
      this.timer.now() - startedAt < AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS
    ) {
      const connected = await this.connectBackgroundWebSocket();
      if (connected) {
        return (
          !this.closed &&
          generation === this.connectionGeneration &&
          this.timer.now() - startedAt <= AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS
        );
      }

      const remainingMs =
        AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS - (this.timer.now() - startedAt);
      if (this.closed || generation !== this.connectionGeneration || remainingMs <= 0) {
        break;
      }
      await this.timer.sleep(Math.min(backoff.delayForAttempt(attempt), remainingMs));
      attempt++;
    }

    return false;
  }

  /** Start a recovery for this observed transport failure if none is pending. */
  public ensureRecoveryStarted(): void {
    if (!this.closed && this.autoReconnectEnabled && !this.recoveryPromise) {
      this.triggerServiceRecovery();
    }
  }

  public isRecoveryInFlight(): boolean {
    return this.recoveryPromise !== null;
  }

  /**
   * Check device presence, then the accessibility service's health. A healthy
   * service is left untouched — no rebind, no setup — the caller only
   * reconnects in the background without resetting the foreground cooldown
   * (issue #6260). An unhealthy service is rebound per #7470 (force-stop,
   * re-add, bounded health poll), falling back to a full `setup()` when the
   * rebind alone does not restore health (e.g. CtrlProxy is missing from
   * `enabled_accessibility_services` or not installed at all).
   */
  private async recoverAccessibilityService(
    generation: number,
    onEscalation: () => void,
  ): Promise<"healthy" | "repaired" | "unavailable" | "failed"> {
    if (this.closed) {
      return "failed";
    }
    const present = await this.isDevicePresent();
    if (generation !== this.connectionGeneration) {
      return "failed";
    }
    if (!present) {
      logger.info(
        `[AndroidCtrlProxyClient] Device ${this.device.deviceId} is offline or missing; skipping recovery`,
      );
      return "unavailable";
    }

    const manager = this.serviceManagerFactory(this.device);
    const healthy = await manager.isAccessibilityServiceHealthy();
    if (generation !== this.connectionGeneration) {
      return "failed";
    }
    if (healthy) {
      logger.info(
        `[AndroidCtrlProxyClient] Accessibility service already healthy; skipping rebind`,
      );
      return "healthy";
    }

    onEscalation();
    logger.info(`[AndroidCtrlProxyClient] Accessibility service unhealthy; attempting rebind`);
    const rebound = (await manager.rebindIfUnhealthy?.()) ?? false;
    if (generation !== this.connectionGeneration) {
      return "failed";
    }
    const rebindOutcome = await this.rebindRecoveryOutcome(manager, rebound);
    if (generation !== this.connectionGeneration) {
      return "failed";
    }
    if (rebindOutcome) {
      return rebindOutcome;
    }

    onEscalation();
    logger.info(`[AndroidCtrlProxyClient] Rebind did not restore health; running full setup`);
    return this.setupRecoveryService(manager, generation);
  }

  private async rebindRecoveryOutcome(
    manager: AndroidServiceRecoveryManager,
    rebound: boolean,
  ): Promise<"repaired" | "healthy" | null> {
    if (rebound) {
      return (await manager.isAccessibilityServiceHealthy()) ? "repaired" : null;
    }
    // A no-op rebind can mean the service was already binding. Let that bind
    // finish before escalating to setup, which would force-stop it again.
    const binding = await manager.waitForAccessibilityServiceBinding?.();
    return binding === "recovered" ? "repaired" : binding === "already-bound" ? "healthy" : null;
  }

  private async setupRecoveryService(
    manager: AndroidServiceRecoveryManager,
    generation: number,
  ): Promise<"repaired" | "failed"> {
    const result = await manager.setup(true);
    if (generation !== this.connectionGeneration) {
      return "failed";
    }
    if (!result.success) {
      logger.warn(
        `[AndroidCtrlProxyClient] CtrlProxy setup failed during recovery: ${result.message}`,
      );
      return "failed";
    }
    const healthy = await manager.isAccessibilityServiceHealthy();
    if (generation !== this.connectionGeneration) {
      return "failed";
    }
    if (!healthy) {
      logger.warn(`[AndroidCtrlProxyClient] Accessibility service remained unhealthy after setup`);
      return "failed";
    }
    return "repaired";
  }

  /**
   * Whether adb still reports this device as present and online. Recovery must
   * not touch a stopped or disconnected device (issue #7532), mirroring the
   * `bootedDeviceLister` check `IOSCtrlProxyClient.ensureConnected` runs before
   * its own auto-setup.
   */
  private async isDevicePresent(): Promise<boolean> {
    const getDeviceStates = this.adb.getDeviceStates?.bind(this.adb);
    if (!getDeviceStates) {
      // The executor cannot report raw device states; fail open rather than
      // block recovery on a capability the executor doesn't provide.
      return true;
    }
    try {
      const states = await getDeviceStates();
      const match = states.find((state) => state.deviceId === this.device.deviceId);
      // "unauthorized" is not a state recovery can act on either — adb cannot
      // run shell commands against it, so it is not meaningfully "present".
      return match !== undefined && match.state !== "offline" && match.state !== "unauthorized";
    } catch (error) {
      // Diagnostic failure only: do not block recovery on it.
      logger.warn(
        `[AndroidCtrlProxyClient] Failed to check device state during recovery: ${error}`,
      );
      return true;
    }
  }

  protected async setupBeforeConnect(perf: PerformanceTracker, signal: AbortSignal): Promise<void> {
    await this.setupPortForwarding(perf, signal);
  }

  // ===========================================================================
  // Delegated Public Methods - Hierarchy
  // ===========================================================================

  // Thin pass-throughs: like the gesture/text/etc. delegates below, these do NOT
  // restate the delegate's default parameter values. Omitted args forward as
  // `undefined`, so CtrlProxyHierarchy (the single source of truth) applies its own
  // defaults — keeping the two-copies drift class from issue #3505 unrepresentable.
  async getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    readOptions?: number | HierarchyReadOptions,
  ): Promise<ViewHierarchyResult | null> {
    return this.hierarchy.getAccessibilityHierarchy(
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      disableAllFiltering,
      signal,
      readOptions,
    );
  }

  async setRecompositionTrackingEnabled(
    enabled: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.hierarchy.setRecompositionTrackingEnabled(enabled, perf, signal);
  }

  async getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    signal?: AbortSignal,
  ): Promise<AccessibilityHierarchyResponse> {
    return this.hierarchy.getLatestHierarchy(
      waitForFresh,
      timeout,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
    );
  }

  async requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
    diagnostics?: HierarchySyncDiagnostics,
    displayId?: number,
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    return this.hierarchy.requestHierarchySync(
      perf,
      disableAllFiltering,
      signal,
      timeoutMs,
      diagnostics,
      displayId,
    );
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering: boolean = false,
    signal?: AbortSignal,
    timeoutMs: number = 10000,
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    const deadline = this.timer.now() + Math.max(0, timeoutMs);
    let suppressedRequestId: string | undefined;
    try {
      return await this.hierarchy.requestHierarchySyncWithOptions({
        perf,
        disableAllFiltering,
        signal,
        timeoutMs,
        observerMode: false,
        onRequestId: (requestId) => {
          // A failed WS send switches to the broadcast's sync_ id. Retire the old token first.
          if (suppressedRequestId) {
            this.removeHierarchyObservationStreamSuppression(suppressedRequestId);
          }
          if (this.closed || signal?.aborted) {
            return;
          }
          suppressedRequestId = requestId;
          this.hierarchyObservationStreamSuppressions.set(
            requestId,
            this.timer.setTimeout(
              () => {
                this.removeHierarchyObservationStreamSuppression(requestId);
              },
              Math.max(0, deadline - this.timer.now()),
            ),
          );
        },
      });
    } finally {
      if (suppressedRequestId) {
        this.removeHierarchyObservationStreamSuppression(suppressedRequestId);
      }
    }
  }

  private removeHierarchyObservationStreamSuppression(requestId: string): boolean {
    const timeout = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (timeout === undefined) {
      return false;
    }
    this.hierarchyObservationStreamSuppressions.delete(requestId);
    this.timer.clearTimeout(timeout);
    return true;
  }

  private clearHierarchyObservationStreamSuppressions(): void {
    for (const requestId of this.hierarchyObservationStreamSuppressions.keys()) {
      this.removeHierarchyObservationStreamSuppression(requestId);
    }
  }

  async requestHierarchySyncForObserver(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering = false,
    signal?: AbortSignal,
    timeoutMs = 10000,
    display?: number | ObserverHierarchyRequestOptions,
  ): Promise<{ hierarchy: AccessibilityHierarchy; frameContext?: string } | null> {
    const deadline = this.timer.now() + timeoutMs;
    await this.waitForPendingRequests(timeoutMs, signal);
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    return this.hierarchy.requestHierarchySyncForObserver(
      perf,
      disableAllFiltering,
      signal,
      remaining,
      display,
    );
  }

  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    const result = this.hierarchy.convertToViewHierarchyResult(accessibilityHierarchy);
    const captureSequence = this.streamedCaptureSequences.get(accessibilityHierarchy);
    if (captureSequence !== undefined) {
      result.captureSequence = captureSequence;
    }
    return result;
  }

  hasCachedHierarchy(): boolean {
    return this.hierarchy.hasCachedHierarchy();
  }

  invalidateCache(): void {
    return this.hierarchy.invalidateCache();
  }

  // ===========================================================================
  // Delegated Public Methods - Gestures
  // ===========================================================================

  // These are thin pass-throughs. They deliberately DO NOT restate the delegate's
  // default parameter values: omitted args forward as `undefined`, so the delegate
  // (the single source of truth) applies its own defaults. This makes the two-copies
  // drift class from issue #3505 unrepresentable.
  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestSwipe(
      x1,
      y1,
      x2,
      y2,
      duration,
      timeoutMs,
      perf,
      frameContext,
      onDispatch,
      signal,
      displayId,
      beforeSend,
    );
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    // Deliberate Android-specific override: taps default to a 10ms press, not the
    // delegate's cross-platform 0ms default. This is the one intentional divergence,
    // not restated drift — see issue #3505.
    duration: number = 10,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    return this.gestures.requestTapCoordinates(
      x,
      y,
      duration,
      timeoutMs,
      perf,
      frameContext,
      signal,
      onDispatch,
      displayId,
      beforeSend,
    );
  }

  /** Double tap (TalkBack activation, tapOn/tapAny/tapAt) with device-side double-tap timing. */
  async requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
    options?: {
      frameContext?: string;
      displayId?: number;
      signal?: AbortSignal;
      beforeSend?: () => void;
    },
  ): Promise<A11yTapCoordinatesResult> {
    return this.gestures.requestDoubleTapCoordinates(x, y, onDispatch, options);
  }

  async requestTwoFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    offset?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestTwoFingerSwipe(
      x1,
      y1,
      x2,
      y2,
      duration,
      offset,
      timeoutMs,
      perf,
      displayId,
      beforeSend,
    );
  }

  async requestDrag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    pressDurationMs: number,
    dragDurationMs: number,
    holdDurationMs: number,
    timeoutMs: number,
    frameContext?: string,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
    onDispatch?: () => void,
  ): Promise<A11yDragResult> {
    return this.gestures.requestDrag(
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      timeoutMs,
      frameContext,
      signal,
      displayId,
      beforeSend,
      onDispatch,
    );
  }

  async requestPinch(
    centerX: number,
    centerY: number,
    distanceStart: number,
    distanceEnd: number,
    rotationDegrees: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yPinchResult> {
    return this.gestures.requestPinch(
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      timeoutMs,
      perf,
      signal,
      displayId,
      beforeSend,
    );
  }

  // Streaming gesture input (Android-only): one live drag = start + moves + end sharing a gestureId,
  // chained into a single continued AccessibilityService gesture by the runner.
  // oxlint-disable-next-line max-params -- Append the dispatch fence to the existing positional Android API.
  async requestGestureStart(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureStart(
      gestureId,
      x,
      y,
      timeoutMs,
      perf,
      displayId,
      beforeSend,
    );
  }

  async requestGestureMove(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureMove(gestureId, x, y, timeoutMs, perf);
  }

  async requestGestureEnd(
    gestureId: string,
    x: number,
    y: number,
    cancel?: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureEnd(gestureId, x, y, cancel, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Text
  // ===========================================================================

  async requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult> {
    return this.text.requestSetText(text, options);
  }

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    // Older APKs do not know this optional command; absence retains legacy suffix settling.
    if (!(await this.supportsCommand("request_insert_text_state"))) {
      return { success: true };
    }
    return this.text.requestInsertTextState();
  }

  async requestInsertText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
    },
    transport: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs"> = {},
  ): Promise<A11ySetTextResult> {
    return this.text.requestInsertText(text, timeoutMs, perf, options, transport);
  }

  async commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents" | "clearField",
  ): Promise<ImeCommitActionResult> {
    return this.text.commitViaIme(text, priorImeId, timeoutMs, perf, signal, delivery);
  }

  async setKeyboardProfile(
    profileId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<{
    success: boolean;
    activeProfileId?: string;
    previousProfileId?: string;
    error?: string;
  }> {
    return this.text.setKeyboardProfile(profileId, timeoutMs, perf);
  }

  async listKeyboardProfiles(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<KeyboardProfileCatalog> {
    return this.text.listKeyboardProfiles(timeoutMs, perf);
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySetTextResult> {
    return this.text.requestClearText(resourceId, timeoutMs, perf);
  }

  async requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yImeActionResult> {
    return this.text.requestImeAction(action, timeoutMs, perf, abortSignal, onDispatch);
  }

  async requestSelectAll(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySelectAllResult> {
    return this.text.requestSelectAll(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Certificates & Permissions
  // ===========================================================================

  async requestInstallCaCertificate(
    certificate: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult> {
    return this.certificates.requestInstallCaCertificate(certificate, timeoutMs, perf);
  }

  async requestInstallCaCertificateFromFile(
    certificatePath: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult> {
    return this.certificates.requestInstallCaCertificateFromFile(certificatePath, timeoutMs, perf);
  }

  async requestRemoveCaCertificate(
    alias: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult> {
    return this.certificates.requestRemoveCaCertificate(alias, timeoutMs, perf);
  }

  async requestDeviceOwnerStatus(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yDeviceOwnerStatusResult> {
    return this.certificates.requestDeviceOwnerStatus(timeoutMs, perf);
  }

  async requestPermission(
    permission: string,
    requestPermission?: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yPermissionResult> {
    return this.certificates.requestPermission(permission, requestPermission, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Storage
  // ===========================================================================

  async listPreferenceFiles(packageName: string, timeoutMs?: number): Promise<PreferenceFile[]> {
    return this.storage.listPreferenceFiles(packageName, timeoutMs);
  }

  async getPreferenceEntries(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry[]> {
    return this.storage.getPreferenceEntries(packageName, fileName, timeoutMs);
  }

  async discoverKeystore(packageName: string) {
    return this.storage.discoverKeystore(packageName);
  }

  async listDataStores(
    packageName: string,
    adapterName: string,
    timeoutMs?: number,
  ): Promise<PreferenceFile[]> {
    return this.storage.listDataStores(packageName, adapterName, timeoutMs);
  }

  async getDataStore(
    packageName: string,
    adapterName: string,
    storeName: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry[]> {
    return this.storage.getDataStore(packageName, adapterName, storeName, timeoutMs);
  }

  async getPreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry | null> {
    return this.storage.getPreference(packageName, fileName, key, timeoutMs);
  }

  async setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string | null,
    type: KeyValueType,
    timeoutMs?: number,
  ): Promise<void> {
    return this.storage.setPreference(packageName, fileName, key, value, type, timeoutMs);
  }

  async removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs?: number,
  ): Promise<void> {
    return this.storage.removePreference(packageName, fileName, key, timeoutMs);
  }

  async clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<void> {
    return this.storage.clearPreferenceStore(packageName, fileName, timeoutMs);
  }

  async subscribeStorage(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<StorageSubscription> {
    return this.storage.subscribeStorage(packageName, fileName, timeoutMs);
  }

  async unsubscribeStorage(subscriptionId: string, timeoutMs?: number): Promise<void> {
    return this.storage.unsubscribeStorage(subscriptionId, timeoutMs);
  }

  addStorageChangeListener(callback: (event: StorageChangedEvent) => void): () => void {
    return this.storage.addStorageChangeListener(callback);
  }

  // ===========================================================================
  // Delegated Public Methods - Focus
  // ===========================================================================

  async clearAccessibilityFocus(
    resourceId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<void> {
    return this.focus.clearAccessibilityFocus(resourceId, timeoutMs, perf);
  }

  async setAccessibilityFocus(
    resourceId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<void> {
    return this.focus.setAccessibilityFocus(resourceId, timeoutMs, perf);
  }

  async requestCurrentFocus(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CurrentFocusResult> {
    return this.focus.requestCurrentFocus(timeoutMs, perf);
  }

  async requestTraversalOrder(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<TraversalOrderResult> {
    return this.focus.requestTraversalOrder(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Highlights
  // ===========================================================================

  requestShowOverlay(
    spec: OverlaySpec,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
  ): Promise<OverlayResult> {
    return this.overlays.requestShowOverlay(spec, timeoutMs, perf, displayId);
  }
  requestUpdateOverlay(
    update: OverlayUpdate,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    return this.overlays.requestUpdateOverlay(update, timeoutMs, perf);
  }
  requestDismissOverlay(
    target: OverlayDismiss,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    return this.overlays.requestDismissOverlay(target, timeoutMs, perf);
  }
  requestPutOverlayAsset(
    asset: OverlayAssetUpload,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    return this.overlays.requestPutOverlayAsset(asset, options);
  }
  requestRemoveOverlayAsset(
    id: string,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    return this.overlays.requestRemoveOverlayAsset(id, options);
  }
  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void {
    return this.overlays.onOverlayEvent(listener);
  }

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult> {
    return this.highlights.requestAddHighlight(id, shape, timeoutMs, perf);
  }

  // ===========================================================================
  // Non-delegated Public Methods
  // ===========================================================================

  async requestAction(
    action: string,
    resourceId?: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    selector?: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.dispatchActionRequest(
      action,
      (requestId) =>
        serializeCtrlProxyRequest(
          ctrlProxyRequests.requestAction({ requestId, action, resourceId, selector }),
        ),
      timeoutMs,
      perf,
      signal,
    );
  }

  async requestClickFocusedInput(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    try {
      return await this.dispatchActionRequest(
        "click",
        (requestId) => {
          this.pendingFocusedInputClickIds.add(requestId);
          return serializeCtrlProxyRequest(
            ctrlProxyRequests.requestClickFocusedInput({ requestId }),
          );
        },
        timeoutMs,
        perf,
        signal,
      );
    } finally {
      this.pendingFocusedInputClickIds.clear();
    }
  }

  /**
   * Very old runners reject the focused-input click during decoding without echoing its id; settle
   * the pending clicks so the host can fall back instead of timing out.
   */
  private settleUnattributedFocusedClickRejection(
    requestId: string | null | undefined,
    rejectedCommand: string | undefined,
    errorText: string,
  ): void {
    if (requestId || rejectedCommand !== "request_click_focused_input") {
      return;
    }
    for (const id of this.pendingFocusedInputClickIds) {
      this.requestManager.resolveError(id, errorText);
    }
  }

  private async dispatchActionRequest(
    action: string,
    serializeRequest: (requestId: string) => string,
    timeoutMs: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    const startTime = this.timer.now();
    const combinedSignal = combineWithAmbientAbort(signal);
    let pendingRequestId: string | undefined;
    let dispatched = false;

    this.cancelScreenshotBackoff();

    try {
      const connected = await this.awaitActionWork(
        () => perf.track("ensureConnection", () => this.connectWebSocket(perf)),
        combinedSignal,
      );
      combinedSignal?.throwIfAborted();
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for action");
        return {
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
          dispatched: false,
          acknowledged: false,
        };
      }

      const requestId = this.requestManager.generateId("action");
      pendingRequestId = requestId;
      logger.debug(
        `[CTRL_PROXY] Creating action request (requestId: ${requestId}, action: ${action})`,
      );

      const actionPromise = this.requestManager.register<A11yActionResult>(
        requestId,
        "action",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: `Action timeout after ${timeout}ms`,
          acknowledged: false,
        }),
        (error, totalTimeMs) => ({
          success: false,
          action,
          totalTimeMs,
          error,
          acknowledged: true,
        }),
      );

      const cancellableAction = this.awaitCancellableRequest(
        requestId,
        actionPromise,
        combinedSignal,
        startTime,
      );
      await perf.track("sendRequest", async () => {
        combinedSignal?.throwIfAborted();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeRequest(requestId);
        this.ws.send(message);
        dispatched = true;
        logger.debug(
          `[CTRL_PROXY] Sent action request (requestId: ${requestId}, action: ${action})`,
        );
      });

      const result = await perf.track("waitForAction", () => cancellableAction);
      combinedSignal?.throwIfAborted();
      const clientDuration = this.timer.now() - startTime;

      if (result.success) {
        logger.debug(
          `[CTRL_PROXY] Action completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, action=${result.action}`,
        );
      } else {
        logger.warn(`[CTRL_PROXY] Action failed after ${clientDuration}ms: ${result.error}`);
      }

      return { ...result, dispatched, acknowledged: result.acknowledged ?? true };
    } catch (error) {
      if (pendingRequestId) {
        this.requestManager.resolveError(
          pendingRequestId,
          String(error),
          this.timer.now() - startTime,
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never report a failed action.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Action request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        action,
        totalTimeMs: duration,
        error: `${error}`,
        dispatched,
        acknowledged: false,
      };
    }
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.requestAction(action, selector.resourceId, timeoutMs, perf, selector, signal);
  }

  async supportsNodeActionSelectors(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    const combinedSignal = combineWithAmbientAbort(signal);
    const connected = await this.awaitActionWork(
      () => perf.track("ensureConnection", () => this.connectWebSocket(perf)),
      combinedSignal,
    );
    combinedSignal?.throwIfAborted();
    if (connected && this.supportedCommands === null) {
      await this.waitForHandshake(undefined, combinedSignal);
    }
    combinedSignal?.throwIfAborted();
    // Unknown selector support must stay closed: an old runner could click the wrong repeated node.
    return (
      connected &&
      this.supportedCommands !== null &&
      this.isCommandSupported("node_selector_actions")
    );
  }

  /**
   * Connects and waits for the runner handshake before returning its advertised
   * command set. A null result means no compatible handshake was available.
   */
  public async getSupportedCommands(): Promise<string[] | null> {
    if (this.supportedCommands === null) {
      const connected = await this.ensureConnected();
      if (connected) {
        await this.waitForHandshake();
      }
    }
    return this.supportedCommands === null ? null : Array.from(this.supportedCommands).sort();
  }

  public async supportsCommand(name: string): Promise<boolean> {
    return (await this.getSupportedCommands())?.includes(name) === true;
  }

  async supportsAccessibilityLinkActivation(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
    if (connected && this.supportedCommands === null) {
      await this.waitForHandshake();
    }
    return connected && this.isCommandSupported("request_activate_accessibility_link");
  }

  // Keep existing positional arguments compatible while adding cancellation and dispatch tracking.
  // oxlint-disable-next-line max-params
  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yActionResult> {
    const startTime = this.timer.now();
    const action = "activate_accessibility_link";
    const combinedSignal = combineWithAmbientAbort(signal);
    const checkCancellation = (): void => combinedSignal?.throwIfAborted();
    let requestId: string | undefined;
    let dispatched = false;
    const unconfirmed = (error: string): A11yActionResult => ({
      success: false,
      action,
      totalTimeMs: this.timer.now() - startTime,
      error,
      dispatched,
      acknowledged: false,
      ...(dispatched ? { retryable: false } : {}),
    });
    try {
      const supported = await this.awaitActionWork(
        () => this.supportsAccessibilityLinkActivation(perf),
        combinedSignal,
      );
      checkCancellation();
      if (!supported) {
        return unconfirmed(
          "Connected Android runner does not support semantic accessibility-link activation",
        );
      }
      requestId = this.requestManager.generateId("accessibility-link");
      const resultPromise = this.requestManager.register<A11yActionResult>(
        requestId,
        "accessibility-link",
        timeoutMs,
        () => unconfirmed(`Semantic link activation timed out after ${timeoutMs}ms`),
        (error, totalTimeMs) => ({
          success: false,
          action,
          totalTimeMs,
          error,
          acknowledged: true,
        }),
      );
      checkCancellation();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      this.ws.send(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.requestActivateAccessibilityLink({
            requestId,
            text,
            occurrence,
            selector,
          }),
        ),
      );
      dispatched = true;
      onDispatch?.();
      const result = await this.awaitCancellableRequest(
        requestId,
        resultPromise,
        combinedSignal,
        startTime,
      );
      checkCancellation();
      return { ...result, dispatched, acknowledged: result.acknowledged ?? true };
    } catch (error) {
      if (requestId) {
        this.requestManager.resolveError(
          requestId,
          errorMessage(error),
          this.timer.now() - startTime,
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never report an unconfirmed activation.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Semantic link activation failed", error);
      return unconfirmed(errorMessage(error));
    } finally {
      if (!dispatched) {
        checkCancellation();
      }
    }
  }

  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yClipboardResult & { acknowledged?: boolean }> {
    const startTime = this.timer.now();
    const combinedSignal = combineWithAmbientAbort(signal);
    let requestId: string | undefined;

    try {
      combinedSignal?.throwIfAborted();
      if (action === "copy" && !text) {
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Text is required for copy action",
        };
      }

      const connected = await this.awaitActionWork(
        () => perf.track("ensureConnection", () => this.connectWebSocket(perf)),
        combinedSignal,
      );
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for clipboard");
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      combinedSignal?.throwIfAborted();
      requestId = this.requestManager.generateId("clipboard");
      const clipboardRequestId = requestId;

      const clipboardPromise = this.requestManager.register<
        A11yClipboardResult & { acknowledged?: boolean }
      >(clipboardRequestId, "clipboard", timeoutMs, (_id, _type, timeout) => ({
        success: false,
        acknowledged: false,
        action,
        totalTimeMs: this.timer.now() - startTime,
        error: `Clipboard ${action} timeout after ${timeout}ms`,
      }));

      await perf.track("sendRequest", async () => {
        combinedSignal?.throwIfAborted();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(
          ctrlProxyRequests.requestClipboard({ requestId: clipboardRequestId, action, text }),
        );
        this.ws.send(message);
        onDispatch?.();
        logger.debug(
          `[CTRL_PROXY] Sent clipboard request (requestId: ${requestId}, action: ${action})`,
        );
      });

      const result = await perf.track("waitForClipboard", () =>
        this.awaitCancellableRequest(
          clipboardRequestId,
          clipboardPromise,
          combinedSignal,
          startTime,
        ).then((result) => ({
          ...result,
          // Only a device reply confirms an outcome; timeout and local cancellation do not.
          acknowledged: result.acknowledged ?? !combinedSignal?.aborted,
        })),
      );
      const clientDuration = this.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] Clipboard ${action} completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] Clipboard ${action} failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      if (requestId) {
        this.requestManager.resolveError(requestId, String(error), this.timer.now() - startTime);
      }
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Clipboard request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        action,
        totalTimeMs: duration,
        error: `${error}`,
        acknowledged: false,
      };
    }
  }

  async requestSettingsGet(
    namespace: SettingsNamespace,
    key: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11ySettingsGetResult> {
    const startTime = this.timer.now();
    try {
      if (!this.isConnected()) {
        return {
          success: false,
          found: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      const requestId = this.requestManager.generateId("settings_get");
      const promise = this.requestManager.register<A11ySettingsGetResult>(
        requestId,
        "settings_get",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          found: false,
          totalTimeMs: this.timer.now() - startTime,
          error: `Settings get timeout after ${timeout}ms`,
        }),
      );

      await perf.track("sendRequest", async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        this.ws.send(
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestSettingsGet({ requestId, namespace, key }),
          ),
        );
      });

      const result = await perf.track("waitForSettingsGet", () => promise);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Settings get failed after ${duration}ms: ${error}`);
      return { success: false, found: false, totalTimeMs: duration, error: `${error}` };
    }
  }

  async requestSettingsPut(
    namespace: SettingsNamespace,
    key: string,
    value: string | null,
    valueType: SettingsValueType = "string",
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11ySettingsPutResult> {
    const startTime = this.timer.now();
    try {
      if (!this.isConnected()) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      const requestId = this.requestManager.generateId("settings_put");
      const promise = this.requestManager.register<A11ySettingsPutResult>(
        requestId,
        "settings_put",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: `Settings put timeout after ${timeout}ms`,
        }),
      );

      await perf.track("sendRequest", async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        this.ws.send(
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestSettingsPut({ requestId, namespace, key, value, valueType }),
          ),
        );
      });

      const result = await perf.track("waitForSettingsPut", () => promise);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Settings put failed after ${duration}ms: ${error}`);
      return { success: false, totalTimeMs: duration, error: `${error}` };
    }
  }

  async requestSettingsList(
    namespace: SettingsNamespace,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11ySettingsListResult> {
    const startTime = this.timer.now();
    try {
      if (!this.isConnected()) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      const requestId = this.requestManager.generateId("settings_list");
      const promise = this.requestManager.register<A11ySettingsListResult>(
        requestId,
        "settings_list",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: `Settings list timeout after ${timeout}ms`,
        }),
      );

      await perf.track("sendRequest", async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        this.ws.send(
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestSettingsList({ requestId, namespace }),
          ),
        );
      });

      const result = await perf.track("waitForSettingsList", () => promise);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Settings list failed after ${duration}ms: ${error}`);
      return { success: false, totalTimeMs: duration, error: `${error}` };
    }
  }

  /**
   * Execute a global action (back, home, recents, etc.) via the accessibility service.
   */
  async requestGlobalAction(
    action: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<{
    success: boolean;
    action: string;
    totalTimeMs: number;
    error?: string;
    acknowledged?: boolean;
  }> {
    const startTime = this.timer.now();
    // Combine with the ambient request signal so a cancelled request (e.g.
    // session teardown mid-home-press) can free this keyed device operation
    // immediately rather than blocking on the CtrlProxy wait until its timeout
    // (issue #6289).
    const combinedSignal = combineWithAmbientAbort(signal);
    let requestId: string | undefined;
    try {
      // Fast-fail if not already connected to avoid stalling callers
      // (undelivered requests are safe to fall back to ADB keyevents)
      if (!this.isConnected()) {
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }
      if (combinedSignal?.aborted) {
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: OPERATION_CANCELLED_MESSAGE,
        };
      }

      requestId = this.requestManager.generateId("global_action");
      const promise = this.requestManager.register<{
        success: boolean;
        action: string;
        totalTimeMs: number;
        error?: string;
        acknowledged?: boolean;
      }>(requestId, "global_action", timeoutMs, (_id, _type, timeout) => ({
        success: false,
        action,
        totalTimeMs: this.timer.now() - startTime,
        error: `Global action timeout after ${timeout}ms`,
        acknowledged: false,
      }));

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      this.ws.send(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.requestGlobalAction({ requestId, action, frameContext }),
        ),
      );
      onDispatch?.();
      logger.debug(
        `[CTRL_PROXY] Sent global action request (requestId: ${requestId}, action: ${action})`,
      );

      return await this.awaitCancellableRequest(requestId, promise, combinedSignal, startTime).then(
        (result) => ({
          ...result,
          // Only a device reply confirms an outcome; timeout and local cancellation do not.
          acknowledged: result.acknowledged ?? !combinedSignal?.aborted,
        }),
      );
    } catch (error) {
      const logger = this.loggerInstance;
      // The local alias keeps the injected logger visible to the catch-convention lint rule.
      logger.warn(`[CTRL_PROXY] Global action failed: ${errorMessage(error)}`, error);
      if (requestId) {
        // Settle the abandoned wait, as in requestClipboard; return the typed failure below.
        this.requestManager.resolveError(requestId, String(error), this.timer.now() - startTime);
      }
      return {
        success: false,
        action,
        totalTimeMs: this.timer.now() - startTime,
        error: error instanceof Error ? error.toString() : errorMessage(error),
        acknowledged: false,
      };
    }
  }

  /**
   * Verifies that an observed frame context still matches device state immediately before
   * an ADB-only input action is issued.
   */
  async validateFrameContext(
    frameContext: string,
    timeoutMs: number = 5000,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; totalTimeMs: number; error?: string }> {
    const startTime = this.timer.now();
    // See requestGlobalAction: cancel the CtrlProxy wait on abort so a torn-down
    // request does not keep the keyed device operation busy for the remaining
    // request budget (issue #6289).
    const combinedSignal = combineWithAmbientAbort(signal);
    let requestId: string | undefined;
    try {
      if (!this.isConnected()) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }
      if (combinedSignal?.aborted) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: OPERATION_CANCELLED_MESSAGE,
        };
      }

      requestId = this.requestManager.generateId("validate_frame_context");
      const promise = this.requestManager.register<{
        success: boolean;
        totalTimeMs: number;
        error?: string;
      }>(requestId, "validate_frame_context", timeoutMs, (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: this.timer.now() - startTime,
        error: `Frame context validation timeout after ${timeout}ms`,
      }));

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      this.ws.send(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.validateFrameContext({ requestId, frameContext }),
        ),
      );

      return await this.awaitCancellableRequest(requestId, promise, combinedSignal, startTime);
    } catch (error) {
      const logger = this.loggerInstance;
      logger.warn(`[CTRL_PROXY] Frame validation failed: ${errorMessage(error)}`, error);
      if (requestId) {
        this.requestManager.reject(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return {
        success: false,
        totalTimeMs: this.timer.now() - startTime,
        error: error instanceof Error ? error.toString() : errorMessage(error),
      };
    }
  }

  /**
   * Await a pending CtrlProxy request, but early-resolve it with a cancellation
   * failure the moment `signal` aborts, so a cancelled caller (e.g. session
   * teardown) frees the keyed device operation immediately instead of blocking
   * until the request's timeout fires. `resolveError` no-ops if the response
   * already landed, and the listener is always removed once the promise settles.
   */
  private async awaitCancellableRequest<
    T extends { success: boolean; totalTimeMs: number; error?: string },
  >(
    requestId: string,
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    startTime: number,
  ): Promise<T> {
    if (!signal) {
      return promise;
    }
    const onAbort = (): void => {
      this.requestManager.resolveError(
        requestId,
        OPERATION_CANCELLED_MESSAGE,
        this.timer.now() - startTime,
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    try {
      return await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Request device metadata from the accessibility service.
   */
  async requestDeviceInfo(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<{
    success: boolean;
    screenWidth?: number;
    screenHeight?: number;
    density?: number;
    rotation?: number;
    sdkInt?: number;
    deviceModel?: string;
    isEmulator?: boolean;
    wakefulness?: string;
    foregroundActivity?: string;
    totalTimeMs: number;
    error?: string;
  }> {
    const startTime = this.timer.now();
    let requestId: string | undefined;
    try {
      const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
      if (!connected) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      requestId = this.requestManager.generateId("device_info");
      const promise = this.requestManager.register<any>(
        requestId,
        "device_info",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: `Device info timeout after ${timeout}ms`,
        }),
      );

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      this.ws.send(serializeCtrlProxyRequest(ctrlProxyRequests.requestDeviceInfo({ requestId })));
      logger.debug(`[CTRL_PROXY] Sent device info request (requestId: ${requestId})`);

      return await promise;
    } catch (error) {
      const logger = this.loggerInstance;
      logger.warn(`[CTRL_PROXY] Device info failed: ${errorMessage(error)}`, error);
      if (requestId) {
        this.requestManager.reject(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      return {
        success: false,
        totalTimeMs: this.timer.now() - startTime,
        error: error instanceof Error ? error.toString() : errorMessage(error),
      };
    }
  }

  /**
   * Establish the connection a screenshot request needs, gated on the caller's
   * cancellation on both sides of the (potentially multi-second) reconnect.
   *
   * @returns the result to return instead of capturing - a connection failure or
   *   the caller's cancellation - or undefined when dispatch should proceed.
   */
  private async connectForScreenshot(
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult | undefined> {
    if (signal?.aborted) {
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
    if (!connected) {
      logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for screenshot");
      return { success: false, error: "Failed to connect to accessibility service" };
    }

    if (signal?.aborted) {
      // Connecting (and reconnecting) can take seconds, so the caller may well
      // have given up by the time we get here. Dispatching anyway would consume
      // the shared a11y screenshot rate limit and push a late frame onto the
      // observation stream for a capture nobody is waiting on (#6605).
      logger.debug("[CTRL_PROXY] Screenshot cancelled before dispatch");
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    return undefined;
  }

  /**
   * Put a registered screenshot request on the wire, unless the caller cancelled
   * while the connection was being established (#6605). A cancelled request is
   * settled locally instead: it must not consume the shared accessibility
   * screenshot rate limit, nor publish a late observation-stream frame.
   */
  private async dispatchScreenshotRequest(
    sentRequestId: string,
    signal?: AbortSignal,
    displayId?: number,
  ): Promise<void> {
    if (signal?.aborted) {
      // Settle the registration we just made so it neither waits out its
      // timeout nor accepts a late response.
      this.requestManager.resolveError(sentRequestId, OPERATION_CANCELLED_MESSAGE);
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const message = serializeCtrlProxyRequest(
      ctrlProxyRequests.requestScreenshot({ requestId: sentRequestId, displayId }),
    );
    // Shared rate-limit floor accounting (issue #4927): a one-shot screenshot (observe /
    // junit-runner) and the observation-stream scheduler both hit the same rate-limited
    // accessibility takeScreenshot(). Advancing the shared clock here (non-blocking) makes the
    // stream scheduler coalesce around a one-shot instead of the two engines rate-limiting each
    // other while a live viewer is attached. requestScreenshot always issues a real a11y capture
    // (it has no ADB path), so the stamp is unconditionally correct.
    this.getScreenshotBackoffScheduler().noteCaptureStarted();
    this.ws.send(message);
    logger.debug(`[CTRL_PROXY] Sent screenshot request (requestId: ${sentRequestId})`);
  }

  private registerPostDispatchAbort(
    sentRequestId: string,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) {
      return () => {};
    }

    const cancelAfterDispatch = () => {
      if (this.requestManager.resolveError(sentRequestId, OPERATION_CANCELLED_MESSAGE)) {
        this.lateCancelledScreenshotRequestIds.add(sentRequestId);
        logger.debug(
          `[CTRL_PROXY] Screenshot cancelled after dispatch (requestId: ${sentRequestId})`,
        );
      }
    };
    signal.addEventListener("abort", cancelAfterDispatch, { once: true });
    if (signal.aborted) {
      cancelAfterDispatch();
    }
    return () => signal.removeEventListener("abort", cancelAfterDispatch);
  }

  private logScreenshotResult(result: ScreenshotResult, duration: number): void {
    if (result.success) {
      const dataSize = result.data ? result.data.length : 0;
      logger.debug(`[CTRL_PROXY] Screenshot received in ${duration}ms (${dataSize} base64 chars)`);
    } else {
      logger.warn(`[CTRL_PROXY] Screenshot failed after ${duration}ms: ${result.error}`);
    }
  }

  async requestScreenshot(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    suppressObservationStreamPush: boolean = false,
    signal?: AbortSignal,
    displayId?: number,
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();
    let suppressedRequestId: string | undefined;
    let requestId: string | undefined;
    let removeAbortListener: (() => void) | undefined;

    try {
      const blocked = await this.connectForScreenshot(perf, signal);
      if (blocked) {
        return blocked;
      }

      requestId = this.requestManager.generateId("screenshot");
      if (suppressObservationStreamPush) {
        this.screenshotObservationStreamSuppressions.add(requestId);
        suppressedRequestId = requestId;
      } else {
        // Bind the capture identity that is current NOW, before the request goes out.
        const binding = this.screenGeometry.bind();
        if (binding) {
          this.screenshotCaptureBindings.set(requestId, binding);
        }
      }

      const sentRequestId = requestId;
      const screenshotPromise = this.requestManager.register<ScreenshotResult>(
        sentRequestId,
        "screenshot",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          error: `Screenshot timeout after ${timeout}ms`,
        }),
      );

      await perf.track("sendRequest", () =>
        this.dispatchScreenshotRequest(sentRequestId, signal, displayId),
      );

      removeAbortListener = this.registerPostDispatchAbort(sentRequestId, signal);

      const result = await perf.track("waitForScreenshot", () => screenshotPromise);
      const duration = this.timer.now() - startTime;

      this.logScreenshotResult(result, duration);

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Screenshot request failed after ${duration}ms: ${error}`);
      return { success: false, error: `${error}` };
    } finally {
      removeAbortListener?.();
      // Clean up the suppression token in case the response never arrived
      // (timeout/error). The message handler deletes it on a normal response;
      // this guards against leaking ids for in-flight requests that never resolve.
      if (suppressedRequestId !== undefined) {
        this.screenshotObservationStreamSuppressions.delete(suppressedRequestId);
      }
      // Drop the binding for a request that never resolved, so the map cannot grow without bound.
      if (requestId !== undefined) {
        this.screenshotCaptureBindings.delete(requestId);
      }
    }
  }

  async requestScreenshotWithoutObservationStreamPush(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<ScreenshotResult> {
    return this.requestScreenshot(timeoutMs, perf, true);
  }

  async verifyServiceReady(
    maxAttempts: number = 5,
    delayMs: number = 500,
    timeoutMs: number = 3000,
  ): Promise<boolean> {
    const signal = combineWithAmbientAbort();
    signal?.throwIfAborted();
    // Remember the most recent runner error text across attempts (issue #3062) so the terminal
    // warn — the one visible at the default log level — attributes the deterministic handler
    // failure, rather than collapsing every attempt into an anonymous "no hierarchy" (a runner
    // error and a plain timeout previously both surfaced identically here).
    let lastRunnerError: string | undefined;
    // Consecutive attempts that failed with byte-identical correlated runner error text
    // (issue #3097). A handler failure that reproduces verbatim after a retry delay is treated
    // as deterministic — the service will not become ready by retrying — so the loop stops
    // instead of burning the remaining attempts. Two safety valves protect the startup path
    // this method exists to verify (where a handler error CAN be transient during bring-up):
    // the first runner error always gets one retry, and a plain timeout in between resets the
    // streak (mixed signals are not evidence of determinism). Classifying specific runner
    // messages (allow/deny lists, structured codes) is deliberately avoided here: codes belong
    // in the runner's wire contract, and TS string-matching individual messages would be
    // fragile against runner text changes.
    let identicalRunnerErrorStreak = 0;
    let shortCircuited = false;
    const result = await this.retryExecutor.execute(
      async (attempt) => {
        logger.debug(`[CTRL_PROXY] Verifying service ready (attempt ${attempt}/${maxAttempts})`);

        const diagnostics: HierarchySyncDiagnostics = {};
        const hierarchyResult = await this.requestHierarchySync(
          new NoOpPerformanceTracker(),
          false,
          signal,
          timeoutMs,
          diagnostics,
        );

        if (hierarchyResult && hierarchyResult.hierarchy) {
          logger.debug(`[CTRL_PROXY] Service verified ready after ${attempt} attempt(s)`);
          return true;
        }

        if (diagnostics.runnerError) {
          identicalRunnerErrorStreak =
            diagnostics.runnerError === lastRunnerError ? identicalRunnerErrorStreak + 1 : 1;
          lastRunnerError = diagnostics.runnerError;
        } else {
          // A plain timeout breaks the deterministic-failure streak but keeps lastRunnerError,
          // so the terminal warn still attributes the most recent runner error.
          identicalRunnerErrorStreak = 0;
        }
        const runnerErrorSuffix = diagnostics.runnerError
          ? `: runner error: ${diagnostics.runnerError}`
          : "";
        throw new Error(
          `Verification attempt ${attempt} returned no hierarchy${runnerErrorSuffix}`,
        );
      },
      {
        maxAttempts,
        delays: delayMs,
        signal,
        shouldRetry: () => {
          if (identicalRunnerErrorStreak >= VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT) {
            shortCircuited = true;
            return false;
          }
          return true;
        },
        onRetry: (error, attempt) => {
          logger.debug(`[CTRL_PROXY] Verification attempt ${attempt} failed: ${error.message}`);
          logger.debug(`[CTRL_PROXY] Waiting ${delayMs}ms before next verification attempt`);
        },
      },
    );

    signal?.throwIfAborted();

    if (!result.success) {
      const runnerErrorSuffix = lastRunnerError ? ` (last runner error: ${lastRunnerError})` : "";
      const attemptsSummary = shortCircuited
        ? `${result.attempts}/${maxAttempts} verification attempts (short-circuited: identical runner error on ${VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT} consecutive attempts)`
        : `${maxAttempts} verification attempts`;
      this.loggerInstance.warn(
        `[CTRL_PROXY] Service not ready after ${attemptsSummary}${runnerErrorSuffix}`,
      );
      return false;
    }

    return result.value ?? false;
  }

  // ===========================================================================
  // Event Listeners
  // ===========================================================================

  onInteraction(listener: (event: InteractionEvent) => void): () => void {
    this.interactionListeners.add(listener);
    return () => {
      this.interactionListeners.delete(listener);
    };
  }

  /** Send start_recording for wire compatibility; currently has no effect on the device. */
  notifyRecordingStarted(): void {
    this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.startRecording()));
  }

  /** Send stop_recording for wire compatibility; currently has no effect on the device. */
  notifyRecordingStopped(): void {
    this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.stopRecording()));
  }

  // ===========================================================================
  // Hierarchy Navigation Detector
  // ===========================================================================

  getHierarchyNavigationDetector(): HierarchyNavigationDetector {
    if (!this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector = new HierarchyNavigationDetector(
        this.getNavigationGraphManager(),
        { timer: this.timer },
      );

      this.hierarchyNavigationDetector.setNavigationCallback((info) => {
        if (info.packageName && info.screenFingerprint) {
          if (!serverConfig.isNavigationScreenshotsEnabled()) {
            return;
          }
          const appId = info.packageName;
          const screenName = `screen_${info.screenFingerprint.substring(0, 12)}`;
          NavigationScreenshotManager.getInstance()
            .captureAndStore(this.device, this.adb, appId, screenName)
            .then((screenshotPath) => {
              if (screenshotPath) {
                this.getNavigationGraphManager()
                  .updateNodeScreenshot(appId, screenName, screenshotPath)
                  .catch((err) =>
                    logger.warn(`[CTRL_PROXY] Failed to update hierarchy screenshot: ${err}`),
                  );
              }
            })
            .catch((err) =>
              logger.debug(`[CTRL_PROXY] Hierarchy screenshot capture skipped: ${err}`),
            );
        }
      });
    }
    return this.hierarchyNavigationDetector;
  }

  resetHierarchyNavigationDetector(): void {
    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.reset();
    }
  }

  // ===========================================================================
  // Screenshot Backoff
  // ===========================================================================

  cancelScreenshotBackoff(): void {
    if (this.screenshotBackoffScheduler) {
      // Fully quiesce (including the trailing throttle capture) — this is a teardown/quiesce path
      // (disconnect, pre-action), not a sequence restart, so nothing should survive (issue #4927).
      this.screenshotBackoffScheduler.stop();
    }
  }

  refreshObservationStreamScreenshotCadence(): void {
    this.screenshotBackoffScheduler?.rescheduleKeepAlive();
  }

  refreshObservationStreamHierarchyCadence(intervalMs?: number | null): void {
    if (!this.isCommandSupported("set_hierarchy_interval")) {
      logger.info(
        "[AndroidCtrlProxyClient] Skipping hierarchy cadence sync; runner does not advertise set_hierarchy_interval",
      );
      return;
    }

    const resolvedIntervalMs =
      intervalMs === undefined
        ? (getDeviceDataStreamServer()?.getHierarchyIntervalMsForDevice(
            this.device.deviceId,
            AndroidCtrlProxyClient.DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS,
          ) ?? AndroidCtrlProxyClient.DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS)
        : intervalMs;

    this.sendMessage(
      serializeCtrlProxyRequest(
        ctrlProxyRequests.setHierarchyInterval({
          intervalMs: resolvedIntervalMs,
        }),
      ),
    );
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  async close(): Promise<void> {
    // Latch closed BEFORE super.close(): super.close() rejects the in-flight
    // CtrlProxy screenshot request (requestManager.cancelAll), whose catch falls
    // through to captureScreenshotViaAdb("ctrlproxy_exception"). Setting the flag
    // first makes that leaked one-shot fallback short-circuit (#5493).
    this.closed = true;
    this.clearHierarchyObservationStreamSuppressions();
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
    this.failPendingRecoveryStability("Client closed before stable reconnect");
    try {
      // Stop work profile monitor if running
      this.stopWorkProfileMonitor();

      await super.close();
      await this.drainInFlightMessageHandlers();

      if (this.portForwardingSetup) {
        // Do not claim the forward is gone when adb could not confirm its removal:
        // the next client's reconciliation pass must still be able to reclaim it.
        this.portForwardingSetup = !(await this.removeCtrlProxyPortForward(this.localPort));
      }

      if (this.ownsPortAllocation) {
        PortManager.releaseIfAllocated(this.portAllocationId, this.localPort);
      }
      await this.finishInvalidatedConnectionCleanup();
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error during cleanup: ${error}`);
    } finally {
      this.lateCancelledScreenshotRequestIds.clear();
      this.releaseCtrlProxyForwardLeaseAfterConnectionSettles();
      AndroidCtrlProxyClient.activeObservers.delete(this);
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async drainInFlightMessageHandlers(): Promise<void> {
    if (this.inFlightMessageHandlers.size === 0) {
      return;
    }
    const drainTimeout = Symbol("inbound handler drain timeout");
    try {
      await raceWithDeadline(Promise.allSettled([...this.inFlightMessageHandlers]), {
        timer: this.timer,
        timeoutMs: AndroidCtrlProxyClient.INBOUND_HANDLER_DRAIN_TIMEOUT_MS,
        label: "Inbound handler drain",
        timeoutError: () => drainTimeout,
      });
    } catch (error) {
      if (error !== drainTimeout) {
        throw toActionableError(error, "Failed to drain Android CtrlProxy inbound handlers");
      }
      logger.warn(
        `[CTRL_PROXY] Inbound handler drain timed out after ${AndroidCtrlProxyClient.INBOUND_HANDLER_DRAIN_TIMEOUT_MS}ms; continuing cleanup`,
      );
    }
  }

  private async ensureLocalPortAvailableForForwarding(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      return;
    }
    const currentAllocation = PortManager.getPort(this.portAllocationId);
    let currentPortIsAvailable = PortManager.isPortAvailable(this.localPort);
    if (currentAllocation === this.localPort) {
      const backoff = fixedBackoff(50);
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (currentPortIsAvailable) {
          return;
        }
        if (this.closed) {
          return;
        }
        throwIfAborted(signal);
        // adb tears down its listener asynchronously after --remove; this short busy window is expected and bounded.
        logger.debug(
          `[CTRL_PROXY] Local port ${this.localPort} busy after forward removal; retrying probe (${attempt}/3)`,
        );
        await awaitWhileRequestIsLive(this.timer.sleep(backoff.delayForAttempt(attempt)), signal);
        if (this.closed) {
          return;
        }
        throwIfAborted(signal);
        currentPortIsAvailable = PortManager.isPortAvailable(this.localPort);
      }
    }
    if (currentAllocation === this.localPort && currentPortIsAvailable) {
      return;
    }

    const additionalReservedPorts = currentPortIsAvailable ? [] : [this.localPort];
    PortManager.release(this.portAllocationId);
    const nextPort = PortManager.allocate(this.portAllocationId, {
      reservedPorts: [...IOS_CTRL_PROXY_RESERVED_PORTS, ...additionalReservedPorts],
    });
    if (nextPort !== this.localPort) {
      logger.info(
        `[CTRL_PROXY] Reallocated local port from ${this.localPort} to ${nextPort} before adb forward`,
      );
      this.localPort = nextPort;
    }
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  async setupPortForwarding(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    if (!this.ctrlProxyForwardLease.tryAcquire()) {
      throwCtrlProxyForwardingLeaseConflict(
        this.device.deviceId,
        this.ctrlProxyForwardLease.getLastOwnerPid(),
      );
    }
    // Verify port forwarding is still active even if we think it's set up
    // Port forwarding can be lost if ADB server restarts or emulator restarts
    if (this.portForwardingSetup) {
      const isActive = await this.isPortForwardingActive(signal);
      if (isActive) {
        logger.debug(`[CTRL_PROXY] Port forwarding already active (localhost:${this.localPort})`);
        return;
      }
      logger.debug(`[CTRL_PROXY] Port forwarding was lost, re-establishing...`);
      this.portForwardingSetup = false;
    }

    try {
      await this.sweepOrphanedCtrlProxyPortForwards(signal);

      const previousLocalPort = this.localPort;
      const clearedCurrentPort = await perf.track(
        "clearPortForward",
        async () => await this.removeCtrlProxyPortForward(this.localPort, signal),
      );
      if (!clearedCurrentPort) {
        throw new Error(`Failed to remove existing CtrlProxy forward on tcp:${this.localPort}`);
      }
      await this.ensureLocalPortAvailableForForwarding(signal);
      if (this.closed) {
        return;
      }
      logger.debug(
        `[CTRL_PROXY] Setting up port forwarding for WebSocket: localhost:${this.localPort} → device:${PortManager.DEVICE_PORT} (device: ${this.device.deviceId})`,
      );

      if (this.localPort !== previousLocalPort) {
        const clearedReallocatedPort = await perf.track(
          "clearReallocatedPortForward",
          async () => await this.removeCtrlProxyPortForward(this.localPort, signal),
        );
        if (!clearedReallocatedPort) {
          throw new Error(`Failed to remove existing CtrlProxy forward on tcp:${this.localPort}`);
        }
      }

      await perf.track("setupPortForward", () =>
        this.adb.execute(["forward", `tcp:${this.localPort}`, `tcp:${PortManager.DEVICE_PORT}`], {
          signal,
        }),
      );

      if (this.closed) {
        await this.removeCtrlProxyPortForward(this.localPort);
        return;
      }

      this.portForwardingSetup = true;
      logger.debug(`[CTRL_PROXY] Port forwarding setup complete (localhost:${this.localPort})`);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to setup port forwarding: ${error}`);
      throw error;
    }
  }

  /**
   * Remove stale local forwards for this device that target CtrlProxy's fixed
   * device port. A daemon crash drops the in-memory singleton registry but
   * leaves ADB's forwards alive; the next client setup is their recovery path.
   *
   * A newly-created singleton is registered before it can start connecting, so
   * its allocated port is treated as live even before port forwarding completes.
   */
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  async sweepOrphanedCtrlProxyPortForwards(signal?: AbortSignal): Promise<void> {
    let stdout: string;
    try {
      const result = await this.adb.execute(["forward", "--list"], { signal });
      stdout = result.stdout;
    } catch (error) {
      logger.warn(
        `[CTRL_PROXY] Failed to list forwards while reconciling device ${this.device.deviceId}: ${error}`,
        error,
      );
      throw error;
    }

    const livePorts = new Set(
      [...AndroidCtrlProxyClient.instances.values(), ...AndroidCtrlProxyClient.activeObservers]
        .filter((client) => client.device.deviceId === this.device.deviceId && !client.closed)
        .map((client) => client.localPort),
    );
    const orphanedPorts = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      const forward = this.parseOwnPortForward(line);
      if (!forward || forward.remote !== `tcp:${PortManager.DEVICE_PORT}`) {
        continue;
      }
      const port = this.localPortFromForward(forward.local);
      if (port !== null && !livePorts.has(port)) {
        orphanedPorts.add(port);
      }
    }

    for (const port of orphanedPorts) {
      logger.info(
        `[CTRL_PROXY] Reclaiming orphaned CtrlProxy forward on ${this.device.deviceId} tcp:${port}`,
      );
      if (!(await this.removeCtrlProxyPortForward(port, signal))) {
        throw new Error(
          `Failed to reclaim orphaned CtrlProxy forward on ${this.device.deviceId} tcp:${port}`,
        );
      }
    }
  }

  /**
   * Remove a forward only when it still maps this device and host port to the
   * CtrlProxy device port. Re-listing closes the race with a different service
   * reusing the host port after the orphan sweep discovered it.
   *
   * @returns `true` when no matching forward remains; `false` when adb failed
   * to establish that state.
   */
  private async removeCtrlProxyPortForward(port: number, signal?: AbortSignal): Promise<boolean> {
    try {
      const expectedLocal = `tcp:${port}`;
      if (!(await this.hasCtrlProxyPortForward(port, signal))) {
        PortManager.clearQuarantine(port);
        return true;
      }

      await this.adb.execute(["forward", "--remove", expectedLocal], { signal });
      const startedAt = this.timer.now();
      const confirmationDeadlineMs = 2_000;
      const backoff = exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 800 });
      for (let attempt = 1; ; attempt++) {
        if (!(await this.hasCtrlProxyPortForward(port, signal))) {
          PortManager.clearQuarantine(port);
          return true;
        }
        const remainingMs = confirmationDeadlineMs - (this.timer.now() - startedAt);
        if (remainingMs <= 0) {
          break;
        }
        await this.timer.sleep(Math.min(backoff.delayForAttempt(attempt), remainingMs));
      }
      logger.warn(
        `[CTRL_PROXY] CtrlProxy forward on ${this.device.deviceId} tcp:${port} remained after removal confirmation`,
      );
      PortManager.quarantine(port);
      return false;
    } catch (error) {
      logger.warn(
        `[CTRL_PROXY] Failed to remove CtrlProxy forward on ${this.device.deviceId} tcp:${port}: ${error}`,
        error,
      );
      return false;
    }
  }

  private async hasCtrlProxyPortForward(port: number, signal?: AbortSignal): Promise<boolean> {
    const result = await this.adb.execute(["forward", "--list"], { signal });
    const expectedLocal = `tcp:${port}`;
    const expectedRemote = `tcp:${PortManager.DEVICE_PORT}`;
    return result.stdout.split(/\r?\n/).some((line) => {
      const forward = this.parseOwnPortForward(line);
      return forward?.local === expectedLocal && forward.remote === expectedRemote;
    });
  }

  private parseOwnPortForward(line: string): { local: string; remote: string } | null {
    const [serial, local, remote, ...extra] = line.trim().split(/\s+/);
    if (serial !== this.device.deviceId) {
      return null;
    }
    if (extra.length !== 0) {
      // Ignore ambiguous rows so cleanup cannot remove an unrelated service's forward.
      logger.debug(
        `[CTRL_PROXY] Skipping adb forward row with extra columns for ${serial}: ${line.trim()}`,
      );
      return null;
    }
    return local && remote ? { local, remote } : null;
  }

  private localPortFromForward(value: string | undefined): number | null {
    if (value === undefined || !value.startsWith("tcp:")) {
      return null;
    }
    const port = Number.parseInt(value.slice("tcp:".length), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  }

  private async finishInvalidatedConnectionCleanup(): Promise<void> {
    if (this.inFlightConnection !== null || this.cleanupHeldPort === null) {
      return;
    }
    const heldPort = this.cleanupHeldPort;
    this.cleanupHeldPort = null;
    PortManager.releaseIfAllocated(this.portAllocationId, this.localPort);
    PortManager.releaseCleanupHold(heldPort);
  }

  /**
   * ADB commands may ignore cancellation. Keep the cross-process ownership
   * lease until an in-flight connection (including its forward setup) settles,
   * so its late cleanup cannot remove a replacement process's forward.
   */
  private releaseCtrlProxyForwardLeaseAfterConnectionSettles(): void {
    if (this.ctrlProxyForwardLeaseReleaseScheduled) {
      return;
    }
    this.ctrlProxyForwardLeaseReleaseScheduled = true;

    const releaseLease = (): void => this.ctrlProxyForwardLease.release();
    const inFlightConnection = this.inFlightConnection;
    if (inFlightConnection === null) {
      releaseLease();
      return;
    }
    void inFlightConnection.then(releaseLease, releaseLease);
  }

  /**
   * Check if port forwarding is still active by querying adb forward --list
   */
  private async isPortForwardingActive(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.adb.execute(["forward", "--list"], { signal });
      // Format is exactly: "serial tcp:localPort tcp:remotePort". Requiring
      // the serial prevents another device's same-number forward from being
      // mistaken for this client's forward.
      const isActive = result.stdout.split(/\r?\n/).some((line) => {
        const forward = this.parseOwnPortForward(line);
        return (
          forward?.local === `tcp:${this.localPort}` &&
          forward.remote === `tcp:${PortManager.DEVICE_PORT}`
        );
      });
      if (!isActive) {
        logger.debug(
          `[CTRL_PROXY] Port forwarding not found for ${this.device.deviceId} on tcp:${this.localPort}`,
        );
      }
      return isActive;
    } catch (error) {
      logger.debug(`[CTRL_PROXY] Failed to check port forwarding status: ${error}`);
      return false;
    }
  }

  /** Resolve request responses only when the runner supplies a truthy request ID. */
  private resolvePendingResponse<Message extends { requestId?: string }, Payload>(
    message: Message,
    buildPayload: (message: Message) => Payload,
  ): void {
    if (message.requestId) {
      this.requestManager.resolve<Payload>(message.requestId, buildPayload(message));
    }
  }

  /** SDK event frames include custom_event, which is intentionally outside WebSocketMessage. */
  private async recordSdkTelemetryEvent(message: {
    type: string;
    timestamp?: number;
    event?: Record<string, unknown>;
  }): Promise<void> {
    const event = message.event;
    if (event) {
      await this.getSdkEventIngestor().recordSdkEvent(
        {
          type: message.type,
          timestamp: message.timestamp ?? this.timer.now(),
          payload: { event },
        },
        (event.applicationId as string) ?? null,
      );
    }
  }

  private readonly webSocketMessageHandlers = {
    connected: (message) => {
      if (this.transientObserver) {
        return;
      }
      this.rejectedCommands.clear();
      this.supportedCommands = Array.isArray(message.supportedCommands)
        ? new Set(message.supportedCommands)
        : null;
      if (this.supportedCommands?.has(ANDROID_REQUEST_ID_ECHO_CAPABILITY)) {
        this.hierarchy.markRequestIdEchoAdvertised();
      }
      logger.debug(`[CTRL_PROXY] Received connection confirmation`);
      this.refreshObservationStreamHierarchyCadence();
    },

    error: (message) => {
      const rejectedCommand = /^Unknown command type: (.+)$/.exec(message.error ?? "")?.[1];
      if (rejectedCommand) {
        this.rejectedCommands.add(rejectedCommand);
      }
      const deviceError = message.error || "Runner reported an unstructured protocol error";
      // Preserve capability refusals used by fallback callers, including focused-input clicks.
      const errorText =
        rejectedCommand &&
        [
          "request_click_focused_input",
          "show_overlay",
          "update_overlay",
          "dismiss_overlay",
          "put_overlay_asset",
          "remove_overlay_asset",
        ].includes(rejectedCommand)
          ? deviceError
          : rewriteUnknownCommandError(deviceError, "android");
      logger.warn(
        `[CTRL_PROXY] Runner error (requestId: ${message.requestId ?? "none"}): ${errorText}`,
      );
      this.settleUnattributedFocusedClickRejection(message.requestId, rejectedCommand, errorText);
      if (message.requestId) {
        this.lateCancelledScreenshotRequestIds.delete(message.requestId);
        this.requestManager.resolveError(message.requestId, errorText);
        this._hierarchy?.rejectPendingHierarchy(message.requestId, errorText);
      }
    },

    hierarchy_update: (message) => {
      if (message.data) {
        this.handleHierarchyUpdate(
          message.data,
          message.perfTiming,
          message.frameContext,
          message.requestId,
        );
      }
    },

    display_transition: (message) => {
      const event = displayTransitionFromWire(message);
      if (event) {
        displayTransitions.notifyAndroidTransition(this.device.deviceId, event);
        this.onDisplayTransition?.(event);
      }
    },

    screenshot: (message) => {
      if (message.requestId) {
        const cancelledAfterDispatch = this.lateCancelledScreenshotRequestIds.delete(
          message.requestId,
        );
        const suppressObservationStreamPush = this.screenshotObservationStreamSuppressions.delete(
          message.requestId,
        );
        const metadata = {
          ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, message.format),
          ...screenshotPerformanceMetadataFrom(message),
        };
        const binding = this.screenshotCaptureBindings.get(message.requestId);
        this.screenshotCaptureBindings.delete(message.requestId);
        if (cancelledAfterDispatch) {
          logger.debug(
            `[CTRL_PROXY] Discarded screenshot response for cancelled request (requestId: ${message.requestId})`,
          );
        } else if (!suppressObservationStreamPush) {
          this.pushScreenshotToObservationStream(
            message.data,
            metadata,
            binding,
            message.frameContext,
            message.rotation,
          );
        } else {
          logger.debug(
            "[CTRL_PROXY] Suppressed screenshot observation stream push for explicit initial-frame request",
          );
        }
        this.requestManager.resolve<ScreenshotResult>(message.requestId, {
          success: true,
          data: message.data,
          format: message.format || "jpeg",
          timestamp: message.timestamp,
          frameContext: message.frameContext,
          rotation: message.rotation,
          displayId: message.displayId,
          panelUniqueId: message.panelUniqueId,
          ...screenshotPerformanceMetadataFrom(message),
        });
      }
    },

    screenshot_error: (message) => {
      if (message.requestId) {
        this.lateCancelledScreenshotRequestIds.delete(message.requestId);
        logger.warn(
          `[CTRL_PROXY] Screenshot error (requestId: ${message.requestId}): ${message.error}`,
        );
        this.requestManager.resolve<ScreenshotResult>(message.requestId, {
          success: false,
          error: message.error || "Unknown error",
          displayId: message.displayId,
          panelUniqueId: message.panelUniqueId,
        });
      }
    },

    swipe_result: (message) => {
      logger.debug(
        `[CTRL_PROXY] Swipe result (requestId: ${message.requestId}, success: ${message.success})`,
      );

      if (message.requestId) {
        this.requestManager.resolve<A11ySwipeResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          gestureTimeMs: message.gestureTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }
    },

    tap_coordinates_result: (message) => {
      logger.info(
        `[CTRL_PROXY] Tap coordinates result (requestId: ${message.requestId}, success: ${message.success})`,
      );

      if (message.requestId) {
        this.requestManager.resolve<A11yTapCoordinatesResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
          acknowledged: true,
        });
      }
    },

    drag_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yDragResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        gestureTimeMs: message.gestureTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    pinch_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yPinchResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        gestureTimeMs: message.gestureTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    set_text_result: (message) =>
      this.resolvePendingResponse(message, (message): A11ySetTextResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    commit_text_result: (message) =>
      this.resolvePendingResponse(message, (message): ImeCommitActionResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        partialApplication: message.partialApplication,
        ...imeCommitUnitFields(message),
        perfTiming: message.perfTiming,
      })),

    cancel_ime_commit_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success,
        targetRequestId: message.targetRequestId,
        partialApplication: message.partialApplication,
        ...imeCommitUnitFields(message),
        error: message.error,
      })),

    set_keyboard_profile_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success,
        activeProfileId: message.activeProfileId,
        previousProfileId: message.previousProfileId,
        error: message.error,
      })),

    keyboard_profiles_result: (message) =>
      this.resolvePendingResponse(message, (message): KeyboardProfileCatalog => ({
        success: message.success,
        catalogId: message.catalogId,
        catalogVersion: message.catalogVersion,
        supportedCatalogVersions: message.supportedCatalogVersions,
        activeProfileId: message.activeProfileId,
        profiles: message.profiles,
        error: message.error,
      })),

    insert_text_state_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success,
        state: message.state,
      })),

    insert_text_result: (message) =>
      this.resolvePendingResponse(message, (message): A11ySetTextResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        partialApplication: message.partialApplication,
        warning: message.warning,
        caretPlaced: message.caretPlaced,
        resultingTextLength: message.resultingTextLength,
        perfTiming: message.perfTiming,
      })),

    ime_action_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yImeActionResult => ({
        success: message.success,
        action: message.action,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    select_all_result: (message) =>
      this.resolvePendingResponse(message, (message): A11ySelectAllResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    action_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yActionResult => ({
        success: message.success,
        action: message.action,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    clipboard_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yClipboardResult => ({
        success: message.success,
        action: message.action,
        text: message.text,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    settings_get_result: (message) =>
      this.resolvePendingResponse(message, (message): A11ySettingsGetResult => ({
        success: message.success,
        value: message.value,
        found: message.found ?? false,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    settings_put_result: (message) =>
      this.resolvePendingResponse(message, (message): A11ySettingsPutResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    settings_list_result: (message) =>
      this.resolvePendingResponse(message, (message): A11ySettingsListResult => ({
        success: message.success,
        entries: message.entries,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    installed_packages_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yInstalledPackagesResult => ({
        success: message.success ?? false,
        userId: message.userId ?? -1,
        packages: message.packages ?? [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    package_info_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yPackageInfoResult => ({
        success: message.success ?? false,
        packageName: message.packageName ?? "",
        isSystem: message.isSystem ?? false,
        applicationLabel: message.applicationLabel,
        versionName: message.versionName,
        versionCode: message.versionCode,
        installerPackage: message.installerPackage,
        firstInstallTime: message.firstInstallTime,
        lastUpdateTime: message.lastUpdateTime,
        allowBackup: message.allowBackup,
        requestedPermissions: message.requestedPermissions ?? [],
        grantedPermissions: message.grantedPermissions ?? {},
        mainActivity: message.mainActivity,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    launch_intent_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yLaunchIntentResult => ({
        success: message.success ?? false,
        packageName: message.packageName ?? "",
        componentName: message.componentName,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    ca_cert_result: (message) => {
      if (message.requestId) {
        // Try delegate handler first (for remove)
        if (
          !this.certificates.handleCaCertRemovalResult(message.requestId, {
            success: message.success,
            action: message.action,
            alias: message.alias,
            totalTimeMs: message.totalTimeMs,
            error: message.error,
            perfTiming: message.perfTiming,
          })
        ) {
          // Fall back to RequestManager (for install)
          this.requestManager.resolve<A11yCaCertResult>(message.requestId, {
            success: message.success,
            action: message.action,
            alias: message.alias,
            totalTimeMs: message.totalTimeMs,
            error: message.error,
            perfTiming: message.perfTiming,
          });
        }
      }
    },

    device_owner_status_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yDeviceOwnerStatusResult => ({
        success: message.success,
        isDeviceOwner: message.isDeviceOwner ?? false,
        isAdminActive: message.isAdminActive ?? false,
        packageName: message.packageName,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    permission_result: (message) =>
      this.resolvePendingResponse(message, (message): A11yPermissionResult => ({
        success: message.success ?? false,
        permission: message.permission ?? "unknown",
        granted: message.granted ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        requestLaunched: message.requestLaunched ?? false,
        canRequest: message.canRequest ?? false,
        requiresSettings: message.requiresSettings ?? false,
        instructions: message.instructions,
        adbCommand: message.adbCommand,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    current_focus_result: (message) =>
      this.resolvePendingResponse(message, (message): CurrentFocusResult => {
        const focusedElement = message.focusedElement
          ? this.focus.convertAccessibilityNodeToElement(message.focusedElement)
          : null;
        return {
          focusedElement,
          totalTimeMs: message.totalTimeMs,
          requestId: message.requestId,
          error: message.error,
        };
      }),

    traversal_order_result: (message) =>
      this.resolvePendingResponse(message, (message): TraversalOrderResult => {
        const result = message.result;
        if (result && result.elements) {
          const converted = result.elements.map((node: AccessibilityNode) =>
            this.focus.convertAccessibilityNodeToElement(node),
          );
          const elements = converted.filter((element) => element !== null);
          const dropped = converted.length - elements.length;
          if (dropped > 0) {
            logger.debug(`[CTRL_PROXY] Dropped ${dropped} traversal nodes that failed conversion`);
          }
          const focusedElement =
            result.focusedIndex === null ? null : converted[result.focusedIndex];
          return {
            elements,
            focusedIndex: focusedElement ? elements.indexOf(focusedElement) : null,
            totalCount: dropped > 0 ? elements.length : result.totalCount,
            truncationReasons: result.truncationReasons,
            totalTimeMs: message.totalTimeMs,
            requestId: message.requestId,
            error: message.error,
          };
        }
        return {
          elements: [],
          focusedIndex: null,
          totalCount: 0,
          totalTimeMs: message.totalTimeMs,
          requestId: message.requestId,
          error: message.error || "No result data",
        };
      }),

    overlay_result: (message) =>
      this.resolvePendingResponse(message, (message): OverlayResult => ({
        success: message.success,
        error: message.error,
        requestId: message.requestId,
        timestamp: message.timestamp,
        ...(Array.isArray(message.missingAssets) && message.missingAssets.length > 0
          ? { missingAssets: message.missingAssets.filter((id) => typeof id === "string") }
          : {}),
      })),

    highlight_response: (message) =>
      this.resolvePendingResponse(message, (message): HighlightOperationResult => ({
        success: message.success ?? false,
        error: message.error,
        requestId: message.requestId,
        timestamp: message.timestamp,
      })),

    global_action_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        action: message.action,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    frame_context_validation_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    device_info_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        screenWidth: message.screenWidth,
        screenHeight: message.screenHeight,
        density: message.density,
        rotation: message.rotation,
        sdkInt: message.sdkInt,
        deviceModel: message.deviceModel,
        isEmulator: message.isEmulator,
        wakefulness: message.wakefulness,
        foregroundActivity: message.foregroundActivity,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    keystore_discovery: (message) =>
      this.resolvePendingResponse(message, (message) => ({ state: message.state })),

    preference_files: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        files: message.files || [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    preferences: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        entries: message.entries || [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    subscribe_storage_result: (message) =>
      this.resolvePendingResponse(message, (message) => {
        // Android sends flat packageName/fileName/subscriptionId fields, not a nested `subscription`
        // object (like preference_files/preferences above). Rebuild the subscription from them so
        // the awaiting subscribeStorage() promise gets a usable StorageSubscription.
        const subscription =
          message.success && message.subscriptionId
            ? {
                packageName: message.packageName ?? "",
                fileName: message.fileName ?? "",
                subscriptionId: message.subscriptionId,
              }
            : undefined;
        return {
          success: message.success ?? false,
          subscription,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        };
      }),

    unsubscribe_storage_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    get_preference_result: (message) =>
      this.resolvePendingResponse(message, (message) => {
        // Build entry from key/value/type fields (Android sends flat structure, not nested entry)
        const entry =
          message.found && message.key
            ? {
                key: message.key,
                value: message.value,
                type: message.valueType ?? "UNKNOWN",
              }
            : undefined;
        return {
          success: message.success ?? false,
          found: message.found ?? false,
          entry,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        };
      }),

    set_preference_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    remove_preference_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    clear_preferences_result: (message) =>
      this.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    navigation_event: async (message) => {
      const event = message.event;
      if (event) {
        // The WebSocket protocol puts timestamp on the outer message, not inside event.
        // Ensure the event has a timestamp for the navigation graph manager.
        if (event.timestamp === undefined && message.timestamp !== undefined) {
          event.timestamp = message.timestamp;
        }
        if (event.applicationId) {
          this.sdkNavigationAppIds.add(event.applicationId);
          // Eagerly resolve build/device provenance for this app (#4984).
          // Non-blocking: later events pick up the resolved build key; this
          // event may still record under the default key.
          this.ensureBuildContext(event.applicationId);
        }
        this.attachRecentInteraction(event);

        logger.info(
          `[CTRL_PROXY] Navigation event: ${event.destination} (app: ${event.applicationId})`,
        );
        // Barrier-tracked via trackExisting so graceful shutdown drains this
        // fire-and-forget write, WITHOUT wrapping it in track(): the caller keeps
        // awaiting the original promise, so the nav-event↔hierarchy-update
        // interleaving that "preserve SDK screen names" depends on is unchanged
        // (issue #2885). If the write is still in flight when the drain window
        // closes, Part 1's dialect reject-on-closed drops the row cleanly
        // (issue #2792).
        const navWrite = this.enqueueNavigationGraphWrite(event);
        void getDbWriteBarrier().trackExisting(navWrite);
        await navWrite;
        if (this.closed) {
          // The graph write is best-effort; skipping its screenshot tail avoids released-device I/O.
          logger.debug("[CTRL_PROXY] Skipping navigation screenshot after close");
          return;
        }

        if (
          event.applicationId &&
          event.destination &&
          serverConfig.isNavigationScreenshotsEnabled()
        ) {
          await NavigationScreenshotManager.getInstance()
            .captureAndStore(this.device, this.adb, event.applicationId, event.destination)
            .then((screenshotPath) => {
              if (this.closed) {
                // The screenshot is optional; do not attach it to a session that has ended.
                logger.debug("[CTRL_PROXY] Skipping navigation screenshot update after close");
                return;
              }
              if (screenshotPath) {
                return this.getNavigationGraphManager()
                  .updateNodeScreenshot(event.applicationId!, event.destination!, screenshotPath)
                  .catch((err) => logger.warn(`[CTRL_PROXY] Failed to update screenshot: ${err}`));
              }
            })
            .catch((err) => {
              // Navigation screenshots are optional and never block navigation recording.
              logger.debug(`[CTRL_PROXY] Screenshot capture skipped: ${err}`);
            });
        }
      }
    },

    package_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.handlePackageEvent(event, message.timestamp);
      }
    },

    overlay_event: (message) => {
      this.overlays.handleOverlayEvent(message);
    },

    interaction_event: (message) => {
      const interaction = message.event;
      if (interaction) {
        const now = this.timer.now();
        this.pruneStaleInteractions(now);
        if (interaction.packageName) {
          this.lastInteractionByApp.delete(interaction.packageName);
          this.lastInteractionByApp.set(interaction.packageName, {
            type: interaction.type,
            elementText: interaction.element?.text ?? undefined,
            elementResourceId: interaction.element?.["resource-id"] ?? undefined,
            timestamp: interaction.timestamp,
            receivedAtMs: now,
          });
          while (this.lastInteractionByApp.size > AndroidCtrlProxyClient.MAX_CACHED_INTERACTIONS) {
            const oldestApplicationId = this.lastInteractionByApp.keys().next().value;
            this.lastInteractionByApp.delete(oldestApplicationId ?? "");
          }
        }
        this.notifyInteractionListeners(interaction);
      }
    },

    handled_exception_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.handleHandledExceptionEvent(event);
      }
    },

    crash_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.handleCrashEvent(
          withResolvedTimestamp(event, message.timestamp, this.timer.now()),
        );
      }
    },

    anr_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.handleAnrEvent(
          withResolvedTimestamp(event, message.timestamp, this.timer.now()),
        );
      }
    },

    frame_metrics_event: (message) => {
      if (message.frameMetrics) {
        this.handleFrameMetricsEvent(message.frameMetrics);
      }
    },

    storage_changed: (message) => {
      const normalizedValue = normalizeStorageWireValue(message.value, message.valueType);
      if (normalizedValue === undefined) {
        logger.warn(
          `[CTRL_PROXY] Ignoring unsafe legacy LONG storage value for ${message.packageName ?? "unknown"}/${message.fileName ?? "unknown"}`,
        );
        return;
      }
      const storageEvent: StorageChangedEvent = {
        packageName: message.packageName ?? "",
        fileName: message.fileName ?? "",
        key: message.key ?? null,
        // Non-string preference types arrive as bare JSON (number/boolean/array); re-encode
        // to the JSON string contract so the desktop storage_update frame decodes (#4709 review).
        value: normalizedValue,
        valueType: message.valueType ?? "STRING",
        timestamp: message.timestamp ?? this.timer.now(),
        sequenceNumber: message.sequenceNumber ?? 0,
      };
      logger.debug(
        `[CTRL_PROXY] Storage changed: ${storageEvent.packageName}/${storageEvent.fileName} key=${storageEvent.key}`,
      );

      this.storage.notifyStorageChangeListeners(storageEvent);

      const server = getDeviceDataStreamServer();
      if (server) {
        server.pushStorageUpdate(this.device.deviceId, storageEvent);
      }

      // Record to telemetry timeline (fan-out owned by the ingestor, #2764).
      const telemetryInput = storageTelemetryInputFromWire(message, storageEvent.timestamp);
      if (telemetryInput !== undefined) {
        this.getSdkEventIngestor().recordStorageEvent(telemetryInput);
      }
    },

    network_event: (message) => this.recordSdkTelemetryEvent(message),

    websocket_frame_event: (message) => this.recordSdkTelemetryEvent(message),

    log_event: (message) => this.recordSdkTelemetryEvent(message),

    broadcast_event: (message) => this.recordSdkTelemetryEvent(message),

    lifecycle_event: (message) => this.recordSdkTelemetryEvent(message),
  } satisfies WebSocketMessageHandlers;

  private pruneStaleInteractions(now: number): void {
    for (const [applicationId, interaction] of this.lastInteractionByApp) {
      if (
        now < interaction.receivedAtMs ||
        now - interaction.receivedAtMs > AndroidCtrlProxyClient.INTERACTION_NAVIGATION_WINDOW_MS
      ) {
        this.lastInteractionByApp.delete(applicationId);
      }
    }
  }

  private attachRecentInteraction(event: NavigationEvent): void {
    const hostNow = this.timer.now();
    this.pruneStaleInteractions(hostNow);
    const interaction = event.applicationId
      ? this.lastInteractionByApp.get(event.applicationId)
      : undefined;
    if (!interaction) {
      return;
    }
    const receivedAgeMs = hostNow - interaction.receivedAtMs;
    if (
      receivedAgeMs < 0 ||
      receivedAgeMs > AndroidCtrlProxyClient.INTERACTION_NAVIGATION_WINDOW_MS
    ) {
      return;
    }
    if (
      typeof event.timestamp === "number" &&
      typeof interaction.timestamp === "number" &&
      event.timestamp < interaction.timestamp
    ) {
      return;
    }
    event.triggeringInteraction = {
      type: interaction.type,
      elementText: interaction.elementText,
      elementResourceId: interaction.elementResourceId,
    };
  }

  private async handleWebSocketMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message = parseCtrlProxyJson<WebSocketMessage>(data.toString());
      const type = (message as { type: string }).type;
      if (this.transientObserver && !["connected", "hierarchy_update", "error"].includes(type)) {
        return;
      }
      if (
        this.supportedCommands?.has(ANDROID_REQUEST_ID_ECHO_CAPABILITY) &&
        ANDROID_REQUEST_ID_RESPONSE_TYPES.has(type) &&
        !("requestId" in message && message.requestId)
      ) {
        logger.warn(ctrlProxyMissingRequestIdError(type));
        return;
      }
      if (Object.hasOwn(this.webSocketMessageHandlers, type)) {
        // The mapped type checks each entry; this cast reconnects key and value after lookup.
        const handler = this.webSocketMessageHandlers[type as WebSocketMessage["type"]] as (
          message: WebSocketMessage,
        ) => void | Promise<void>;
        await handler(message);
      } else if (SDK_TELEMETRY_EVENT_TYPES.has(type)) {
        await this.recordSdkTelemetryEvent(
          message as { type: string; timestamp?: number; event?: Record<string, unknown> },
        );
      } else {
        logger.debug(`[CTRL_PROXY] Ignoring unknown WebSocket message type: ${type}`);
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error handling WebSocket message: ${error}`);
    }
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  handleHierarchyUpdate(
    data: AccessibilityHierarchy,
    perfTiming?: AndroidPerfTiming[],
    frameContext?: string,
    requestId?: string | null,
  ): void {
    const now = this.timer.now();
    logger.debug(
      `[CTRL_PROXY] Received hierarchy update (updatedAt: ${data.updatedAt}, receivedAt: ${now})`,
    );

    const incomingHierarchy: CachedHierarchy = {
      hierarchy: data,
      receivedAt: now,
      fresh: true,
      requestId,
      perfTiming,
      frameContext,
    };
    // A must-deliver correlated frame can leave the runner after a newer coalesced push.
    // Complete its own waiter, but do not regress the shared cache or observation stream.
    const observerResponse = !!requestId && this.observerHierarchyRequestIds.has(requestId);
    const isolatedObserverResponse =
      observerResponse && this.observerHierarchyRequestIds.get(requestId!) === true;
    this.hierarchy.resolvePendingHierarchy(requestId, incomingHierarchy);
    // Consume correlated responses even when too old for the shared cache or observer-only.
    let suppressObservationStreamPush =
      !!requestId && this.removeHierarchyObservationStreamSuppression(requestId);
    if (observerResponse) {
      this.observerHierarchyRequestIds.delete(requestId);
      if (
        this.transientObserver ||
        // Aggregate and explicit-panel observer frames cannot seed the owner's active frame.
        isolatedObserverResponse ||
        (this.cachedHierarchy !== null &&
          isDeepStrictEqual(
            {
              hierarchy: data.hierarchy,
              packageName: data.packageName,
              windows: data.windows,
              screenWidth: data.screenWidth,
              screenHeight: data.screenHeight,
              rotation: data.rotation,
              displayId: data.displayId,
            },
            {
              hierarchy: this.cachedHierarchy.hierarchy.hierarchy,
              packageName: this.cachedHierarchy.hierarchy.packageName,
              windows: this.cachedHierarchy.hierarchy.windows,
              screenWidth: this.cachedHierarchy.hierarchy.screenWidth,
              screenHeight: this.cachedHierarchy.hierarchy.screenHeight,
              rotation: this.cachedHierarchy.hierarchy.rotation,
              displayId: this.cachedHierarchy.hierarchy.displayId,
            },
          ))
      ) {
        return;
      }
    }
    if (this.transientObserver) {
      return;
    }
    if (this.cachedHierarchy && data.updatedAt < this.cachedHierarchy.hierarchy.updatedAt) {
      return;
    }

    // Mark previous cache as stale
    if (this.cachedHierarchy) {
      this.cachedHierarchy.fresh = false;
    }

    // Update cache with fresh data
    this.cachedHierarchy = incomingHierarchy;

    // Update cached screen dimensions
    this.updateCachedScreenDimensions(data);

    // Old APKs have no echo capability advertisement. Until the first correlated frame on a
    // fresh connection, an idless broadcast can still consume the oldest token (legacy behavior).
    // Once ANY echoed id is seen, idless/foreign frames never consume another request's token.
    // Keep legacy consumption after the cache/observer guards, exactly as the anonymous Set was.
    if (!requestId && !this.hierarchy.hasSeenCorrelatedFrames()) {
      const oldestId = this.hierarchyObservationStreamSuppressions.keys().next().value;
      suppressObservationStreamPush =
        oldestId !== undefined && this.removeHierarchyObservationStreamSuppression(oldestId);
    }
    if (!suppressObservationStreamPush) {
      // Push to observation stream
      this.pushHierarchyToObservationStream(data, frameContext);

      // Start screenshot backoff
      this.startScreenshotBackoff();
    } else {
      logger.debug(
        "[CTRL_PROXY] Suppressed hierarchy observation stream push for explicit initial-frame request",
      );
    }

    // Track foreground package for context and start performance monitoring
    if (data.packageName && data.packageName !== this.lastForegroundPackage) {
      this.lastForegroundPackage = data.packageName;
      // Start performance monitoring for this device/package
      const monitor = getPerformanceMonitor();
      monitor.startMonitoring(this.device.deviceId, data.packageName);
    }

    // Record layout telemetry (throttled to max 1 per 500ms)
    if (now - this.lastLayoutTelemetryTimestamp >= 500) {
      this.lastLayoutTelemetryTimestamp = now;
      const recorder = TelemetryRecorder.getInstance();
      recorder.setContext(this.device.deviceId, null);
      const screenName = data.foregroundActivity ?? data.packageName ?? null;
      const windowCount = data.windows?.length ?? 0;
      // Include a compact hierarchy tree (~2-5KB) with just the display properties.
      // The full hierarchy (~10-50KB with bounds/states/extras) is available via
      // the observation stream and would cause excessive traffic at 500ms intervals.
      const compactHierarchy = data.hierarchy ? { node: compactifyNode(data.hierarchy) } : null;
      recorder
        .recordLayoutEvent({
          timestamp: now,
          applicationId: data.packageName ?? null,
          subType: "hierarchy_change",
          composableName: null,
          composableId: null,
          recompositionCount: null,
          durationMs: null,
          likelyCause: null,
          detailsJson: JSON.stringify({
            screenName,
            windowCount,
            foregroundActivity: data.foregroundActivity ?? null,
            hierarchy: compactHierarchy,
          }),
          screenName,
        })
        .catch((error) => {
          logger.warn(`[CTRL_PROXY] Layout telemetry failed: ${errorMessage(error)}`, error);
        });
    }

    // Notify hierarchy navigation detector
    const navigationPackage = this.resolveHierarchyPackage(data);
    if (!data.hierarchy) {
      logger.warn("[CTRL_PROXY] Skipping navigation detection: hierarchy missing");
    } else if (data.error) {
      logger.warn(`[CTRL_PROXY] Skipping navigation detection due to error: ${data.error}`);
    } else if (!this.shouldUseHierarchyNavigation(navigationPackage)) {
      logger.debug(`[CTRL_PROXY] Skipping hierarchy navigation for SDK app: ${navigationPackage}`);
      // The app may be back in front without a navigation event (#10193). The signal names this
      // device: on the shared global manager another device's tick must not switch the app.
      if (navigationPackage) {
        this.getNavigationGraphManager()
          .recordAppForeground(navigationPackage, this.device.deviceId)
          .catch((error) =>
            logger.warn(`[CTRL_PROXY] SDK app foreground signal failed: ${errorMessage(error)}`),
          );
      }
    } else {
      // Resolve build/device provenance for hierarchy-driven reaches too (#4984):
      // non-SDK apps never emit navigation_event, so this is the only path that gives
      // them a real build key instead of the default/legacy one.
      if (navigationPackage) {
        this.ensureBuildContext(navigationPackage);
      }
      this.getHierarchyNavigationDetector().onHierarchyUpdate({
        ...data,
        packageName: navigationPackage,
      });
    }
  }

  private resolveHierarchyPackage(data: AccessibilityHierarchy): string | undefined {
    if (data.packageName?.trim()) {
      return data.packageName.trim();
    }
    const windows = (linkWindowRoots(data.hierarchy, data.windows) ?? []).filter(
      (window) =>
        data.displayId === undefined ||
        data.displayId === null ||
        window.displayId === undefined ||
        window.displayId === null ||
        window.displayId === data.displayId,
    );
    // An IME can own focus above the app. Prefer a focused non-IME surface
    // (including system dialogs), then the active/top application window.
    const appWindows = windows.filter((entry) => entry.type === 1);
    const window =
      windows.find((entry) => entry.isFocused && entry.type !== 2) ??
      appWindows.find((entry) => entry.isActive) ??
      appWindows.sort((left, right) => (right.windowLayer ?? 0) - (left.windowLayer ?? 0))[0];
    const attributes = window?.hierarchy ? nodeAttributes(window.hierarchy) : {};
    // Do not borrow a different root's identity when the selected window is unknown.
    const candidates = window
      ? [window.packageName, attributes.packageName, attributes.package]
      : [data.hierarchy?.packageName];
    return candidates
      .flatMap((value) => (typeof value === "string" ? [value.trim()] : []))
      .find((value) => value.length > 0);
  }

  private shouldUseHierarchyNavigation(packageName?: string): boolean {
    if (!packageName) {
      return true;
    }
    return !this.sdkNavigationAppIds.has(packageName);
  }

  private pushHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    frameContext?: string,
  ): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    try {
      const captureSequence = server.pushHierarchyUpdate(
        this.device.deviceId,
        hierarchy,
        frameContext,
      );
      // Record the identity the daemon assigned, so screenshot requests initiated from here on are
      // bound to it. A null return (no subscribers), a throw, or a missing server all leave the
      // geometry untracked, and the daemon then omits the identity so a control client fails closed.
      if (captureSequence !== null) {
        hierarchy.captureSequence = captureSequence;
        this.streamedCaptureSequences.set(hierarchy, captureSequence);
        this.screenGeometry.markForwarded(captureSequence);
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to push hierarchy to observation stream: ${error}`);
    }
  }

  /**
   * Bind the hierarchy explicitly forwarded by the daemon's subscriber bootstrap. The request
   * suppressed this client's normal stream push, so it must replace any prior provenance before
   * accepting the identity assigned by that explicit push, then start keepalives for a static
   * screen.
   */
  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void {
    this.screenGeometry.clear();
    this.updateCachedScreenDimensions(hierarchy);
    if (captureSequence !== null) {
      this.screenGeometry.markForwarded(captureSequence);
    }
    this.startScreenshotBackoff();
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  pushScreenshotToObservationStream(
    screenshotBase64: string,
    metadata: ScreenshotMetadata = ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
    binding?: ScreenGeometryBinding,
    frameContext?: string,
    rotation?: number,
  ): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    // Declare the geometry the request was BOUND to, not whatever the cache holds now — the two
    // differ exactly when a hierarchy arrived while this frame was in flight. Without a binding,
    // fall back to a nominal size and send no identity, so a control client fails closed.
    const screenWidth = binding?.width ?? this.screenGeometry.width ?? 1080;
    const screenHeight = binding?.height ?? this.screenGeometry.height ?? 2340;

    try {
      // The identity AND the coordinate space travel with the frame from the moment it was
      // requested (issues #3348, #4549) — both from the binding taken at initiation, never the
      // client's LATEST metadata at delivery. Android bounds are already physical pixels
      // (nativeScale === 1), so a post-#4548 runner's frame is canonical pixels as-is; the binding
      // carries that declaration so a mid-flight metadata flip cannot relabel the frame.
      server.pushScreenshotUpdate(
        this.device.deviceId,
        screenshotBase64,
        screenWidth,
        screenHeight,
        metadata,
        {
          ...screenshotBindingPushOptions(binding),
          rotation,
          ...(frameContext === undefined ? {} : { frameContext }),
        },
      );
    } catch (error) {
      logger.debug(`[CTRL_PROXY] Failed to push screenshot to observation stream: ${error}`);
    }
  }

  private updateCachedScreenDimensions(
    hierarchy: Pick<
      AccessibilityHierarchy,
      "windows" | "nativeScale" | "pixelWidth" | "pixelHeight"
    >,
  ): void {
    // Retain the additive #4548 scale metadata alongside — but never instead of — the
    // window-derived geometry below. Same freshness rule as the tracked geometry: a hierarchy
    // without the fields (pre-#4548 runner) resets it to null rather than leaving stale values.
    this.reportedScaleMetadata = readScreenScaleMetadata(hierarchy);
    const windows = hierarchy.windows;
    if (!windows || windows.length === 0) {
      this.screenGeometry.clear();
      return;
    }

    let maxArea = 0;
    let bestDimensions: { width: number; height: number } | null = null;

    for (const window of windows) {
      if (window.bounds) {
        const width = window.bounds.right - window.bounds.left;
        const height = window.bounds.bottom - window.bounds.top;
        const area = width * height;
        if (area > maxArea) {
          maxArea = area;
          bestDimensions = { width, height };
        }
      }
    }

    if (bestDimensions) {
      // A change clears the identity: it becomes capture-tracked only once the hierarchy carrying
      // it reaches the daemon (see pushHierarchyToObservationStream) — which will NOT happen when
      // this hierarchy is suppressed, or when there is no stream server. The coordinate space is
      // bound here (#4549) from the metadata present for THIS hierarchy, so a later metadata flip
      // cannot restamp a frame whose request was bound now.
      this.screenGeometry.update(
        bestDimensions.width,
        bestDimensions.height,
        this.reportedScaleMetadata ? COORDINATE_SPACE_PX : undefined,
        this.reportedScaleMetadata?.nativeScale,
      );
    } else {
      // No usable window bounds in this hierarchy. Clearing (rather than keeping the previous
      // entry) stops a later push from vouching for dimensions this hierarchy cannot confirm.
      this.screenGeometry.clear();
    }
  }

  /**
   * Runner-reported scale metadata from the most recent hierarchy (#4548), or null when the
   * runner has not reported it (pre-#4548 runner, or no hierarchy yet). Exposed for #4549's
   * canonical-pixel conversion; nothing in current behavior consumes it.
   */
  getScreenScaleMetadata(): ScreenScaleMetadata | null {
    return this.reportedScaleMetadata;
  }

  private getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler {
    if (!this.screenshotBackoffScheduler) {
      this.screenshotBackoffScheduler = new DefaultScreenshotBackoffScheduler(
        async (): Promise<ScreenshotCaptureResult> => {
          return this.captureScreenshotForBackoff();
        },
        (result: ScreenshotCaptureResult) => {
          if (result.data) {
            this.pushScreenshotToObservationStream(
              result.data,
              result,
              result.captureBinding,
              result.frameContext,
              result.rotation,
            );
          }
        },
        {
          intervals: [0, 100, 300, 500, 800, 1300],
          keepAliveIntervalMs: 3000,
          getKeepAliveIntervalMs: () => {
            const server = getDeviceDataStreamServer();
            return server?.getScreenshotIntervalMsForDevice(this.device.deviceId) ?? 3000;
          },
          minCaptureIntervalMs: AndroidCtrlProxyClient.A11Y_SCREENSHOT_MIN_INTERVAL_MS,
        },
        this.timer,
        () => {
          const server = getDeviceDataStreamServer();
          return !!server && server.hasSubscriberForDevice(this.device.deviceId);
        },
      );
    }
    return this.screenshotBackoffScheduler;
  }

  private async captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult> {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.device.deviceId)) {
      return { success: false, error: "No subscribers" };
    }

    return this.captureScreenshotForObservationStream();
  }

  async captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult> {
    // Keep unsupported devices on ADB between probes, but periodically recheck in case the
    // CtrlProxy service/APK was updated without replacing this client instance.
    if (this.a11yScreenshotSupported === false && !this.prepareA11yScreenshotReprobe()) {
      return this.captureScreenshotViaAdb("a11y_screenshot_unsupported");
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this.captureScreenshotViaAdb("websocket_unavailable");
    }

    const requestId = this.requestManager.generateId("screenshot-backoff");
    const message = serializeCtrlProxyRequest(ctrlProxyRequests.requestScreenshot({ requestId }));
    // Bind the capture identity current at INITIATION and carry it through the await, so a
    // hierarchy forwarded while this frame is in flight cannot relabel it.
    const captureBinding = this.screenGeometry.bind() ?? undefined;

    try {
      this.screenshotObservationStreamSuppressions.add(requestId);
      const screenshotPromise = this.requestManager.register<ScreenshotResult>(
        requestId,
        "screenshot",
        3000,
        (_id, _type, _timeout) => ({ success: false, error: CTRLPROXY_SCREENSHOT_TIMEOUT_ERROR }),
      );

      // Advance the shared rate-limit floor clock at the a11y-request boundary so a direct capture
      // (e.g. the initial subscriber frame) and a scheduler-armed capture cannot both hit the
      // accessibility screenshot API in the same floor window (issue #4927).
      this.getScreenshotBackoffScheduler().noteCaptureStarted();
      this.ws.send(message);

      const result = await screenshotPromise;

      if (!result.success || !result.data) {
        if (result.error === CTRLPROXY_RATE_LIMITED_ERROR) {
          this.a11yScreenshotFailures = 0;
          return this.captureScreenshotViaAdb(fallbackReasonForCtrlProxyFailure(result.error));
        }

        this.a11yScreenshotFailures++;
        if (
          this.a11yScreenshotSupported === null &&
          this.a11yScreenshotFailures >= AndroidCtrlProxyClient.A11Y_SCREENSHOT_MAX_FAILURES
        ) {
          logger.info(
            "[CTRL_PROXY] Accessibility service screenshot not supported after " +
              `${this.a11yScreenshotFailures} consecutive failures, falling back to ADB screencap`,
          );
          this.a11yScreenshotSupported = false;
          this.a11yScreenshotUnsupportedSince = this.timer.now();
        }
        return this.captureScreenshotViaAdb(fallbackReasonForCtrlProxyFailure(result.error));
      }

      this.a11yScreenshotFailures = 0;
      this.a11yScreenshotSupported = true;
      const checksum = computeChecksum(result.data);

      return {
        success: true,
        data: result.data,
        checksum,
        captureBinding,
        frameContext: result.frameContext,
        rotation: result.rotation,
        ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, result.format),
        ...screenshotPerformanceMetadataFrom(result),
      };
    } catch (error) {
      this.requestManager.resolve<ScreenshotResult>(requestId, {
        success: false,
        error: `${error}`,
      });
      return this.captureScreenshotViaAdb("ctrlproxy_exception");
    } finally {
      this.screenshotObservationStreamSuppressions.delete(requestId);
    }
  }

  private resetA11yScreenshotSupport(): void {
    this.a11yScreenshotSupported = null;
    this.a11yScreenshotFailures = 0;
    this.a11yScreenshotUnsupportedSince = null;
  }

  private prepareA11yScreenshotReprobe(): boolean {
    const unsupportedSince = this.a11yScreenshotUnsupportedSince;
    if (
      unsupportedSince === null ||
      this.timer.now() - unsupportedSince <
        AndroidCtrlProxyClient.A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS
    ) {
      return false;
    }

    this.a11yScreenshotSupported = null;
    // One failed post-cooldown probe should relatch immediately and restart the cooldown.
    this.a11yScreenshotFailures = AndroidCtrlProxyClient.A11Y_SCREENSHOT_MAX_FAILURES - 1;
    this.a11yScreenshotUnsupportedSince = null;
    return true;
  }

  /**
   * Fallback screenshot capture via ADB screencap for devices that don't support
   * accessibility service screenshots (API < 30).
   */
  private async captureScreenshotViaAdb(
    fallbackReason?: ScreenshotFallbackReason,
  ): Promise<ScreenshotCaptureResult> {
    // Once the client is terminally closed, suppress the signal-less ADB screencap
    // fallback so a capture rejected by close() cannot keep the transport referenced
    // past teardown (#5493). A transient websocket disconnect does not set this flag,
    // so the fallback still fires during reconnect windows.
    if (this.closed) {
      return {
        success: false,
        error: "AndroidCtrlProxyClient closed; ADB screencap fallback suppressed",
      };
    }

    // Bind the geometry current when the ADB request begins, before its await can let a newer
    // hierarchy relabel the returned pixels.
    const captureBinding = this.screenGeometry.bind() ?? undefined;

    try {
      const tempFile = `/data/local/tmp/am-shot-${screenshotTempIdToken(this.idGenerator.next())}.png`;
      const displayId = await this.physicalDisplayIdResolver.resolve(
        this.adb,
        this.device.deviceId,
      );
      const displayArgument = displayId ? `-d ${displayId} ` : "";
      const quotedTempFile = shellQuote(tempFile);
      const command = `shell "screencap ${displayArgument}-p ${quotedTempFile} && base64 ${quotedTempFile} && rm ${quotedTempFile}"`;
      const maxBuffer = 50 * 1024 * 1024;
      const result = await withAndroidScreenshotCaptureLock(this.device.deviceId, () =>
        this.adb.executeCommand(command, undefined, maxBuffer),
      );

      if (!result.stdout || result.stdout.trim().length === 0) {
        return { success: false, error: "No data from ADB screencap" };
      }

      const data = decodePngBase64Output(result.stdout).toString("base64");
      const checksum = computeChecksum(data);

      return {
        success: true,
        data,
        checksum,
        captureBinding,
        ...ANDROID_ADB_SCREENSHOT_METADATA,
        screenshotFallbackReason: fallbackReason,
      };
    } catch (error) {
      const logger = this.loggerInstance;
      const message = errorMessage(error);
      logger.warn(`[CTRL_PROXY] ADB screencap failed: ${message}`, error);
      return { success: false, error: `ADB screencap failed: ${message}` };
    }
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  startScreenshotBackoff(): void {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.device.deviceId)) {
      return;
    }

    const scheduler = this.getScreenshotBackoffScheduler();
    scheduler.startBackoffSequence();
  }

  private notifyInteractionListeners(event: InteractionEvent): void {
    for (const listener of this.interactionListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`[CTRL_PROXY] Interaction listener error: ${error}`);
      }
    }
  }

  private getInstalledAppsRepository(): InstalledAppsStore {
    if (!this.installedAppsRepository) {
      this.installedAppsRepository = new InstalledAppsRepository();
    }
    return this.installedAppsRepository;
  }

  /**
   * Get or create the work profile monitor for polling profiles without accessibility service
   */
  getWorkProfileMonitor(): WorkProfileMonitor {
    if (!this.workProfileMonitor) {
      this.workProfileMonitor = new DefaultWorkProfileMonitor({
        deviceId: this.device.deviceId,
        adb: this.adb,
        installedAppsStore: this.getInstalledAppsRepository(),
        timer: this.timer,
      });
    }
    return this.workProfileMonitor;
  }

  /**
   * Start the work profile monitor to poll profiles without accessibility service
   */
  startWorkProfileMonitor(): void {
    this.getWorkProfileMonitor().start();
  }

  /**
   * Stop the work profile monitor
   */
  stopWorkProfileMonitor(): void {
    if (this.workProfileMonitor) {
      this.workProfileMonitor.stop();
    }
  }

  private async handlePackageEvent(event: PackageEvent, timestamp?: number): Promise<void> {
    if (this.device.platform !== "android") {
      return;
    }

    if (!event.packageName || !Number.isInteger(event.userId) || event.userId < 0) {
      logger.warn("[CTRL_PROXY] Ignoring package event with missing data");
      return;
    }

    const deviceId = this.device.deviceId;
    const androidUserId = packageEventAndroidUserId(event);
    const eventTimestamp = typeof timestamp === "number" ? timestamp : this.timer.now();
    const repo = this.getInstalledAppsRepository();

    // Invalidate cached build/content-hash provenance for this package (#4984) so the
    // next nav event re-resolves the hash. Fires for every action (add/replace/remove)
    // — a rebuild+reinstall, INCLUDING the same-versionCode/different-content daily-dev
    // case, must not keep recording against the previous build's hash.
    this.invalidateBuildContext(event.packageName);

    try {
      if (event.action === "removed") {
        if (event.removedForAllUsers) {
          await repo.removeInstalledAppForDevice(deviceId, event.packageName);
        } else {
          await repo.removeInstalledApp(deviceId, androidUserId, event.packageName);
        }
      } else {
        const isSystem = event.isSystem === true;
        await repo.upsertInstalledApp(
          deviceId,
          androidUserId,
          event.packageName,
          isSystem,
          eventTimestamp,
        );
      }

      // Notify work profile monitor that this user has accessibility service
      // (if we're receiving package events, the service is working for this user)
      if (androidUserId > 0 && this.workProfileMonitor) {
        this.workProfileMonitor.setProfileHasAccessibilityService(androidUserId, true);
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to apply package event: ${error}`);
    }
  }

  private enqueueNavigationGraphWrite(received: NavigationEvent): Promise<void> {
    const navigationGraphManager = this.getNavigationGraphManager();
    // Stamp the device that received the event: the manager's telemetry must not read the
    // recorder's ambient context, which another device's client may have set (#10195).
    const event: NavigationEvent = { ...received, deviceId: this.device.deviceId };
    const navWrite = this.navigationWriteTail.then(
      () => navigationGraphManager.recordNavigationEvent(event),
      () => navigationGraphManager.recordNavigationEvent(event),
    );
    // A failed event remains observable to its handler, but cannot permanently block later
    // navigation frames from reaching the graph.
    this.navigationWriteTail = navWrite.catch(() => undefined);
    return navWrite;
  }

  private async handleHandledExceptionEvent(event: HandledExceptionEvent): Promise<void> {
    logger.info(
      `[CTRL_PROXY] Received handled exception: ${event.exceptionClass} from ${event.packageName}`,
    );
    await this.getSdkEventIngestor().recordHandledException(event);
  }

  private isCommandSupported(messageType: string): boolean {
    if (this.rejectedCommands.has(messageType)) {
      return false;
    }
    if (this.supportedCommands?.has(ANDROID_FULL_COMMAND_SET_CAPABILITY)) {
      return this.supportedCommands.has(messageType);
    }
    // Legacy behavior for services that predate full_command_set_v1 (older APKs).
    if (
      messageType === "gesture_display_id_v1" ||
      messageType === "tap_double_v1" ||
      messageType === OVERLAY_DISPLAY_CAPABILITY
    ) {
      return this.supportedCommands?.has(messageType) === true;
    }
    if (this.supportedCommands === null) {
      return true;
    }
    if (ANDROID_CAPABILITY_GATED_COMMANDS.has(messageType)) {
      return this.supportedCommands.has(messageType);
    }
    return true;
  }

  // Cancel only this caller's wait; connection establishment is shared with other operations.
  private async awaitActionWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!signal) {
      return work();
    }
    return raceWithDeadline(work(), {
      timer: this.timer,
      signal,
      label: "Android CtrlProxy action",
    });
  }

  private async waitForHandshake(
    timeoutMs: number = AndroidCtrlProxyClient.HANDSHAKE_WAIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = this.timer.now() + timeoutMs;
    while (this.supportedCommands === null && this.timer.now() < deadline) {
      if (!signal) {
        await this.timer.sleep(AndroidCtrlProxyClient.HANDSHAKE_POLL_INTERVAL_MS);
        continue;
      }
      let timeout: ReturnType<Timer["setTimeout"]> | undefined;
      try {
        await this.awaitActionWork(
          () =>
            new Promise<void>((resolve) => {
              timeout = this.timer.setTimeout(
                resolve,
                AndroidCtrlProxyClient.HANDSHAKE_POLL_INTERVAL_MS,
              );
            }),
          signal,
        );
      } finally {
        if (timeout !== undefined) {
          this.timer.clearTimeout(timeout);
        }
      }
    }
  }

  private async persistCrash(event: SdkCrashPayload): Promise<void> {
    try {
      await this.crashEventSink.saveCrash(normalizeCrash(event, this.device.deviceId));
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to persist crash: ${error}`);
    }
  }

  /**
   * Ingest a live frame-metrics event from the in-app SDK (issue #5076) into the
   * shared store. `PerformanceMonitor` prefers this real app-frame data over the
   * dumpsys scrape when it is fresh. The event's applicationId identifies the
   * app; fall back to the last-known foreground package if the SDK omitted it.
   */
  private handleFrameMetricsEvent(data: NonNullable<WsFrameMetricsMessage["frameMetrics"]>): void {
    const packageName = data.applicationId ?? this.lastForegroundPackage;
    if (!packageName) {
      return;
    }
    getSdkFrameMetricsStore().ingest(this.device.deviceId, packageName, {
      fps: data.fps ?? null,
      frameTimeMs: data.frameTimeMs ?? null,
      jankFrames: data.jankFrames ?? null,
      receivedAt: this.timer.now(),
    });
  }

  private async handleCrashEvent(event: SdkCrashPayload): Promise<void> {
    logger.info(
      `[CTRL_PROXY] Received crash: ${event.exceptionClass} on thread ${event.threadName} from ${event.packageName}`,
    );
    await Promise.all([
      this.persistCrash(event),
      this.getSdkEventIngestor().recordCrashAnalytics(event),
    ]);
  }

  private async persistAnr(event: SdkAnrPayload): Promise<void> {
    try {
      await this.crashEventSink.saveAnr(normalizeAnr(event, this.device.deviceId));
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to persist ANR: ${error}`);
    }
  }

  private async handleAnrEvent(event: SdkAnrPayload): Promise<void> {
    logger.info(
      `[CTRL_PROXY] Received ANR: pid=${event.pid}, process=${event.processName}, importance=${event.importance}`,
    );
    const packageName = event.packageName ?? event.processName;
    await Promise.all([
      this.persistAnr(event),
      this.getSdkEventIngestor().recordAnrAnalytics(event, packageName),
    ]);
  }

  private parseStackTrace(stackTrace: string, packageName: string): StackTraceElement[] {
    const elements: StackTraceElement[] = [];
    const lines = stackTrace.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(
        /^at\s+([a-zA-Z0-9$_.]+)\.([a-zA-Z0-9$_<>]+)\(([^:)]+):?(\d+)?\)$/,
      );
      if (match) {
        const [, fullClassName, methodName, fileName, lineNumberStr] = match;
        const lineNumber = lineNumberStr ? parseInt(lineNumberStr, 10) : undefined;

        const isAppCode =
          fullClassName.startsWith(packageName) ||
          fullClassName.includes(packageName.split(".").slice(0, 2).join("."));

        elements.push({
          className: fullClassName,
          methodName,
          fileName,
          lineNumber,
          isAppCode,
        });
      }
    }

    return elements;
  }

  private async markInstalledAppsStale(reason: string): Promise<void> {
    if (this.device.platform !== "android") {
      return;
    }

    try {
      // Fired fire-and-forget on WS close, which happens during shutdown socket
      // teardown — route through the barrier so it drains (or is skipped) before
      // closeDatabase() rather than racing the closing connection (issue #2792).
      await getInstalledAppsCacheWriteCoordinator().invalidate(this.device.deviceId, () =>
        getDbWriteBarrier()
          .track(() => this.getInstalledAppsRepository().markDeviceStale(this.device.deviceId))
          .then(() => undefined),
      );
      logger.info(`[CTRL_PROXY] Marked installed apps cache stale (${reason})`);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to mark installed apps stale: ${error}`);
    }
  }
}

/**
 * Create a compact representation of an AccessibilityNode tree for telemetry.
 * Strips bounds, states, extras — keeps only className, resource-id, text,
 * content-desc, scrollable, and children. Typically ~2-5KB vs 10-50KB full.
 */
function compactifyNode(node: AccessibilityNode): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  if (node.className) {
    compact.className = node.className;
  }
  if (node["resource-id"]) {
    compact["resource-id"] = node["resource-id"];
  }
  if (node.text) {
    compact.text = node.text;
  }
  if (node["content-desc"]) {
    compact["content-desc"] = node["content-desc"];
  }
  if (node.scrollable === "true") {
    compact.scrollable = "true";
  }

  if (node.node) {
    const children = Array.isArray(node.node) ? node.node : [node.node];
    compact.node = children.map(compactifyNode);
  }
  return compact;
}

registerDeviceIncarnationListener({
  name: "ctrlproxy-client",
  onDeviceIncarnationChanged: async (deviceId) =>
    await AndroidCtrlProxyClient.invalidateForDeviceIncarnation(deviceId),
});
