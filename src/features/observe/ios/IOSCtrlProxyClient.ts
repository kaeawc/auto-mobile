/**
 * IOSCtrlProxyClient - Main client for iOS CtrlProxy.
 *
 * This client provides a unified interface to the iOS CtrlProxy
 * via WebSocket connection. It uses composition with delegate modules to handle
 * specific functionality:
 *
 * - CtrlProxyGestures: Swipe, tap, drag, pinch operations
 * - CtrlProxyText: setText, clearText, IME actions, select all
 * - CtrlProxyKeyboard: keyboard open, close, detect
 * - CtrlProxyHierarchy: Hierarchy retrieval, caching, conversion
 * - CtrlProxyScreenshot: Screenshot capture
 * - CtrlProxyNavigation: pressHome, pressBack, launchApp
 */

import { decodeSdkEventBatches, type DecodedSdkEvent } from "./decodeSdkEventBatches";
import WebSocket from "ws";
import { ActionableError } from "../../../models/ActionableError";
import type { IosHierarchyUnavailableReason } from "../../../models/ViewHierarchyResult";
import { logger } from "../../../utils/logger";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { captureIosPanelScreenshot } from "./CtrlProxyScreenshot";
import { displayTransitions } from "../DisplayTransition";
import { errorMessage } from "../../../utils/describeUnknownError";
import { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import {
  BootedDevice,
  HighlightShape,
  ScreenIdentity,
  ImeAction,
  ViewHierarchyResult,
  ScreenScaleMetadata,
} from "../../../models";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { exponentialBackoff } from "../../../utils/Backoff";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { RetryExecutor, defaultRetryExecutor } from "../../../utils/retry/RetryExecutor";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { requireBootedDevice } from "../../../devices/requireBootedDevice";
import {
  IOSCtrlProxyManager,
  CtrlProxyIosManager,
  type CtrlProxyIosSetupResult,
} from "../../../ctrlProxy/IOSCtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../../utils/factories/PlatformDeviceManagerFactory";
import {
  NavigationGraphManager,
  type NavigationBuildContext,
} from "../../navigation/NavigationGraphManager";
import { GetAppMetadata } from "../GetAppMetadata";
import type { IosAppMetadataSource } from "../../../models/IosAppMetadataSource";
import { createIosMetadataSource } from "../../../utils/iosAppMetadataSource";
import {
  createContentHashProvider,
  type ContentHashProvider,
} from "../../../utils/ContentHashProvider";
import { defaultAdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { serverConfig } from "../../../utils/ServerConfig";
import { NetworkState } from "../../../server/NetworkState";
import { buildNetworkMockRules } from "../../../server/networkMockRules";
import {
  HierarchyNavigationDetector,
  HierarchyNavigationUpdateMetrics,
} from "../../navigation/HierarchyNavigationDetector";
import { AccessibilityHierarchy } from "../../navigation/ScreenFingerprint";
import {
  DeviceServiceClient,
  ObserverPendingRequestTimeoutError,
  WebSocketFactory,
  defaultWebSocketFactory,
} from "../DeviceServiceClient";
import { sendCommand } from "../DeviceServiceUtils";
import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import type { BaseResult } from "../shared/types";
import type { SwipeRequestOptions } from "../shared/types";
import type { SetTextOptions } from "../DeviceService";
import type { SimulatedErrorType } from "../../../server/NetworkState";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";
import { TrackedScreenGeometry } from "../TrackedScreenGeometry";
import {
  getDeviceDataStreamServer,
  PerformanceStreamData,
} from "../../../daemon/deviceDataStreamSocketServer";
import { COORDINATE_SPACE_PX, type CoordinateSpace } from "../../../daemon/canonicalPixels";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import {
  ScreenshotBackoffScheduler,
  DefaultScreenshotBackoffScheduler,
  ScreenshotCaptureResult,
} from "../ScreenshotBackoffScheduler";
import {
  IOS_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
  type ScreenshotMetadata,
} from "../ScreenshotMetadata";
import { resolveAssetVersion, resolvePinnedVersion } from "../../../constants/release";
import { compareStrictNumericVersions } from "../../../utils/deviceMatcher";
import { serializeIosRequest } from "./serializeIosRequest";
import { iosMutationTokens } from "../../storage/IosMutationTokens";

/** Pending requests lose their transport when the service endpoint changes. */
export class CtrlProxyServicePortChangedError extends Error {
  constructor() {
    super("CtrlProxy service port changed");
    this.name = "CtrlProxyServicePortChangedError";
  }
}

/**
 * Factory function type for creating CtrlProxyIosManager instances.
 * Used for testing to inject fake service managers.
 */
export type ServiceManagerFactory = (device: BootedDevice) => CtrlProxyIosManager;

/** Default production factory that delegates to the real singleton. */
const defaultServiceManagerFactory: ServiceManagerFactory = (d) =>
  IOSCtrlProxyManager.getInstance(d);

/**
 * Function type that returns currently booted devices.
 * Injected for testability — avoids coupling to PlatformDeviceManagerFactory in tests.
 */
export type BootedDeviceLister = () => Promise<BootedDevice[]>;

export interface IosCtrlProxyClientOptions {
  transientObserver?: boolean;
  iosSource?: IosAppMetadataSource;
  contentHashProvider?: ContentHashProvider;
}

interface IosCtrlProxyClientDependencies extends IosCtrlProxyClientOptions {
  wsFactory?: WebSocketFactory;
  timer?: Timer;
  serviceManagerFactory?: ServiceManagerFactory;
  bootedDeviceLister?: BootedDeviceLister;
  deviceConnectionLostNotifier?: DeviceConnectionLostNotifier;
  sdkEventIngestor?: IosSdkEventIngestor;
  retryExecutor?: RetryExecutor;
}

/** Validate the platform version before it becomes a wire/cache key. */
function iosBuildVersion(raw: string): { versionCode: number; versionKey?: string } | null {
  const trimmed = raw.trim();
  // 64 characters accommodates build labels while bounding wire/cache keys.
  // Metadata and provenance share the trimmed platform value.
  if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    return null;
  }
  const numeric = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isSafeInteger(numeric)) {
    return { versionCode: numeric };
  }
  return { versionCode: 0, versionKey: trimmed };
}

interface IosBuildContextAttempt {
  generation: number;
  controller: AbortController;
  scheduledTimer?: ReturnType<Timer["setTimeout"]>;
}

type IosBuildContextResolution =
  | { kind: "resolved"; context: NavigationBuildContext }
  | { kind: "terminal"; reason: string }
  | { kind: "failed" | "superseded" };

const iosBuildContextBackoff = exponentialBackoff({
  initialDelayMs: 5000,
  multiplier: 2,
  maxDelayMs: 300000,
});
const IOS_BUILD_CONTEXT_DEADLINE_MS = 30000;

// Test-created clients must never fall through to simctl/devicectl for provenance.
const noOpIosMetadataSource: IosAppMetadataSource = {
  listApps: async () => [],
  getPhysicalDeviceAppInfo: async () => null,
};

type IosSdkCapability =
  | "hierarchy"
  | "network_mocking"
  | "network_fault_rules"
  | "network_error_simulation"
  | "database"
  | "highlight";

interface IosSdkCapabilities {
  bundleId: string;
  capabilities: Set<IosSdkCapability>;
}

interface IosSdkCapabilitiesResult extends BaseResult {
  available: boolean;
  bundleId?: string;
  capabilities?: string[];
}

/**
 * A capability waiter was created under one probe generation, but a hierarchy
 * update (foreground app change, reconnect, SDK failure) invalidated that
 * generation before its probe answered. The replacement generation's result
 * belongs to a different foreground app and must never authorize this waiter
 * (#6896): callers either retry against the new generation or fail actionably.
 */
export class SdkCapabilityProbeSupersededError extends ActionableError {
  constructor(
    readonly capability: IosSdkCapability,
    readonly probeGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(
      `The AutoMobile SDK capability probe for ${capability} (generation ${probeGeneration}) was superseded by a newer foreground state (generation ${currentGeneration}); re-observe and retry against the current foreground app.`,
    );
    this.name = "SdkCapabilityProbeSupersededError";
  }
}

/** Default production lister that queries the real device manager. */
const defaultBootedDeviceLister: BootedDeviceLister = () =>
  PlatformDeviceManagerFactory.getInstance().getBootedDevices("ios");

/**
 * No-op factory used by createForTesting so that tests which don't supply
 * a factory never trigger real CtrlProxy setup on connection failure.
 */
class NoOpIOSCtrlProxyManager implements CtrlProxyIosManager {
  private readonly forcedRestartBudget = new ForcedRestartBudget();
  getForcedRestartBudget(): ForcedRestartBudget {
    return this.forcedRestartBudget;
  }
  async setup(): Promise<{ success: false; message: string }> {
    return { success: false, message: "no-op test stub" };
  }
  async isInstalled(): Promise<boolean> {
    return false;
  }
  async isRunning(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getServicePort(): number {
    return 0;
  }
  async getReportedRunnerPort(): Promise<number | null> {
    return null;
  }
  setAutoRestart(): void {}
  isAutoRestartEnabled(): boolean {
    return false;
  }
  async forceRestart(): Promise<void> {}
  resetSetupState(): void {}
}

const noOpServiceManagerFactory: ServiceManagerFactory = () => new NoOpIOSCtrlProxyManager();

// Import delegates
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyText } from "./CtrlProxyText";
import { CtrlProxyHierarchy as CtrlProxyHierarchyDelegate } from "./CtrlProxyHierarchy";
import { CtrlProxyScreenshot } from "./CtrlProxyScreenshot";
import { CtrlProxyNavigation } from "./CtrlProxyNavigation";
import { CtrlProxyClipboard } from "./CtrlProxyClipboard";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import {
  CtrlProxyVoiceOver,
  type VoiceOverActivationOptions,
  type CtrlProxyRequestActionOptions,
} from "./CtrlProxyVoiceOver";
import { CtrlProxyKeyboard } from "./CtrlProxyKeyboard";
import type { InputKeyModifier, InputKeyName } from "../../action/InputKey";
import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import { CtrlProxyDatabase } from "./CtrlProxyDatabase";
import { CtrlProxyPermissions } from "./CtrlProxyPermissions";
import {
  gesturePhaseSummary,
  decodeCtrlProxyMessage,
  type DecodedCtrlProxyMessage,
} from "./decodeCtrlProxyMessage";
import { DefaultIosSdkEventIngestor, type IosSdkEventIngestor } from "./IosSdkEventIngestor";
import { deriveIosSdkScreenIdentity } from "./IosSdkScreenIdentity";

// Import types
import type {
  DelegateContext,
  HierarchyDelegateContext,
  CtrlProxyNode,
  XCTestHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxyScreenshotResult,
  CtrlProxySwipeResult,
  CtrlProxyTapResult,
  CtrlProxyDragResult,
  CtrlProxyPinchResult,
  CtrlProxySetTextResult,
  CtrlProxyImeActionResult,
  CtrlProxySelectAllResult,
  CtrlProxyKeyboardResult,
  CtrlProxyPressKeyResult,
  CtrlProxyPressHomeResult,
  CtrlProxyPressBackResult,
  CtrlProxyShakeResult,
  CtrlProxyPressButtonResult,
  CtrlProxyRecentAppsResult,
  CtrlProxyRotateResult,
  CtrlProxyHingeAngleResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyResetPermissionsResult,
  CtrlProxyPerfTiming,
  CtrlProxyPerformanceSnapshot,
  CtrlProxyCachedHierarchy,
  CtrlProxyVoiceOverResult,
  CtrlProxyActionResult,
  CtrlProxyClipboardResult,
  CtrlProxyHighlightResult,
  WebSocketMessage,
} from "./types";

/**
 * Interface for CtrlProxy providing iOS UI hierarchy and interaction capabilities
 * via WebSocket connection to iOS CtrlProxy
 */
// oxlint-disable-next-line auto-mobile/naming-convention -- IOS is an acronym, not a Hungarian-notation interface prefix
export interface IOSCtrlProxy extends CtrlProxyClient {
  getSupportedCommands?(): Promise<string[] | null>;
  connectWithoutSetup(signal?: AbortSignal): Promise<boolean>;
  getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    signal?: AbortSignal,
  ): Promise<CtrlProxyHierarchyResponse>;

  requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{
    hierarchy: XCTestHierarchy;
    perfTiming?: CtrlProxyPerfTiming;
    frameContext?: string;
  } | null>;
  requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyHighlightResult>;

  setNetworkErrorSimulation(
    config: IosNetworkErrorSimulationConfig,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<BaseResult>;

  requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{
    hierarchy: XCTestHierarchy;
    perfTiming?: CtrlProxyPerfTiming;
    frameContext?: string;
  } | null>;

  convertToViewHierarchyResult(hierarchy: XCTestHierarchy): ViewHierarchyResult;

  requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    contextOptions?: string | SwipeRequestOptions,
    signal?: AbortSignal,
  ): Promise<CtrlProxySwipeResult>;

  requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<CtrlProxyTapResult>;

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
    onDispatch?: () => void,
  ): Promise<CtrlProxyDragResult>;

  requestPinch(
    centerX: number,
    centerY: number,
    distanceStart: number,
    distanceEnd: number,
    rotationDegrees: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPinchResult>;

  requestSetText(text: string, options?: SetTextOptions): Promise<CtrlProxySetTextResult>;

  requestAppendText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxySetTextResult>;

  requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxySetTextResult>;

  requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<CtrlProxyImeActionResult>;

  requestSelectAll(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxySelectAllResult>;

  requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyKeyboardResult>;

  requestPressKey(
    key: InputKeyName,
    modifiers: InputKeyModifier[],
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressKeyResult>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyClipboardResult>;

  requestPressHome(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxyPressHomeResult>;

  requestPressBack(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxyPressBackResult>;

  requestShake(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyShakeResult>;

  requestPressButton(
    button: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxyPressButtonResult>;

  requestRecentApps(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<CtrlProxyRecentAppsResult>;

  requestRotate(
    orientation: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyRotateResult>;

  requestSetHingeAngle(angle: number, timeoutMs?: number): Promise<CtrlProxyHingeAngleResult>;

  requestLaunchApp(
    bundleId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    coldBoot?: boolean,
    signal?: AbortSignal,
  ): Promise<CtrlProxyLaunchAppResult>;

  requestResetPermissions(
    bundleId: string,
    permissions: string[],
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyResetPermissionsResult>;

  requestScreenshot(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult>;

  requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyScreenshotResult>;

  requestVoiceOverState(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyVoiceOverResult>;

  requestVoiceOverActivate(
    label: string,
    action: "activate" | "long_press",
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: VoiceOverActivationOptions,
  ): Promise<CtrlProxyActionResult>;

  requestSetVoiceOverEnabled(
    enabled: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult>;

  requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: CtrlProxyRequestActionOptions,
  ): Promise<CtrlProxyActionResult>;

  requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    ownerResourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult>;

  requestMultiFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    fingerCount: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    fingerSpacing?: number,
  ): Promise<CtrlProxySwipeResult>;

  clearCache(): void;

  onPushUpdate(callback: (hierarchy: XCTestHierarchy) => void): () => void;
}

export interface IosNetworkErrorSimulationConfig {
  enabled: boolean;
  errorType?: SimulatedErrorType | null;
  limit?: number | null;
  expiresAtEpochMs?: number | null;
}

type SdkEventPollResult = {
  receivedEvents: boolean;
  rememberedApplicationIds: Set<string>;
};

type SdkScreenIdentityPollGeneration = {
  clearGeneration: number;
  applicationGenerations: Map<string, number>;
};

function numberOrDefault(value: number | null | undefined): number {
  return value ?? 0;
}

function nullWhenAbsent<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * Command rawValues a *fresh* iOS CtrlProxy runner advertises in its `connected`
 * handshake that the released v0.0.38 runner predates. The runner exposes no
 * version/hash, so presence of all of these in `supportedCommands` is the runner
 * identity used by diagnostics (doctor) and the booted-devices resource to tell a
 * current runner from a stale one. Keep unreleased feature-gated commands out of
 * this list until they are present in the released runner registry. Environment-
 * restricted commands such as set_hinge_angle are filtered per environment by
 * iosRunnerFeatureCommands.ts. Append input deliberately uses request_set_text
 * as a compatibility fallback until its dedicated command is released.
 */
export const IOS_RUNNER_FEATURE_COMMANDS = [
  "request_shake",
  "request_press_button",
  "request_multi_finger_swipe",
  "add_highlight",
  "execute_sql",
  "set_network_mock_rules",
  "set_hinge_angle",
] as const;

/** Non-command wire capabilities advertised by runners built from this source revision. */
export const IOS_RUNNER_FEATURE_FLAGS = ["display_cutout_info"] as const;

// The immutable 0.0.66 IPA predates the feature handshake. Require the flag
// only once the release pipeline cuts 0.0.67+ from source that advertises it.
const IOS_RUNNER_FEATURE_FLAGS_MIN_RELEASE = "0.0.67";

export function getRequiredIosRunnerFeatureFlags(
  env: Record<string, string | undefined> = process.env,
): readonly (typeof IOS_RUNNER_FEATURE_FLAGS)[number][] {
  const artifactVersion = resolveAssetVersion(resolvePinnedVersion(env));
  const comparison = compareStrictNumericVersions(
    artifactVersion,
    IOS_RUNNER_FEATURE_FLAGS_MIN_RELEASE,
  );
  return Number.isNaN(comparison) || comparison >= 0 ? IOS_RUNNER_FEATURE_FLAGS : [];
}

/**
 * IOSCtrlProxyClient - WebSocket client for iOS CtrlProxy
 * Provides iOS UI hierarchy and interaction capabilities matching Android IOSCtrlProxyClient
 *
 * Extends DeviceServiceClient for shared connection lifecycle management.
 */
export class IOSCtrlProxyClient extends DeviceServiceClient implements IOSCtrlProxy {
  private readonly streamedCaptureSequences = new WeakMap<XCTestHierarchy, number>();
  private static instances: Map<string, IOSCtrlProxyClient> = new Map();
  private closed = false;

  // Default port matches CtrlProxy on iOS
  public static readonly DEFAULT_PORT = 8765;

  /**
   * NOT using TTLCache: "fresh" state managed by push updates + minTimestamp
   * validation, not simple TTL expiration. The cache is invalidated based on
   * WebSocket push events and explicit invalidateCache() calls after actions.
   */
  private cachedHierarchy: CtrlProxyCachedHierarchy | null = null;
  private cachedHierarchyDisplayRevision = -1;
  // #9259 re-broadcasts lagged by ~3–10s; 30s leaves headroom while bounding
  // the older-push guard when the device clock takes a larger backward step.
  private static readonly MAX_HIERARCHY_REBROADCAST_GAP_MS = 30_000;
  // Count only advancing-clock older pushes: #9259 re-broadcasts the same stale
  // tree after navigation, so repeats must never accumulate toward recovery.
  private static readonly MAX_CONSECUTIVE_OLDER_HIERARCHY_PUSHES = 5;
  private consecutiveOlderHierarchyPushes = 0;
  private lastDroppedOlderPushUpdatedAt: number | null = null;
  // Raised from 500ms toward maxObservationAgeMs so cache hits replace device
  // round-trips during multi-step sequences, leaning on unsolicited
  // `hierarchy_update` pushes to keep the cache warm (#5472). Still floored by
  // `Math.min(cacheFreshTtlMs, maxObservationAgeMs())` in CtrlProxyHierarchy, and
  // a stale CAPTURE age past maxObservationAgeMs still forces re-verification.
  private static readonly CACHE_FRESH_TTL_MS = 2000;
  private readonly hierarchyObservationStreamSuppressions: Map<string, NodeJS.Timeout> = new Map();
  private readonly observerHierarchyRequestIds = new Set<string>();
  private readonly transientObserver: boolean;

  // Push update callbacks
  private onPushUpdateCallbacks: Set<(hierarchy: XCTestHierarchy) => void> = new Set();
  private supportedCommands: Set<string> | null = null;
  private readonly rejectedCommands = new Set<string>();
  private supportedFeatures: Set<string> | null = null;
  private sdkCapabilities: IosSdkCapabilities | null = null;
  private sdkCapabilitiesKnown = false;
  private sdkCapabilitiesKnownAt = 0;
  private sdkCapabilityGeneration = 0;
  private sdkCapabilityRefreshInFlight: {
    generation: number;
    promise: Promise<IosSdkCapabilities | null>;
  } | null = null;

  // Track last foreground bundle for performance monitoring
  private lastForegroundBundleId: string | null = null;

  // Platform-specific dependencies
  private readonly device: BootedDevice;
  private port: number;

  // Delegate instances (lazy initialized)
  private _gestures: CtrlProxyGestures | null = null;
  private _text: CtrlProxyText | null = null;
  private _hierarchy: CtrlProxyHierarchyDelegate | null = null;
  private _screenshot: CtrlProxyScreenshot | null = null;
  private _navigation: CtrlProxyNavigation | null = null;
  private _clipboard: CtrlProxyClipboard | null = null;
  private _voiceOver: CtrlProxyVoiceOver | null = null;
  private _storage: CtrlProxyStorage | null = null;
  private _keyboard: CtrlProxyKeyboard | null = null;
  private _highlights: CtrlProxyHighlights | null = null;
  private _database: CtrlProxyDatabase | null = null;
  private _permissions: CtrlProxyPermissions | null = null;

  // Logging tag for base class
  protected readonly logTag = "IOSCtrlProxyClient";

  // Screenshot backoff scheduler for real-time screenshot streaming
  private screenshotBackoffScheduler: ScreenshotBackoffScheduler | null = null;
  // Screen geometry derived from hierarchies, carrying whether the daemon has actually seen a
  // hierarchy with that geometry (issue #3348). See TrackedScreenGeometry.
  private readonly screenGeometry = new TrackedScreenGeometry();
  // Runner-reported scale metadata from the most recent forwarded hierarchy (#4548). Retained for
  // #4549's canonical-pixel conversion; null until a #4548-aware runner reports it. Nothing in
  // current behavior reads it — screenGeometry above stays the points * screenScale computation.
  private reportedScaleMetadata: ScreenScaleMetadata | null = null;

  // Connection failure tracking for auto-restart
  private consecutiveConnectionFailures: number = 0;
  private isRequestingServiceRestart: boolean = false;
  private lastDeniedRestartState: string | undefined;
  private static readonly MAX_FAILURES_BEFORE_RESTART = 3;
  private static readonly CONNECTION_RESET_MS = 2000;
  /** A briefly open socket is not evidence that the runner recovered. */
  private static readonly RESTART_REARM_STABILITY_MS = 2000;
  private restartRearmTimeout: NodeJS.Timeout | null = null;
  private pendingRestartToken: number | undefined;
  private resolvePendingRestart: ((stable: boolean) => void) | undefined;
  /** Only a socket opened after forceRestart teardown may satisfy this attempt. */
  private restartAcceptsReplacement = false;
  private restartReplacementSocket: WebSocket | null = null;
  private restartSocketBeforeTeardown: WebSocket | null = null;
  private connectedSocketPort: number | null = null;
  /** Port acquired by this registered client, if it still uses that allocation. */
  private allocatedPort: number | null = null;

  // Auto-setup on connection failure
  private readonly serviceManagerFactory: ServiceManagerFactory;
  private readonly bootedDeviceLister: BootedDeviceLister;
  private readonly deviceConnectionLostNotifier: DeviceConnectionLostNotifier;
  private isAttemptingAutoSetup: boolean = false;
  public static readonly OBSERVE_RECOVERY_WAIT_MS = 20_000;
  private lastConnectFailure?: { reason: IosHierarchyUnavailableReason; detail?: string };

  // SDK-event ingestion (telemetry/failure fan-out + layout telemetry)
  private readonly sdkEventIngestor: IosSdkEventIngestor;
  private readonly sdkScreenIdentitiesByApplicationId = new Map<string, ScreenIdentity>();
  private readonly sdkScreenIdentityOrdersByApplicationId = new Map<
    string,
    { timestamp: number; sequenceNumber?: number }
  >();
  private readonly sdkScreenIdentityGenerationsByApplicationId = new Map<string, number>();
  private readonly sdkScreenIdentitySessionsByApplicationId = new Map<string, string>();
  private readonly sdkScreenIdentityStartedSessionsByApplicationId = new Map<string, string>();
  private readonly sdkScreenIdentitySessionEpochsByApplicationId = new Map<string, number>();
  private readonly sdkScreenIdentityRetiredSessionsByApplicationId = new Map<string, Set<string>>();
  private readonly sdkScreenIdentityTrackingGenerationsByApplicationId = new Map<string, number>();
  private readonly sdkScreenIdentityTrackingDisabledApplicationIds = new Set<string>();
  private sdkScreenIdentityClearGeneration = 0;
  private iosSource?: IosAppMetadataSource;
  private appMetadata?: GetAppMetadata;
  private contentHashProvider?: ContentHashProvider;
  private readonly resolvedBuildContexts = new Map<string, NavigationBuildContext>();
  private readonly buildContextInFlight = new Map<string, IosBuildContextAttempt>();
  private readonly buildContextFailures = new Map<string, { attempts: number; retryAt: number }>();
  private readonly appliedBuildContextManagers = new Map<string, Set<NavigationGraphManager>>();
  private readonly buildContextGeneration = new Map<string, number>();
  private sdkEventPollGeneration = 0;
  private sdkEventPollAbortController: AbortController | null = null;
  private sdkEventPollInFlight: {
    generation: number;
    promise: Promise<SdkEventPollResult>;
  } | null = null;
  private static readonly SDK_EVENT_POLL_TIMEOUT_MS = 2000;
  // Fast cadence for the CtrlProxy /sdk-events long-poll (was a bare `2000`).
  private static readonly SDK_EVENT_POLL_INTERVAL_MS = 2000;
  // After this many consecutive empty batches (e.g. an app with no SDK
  // integrated) the poll backs off to the slower cadence below. Any inbound WS
  // activity resets the counter and restores fast cadence (#5472, AC#2).
  private static readonly SDK_EVENT_POLL_EMPTY_BATCHES_BEFORE_BACKOFF = 5;
  private static readonly SDK_EVENT_POLL_BACKOFF_INTERVAL_MS = 30_000;
  private sdkEventPollConsecutiveEmpty = 0;
  private static readonly SDK_IDENTITY_REFRESH_TIMEOUT_MS = 100;
  private static readonly SDK_IDENTITY_REFRESH_RETRY_MS = 10;
  private static readonly SDK_CAPABILITY_NEGATIVE_CACHE_TTL_MS = 5000;

  private constructor(
    device: BootedDevice,
    port: number = IOSCtrlProxyClient.DEFAULT_PORT,
    options: IosCtrlProxyClientDependencies = {},
  ) {
    super(
      options.timer ?? defaultTimer,
      options.wsFactory ?? defaultWebSocketFactory,
      { connectionResetMs: IOSCtrlProxyClient.CONNECTION_RESET_MS },
      options.retryExecutor ?? defaultRetryExecutor,
    );
    this.device = device;
    this.transientObserver = options.transientObserver ?? false;
    this.iosSource = options.iosSource;
    this.contentHashProvider = options.contentHashProvider;
    if (this.transientObserver) {
      this.autoReconnectEnabled = false;
    }
    this.port = port;
    this.serviceManagerFactory = options.serviceManagerFactory ?? defaultServiceManagerFactory;
    this.bootedDeviceLister = options.bootedDeviceLister ?? defaultBootedDeviceLister;
    this.deviceConnectionLostNotifier =
      options.deviceConnectionLostNotifier ?? observationStreamDeviceConnectionLostNotifier;
    // Constructed eagerly (unlike the lazy delegate getters): DefaultIosSdkEventIngestor's
    // constructor only stores these session-bound closures — it does no I/O and does not
    // resolve the telemetry/failure singletons (those resolve per-call), so eager
    // construction is free even for throwaway probe clients.
    this.sdkEventIngestor =
      options.sdkEventIngestor ??
      new DefaultIosSdkEventIngestor({
        deviceId: this.device.deviceId,
        getNavigationGraphManager: () => this.getNavigationGraphManager(),
        captureScreenshot: (timeoutMs: number) => this.requestScreenshot(timeoutMs),
      });
  }

  /**
   * Get singleton instance for a device
   */
  public static getInstance(device: BootedDevice, port?: number): IOSCtrlProxyClient {
    requireBootedDevice(device, "IOSCtrlProxyClient.getInstance");
    const key = device.deviceId;
    const retired = IOSCtrlProxyManager.isDeviceRetired(key);
    const existing = IOSCtrlProxyClient.instances.get(key);
    if (existing) {
      if (port !== undefined && !existing.closed && !retired) {
        existing.updatePort(port);
      }
      return existing;
    }
    const allocatePort = !retired && port === undefined && device.platform === "ios";
    const resolvedPort = allocatePort
      ? PortManager.allocate(device.deviceId, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS })
      : ((retired ? IOSCtrlProxyClient.DEFAULT_PORT : port) ?? IOSCtrlProxyClient.DEFAULT_PORT);
    const client = new IOSCtrlProxyClient(device, resolvedPort);
    if (allocatePort) {
      client.allocatedPort = resolvedPort;
    }
    if (retired) {
      client.closed = true;
      client.autoReconnectEnabled = false;
    }
    IOSCtrlProxyClient.instances.set(key, client);
    return client;
  }

  /**
   * Return the existing client for a device without creating one (or allocating a
   * port). Hot paths that only want a connection-free read of cached state — e.g.
   * the booted-devices resource reading `getCachedSupportedCommands()` — use this
   * so listing devices never spins up a client or reserves a port as a side effect.
   */
  public static getExistingInstance(deviceId: string): IOSCtrlProxyClient | null {
    if (IOSCtrlProxyManager.isDeviceRetired(deviceId)) {
      return null;
    }
    return IOSCtrlProxyClient.instances.get(deviceId) ?? null;
  }

  /** @internal Test seam matching AndroidCtrlProxyClient.registerForTesting. */
  public static registerForTesting(client: IOSCtrlProxyClient, deviceId: string): void {
    IOSCtrlProxyClient.instances.set(deviceId, client);
  }

  /**
   * @internal Clear registry entries for isolated tests only. This closes
   * nothing and resets no ports, observers, or retired-device state. Unlike
   * resetInstances(), it avoids fire-and-forget close() cleanup that can run
   * real socket work and leaves IOSCtrlProxyManager's retired-device state
   * untouched.
   */
  public static clearInstanceRegistryForTesting(): void {
    IOSCtrlProxyClient.instances.clear();
  }

  /** Permanently retire the registered client for one device incarnation. */
  public static async retireInstance(deviceId: string): Promise<void> {
    IOSCtrlProxyManager.retireDevice(deviceId);
    const instance = IOSCtrlProxyClient.instances.get(deviceId);
    if (!instance) {
      return;
    }
    instance.closed = true;
    await instance.close();
  }

  /** Reopen the device registry only after a new boot/session start owns it. */
  public static resumeAfterDeviceStart(deviceId: string): void {
    if (!IOSCtrlProxyManager.isDeviceRetired(deviceId)) {
      return;
    }
    IOSCtrlProxyClient.instances.delete(deviceId);
    IOSCtrlProxyManager.resumeDevice(deviceId);
  }

  /** Return the latest app-provided navigation identity without doing I/O. */
  public getSdkScreenIdentity(applicationId?: string): ScreenIdentity | undefined {
    return applicationId ? this.sdkScreenIdentitiesByApplicationId.get(applicationId) : undefined;
  }

  /** Remove SDK navigation state after an app process is replaced. */
  public clearSdkScreenIdentity(applicationId?: string): void {
    this.invalidateSdkCapabilities();
    if (applicationId) {
      this.invalidateBuildContext(applicationId);
      this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(applicationId);
      this.invalidateSdkScreenIdentity(applicationId);
      return;
    }
    for (const appId of this.buildContextGeneration.keys()) {
      this.invalidateBuildContext(appId);
    }
    this.sdkScreenIdentityClearGeneration++;
    this.sdkScreenIdentityGenerationsByApplicationId.clear();
    this.sdkScreenIdentityTrackingDisabledApplicationIds.clear();
    this.sdkScreenIdentitySessionsByApplicationId.clear();
    this.sdkScreenIdentityStartedSessionsByApplicationId.clear();
    this.sdkScreenIdentitySessionEpochsByApplicationId.clear();
    this.sdkScreenIdentityRetiredSessionsByApplicationId.clear();
    this.sdkScreenIdentityTrackingGenerationsByApplicationId.clear();
    this.sdkScreenIdentitiesByApplicationId.clear();
    this.sdkScreenIdentityOrdersByApplicationId.clear();
  }

  /**
   * Drain the CtrlProxy SDK-event queue before returning the current identity.
   * Observe calls this after reading the hierarchy so a navigation event does
   * not wait for the background poll interval before it reaches the diff gate.
   */
  public async refreshSdkScreenIdentity(
    applicationId?: string,
  ): Promise<ScreenIdentity | undefined> {
    const deadline = this.timer.now() + IOSCtrlProxyClient.SDK_IDENTITY_REFRESH_TIMEOUT_MS;
    while (this.timer.now() < deadline) {
      const result = await this.pollSdkEventsUntil(deadline);
      const refreshed = applicationId
        ? result?.rememberedApplicationIds.has(applicationId)
        : result?.receivedEvents;
      if (refreshed) {
        break;
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        break;
      }
      await this.timer.sleep(Math.min(IOSCtrlProxyClient.SDK_IDENTITY_REFRESH_RETRY_MS, remaining));
    }
    return this.getSdkScreenIdentity(applicationId);
  }

  private async pollSdkEventsUntil(deadline: number): Promise<SdkEventPollResult | undefined> {
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      return undefined;
    }
    const timedOut = new Error("SDK event poll timed out");
    try {
      return await raceWithDeadline(this.pollSdkEvents(), {
        timer: this.timer,
        timeoutMs: remaining,
        label: "SDK event poll",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error === timedOut) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Build a throwaway client that is NOT registered in the singleton map. Used by
   * short-lived diagnostics (doctor) that must open a connection, read, and close
   * without leaving anything behind: because it is never cached, a later
   * `getExistingInstance` can't rediscover a closed probe and mistake it for a
   * live session (which would reconnect and leak the socket/SDK polling timer).
   * Uses an explicit discovered host port when supplied, otherwise the shared
   * allocation. Does not own that allocation: a registered manager may use it.
   */
  public static createDetached(
    device: BootedDevice,
    options: { port?: number } = {},
  ): IOSCtrlProxyClient {
    requireBootedDevice(device, "IOSCtrlProxyClient.createDetached");
    const port =
      options.port ??
      (device.platform === "ios"
        ? PortManager.allocate(device.deviceId, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS })
        : IOSCtrlProxyClient.DEFAULT_PORT);
    return new IOSCtrlProxyClient(device, port);
  }

  /** Connect only to an already-running runner for one observation. */
  public static createForObservationRead(
    device: BootedDevice,
    resident?: IOSCtrlProxyClient,
  ): IOSCtrlProxyClient {
    requireBootedDevice(device, "IOSCtrlProxyClient.createForObservationRead");
    // A probe of a resident borrows only its endpoint and injected dependencies,
    // never its port allocation or connection lifecycle.
    const ownsPortAllocation = !resident && PortManager.getPort(device.deviceId) === undefined;
    const port =
      resident?.port ??
      PortManager.allocate(device.deviceId, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS });
    const dependencies = resident
      ? {
          timer: resident.timer,
          serviceManagerFactory: resident.serviceManagerFactory,
          bootedDeviceLister: resident.bootedDeviceLister,
          deviceConnectionLostNotifier: resident.deviceConnectionLostNotifier,
          retryExecutor: resident.retryExecutor,
        }
      : {
          timer: defaultTimer,
          serviceManagerFactory: defaultServiceManagerFactory,
          bootedDeviceLister: defaultBootedDeviceLister,
          deviceConnectionLostNotifier: observationStreamDeviceConnectionLostNotifier,
          retryExecutor: defaultRetryExecutor,
        };
    // Ordinary transient observers intentionally ignore connected pushes. A
    // diagnostic probe captures capability metadata on its own socket without
    // changing those handlers or synchronizing the runner's configuration.
    const socketFactory: WebSocketFactory = resident
      ? (url) => {
          const socket = resident.webSocketFactory(url);
          socket.on("message", (data: WebSocket.Data) => {
            try {
              const message: WebSocketMessage = JSON.parse(data.toString());
              if (message.type === "connected") {
                client.supportedCommands = Array.isArray(message.supportedCommands)
                  ? new Set(message.supportedCommands)
                  : null;
                client.supportedFeatures = Array.isArray(message.supportedFeatures)
                  ? new Set(message.supportedFeatures)
                  : null;
              }
            } catch (error) {
              logger.warn(`iOS diagnostic handshake failed: ${errorMessage(error)}`, error);
            }
          });
          return socket;
        }
      : defaultWebSocketFactory;
    const client = new IOSCtrlProxyClient(device, port, {
      ...dependencies,
      wsFactory: socketFactory,
      transientObserver: true,
      iosSource: resident?.iosSource,
      contentHashProvider: resident?.contentHashProvider,
    });
    if (ownsPortAllocation) {
      client.allocatedPort = port;
    }
    return client;
  }

  public connectForObservationRead(): Promise<boolean> {
    return super.ensureConnected();
  }

  /**
   * Diagnostic accessor for doctor: reports the host port this client will use
   * for the runner WebSocket without opening any additional connection.
   */
  public getConnectionPortForDiagnostics(): number {
    return this.port;
  }

  /**
   * An open resident socket can serve a read. Otherwise only a transient observer
   * dials: its promises, timers, budgets and handshake cache belong to the probe.
   * Never close, reconnect, or update any state on the resident client.
   */
  private async readForDiagnostics<T>(
    read: (client: IOSCtrlProxyClient) => Promise<T>,
    unavailable: T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.isConnected()) {
      return read(this);
    }
    if (this.transientObserver) {
      return (await this.connectWithoutSetup(signal)) ? read(this) : unavailable;
    }
    const probe = IOSCtrlProxyClient.createForObservationRead(this.device, this);
    try {
      return (await probe.connectWithoutSetup(signal)) ? await read(probe) : unavailable;
    } finally {
      await probe.close();
    }
  }

  /** Read both identity fields from one handshake on one connection. */
  public async getRunnerIdentityForDiagnostics(
    signal?: AbortSignal,
  ): Promise<{ commands: string[] | null; features: string[] | null } | null> {
    return this.readForDiagnostics(
      async (client) => {
        await client.waitForHandshake(undefined, signal);
        signal?.throwIfAborted();
        const commands = client.getCachedSupportedCommands();
        return commands === null
          ? null
          : { commands, features: client.getCachedSupportedFeatures() };
      },
      null,
      signal,
    );
  }

  /** Cached handshake or connection-only read; never sets up a runner. */
  public async getSupportedCommandsForDiagnostics(signal?: AbortSignal): Promise<string[] | null> {
    return this.readForDiagnostics(
      async (client) => {
        await client.waitForHandshake(undefined, signal);
        signal?.throwIfAborted();
        return client.getCachedSupportedCommands();
      },
      null,
      signal,
    );
  }

  public async getSupportedFeaturesForDiagnostics(signal?: AbortSignal): Promise<string[] | null> {
    return this.readForDiagnostics(
      async (client) => {
        await client.waitForHandshake(undefined, signal);
        signal?.throwIfAborted();
        return client.getCachedSupportedFeatures();
      },
      null,
      signal,
    );
  }

  /** Hierarchy read on a connection-only transport, with no reconnect fallback. */
  public async requestHierarchySyncForDiagnostics(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 5000,
  ): Promise<{
    hierarchy: XCTestHierarchy;
    perfTiming?: CtrlProxyPerfTiming;
    frameContext?: string;
  } | null> {
    const deadline = this.timer.now() + Math.max(0, timeoutMs);
    return this.readForDiagnostics(
      (client) =>
        client.hierarchy.requestHierarchySync(
          perf,
          disableAllFiltering,
          signal,
          Math.max(0, deadline - this.timer.now()),
          true,
          { observerMode: true },
        ),
      null,
      signal,
    );
  }

  /**
   * Bind this client to a session for multi-agent NavigationGraphManager isolation.
   */
  public bindSession(sessionId: string): void {
    // Binding means this session is live again — clear any released-tombstone so a
    // reused uuid (e.g. setActiveDevice re-creating the session on another device)
    // gets its own manager rather than the unattributed global (#4984).
    NavigationGraphManager.clearReleasedSession(sessionId);
    if (this.boundSessionId !== sessionId) {
      // See AndroidCtrlProxyClient.bindSession: a per-device client is
      // last-writer-wins. Trace a transition off a previously-bound session so a
      // concurrent-share regression is diagnosable, but stay at debug so the
      // common released-then-reassigned case is not noisy.
      if (this.boundSessionId !== null) {
        logger.debug(
          `[IOSCtrlProxyClient] Rebinding device ${this.device.deviceId} from session ` +
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
   * Mirrors the Android client so isolation tests can pin the routing invariant.
   */
  public getBoundSessionIdForTesting(): string | null {
    return this.boundSessionId;
  }

  /**
   * Get the NavigationGraphManager for the bound session, or the global singleton.
   */
  private getNavigationGraphManager(): NavigationGraphManager {
    return this.boundSessionId
      ? NavigationGraphManager.getInstanceForSession(this.boundSessionId)
      : NavigationGraphManager.getInstance();
  }

  /** Resolve provenance out of band, re-applying it to the current session on every event. */
  private ensureBuildContext(appId: string): void {
    if (this.closed) {
      return;
    }
    const resolved = this.resolvedBuildContexts.get(appId);
    if (resolved) {
      this.applyBuildContext(resolved);
      return;
    }
    this.getNavigationGraphManager().clearBuildContext(appId);
    if (
      this.buildContextInFlight.has(appId) ||
      this.timer.now() < (this.buildContextFailures.get(appId)?.retryAt ?? 0)
    ) {
      return;
    }
    const generation = this.buildContextGeneration.get(appId) ?? 0;
    this.buildContextGeneration.set(appId, generation);
    const attempt: IosBuildContextAttempt = { generation, controller: new AbortController() };
    this.buildContextInFlight.set(appId, attempt);
    // Match Android's macrotask deferral: register the navigation write first,
    // before metadata lookup or hashing can do any I/O.
    attempt.scheduledTimer = this.timer.setTimeout(() => {
      attempt.scheduledTimer = undefined;
      if (this.isBuildContextAttemptCurrent(appId, attempt)) {
        void this.resolveBuildContext(appId, attempt);
      }
    }, 0);
  }

  private isBuildContextAttemptCurrent(appId: string, attempt: IosBuildContextAttempt): boolean {
    return (
      !this.closed &&
      !attempt.controller.signal.aborted &&
      this.buildContextInFlight.get(appId) === attempt &&
      this.buildContextGeneration.get(appId) === attempt.generation
    );
  }

  private async readBuildContext(
    appId: string,
    attempt: IosBuildContextAttempt,
  ): Promise<IosBuildContextResolution> {
    if (!this.isBuildContextAttemptCurrent(appId, attempt)) {
      return { kind: "superseded" };
    }
    // Use metadata's existing transport predicate. Physical bundle paths belong
    // to the device filesystem and cannot be hashed by the host bundle walker.
    if (resolveIosDeviceKind({ deviceId: this.device.deviceId }) !== "simulator") {
      return { kind: "terminal", reason: "physical-device bundle hashing is unavailable" };
    }
    this.iosSource ??= createIosMetadataSource(this.device);
    this.appMetadata ??= new GetAppMetadata(this.device, defaultAdbClientFactory, this.iosSource);
    const metadata = await this.appMetadata.execute(appId);
    if (!this.isBuildContextAttemptCurrent(appId, attempt)) {
      return { kind: "superseded" };
    }
    if (!metadata) {
      return { kind: "failed" };
    }
    const buildNumber = metadata.buildNumber.trim();
    const version = iosBuildVersion(buildNumber);
    if (version === null) {
      return {
        kind: "terminal",
        reason: `CFBundleVersion ${JSON.stringify(buildNumber)} is blank, over 64 characters, or contains controls`,
      };
    }
    this.contentHashProvider ??= createContentHashProvider(
      this.device,
      defaultAdbClientFactory.create(this.device),
      this.iosSource,
    );
    const contentHash = await this.contentHashProvider.resolveContentHash(
      this.device,
      appId,
      version.versionKey ?? version.versionCode,
    );
    if (contentHash === null) {
      return { kind: "failed" };
    }
    return {
      kind: "resolved",
      context: {
        appId,
        deviceId: this.device.deviceId,
        ...version,
        contentHash,
      },
    };
  }

  private async resolveBuildContext(
    appId: string,
    attempt: IosBuildContextAttempt,
  ): Promise<boolean> {
    try {
      const result = await raceWithDeadline(() => this.readBuildContext(appId, attempt), {
        timer: this.timer,
        timeoutMs: IOS_BUILD_CONTEXT_DEADLINE_MS,
        signal: attempt.controller.signal,
        label: `iOS build-context resolution for ${appId}`,
      });
      if (!this.isBuildContextAttemptCurrent(appId, attempt) || result.kind === "superseded") {
        return false;
      }
      if (result.kind === "failed") {
        this.recordBuildContextFailure(appId);
        return false;
      }
      if (result.kind === "terminal") {
        logger.info(
          `[IOSCtrlProxyClient] ${appId}: ${result.reason}; using device attribution with the unknown build key until invalidation`,
        );
      }
      // (0, "") is NavigationGraphManager's existing default/unknown build key.
      // Keep its device dimension without inventing a version or content hash;
      // observation rows remain separate by device/session under that same key.
      const context: NavigationBuildContext =
        result.kind === "resolved"
          ? result.context
          : {
              appId,
              deviceId: this.device.deviceId,
              versionCode: 0,
              contentHash: "",
            };
      this.applyBuildContext(context);
      this.resolvedBuildContexts.set(appId, context);
      this.buildContextFailures.delete(appId);
      return true;
    } catch (error) {
      if (!this.isBuildContextAttemptCurrent(appId, attempt)) {
        // Invalidation/close intentionally aborts optional provenance; no write is lost.
        logger.debug(
          `[IOSCtrlProxyClient] Build-context resolution cancelled for ${appId}: ${errorMessage(error)}`,
        );
        return false;
      }
      logger.warn(
        `[IOSCtrlProxyClient] Build-context resolution failed for ${appId}: ${errorMessage(error)}`,
        error,
      );
      this.recordBuildContextFailure(appId);
      return false;
    } finally {
      // The deadline helper observes late rejections; abort also prevents a late
      // metadata result from starting hashing after the race has already settled.
      attempt.controller.abort();
      if (this.buildContextInFlight.get(appId) === attempt) {
        this.buildContextInFlight.delete(appId);
      }
    }
  }

  private recordBuildContextFailure(appId: string): void {
    const attempts = (this.buildContextFailures.get(appId)?.attempts ?? 0) + 1;
    this.buildContextFailures.set(appId, {
      attempts,
      retryAt: this.timer.now() + iosBuildContextBackoff.delayForAttempt(attempts),
    });
  }

  private applyBuildContext(context: NavigationBuildContext): void {
    const manager = this.getNavigationGraphManager();
    manager.setBuildContext(context);
    let managers = this.appliedBuildContextManagers.get(context.appId);
    if (!managers) {
      managers = new Set();
      this.appliedBuildContextManagers.set(context.appId, managers);
    }
    managers.add(manager);
  }

  private clearClientBuildContext(appId: string): boolean {
    // Clear earlier session bindings too: close must not leave a released device
    // attributable on a manager to which this client previously applied context.
    const managers =
      this.appliedBuildContextManagers.get(appId) ?? new Set<NavigationGraphManager>();
    for (const manager of managers) {
      manager.clearBuildContext(appId);
    }
    this.appliedBuildContextManagers.delete(appId);
    try {
      this.getNavigationGraphManager().clearBuildContext(appId);
      return true;
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Could not clear build context for ${appId}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  private invalidateBuildContext(appId: string): void {
    this.buildContextGeneration.set(appId, (this.buildContextGeneration.get(appId) ?? 0) + 1);
    const attempt = this.buildContextInFlight.get(appId);
    if (attempt?.scheduledTimer !== undefined) {
      this.timer.clearTimeout(attempt.scheduledTimer);
    }
    attempt?.controller.abort();
    this.buildContextInFlight.delete(appId);
    this.buildContextFailures.delete(appId);
    this.resolvedBuildContexts.delete(appId);
    this.contentHashProvider?.invalidate(this.device.deviceId, appId);
    this.clearClientBuildContext(appId);
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTesting(
    device: BootedDevice,
    port: number,
    wsFactory: WebSocketFactory,
    timer: Timer,
    serviceManagerFactory: ServiceManagerFactory = noOpServiceManagerFactory,
    bootedDeviceLister?: BootedDeviceLister,
    deviceConnectionLostNotifier?: DeviceConnectionLostNotifier,
    sdkEventIngestor?: IosSdkEventIngestor,
    retryExecutor?: RetryExecutor,
    options: boolean | IosCtrlProxyClientOptions = false,
  ): IOSCtrlProxyClient {
    // Default test lister always reports the device as booted so existing tests
    // are unaffected. Tests that verify boot-check behavior supply their own lister.
    const lister = bootedDeviceLister ?? (async () => [device]);
    return new IOSCtrlProxyClient(device, port, {
      ...(typeof options === "boolean" ? { transientObserver: options } : options),
      iosSource:
        typeof options === "boolean"
          ? noOpIosMetadataSource
          : (options.iosSource ?? noOpIosMetadataSource),
      wsFactory,
      timer,
      serviceManagerFactory,
      bootedDeviceLister: lister,
      deviceConnectionLostNotifier,
      sdkEventIngestor,
      retryExecutor,
    });
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    for (const instance of IOSCtrlProxyClient.instances.values()) {
      void instance.close();
    }
    IOSCtrlProxyClient.instances.clear();
    IOSCtrlProxyManager.resetRetiredDevicesForTesting();
  }

  // ===========================================================================
  // Auto-setup on connection failure
  // ===========================================================================

  /**
   * Probe the WebSocket directly without entering the automatic runner setup path.
   */
  public async connectWithoutSetup(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const interest = this.acquirePendingConnectInterest();

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const settle = (complete: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        interest.release();
        signal?.removeEventListener("abort", abortConnection);
        complete();
      };
      const abortConnection = (): void => {
        settle(() => {
          if (this.pendingConnectJoiners === 0) {
            this.abortPendingConnect();
          }
          reject(signal!.reason);
        });
      };

      signal?.addEventListener("abort", abortConnection, { once: true });
      void this.connectWebSocket(undefined, interest).then(
        (connected) => settle(() => resolve(connected)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Override ensureConnected to automatically set up CtrlProxy when
   * the WebSocket connection fails. This covers all tool calls (observe, tap, etc.).
   */
  public override async ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    this.lastConnectFailure = undefined;
    if (this.closed) {
      this.lastConnectFailure = { reason: "connection_lost", detail: "client closed" };
      return false;
    }
    // Direct session tools connect here without passing through the manager.
    await IOSCtrlProxyManager.awaitStartupOrphanRunnerReap();

    if (this.closed) {
      this.lastConnectFailure = { reason: "connection_lost", detail: "client closed" };
      return false;
    }

    const connected = await super.ensureConnected(perf);
    if (connected) {
      return true;
    }

    if (this.getReconnectStatus()) {
      return false;
    }

    // Prevent re-entry during auto-setup
    if (this.isAttemptingAutoSetup) {
      this.lastConnectFailure = {
        reason: "auto_setup_failed",
        detail: "auto-setup already running",
      };
      return false;
    }

    this.isAttemptingAutoSetup = true;
    try {
      const manager = this.serviceManagerFactory(this.device);

      // If the service is already running (health endpoint responds), the WebSocket
      // failure is transient (e.g. service just restarted by hot-reload). Skip the
      // full setup/download cycle — just reset attempts and retry the connection.
      const alreadyRunning = await manager.isRunning();
      // Diagnostic: the decisive state for why a reused session's observe fails.
      // alreadyRunning=false ⇒ the runner is gone since a prior session ⇒ a slow
      // cold setup happens inside the caller's bounded waitFor. alreadyRunning=true
      // ⇒ the runner lives and only the WebSocket needs re-opening (fast). (#2825)
      logger.info(
        `[IOSCtrlProxyClient] auto-setup decision: alreadyRunning(health)=${alreadyRunning}, ` +
          `port=${this.port}, hadOpenWs=${!!this.ws}, device=${this.device.deviceId}`,
      );
      if (alreadyRunning) {
        logger.info(
          `[IOSCtrlProxyClient] Service is running but WebSocket failed — transient issue, retrying connection`,
        );
        this.syncPortFromManager(manager);
        this.resetConnectionBudget();
        return await this.reconnectAfterSetup(perf);
      }

      // Check if the target simulator is still booted before attempting auto-setup.
      // Without this check, xcodebuild test-without-building will re-boot the simulator
      // as a side effect, causing phantom simulators.
      try {
        const bootedDevices = await this.bootedDeviceLister();
        const stillBooted = bootedDevices.some((d) => d.deviceId === this.device.deviceId);
        if (!stillBooted) {
          logger.info(
            `[IOSCtrlProxyClient] Target simulator ${this.device.deviceId} is no longer booted, skipping auto-setup`,
          );
          this.lastConnectFailure = { reason: "simulator_not_booted" };
          return false;
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxyClient] Failed to check simulator boot state: ${error}`);
        // Proceed with auto-setup on failure to check — better to attempt than to silently skip
      }

      logger.info(
        `[IOSCtrlProxyClient] WebSocket connection failed, attempting auto-setup of CtrlProxy`,
      );
      const result = await manager.setup(true, perf);

      if (!result.success) {
        logger.warn(`[IOSCtrlProxyClient] Auto-setup failed: ${result.message}`);
        this.lastConnectFailure = this.autoSetupFailure(result, manager);
        return false;
      }

      this.syncPortFromManager(manager);

      logger.info(`[IOSCtrlProxyClient] Auto-setup succeeded, retrying WebSocket connection`);
      // Reset the connection budget to allow a fresh connection attempt
      this.resetConnectionBudget();
      return await this.reconnectAfterSetup(perf);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Auto-setup error: ${error}`);
      this.lastConnectFailure = { reason: "auto_setup_failed", detail: String(error) };
      return false;
    } finally {
      this.isAttemptingAutoSetup = false;
    }
  }

  private autoSetupFailure(
    result: CtrlProxyIosSetupResult,
    manager: CtrlProxyIosManager,
  ): { reason: IosHierarchyUnavailableReason; detail: string } {
    return {
      reason:
        result.recoveryInterrupted && manager.isRecoveryInFlight?.()
          ? "service_recovering"
          : "auto_setup_failed",
      detail: result.recoveryInterrupted ? (result.error ?? result.message) : result.message,
    };
  }

  private async reconnectAfterSetup(perf: PerformanceTracker): Promise<boolean> {
    const reconnected = await super.ensureConnected(perf);
    if (!reconnected) {
      this.lastConnectFailure = {
        reason: "connection_lost",
        detail: "WebSocket reconnect failed after setup",
      };
    }
    return reconnected;
  }

  protected override connectWebSocket(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    interest?: { release: () => void },
  ): Promise<boolean> {
    if (this.closed) {
      return Promise.resolve(false);
    }
    return super.connectWebSocket(perf, interest);
  }

  public override async close(): Promise<void> {
    this.closed = true;
    // Synchronous teardown before super.close() can await socket cleanup.
    for (const appId of this.buildContextGeneration.keys()) {
      this.invalidateBuildContext(appId);
    }
    this.buildContextGeneration.clear();
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
    this.failPendingRestart("Client closed before stable reconnect");
    try {
      await super.close();
    } finally {
      const registered = IOSCtrlProxyClient.instances.get(this.device.deviceId);
      if (registered === this) {
        IOSCtrlProxyClient.instances.delete(this.device.deviceId);
      }
      if (this.allocatedPort !== null && (!registered || registered === this)) {
        PortManager.releaseIfAllocated(this.device.deviceId, this.allocatedPort);
      }
      this.allocatedPort = null;
    }
  }

  private syncPortFromManager(manager: CtrlProxyIosManager): void {
    this.updatePort(manager.getServicePort());
  }

  private updatePort(port: number): void {
    if (port !== this.port) {
      logger.info(
        `[IOSCtrlProxyClient] CtrlProxy service port changed from ${this.port} to ${port}`,
      );
      this.port = port;
      this.allocatedPort = null;
      // Invalidate any in-flight connect the same way close() does: a connect
      // that is mid-handshake snapshotted the old generation and is dialing the
      // now-stale old port (this.ws is still null, isConnecting is true), so its
      // `open` must be discarded rather than installed. Bumping the generation
      // makes the base connectWebSocket() open-guard drop that socket and clear
      // isConnecting, leaving a fresh connect free to dial the new port.
      this.connectionGeneration++;
      // Eagerly abort a handshake still stuck in CONNECTING (this.ws null,
      // isConnecting true, dialing the now-stale old port): the generation bump
      // above is only observed inside the socket's open/error handlers, so a
      // socket emitting neither would keep isConnecting true until
      // connectionTimeoutMs, stalling the new-port connect by up to ~5s. (#5656)
      this.abortPendingConnect();
      // The connection-attempt budget is per-endpoint: failures against the old
      // port must not cool down the new one. Without this reset, a port change on
      // the max-th in-flight attempt leaves connectionAttempts at the ceiling, so
      // connectWebSocket()'s cooldown check refuses to dial the new port for the
      // reset interval — the wedged state AC2 forbids.
      this.resetConnectionBudget();
      if (this.ws) {
        logger.info(
          "[IOSCtrlProxyClient] Closing stale WebSocket after CtrlProxy service port change",
        );
        const staleSocket = this.ws;
        this.ws = null;
        this.stopHealthCheck();
        this.requestManager.cancelAll(new CtrlProxyServicePortChangedError());
        staleSocket.removeAllListeners();
        staleSocket.close();
      }
    }
  }

  // ===========================================================================
  // Delegate Context Factories
  // ===========================================================================

  protected override extraDelegateContextFields(): Partial<DelegateContext> {
    return {
      serializeRequest: serializeIosRequest,
      getReconnectStatus: () => this.getReconnectStatus(),
      isCommandSupported: (messageType) => this.isCommandSupported(messageType),
      getSupportedCommands: () => this.getSupportedCommands(),
      unsupportedCommandError: (messageType) => this.buildUnsupportedCommandError(messageType),
    };
  }

  private createHierarchyDelegateContext(): HierarchyDelegateContext {
    return {
      ...this.createDelegateContext(),
      getLastConnectFailure: () => this.lastConnectFailure,
      getDeviceId: () => this.device.deviceId,
      cacheFreshTtlMs: IOSCtrlProxyClient.CACHE_FRESH_TTL_MS,
      getCachedHierarchy: () => this.cachedHierarchy,
      setCachedHierarchy: (h) => {
        const sameCapture =
          h !== null &&
          this.cachedHierarchy !== null &&
          h.hierarchy.updatedAt === this.cachedHierarchy.hierarchy.updatedAt;
        const previousRevision = this.cachedHierarchyDisplayRevision;
        this.cachedHierarchy = h;
        if (h === null || h.fresh) {
          this.resetOlderHierarchyPushRun();
        }
        this.cachedHierarchyDisplayRevision = sameCapture
          ? previousRevision
          : displayTransitions.revision(this.device.deviceId);
      },
      suppressHierarchyObservationStreamPush: (requestId, timeoutMs) =>
        this.suppressHierarchyObservationStreamPush(requestId, timeoutMs),
      markObserverHierarchyRequest: (requestId) => {
        this.observerHierarchyRequestIds.add(requestId);
      },
      unmarkObserverHierarchyRequest: (requestId) => {
        this.observerHierarchyRequestIds.delete(requestId);
      },
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

  private get hierarchy(): CtrlProxyHierarchyDelegate {
    return this.lazyDelegate(
      () => this._hierarchy,
      (value) => {
        this._hierarchy = value;
      },
      () => new CtrlProxyHierarchyDelegate(this.createHierarchyDelegateContext()),
    );
  }

  private get screenshot(): CtrlProxyScreenshot {
    return this.lazyDelegate(
      () => this._screenshot,
      (value) => {
        this._screenshot = value;
      },
      () => new CtrlProxyScreenshot(this.createDelegateContext()),
    );
  }

  private get navigation(): CtrlProxyNavigation {
    return this.lazyDelegate(
      () => this._navigation,
      (value) => {
        this._navigation = value;
      },
      () => new CtrlProxyNavigation(this.createDelegateContext()),
    );
  }

  private get clipboard(): CtrlProxyClipboard {
    return this.lazyDelegate(
      () => this._clipboard,
      (value) => {
        this._clipboard = value;
      },
      () => new CtrlProxyClipboard(this.createDelegateContext()),
    );
  }

  private get voiceOver(): CtrlProxyVoiceOver {
    return this.lazyDelegate(
      () => this._voiceOver,
      (value) => {
        this._voiceOver = value;
      },
      () => new CtrlProxyVoiceOver(this.createDelegateContext()),
    );
  }

  private get storage(): CtrlProxyStorage {
    return this.lazyDelegate(
      () => this._storage,
      (value) => {
        this._storage = value;
      },
      () =>
        new CtrlProxyStorage(
          this.createDelegateContext(),
          () => this.boundSessionId,
          (appId) => iosMutationTokens.get(this.device.deviceId, appId),
        ),
    );
  }

  private get keyboard(): CtrlProxyKeyboard {
    return this.lazyDelegate(
      () => this._keyboard,
      (value) => {
        this._keyboard = value;
      },
      () => new CtrlProxyKeyboard(this.createDelegateContext()),
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

  private get database(): CtrlProxyDatabase {
    return this.lazyDelegate(
      () => this._database,
      (value) => {
        this._database = value;
      },
      () => new CtrlProxyDatabase(this.createDelegateContext()),
    );
  }

  private get permissions(): CtrlProxyPermissions {
    return this.lazyDelegate(
      () => this._permissions,
      (value) => {
        this._permissions = value;
      },
      () => new CtrlProxyPermissions(this.createDelegateContext()),
    );
  }

  // ===========================================================================
  // DeviceServiceClient abstract method implementations
  // ===========================================================================

  protected getWebSocketUrl(): string {
    const wsHost = this.resolveWebSocketHost();
    return `ws://${wsHost}:${this.port}/ws`;
  }

  protected handleMessage(data: WebSocket.Data): void {
    // Inbound frames indicate an active app; reset the SDK-event poll backoff.
    this.noteSdkEventPollWsActivity();
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      this.processMessage(message);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to parse message: ${error}`);
    }
  }

  private sdkEventPollTimer: ReturnType<typeof setTimeout> | null = null;

  protected onConnectionEstablished(): void {
    if (this.transientObserver) {
      this.connectedSocketPort = this.port;
      return;
    }
    // Reset failure counter on successful connection
    this.consecutiveConnectionFailures = 0;
    this.connectedSocketPort = this.port;
    if (this.pendingRestartToken !== undefined && this.restartAcceptsReplacement) {
      this.restartReplacementSocket = this.ws;
    }
    // A short stability window proves the new socket remains usable. The
    // injected timer lets a close cancel rearming without a wall-clock race.
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
    }
    this.restartRearmTimeout = this.timer.setTimeout(() => {
      this.restartRearmTimeout = null;
      this.completeStableRestartConnection();
    }, IOSCtrlProxyClient.RESTART_REARM_STABILITY_MS);
    logger.info(`[IOSCtrlProxyClient] Connection established, reset failure counter`);

    // Start polling for SDK events from the CtrlProxy HTTP endpoint
    this.startSdkEventPolling();

    // Resume the screenshot keepalive after a (re)connect. onConnectionClosed()
    // cancels it; without restarting here, a transient drop on a STATIC screen
    // leaves the live view frozen forever. Subscriber-gated and idempotent.
    this.startScreenshotBackoff();
  }

  private syncNetworkMockRulesToDevice(): void {
    if (
      !this.hasSdkCapability("network_mocking") &&
      !this.isLegacySdkCommandSupported("network_mocking")
    ) {
      return;
    }
    if (!serverConfig.isNetworkMockableEnabled()) {
      return;
    }

    try {
      // Always sync mock rules on reconnect. Sending an empty list clears
      // stale rules that may linger in the iOS SDK after a CtrlProxy restart.
      const rules = buildNetworkMockRules(NetworkState.getInstance());
      this.sendMessage(JSON.stringify({ type: "set_network_mock_rules", rules }));
    } catch (e) {
      logger.warn(`[IOSCtrlProxyClient] Failed to sync network mock rules on reconnect: ${e}`);
    }
  }

  private syncNetworkErrorSimulationToDevice(): void {
    if (
      !this.hasSdkCapability("network_error_simulation") &&
      !this.isLegacySdkCommandSupported("network_error_simulation")
    ) {
      return;
    }
    if (!this.isCommandSupported("set_network_error_simulation")) {
      logger.info(
        "[IOSCtrlProxyClient] Skipping network error simulation sync; runner does not advertise set_network_error_simulation",
      );
      return;
    }
    try {
      const sim = NetworkState.getInstance().simulation;
      if (sim === null) {
        this.sendMessage(
          JSON.stringify({
            type: "set_network_error_simulation",
            enabled: false,
          }),
        );
        return;
      }
      this.sendMessage(
        JSON.stringify({
          type: "set_network_error_simulation",
          enabled: true,
          errorType: sim.errorType,
          limit: sim.limit,
          expiresAtEpochMs: sim.expiresAt,
        }),
      );
    } catch (e) {
      logger.warn(
        `[IOSCtrlProxyClient] Failed to sync network error simulation on reconnect: ${e}`,
      );
    }
  }

  private invalidateSdkCapabilities(): void {
    this.sdkCapabilityGeneration++;
    this.sdkCapabilities = null;
    this.sdkCapabilitiesKnown = false;
    this.sdkCapabilitiesKnownAt = 0;
    this.sdkCapabilityRefreshInFlight = null;
  }

  private hasSdkCapability(capability: IosSdkCapability, bundleId?: string): boolean {
    return IOSCtrlProxyClient.capabilitiesInclude(this.sdkCapabilities, capability, bundleId);
  }

  private static capabilitiesInclude(
    capabilities: IosSdkCapabilities | null,
    capability: IosSdkCapability,
    bundleId?: string,
  ): boolean {
    const normalizedBundleId = bundleId?.trim();
    return (
      capabilities !== null &&
      (normalizedBundleId === undefined || capabilities.bundleId === normalizedBundleId) &&
      capabilities.capabilities.has(capability)
    );
  }

  private async refreshSdkCapabilities(): Promise<IosSdkCapabilities | null> {
    if (!this.isCommandSupported("get_sdk_capabilities")) {
      this.sdkCapabilities = null;
      this.sdkCapabilitiesKnown = true;
      return null;
    }

    const generation = this.sdkCapabilityGeneration;
    if (this.sdkCapabilityRefreshInFlight?.generation === generation) {
      return this.sdkCapabilityRefreshInFlight.promise;
    }

    const promise = this.requestSdkCapabilities(generation);
    const inFlight = { generation, promise };
    this.sdkCapabilityRefreshInFlight = inFlight;
    void promise
      .finally(() => {
        if (this.sdkCapabilityRefreshInFlight === inFlight) {
          this.sdkCapabilityRefreshInFlight = null;
        }
      })
      .catch((error) => {
        // The caller handles the rejection; this branch prevents an unhandled promise rejection.
        logger.debug(`[IOSCtrlProxyClient] SDK capability refresh cleanup: ${errorMessage(error)}`);
      });
    return promise;
  }

  private async requestSdkCapabilities(generation: number): Promise<IosSdkCapabilities | null> {
    const result = await sendCommand<IosSdkCapabilitiesResult>(this.createDelegateContext(), {
      idPrefix: "sdkCapabilities",
      responseType: "sdk_capabilities",
      messageType: "get_sdk_capabilities",
      timeoutMs: 1000,
      cancelScreenshotBackoff: false,
      errorLabel: "SDK capability query",
      notConnectedError: () => ({
        success: false,
        available: false,
        capabilities: [],
        totalTimeMs: 0,
      }),
      timeoutError: (timeoutMs) => ({
        success: false,
        available: false,
        capabilities: [],
        totalTimeMs: timeoutMs,
      }),
      unsupportedCommandError: () => ({
        success: false,
        available: false,
        capabilities: [],
        totalTimeMs: 0,
      }),
    });

    let capabilities: IosSdkCapabilities | null = null;
    if (!result.success) {
      return null;
    }

    if (result.success && result.available && result.bundleId) {
      capabilities = {
        bundleId: result.bundleId,
        capabilities: new Set(
          (result.capabilities ?? []).filter(
            (capability): capability is IosSdkCapability =>
              capability === "hierarchy" ||
              capability === "network_mocking" ||
              capability === "network_fault_rules" ||
              capability === "network_error_simulation" ||
              capability === "database" ||
              capability === "highlight",
          ),
        ),
      };
    }

    if (generation === this.sdkCapabilityGeneration) {
      this.sdkCapabilities = capabilities;
      this.sdkCapabilitiesKnown = true;
      this.sdkCapabilitiesKnownAt = this.timer.now();
    }
    return generation === this.sdkCapabilityGeneration ? capabilities : null;
  }

  private async refreshSdkCapabilitiesAndSync(): Promise<void> {
    const capabilities = await this.refreshSdkCapabilities();
    if (capabilities === null) {
      if (this.supportedCommands !== null && !this.supportedCommands.has("get_sdk_capabilities")) {
        this.syncNetworkMockRulesToDevice();
        this.syncNetworkErrorSimulationToDevice();
      }
      return;
    }
    this.syncNetworkMockRulesToDevice();
    this.syncNetworkErrorSimulationToDevice();
  }

  private sdkUnavailableResult(capability: IosSdkCapability): BaseResult {
    return {
      success: false,
      totalTimeMs: 0,
      error: `The foreground iOS app does not expose the AutoMobile SDK capability ${capability}.`,
    };
  }

  private async ensureSdkCapability(
    capability: IosSdkCapability,
    bundleId?: string,
  ): Promise<boolean> {
    if (this.supportedCommands === null || !this.supportedCommands.has("get_sdk_capabilities")) {
      return this.isLegacySdkCommandSupported(capability);
    }
    if (this.sdkCapabilitiesKnown) {
      if (
        this.sdkCapabilities === null &&
        this.timer.now() - this.sdkCapabilitiesKnownAt >=
          IOSCtrlProxyClient.SDK_CAPABILITY_NEGATIVE_CACHE_TTL_MS
      ) {
        this.sdkCapabilitiesKnown = false;
      } else {
        return this.hasSdkCapability(capability, bundleId);
      }
    }
    // Generation binding (#6896): the waiter records the generation it was created
    // under and decides ONLY from that generation's probe result. A hierarchy update
    // can invalidate this generation and complete a replacement probe for another
    // foreground app before this probe answers; rereading the shared cache here
    // would let that app's capabilities authorize this waiter.
    const probeGeneration = this.sdkCapabilityGeneration;
    const probed = await this.refreshSdkCapabilities();
    if (probeGeneration !== this.sdkCapabilityGeneration) {
      throw new SdkCapabilityProbeSupersededError(
        capability,
        probeGeneration,
        this.sdkCapabilityGeneration,
      );
    }
    return IOSCtrlProxyClient.capabilitiesInclude(probed, capability, bundleId);
  }

  /**
   * Result-returning variant of `ensureSdkCapability` for callers that report
   * failures as a `BaseResult` instead of throwing: `null` means the capability
   * is available; otherwise the actionable failure to return as-is.
   */
  private async sdkCapabilityGate(capability: IosSdkCapability): Promise<BaseResult | null> {
    try {
      return (await this.ensureSdkCapability(capability))
        ? null
        : this.sdkUnavailableResult(capability);
    } catch (error) {
      if (error instanceof SdkCapabilityProbeSupersededError) {
        logger.info(`[IOSCtrlProxyClient] ${error.message}`);
        return { success: false, totalTimeMs: 0, error: error.message };
      }
      throw error;
    }
  }

  private isLegacySdkCommandSupported(capability: IosSdkCapability): boolean {
    const commandByCapability: Record<IosSdkCapability, string> = {
      hierarchy: "request_hierarchy",
      network_mocking: "set_network_mock_rules",
      network_fault_rules: "set_network_fault_rules",
      network_error_simulation: "set_network_error_simulation",
      database: "execute_sql",
      highlight: "add_highlight",
    };
    return this.isCommandSupported(commandByCapability[capability]);
  }

  private async requireSdkCapability(
    capability: IosSdkCapability,
    bundleId?: string,
  ): Promise<void> {
    if (!(await this.ensureSdkCapability(capability, bundleId))) {
      throw new Error(this.sdkUnavailableResult(capability).error);
    }
  }

  public async syncNetworkMockRulesIfAvailable(): Promise<void> {
    try {
      if (await this.ensureSdkCapability("network_mocking")) {
        this.syncNetworkMockRulesToDevice();
      }
    } catch (error) {
      if (!(error instanceof SdkCapabilityProbeSupersededError)) {
        throw error;
      }
      // Safe to swallow: the generation that superseded this probe runs its own
      // refreshSdkCapabilitiesAndSync, which re-syncs the mock rules to the device.
      logger.debug(`[IOSCtrlProxyClient] mock-rule sync skipped: ${error.message}`);
    }
  }

  private syncHierarchyCadenceToDevice(): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    this.refreshObservationStreamHierarchyCadence(
      server.getHierarchyIntervalMsForDevice(this.device.deviceId),
    );
  }

  protected onConnectionClosed(): void {
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
    if (this.restartReplacementSocket !== null || this.pendingRestartToken === undefined) {
      this.failPendingRestart("WebSocket closed before stable reconnect");
    }
    this.cancelScreenshotBackoff();
    this.onClientClosedWithoutConnection();
    this.cachedHierarchy = null;
    this.resetOlderHierarchyPushRun();
    this.observerHierarchyRequestIds.clear();
    this.clearSdkScreenIdentity();
    this.supportedCommands = null;
    this.rejectedCommands.clear();
    this.supportedFeatures = null;
    if (this.transientObserver) {
      return;
    }
    this.deviceConnectionLostNotifier.onDeviceConnectionLost(this.device.deviceId);

    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.dispose();
      this.hierarchyNavigationDetector = null;
    }
  }

  protected override onClientClosedWithoutConnection(): void {
    this._hierarchy?.resetState();
    this.stopSdkEventPolling();
    this.sdkEventPollGeneration++;
    this.sdkEventPollAbortController?.abort();
    this.sdkEventPollAbortController = null;
  }

  protected override onConnectAttemptFailed(): void {
    if (this.closed || !this.autoReconnectEnabled) {
      return;
    }

    // Track connection failure and potentially trigger service restart
    this.consecutiveConnectionFailures++;
    logger.info(
      `[IOSCtrlProxyClient] Connection attempt failed (failure count: ${this.consecutiveConnectionFailures})`,
    );

    if (
      this.consecutiveConnectionFailures > 0 &&
      this.consecutiveConnectionFailures % IOSCtrlProxyClient.MAX_FAILURES_BEFORE_RESTART === 0 &&
      !this.isRequestingServiceRestart
    ) {
      this.triggerServiceRestart();
    }
  }

  private startSdkEventPolling(): void {
    this.stopSdkEventPolling();
    this.sdkEventPollConsecutiveEmpty = 0;
    // Self-rescheduling loop (was a fixed setInterval) so the cadence can adapt:
    // an immediate poll, then reschedule at fast or backed-off cadence based on
    // whether batches keep coming back empty.
    void this.runSdkEventPollCycle(this.sdkEventPollGeneration);
  }

  private async runSdkEventPollCycle(generation: number): Promise<void> {
    if (generation !== this.sdkEventPollGeneration) {
      return;
    }
    const result = await this.pollSdkEvents();
    if (generation !== this.sdkEventPollGeneration) {
      return;
    }
    if (result.receivedEvents) {
      this.sdkEventPollConsecutiveEmpty = 0;
    } else {
      this.sdkEventPollConsecutiveEmpty++;
    }
    this.scheduleNextSdkEventPoll(generation);
  }

  private scheduleNextSdkEventPoll(generation: number): void {
    if (generation !== this.sdkEventPollGeneration) {
      return;
    }
    if (this.sdkEventPollTimer) {
      this.timer.clearTimeout(this.sdkEventPollTimer);
    }
    this.sdkEventPollTimer = this.timer.setTimeout(() => {
      void this.runSdkEventPollCycle(generation);
    }, this.currentSdkEventPollIntervalMs());
  }

  private currentSdkEventPollIntervalMs(): number {
    return this.sdkEventPollConsecutiveEmpty >=
      IOSCtrlProxyClient.SDK_EVENT_POLL_EMPTY_BATCHES_BEFORE_BACKOFF
      ? IOSCtrlProxyClient.SDK_EVENT_POLL_BACKOFF_INTERVAL_MS
      : IOSCtrlProxyClient.SDK_EVENT_POLL_INTERVAL_MS;
  }

  /**
   * Any inbound WebSocket frame from the runner is a signal the app is active,
   * so reset the empty-batch backoff and — if we had already backed off — restore
   * fast cadence immediately rather than waiting out the long backoff timer.
   */
  private noteSdkEventPollWsActivity(): void {
    if (this.sdkEventPollConsecutiveEmpty === 0) {
      return;
    }
    const wasBackedOff =
      this.sdkEventPollConsecutiveEmpty >=
      IOSCtrlProxyClient.SDK_EVENT_POLL_EMPTY_BATCHES_BEFORE_BACKOFF;
    this.sdkEventPollConsecutiveEmpty = 0;
    if (wasBackedOff && this.sdkEventPollTimer) {
      this.scheduleNextSdkEventPoll(this.sdkEventPollGeneration);
    }
  }

  private async pollSdkEvents(): Promise<SdkEventPollResult> {
    const generation = this.sdkEventPollGeneration;
    if (this.sdkEventPollInFlight?.generation === generation) {
      return this.sdkEventPollInFlight.promise;
    }

    const promise = this.pollSdkEventsOnce(generation);
    const inFlight = { generation, promise };
    this.sdkEventPollInFlight = inFlight;
    void promise
      .finally(() => {
        if (this.sdkEventPollInFlight === inFlight) {
          this.sdkEventPollInFlight = null;
        }
      })
      .catch((error) => logger.debug(`[IOSCtrlProxy] SDK event poll cleanup failed: ${error}`));
    return promise;
  }

  private async pollSdkEventsOnce(generation: number): Promise<SdkEventPollResult> {
    const pollGeneration: SdkScreenIdentityPollGeneration = {
      clearGeneration: this.sdkScreenIdentityClearGeneration,
      applicationGenerations: new Map(this.sdkScreenIdentityGenerationsByApplicationId),
    };
    const host = this.resolveWebSocketHost();
    const url = `http://${host}:${this.port}/sdk-events`;
    const abortController = new AbortController();
    this.sdkEventPollAbortController = abortController;
    const timeoutId = this.timer.setTimeout(
      () => abortController.abort(),
      IOSCtrlProxyClient.SDK_EVENT_POLL_TIMEOUT_MS,
    );
    try {
      const resp = await fetch(url, { signal: abortController.signal });
      if (generation !== this.sdkEventPollGeneration) {
        return this.emptySdkEventPollResult();
      }
      if (!resp.ok) {
        return this.emptySdkEventPollResult();
      }
      const batches = (await resp.json()) as Array<{
        bundleId?: string;
        events?: Array<{ eventType: string; payload: string }>;
      }>;
      const pollResult = await this.processSdkEventBatches(batches, generation, pollGeneration);
      return pollResult;
    } catch (error) {
      // Polling failure is non-fatal (endpoint down, timeout) — trace at debug.
      logger.debug(`[IOSCtrlProxy] SDK event poll failed: ${error}`);
      return this.emptySdkEventPollResult();
    } finally {
      this.timer.clearTimeout(timeoutId);
      if (this.sdkEventPollAbortController === abortController) {
        this.sdkEventPollAbortController = null;
      }
    }
  }

  private async processSdkEventBatches(
    batches: Array<{ bundleId?: string; events?: Array<{ eventType: string; payload: string }> }>,
    generation: number,
    pollGeneration: SdkScreenIdentityPollGeneration,
  ): Promise<SdkEventPollResult> {
    const events = this.decodeSdkEventBatches(batches, generation);
    const rememberedApplicationIds = new Set<string>();
    for (const event of events) {
      if (generation !== this.sdkEventPollGeneration) {
        return this.emptySdkEventPollResult();
      }
      const lifecycleEventHasCurrentPoll = this.isSdkScreenIdentityPollCurrent(
        event.applicationId,
        pollGeneration,
      );
      if (this.applySdkScreenIdentityLifecycleEvent(event)) {
        if (lifecycleEventHasCurrentPoll && event.applicationId) {
          pollGeneration.applicationGenerations.set(
            event.applicationId,
            this.getSdkScreenIdentityGeneration(event.applicationId),
          );
        }
        continue;
      }
      if (
        this.isSdkScreenIdentityPollCurrent(event.applicationId, pollGeneration) &&
        this.rememberSdkScreenIdentity(
          event.eventType,
          event.applicationId,
          event.payload,
          event.timestamp,
          event.sequenceNumber,
        )
      ) {
        rememberedApplicationIds.add(event.applicationId!);
      }
    }
    for (const event of events) {
      if (generation !== this.sdkEventPollGeneration) {
        return this.emptySdkEventPollResult();
      }
      await this.sdkEventIngestor.recordSdkEvent(
        { type: event.eventType, timestamp: event.timestamp, payload: event.payload },
        event.applicationId ?? null,
      );
    }
    return { receivedEvents: events.length > 0, rememberedApplicationIds };
  }

  private decodeSdkEventBatches(
    batches: Array<{ bundleId?: string; events?: Array<{ eventType: string; payload: string }> }>,
    generation: number,
  ): DecodedSdkEvent[] {
    return decodeSdkEventBatches(
      batches,
      () => this.timer.now(),
      () => generation === this.sdkEventPollGeneration,
    ).events;
  }

  private stopSdkEventPolling(): void {
    if (this.sdkEventPollTimer) {
      this.timer.clearTimeout(this.sdkEventPollTimer);
      this.sdkEventPollTimer = null;
    }
  }

  private rememberSdkScreenIdentity(
    eventType: string,
    applicationId: string | undefined,
    payload: Record<string, unknown>,
    timestamp: number,
    sequenceNumber: number | undefined,
  ): boolean {
    if (
      !applicationId ||
      !this.activateSdkScreenIdentitySession(applicationId, payload) ||
      !this.isSdkScreenIdentityTrackingEnabled(applicationId, payload)
    ) {
      return false;
    }
    const identity = deriveIosSdkScreenIdentity(eventType, applicationId, payload);
    const currentOrder = this.sdkScreenIdentityOrdersByApplicationId.get(applicationId);
    const isNewer =
      currentOrder === undefined ||
      timestamp > currentOrder.timestamp ||
      (timestamp === currentOrder.timestamp &&
        (sequenceNumber === undefined ||
          currentOrder.sequenceNumber === undefined ||
          sequenceNumber > currentOrder.sequenceNumber));
    if (identity && isNewer) {
      this.sdkScreenIdentitiesByApplicationId.set(applicationId, identity);
      this.sdkScreenIdentityOrdersByApplicationId.set(applicationId, { timestamp, sequenceNumber });
      return true;
    }
    return false;
  }

  private emptySdkEventPollResult(): SdkEventPollResult {
    return { receivedEvents: false, rememberedApplicationIds: new Set() };
  }

  private getSdkScreenIdentityGeneration(applicationId: string): number {
    return this.sdkScreenIdentityGenerationsByApplicationId.get(applicationId) ?? 0;
  }

  private invalidateSdkScreenIdentity(applicationId: string, retireSession: boolean = true): void {
    this.sdkScreenIdentityGenerationsByApplicationId.set(
      applicationId,
      this.getSdkScreenIdentityGeneration(applicationId) + 1,
    );
    const sessionId = this.sdkScreenIdentitySessionsByApplicationId.get(applicationId);
    if (retireSession && sessionId) {
      this.retireSdkScreenIdentitySession(applicationId, sessionId);
    }
    if (retireSession) {
      this.sdkScreenIdentityStartedSessionsByApplicationId.delete(applicationId);
      this.sdkScreenIdentitySessionEpochsByApplicationId.delete(applicationId);
    }
    this.sdkScreenIdentitiesByApplicationId.delete(applicationId);
    this.sdkScreenIdentityOrdersByApplicationId.delete(applicationId);
  }

  private applySdkScreenIdentityLifecycleEvent(event: DecodedSdkEvent): boolean {
    if (!event.applicationId || event.eventType !== "lifecycle") {
      return false;
    }
    if (event.payload.state === "sdk_session_started") {
      this.startSdkScreenIdentitySession(event.applicationId, event.payload);
      return true;
    }
    if (!this.activateSdkScreenIdentitySession(event.applicationId, event.payload)) {
      return true;
    }
    const trackingGeneration = this.getSdkScreenIdentityTrackingGeneration(event.payload);
    const currentGeneration = this.sdkScreenIdentityTrackingGenerationsByApplicationId.get(
      event.applicationId,
    );
    if (
      trackingGeneration === undefined ||
      currentGeneration === undefined ||
      trackingGeneration >= currentGeneration
    ) {
      if (trackingGeneration !== undefined) {
        this.sdkScreenIdentityTrackingGenerationsByApplicationId.set(
          event.applicationId,
          trackingGeneration,
        );
      }
    } else {
      return true;
    }
    if (event.payload.state === "sdk_tracking_disabled") {
      this.sdkScreenIdentityTrackingDisabledApplicationIds.add(event.applicationId);
      this.invalidateSdkScreenIdentity(event.applicationId, false);
      return true;
    }
    if (event.payload.state === "sdk_tracking_enabled") {
      this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(event.applicationId);
      return true;
    }
    return false;
  }

  private activateSdkScreenIdentitySession(
    applicationId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    if (!sessionId) {
      return true;
    }
    if (this.sdkScreenIdentityRetiredSessionsByApplicationId.get(applicationId)?.has(sessionId)) {
      return false;
    }
    const sessionEpoch = this.getSdkScreenIdentitySessionEpoch(payload);
    const currentEpoch = this.sdkScreenIdentitySessionEpochsByApplicationId.get(applicationId);
    const currentSessionId = this.sdkScreenIdentitySessionsByApplicationId.get(applicationId);
    if (
      this.isOlderSdkScreenIdentitySession(sessionId, sessionEpoch, currentEpoch, currentSessionId)
    ) {
      return false;
    }
    const startedSessionId =
      this.sdkScreenIdentityStartedSessionsByApplicationId.get(applicationId);
    if (
      this.isConflictingStartedSdkSession(startedSessionId, sessionId, sessionEpoch, currentEpoch)
    ) {
      return false;
    }
    if (currentSessionId && currentSessionId !== sessionId) {
      this.invalidateBuildContext(applicationId);
      this.retireSdkScreenIdentitySession(applicationId, currentSessionId);
      this.sdkScreenIdentitiesByApplicationId.delete(applicationId);
      this.sdkScreenIdentityOrdersByApplicationId.delete(applicationId);
      this.resetSdkScreenIdentityTrackingState(applicationId, payload);
      this.sdkScreenIdentityStartedSessionsByApplicationId.set(applicationId, sessionId);
    }
    this.sdkScreenIdentitySessionsByApplicationId.set(applicationId, sessionId);
    if (sessionEpoch !== undefined) {
      this.sdkScreenIdentitySessionEpochsByApplicationId.set(applicationId, sessionEpoch);
    }
    return true;
  }

  private isOlderSdkScreenIdentitySession(
    sessionId: string,
    sessionEpoch: number | undefined,
    currentEpoch: number | undefined,
    currentSessionId: string | undefined,
  ): boolean {
    return Boolean(
      sessionEpoch !== undefined &&
      currentEpoch !== undefined &&
      (sessionEpoch < currentEpoch ||
        (sessionEpoch === currentEpoch && currentSessionId && currentSessionId !== sessionId)),
    );
  }

  private isConflictingStartedSdkSession(
    startedSessionId: string | undefined,
    sessionId: string,
    sessionEpoch: number | undefined,
    currentEpoch: number | undefined,
  ): boolean {
    return Boolean(
      startedSessionId &&
      startedSessionId !== sessionId &&
      (sessionEpoch === undefined || currentEpoch === undefined || sessionEpoch <= currentEpoch),
    );
  }

  private startSdkScreenIdentitySession(
    applicationId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    if (!sessionId || !this.activateSdkScreenIdentitySession(applicationId, payload)) {
      return false;
    }
    this.sdkScreenIdentityStartedSessionsByApplicationId.set(applicationId, sessionId);
    return true;
  }

  private resetSdkScreenIdentityTrackingState(
    applicationId: string,
    payload: Record<string, unknown>,
  ): void {
    this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(applicationId);
    const trackingGeneration = this.getSdkScreenIdentityTrackingGeneration(payload);
    if (trackingGeneration === undefined) {
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.delete(applicationId);
    } else {
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.set(
        applicationId,
        trackingGeneration,
      );
    }
  }

  private retireSdkScreenIdentitySession(applicationId: string, sessionId: string): void {
    let retiredSessions = this.sdkScreenIdentityRetiredSessionsByApplicationId.get(applicationId);
    if (!retiredSessions) {
      retiredSessions = new Set<string>();
      this.sdkScreenIdentityRetiredSessionsByApplicationId.set(applicationId, retiredSessions);
    }
    retiredSessions.add(sessionId);
  }

  private isSdkScreenIdentityTrackingEnabled(
    applicationId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const trackingGeneration = this.getSdkScreenIdentityTrackingGeneration(payload);
    const currentGeneration =
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.get(applicationId);
    if (this.sdkScreenIdentityTrackingDisabledApplicationIds.has(applicationId)) {
      if (
        trackingGeneration === undefined ||
        currentGeneration === undefined ||
        trackingGeneration <= currentGeneration
      ) {
        return false;
      }
      this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(applicationId);
    }
    if (
      trackingGeneration !== undefined &&
      (currentGeneration === undefined || trackingGeneration > currentGeneration)
    ) {
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.set(
        applicationId,
        trackingGeneration,
      );
    }
    return true;
  }

  private getSdkScreenIdentityTrackingGeneration(
    payload: Record<string, unknown>,
  ): number | undefined {
    return typeof payload.trackingGeneration === "number" &&
      Number.isSafeInteger(payload.trackingGeneration)
      ? payload.trackingGeneration
      : undefined;
  }

  private getSdkScreenIdentitySessionEpoch(payload: Record<string, unknown>): number | undefined {
    return typeof payload.sessionEpoch === "number" && Number.isSafeInteger(payload.sessionEpoch)
      ? payload.sessionEpoch
      : undefined;
  }

  private isSdkScreenIdentityPollCurrent(
    applicationId: string | undefined,
    pollGeneration: SdkScreenIdentityPollGeneration,
  ): applicationId is string {
    return (
      applicationId !== undefined &&
      pollGeneration.clearGeneration === this.sdkScreenIdentityClearGeneration &&
      (pollGeneration.applicationGenerations.get(applicationId) ?? 0) ===
        this.getSdkScreenIdentityGeneration(applicationId)
    );
  }

  /**
   * Trigger CtrlProxy restart through the manager.
   * This is called when repeated WebSocket connection failures indicate
   * that the CtrlProxy process may have crashed.
   */
  private triggerServiceRestart(): void {
    if (
      this.closed ||
      IOSCtrlProxyManager.isDeviceRetired(this.device.deviceId) ||
      this.isRequestingServiceRestart
    ) {
      return;
    }

    const manager = this.serviceManagerFactory(this.device);
    const budget = manager.getForcedRestartBudget();
    if (budget.snapshot().state !== "idle") {
      this.logDeniedRestart(budget);
      return;
    }
    this.isRequestingServiceRestart = true;
    const recovery = this.restartServiceIfBooted(manager, budget).finally(() => {
      // An older completion must not erase a newer recovery's promise or guard.
      if (this.recoveryPromise === recovery) {
        this.isRequestingServiceRestart = false;
        this.recoveryPromise = null;
      }
    });
    this.recoveryPromise = recovery;
  }

  private failPendingRestart(reason: string): void {
    const token = this.pendingRestartToken;
    if (token !== undefined) {
      this.pendingRestartToken = undefined;
      this.serviceManagerFactory(this.device).getForcedRestartBudget().recordFailure(reason, token);
    }
    this.restartAcceptsReplacement = false;
    this.restartReplacementSocket = null;
    this.restartSocketBeforeTeardown = null;
    this.finishPendingRestart(false);
  }

  private completeStableRestartConnection(): void {
    if (!this.isConnected()) {
      this.failPendingRestart("WebSocket closed before stable reconnect");
      return;
    }
    if (this.pendingRestartToken !== undefined && this.ws !== this.restartReplacementSocket) {
      return;
    }
    const budget = this.serviceManagerFactory(this.device).getForcedRestartBudget();
    if (budget.snapshot().state === "suspended") {
      this.failPendingRestart("Restart budget suspended before stable reconnect");
      return;
    }
    const token = this.pendingRestartToken;
    if (budget.recordSuccess(token)) {
      this.pendingRestartToken = undefined;
      this.restartAcceptsReplacement = false;
      this.restartReplacementSocket = null;
      this.restartSocketBeforeTeardown = null;
      this.lastDeniedRestartState = undefined;
      if (token !== undefined) {
        this.finishPendingRestart(true);
      }
    } else if (token !== undefined) {
      this.failPendingRestart("WebSocket reconnect was superseded before stability");
    }
  }

  private acceptEarlyRestartReplacement(): void {
    if (
      !this.isConnected() ||
      this.ws === this.restartSocketBeforeTeardown ||
      this.connectedSocketPort !== this.port
    ) {
      return;
    }
    this.restartReplacementSocket = this.ws;
    // The original stability timer may already have fired while forceRestart
    // was still polling health. Credit that completed window now.
    if (!this.restartRearmTimeout) {
      this.completeStableRestartConnection();
    }
  }

  private hasAcceptedRestartReplacement(): boolean {
    return this.pendingRestartToken === undefined || this.ws === this.restartReplacementSocket;
  }

  private finishPendingRestart(stable: boolean): void {
    const resolve = this.resolvePendingRestart;
    this.resolvePendingRestart = undefined;
    resolve?.(stable);
  }

  /** Start a restart for this observed transport failure, subject to the manager budget. */
  public ensureRecoveryStarted(): void {
    this.triggerServiceRestart();
  }

  public override async awaitRecovery(
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<"recovered" | "not_recovering" | "failed" | "timed_out"> {
    const budget = this.serviceManagerFactory(this.device).getForcedRestartBudget();
    const throwIfExhausted = (): void => {
      const snapshot = budget.snapshot();
      if (snapshot.state === "exhausted") {
        throw new ActionableError(
          `Automatic iOS CtrlProxy recovery exhausted for ${this.device.deviceId} ` +
            `after ${snapshot.attempts} attempts: ${snapshot.lastFailureReason ?? "runner remained unavailable"}. ` +
            "Restart the simulator to rearm recovery.",
        );
      }
    };
    throwIfExhausted();
    const remainingMs = budget.timeRemainingMs();
    const result = await super.awaitRecovery(
      remainingMs === undefined ? budgetMs : Math.min(budgetMs, remainingMs),
      signal,
    );
    throwIfExhausted();
    return result;
  }

  /** Logs a denied restart once per non-idle budget state. */
  private logDeniedRestart(budget: ForcedRestartBudget): void {
    const snapshot = budget.snapshot();
    if (snapshot.state === "idle") {
      return;
    }
    if (snapshot.state !== this.lastDeniedRestartState) {
      logger.warn(
        `[IOSCtrlProxyClient] Automatic CtrlProxy restart ${snapshot.state} for ${this.device.deviceId}` +
          (snapshot.lastFailureReason ? `: ${snapshot.lastFailureReason}` : ""),
      );
      this.lastDeniedRestartState = snapshot.state;
    }
  }

  /** Rechecks boot and retirement before admission; only a failure for this attempt token consumes budget. */
  private async restartServiceIfBooted(
    manager: CtrlProxyIosManager,
    budget: ForcedRestartBudget,
  ): Promise<boolean> {
    try {
      const booted = await this.bootedDeviceLister();
      if (!booted.some((device) => device.deviceId === this.device.deviceId)) {
        logger.info(
          `[IOSCtrlProxyClient] Target simulator ${this.device.deviceId} is no longer booted, skipping restart`,
        );
        return false;
      }
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Failed to check simulator boot state: ${errorMessage(error)}`,
      );
      return false;
    }
    if (this.closed || IOSCtrlProxyManager.isDeviceRetired(this.device.deviceId)) {
      return false;
    }
    const token = budget.tryBeginAttempt();
    if (token === undefined) {
      this.logDeniedRestart(budget);
      return false;
    }
    this.pendingRestartToken = token;
    this.restartAcceptsReplacement = false;
    this.restartReplacementSocket = null;
    this.restartSocketBeforeTeardown = this.ws;
    const stableConnection = new Promise<boolean>((resolve) => {
      this.resolvePendingRestart = resolve;
    });
    this.lastDeniedRestartState = undefined;
    logger.info(
      `[IOSCtrlProxyClient] Triggering CtrlProxy restart after ${this.consecutiveConnectionFailures} connection failures`,
    );
    try {
      const withinRecoveryBudget = <T>(operation: Promise<T>, phase: string): Promise<T> =>
        raceWithDeadline(operation, {
          timer: this.timer,
          timeoutMs: budget.timeRemainingMs(),
          label: `iOS CtrlProxy ${phase} for ${this.device.deviceId}`,
        });
      // WebSocket failures are authoritative even when HTTP /health still responds.
      await withinRecoveryBudget(manager.forceRestart({ joinInFlightStart: true }), "restart");
      this.restartAcceptsReplacement = true;
      this.syncPortFromManager(manager);
      this.acceptEarlyRestartReplacement();
      this.resetConnectionBudget();
      logger.info(`[IOSCtrlProxyClient] CtrlProxy restart completed; reconnecting WebSocket`);
      const connected = await withinRecoveryBudget(this.connectBackgroundWebSocket(), "reconnect");
      if (!connected || !this.isConnected()) {
        this.failPendingRestart("WebSocket reconnect failed after CtrlProxy restart");
        logger.warn(`[IOSCtrlProxyClient] WebSocket reconnect failed after CtrlProxy restart`);
        return false;
      }
      if (!this.hasAcceptedRestartReplacement()) {
        this.failPendingRestart("No replacement WebSocket opened after CtrlProxy restart");
        return false;
      }
      if (this.pendingRestartToken !== undefined && !this.restartRearmTimeout) {
        this.failPendingRestart("No stable WebSocket reconnect observed");
      }
      return await withinRecoveryBudget(stableConnection, "stable reconnect");
    } catch (error) {
      this.failPendingRestart(errorMessage(error));
      logger.warn(`[IOSCtrlProxyClient] CtrlProxy restart failed: ${errorMessage(error)}`);
      return false;
    }
  }

  protected async setupBeforeConnect(
    _perf: PerformanceTracker,
    _signal: AbortSignal,
  ): Promise<void> {
    // The manager establishes iproxy for physical devices before connecting.
  }

  // ===========================================================================
  // Platform-specific methods
  // ===========================================================================

  private resolveWebSocketHost(): string {
    return "127.0.0.1";
  }

  private logTapDiagnostics(message: WebSocketMessage, hasDecodedResult: boolean): void {
    if (message.type !== "tap_coordinates_result" || message.tapDiagnostics === undefined) {
      return;
    }
    // Native JSON.stringify preserves the optional wire payload, including malformed values.
    logger.debug(`[CTRLPROXY_TAP_DIAG] ${JSON.stringify(message.tapDiagnostics)}`);
    const diagnostics = message.tapDiagnostics;
    if (
      hasDecodedResult &&
      diagnostics &&
      typeof diagnostics === "object" &&
      diagnostics.deliveryWarning === "eventDisplayMismatch"
    ) {
      logger.warn(
        `[CTRLPROXY_TAP_DIAG] deliveryWarning=eventDisplayMismatch route=${diagnostics.route ?? "unknown"} targetDisplayId=${diagnostics.targetDisplayId ?? "nil"} requestId=${message.requestId}`,
      );
    }
  }

  private resetOlderHierarchyPushRun(): void {
    this.consecutiveOlderHierarchyPushes = 0;
    this.lastDroppedOlderPushUpdatedAt = null;
  }

  private ignoreOlderHierarchyPush(message: WebSocketMessage): boolean {
    if (message.type !== "hierarchy_update" || message.requestId || !message.data) {
      return false;
    }
    if (
      this.cachedHierarchy === null ||
      !(message.data.updatedAt < this.cachedHierarchy.hierarchy.updatedAt)
    ) {
      this.resetOlderHierarchyPushRun();
      return false;
    }
    const cachedTimestamp = this.cachedHierarchy.hierarchy.updatedAt;
    const pushedTimestamp = message.data.updatedAt;
    const clockStep =
      cachedTimestamp - pushedTimestamp > IOSCtrlProxyClient.MAX_HIERARCHY_REBROADCAST_GAP_MS;
    this.consecutiveOlderHierarchyPushes =
      this.lastDroppedOlderPushUpdatedAt !== null &&
      pushedTimestamp > this.lastDroppedOlderPushUpdatedAt
        ? this.consecutiveOlderHierarchyPushes + 1
        : 1;
    if (
      clockStep ||
      this.consecutiveOlderHierarchyPushes >=
        IOSCtrlProxyClient.MAX_CONSECUTIVE_OLDER_HIERARCHY_PUSHES
    ) {
      logger.warn(
        `[IOSCtrlProxyClient] Resetting hierarchy push baseline (${clockStep ? "backward clock step" : "consecutive older push limit"}): pushed=${pushedTimestamp} cached=${cachedTimestamp}`,
      );
      this.resetOlderHierarchyPushRun();
      return false;
    }
    this.lastDroppedOlderPushUpdatedAt = pushedTimestamp;
    logger.debug(
      `[IOSCtrlProxyClient] Ignoring older hierarchy push: pushed=${pushedTimestamp} cached=${cachedTimestamp}`,
    );
    return true;
  }

  private processMessage(message: WebSocketMessage): void {
    const { type, requestId } = message;
    if (
      this.transientObserver &&
      !["connected", "hierarchy_update", "screenshot", "error"].includes(type)
    ) {
      return;
    }

    // Handle push messages (no requestId)
    if (type === "connected") {
      this.processConnectedMessage(message);
      return;
    }

    if (this.isSdkCapabilityFailure(message)) {
      this.invalidateSdkCapabilities();
    }

    if (type === "hierarchy_update" && message.data) {
      if (!this.prepareHierarchyMessage(message, requestId)) {
        return;
      }
    }

    // Handle request/response messages (with requestId) first
    if (requestId && this.resolveMessageResponse(message, type, requestId)) {
      return;
    }

    this.processPushMessage(type, message);
  }

  private processPushMessage(type: string, message: WebSocketMessage): void {
    // Handle push messages (no requestId)
    if (type === "hierarchy_update" && message.data) {
      this.processHierarchyPush(message);
      return;
    }

    // Handle performance update push messages from CADisplayLink FPS monitoring
    if (type === "performance_update") {
      if (message.performanceData) {
        this.handlePerformanceUpdate(message.performanceData);
      } else {
        logger.warn(
          `[IOSCtrlProxyClient] Received performance_update but no performanceData field`,
        );
      }
      return;
    }
  }

  private processConnectedMessage(message: WebSocketMessage): void {
    if (this.transientObserver) {
      return;
    }
    this.rejectedCommands.clear();
    this.supportedCommands = Array.isArray(message.supportedCommands)
      ? new Set(message.supportedCommands)
      : null;
    this.supportedFeatures = Array.isArray(message.supportedFeatures)
      ? new Set(message.supportedFeatures)
      : null;
    try {
      this.syncHierarchyCadenceToDevice();
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Hierarchy cadence sync failed: ${errorMessage(error)}`,
        error,
      );
    }
    this.invalidateSdkCapabilities();
    void this.refreshSdkCapabilitiesAndSync().catch((error) => {
      // SDK absence/version skew is expected; this trace is diagnostic only.
      logger.debug(`[IOSCtrlProxyClient] SDK capability refresh failed: ${error}`);
    });
    logger.info(`[IOSCtrlProxyClient] Received connected message`);
    return;
  }

  private prepareHierarchyMessage(
    message: WebSocketMessage,
    requestId: string | undefined,
  ): boolean {
    if (
      this.transientObserver &&
      (!requestId || !this.observerHierarchyRequestIds.has(requestId))
    ) {
      return false;
    }
    // Reject out-of-order pushes before they can affect cache or observation state.
    if (this.ignoreOlderHierarchyPush(message)) {
      return false;
    }
    // Retain the additive #4548 scale metadata on RECEIPT — the moment the hierarchy first
    // arrives — independent of whether it is later pushed to the observation stream. The push
    // is skipped entirely when there is no device-data server, and suppressed for explicit
    // initial-frame requests, so retaining inside pushHierarchyToObservationStream would leave
    // getScreenScaleMetadata() null on exactly the paths #4549 must still be able to read.
    const observerResponse = requestId ? this.observerHierarchyRequestIds.delete(requestId) : false;
    if (!observerResponse) {
      this.retainScaleMetadataFrom(message.data! as XCTestHierarchy);
      this.handleHierarchyUpdateForNavigation(message.data!, message.perfTiming);
    }
    // Record layout telemetry event using converted hierarchy (same format as observation stream)
    const converted = this.convertToViewHierarchyResult(message.data!);
    if (!observerResponse) {
      this.sdkEventIngestor.recordLayoutTelemetryEvent(converted);
    }
    // Only push to observation stream for request-response updates (with requestId).
    // Push messages (no requestId) are handled in the dedicated push-message branch below
    // to avoid duplicate hierarchy events.
    this.publishHierarchyResponse(message, requestId, converted, observerResponse);
    return true;
  }

  private publishHierarchyResponse(
    message: WebSocketMessage,
    requestId: string | undefined,
    converted: ViewHierarchyResult,
    observerResponse: boolean,
  ): void {
    if (requestId) {
      const suppressObservationStreamPush =
        this.consumeHierarchyObservationStreamSuppression(requestId);
      if (!suppressObservationStreamPush && !observerResponse) {
        this.pushHierarchyToObservationStream(
          converted,
          message.data as XCTestHierarchy,
          message.frameContext,
        );
      } else {
        logger.debug(
          "[IOSCtrlProxyClient] Suppressed hierarchy observation stream push for explicit initial-frame request",
        );
      }
    }
  }

  private resolveMessageResponse(
    message: WebSocketMessage,
    type: string,
    requestId: string,
  ): boolean {
    const phases = gesturePhaseSummary(message.perfTiming);
    if (phases) {
      const line = `[IOSCtrlProxyClient] type=${type} requestId=${requestId} ${phases}`;
      if (!this.requestManager.isPending(requestId)) {
        logger.warn(`${line} lateResponse=true`);
      } else {
        logger.debug(line);
      }
    }
    const decoded = decodeCtrlProxyMessage(message);
    this.logTapDiagnostics(message, decoded?.result !== undefined);
    return this.resolveDecodedMessage(message, decoded);
  }

  private resolveDecodedMessage(
    message: WebSocketMessage,
    decoded: DecodedCtrlProxyMessage | null,
  ): boolean {
    if (decoded) {
      if (decoded.runnerBusy && decoded.errorMessage !== undefined) {
        this.requestManager.reject(decoded.requestId, new ActionableError(decoded.errorMessage));
        return true;
      }
      if (decoded.errorMessage !== undefined) {
        this.rememberRejectedCommand(message.error);
        this.requestManager.resolveError(
          decoded.requestId,
          decoded.errorMessage,
          decoded.totalTimeMs ?? 0,
          decoded.perfTiming ? { perfTiming: decoded.perfTiming } : undefined,
        );
        return true;
      }
      this.requestManager.resolve(decoded.requestId, decoded.result);
      return true;
    }
    return false;
  }

  private processHierarchyPush(message: WebSocketMessage): void {
    // Push update from server
    const now = this.timer.now();
    const previous = this.cachedHierarchy;
    this.cachedHierarchy = {
      hierarchy: message.data!,
      receivedAt: now,
      captureReceivedAt:
        previous !== null && previous.hierarchy.updatedAt === message.data!.updatedAt
          ? (previous.captureReceivedAt ?? previous.receivedAt)
          : now,
      fresh: true,
      perfTiming: message.perfTiming as CtrlProxyPerfTiming | undefined,
      frameContext: message.frameContext,
    };
    this.resetOlderHierarchyPushRun();
    this.cachedHierarchyDisplayRevision =
      previous?.hierarchy.updatedAt === message.data!.updatedAt
        ? this.cachedHierarchyDisplayRevision
        : displayTransitions.revision(this.device.deviceId);
    logger.info(`[IOSCtrlProxyClient] Received hierarchy push update - UI changed`);

    // Convert and push to observation stream for IDE plugins
    const viewHierarchyResult = this.convertToViewHierarchyResult(message.data!);
    this.pushHierarchyToObservationStream(
      viewHierarchyResult,
      message.data! as XCTestHierarchy,
      message.frameContext,
    );

    // Start screenshot backoff sequence for real-time screenshot streaming
    this.startScreenshotBackoff();

    // Performance monitoring is handled in handleHierarchyUpdateForNavigation
    // which runs for ALL hierarchy_update messages (both push and request-response)

    // Notify listeners (e.g., ObserveScreen to clear its cache)
    this.notifyPushUpdateListeners(message.data!);
    return;
  }

  private isCommandSupported(messageType: string): boolean {
    return (
      !this.rejectedCommands.has(messageType) &&
      (this.supportedCommands === null || this.supportedCommands.has(messageType))
    );
  }

  private rememberRejectedCommand(error?: string): void {
    const rejectedCommand = /^Unknown command type: (.+)$/.exec(error ?? "")?.[1];
    if (rejectedCommand) {
      this.rejectedCommands.add(rejectedCommand);
    }
  }

  private isSdkCapabilityFailure(message: WebSocketMessage): boolean {
    if (message.success !== false && message.ok !== false) {
      return false;
    }
    return (
      message.type === "set_network_mock_rules_result" ||
      message.type === "set_network_fault_rules_result" ||
      message.type === "set_network_error_simulation_result" ||
      message.type === "highlight_response" ||
      message.type === "execute_sql_result" ||
      message.type === "list_databases_result" ||
      message.type === "storage_capabilities_result" ||
      message.type === "list_tables_result" ||
      message.type === "table_data_result" ||
      message.type === "table_structure_result"
    );
  }

  /**
   * Runner-identity accessor for diagnostics (doctor). Connects if needed so the
   * `connected` handshake's `supportedCommands` set is available, then returns it
   * sorted. Returns null when the runner cannot be reached (no handshake), which
   * the caller surfaces as an `unknown` runner status rather than a false pass.
   */
  public async getSupportedCommands(): Promise<string[] | null> {
    if (this.supportedCommands === null) {
      const connected = await this.ensureConnected();
      // ensureConnected resolves on the WebSocket `open` event, but the runner's
      // `supportedCommands` arrive a beat later in the `connected` handshake
      // message. Without waiting for it, the first probe (e.g. doctor) of a
      // healthy runner reads null and misreports it as `unknown`. Poll briefly
      // for the handshake before reading.
      if (connected) {
        await this.waitForHandshake();
      }
    }
    return this.getCachedSupportedCommands();
  }

  private static readonly HANDSHAKE_WAIT_TIMEOUT_MS = 2000;
  private static readonly HANDSHAKE_POLL_INTERVAL_MS = 50;

  private async waitForHandshake(
    timeoutMs: number = IOSCtrlProxyClient.HANDSHAKE_WAIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const deadline = this.timer.now() + timeoutMs;
    while (this.supportedCommands === null && this.timer.now() < deadline) {
      if (!signal) {
        await this.timer.sleep(IOSCtrlProxyClient.HANDSHAKE_POLL_INTERVAL_MS);
        continue;
      }
      let timeout: ReturnType<Timer["setTimeout"]> | undefined;
      try {
        await raceWithDeadline(
          () =>
            new Promise<void>((resolve) => {
              timeout = this.timer.setTimeout(
                resolve,
                IOSCtrlProxyClient.HANDSHAKE_POLL_INTERVAL_MS,
              );
            }),
          { timer: this.timer, signal, label: "iOS diagnostic handshake" },
        );
      } finally {
        if (timeout !== undefined) {
          this.timer.clearTimeout(timeout);
        }
      }
    }
  }

  /**
   * Cheap, connection-free view of the last advertised command set. Used by the
   * booted-devices resource hot path, which must not open a WebSocket just to
   * report status. Returns null when no handshake has been seen.
   */
  public getCachedSupportedCommands(): string[] | null {
    return this.supportedCommands === null ? null : Array.from(this.supportedCommands).sort();
  }

  /** Runner feature flags from the most recent connected handshake. */
  public async getSupportedFeatures(): Promise<string[] | null> {
    await this.getSupportedCommands();
    return this.getCachedSupportedFeatures();
  }

  /** Connection-free feature view for status resources. */
  public getCachedSupportedFeatures(): string[] | null {
    return this.supportedFeatures === null ? null : Array.from(this.supportedFeatures).sort();
  }

  private buildUnsupportedCommandError(messageType: string): string {
    return `iOS CtrlProxy runner does not support ${messageType}. The daemon and runner are out of sync; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.`;
  }

  /**
   * Handle performance update push messages from iOS CtrlProxy.
   * Converts the iOS performance snapshot to PerformanceStreamData and pushes to IDE.
   */
  private handlePerformanceUpdate(snapshot: CtrlProxyPerformanceSnapshot): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    // Convert iOS performance snapshot to PerformanceStreamData format
    const fps = numberOrDefault(snapshot.fps);
    const streamData: PerformanceStreamData = {
      fps,
      frameTimeMs: numberOrDefault(snapshot.frameTimeMs),
      jankFrames: numberOrDefault(snapshot.jankFrames),
      droppedFrames: 0, // iOS doesn't report this separately
      memoryUsageMb: numberOrDefault(snapshot.memoryUsageMb),
      cpuUsagePercent: numberOrDefault(snapshot.cpuUsagePercent),
      touchLatencyMs: nullWhenAbsent(snapshot.touchLatencyMs),
      timeToInteractiveMs: nullWhenAbsent(snapshot.ttiMs),
      screenName: nullWhenAbsent(snapshot.screenName),
      isResponsive: fps >= 50, // Consider responsive if FPS >= 50
      recompositionCount: null,
      recompositionRate: null,
    };

    // NOTE: this CtrlProxy snapshot is intentionally NOT fed into the observe
    // `perfSnapshot` buffer. Its CADisplayLink fps/frame/jank measure the
    // XCUITest *runner* process's own main-thread cadence, and its cpu/memory
    // (task_info on the runner) describe the runner — none of it is the app
    // under test. The app's real CPU/memory reach the buffer via
    // PerformanceMonitor's host-side sampler (ps/simctl by bundle id). Feeding
    // runner-cadence numbers here would present runner health as app perf.
    // A real per-app iOS source is tracked in #5078; it still flows to the IDE
    // stream below (unchanged existing behavior).
    try {
      server.pushPerformanceUpdate(this.device.deviceId, streamData);
      // Log occasionally to avoid spam
      if (this.timer.now() % 5000 < 600) {
        logger.debug(
          `[IOSCtrlProxyClient] iOS FPS: ${streamData.fps.toFixed(1)}, frameTime: ${streamData.frameTimeMs.toFixed(1)}ms, memory: ${streamData.memoryUsageMb.toFixed(1)}MB`,
        );
      }
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to push performance update: ${error}`);
    }
  }

  // ===========================================================================
  // Delegated Public Methods - Hierarchy
  // ===========================================================================

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

  // Thin pass-throughs: like the delegated methods below, these do NOT restate the
  // delegate's default parameter values. Omitted args forward as `undefined`, so
  // CtrlProxyHierarchy (the single source of truth) applies its own defaults —
  // keeping the two-copies drift class from issue #3505 unrepresentable.
  async getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    signal?: AbortSignal,
  ): Promise<CtrlProxyHierarchyResponse> {
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
  ): Promise<{ hierarchy: XCTestHierarchy; perfTiming?: CtrlProxyPerfTiming } | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs);
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{
    hierarchy: XCTestHierarchy;
    perfTiming?: CtrlProxyPerfTiming;
    frameContext?: string;
  } | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs, true);
  }

  async requestHierarchySyncForObserver(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering = false,
    signal?: AbortSignal,
    timeoutMs = 10000,
  ): Promise<{ hierarchy: XCTestHierarchy; frameContext?: string } | null> {
    const deadline = this.timer.now() + timeoutMs;
    await this.waitForPendingRequests(timeoutMs, signal);
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, remaining, true, {
      forceCapture: true,
      observerMode: true,
    });
  }

  convertToViewHierarchyResult(hierarchy: XCTestHierarchy): ViewHierarchyResult {
    this.hierarchy.observeReceivedHierarchy(hierarchy);
    const result = this.hierarchy.convertToViewHierarchyResult(hierarchy);
    const captureSequence = this.streamedCaptureSequences.get(hierarchy);
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

  clearCache(): void {
    this._hierarchy?.resetState();
    this.cachedHierarchy = null;
    this.resetOlderHierarchyPushRun();
  }

  /** Discard hierarchy and screenshot provenance when the physical panel changes. */
  clearDisplayProvenance(): void {
    this.clearCache();
    this.screenGeometry.clear();
  }

  // ===========================================================================
  // Delegated Public Methods - Highlights
  // ===========================================================================

  // Thin pass-throughs below deliberately DO NOT restate the delegate's default
  // parameter values: omitted args forward as `undefined` so the delegate (the
  // single source of truth) applies its own defaults, making the two-copies drift
  // class from issue #3505 unrepresentable.
  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyHighlightResult> {
    const gate = await this.sdkCapabilityGate("highlight");
    if (gate !== null) {
      return gate;
    }
    return this.highlights.requestAddHighlight(id, shape, timeoutMs, perf);
  }

  async setNetworkErrorSimulation(
    config: IosNetworkErrorSimulationConfig,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    const gate = await this.sdkCapabilityGate("network_error_simulation");
    if (gate !== null) {
      return gate;
    }
    return sendCommand<BaseResult>(this.createDelegateContext(), {
      idPrefix: "networkErrorSimulation",
      responseType: "set_network_error_simulation_result",
      messageType: "set_network_error_simulation",
      params: {
        enabled: config.enabled,
        errorType: config.errorType ?? null,
        limit: config.limit ?? null,
        expiresAtEpochMs: config.expiresAtEpochMs ?? null,
      },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      errorLabel: "Network error simulation",
    });
  }

  // ===========================================================================
  // Delegated Public Methods - Gestures
  // ===========================================================================

  async requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<CtrlProxyTapResult> {
    return this.gestures.requestTapCoordinates(
      x,
      y,
      duration,
      timeoutMs,
      perf,
      frameContext,
      signal,
    );
  }

  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    contextOptions?: string | SwipeRequestOptions,
    signal?: AbortSignal,
  ): Promise<CtrlProxySwipeResult> {
    return this.gestures.requestSwipe(
      x1,
      y1,
      x2,
      y2,
      duration,
      timeoutMs,
      perf,
      contextOptions,
      undefined,
      signal,
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
    onDispatch?: () => void,
  ): Promise<CtrlProxyDragResult> {
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
      undefined,
      undefined,
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
  ): Promise<CtrlProxyPinchResult> {
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

  // ===========================================================================
  // Delegated Public Methods - Text
  // ===========================================================================

  async requestSetText(text: string, options?: SetTextOptions): Promise<CtrlProxySetTextResult> {
    return this.text.requestSetText(text, options);
  }

  async requestAppendText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxySetTextResult> {
    return this.text.requestAppendText(text, timeoutMs, perf, frameContext);
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxySetTextResult> {
    return this.text.requestClearText(resourceId, timeoutMs, perf);
  }

  async requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<CtrlProxyImeActionResult> {
    return this.text.requestImeAction(action, timeoutMs, perf, abortSignal, onDispatch);
  }

  async requestSelectAll(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxySelectAllResult> {
    return this.text.requestSelectAll(timeoutMs, perf);
  }

  async requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyKeyboardResult> {
    return this.keyboard.requestKeyboard(action, timeoutMs, perf, signal);
  }

  async requestPressKey(
    key: InputKeyName,
    modifiers: InputKeyModifier[],
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressKeyResult> {
    return this.keyboard.requestPressKey(key, modifiers, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Navigation
  // ===========================================================================

  async requestPressHome(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxyPressHomeResult> {
    this.invalidateSdkCapabilities();
    return this.navigation.requestPressHome(timeoutMs, perf, frameContext);
  }

  async requestPressBack(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxyPressBackResult> {
    return this.navigation.requestPressBack(timeoutMs, perf, frameContext);
  }

  async requestShake(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyShakeResult> {
    return this.navigation.requestShake(timeoutMs, perf, signal);
  }

  async requestPressButton(
    button: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<CtrlProxyPressButtonResult> {
    if (button.toLowerCase() === "home" || button.toLowerCase() === "recent") {
      this.invalidateSdkCapabilities();
    }
    return this.navigation.requestPressButton(button, timeoutMs, perf, frameContext);
  }

  async requestRecentApps(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<CtrlProxyRecentAppsResult> {
    this.invalidateSdkCapabilities();
    return this.navigation.requestRecentApps(timeoutMs, perf, frameContext, signal);
  }

  async requestRotate(
    orientation: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyRotateResult> {
    return this.navigation.requestRotate(orientation, timeoutMs, perf);
  }

  async requestSetHingeAngle(
    angle: number,
    timeoutMs?: number,
  ): Promise<CtrlProxyHingeAngleResult> {
    return this.navigation.requestSetHingeAngle(angle, timeoutMs);
  }

  async requestLaunchApp(
    bundleId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    coldBoot?: boolean,
    signal?: AbortSignal,
  ): Promise<CtrlProxyLaunchAppResult> {
    this.invalidateSdkCapabilities();
    const result = await this.navigation.requestLaunchApp(
      bundleId,
      timeoutMs,
      perf,
      coldBoot,
      signal,
    );
    if (result.success) {
      await this.refreshSdkCapabilitiesAndSync().catch((error) => {
        // A launched app without AutoMobileSDK is normal; the launch itself succeeded.
        logger.debug(`[IOSCtrlProxyClient] SDK capability refresh after launch failed: ${error}`);
      });
    }
    return result;
  }

  // ===========================================================================
  // Delegated Public Methods - App Privacy Permissions
  // ===========================================================================

  async requestResetPermissions(
    bundleId: string,
    permissions: string[],
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyResetPermissionsResult> {
    return this.permissions.requestResetPermissions(bundleId, permissions, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Clipboard
  // ===========================================================================

  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyClipboardResult> {
    return this.clipboard.requestClipboard(action, text, timeoutMs, perf, signal);
  }

  // ===========================================================================
  // Delegated Public Methods - Screenshot
  // ===========================================================================

  async requestScreenshot(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    if ((this.device.displays?.panels.length ?? 0) < 2) {
      return this.screenshot.requestScreenshot(timeoutMs, perf, signal);
    }
    const currentPanel = displayTransitions.currentObservedPanel(this.device.deviceId);
    const hierarchy =
      !currentPanel &&
      this.cachedHierarchy?.fresh &&
      this.cachedHierarchyDisplayRevision === displayTransitions.revision(this.device.deviceId)
        ? this.cachedHierarchy.hierarchy
        : null;
    return captureIosPanelScreenshot(
      this.device,
      hierarchy,
      new SimCtlClient(this.device),
      () => this.screenshot.requestScreenshot(timeoutMs, perf, signal),
      signal,
      currentPanel?.key,
    );
  }

  async requestScreenshotForObserver(
    timeoutMs = 10000,
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    const deadline = this.timer.now() + timeoutMs;
    await this.waitForPendingRequests(timeoutMs, signal);
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    return this.screenshot.requestScreenshot(remaining, undefined, signal, true);
  }

  async requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyScreenshotResult> {
    return this.requestScreenshot(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - VoiceOver
  // ===========================================================================

  async requestVoiceOverState(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyVoiceOverResult> {
    return this.voiceOver.requestVoiceOverState(timeoutMs, perf, signal);
  }

  async requestVoiceOverActivate(
    label: string,
    action: "activate" | "long_press",
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: VoiceOverActivationOptions,
  ): Promise<CtrlProxyActionResult> {
    return this.voiceOver.requestVoiceOverActivate(label, action, timeoutMs, perf, options);
  }

  async requestSetVoiceOverEnabled(
    enabled: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    return this.voiceOver.requestSetVoiceOverEnabled(enabled, timeoutMs, perf);
  }

  async requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: CtrlProxyRequestActionOptions,
  ): Promise<CtrlProxyActionResult> {
    return this.voiceOver.requestAction(action, resourceId, label, timeoutMs, perf, options);
  }

  /**
   * On iOS, occurrence is the zero-based index among case-insensitive text matches
   * within the owning text element. Without ownerResourceId, use the first owner
   * carrying a matching link in document order (previously counted tree-wide).
   * Multiple candidate owners produce a runner warning; scope with container/subtext
   * for a specific owner. The XCUITest fallback refuses owner-less occurrence > 0.
   * Android remains unchanged: count matching links in document order within the
   * owner's subtree, or the whole active-window tree when owner-less.
   */
  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    ownerResourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    return this.voiceOver.requestActivateAccessibilityLink(
      text,
      occurrence,
      ownerResourceId,
      timeoutMs,
      perf,
    );
  }

  async requestMultiFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    fingerCount: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    fingerSpacing?: number,
  ): Promise<CtrlProxySwipeResult> {
    return this.gestures.requestMultiFingerSwipe(
      x1,
      y1,
      x2,
      y2,
      fingerCount,
      duration,
      timeoutMs,
      perf,
      fingerSpacing,
    );
  }

  // ===========================================================================
  // Delegated Public Methods - Storage (UserDefaults)
  // ===========================================================================

  async listPreferenceFiles(
    packageName: string,
    timeoutMs?: number,
  ): Promise<import("../../storage/storageTypes").PreferenceFile[]> {
    return this.storage.listPreferenceFiles(packageName, timeoutMs);
  }

  async getPreferenceEntries(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<import("../../storage/storageTypes").KeyValueEntry[]> {
    return this.storage.getPreferenceEntries(packageName, fileName, timeoutMs);
  }

  /** Existing-socket UserDefaults access: never reconnect or provision a runner. */
  public getConnectedPreferenceClient(): Pick<
    IOSCtrlProxyClient,
    "getPreference" | "setPreference" | "isConnected"
  > {
    const storage = new CtrlProxyStorage(
      {
        ...this.createDelegateContext(),
        // The storage delegate's connection probe must only inspect the socket.
        ensureConnected: async () => this.isConnected(),
        getWebSocket: () => (this.isConnected() ? this.ws : null),
      },
      () => this.boundSessionId,
      (appId) => iosMutationTokens.get(this.device.deviceId, appId),
    );
    return {
      isConnected: () => this.isConnected(),
      getPreference: (...args) => storage.getPreference(...args),
      setPreference: (...args) => storage.setPreference(...args),
    };
  }

  async getPreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs?: number,
  ): Promise<import("../../storage/storageTypes").KeyValueEntry | null> {
    return this.storage.getPreference(packageName, fileName, key, timeoutMs);
  }

  async setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string | null,
    type: import("../../storage/storageTypes").KeyValueType,
    timeoutMs?: number,
  ): Promise<import("../../storage/storageTypes").PreferenceStoreResolution | undefined> {
    return this.storage.setPreference(packageName, fileName, key, value, type, timeoutMs);
  }

  async removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs?: number,
  ): Promise<import("../../storage/storageTypes").PreferenceStoreResolution | undefined> {
    return this.storage.removePreference(packageName, fileName, key, timeoutMs);
  }

  async clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<import("../../storage/storageTypes").PreferenceStoreResolution | undefined> {
    return this.storage.clearPreferenceStore(packageName, fileName, timeoutMs);
  }

  // ===========================================================================
  // Delegated Public Methods - Database (SQLite)
  // ===========================================================================

  async executeSQLForIos(
    appId: string,
    databasePath: string,
    query: string,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").SQLResult> {
    await this.requireSdkCapability("database", appId);
    return this.database.executeSQL(
      appId,
      databasePath,
      query,
      timeoutMs,
      this.boundSessionId ?? undefined,
      iosMutationTokens.get(this.device.deviceId, appId),
    );
  }

  async listDatabasesForIos(
    appId: string,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").DatabaseInfo[]> {
    await this.requireSdkCapability("database", appId);
    return this.database.listDatabases(appId, timeoutMs);
  }

  async getStorageCapabilitiesForIos(
    appId: string,
    timeoutMs?: number,
  ): Promise<import("./CtrlProxyDatabase").StorageCapabilities> {
    await this.requireSdkCapability("database", appId);
    return this.database.storageCapabilities(appId, timeoutMs);
  }

  async listTablesForIos(
    appId: string,
    databasePath: string,
    timeoutMs?: number,
  ): Promise<string[]> {
    await this.requireSdkCapability("database", appId);
    return this.database.listTables(appId, databasePath, timeoutMs);
  }

  async getTableDataForIos(
    appId: string,
    databasePath: string,
    table: string,
    limit?: number,
    offset?: number,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").TableDataResult> {
    await this.requireSdkCapability("database", appId);
    return this.database.getTableData(appId, databasePath, table, limit, offset, timeoutMs);
  }

  async getTableStructureForIos(
    appId: string,
    databasePath: string,
    table: string,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").TableStructureResult> {
    await this.requireSdkCapability("database", appId);
    return this.database.getTableStructure(appId, databasePath, table, timeoutMs);
  }

  // ===========================================================================
  // Service Verification
  // ===========================================================================

  public async verifyServiceReady(
    maxAttempts: number = 3,
    delayMs: number = 1000,
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    // Sits on the shared RetryExecutor (issue #5460), matching how
    // DeviceServiceClient.waitForConnection and AndroidCtrlProxyClient.verifyServiceReady
    // already retry service-readiness. The two-phase probe is preserved: a failed
    // connection throws to consume an attempt without a hierarchy request, and a
    // connected-but-empty/failed hierarchy throws to retry. Any throw becomes a
    // retryable attempt with a fixed `delayMs` wait between attempts — so the loop
    // waits maxAttempts - 1 times, not once per attempt as the previous hand-rolled
    // loop did (it slept even after the final failed attempt; that trailing wait was
    // pure wasted latency on the error path).
    const result = await this.retryExecutor.execute(
      async () => {
        if (!(await this.ensureConnected())) {
          throw new Error("CtrlProxy WebSocket not connected");
        }

        const hierarchyResult = await this.requestHierarchySync(
          undefined,
          false,
          undefined,
          timeoutMs,
        );
        if (hierarchyResult?.hierarchy) {
          return true;
        }

        throw new Error("CtrlProxy returned no hierarchy");
      },
      {
        maxAttempts,
        delays: delayMs,
      },
    );

    return result.value ?? false;
  }

  // ===========================================================================
  // Push Update Callbacks
  // ===========================================================================

  public onPushUpdate(callback: (hierarchy: XCTestHierarchy) => void): () => void {
    this.onPushUpdateCallbacks.add(callback);
    return () => {
      this.onPushUpdateCallbacks.delete(callback);
    };
  }

  private notifyPushUpdateListeners(hierarchy: XCTestHierarchy): void {
    for (const callback of this.onPushUpdateCallbacks) {
      try {
        callback(hierarchy);
      } catch (error) {
        logger.warn(`[IOSCtrlProxyClient] Push update callback error: ${error}`);
      }
    }
  }

  private suppressHierarchyObservationStreamPush(requestId: string, timeoutMs: number): void {
    const existingTimeout = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (existingTimeout) {
      this.timer.clearTimeout(existingTimeout);
    }

    const timeoutHandle = this.timer.setTimeout(() => {
      this.hierarchyObservationStreamSuppressions.delete(requestId);
    }, timeoutMs);
    this.hierarchyObservationStreamSuppressions.set(requestId, timeoutHandle);
  }

  private consumeHierarchyObservationStreamSuppression(requestId: string): boolean {
    const timeoutHandle = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (!timeoutHandle) {
      return false;
    }

    this.hierarchyObservationStreamSuppressions.delete(requestId);
    this.timer.clearTimeout(timeoutHandle);
    return true;
  }

  /**
   * Push hierarchy update to the device data stream for IDE plugins.
   */
  private pushHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    source: XCTestHierarchy | undefined,
    frameContext?: string,
  ): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    try {
      // Derive geometry from the hierarchy BEING FORWARDED, before the push, so the identity
      // recorded below belongs to the geometry it actually describes.
      //
      // Reading this.cachedHierarchy here would be wrong on the request/response path: processMessage
      // forwards the converted response before CtrlProxyHierarchy.requestHierarchySync resumes and
      // installs it in the cache, so the cache still holds the PREVIOUS hierarchy (or nothing at
      // all on the first response). A resolution-changing response would then associate its capture
      // id with the old dimensions and screenshots could not pair until another hierarchy arrived.
      this.updateScreenGeometryFrom(source);
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
        if (source) {
          source.captureSequence = captureSequence;
          this.streamedCaptureSequences.set(source, captureSequence);
        }
        this.screenGeometry.markForwarded(captureSequence);
      }
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to push hierarchy to observation stream: ${error}`);
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
    this.updateScreenGeometryFrom(hierarchy);
    if (captureSequence !== null) {
      this.screenGeometry.markForwarded(captureSequence);
    }
    this.startScreenshotBackoff();
  }

  /**
   * Push screenshot update to the device data stream for IDE plugins.
   */
  private pushScreenshotToObservationStream(
    screenshotBase64: string,
    screenWidth: number,
    screenHeight: number,
    metadata: ScreenshotMetadata = IOS_CTRLPROXY_SCREENSHOT_METADATA,
    captureSequence?: number,
    coordinateSpace?: CoordinateSpace,
    nativeScale?: number,
    frameContext?: string,
    rotation?: number,
  ): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    try {
      // Identity, coordinate space, and native scale travel with the frame from request initiation,
      // never from the latest metadata at delivery time. A hierarchy that flips scale metadata
      // while pixels are in flight must not relabel their geometry or their swipe threshold.
      server.pushScreenshotUpdate(
        this.device.deviceId,
        screenshotBase64,
        screenWidth,
        screenHeight,
        metadata,
        {
          captureSequence,
          ...(coordinateSpace ? { coordinateSpace } : {}),
          ...(nativeScale === undefined ? {} : { nativeScale }),
          frameContext,
          rotation,
        },
      );
    } catch (error) {
      logger.debug(
        `[IOSCtrlProxyClient] Failed to push screenshot to observation stream: ${error}`,
      );
    }
  }

  // ===========================================================================
  // Screenshot Backoff for Real-time Streaming
  // ===========================================================================

  /**
   * Start screenshot backoff sequence for real-time screenshot streaming to IDE.
   * Called when a hierarchy push update is received to capture corresponding screenshots.
   */
  private startScreenshotBackoff(): void {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.device.deviceId)) {
      return;
    }

    const scheduler = this.getScreenshotBackoffScheduler();
    scheduler.startBackoffSequence();
  }

  private getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler {
    if (!this.screenshotBackoffScheduler) {
      this.screenshotBackoffScheduler = new DefaultScreenshotBackoffScheduler(
        async (): Promise<ScreenshotCaptureResult> => {
          return this.captureScreenshotForBackoff();
        },
        (result: ScreenshotCaptureResult) => {
          if (!result.data) {
            return;
          }
          // Get screen dimensions from cached hierarchy or use defaults. A fallback has no capture
          // provenance at all, so it must never be asserted as tracked.
          // Declare the geometry the request was BOUND to, not whatever the cache holds now.
          // Without a binding, fall back to a nominal size and send no identity, so a control
          // client fails closed.
          const binding = result.captureBinding;
          const screenWidth = binding?.width ?? this.screenGeometry.width ?? 1170;
          const screenHeight = binding?.height ?? this.screenGeometry.height ?? 2532;
          this.pushScreenshotToObservationStream(
            result.data,
            screenWidth,
            screenHeight,
            result,
            binding?.captureSequence,
            binding?.coordinateSpace,
            binding?.nativeScale,
            result.frameContext,
            result.rotation,
          );
        },
        {
          getKeepAliveIntervalMs: () => {
            const server = getDeviceDataStreamServer();
            return server?.getScreenshotIntervalMsForDevice(this.device.deviceId) ?? 3000;
          },
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

    // Bind the capture identity current at INITIATION and carry it through the await, so a
    // hierarchy forwarded while this frame is in flight cannot relabel it. Same-resolution
    // navigation makes this the only defence — the pixels are identical in size either way.
    const captureBinding = this.screenGeometry.bind() ?? undefined;

    try {
      const result = await this.requestScreenshot(5000);
      if (!result.success || !result.data) {
        return { success: false, error: result.error || "No screenshot data" };
      }

      return {
        success: true,
        data: result.data,
        captureBinding,
        frameContext: result.frameContext,
        rotation: result.rotation,
        ...metadataForScreenshotFormat(IOS_CTRLPROXY_SCREENSHOT_METADATA, result.format),
      };
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Screenshot backoff capture failed: ${errorMessage(error)}`,
        error,
      );
      return { success: false, error: `${error}` };
    }
  }

  /**
   * Record the screen geometry described by [source] — the hierarchy about to be forwarded, never
   * whatever happens to be cached (issue #3348).
   */
  private updateScreenGeometryFrom(
    source:
      | {
          screenWidth?: number;
          screenHeight?: number;
          screenScale?: number;
          nativeScale?: number;
          pixelWidth?: number;
          pixelHeight?: number;
        }
      | null
      | undefined,
  ): void {
    const hierarchy = source;
    if (!hierarchy?.screenWidth || !hierarchy.screenHeight) {
      // No usable geometry in this hierarchy. Clearing (rather than keeping the previous entry)
      // stops a later push from vouching for dimensions this hierarchy cannot confirm.
      this.screenGeometry.clear();
      return;
    }
    // Canonical pixels (#4549): the capture-identity claim must equal the screenshot's real pixels,
    // which XCUIScreenshot renders at NATIVE scale. When the runner supplied complete scale
    // metadata, use its reported pixelWidth/pixelHeight (derived at nativeScale in #4548) directly —
    // NOT points * screenScale, which diverges from the PNG under Display Zoom. A pre-#4548 runner
    // has no metadata, so fall back to the legacy points * screenScale claim, byte-identical.
    const metadata = readScreenScaleMetadata(hierarchy);
    const [pixelWidth, pixelHeight] = metadata
      ? [metadata.pixelWidth, metadata.pixelHeight]
      : [
          Math.round(hierarchy.screenWidth * (hierarchy.screenScale ?? 1)),
          Math.round(hierarchy.screenHeight * (hierarchy.screenScale ?? 1)),
        ];
    // A change clears the forwarded flag: the geometry becomes capture-tracked only once a
    // hierarchy carrying it is forwarded (see pushHierarchyToObservationStream) — which will NOT
    // happen while hierarchy pushes are suppressed, or when there is no stream server. The
    // Coordinate space and native scale are bound here from THIS hierarchy, so a later metadata
    // flip cannot restamp a frame whose request was bound now.
    this.screenGeometry.update(
      pixelWidth,
      pixelHeight,
      metadata ? COORDINATE_SPACE_PX : undefined,
      metadata?.nativeScale,
    );
  }

  /**
   * Retain the additive #4548 scale metadata from a received hierarchy. Called on RECEIPT (the
   * first `hierarchy_update` branch) so retention is independent of the observation-stream push,
   * which is skipped with no device-data server and suppressed for initial-frame requests. Follows
   * the same freshness rule as the tracked geometry: it always describes THIS hierarchy, so a
   * hierarchy without complete fields (pre-#4548 runner) resets it to null rather than leaving
   * stale values behind. `readScreenScaleMetadata` is the single all-or-nothing validator.
   */
  private retainScaleMetadataFrom(
    hierarchy:
      | { nativeScale?: number; pixelWidth?: number; pixelHeight?: number }
      | null
      | undefined,
  ): void {
    this.reportedScaleMetadata = readScreenScaleMetadata(hierarchy);
  }

  /**
   * Runner-reported scale metadata from the most recently received hierarchy (#4548), or null
   * when the runner has not reported it (pre-#4548 runner, or no hierarchy yet). Exposed for
   * #4549's canonical-pixel conversion; nothing in current behavior consumes it.
   */
  getScreenScaleMetadata(): ScreenScaleMetadata | null {
    return this.reportedScaleMetadata;
  }

  /**
   * Cancel any pending screenshot captures.
   */
  cancelScreenshotBackoff(): void {
    if (this.screenshotBackoffScheduler) {
      this.screenshotBackoffScheduler.cancelPendingCaptures();
    }
  }

  refreshObservationStreamScreenshotCadence(): void {
    this.screenshotBackoffScheduler?.rescheduleKeepAlive();
  }

  refreshObservationStreamHierarchyCadence(intervalMs: number): void {
    if (!this.isCommandSupported("set_hierarchy_poll_interval")) {
      logger.info(
        "[IOSCtrlProxyClient] Skipping hierarchy cadence sync; runner does not advertise set_hierarchy_poll_interval",
      );
      return;
    }

    this.sendMessage(
      serializeIosRequest({
        type: "set_hierarchy_poll_interval",
        intervalMs,
      }),
    );
  }

  // ===========================================================================
  // Navigation Detector
  // ===========================================================================

  public getHierarchyNavigationDetector(): HierarchyNavigationDetector {
    if (!this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector = new HierarchyNavigationDetector(
        this.getNavigationGraphManager(),
        { timer: this.timer },
      );
    }
    return this.hierarchyNavigationDetector;
  }

  public resetHierarchyNavigationDetector(): void {
    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.reset();
    }
  }

  private handleHierarchyUpdateForNavigation(
    hierarchy: XCTestHierarchy,
    perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[],
  ): void {
    if (!hierarchy.hierarchy) {
      logger.warn(
        "[IOSCtrlProxyClient] Skipping navigation detection: hierarchy missing in update",
      );
      return;
    }

    if (hierarchy.error) {
      logger.warn(
        `[IOSCtrlProxyClient] Skipping navigation detection due to hierarchy error: ${hierarchy.error}`,
      );
      return;
    }

    // Track foreground bundle and start performance monitoring when app changes
    const bundleId = hierarchy.packageName;
    if (bundleId) {
      this.ensureBuildContext(bundleId);
    }
    logger.debug(
      `[IOSCtrlProxyClient] Hierarchy update - bundleId: "${bundleId}", lastForeground: "${this.lastForegroundBundleId}"`,
    );
    if (bundleId && bundleId !== this.lastForegroundBundleId) {
      this.lastForegroundBundleId = bundleId;
      this.invalidateSdkCapabilities();
      void this.refreshSdkCapabilitiesAndSync().catch((error) => {
        // Foreground apps without AutoMobileSDK are normal.
        logger.debug(
          `[IOSCtrlProxyClient] SDK capability refresh after app change failed: ${error}`,
        );
      });
      // Start performance monitoring for this device/bundle
      const monitor = getPerformanceMonitor();
      monitor.startMonitoring(this.device.deviceId, bundleId, "ios");
      logger.info(
        `[IOSCtrlProxyClient] Started performance monitoring for ${bundleId} on ${this.device.deviceId}`,
      );
    }

    const conversionStart = this.timer.now();
    const convertedHierarchy = this.convertHierarchyForNavigation(hierarchy);
    const conversionMs = this.timer.now() - conversionStart;

    const metrics: HierarchyNavigationUpdateMetrics = {
      source: "ios",
      conversionMs,
      externalTiming: perfTiming,
    };

    this.getHierarchyNavigationDetector().onHierarchyUpdate(convertedHierarchy, metrics);
  }

  private convertHierarchyForNavigation(hierarchy: XCTestHierarchy): AccessibilityHierarchy {
    return {
      updatedAt: hierarchy.updatedAt,
      packageName: hierarchy.packageName,
      hierarchy: this.convertNodeForNavigation(
        hierarchy.hierarchy,
      ) as AccessibilityHierarchy["hierarchy"],
    };
  }

  private convertNodeForNavigation(
    node: CtrlProxyNode | CtrlProxyNode[],
  ): Record<string, unknown> | Record<string, unknown>[] {
    if (Array.isArray(node)) {
      return node.flatMap((child) => {
        const converted = this.convertNodeForNavigation(child);
        return Array.isArray(converted) ? converted : [converted];
      });
    }

    const converted: Record<string, unknown> = {};

    const contentDesc = this.readNodeField<string>(node, "contentDesc", "content-desc");
    const resourceId = this.readNodeField<string>(node, "resourceId", "resource-id");
    const testTag = this.readNodeField<string>(node, "testTag", "test-tag");
    const viewId = this.readNodeField<string>(node, "viewId", "view-id");

    if (node.text) {
      converted.text = node.text;
    }
    if (contentDesc) {
      converted["content-desc"] = contentDesc;
    }
    if (resourceId) {
      converted["resource-id"] = resourceId;
    }
    if (testTag) {
      converted["test-tag"] = testTag;
    }
    if (viewId) {
      converted["view-id"] = viewId;
    }
    if (node.className) {
      converted.className = node.className;
    }
    if (node.scrollable) {
      converted.scrollable = node.scrollable;
    }
    if (node.selected) {
      converted.selected = node.selected;
    }

    if (node.node) {
      converted.node = this.convertNodeForNavigation(node.node);
    }

    return converted;
  }

  private readNodeField<T>(
    node: CtrlProxyNode,
    camelKey: keyof CtrlProxyNode,
    dashedKey?: string,
  ): T | undefined {
    const record = node as Record<string, unknown>;
    if (record[camelKey as string] !== undefined) {
      return record[camelKey as string] as T;
    }
    if (dashedKey && record[dashedKey] !== undefined) {
      return record[dashedKey] as T;
    }
    return undefined;
  }
}
