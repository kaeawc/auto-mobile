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

import WebSocket from "ws";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AdbClient } from "../../../utils/android-cmdline-tools/AdbClient";
import { logger, type Logger } from "../../../utils/logger";
import { rewriteUnknownCommandError } from "../shared/rewriteUnknownCommandError";
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
} from "../../../models";
import { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import { AndroidCtrlProxyManager } from "../../../utils/CtrlProxyManager";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
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
import { InstalledAppsRepository, InstalledAppsStore } from "../../../db/installedAppsRepository";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../../db/installedAppsCacheWriteCoordinator";
import { DefaultWorkProfileMonitor, WorkProfileMonitor } from "../../../utils/WorkProfileMonitor";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { requireBootedDevice } from "../../../utils/requireBootedDevice";
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
  normalizeAnr,
  normalizeCrash,
  type SdkAnrPayload,
  type SdkCrashPayload,
} from "../crash/sdkCrashIngestion";
import { AndroidSdkEventIngestor, DefaultAndroidSdkEventIngestor } from "./AndroidSdkEventIngestor";
import { FailureEventRepository } from "../../../db/failureEventRepository";
import type { CrashEventSink } from "../../../utils/interfaces/CrashMonitor";
import { serverConfig } from "../../../utils/ServerConfig";
import { TelemetryRecorder } from "../../telemetry/TelemetryRecorder";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import { getSdkFrameMetricsStore } from "../../performance/SdkFrameMetricsStore";
import type { StackTraceElement } from "../../../server/failuresResources";
import { NetworkState } from "../../../server/NetworkState";
import { buildNetworkMockRules } from "../../../server/networkMockRules";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import type {
  PreferenceFile,
  KeyValueEntry,
  KeyValueType,
  StorageSubscription,
  StorageChangedEvent,
} from "../../storage/storageTypes";
import {
  DeviceServiceClient,
  WebSocketFactory,
  defaultWebSocketFactory,
} from "../DeviceServiceClient";
import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import type { SetTextOptions } from "../DeviceService";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";
import { RetryExecutor, defaultRetryExecutor } from "../../../utils/retry/RetryExecutor";

// Import delegates
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyText } from "./CtrlProxyText";
import { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import { CtrlProxyCertificates, type CertificateFileSystem } from "./CtrlProxyCertificates";
import { CtrlProxyFocus } from "./CtrlProxyFocus";
import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import { CtrlProxyPackages, type PackageInfoOptions } from "./CtrlProxyPackages";

// Import types
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
  userId: number;
  isSystem?: boolean | null;
  removedForAllUsers?: boolean | null;
}

/**
 * Interface for handled exception event from SDK
 */
interface HandledExceptionEvent {
  timestamp: number;
  exceptionClass: string;
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

interface ObservationStreamSuppression {
  timeoutHandle: NodeJS.Timeout;
}

interface WsHierarchyUpdateMessage extends WsMessageBase {
  type: "hierarchy_update";
  data: AccessibilityHierarchy;
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
}

interface WsScreenshotErrorMessage extends WsMessageBase {
  type: "screenshot_error";
  requestId: string;
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
  totalTimeMs?: number;
  focusedElement?: AccessibilityNode | null;
}

interface WsTraversalOrderResultMessage extends WsMessageBase {
  type: "traversal_order_result";
  requestId: string;
  totalTimeMs?: number;
  result?: {
    elements: AccessibilityNode[];
    focusedIndex: number | null;
    totalCount: number;
  };
}

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
  event?: SdkCrashPayload;
}

interface WsAnrEventMessage extends WsMessageBase {
  type: "anr_event";
  event?: SdkAnrPayload;
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
 * These are not part of the typed `WebSocketMessage` union.
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
 * message. The runner-supplied `previousValue` is threaded through ONLY when the
 * wire message carries it (`!== undefined`), so the repository's
 * `previousValue !== undefined` guard falls through to the per-insert auto-lookup
 * for legacy runners that omit it (#3000). An explicit null ("no prior value")
 * is honored verbatim and also skips the lookup.
 */
export function storageTelemetryInputFromWire(
  message: WsStorageChangedMessage,
  resolvedTimestamp: number,
): StorageTelemetryInput {
  const input: StorageTelemetryInput = {
    timestamp: resolvedTimestamp,
    applicationId: message.packageName ?? null,
    fileName: message.fileName ?? "",
    key: message.key ?? null,
    value: message.value ?? null,
    valueType: message.valueType ?? "STRING",
    changeType: message.changeType ?? "modify",
  };
  if (message.previousValue !== undefined) {
    input.previousValue = message.previousValue;
  }
  return input;
}

/**
 * Discriminated union of all WebSocket messages from the accessibility service.
 * The `type` field is the discriminant.
 */
type WebSocketMessage =
  | WsConnectedMessage
  | WsHierarchyUpdateMessage
  | WsScreenshotMessage
  | WsScreenshotErrorMessage
  | WsErrorMessage
  | WsSwipeResultMessage
  | WsTapCoordinatesResultMessage
  | WsDragResultMessage
  | WsPinchResultMessage
  | WsSetTextResultMessage
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
  | WsHighlightResponseMessage
  | WsGlobalActionResultMessage
  | WsDeviceInfoResultMessage
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

/**
 * Interface for accessibility service providing Android UI hierarchy and interaction capabilities
 */
export interface AndroidCtrlProxy extends CtrlProxyClient {
  setRecompositionTrackingEnabled(enabled: boolean, perf?: PerformanceTracker): Promise<void>;

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
  ): Promise<A11ySwipeResult>;

  requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
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
  ): Promise<A11yPinchResult>;

  requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult>;

  requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySetTextResult>;

  requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yImeActionResult>;

  requestSelectAll(timeoutMs?: number, perf?: PerformanceTracker): Promise<A11ySelectAllResult>;

  requestAction(
    action: string,
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yActionResult>;

  requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yActionResult>;

  supportsNodeActionSelectors(perf?: PerformanceTracker): Promise<boolean>;

  requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yActionResult>;

  supportsAccessibilityLinkActivation(perf?: PerformanceTracker): Promise<boolean>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
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

/**
 * Client for interacting with the AutoMobile Accessibility Service via WebSocket.
 * Uses singleton pattern per device to maintain persistent WebSocket connection.
 */
export class AndroidCtrlProxyClient extends DeviceServiceClient implements AndroidCtrlProxy {
  private static readonly DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250;

  private device: BootedDevice;
  private adb: AdbExecutor;

  // Per-instance port allocation for multi-device support
  private localPort: number;

  // Singleton instances per device
  private static instances: Map<string, AndroidCtrlProxyClient> = new Map();

  // Session binding for multi-agent isolation
  private boundSessionId: string | null = null;

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
  private lastWebSocketTimeout: number = 0;

  // Delegate instances (lazy initialized)
  private _gestures: CtrlProxyGestures | null = null;
  private _text: CtrlProxyText | null = null;
  private _hierarchy: CtrlProxyHierarchy | null = null;
  private _storage: CtrlProxyStorage | null = null;
  private _certificates: CtrlProxyCertificates | null = null;
  private _focus: CtrlProxyFocus | null = null;
  private _highlights: CtrlProxyHighlights | null = null;
  private _packages: CtrlProxyPackages | null = null;

  // Interaction listeners
  private interactionListeners: Set<(event: InteractionEvent) => void> = new Set();
  // Last interaction for correlating with navigation events
  private lastInteraction: {
    type: string;
    elementText?: string;
    elementResourceId?: string;
    timestamp: number;
  } | null = null;
  private installedAppsRepository: InstalledAppsStore | null = null;

  // Hierarchy navigation detector
  private hierarchyNavigationDetector: HierarchyNavigationDetector | null = null;
  private sdkNavigationAppIds: Set<string> = new Set();
  private navigationWriteTail: Promise<void> = Promise.resolve();

  // Screenshot backoff scheduler
  private screenshotBackoffScheduler: ScreenshotBackoffScheduler | null = null;
  // Screen geometry derived from hierarchies, carrying whether the daemon has actually seen a
  // hierarchy with that geometry (issue #3348). See TrackedScreenGeometry.
  private readonly screenGeometry = new TrackedScreenGeometry();
  // Runner-reported scale metadata from the most recent hierarchy (#4548). Android reports
  // nativeScale 1 with pixel dims equal to its (already-pixel) screen dims. Retained for #4549;
  // null until a #4548-aware runner reports it. Nothing in current behavior reads it.
  private reportedScaleMetadata: ScreenScaleMetadata | null = null;
  private hierarchyObservationStreamSuppressions: Set<ObservationStreamSuppression> = new Set();
  // Request ids whose screenshot responses must not be auto-pushed to the
  // observation stream. Scoped per-request so an unrelated in-flight screenshot
  // (e.g. backoff capture or MCP screenshot) cannot consume the suppression.
  private screenshotObservationStreamSuppressions: Set<string> = new Set();

  // Capture identity bound to each in-flight screenshot request, keyed by requestId (issue #3348).
  // Recorded when the request is SENT and consumed when its response is pushed, so a hierarchy that
  // arrives while the frame is in flight cannot relabel it. Same-resolution navigation makes this
  // the only defence: the pixel dimensions are identical, so nothing about the frame reveals that
  // it belongs to the previous screen.
  private screenshotCaptureBindings: Map<string, ScreenGeometryBinding> = new Map();
  // Track whether the device supports accessibility service screenshots (API 30+).
  // null = unknown, true = supported, false = unsupported (fall back to ADB screencap).
  // Only marked unsupported after consecutive failures to avoid disabling on transient timeouts.
  private a11yScreenshotSupported: boolean | null = null;
  private a11yScreenshotFailures: number = 0;
  private static readonly A11Y_SCREENSHOT_MAX_FAILURES = 3;
  // Minimum interval between accessibility takeScreenshot() requests. The platform rate-limits
  // calls below its floor (~333ms, ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT); 350ms sits just
  // above it so a front-loaded backoff burst or an animation's restart storm cannot trip the
  // limit into needless ADB-screencap fallover (issue #4927).
  private static readonly A11Y_SCREENSHOT_MIN_INTERVAL_MS = 350;

  // Work profile monitor for polling profiles without accessibility service
  private workProfileMonitor: WorkProfileMonitor | null = null;
  private supportedCommands: Set<string> | null = null;
  private static readonly HANDSHAKE_WAIT_TIMEOUT_MS = 2000;
  private static readonly HANDSHAKE_POLL_INTERVAL_MS = 50;

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
  ) {
    super(
      timer ?? defaultTimer,
      webSocketFactory ?? defaultWebSocketFactory,
      {},
      retryExecutor ?? defaultRetryExecutor,
    );
    this.sdkEventIngestorInstance = sdkEventIngestor ?? null;
    this.loggerInstance = loggerInstance;
    this.device = device;
    this.adb = adb;
    this.installedAppsRepository = installedAppsRepository ?? null;
    this.crashEventSink = crashEventSink ?? new FailureEventRepository();
    this.deviceConnectionLostNotifier =
      deviceConnectionLostNotifier ?? observationStreamDeviceConnectionLostNotifier;
    this.certificateFileSystem = certificateFileSystem;
    this.localPort = PortManager.allocate(device.deviceId, {
      reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
    });
    AndroidCtrlProxyManager.getInstance(device);
  }

  /**
   * Get singleton instance for a device
   */
  public static getInstance(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ): AndroidCtrlProxyClient {
    requireBootedDevice(device, "AndroidCtrlProxyClient.getInstance");
    const deviceId = device.deviceId;
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
   * Test-only accessor for the currently bound session (or null when unbound).
   * Lets isolation tests pin the routing invariant that `bindSession` is
   * last-writer-wins and that an unbound client has no session.
   */
  public getBoundSessionIdForTesting(): string | null {
    return this.boundSessionId;
  }

  /**
   * Release this client's binding to a session that has ended (#4984). If still
   * bound to `sessionId`, drop the binding and dispose the cached hierarchy detector
   * so a post-release event (before any new session binds the still-connected
   * device) routes to the unattributed global manager, never the ended session's.
   */
  public releaseSessionBinding(sessionId: string): void {
    if (this.boundSessionId === sessionId) {
      this.boundSessionId = null;
      if (this.hierarchyNavigationDetector) {
        this.hierarchyNavigationDetector.dispose();
        this.hierarchyNavigationDetector = null;
      }
    }
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
        const info = await this.requestPackageInfo(appId, { includePermissions: false }, 4000);
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
      instance.close().catch(() => {});
    }
    AndroidCtrlProxyClient.instances.clear();
    PortManager.reset();
    logger.info("[CTRL_PROXY] Reset all singleton instances and port allocations");
  }

  /**
   * Create instance for testing with custom WebSocket factory
   */
  public static createForTesting(
    device: BootedDevice,
    adb: AdbClient,
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
    );
    // Test-only seam: pre-seed the lazily-built scheduler so tests can assert shared floor
    // accounting (noteCaptureStarted) without the live device-data-stream server. Not exposed on
    // the production getInstance path.
    if (screenshotBackoffScheduler) {
      client.screenshotBackoffScheduler = screenshotBackoffScheduler;
    }
    return client;
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

  private get hierarchy(): CtrlProxyHierarchy {
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

  protected async handleMessage(data: WebSocket.Data): Promise<void> {
    return this.handleWebSocketMessage(data);
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
    const connected = await super.ensureConnected(perf);
    if (connected) {
      this.syncAccessibilityFlagsToDevice();
    }
    return connected;
  }

  protected onConnectionEstablished(): void {
    this.syncNetworkStateToDevice();
    this.syncAccessibilityFlagsToDevice();
    // Resume the screenshot keepalive after a (re)connect. onConnectionClosed()
    // cancels it; without restarting here, a transient drop on a STATIC screen
    // leaves the live view frozen forever (no UI change to retrigger a capture).
    // Subscriber-gated and idempotent, so this is a no-op when nobody is
    // watching and safe to call on every reconnect.
    this.startScreenshotBackoff();
  }

  private syncNetworkStateToDevice(): void {
    try {
      const state = NetworkState.getInstance();

      // Always sync mock rules on reconnect — buildNetworkMockRules uses limit
      // (not remaining) so the device-side store reinitializes fresh counts.
      // Sending an empty list clears stale rules that may linger from a
      // previous connection.
      const rules = buildNetworkMockRules(state);
      this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules })));

      // Always re-sync error simulation state (including disabled) so the
      // device doesn't keep stale simulation config from a previous connection
      const sim = state.simulation;
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

  protected onConnectionClosed(): void {
    this.supportedCommands = null;
    this.cancelScreenshotBackoff();
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

  /** Every app id with cached or in-flight build-context state (#4984). */
  private knownBuildContextApps(): string[] {
    return Array.from(
      new Set([...this.resolvedBuildContexts.keys(), ...this.buildContextInFlight]),
    );
  }

  protected async setupBeforeConnect(perf: PerformanceTracker): Promise<void> {
    await this.setupPortForwarding(perf);
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
    timeoutMs?: number,
  ): Promise<ViewHierarchyResult | null> {
    return this.hierarchy.getAccessibilityHierarchy(
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      disableAllFiltering,
      signal,
      timeoutMs,
    );
  }

  async setRecompositionTrackingEnabled(
    enabled: boolean,
    perf?: PerformanceTracker,
  ): Promise<void> {
    return this.hierarchy.setRecompositionTrackingEnabled(enabled, perf);
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
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    return this.hierarchy.requestHierarchySync(
      perf,
      disableAllFiltering,
      signal,
      timeoutMs,
      diagnostics,
    );
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering: boolean = false,
    signal?: AbortSignal,
    timeoutMs: number = 10000,
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    const suppression: ObservationStreamSuppression = {
      timeoutHandle: this.timer.setTimeout(() => {
        this.hierarchyObservationStreamSuppressions.delete(suppression);
      }, timeoutMs),
    };
    this.hierarchyObservationStreamSuppressions.add(suppression);
    return this.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs);
  }

  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    return this.hierarchy.convertToViewHierarchyResult(accessibilityHierarchy);
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
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestSwipe(x1, y1, x2, y2, duration, timeoutMs, perf, frameContext);
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
  ): Promise<A11yTapCoordinatesResult> {
    return this.gestures.requestTapCoordinates(x, y, duration, timeoutMs, perf, frameContext);
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
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestTwoFingerSwipe(x1, y1, x2, y2, duration, offset, timeoutMs, perf);
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
    );
  }

  // Streaming gesture input (Android-only): one live drag = start + moves + end sharing a gestureId,
  // chained into a single continued AccessibilityService gesture by the runner.
  async requestGestureStart(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureStart(gestureId, x, y, timeoutMs, perf);
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
  ): Promise<A11yImeActionResult> {
    return this.text.requestImeAction(action, timeoutMs, perf);
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
  ): Promise<A11yActionResult> {
    const startTime = this.timer.now();

    this.cancelScreenshotBackoff();

    try {
      const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for action");
        return {
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      const requestId = this.requestManager.generateId("action");
      logger.debug(
        `[CTRL_PROXY] Creating action request (requestId: ${requestId}, action: ${action}, ` +
          `resourceId: ${resourceId}, selector: ${JSON.stringify(selector)})`,
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
        }),
      );

      await perf.track("sendRequest", async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(
          ctrlProxyRequests.requestAction({ requestId, action, resourceId, selector }),
        );
        this.ws.send(message);
        logger.debug(
          `[CTRL_PROXY] Sent action request (requestId: ${requestId}, action: ${action}, ` +
            `resourceId: ${resourceId}, selector: ${JSON.stringify(selector)})`,
        );
      });

      const result = await perf.track("waitForAction", () => actionPromise);
      const clientDuration = this.timer.now() - startTime;

      if (result.success) {
        logger.debug(
          `[CTRL_PROXY] Action completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, action=${result.action}`,
        );
      } else {
        logger.warn(`[CTRL_PROXY] Action failed after ${clientDuration}ms: ${result.error}`);
      }

      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Action request failed after ${duration}ms: ${error}`);
      return { success: false, action, totalTimeMs: duration, error: `${error}` };
    }
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yActionResult> {
    return this.requestAction(action, selector.resourceId, timeoutMs, perf, selector);
  }

  async supportsNodeActionSelectors(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
    if (connected && this.supportedCommands === null) {
      await this.waitForHandshake();
    }
    return connected && this.isCommandSupported("node_selector_actions");
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

  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yActionResult> {
    const startTime = this.timer.now();
    const action = "activate_accessibility_link";
    try {
      if (!(await this.supportsAccessibilityLinkActivation(perf))) {
        return {
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Connected Android runner does not support semantic accessibility-link activation",
        };
      }
      const requestId = this.requestManager.generateId("accessibility-link");
      const resultPromise = this.requestManager.register<A11yActionResult>(
        requestId,
        "accessibility-link",
        timeoutMs,
        () => ({
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: `Semantic link activation timed out after ${timeoutMs}ms`,
        }),
      );
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
      return await resultPromise;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Semantic link activation failed: ${error}`);
      return {
        success: false,
        action,
        totalTimeMs: this.timer.now() - startTime,
        error: `${error}`,
      };
    }
  }

  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yClipboardResult> {
    const startTime = this.timer.now();

    try {
      if (action === "copy" && !text) {
        return {
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Text is required for copy action",
        };
      }

      const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for clipboard");
        return {
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      const requestId = this.requestManager.generateId("clipboard");

      const clipboardPromise = this.requestManager.register<A11yClipboardResult>(
        requestId,
        "clipboard",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: `Clipboard ${action} timeout after ${timeout}ms`,
        }),
      );

      await perf.track("sendRequest", async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(
          ctrlProxyRequests.requestClipboard({ requestId, action, text }),
        );
        this.ws.send(message);
        logger.debug(
          `[CTRL_PROXY] Sent clipboard request (requestId: ${requestId}, action: ${action})`,
        );
      });

      const result = await perf.track("waitForClipboard", () => clipboardPromise);
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
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Clipboard request failed after ${duration}ms: ${error}`);
      return { success: false, action, totalTimeMs: duration, error: `${error}` };
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
  ): Promise<{ success: boolean; action: string; totalTimeMs: number; error?: string }> {
    const startTime = this.timer.now();
    try {
      // Fast-fail if not already connected to avoid stalling callers
      // (all callers fall back to ADB keyevent on failure)
      if (!this.isConnected()) {
        return {
          success: false,
          action,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      const requestId = this.requestManager.generateId("global_action");
      const promise = this.requestManager.register<{
        success: boolean;
        action: string;
        totalTimeMs: number;
        error?: string;
      }>(requestId, "global_action", timeoutMs, (_id, _type, timeout) => ({
        success: false,
        action,
        totalTimeMs: this.timer.now() - startTime,
        error: `Global action timeout after ${timeout}ms`,
      }));

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      this.ws.send(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.requestGlobalAction({ requestId, action, frameContext }),
        ),
      );
      logger.debug(
        `[CTRL_PROXY] Sent global action request (requestId: ${requestId}, action: ${action})`,
      );

      return await promise;
    } catch (error) {
      return {
        success: false,
        action,
        totalTimeMs: this.timer.now() - startTime,
        error: `${error}`,
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
  ): Promise<{ success: boolean; totalTimeMs: number; error?: string }> {
    const startTime = this.timer.now();
    try {
      if (!this.isConnected()) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      const requestId = this.requestManager.generateId("validate_frame_context");
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

      return await promise;
    } catch (error) {
      return { success: false, totalTimeMs: this.timer.now() - startTime, error: `${error}` };
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
    try {
      const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
      if (!connected) {
        return {
          success: false,
          totalTimeMs: this.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      const requestId = this.requestManager.generateId("device_info");
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
      return { success: false, totalTimeMs: this.timer.now() - startTime, error: `${error}` };
    }
  }

  async requestScreenshot(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    suppressObservationStreamPush: boolean = false,
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();
    let suppressedRequestId: string | undefined;
    let requestId: string | undefined;

    try {
      const connected = await perf.track("ensureConnection", () => this.connectWebSocket(perf));
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for screenshot");
        return { success: false, error: "Failed to connect to accessibility service" };
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

      await perf.track("sendRequest", async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(
          ctrlProxyRequests.requestScreenshot({ requestId: sentRequestId }),
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
      });

      const result = await perf.track("waitForScreenshot", () => screenshotPromise);
      const duration = this.timer.now() - startTime;

      if (result.success) {
        const dataSize = result.data ? result.data.length : 0;
        logger.debug(
          `[CTRL_PROXY] Screenshot received in ${duration}ms (${dataSize} base64 chars)`,
        );
      } else {
        logger.warn(`[CTRL_PROXY] Screenshot failed after ${duration}ms: ${result.error}`);
      }

      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Screenshot request failed after ${duration}ms: ${error}`);
      return { success: false, error: `${error}` };
    } finally {
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
          undefined,
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

  /** Tell the Kotlin service that recording has started (enables interaction event emission). */
  notifyRecordingStarted(): void {
    this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.startRecording()));
  }

  /** Tell the Kotlin service that recording has stopped (disables interaction event emission). */
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
    try {
      // Stop work profile monitor if running
      this.stopWorkProfileMonitor();

      await super.close();

      if (this.portForwardingSetup) {
        await this.adb.executeCommand(`forward --remove tcp:${this.localPort}`).catch(() => {});
        this.portForwardingSetup = false;
      }

      PortManager.release(this.device.deviceId);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error during cleanup: ${error}`);
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private ensureLocalPortAvailableForForwarding(): void {
    const currentAllocation = PortManager.getPort(this.device.deviceId);
    const currentPortIsAvailable = PortManager.isPortAvailable(this.localPort);
    if (currentAllocation === this.localPort && currentPortIsAvailable) {
      return;
    }

    const additionalReservedPorts = currentPortIsAvailable ? [] : [this.localPort];
    PortManager.release(this.device.deviceId);
    const nextPort = PortManager.allocate(this.device.deviceId, {
      reservedPorts: [...IOS_CTRL_PROXY_RESERVED_PORTS, ...additionalReservedPorts],
    });
    if (nextPort !== this.localPort) {
      logger.info(
        `[CTRL_PROXY] Reallocated local port from ${this.localPort} to ${nextPort} before adb forward`,
      );
      this.localPort = nextPort;
    }
  }

  private async setupPortForwarding(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<void> {
    // Verify port forwarding is still active even if we think it's set up
    // Port forwarding can be lost if ADB server restarts or emulator restarts
    if (this.portForwardingSetup) {
      const isActive = await this.isPortForwardingActive();
      if (isActive) {
        logger.debug(`[CTRL_PROXY] Port forwarding already active (localhost:${this.localPort})`);
        return;
      }
      logger.debug(`[CTRL_PROXY] Port forwarding was lost, re-establishing...`);
      this.portForwardingSetup = false;
    }

    try {
      const previousLocalPort = this.localPort;
      await perf.track("clearPortForward", () =>
        this.adb.executeCommand(`forward --remove tcp:${this.localPort}`).catch(() => {}),
      );

      this.ensureLocalPortAvailableForForwarding();
      logger.debug(
        `[CTRL_PROXY] Setting up port forwarding for WebSocket: localhost:${this.localPort} → device:${PortManager.DEVICE_PORT} (device: ${this.device.deviceId})`,
      );

      if (this.localPort !== previousLocalPort) {
        await perf.track("clearReallocatedPortForward", () =>
          this.adb.executeCommand(`forward --remove tcp:${this.localPort}`).catch(() => {}),
        );
      }

      await perf.track("setupPortForward", () =>
        this.adb.executeCommand(`forward tcp:${this.localPort} tcp:${PortManager.DEVICE_PORT}`),
      );

      this.portForwardingSetup = true;
      logger.debug(`[CTRL_PROXY] Port forwarding setup complete (localhost:${this.localPort})`);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to setup port forwarding: ${error}`);
      throw error;
    }
  }

  /**
   * Check if port forwarding is still active by querying adb forward --list
   */
  private async isPortForwardingActive(): Promise<boolean> {
    try {
      const result = await this.adb.executeCommand("forward --list");
      const expectedForward = `tcp:${this.localPort} tcp:${PortManager.DEVICE_PORT}`;
      // Check if our port forward entry exists in the list
      // Format is: "serial tcp:localPort tcp:remotePort" per line
      const isActive = result.stdout.includes(expectedForward);
      if (!isActive) {
        logger.debug(
          `[CTRL_PROXY] Port forwarding not found in active forwards. Expected: ${expectedForward}`,
        );
      }
      return isActive;
    } catch (error) {
      logger.debug(`[CTRL_PROXY] Failed to check port forwarding status: ${error}`);
      return false;
    }
  }

  private async handleWebSocketMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());

      if (message.type === "connected") {
        this.supportedCommands = Array.isArray(message.supportedCommands)
          ? new Set(message.supportedCommands)
          : new Set();
        logger.debug(`[CTRL_PROXY] Received connection confirmation`);
        this.refreshObservationStreamHierarchyCadence();
        return;
      }

      // Structured protocol-boundary error from the runner (issue #2985): a command failed to
      // decode or its handler threw. Fail the correlated request fast instead of letting the
      // awaiter hang to timeout. requestId is best-effort — when null the runner could not
      // correlate it, so there is no pending request to resolve (resolveError no-ops on unknown
      // ids anyway).
      //
      // Fan the error out to ALL wait mechanisms, not just RequestManager: request_hierarchy does
      // not await through RequestManager, so an error frame for a hierarchy requestId must also be
      // routed into CtrlProxyHierarchy's bespoke wait or the hierarchy caller hangs to timeout
      // (issue #3032). Both calls are safe no-ops on unknown ids.
      if (message.type === "error") {
        const errorText = rewriteUnknownCommandError(
          message.error || "Runner reported an unstructured protocol error",
          "android",
        );
        logger.warn(
          `[CTRL_PROXY] Runner error (requestId: ${message.requestId ?? "none"}): ${errorText}`,
        );
        if (message.requestId) {
          this.requestManager.resolveError(message.requestId, errorText);
          this._hierarchy?.rejectPendingHierarchy(message.requestId, errorText);
        }
        return;
      }

      if (message.type === "hierarchy_update" && message.data) {
        this.handleHierarchyUpdate(message.data, message.perfTiming, message.frameContext);
      }

      // Handle screenshot response
      if (message.type === "screenshot" && message.requestId) {
        const suppressObservationStreamPush = this.screenshotObservationStreamSuppressions.delete(
          message.requestId,
        );
        const metadata = {
          ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, message.format),
          ...screenshotPerformanceMetadataFrom(message),
        };
        const binding = this.screenshotCaptureBindings.get(message.requestId);
        this.screenshotCaptureBindings.delete(message.requestId);
        if (!suppressObservationStreamPush) {
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
          ...screenshotPerformanceMetadataFrom(message),
        });
      }

      // Handle screenshot error
      if (message.type === "screenshot_error" && message.requestId) {
        logger.warn(
          `[CTRL_PROXY] Screenshot error (requestId: ${message.requestId}): ${message.error}`,
        );
        this.requestManager.resolve<ScreenshotResult>(message.requestId, {
          success: false,
          error: message.error || "Unknown error",
        });
      }

      // Handle swipe result
      if (message.type === "swipe_result") {
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
      }

      // Handle tap coordinates result
      if (message.type === "tap_coordinates_result") {
        logger.info(
          `[CTRL_PROXY] Tap coordinates result (requestId: ${message.requestId}, success: ${message.success})`,
        );

        if (message.requestId) {
          this.requestManager.resolve<A11yTapCoordinatesResult>(message.requestId, {
            success: message.success,
            totalTimeMs: message.totalTimeMs,
            error: message.error,
            perfTiming: message.perfTiming,
          });
        }
      }

      // Handle drag result
      if (message.type === "drag_result" && message.requestId) {
        this.requestManager.resolve<A11yDragResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          gestureTimeMs: message.gestureTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle pinch result
      if (message.type === "pinch_result" && message.requestId) {
        this.requestManager.resolve<A11yPinchResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          gestureTimeMs: message.gestureTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle set text result
      if (message.type === "set_text_result" && message.requestId) {
        this.requestManager.resolve<A11ySetTextResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle IME action result
      if (message.type === "ime_action_result" && message.requestId) {
        this.requestManager.resolve<A11yImeActionResult>(message.requestId, {
          success: message.success,
          action: message.action,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle select all result
      if (message.type === "select_all_result" && message.requestId) {
        this.requestManager.resolve<A11ySelectAllResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle action result
      if (message.type === "action_result" && message.requestId) {
        this.requestManager.resolve<A11yActionResult>(message.requestId, {
          success: message.success,
          action: message.action,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle clipboard result
      if (message.type === "clipboard_result" && message.requestId) {
        this.requestManager.resolve<A11yClipboardResult>(message.requestId, {
          success: message.success,
          action: message.action,
          text: message.text,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle settings results
      if (message.type === "settings_get_result" && message.requestId) {
        this.requestManager.resolve<A11ySettingsGetResult>(message.requestId, {
          success: message.success,
          value: message.value,
          found: message.found ?? false,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      if (message.type === "settings_put_result" && message.requestId) {
        this.requestManager.resolve<A11ySettingsPutResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      if (message.type === "settings_list_result" && message.requestId) {
        this.requestManager.resolve<A11ySettingsListResult>(message.requestId, {
          success: message.success,
          entries: message.entries,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle installed packages result
      if (message.type === "installed_packages_result" && message.requestId) {
        this.requestManager.resolve<A11yInstalledPackagesResult>(message.requestId, {
          success: message.success ?? false,
          userId: message.userId ?? -1,
          packages: message.packages ?? [],
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      // Handle package info result
      if (message.type === "package_info_result" && message.requestId) {
        this.requestManager.resolve<A11yPackageInfoResult>(message.requestId, {
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
        });
      }

      // Handle launch intent result
      if (message.type === "launch_intent_result" && message.requestId) {
        this.requestManager.resolve<A11yLaunchIntentResult>(message.requestId, {
          success: message.success ?? false,
          packageName: message.packageName ?? "",
          componentName: message.componentName,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      // Handle CA certificate result
      if (message.type === "ca_cert_result" && message.requestId) {
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

      // Handle device owner status result
      if (message.type === "device_owner_status_result" && message.requestId) {
        this.requestManager.resolve<A11yDeviceOwnerStatusResult>(message.requestId, {
          success: message.success,
          isDeviceOwner: message.isDeviceOwner ?? false,
          isAdminActive: message.isAdminActive ?? false,
          packageName: message.packageName,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }

      // Handle permission result
      if (message.type === "permission_result" && message.requestId) {
        this.requestManager.resolve<A11yPermissionResult>(message.requestId, {
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
        });
      }

      // Handle current focus result
      if (message.type === "current_focus_result" && message.requestId) {
        const focusedElement = message.focusedElement
          ? this.focus.convertAccessibilityNodeToElement(message.focusedElement)
          : null;

        this.requestManager.resolve<CurrentFocusResult>(message.requestId, {
          focusedElement,
          totalTimeMs: message.totalTimeMs,
          requestId: message.requestId,
          error: message.error,
        });
      }

      // Handle traversal order result
      if (message.type === "traversal_order_result" && message.requestId) {
        const result = message.result;

        if (result && result.elements) {
          const elements = result.elements.map((node: AccessibilityNode) =>
            this.focus.convertAccessibilityNodeToElement(node),
          );

          this.requestManager.resolve<TraversalOrderResult>(message.requestId, {
            elements,
            focusedIndex: result.focusedIndex,
            totalCount: result.totalCount,
            totalTimeMs: message.totalTimeMs,
            requestId: message.requestId,
            error: message.error,
          });
        } else {
          this.requestManager.resolve<TraversalOrderResult>(message.requestId, {
            elements: [],
            focusedIndex: null,
            totalCount: 0,
            totalTimeMs: message.totalTimeMs,
            requestId: message.requestId,
            error: message.error || "No result data",
          });
        }
      }

      // Handle highlight response
      if (message.type === "highlight_response" && message.requestId) {
        this.requestManager.resolve<HighlightOperationResult>(message.requestId, {
          success: message.success ?? false,
          error: message.error,
          requestId: message.requestId,
          timestamp: message.timestamp,
        });
      }

      // Handle global action result
      if (message.type === "global_action_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          action: message.action,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "frame_context_validation_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      // Handle device info result
      if (message.type === "device_info_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
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
        });
      }

      // Handle storage result messages
      // Note: Android sends "preference_files" but we register with "list_preference_files"
      if (message.type === "preference_files" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          files: message.files || [],
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      // Note: Android sends "preferences" but we register with "get_preferences"
      if (message.type === "preferences" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          entries: message.entries || [],
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "subscribe_storage_result" && message.requestId) {
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
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          subscription,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "unsubscribe_storage_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "get_preference_result" && message.requestId) {
        // Build entry from key/value/type fields (Android sends flat structure, not nested entry)
        const entry =
          message.found && message.key
            ? {
                key: message.key,
                value: message.value,
                type: message.type,
              }
            : undefined;
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          found: message.found ?? false,
          entry,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "set_preference_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "remove_preference_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      if (message.type === "clear_preferences_result" && message.requestId) {
        this.requestManager.resolve(message.requestId, {
          success: message.success ?? false,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        });
      }

      // Handle navigation event
      if (message.type === "navigation_event") {
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
          // Attach last interaction for telemetry correlation
          if (this.lastInteraction) {
            event.triggeringInteraction = {
              type: this.lastInteraction.type,
              elementText: this.lastInteraction.elementText,
              elementResourceId: this.lastInteraction.elementResourceId,
            };
          }

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

          if (
            event.applicationId &&
            event.destination &&
            serverConfig.isNavigationScreenshotsEnabled()
          ) {
            NavigationScreenshotManager.getInstance()
              .captureAndStore(this.device, this.adb, event.applicationId, event.destination)
              .then((screenshotPath) => {
                if (screenshotPath) {
                  this.getNavigationGraphManager()
                    .updateNodeScreenshot(event.applicationId!, event.destination!, screenshotPath)
                    .catch((err) =>
                      logger.warn(`[CTRL_PROXY] Failed to update screenshot: ${err}`),
                    );
                }
              })
              .catch((err) => logger.debug(`[CTRL_PROXY] Screenshot capture skipped: ${err}`));
          }
        }
      }

      if (message.type === "package_event") {
        const event = message.event;
        if (event) {
          await this.handlePackageEvent(event, message.timestamp);
        }
      }

      if (message.type === "interaction_event") {
        const interaction = message.event;
        if (interaction) {
          this.lastInteraction = {
            type: interaction.type,
            elementText: interaction.element?.text ?? undefined,
            elementResourceId: interaction.element?.["resource-id"] ?? undefined,
            timestamp: interaction.timestamp,
          };
          this.notifyInteractionListeners(interaction);
        }
      }

      if (message.type === "handled_exception_event") {
        const event = message.event;
        if (event) {
          await this.handleHandledExceptionEvent(event);
        }
      }

      if (message.type === "crash_event") {
        const event = message.event;
        if (event) {
          await this.handleCrashEvent(event);
        }
      }

      if (message.type === "anr_event") {
        const event = message.event;
        if (event) {
          await this.handleAnrEvent(event);
        }
      }

      if (message.type === "frame_metrics_event" && message.frameMetrics) {
        this.handleFrameMetricsEvent(message.frameMetrics);
      }

      // Handle telemetry events from SDK event batch. The fan-out to
      // TelemetryRecorder is owned by AndroidSdkEventIngestor (issue #2764); the
      // client only recognizes the wire type and forwards the typed event. These
      // telemetry messages are not part of the typed WebSocketMessage union, so
      // compare against a plain string type.
      const messageType = (message as { type: string }).type;
      if (SDK_TELEMETRY_EVENT_TYPES.has(messageType)) {
        const event = (message as { event?: Record<string, unknown> }).event;
        if (event) {
          await this.getSdkEventIngestor().recordSdkEvent(
            {
              type: messageType,
              timestamp: message.timestamp ?? this.timer.now(),
              payload: { event },
            },
            (event.applicationId as string) ?? null,
          );
        }
      }

      // Handle storage_changed push event
      if (message.type === "storage_changed") {
        const storageEvent: StorageChangedEvent = {
          packageName: message.packageName ?? "",
          fileName: message.fileName ?? "",
          key: message.key ?? null,
          value: message.value ?? null,
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
        this.getSdkEventIngestor().recordStorageEvent(
          storageTelemetryInputFromWire(message, storageEvent.timestamp),
        );
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error handling WebSocket message: ${error}`);
    }
  }

  private handleHierarchyUpdate(
    data: AccessibilityHierarchy,
    perfTiming?: AndroidPerfTiming[],
    frameContext?: string,
  ): void {
    const now = this.timer.now();
    logger.debug(
      `[CTRL_PROXY] Received hierarchy update (updatedAt: ${data.updatedAt}, receivedAt: ${now})`,
    );

    // Mark previous cache as stale
    if (this.cachedHierarchy) {
      this.cachedHierarchy.fresh = false;
    }

    // Update cache with fresh data
    this.cachedHierarchy = {
      hierarchy: data,
      receivedAt: now,
      fresh: true,
      perfTiming,
      frameContext,
    };

    // Update cached screen dimensions
    this.updateCachedScreenDimensions(data);

    const suppression = this.hierarchyObservationStreamSuppressions.values().next().value;
    const suppressObservationStreamPush = suppression !== undefined;
    if (suppression) {
      this.hierarchyObservationStreamSuppressions.delete(suppression);
      this.timer.clearTimeout(suppression.timeoutHandle);
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
      recorder.recordLayoutEvent({
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
      });
    }

    // Notify hierarchy navigation detector
    if (!data.hierarchy) {
      logger.warn("[CTRL_PROXY] Skipping navigation detection: hierarchy missing");
    } else if (data.error) {
      logger.warn(`[CTRL_PROXY] Skipping navigation detection due to error: ${data.error}`);
    } else if (!this.shouldUseHierarchyNavigation(data.packageName)) {
      logger.debug(`[CTRL_PROXY] Skipping hierarchy navigation for SDK app: ${data.packageName}`);
    } else {
      // Resolve build/device provenance for hierarchy-driven reaches too (#4984):
      // non-SDK apps never emit navigation_event, so this is the only path that gives
      // them a real build key instead of the default/legacy one.
      if (data.packageName) {
        this.ensureBuildContext(data.packageName);
      }
      this.getHierarchyNavigationDetector().onHierarchyUpdate(data);
    }
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

  private pushScreenshotToObservationStream(
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

  private updateCachedScreenDimensions(hierarchy: ViewHierarchyResult): void {
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
    // If we know the device doesn't support a11y screenshots, go straight to ADB fallback
    if (this.a11yScreenshotSupported === false) {
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

  /**
   * Fallback screenshot capture via ADB screencap for devices that don't support
   * accessibility service screenshots (API < 30).
   */
  private async captureScreenshotViaAdb(
    fallbackReason?: ScreenshotFallbackReason,
  ): Promise<ScreenshotCaptureResult> {
    // Bind the geometry current when the ADB request begins, before its await can let a newer
    // hierarchy relabel the returned pixels.
    const captureBinding = this.screenGeometry.bind() ?? undefined;

    try {
      const tempFile = "/sdcard/screenshot_stream.png";
      const command = `shell "screencap -p ${tempFile} && base64 ${tempFile} && rm ${tempFile}"`;
      const maxBuffer = 50 * 1024 * 1024;
      const result = await this.adb.executeCommand(command, undefined, maxBuffer);

      if (!result.stdout || result.stdout.trim().length === 0) {
        return { success: false, error: "No data from ADB screencap" };
      }

      const data = result.stdout.replace(/[\r\n]/g, "");
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
      return { success: false, error: `ADB screencap failed: ${error}` };
    }
  }

  private startScreenshotBackoff(): void {
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
          await repo.removeInstalledApp(deviceId, event.userId, event.packageName);
        }
      } else {
        const isSystem = event.isSystem === true;
        await repo.upsertInstalledApp(
          deviceId,
          event.userId,
          event.packageName,
          isSystem,
          eventTimestamp,
        );
      }

      // Notify work profile monitor that this user has accessibility service
      // (if we're receiving package events, the service is working for this user)
      if (event.userId > 0 && this.workProfileMonitor) {
        this.workProfileMonitor.setProfileHasAccessibilityService(event.userId, true);
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to apply package event: ${error}`);
    }
  }

  private enqueueNavigationGraphWrite(event: NavigationEvent): Promise<void> {
    const navigationGraphManager = this.getNavigationGraphManager();
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
    return this.supportedCommands?.has(messageType) === true;
  }

  private async waitForHandshake(
    timeoutMs: number = AndroidCtrlProxyClient.HANDSHAKE_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = this.timer.now() + timeoutMs;
    while (this.supportedCommands === null && this.timer.now() < deadline) {
      await this.timer.sleep(AndroidCtrlProxyClient.HANDSHAKE_POLL_INTERVAL_MS);
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
          fileName: fileName || undefined,
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
