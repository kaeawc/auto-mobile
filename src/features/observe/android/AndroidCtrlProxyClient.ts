import { AndroidInboundMessageRouter } from "./AndroidInboundMessageRouter";
import type {
  InteractionEvent,
  AndroidDisplayTransition,
  WsFrameMetricsMessage,
} from "./androidCtrlProxyInboundProtocol";
export type {
  InteractionEvent,
  AndroidDisplayTransition,
  StorageTelemetryInput,
  WebSocketMessage,
} from "./androidCtrlProxyInboundProtocol";
export {
  displayTransitionFromWire,
  normalizeStorageWireValue,
  storageTelemetryInputFromWire,
  parseCtrlProxyJson,
} from "./androidCtrlProxyInboundWire";
import {} from "./androidCtrlProxyInboundWire";

import type { PrototypeShowOverrides } from "../../prototype/PrototypeTransport";

import {
  type PrototypePatchRequest,
  type PrototypePatchReply,
} from "../../prototype/prototypePatchWire";
import { resetForeignCtrlProxyForwardEvidenceForTesting } from "./foreignCtrlProxyForwardEvidence";
import { isProcessRunning } from "../../../utils/processLiveness";

export { CTRL_PROXY_CONNECT_ATTEMPTS } from "./AndroidCtrlProxyPortForwarder";
import { AndroidCtrlProxyPortForwarder } from "./AndroidCtrlProxyPortForwarder";

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
import WebSocket from "ws";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger, type Logger } from "../../../utils/logger";

import type { ScreenIdentity } from "../../../models/ObserveResult";

import {
  HostForwardClientConnectionProbe,
  NoForwardClientConnectionProbe,
  type ForwardClientConnectionProbe,
} from "./CtrlProxyForwardClientProbe";
import {
  BootedDevice,
  ImeAction,
  ViewHierarchyResult,
  ScreenScaleMetadata,
  HighlightOperationResult,
  HighlightShape,
  toActionableError,
  ActionableError,
} from "../../../models";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import {
  ForcedRestartBudget,
  type ForcedRestartSnapshot,
} from "../../../ctrlProxy/ForcedRestartBudget";
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
import {
  AndroidServiceRecovery,
  OBSERVE_RECOVERY_WAIT_MS,
  type AndroidServiceManagerFactory,
} from "./AndroidServiceRecovery";
import { AndroidHierarchyUpdateHandler } from "./AndroidHierarchyUpdateHandler";
import { AndroidCtrlProxyDelegatingFacade } from "./AndroidCtrlProxyDelegatingFacade";
import { AndroidDeviceStateSync } from "./AndroidDeviceStateSync";
import { AndroidScreenshotCapture } from "./AndroidScreenshotCapture";
import { AndroidActionDispatcher } from "./AndroidActionDispatcher";
import { AndroidClientRequests } from "./AndroidClientRequests";
import { requireBootedDevice } from "../../../devices/requireBootedDevice";
import { WEBSOCKET_NOT_CONNECTED_MESSAGE, type SendCommandOptions } from "../DeviceServiceUtils";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import {
  TrackedScreenGeometry,
  screenshotBindingPushOptions,
  type ScreenGeometryBinding,
} from "../TrackedScreenGeometry";
import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import { COORDINATE_SPACE_PX } from "../../../daemon/canonicalPixels";
import { ScreenshotBackoffScheduler, ScreenshotCaptureResult } from "../ScreenshotBackoffScheduler";
import {
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  type ScreenshotMetadata,
} from "../ScreenshotMetadata";
import {} from "./screenshotFallbackReason";
import { AndroidPhysicalDisplayIdResolver } from "./AndroidPhysicalDisplayId";
import { type SdkAnrPayload, type SdkCrashPayload } from "../crash/sdkCrashIngestion";
import {
  AndroidSdkEventIngestor,
  DefaultAndroidSdkEventIngestor,
  type AndroidHandledExceptionEvent as HandledExceptionEvent,
} from "./AndroidSdkEventIngestor";
import { FailureEventRepository } from "../../../db/failureEventRepository";
import type { CrashEventSink } from "../../../utils/interfaces/CrashMonitor";
import { serverConfig } from "../../../utils/ServerConfig";
import { getSdkFrameMetricsStore } from "../../performance/SdkFrameMetricsStore";
import {
  AndroidAppEventRecorder,
  parseStackTrace,
  type AndroidPackageEvent as PackageEvent,
} from "./AndroidAppEventRecorder";
import {
  deviceIncarnationToken,
  registerDeviceIncarnationListener,
} from "../../../utils/deviceIncarnation";
import type { StackTraceElement } from "../../../server/failuresResources";
import {} from "../../../server/NetworkState";
import {
  NETWORK_MOCK_REPORT_TIMEOUT_MS,
  type NetworkMockPushResult,
  type NetworkMockRuleSync,
} from "../../../server/networkMockRules";
import { pushNetworkMockRules } from "./networkMockRulesPush";
import {
  ANDROID_CAPABILITY_GATED_COMMANDS,
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
  PROTOTYPE_DISPLAY_CAPABILITY,
  MULTI_FINGER_GESTURE_CAPABILITY,
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
  PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
  PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
  PROTOTYPE_SAVED_CAPABILITY,
  PROTOTYPE_MULTI_SURFACE_CAPABILITY,
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
} from "./ctrlProxyProtocol";
import type { StorageSubscription } from "../../storage/storageTypes";
import {
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
import {} from "../../../utils/screenshot/screenshotFormats";
import { shellQuote } from "../../../utils/shellQuote";
import {
  FileCtrlProxyForwardLease,
  NoOpCtrlProxyForwardLease,
  type CtrlProxyForwardLease,
} from "./CtrlProxyForwardLease";

// Import delegates
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyText, type ImeCommitActionResult } from "./CtrlProxyText";
import type { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import { CtrlProxyCertificates, type CertificateFileSystem } from "./CtrlProxyCertificates";
import { CtrlProxyFocus } from "./CtrlProxyFocus";
import { CtrlProxyPrototypes, type PrototypeAssetRequestOptions } from "./CtrlProxyPrototypes";
import type { PrototypeSpec } from "../../prototype/prototypeSpec";
import type { PrototypeAssetUpload } from "../../prototype/prototypeAssets";
import type {
  PrototypeAppearanceOverride,
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "./ctrlProxyProtocol";
import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import { CtrlProxyPackages, type PackageInfoOptions } from "./CtrlProxyPackages";

// Import types
import type { DelegateContext } from "../shared/types";
import { defaultPrototypeAssetCache } from "../../prototype/prototypeAssetCache";
import { defaultSavedPrototypeMirror } from "../../prototype/savedPrototypeMirror";
import type {
  HierarchyDelegateContext,
  CertificatesDelegateContext,
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
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
  AndroidPerfTiming,
  HierarchySyncDiagnostics,
  ObserverHierarchyRequestOptions,
} from "./types";

interface SdkRouteWaiter {
  sinceMs: number;
  settle(identity: ScreenIdentity | undefined): void;
}

/**
 * Interface for accessibility service providing Android UI hierarchy and interaction capabilities
 */
export interface AndroidCtrlProxy extends CtrlProxyClient {
  isLastConnectionFailureForwardingLeaseConflict?(): boolean;
  getLastConnectionFailureMessage?(): string | undefined;
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
    trace?: boolean,
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
    signal?: AbortSignal,
  ): Promise<A11ySettingsGetResult>;

  requestSettingsPut(
    namespace: SettingsNamespace,
    key: string,
    value: string | null,
    valueType?: SettingsValueType,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11ySettingsPutResult>;

  requestSettingsList(
    namespace: SettingsNamespace,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
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

  requestShowPrototype(
    spec: PrototypeSpec,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
    reset?: boolean,
    appearance?: PrototypeAppearanceOverride | PrototypeShowOverrides,
  ): Promise<PrototypeResult>;
  requestDismissPrototype(
    target: PrototypeDismiss,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestPatchPrototype(
    patch: PrototypePatchRequest,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypePatchReply>;
  requestSavePrototype(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestPinSavedPrototype(
    id: string,
    icon?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestListSavedPrototypes(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestDeleteSavedPrototype(
    id: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestInspectPrototypes(timeoutMs?: number, perf?: PerformanceTracker): Promise<PrototypeResult>;
  requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult>;
  requestRemovePrototypeAsset(
    id: string,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult>;
  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void;

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

function portAllocationIdForClient(
  deviceId: string,
  transientObserver: boolean,
  ids: IdGenerator,
): string {
  return transientObserver ? `${deviceId}:observer:${ids.next()}` : deviceId;
}

export type {
  AndroidServiceRecoveryManager,
  AndroidServiceManagerFactory,
} from "./AndroidServiceRecovery";

export interface AndroidCtrlProxyClientDeps {
  /** Creates the client's WebSocket transport. */
  webSocketFactory?: WebSocketFactory;
  /** Schedules connection and request deadlines. */
  timer?: Timer;
  /** Stores installed-app metadata. */
  installedAppsRepository?: InstalledAppsStore;
  /** Executes retryable operations. */
  retryExecutor?: RetryExecutor;
  /** Records app crash events. */
  crashEventSink?: CrashEventSink;
  /** Reports lost device connections. */
  deviceConnectionLostNotifier?: DeviceConnectionLostNotifier;
  /** Ingests SDK telemetry, crash, and ANR events. */
  sdkEventIngestor?: AndroidSdkEventIngestor;
  /** Logs client lifecycle and cleanup events. */
  logger?: Logger;
  /** Provides certificate file operations. */
  certificateFileSystem?: CertificateFileSystem;
  /** Coordinates ownership of the device's CtrlProxy forward. */
  ctrlProxyForwardLease?: CtrlProxyForwardLease;
  /** Creates the accessibility-service recovery manager. */
  serviceManagerFactory?: AndroidServiceManagerFactory;
  /** Generates client and request identifiers. */
  idGenerator?: IdGenerator;
  /** Creates a detached observer without service recovery or auto-reconnect. */
  transientObserver?: boolean;
}

type AndroidCtrlProxyClientLegacyTestArgs = [
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
  transientObserver?: boolean,
];

const defaultAndroidServiceManagerFactory: AndroidServiceManagerFactory = (device) =>
  AndroidCtrlProxyManager.getInstance(device);

/**
 * Client for interacting with the AutoMobile Accessibility Service via WebSocket.
 * Uses singleton pattern per device to maintain persistent WebSocket connection.
 */
/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const CTRL_PROXY_CLIENT_PURPOSE = "to drive the device through CtrlProxy";

export class AndroidCtrlProxyClient
  extends AndroidCtrlProxyDelegatingFacade
  implements AndroidCtrlProxy
{
  protected override get clientLogTag(): string {
    return "AndroidCtrlProxyClient";
  }

  /** Optional observer for display and posture changes. */
  onDisplayTransition?: (event: AndroidDisplayTransition) => void;
  private readonly streamedCaptureSequences = new WeakMap<object, number>();
  private static readonly DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250;

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
  /**
   * @internal Host TCP-table reader deciding whether an unrecorded forward is
   * still in use (#10690). Tests replace it; production reads lsof/netstat.
   */
  forwardClientProbe: ForwardClientConnectionProbe = new HostForwardClientConnectionProbe();
  /** @internal Injected liveness probe for sticky foreign-forward evidence. */
  forwardClientProcessIsRunning: (pid: number) => boolean = isProcessRunning;
  private ctrlProxyForwardLeaseReleaseScheduled: boolean = false;
  /** Set when shutdown released this client's lease before its close finished. */
  private forwardLeaseForceReleased: boolean = false;
  private inFlightConnection: Promise<boolean> | null = null;
  private cleanupHeldPort: number | null = null;
  private lastWebSocketTimeout: number = 0;

  private incarnationToken: string | undefined;
  private readinessHolds = 0;
  private forwardSetupFailure: string | undefined;
  private readonly inFlightMessageHandlers = new Set<Promise<void>>();
  // Match the bounded ADB forward-removal confirmation window during teardown.
  private static readonly INBOUND_HANDLER_DRAIN_TIMEOUT_MS = 2000;

  // Re-entry guard: a recovery burst that has not settled must not start a
  // second, overlapping recovery attempt.
  private isRecoveringService: boolean = false;
  /** A socket must survive this interval before it can rearm a restart. */
  private static readonly RESTART_REARM_STABILITY_MS = 2000;
  private restartRearmTimeout: NodeJS.Timeout | null = null;
  /** One client exists per device; this budget gates both failure bursts and observe calls. */
  private readonly forcedRestartBudget: ForcedRestartBudget;
  private serviceRecovery: AndroidServiceRecovery | undefined;
  public static readonly OBSERVE_RECOVERY_WAIT_MS = OBSERVE_RECOVERY_WAIT_MS;
  private readonly serviceManagerFactory: AndroidServiceManagerFactory;

  // Delegate instances (lazy initialized)
  private _gestures: CtrlProxyGestures | null = null;
  private _text: CtrlProxyText | null = null;
  private _hierarchy: CtrlProxyHierarchy | null = null;
  private _storage: CtrlProxyStorage | null = null;
  private _certificates: CtrlProxyCertificates | null = null;
  private _focus: CtrlProxyFocus | null = null;
  private _prototypes: CtrlProxyPrototypes | null = null;
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
  /** Newest AutoMobile SDK navigation route per reporting package, as a screen identity. */
  private sdkScreenIdentities = new Map<
    string,
    { identity: ScreenIdentity; receivedAtMs: number }
  >();
  /** Callers waiting for a route newer than a given host time, keyed by reporting package. */
  private sdkScreenIdentityWaiters = new Map<string, Set<SdkRouteWaiter>>();
  private navigationWriteTail: Promise<void> = Promise.resolve();

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
  get a11yScreenshotSupported(): boolean | null {
    return this.getScreenshotCapture().a11yScreenshotSupported;
  }
  set a11yScreenshotSupported(value: boolean | null) {
    this.getScreenshotCapture().a11yScreenshotSupported = value;
  }
  // Minimum interval between accessibility takeScreenshot() requests. The platform rate-limits
  // calls below its floor (~333ms, ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT); 350ms sits just
  // above it so a front-loaded backoff burst or an animation's restart storm cannot trip the
  // limit into needless ADB-screencap fallover (issue #4927).
  private static readonly A11Y_SCREENSHOT_MIN_INTERVAL_MS = 350;

  // Work profile monitor for polling profiles without accessibility service
  private workProfileMonitor: WorkProfileMonitor | null = null;

  private readonly rejectedCommands = new Set<string>();

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

  private readonly crashEventSink: CrashEventSink;
  private readonly deviceConnectionLostNotifier: DeviceConnectionLostNotifier;
  private readonly certificateFileSystem: CertificateFileSystem | undefined;

  private portForwarder: AndroidCtrlProxyPortForwarder | null = null;

  private appEventRecorder: AndroidAppEventRecorder | null = null;

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
    deps: AndroidCtrlProxyClientDeps = {},
  ) {
    super(
      deps.timer ?? defaultTimer,
      deps.webSocketFactory ?? defaultWebSocketFactory,
      { connectionResetMs: AndroidCtrlProxyClient.CONNECTION_RESET_MS },
      deps.retryExecutor ?? defaultRetryExecutor,
    );
    const {
      serviceManagerFactory = defaultAndroidServiceManagerFactory,
      idGenerator = defaultIdGenerator,
      logger: loggerInstance = logger,
      transientObserver,
    } = deps;
    this.forcedRestartBudget = new ForcedRestartBudget(this.timer);
    this.serviceManagerFactory = serviceManagerFactory;
    this.sdkEventIngestorInstance = deps.sdkEventIngestor ?? null;
    this.loggerInstance = loggerInstance;
    this.device = device;
    this.incarnationToken = AndroidCtrlProxyClient.currentIncarnationToken(device.deviceId);
    this.adb = adb;
    this.idGenerator = idGenerator;
    this.transientObserver = transientObserver === true;
    this.autoReconnectEnabled = transientObserver !== true;
    this.physicalDisplayIdResolver = new AndroidPhysicalDisplayIdResolver({ timer: this.timer });
    this.installedAppsRepository = deps.installedAppsRepository ?? null;
    this.crashEventSink = deps.crashEventSink ?? new FailureEventRepository();
    this.deviceConnectionLostNotifier =
      deps.deviceConnectionLostNotifier ?? observationStreamDeviceConnectionLostNotifier;
    this.certificateFileSystem = deps.certificateFileSystem;
    this.ctrlProxyForwardLease = this.resolveForwardLease(deps.ctrlProxyForwardLease);
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

  private resolveForwardLease(
    ctrlProxyForwardLease?: CtrlProxyForwardLease,
  ): CtrlProxyForwardLease {
    return ctrlProxyForwardLease ?? new FileCtrlProxyForwardLease(this.device.deviceId);
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
    const currentToken = AndroidCtrlProxyClient.currentIncarnationToken(deviceId);
    const existing = AndroidCtrlProxyClient.instances.get(deviceId);
    if (
      existing?.incarnationToken !== undefined &&
      currentToken !== undefined &&
      existing.incarnationToken !== currentToken
    ) {
      logger.info(
        `[CTRL_PROXY] Replacing client for ${deviceId}: incarnation ${existing.incarnationToken} -> ${currentToken}`,
      );
      void AndroidCtrlProxyClient.evictAfterDeviceRemoval(deviceId).catch((error) => {
        logger.warn(
          `[CTRL_PROXY] Failed to close old incarnation client for ${deviceId}: ${errorMessage(error)}`,
          error,
        );
      });
    } else if (existing && existing.incarnationToken === undefined) {
      existing.incarnationToken = currentToken;
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

  private static currentIncarnationToken(deviceId: string): string | undefined {
    // A retired client serves no runtime; preserve its inert resolution path.
    return AndroidCtrlProxyClient.retiredDeviceIds.has(deviceId)
      ? undefined
      : deviceIncarnationToken(deviceId);
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
    return new AndroidCtrlProxyClient(device, adbFactory.create(device), {
      ctrlProxyForwardLease:
        existing?.ctrlProxyForwardLease.fork?.() ?? existing?.ctrlProxyForwardLease,
      transientObserver: true,
    });
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
    resetForeignCtrlProxyForwardEvidenceForTesting();
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
    // An explicit startDevice/setup is a fresh start for forced-restart admission (#11246).
    AndroidCtrlProxyClient.instances
      .get(deviceId)
      ?.forcedRestartBudget.rearm("explicit device start");
    if (AndroidCtrlProxyClient.retiredDeviceIds.delete(deviceId)) {
      AndroidCtrlProxyClient.instances.delete(deviceId);
    }
  }

  /** The device re-entered the ready state; rearm only if recovery saw it absent (#11246). */
  public static noteDeviceOnline(deviceId: string): void {
    AndroidCtrlProxyClient.instances.get(deviceId)?.rearmAfterDeviceOnline();
  }

  private rearmAfterDeviceOnline(): void {
    this.getServiceRecovery().rearmAfterDeviceOnline();
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

  /** Evict before asynchronous cleanup so a reused serial gets a new client and port. */
  public static async evictAfterDeviceRemoval(deviceId: string): Promise<void> {
    const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
    if (!client) {
      return;
    }
    client.invalidateForShutdownRecovery();
    await client.close();
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public beginReadinessHold(): () => void {
    this.readinessHolds++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.readinessHolds--;
      }
    };
  }

  public getForwardFailureCause(): string | undefined {
    if (this.closed) {
      return `CtrlProxy client for ${this.device.deviceId} was closed (forwarding lease released or device removed) before an adb forward was established`;
    }
    return this.forwardSetupFailure;
  }

  /** Devices whose singleton client holds the cross-process forwarding lease. */
  public static getForwardLeaseHeldDeviceIds(): string[] {
    return [...AndroidCtrlProxyClient.instances.entries()]
      .filter(([, client]) => client.ctrlProxyForwardLease.isHeld?.() === true)
      .map(([deviceId]) => deviceId);
  }

  /**
   * CtrlProxy use of a device by this process (#10497): requests in flight
   * through its singleton and any detached observer, and time since the last
   * request or since the lease was taken, whichever is later. `null` when
   * this process neither holds the lease nor has used the device.
   */
  public static getForwardLeaseActivity(
    deviceId: string,
    timer: Timer = defaultTimer,
  ): { inFlightRequests: number; idleForMs: number | null } {
    const clients = [
      AndroidCtrlProxyClient.instances.get(deviceId),
      ...[...AndroidCtrlProxyClient.activeObservers].filter(
        (observer) => observer.device.deviceId === deviceId,
      ),
    ].filter((client): client is AndroidCtrlProxyClient => client !== undefined);
    const activities = clients.map((client) => client.getRequestActivity());
    const observers = clients.length - (AndroidCtrlProxyClient.instances.has(deviceId) ? 1 : 0);
    const lastTimes = [
      ...activities.map((activity) => activity.lastActivityAt),
      AndroidCtrlProxyClient.instances.get(deviceId)?.ctrlProxyForwardLease.getAcquiredAt?.(),
    ].filter((time): time is number => time !== undefined);
    return {
      // A live detached observer is a read in progress even between its requests.
      inFlightRequests:
        activities.reduce((sum, activity) => sum + activity.inFlightRequests, 0) +
        observers +
        clients.reduce((sum, client) => sum + client.readinessHolds, 0),
      idleForMs: lastTimes.length === 0 ? null : Math.max(0, timer.now() - Math.max(...lastTimes)),
    };
  }

  /**
   * Give up an idle device's forwarding lease (issue #10497): evict the
   * singleton first so a new call builds a fresh client that re-acquires the
   * lease, then close the old one, which removes its forward and releases it.
   */
  public static async releaseIdleForwardLease(deviceId: string): Promise<void> {
    const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
    if (!client) {
      return;
    }
    AndroidCtrlProxyClient.removeInstanceIfCurrent(deviceId, client);
    await client.close();
  }

  /**
   * Graceful daemon stop: close every client this process holds (removing the
   * forwards it recorded, never unrecorded ones) and release its forwarding
   * leases, so the next daemon need not reclaim them. Bounded by `timeoutMs`:
   * a hung adb must not block shutdown, so on timeout the leases are released
   * anyway while the recorded forward stays on disk for the next daemon.
   */
  public static async releaseForwardLeasesForShutdown(
    timer: Timer,
    timeoutMs: number,
  ): Promise<void> {
    const clients = new Set<AndroidCtrlProxyClient>([
      ...AndroidCtrlProxyClient.instances.values(),
      ...AndroidCtrlProxyClient.activeObservers,
    ]);
    if (clients.size === 0) {
      return;
    }
    AndroidCtrlProxyClient.instances.clear();
    const closes = [...clients].map((client) =>
      client.close().catch((error) => {
        logger.warn(
          `[CTRL_PROXY] Failed to close CtrlProxy client for ${client.device.deviceId} during shutdown: ${errorMessage(error)}`,
          error,
        );
      }),
    );
    const timedOut = Symbol("ctrlproxy shutdown release timeout");
    try {
      await raceWithDeadline(Promise.all(closes), {
        timer,
        timeoutMs,
        label: "CtrlProxy forward lease shutdown release",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.warn(
        `[CTRL_PROXY] Timed out after ${timeoutMs}ms removing CtrlProxy forwards during shutdown; ` +
          `releasing forwarding leases anyway`,
      );
      for (const client of clients) {
        // A close still stuck on adb must not later remove a forward that a
        // successor daemon creates on the freed lease and port (#10690).
        client.forwardLeaseForceReleased = true;
        client.ctrlProxyForwardLease.release();
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

  protected override onSessionRebound(): void {
    // A new session is a fresh owner: do not let a previous session's exhausted budget strand it.
    this.forcedRestartBudget.rearm("new session bound");
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
   * The newest AutoMobile SDK navigation route the app reported, when the app embeds the SDK.
   * Single-activity Compose apps name their screens only this way.
   */
  public getSdkScreenIdentity(applicationId?: string): ScreenIdentity | undefined {
    return applicationId ? this.sdkScreenIdentities.get(applicationId)?.identity : undefined;
  }

  /** Host time (this client's timer) at which the app's newest SDK route arrived. */
  public getSdkScreenIdentityReceivedAtMs(applicationId: string): number | undefined {
    return this.sdkScreenIdentities.get(applicationId)?.receivedAtMs;
  }

  /**
   * Resolve with the app's SDK route once one newer than `sinceMs` has arrived, or undefined after
   * `timeoutMs` (or when the app's route is cleared first). Returns at once for a route that
   * already postdates `sinceMs`.
   */
  public awaitSdkScreenIdentityAfter(
    applicationId: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<ScreenIdentity | undefined> {
    const current = this.sdkScreenIdentities.get(applicationId);
    if (current && current.receivedAtMs > sinceMs) {
      return Promise.resolve(current.identity);
    }
    return new Promise((resolve) => {
      const waiters = this.sdkScreenIdentityWaiters.get(applicationId) ?? new Set();
      this.sdkScreenIdentityWaiters.set(applicationId, waiters);
      const waiter: SdkRouteWaiter = {
        sinceMs,
        settle: (identity) => {
          this.timer.clearTimeout(handle);
          waiters.delete(waiter);
          resolve(identity);
        },
      };
      const handle = this.timer.setTimeout(() => waiter.settle(undefined), timeoutMs);
      waiters.add(waiter);
    });
  }

  /**
   * Forget the SDK navigation route of an app whose process was replaced (terminated, relaunched
   * cold, data cleared, crashed), or of every app when none is named (the SDK link was lost). The
   * next route event the new process reports is the only thing that names its screen again.
   */
  public clearSdkScreenIdentity(applicationId?: string): void {
    const applicationIds = applicationId
      ? [applicationId]
      : [...new Set([...this.sdkScreenIdentities.keys(), ...this.sdkScreenIdentityWaiters.keys()])];
    for (const id of applicationIds) {
      this.sdkScreenIdentities.delete(id);
      for (const waiter of [...(this.sdkScreenIdentityWaiters.get(id) ?? [])]) {
        waiter.settle(undefined);
      }
    }
  }

  private recordSdkScreenIdentity(applicationId: string, identity: ScreenIdentity): void {
    const receivedAtMs = this.timer.now();
    this.sdkScreenIdentities.set(applicationId, { identity, receivedAtMs });
    for (const waiter of [...(this.sdkScreenIdentityWaiters.get(applicationId) ?? [])]) {
      if (receivedAtMs > waiter.sinceMs) {
        waiter.settle(identity);
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

  /** Keep mutable test seams and post-await state live without exposing connection lifecycle. */
  private hierarchyUpdateHandler: AndroidHierarchyUpdateHandler | undefined;
  private getHierarchyUpdateHandler(): AndroidHierarchyUpdateHandler {
    if (!this.hierarchyUpdateHandler) {
      const client = this;
      this.hierarchyUpdateHandler = new AndroidHierarchyUpdateHandler({
        get timer() {
          return client.timer;
        },
        get deviceId() {
          return client.device.deviceId;
        },
        get transientObserver() {
          return client.transientObserver;
        },
        get hierarchy() {
          return client.hierarchy;
        },
        get observerHierarchyRequestIds() {
          return client.observerHierarchyRequestIds;
        },
        get hierarchyObservationStreamSuppressions() {
          return client.hierarchyObservationStreamSuppressions;
        },
        get sdkNavigationAppIds() {
          return client.sdkNavigationAppIds;
        },
        get cachedHierarchy() {
          return client.cachedHierarchy;
        },
        set cachedHierarchy(value) {
          client.cachedHierarchy = value;
        },
        get lastForegroundPackage() {
          return client.lastForegroundPackage;
        },
        set lastForegroundPackage(value) {
          client.lastForegroundPackage = value;
        },
        removeHierarchyObservationStreamSuppression: (requestId) =>
          client.removeHierarchyObservationStreamSuppression(requestId),
        updateCachedScreenDimensions: (hierarchy) => client.updateCachedScreenDimensions(hierarchy),
        pushHierarchyToObservationStream: (hierarchy, frameContext) =>
          client.pushHierarchyToObservationStream(hierarchy, frameContext),
        startScreenshotBackoff: () => client.startScreenshotBackoff(),
        getNavigationGraphManager: () => client.getNavigationGraphManager(),
        ensureBuildContext: (packageName) => client.ensureBuildContext(packageName),
        getHierarchyNavigationDetector: () => client.getHierarchyNavigationDetector(),
      });
    }
    return this.hierarchyUpdateHandler;
  }

  private screenshotCapture: AndroidScreenshotCapture | undefined;
  private getScreenshotCapture(): AndroidScreenshotCapture {
    if (!this.screenshotCapture) {
      const client = this;
      this.screenshotCapture = new AndroidScreenshotCapture({
        get adb() {
          return client.adb;
        },
        get timer() {
          return client.timer;
        },
        get deviceId() {
          return client.device.deviceId;
        },
        get closed() {
          return client.closed;
        },
        get logger() {
          return client.loggerInstance;
        },
        get idGenerator() {
          return client.idGenerator;
        },
        get physicalDisplayIdResolver() {
          return client.physicalDisplayIdResolver;
        },
        get screenGeometry() {
          return client.screenGeometry;
        },
        get requestManager() {
          return client.requestManager;
        },
        get screenshotObservationStreamSuppressions() {
          return client.screenshotObservationStreamSuppressions;
        },
        get socket() {
          return client.ws;
        },
        noteScreenshotCaptureStarted: () =>
          client.getScreenshotBackoffScheduler().noteCaptureStarted(),
      });
    }
    return this.screenshotCapture;
  }

  private resetA11yScreenshotSupport(): void {
    this.getScreenshotCapture().resetA11yScreenshotSupport();
  }

  private actionDispatcher: AndroidActionDispatcher | undefined;
  private getActionDispatcher(): AndroidActionDispatcher {
    if (!this.actionDispatcher) {
      const client = this;
      this.actionDispatcher = new AndroidActionDispatcher({
        get timer() {
          return client.timer;
        },
        get requestManager() {
          return client.requestManager;
        },
        get pendingFocusedInputClickIds() {
          return client.pendingFocusedInputClickIds;
        },
        get supportedCommands() {
          return client.supportedCommands;
        },
        awaitActionWork: (work, signal) => client.awaitActionWork(work, signal),
        awaitCancellableRequest: (requestId, promise, signal, startTime) =>
          client.awaitCancellableRequest(requestId, promise, signal, startTime),
        connectWebSocket: (perf) => client.connectWebSocket(perf),
        waitForHandshake: (timeoutMs, signal) => client.waitForHandshake(timeoutMs, signal),
        isCommandSupported: (messageType) => client.isCommandSupported(messageType),
        cancelScreenshotBackoff: () => client.cancelScreenshotBackoff(),
        createDelegateContext: () => client.createDelegateContext(),
      });
    }
    return this.actionDispatcher;
  }

  private clientRequests: AndroidClientRequests | undefined;
  private getClientRequests(): AndroidClientRequests {
    if (!this.clientRequests) {
      const client = this;
      this.clientRequests = new AndroidClientRequests({
        get timer() {
          return client.timer;
        },
        get requestManager() {
          return client.requestManager;
        },
        get logger() {
          return client.loggerInstance;
        },
        get actions() {
          return client.getActionDispatcher();
        },
        isConnected: () => client.isConnected(),
        connectWebSocket: (perf) => client.connectWebSocket(perf),
        createDelegateContext: () => client.createDelegateContext(),
        awaitActionWork: (work, signal) => client.awaitActionWork(work, signal),
      });
    }
    return this.clientRequests;
  }

  private getServiceRecovery(): AndroidServiceRecovery {
    if (!this.serviceRecovery) {
      const client = this;
      this.serviceRecovery = new AndroidServiceRecovery({
        get adb() {
          return client.adb;
        },
        get timer() {
          return client.timer;
        },
        get deviceId() {
          return client.device.deviceId;
        },
        get device() {
          return client.device;
        },
        get closed() {
          return client.closed;
        },
        get connectionGeneration() {
          return client.connectionGeneration;
        },
        get consecutiveConnectionFailures() {
          return client.consecutiveConnectionFailures;
        },
        set consecutiveConnectionFailures(value: number) {
          client.consecutiveConnectionFailures = value;
        },
        get isRecoveringService() {
          return client.isRecoveringService;
        },
        set isRecoveringService(value: boolean) {
          client.isRecoveringService = value;
        },
        get recoveryPromise() {
          return client.recoveryPromise;
        },
        set recoveryPromise(value: Promise<boolean> | null) {
          client.recoveryPromise = value;
        },
        get forcedRestartBudget() {
          return client.forcedRestartBudget;
        },
        get serviceManagerFactory() {
          return client.serviceManagerFactory;
        },
        get restartRearmPending() {
          return client.restartRearmTimeout !== null;
        },
        get socket() {
          return client.ws;
        },
        isConnected: () => client.isConnected(),
        resetConnectionBudget: () => client.resetConnectionBudget(),
        connectBackgroundWebSocket: () => client.connectBackgroundWebSocket(),
      });
    }
    return this.serviceRecovery;
  }

  private getPortForwarder(): AndroidCtrlProxyPortForwarder {
    if (!this.portForwarder) {
      const client = this;
      this.portForwarder = new AndroidCtrlProxyPortForwarder({
        get adb() {
          return client.adb;
        },
        get timer() {
          return client.timer;
        },
        get deviceId() {
          return client.device.deviceId;
        },
        get ctrlProxyForwardLease() {
          return client.ctrlProxyForwardLease;
        },
        get forwardClientProbe() {
          return client.forwardClientProbe;
        },
        get forwardClientProcessIsRunning() {
          return client.forwardClientProcessIsRunning;
        },
        get closed() {
          return client.closed;
        },
        get localPort() {
          return client.localPort;
        },
        set localPort(value) {
          client.localPort = value;
        },
        get portAllocationId() {
          return client.portAllocationId;
        },
        get portForwardingSetup() {
          return client.portForwardingSetup;
        },
        set portForwardingSetup(value) {
          client.portForwardingSetup = value;
        },
        get forwardLeaseForceReleased() {
          return client.forwardLeaseForceReleased;
        },
        set forwardSetupFailure(failure: string | undefined) {
          client.forwardSetupFailure = failure;
        },
        getLiveLocalPorts: () =>
          new Set(
            [
              ...AndroidCtrlProxyClient.instances.values(),
              ...AndroidCtrlProxyClient.activeObservers,
            ]
              .filter((other) => other.device.deviceId === this.device.deviceId && !other.closed)
              .map((other) => other.localPort),
          ),
      });
    }
    return this.portForwarder;
  }

  /** Resolve collaborators lazily so injected stores and session-bound ingestors stay live. */
  private getAppEventRecorder(): AndroidAppEventRecorder {
    if (!this.appEventRecorder) {
      this.appEventRecorder = new AndroidAppEventRecorder({
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        timer: this.timer,
        crashEventSink: this.crashEventSink,
        getSdkEventIngestor: () => this.getSdkEventIngestor(),
        getInstalledAppsStore: () => this.getInstalledAppsRepository(),
        getWorkProfileMonitor: () => this.workProfileMonitor,
        invalidateBuildContext: (appId) => this.invalidateBuildContext(appId),
        getLastForegroundPackage: () => this.lastForegroundPackage,
        // Resolve the module exports per call so later spies and singleton swaps are honoured.
        getFrameMetricsStore: () => getSdkFrameMetricsStore(),
        getInstalledAppsCacheWriteCoordinator: () => getInstalledAppsCacheWriteCoordinator(),
        getDbWriteBarrier: () => getDbWriteBarrier(),
      });
    }
    return this.appEventRecorder;
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    resetForeignCtrlProxyForwardEvidenceForTesting();
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
    deps?: AndroidCtrlProxyClientDeps & { screenshotBackoffScheduler?: ScreenshotBackoffScheduler },
  ): AndroidCtrlProxyClient;
  /** @deprecated Pass an AndroidCtrlProxyClientDeps object instead of positional dependencies. */
  public static createForTesting(
    device: BootedDevice,
    adb: AdbExecutor,
    webSocketFactory: WebSocketFactory,
    ...args: AndroidCtrlProxyClientLegacyTestArgs
  ): AndroidCtrlProxyClient;
  public static createForTesting(
    device: BootedDevice,
    adb: AdbExecutor,
    depsOrWebSocketFactory?:
      | (AndroidCtrlProxyClientDeps & { screenshotBackoffScheduler?: ScreenshotBackoffScheduler })
      | WebSocketFactory,
    ...args: AndroidCtrlProxyClientLegacyTestArgs
  ): AndroidCtrlProxyClient {
    const [
      timer,
      installedAppsRepository,
      retryExecutor,
      crashEventSink,
      deviceConnectionLostNotifier,
      sdkEventIngestor,
      loggerInstance,
      certificateFileSystem,
      screenshotBackoffScheduler,
      ctrlProxyForwardLease,
      serviceManagerFactory,
      idGenerator,
      transientObserver = false,
    ] = args;
    // Positional form: a factory, or an explicit `undefined` factory followed by later positional
    // arguments such as the timer. Anything else is the deps bag.
    const isPositional =
      typeof depsOrWebSocketFactory === "function" ||
      (depsOrWebSocketFactory === undefined && args.length > 0);
    const deps: AndroidCtrlProxyClientDeps & {
      screenshotBackoffScheduler?: ScreenshotBackoffScheduler;
    } = isPositional
      ? {
          webSocketFactory:
            typeof depsOrWebSocketFactory === "function" ? depsOrWebSocketFactory : undefined,
          timer,
          installedAppsRepository,
          retryExecutor,
          crashEventSink,
          deviceConnectionLostNotifier,
          sdkEventIngestor,
          logger: loggerInstance,
          certificateFileSystem,
          screenshotBackoffScheduler,
          ctrlProxyForwardLease,
          serviceManagerFactory,
          idGenerator,
          transientObserver,
        }
      : (depsOrWebSocketFactory ?? {});
    const client = new AndroidCtrlProxyClient(device, adb, {
      ...deps,
      ctrlProxyForwardLease: deps.ctrlProxyForwardLease ?? new NoOpCtrlProxyForwardLease(),
      serviceManagerFactory: deps.serviceManagerFactory ?? defaultAndroidServiceManagerFactory,
    });
    // Unit tests never read the real host's TCP table.
    client.forwardClientProbe = new NoForwardClientConnectionProbe();
    // Test-only seam: pre-seed the lazily-built scheduler so tests can assert shared floor
    // accounting (noteCaptureStarted) without the live device-data-stream server. Not exposed on
    // the production getInstance path.
    if (deps.screenshotBackoffScheduler) {
      client.screenshotBackoffScheduler = deps.screenshotBackoffScheduler;
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
    return new AndroidCtrlProxyClient(device, adb, { webSocketFactory, timer });
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
      prototypeAssetCache: { serial: this.device.deviceId, cache: defaultPrototypeAssetCache() },
      savedPrototypeMirror: { serial: this.device.deviceId, mirror: defaultSavedPrototypeMirror() },
      isCommandSupported: (messageType) =>
        messageType === PROTOTYPE_SAVED_CAPABILITY
          ? this.supportedCommands?.has(messageType) === true
          : this.isCommandSupported(messageType),
      getSupportedCommands: () => this.getSupportedCommands(),
      idGenerator: this.idGenerator,
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

  protected get gestures(): CtrlProxyGestures {
    return this.lazyDelegate(
      () => this._gestures,
      (value) => {
        this._gestures = value;
      },
      () => new CtrlProxyGestures(this.createDelegateContext()),
    );
  }

  protected get text(): CtrlProxyText {
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

  protected get storage(): CtrlProxyStorage {
    return this.lazyDelegate(
      () => this._storage,
      (value) => {
        this._storage = value;
      },
      () => new CtrlProxyStorage(this.createDelegateContext()),
    );
  }

  protected get certificates(): CtrlProxyCertificates {
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

  protected get focus(): CtrlProxyFocus {
    return this.lazyDelegate(
      () => this._focus,
      (value) => {
        this._focus = value;
      },
      () => new CtrlProxyFocus(this.createDelegateContext()),
    );
  }

  protected get prototypes(): CtrlProxyPrototypes {
    return this.lazyDelegate(
      () => this._prototypes,
      (value) => {
        this._prototypes = value;
      },
      () => new CtrlProxyPrototypes(this.createDelegateContext()),
    );
  }

  protected get highlights(): CtrlProxyHighlights {
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
      this.getServiceRecovery().onStabilityTimerFired();
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
   * Push THIS device's mock rules for a `mockNetwork`/`clearMockNetwork` call and wait (bounded)
   * for the rules the app's regex engine rejected (issue #10101). A runner or SDK that does not
   * report resolves to `unconfirmed`; only an undelivered push is a failure.
   */
  async pushNetworkMockRules(
    rules: NetworkMockRuleSync[],
    timeoutMs: number = NETWORK_MOCK_REPORT_TIMEOUT_MS,
  ): Promise<NetworkMockPushResult> {
    return pushNetworkMockRules(
      this.createDelegateContext(),
      rules,
      () =>
        this.sendMessage(
          serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules })),
        ),
      timeoutMs,
    );
  }

  /**
   * Push THIS device's mock rules and error simulation from the host store.
   * Runs on every (re)connect, and after a session release clears the store so
   * the device drops what that session installed (issue #10061).
   */
  public syncNetworkStateToDevice(): void {
    this.getDeviceStateSync().syncNetworkState();
  }

  private syncAccessibilityFlagsToDevice(): void {
    this.getDeviceStateSync().syncAccessibilityFlags();
  }

  private deviceStateSync: AndroidDeviceStateSync | undefined;
  private getDeviceStateSync(): AndroidDeviceStateSync {
    this.deviceStateSync ??= new AndroidDeviceStateSync({
      deviceId: this.device.deviceId,
      sendMessage: (message) => this.sendMessage(message),
    });
    return this.deviceStateSync;
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public onConnectionClosed(): void {
    const rearmTimerWasArmed = this.restartRearmTimeout !== null;
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
    this.getServiceRecovery().onSocketClosed(rearmTimerWasArmed);
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
    // The SDK reports through this link: after a reconnect the app process may be a new one, and a
    // route from before the gap cannot be told apart from the new process's.
    this.clearSdkScreenIdentity();
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

  /** Every app id with cached or in-flight build-context state (#4984). */
  private knownBuildContextApps(): string[] {
    return Array.from(
      new Set([...this.resolvedBuildContexts.keys(), ...this.buildContextInFlight]),
    );
  }

  /**
   * Whether a failed attempt counts toward escalating to service recovery (issue #7532).
   * The shared `DeviceServiceClient.onConnectAttemptFailed` funnel (#7537) calls this once per
   * failed dial AND once per lost open connection, so both refused dials and dropped
   * connections count toward the threshold. Android additionally skips a failure caused by a
   * foreign forwarding-lease conflict.
   */
  protected override shouldCountConnectionFailure(): boolean {
    return !this.isLastConnectionFailureForwardingLeaseConflict();
  }

  protected override onConnectionFailureThresholdReached(): void {
    if (!this.isRecoveringService) {
      this.getServiceRecovery().trigger();
    }
  }

  /** Start a recovery for this observed transport failure if none is pending. */
  public ensureRecoveryStarted(): void {
    this.getServiceRecovery().ensureStarted(this.autoReconnectEnabled);
  }

  /** Current forced-restart admission state, for typed observe/action failure reasons. */
  public getRestartBudgetSnapshot(): ForcedRestartSnapshot {
    return this.forcedRestartBudget.snapshot();
  }

  public isRecoveryInFlight(): boolean {
    return this.recoveryPromise !== null;
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
    ...args: Parameters<CtrlProxyHierarchy["getAccessibilityHierarchy"]>
  ): Promise<ViewHierarchyResult | null> {
    return this.hierarchy.getAccessibilityHierarchy(...args);
  }

  async setRecompositionTrackingEnabled(
    enabled: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.hierarchy.setRecompositionTrackingEnabled(enabled, perf, signal);
  }

  async getLatestHierarchy(
    ...args: Parameters<CtrlProxyHierarchy["getLatestHierarchy"]>
  ): Promise<AccessibilityHierarchyResponse> {
    return this.hierarchy.getLatestHierarchy(...args);
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

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    // Older APKs do not know this optional command; absence retains legacy suffix settling.
    if (!(await this.supportsCommand("request_insert_text_state"))) {
      return { success: true };
    }
    return this.text.requestInsertTextState();
  }

  async subscribeStorage(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<StorageSubscription> {
    // A provider call into an app without a process starts that process, and the next subscribe
    // then fails with a misleading "inspection is disabled" (#10246). Decide "not running" here,
    // before any provider call, so a refused subscribe leaves the app stopped.
    if (!(await this.isAppProcessRunning(packageName))) {
      throw new ActionableError(
        `Cannot subscribe to storage: ${packageName} is not running. Launch the app first (launchApp) and subscribe again.`,
      );
    }
    return this.storage.subscribeStorage(packageName, fileName, timeoutMs);
  }

  /** True when the app has a live process; a failed probe counts as not running. */
  private async isAppProcessRunning(packageName: string): Promise<boolean> {
    try {
      const result = await this.adb.executeCommand(`shell pidof ${shellQuote(packageName)}`);
      return result.stdout.trim().length > 0;
    } catch (error) {
      // pidof exits non-zero when no process matches; that is the expected "not running" answer.
      logger.debug(`pidof ${packageName} found no process: ${error}`);
      return false;
    }
  }

  // ===========================================================================
  // Non-delegated Public Methods
  // ===========================================================================

  async requestAction(
    action: string,
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    selector?: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestAction(
      action,
      resourceId,
      timeoutMs,
      perf,
      selector,
      signal,
    );
  }

  async requestClickFocusedInput(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestClickFocusedInput(timeoutMs, perf, signal);
  }

  private settleUnattributedFocusedClickRejection(
    requestId: string | null | undefined,
    rejectedCommand: string | undefined,
    errorText: string,
  ): void {
    this.getActionDispatcher().settleUnattributedFocusedClickRejection(
      requestId,
      rejectedCommand,
      errorText,
    );
  }

  /** These legacy client requests bypass the generic capability/deadline gate. */
  private sendClientCommand<T extends { success: boolean; totalTimeMs: number; error?: string }>(
    requestId: string,
    serializeRequest: (requestId: string) => string,
    options: Pick<
      SendCommandOptions<T>,
      "responseType" | "messageType" | "timeoutMs" | "responseError" | "beforeSend" | "onDispatch"
    > & { timeoutError: (timeoutMs: number) => T },
    cancellation?: { signal: AbortSignal | undefined; startTime: number },
    perf?: PerformanceTracker,
  ): Promise<T> {
    return this.getActionDispatcher().sendClientCommand<T>(
      requestId,
      serializeRequest,
      options,
      cancellation,
      perf,
    );
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestNodeAction(action, selector, timeoutMs, perf, signal);
  }

  async supportsNodeActionSelectors(
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.getActionDispatcher().supportsNodeActionSelectors(perf, signal);
  }

  public async supportsCommand(name: string): Promise<boolean> {
    return (await this.getSupportedCommands())?.includes(name) === true;
  }

  async supportsAccessibilityLinkActivation(perf?: PerformanceTracker): Promise<boolean> {
    return this.getActionDispatcher().supportsAccessibilityLinkActivation(perf);
  }

  // Keep existing positional arguments compatible while adding cancellation and dispatch tracking.
  // oxlint-disable-next-line max-params
  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestActivateAccessibilityLink(
      text,
      occurrence,
      selector,
      timeoutMs,
      perf,
      signal,
      onDispatch,
    );
  }

  requestClipboard(
    ...args: Parameters<AndroidClientRequests["requestClipboard"]>
  ): ReturnType<AndroidClientRequests["requestClipboard"]> {
    return this.getClientRequests().requestClipboard(...args);
  }

  requestSettingsGet(
    ...args: Parameters<AndroidClientRequests["requestSettingsGet"]>
  ): ReturnType<AndroidClientRequests["requestSettingsGet"]> {
    return this.getClientRequests().requestSettingsGet(...args);
  }

  requestSettingsPut(
    ...args: Parameters<AndroidClientRequests["requestSettingsPut"]>
  ): ReturnType<AndroidClientRequests["requestSettingsPut"]> {
    return this.getClientRequests().requestSettingsPut(...args);
  }

  requestSettingsList(
    ...args: Parameters<AndroidClientRequests["requestSettingsList"]>
  ): ReturnType<AndroidClientRequests["requestSettingsList"]> {
    return this.getClientRequests().requestSettingsList(...args);
  }

  requestGlobalAction(
    ...args: Parameters<AndroidClientRequests["requestGlobalAction"]>
  ): ReturnType<AndroidClientRequests["requestGlobalAction"]> {
    return this.getClientRequests().requestGlobalAction(...args);
  }

  validateFrameContext(
    ...args: Parameters<AndroidClientRequests["validateFrameContext"]>
  ): ReturnType<AndroidClientRequests["validateFrameContext"]> {
    return this.getClientRequests().validateFrameContext(...args);
  }

  requestDeviceInfo(
    ...args: Parameters<AndroidClientRequests["requestDeviceInfo"]>
  ): ReturnType<AndroidClientRequests["requestDeviceInfo"]> {
    return this.getClientRequests().requestDeviceInfo(...args);
  }

  private awaitCancellableRequest<
    T extends { success: boolean; totalTimeMs: number; error?: string },
  >(
    requestId: string,
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    startTime: number,
  ): Promise<T> {
    return this.getClientRequests().awaitCancellableRequest(requestId, promise, signal, startTime);
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
    hidePrototypes = false,
  ): Promise<void> {
    if (signal?.aborted) {
      // Settle the registration we just made so it neither waits out its
      // timeout nor accepts a late response.
      this.requestManager.resolveError(sentRequestId, OPERATION_CANCELLED_MESSAGE);
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(WEBSOCKET_NOT_CONNECTED_MESSAGE);
    }
    const message = serializeCtrlProxyRequest(
      ctrlProxyRequests.requestScreenshot({
        requestId: sentRequestId,
        displayId,
        // A capability flag, never a request type: the legacy "assume supported" path must not
        // apply, or an older APK would silently capture with the prototype showing.
        hidePrototypes:
          hidePrototypes &&
          this.supportedCommands?.has(SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY) === true,
      }),
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

  /**
   * `hidePrototypes` asks the device to hide its prototype for this capture (#9305); it is sent only
   * to a CtrlProxy advertising `screenshot_hide_prototype_v1`, and the result's `prototypesHidden`
   * reports the outcome.
   */
  async requestScreenshot(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    suppressObservationStreamPush: boolean = false,
    signal?: AbortSignal,
    displayId?: number,
    hidePrototypes: boolean = false,
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
        this.dispatchScreenshotRequest(sentRequestId, signal, displayId, hidePrototypes),
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
    this.getServiceRecovery().failPendingStability("Client closed before stable reconnect");
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

  private ensureLocalPortAvailableForForwarding(signal?: AbortSignal): Promise<void> {
    return this.getPortForwarder().ensureLocalPortAvailableForForwarding(signal);
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  setupPortForwarding(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    return this.getPortForwarder().setupPortForwarding(perf, signal);
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
  sweepOrphanedCtrlProxyPortForwards(signal?: AbortSignal): Promise<void> {
    return this.getPortForwarder().sweepOrphanedCtrlProxyPortForwards(signal);
  }

  /**
   * Remove a forward only when it still maps this device and host port to the
   * CtrlProxy device port. Re-listing closes the race with a different service
   * reusing the host port after the orphan sweep discovered it.
   *
   * @returns `true` when no matching forward remains; `false` when adb failed
   * to establish that state.
   */
  private removeCtrlProxyPortForward(
    port: number,
    signal?: AbortSignal,
    options: { reclaimUnrecorded?: boolean } = {},
  ): Promise<boolean> {
    return this.getPortForwarder().removeCtrlProxyPortForward(port, signal, options);
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

  /** Resolve request responses only when the runner supplies a truthy request ID. */
  private resolvePendingResponse<Message extends { requestId?: string | null }, Payload>(
    message: Message,
    buildPayload: (message: Message & { requestId: string }) => Payload,
  ): void {
    if (message.requestId) {
      this.requestManager.resolve<Payload>(
        message.requestId,
        buildPayload(message as Message & { requestId: string }),
      );
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

  private inboundMessageRouter: AndroidInboundMessageRouter | null = null;
  private getInboundMessageRouter(): AndroidInboundMessageRouter {
    if (!this.inboundMessageRouter) {
      const client = this;
      this.inboundMessageRouter = new AndroidInboundMessageRouter({
        get transientObserver() {
          return client.transientObserver;
        },
        get rejectedCommands() {
          return client.rejectedCommands;
        },
        get supportedCommands() {
          return client.supportedCommands;
        },
        set supportedCommands(value) {
          client.supportedCommands = value;
        },
        get hierarchy() {
          return client.hierarchy;
        },
        get lateCancelledScreenshotRequestIds() {
          return client.lateCancelledScreenshotRequestIds;
        },
        get requestManager() {
          return client.requestManager;
        },
        get _hierarchy() {
          return client._hierarchy;
        },
        get device() {
          return client.device;
        },
        get onDisplayTransition() {
          return client.onDisplayTransition;
        },
        get screenshotObservationStreamSuppressions() {
          return client.screenshotObservationStreamSuppressions;
        },
        get screenshotCaptureBindings() {
          return client.screenshotCaptureBindings;
        },
        get certificates() {
          return client.certificates;
        },
        get focus() {
          return client.focus;
        },
        get sdkNavigationAppIds() {
          return client.sdkNavigationAppIds;
        },
        get closed() {
          return client.closed;
        },
        get adb() {
          return client.adb;
        },
        get prototypes() {
          return client.prototypes;
        },
        get timer() {
          return client.timer;
        },
        get lastInteractionByApp() {
          return client.lastInteractionByApp;
        },
        get storage() {
          return client.storage;
        },
        get maxCachedInteractions() {
          return AndroidCtrlProxyClient.MAX_CACHED_INTERACTIONS;
        },
        refreshObservationStreamHierarchyCadence: (...args) =>
          client.refreshObservationStreamHierarchyCadence(...args),
        settleUnattributedFocusedClickRejection: (...args) =>
          client.settleUnattributedFocusedClickRejection(...args),
        handleHierarchyUpdate: (...args) => client.handleHierarchyUpdate(...args),
        pushScreenshotToObservationStream: (...args) =>
          client.pushScreenshotToObservationStream(...args),
        resolvePendingResponse: (...args) => client.resolvePendingResponse(...args),
        recordSdkScreenIdentity: (...args) => client.recordSdkScreenIdentity(...args),
        ensureBuildContext: (...args) => client.ensureBuildContext(...args),
        attachRecentInteraction: (...args) => client.attachRecentInteraction(...args),
        enqueueNavigationGraphWrite: (...args) => client.enqueueNavigationGraphWrite(...args),
        getNavigationGraphManager: (...args) => client.getNavigationGraphManager(...args),
        handlePackageEvent: (...args) => client.handlePackageEvent(...args),
        pruneStaleInteractions: (...args) => client.pruneStaleInteractions(...args),
        notifyInteractionListeners: (...args) => client.notifyInteractionListeners(...args),
        handleHandledExceptionEvent: (...args) => client.handleHandledExceptionEvent(...args),
        clearSdkScreenIdentity: (...args) => client.clearSdkScreenIdentity(...args),
        handleCrashEvent: (...args) => client.handleCrashEvent(...args),
        handleAnrEvent: (...args) => client.handleAnrEvent(...args),
        handleFrameMetricsEvent: (...args) => client.handleFrameMetricsEvent(...args),
        getSdkEventIngestor: (...args) => client.getSdkEventIngestor(...args),
        recordSdkTelemetryEvent: (...args) => client.recordSdkTelemetryEvent(...args),
      });
    }
    return this.inboundMessageRouter;
  }

  private get webSocketMessageHandlers() {
    return this.getInboundMessageRouter().webSocketMessageHandlers;
  }

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
  private handleWebSocketMessage(data: WebSocket.Data): Promise<void> {
    return this.getInboundMessageRouter().handleWebSocketMessage(data);
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  handleHierarchyUpdate(
    data: AccessibilityHierarchy,
    perfTiming?: AndroidPerfTiming[],
    frameContext?: string,
    requestId?: string | null,
  ): void {
    this.getHierarchyUpdateHandler().handle(data, perfTiming, frameContext, requestId);
  }

  private pushHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    frameContext?: string,
  ): void {
    this.forwardHierarchyToObservationStream(hierarchy, frameContext, {
      logTag: "CTRL_PROXY",
      recordForwarded: (captureSequence) => {
        this.streamedCaptureSequences.set(hierarchy, captureSequence);
        this.screenGeometry.markForwarded(captureSequence);
      },
    });
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
    return this.createScreenshotBackoffScheduler(
      async () => this.captureScreenshotForBackoff(),
      (result) => this.emitBackoffScreenshot(result),
      {
        intervals: [0, 100, 300, 500, 800, 1300],
        keepAliveIntervalMs: 3000,
        minCaptureIntervalMs: AndroidCtrlProxyClient.A11Y_SCREENSHOT_MIN_INTERVAL_MS,
      },
    );
  }

  private emitBackoffScreenshot(result: ScreenshotCaptureResult): void {
    if (result.data) {
      this.pushScreenshotToObservationStream(
        result.data,
        result,
        result.captureBinding,
        result.frameContext,
        result.rotation,
      );
    }
  }

  private async captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult> {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.device.deviceId)) {
      return { success: false, error: "No subscribers" };
    }

    return this.captureScreenshotForObservationStream();
  }

  async captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult> {
    return this.getScreenshotCapture().captureForObservationStream();
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

  private handlePackageEvent(event: PackageEvent, timestamp?: number): Promise<void> {
    return this.getAppEventRecorder().handlePackageEvent(event, timestamp);
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

  private handleHandledExceptionEvent(event: HandledExceptionEvent): Promise<void> {
    return this.getAppEventRecorder().handleHandledExceptionEvent(event);
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
      [
        "gesture_display_id_v1",
        "tap_double_v1",
        MULTI_FINGER_GESTURE_CAPABILITY,
        PROTOTYPE_DISPLAY_CAPABILITY,
        PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
        PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
        PROTOTYPE_MULTI_SURFACE_CAPABILITY,
      ].includes(messageType)
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

  protected override awaitHandshakePoll(
    work: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    return this.awaitActionWork(work, signal);
  }

  private handleFrameMetricsEvent(data: NonNullable<WsFrameMetricsMessage["frameMetrics"]>): void {
    return this.getAppEventRecorder().handleFrameMetricsEvent(data);
  }

  private handleCrashEvent(event: SdkCrashPayload): Promise<void> {
    return this.getAppEventRecorder().handleCrashEvent(event);
  }

  private handleAnrEvent(event: SdkAnrPayload): Promise<void> {
    return this.getAppEventRecorder().handleAnrEvent(event);
  }

  private parseStackTrace(stackTrace: string, packageName: string): StackTraceElement[] {
    return parseStackTrace(stackTrace, packageName);
  }

  private markInstalledAppsStale(reason: string): Promise<void> {
    return this.getAppEventRecorder().markInstalledAppsStale(reason);
  }
}

registerDeviceIncarnationListener({
  name: "ctrlproxy-client",
  onDeviceIdentityReplaced: (deviceId) => {
    void AndroidCtrlProxyClient.evictAfterDeviceRemoval(deviceId).catch((error) => {
      logger.warn(
        `[CTRL_PROXY] Failed to close replaced device ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    });
  },
  onDeviceIncarnationChanged: async (deviceId) =>
    await AndroidCtrlProxyClient.invalidateForDeviceIncarnation(deviceId),
});
