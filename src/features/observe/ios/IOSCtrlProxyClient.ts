import { IosCtrlProxyDelegatingFacade } from "./IosCtrlProxyDelegatingFacade";
import { CtrlProxyConnection } from "./CtrlProxyConnection";
import { CtrlProxyRunnerRecovery } from "./CtrlProxyRunnerRecovery";
import { CtrlProxyHierarchyTelemetry } from "./CtrlProxyHierarchyTelemetry";
import {
  CtrlProxyObservationStream,
  type ScreenshotObservationStreamOptions,
} from "./CtrlProxyObservationStream";
import { CtrlProxyInboundMessages } from "./CtrlProxyInboundMessages";
import {
  CtrlProxyNetworkSync,
  type IosMockRuleSyncResult,
  type IosNetworkErrorSimulationConfig,
} from "./CtrlProxyNetworkSync";
export type {
  IosMockRuleSyncOutcome,
  IosMockRuleSyncResult,
  IosNetworkErrorSimulationConfig,
} from "./CtrlProxyNetworkSync";
import { CtrlProxySdkEvents, type SdkEventPollResult } from "./CtrlProxySdkEvents";
import { CtrlProxySdkCapabilities } from "./CtrlProxySdkCapabilities";
import { CtrlProxySdkScreenIdentity } from "./CtrlProxySdkScreenIdentity";
import { CtrlProxyBuildContext } from "./CtrlProxyBuildContext";
import type { PinchRequest, TapCoordinatesRequest } from "../shared/SharedGestureDelegate";
import type { IosActivateAccessibilityLinkRequest } from "./CtrlProxyVoiceOver";
import { MapDeviceClientRegistry } from "../../../ctrlProxy/deviceClientRegistry";
import { type IOSDispatchResult } from "./CtrlProxyDispatch";
import { withCtrlProxyRecordingFromEnv } from "./CtrlProxyExchangeRecorder";
import type { CtrlProxyMagicTapResult, CtrlProxySdkTriggerResult } from "./types";
import { type SdkTriggerRequest } from "./CtrlProxySdkTrigger";
import type { IosHierarchyMessageEffects } from "./IosHierarchyMessageEffects";
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

import WebSocket from "ws";

import type { IosHierarchyUnavailableReason } from "../../../models/ViewHierarchyResult";
import { logger } from "../../../utils/logger";
import type { TimedOutRequest } from "../../../utils/RequestManager";

import { errorMessage } from "../../../utils/describeUnknownError";

import {
  BootedDevice,
  HighlightShape,
  ScreenIdentity,
  ImeAction,
  ViewHierarchyResult,
} from "../../../models";

import type { MultiFingerSwipeRequest } from "../../../utils/interfaces/MultiFingerSwipeRequest";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { RetryExecutor, defaultRetryExecutor } from "../../../utils/retry/RetryExecutor";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { requireBootedDevice } from "../../../devices/requireBootedDevice";
import { IOSCtrlProxyManager, CtrlProxyIosManager } from "../../../ctrlProxy/IOSCtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../../utils/factories/PlatformDeviceManagerFactory";
import { NavigationGraphManager } from "../../navigation/NavigationGraphManager";
import type { IosAppMetadataSource } from "../../../models/IosAppMetadataSource";
import type { ContentHashProvider } from "../../../utils/ContentHashProvider";
import { HierarchyNavigationDetector } from "../../navigation/HierarchyNavigationDetector";

import { WebSocketFactory, defaultWebSocketFactory } from "../DeviceServiceClient";

import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import type { BaseResult } from "../shared/types";
import type { DragRequest, GestureTimingResult, SwipeRequest } from "../shared/types";
import type { SetTextOptions } from "../DeviceService";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";

import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";

import { ScreenshotCaptureResult } from "../ScreenshotBackoffScheduler";

import { resolveAssetVersion, resolvePinnedVersion } from "../../../constants/release";
import { compareStrictNumericVersions } from "../../../utils/deviceMatcher";
import { serializeIosRequest } from "./serializeIosRequest";

/**
 * Factory function type for creating CtrlProxyIosManager instances.
 * Used for testing to inject fake service managers.
 */
export type ServiceManagerFactory = (device: BootedDevice) => CtrlProxyIosManager;

/** Default production factory that delegates to the real singleton. */
type NavGraph = ReturnType<typeof NavigationGraphManager.getInstance>;

const defaultServiceManagerFactory: ServiceManagerFactory = (d) =>
  IOSCtrlProxyManager.getInstance(d);

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
  /** Replaces the side effects `processMessage` runs for hierarchy messages; tests observe their order. */
  messageEffects?: IosHierarchyMessageEffects;
}

/** Optional test dependencies; observer options retain the legacy boolean shorthand. */
export interface IosCtrlProxyClientTestOptions {
  serviceManagerFactory?: ServiceManagerFactory;
  bootedDeviceLister?: BootedDeviceLister;
  deviceConnectionLostNotifier?: DeviceConnectionLostNotifier;
  sdkEventIngestor?: IosSdkEventIngestor;
  retryExecutor?: RetryExecutor;
  options?: boolean | IosCtrlProxyClientOptions;
}

// Test-created clients must never fall through to simctl/devicectl for provenance.
const noOpIosMetadataSource: IosAppMetadataSource = {
  listApps: async () => [],
  getPhysicalDeviceAppInfo: async () => null,
};

/** Default production lister that queries the real device manager. */
const defaultBootedDeviceLister: BootedDeviceLister = () =>
  PlatformDeviceManagerFactory.getInstance().getBootedDevices("ios");

const noOpServiceManagerFactory: ServiceManagerFactory = () => new NoOpIOSCtrlProxyManager();

// Import delegates

import {
  type VoiceOverActivationOptions,
  type CtrlProxyRequestActionOptions,
} from "./CtrlProxyVoiceOver";

import type { InputKeyModifier, InputKeyName } from "../../action/InputKey";

import { DefaultIosSdkEventIngestor, type IosSdkEventIngestor } from "./IosSdkEventIngestor";

// Import types
// Import types
import type {
  XCTestHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxySyncedHierarchy,
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
  CtrlProxyVoiceOverResult,
  CtrlProxyActionResult,
  CtrlProxyClipboardResult,
  CtrlProxyHighlightResult,
  WebSocketMessage,
} from "./types";
import { CtrlProxyServicePortChangedError } from "./CtrlProxyServicePortChangedError";
import { NoOpIOSCtrlProxyManager } from "./NoOpIOSCtrlProxyManager";

/**
 * Interface for CtrlProxy providing iOS UI hierarchy and interaction capabilities
 * via WebSocket connection to iOS CtrlProxy
 */
export interface IosCtrlProxy extends Omit<CtrlProxyClient, "requestPinch"> {
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
  ): Promise<CtrlProxySyncedHierarchy | null>;
  /** Force a real extraction only for cached tap resolution. */
  requestHierarchySyncForTapRevalidation(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): ReturnType<IosCtrlProxy["requestHierarchySync"]>;
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
  ): Promise<CtrlProxySyncedHierarchy | null>;

  convertToViewHierarchyResult(hierarchy: XCTestHierarchy): ViewHierarchyResult;

  requestSwipe(request: SwipeRequest): Promise<IOSDispatchResult<CtrlProxySwipeResult>>;

  requestDoubleTapCoordinates(
    x: number,
    y: number,
    timeoutMs?: number,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>>;

  requestTapCoordinates(
    request: TapCoordinatesRequest,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>>;

  requestDrag(request: DragRequest): Promise<CtrlProxyDragResult>;

  requestPathGesture(
    points: ReadonlyArray<{ x: number; y: number; offsetMs: number }>,
    timeoutMs?: number,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<GestureTimingResult>>;

  requestPinch(
    request: PinchRequest,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPinchResult>>;

  requestSetText(text: string, options?: SetTextOptions): Promise<CtrlProxySetTextResult>;

  requestAppendText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    options?: Pick<SetTextOptions, "abortSignal" | "deadlineMs" | "onDispatch">,
  ): Promise<CtrlProxySetTextResult>;

  requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: Pick<SetTextOptions, "abortSignal" | "deadlineMs" | "onDispatch">,
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
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressKeyResult>>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<CtrlProxyClipboardResult & { acknowledged?: boolean }>;

  requestPressHome(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressHomeResult>>;

  requestPressBack(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressBackResult>>;

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
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressButtonResult>>;

  requestRecentApps(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyRecentAppsResult>>;

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

  requestMagicTap(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyMagicTapResult>;

  requestSdkTrigger(request: SdkTriggerRequest): Promise<CtrlProxySdkTriggerResult>;

  requestActivateAccessibilityLink(
    request: IosActivateAccessibilityLinkRequest,
  ): Promise<CtrlProxyActionResult>;

  requestMultiFingerSwipe(
    request: MultiFingerSwipeRequest,
  ): Promise<IOSDispatchResult<CtrlProxySwipeResult>>;

  clearCache(): void;

  onPushUpdate(callback: (hierarchy: XCTestHierarchy) => void): () => void;
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
export const IOS_RUNNER_FEATURE_FLAGS = ["display_cutout_info", "double_tap_v1"] as const;

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
export class IOSCtrlProxyClient extends IosCtrlProxyDelegatingFacade implements IosCtrlProxy {
  protected get cacheFreshTtlMs(): number {
    return IOSCtrlProxyClient.CACHE_FRESH_TTL_MS;
  }

  protected createDiagnosticsProbe(): IOSCtrlProxyClient {
    return IOSCtrlProxyClient.createForObservationRead(this.device, this);
  }

  public getObservationStreamTestHooks(): Pick<
    CtrlProxyObservationStream,
    "suppressedRequestIds" | "suppressHierarchyObservationStreamPush"
  > {
    return this.observationStream;
  }
  private _connection: CtrlProxyConnection | null = null;
  private get connection(): CtrlProxyConnection {
    const client = this;
    return (this._connection ??= new CtrlProxyConnection({
      deviceId: this.device.deviceId,
      retryExecutor: this.retryExecutor,
      get closed() {
        return client.closed;
      },
      get port() {
        return client.port;
      },
      get pendingConnectJoiners() {
        return client.pendingConnectJoiners;
      },
      get lastConnectFailure() {
        return client.lastConnectFailure;
      },
      set lastConnectFailure(value) {
        client.lastConnectFailure = value;
      },
      getManager: () => this.serviceManagerFactory(this.device),
      hasOpenSocket: () => !!this.ws,
      isRecovering: () => !!this.getReconnectStatus(),
      connectTransport: (perf) => super.ensureConnected(perf),
      syncPortFromManager: (manager) => this.syncPortFromManager(manager),
      resetConnectionBudget: () => this.resetConnectionBudget(),
      bootedDeviceLister: () => this.bootedDeviceLister(),
      acquirePendingConnectInterest: () => this.acquirePendingConnectInterest(),
      abortPendingConnect: () => this.abortPendingConnect(),
      connectWebSocket: (perf, interest) => this.connectWebSocket(perf, interest),
      ensureConnected: () => this.ensureConnected(),
      requestHierarchySync: (perf, filter, signal, timeoutMs) =>
        this.requestHierarchySync(perf, filter, signal, timeoutMs),
    }));
  }
  public async verifyServiceReady(
    maxAttempts: number = 3,
    delayMs: number = 1000,
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    return this.connection.verifyServiceReady(maxAttempts, delayMs, timeoutMs);
  }
  public override async ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    return this.connection.ensureConnected(perf);
  }
  public async connectWithoutSetup(signal?: AbortSignal): Promise<boolean> {
    return this.connection.connectWithoutSetup(signal);
  }
  private _runnerRecovery: CtrlProxyRunnerRecovery | null = null;
  private get runnerRecovery(): CtrlProxyRunnerRecovery {
    const client = this;
    return (this._runnerRecovery ??= new CtrlProxyRunnerRecovery({
      timer: this.timer,
      deviceId: this.device.deviceId,
      transientObserver: this.transientObserver,
      observerHierarchyRequestIds: this.observerHierarchyRequestIds,
      get ws() {
        return client.ws;
      },
      get port() {
        return client.port;
      },
      get closed() {
        return client.closed;
      },
      get consecutiveConnectionFailures() {
        return client.consecutiveConnectionFailures;
      },
      set consecutiveConnectionFailures(value) {
        client.consecutiveConnectionFailures = value;
      },
      get recoveryPromise() {
        return client.recoveryPromise;
      },
      set recoveryPromise(value) {
        client.recoveryPromise = value;
      },
      getManager: () => this.serviceManagerFactory(this.device),
      isConnected: () => this.isConnected(),
      syncPortFromManager: (manager) => this.syncPortFromManager(manager),
      resetConnectionBudget: () => this.resetConnectionBudget(),
      connectBackgroundWebSocket: () => this.connectBackgroundWebSocket(),
      bootedDeviceLister: () => this.bootedDeviceLister(),
      startScreenshotBackoff: () => this.startScreenshotBackoff(),
      startSdkEventPolling: () => this.sdkEvents.startSdkEventPolling(),
      awaitRecovery: (budgetMs, signal) => super.awaitRecovery(budgetMs, signal),
    }));
  }
  protected onConnectionEstablished(): void {
    this.runnerRecovery.onConnectionEstablished();
  }
  protected override silentTimeoutConfirmationMs(request: TimedOutRequest): number | undefined {
    return this.runnerRecovery.silentTimeoutConfirmationMs(request);
  }
  public override awaitRecovery(
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<"recovered" | "not_recovering" | "failed" | "timed_out"> {
    return this.runnerRecovery.awaitRecovery(budgetMs, signal);
  }
  public getRunnerRecoveryTestHooks(): Pick<
    CtrlProxyRunnerRecovery,
    "failPendingRestart" | "restartServiceIfBooted" | "diagnostics" | "resetInFlightForTesting"
  > {
    return this.runnerRecovery;
  }
  private _hierarchyTelemetry: CtrlProxyHierarchyTelemetry | null = null;
  private get hierarchyTelemetry(): CtrlProxyHierarchyTelemetry {
    const client = this;
    return (this._hierarchyTelemetry ??= new CtrlProxyHierarchyTelemetry({
      timer: this.timer,
      deviceId: this.device.deviceId,
      sdkCapability: this.sdkCapability,
      buildContext: this.buildContext,
      get lastForegroundBundleId() {
        return client.lastForegroundBundleId;
      },
      set lastForegroundBundleId(value) {
        client.lastForegroundBundleId = value;
      },
      getHierarchyNavigationDetector: () => this.getHierarchyNavigationDetector(),
    }));
  }
  private handlePerformanceUpdate(snapshot: CtrlProxyPerformanceSnapshot): void {
    this.hierarchyTelemetry.handlePerformanceUpdate(snapshot);
  }
  private handleHierarchyUpdateForNavigation(
    hierarchy: XCTestHierarchy,
    perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[],
  ): void {
    this.hierarchyTelemetry.handleHierarchyUpdateForNavigation(hierarchy, perfTiming);
  }
  private _observationStream: CtrlProxyObservationStream | null = null;
  private get observationStream(): CtrlProxyObservationStream {
    return (this._observationStream ??= new CtrlProxyObservationStream({
      timer: this.timer,
      deviceId: this.device.deviceId,
      screenGeometry: this.screenGeometry,
      streamedCaptureSequences: this.streamedCaptureSequences,
      requestScreenshot: (timeoutMs) => this.requestScreenshot(timeoutMs),
      startScreenshotBackoff: () => this.startScreenshotBackoff(),
      captureScreenshotForBackoff: () => this.captureScreenshotForBackoff(),
      createScreenshotBackoffScheduler: (capture, emit) =>
        this.createScreenshotBackoffScheduler(capture, emit, {}),
      forwardHierarchyToObservationStream: (hierarchy, frameContext, hooks) =>
        this.forwardHierarchyToObservationStream(hierarchy, frameContext, hooks),
    }));
  }
  protected suppressHierarchyObservationStreamPush(requestId: string, timeoutMs: number): void {
    return this.observationStream.suppressHierarchyObservationStreamPush(requestId, timeoutMs);
  }
  private consumeHierarchyObservationStreamSuppression(requestId: string): boolean {
    return this.observationStream.consumeHierarchyObservationStreamSuppression(requestId);
  }
  private pushHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    source: XCTestHierarchy | undefined,
    frameContext?: string,
  ): void {
    return this.observationStream.pushHierarchyToObservationStream(hierarchy, source, frameContext);
  }
  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void {
    return this.observationStream.recordInitialObservationStreamHierarchy(
      hierarchy,
      captureSequence,
    );
  }
  private pushScreenshotToObservationStream(options: ScreenshotObservationStreamOptions): void {
    this.observationStream.pushScreenshotToObservationStream(options);
  }
  private startScreenshotBackoff(): void {
    return this.observationStream.startScreenshotBackoff();
  }
  private async captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult> {
    return this.observationStream.captureScreenshotForBackoff();
  }
  private _inbound: CtrlProxyInboundMessages | null = null;
  protected get inbound(): CtrlProxyInboundMessages {
    const client = this;
    return (this._inbound ??= new CtrlProxyInboundMessages({
      timer: this.timer,
      requestManager: this.requestManager,
      deviceId: this.device.deviceId,
      transientObserver: this.transientObserver,
      observerHierarchyRequestIds: this.observerHierarchyRequestIds,
      rejectedCommands: this.rejectedCommands,
      sdkCapability: this.sdkCapability,
      get cachedHierarchy() {
        return client.cachedHierarchy;
      },
      set cachedHierarchy(value) {
        client.cachedHierarchy = value;
      },
      get cachedHierarchyDisplayRevision() {
        return client.cachedHierarchyDisplayRevision;
      },
      set cachedHierarchyDisplayRevision(value) {
        client.cachedHierarchyDisplayRevision = value;
      },
      get supportedCommands() {
        return client.supportedCommands;
      },
      set supportedCommands(value) {
        client.supportedCommands = value;
      },
      get supportedFeatures() {
        return client.supportedFeatures;
      },
      set supportedFeatures(value) {
        client.supportedFeatures = value;
      },
      getMessageEffects: () => this.messageEffects,
      syncHierarchyCadenceToDevice: () => this.syncHierarchyCadenceToDevice(),
      handlePerformanceUpdate: (snapshot) => this.handlePerformanceUpdate(snapshot),
    }));
  }
  private processMessage(message: WebSocketMessage): void {
    this.inbound.processMessage(message);
  }
  public getInboundMessageTestHooks(): Pick<CtrlProxyInboundMessages, "processMessage"> {
    return this.inbound;
  }
  protected readonly sdkCapability = new CtrlProxySdkCapabilities({
    timer: this.timer,
    getSupportedCommands: () => this.supportedCommands,
    isCommandSupported: (type) => this.isCommandSupported(type),
    createDelegateContext: () => this.createDelegateContext(),
    syncNetworkMockRulesToDevice: () => this.networkSync.syncNetworkMockRulesToDevice(),
    syncNetworkErrorSimulationToDevice: () => this.networkSync.syncNetworkErrorSimulationToDevice(),
  });
  public getSdkCapabilityTestHooks(): Pick<
    CtrlProxySdkCapabilities,
    "ensureSdkCapability" | "sdkCapabilityGate" | "requestSdkCapabilities" | "seedForTesting"
  > {
    return this.sdkCapability;
  }
  private readonly networkSync = new CtrlProxyNetworkSync({
    getDevice: () => this.device,
    requestManager: this.requestManager,
    sdkCapability: this.sdkCapability,
    sendMessage: (data) => this.sendMessage(data),
    isCommandSupported: (type) => this.isCommandSupported(type),
    createDelegateContext: () => this.createDelegateContext(),
  });
  public syncNetworkMockRulesIfAvailable(): Promise<IosMockRuleSyncResult> {
    return this.networkSync.syncNetworkMockRulesIfAvailable();
  }
  async setNetworkErrorSimulation(
    config: IosNetworkErrorSimulationConfig,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    return this.networkSync.setNetworkErrorSimulation(config, timeoutMs, perf);
  }
  private readonly sdkScreenIdentity = new CtrlProxySdkScreenIdentity({
    invalidateBuildContext: (appId) => this.buildContext.invalidateBuildContext(appId),
    invalidateAllBuildContexts: () => this.buildContext.invalidateAll(),
    invalidateSdkCapabilities: () => this.sdkCapability.invalidateSdkCapabilities(),
  });
  public getSdkScreenIdentity(applicationId?: string): ScreenIdentity | undefined {
    return this.sdkScreenIdentity.getSdkScreenIdentity(applicationId);
  }
  public clearSdkScreenIdentity(applicationId?: string): void {
    this.sdkScreenIdentity.clearSdkScreenIdentity(applicationId);
  }
  public getSdkScreenIdentityTestHooks(): Pick<
    CtrlProxySdkScreenIdentity,
    "activateSdkScreenIdentitySession"
  > {
    return this.sdkScreenIdentity;
  }
  private readonly sdkEvents = new CtrlProxySdkEvents({
    timer: this.timer,
    screenIdentity: this.sdkScreenIdentity,
    getSdkEventIngestor: () => this.sdkEventIngestor,
    getPort: () => this.port,
    resolveWebSocketHost: () => this.resolveWebSocketHost(),
    pollSdkEvents: () => this.pollSdkEvents(),
    getSdkScreenIdentity: (appId) => this.getSdkScreenIdentity(appId),
  });
  public refreshSdkScreenIdentity(appId?: string): Promise<ScreenIdentity | undefined> {
    return this.sdkEvents.refreshSdkScreenIdentity(appId);
  }
  public pollSdkEvents(): Promise<SdkEventPollResult> {
    return this.sdkEvents.pollSdkEvents();
  }
  public getSdkEventPollingTestHooks(): {
    polling: Pick<
      CtrlProxySdkEvents,
      | "startSdkEventPolling"
      | "runSdkEventPollCycle"
      | "currentSdkEventPollIntervalMs"
      | "stopSdkEventPolling"
      | "decodeSdkEventBatches"
      | "diagnostics"
    >;
    receiveMessage: (data: WebSocket.Data) => void;
  } {
    return { polling: this.sdkEvents, receiveMessage: (data) => this.handleMessage(data) };
  }
  private readonly buildContext: CtrlProxyBuildContext;
  public getBuildContextDiagnosticsForTesting() {
    return this.buildContext.diagnostics();
  }
  /** Per-device client instances (#11847); retired-device state stays on IOSCtrlProxyManager. */
  public static readonly registry = new MapDeviceClientRegistry<IOSCtrlProxyClient>();

  // Default port matches CtrlProxy on iOS
  public static readonly DEFAULT_PORT = 8765;
  // Raised from 500ms toward maxObservationAgeMs so cache hits replace device
  // round-trips during multi-step sequences, leaning on unsolicited
  // `hierarchy_update` pushes to keep the cache warm (#5472). Still floored by
  // `Math.min(cacheFreshTtlMs, maxObservationAgeMs())` in CtrlProxyHierarchy, and
  // a stale CAPTURE age past maxObservationAgeMs still forces re-verification.
  private static readonly CACHE_FRESH_TTL_MS = 2000;
  protected readonly transientObserver: boolean;

  // Push update callbacks
  private onPushUpdateCallbacks: Set<(hierarchy: XCTestHierarchy) => void> = new Set();

  private readonly rejectedCommands = new Set<string>();
  protected supportedFeatures: Set<string> | null = null;

  // Track last foreground bundle for performance monitoring
  private lastForegroundBundleId: string | null = null;

  // Platform-specific dependencies
  private port: number;

  // Logging tag for base class
  protected readonly logTag = "IOSCtrlProxyClient";
  private static readonly CONNECTION_RESET_MS = 2000;
  /** Port acquired by this registered client, if it still uses that allocation. */
  private allocatedPort: number | null = null;

  // Auto-setup on connection failure
  private readonly serviceManagerFactory: ServiceManagerFactory;
  private readonly bootedDeviceLister: BootedDeviceLister;
  private readonly deviceConnectionLostNotifier: DeviceConnectionLostNotifier;
  public static readonly OBSERVE_RECOVERY_WAIT_MS = 20_000;
  protected lastConnectFailure?: { reason: IosHierarchyUnavailableReason; detail?: string };

  // SDK-event ingestion (telemetry/failure fan-out + layout telemetry)
  private readonly sdkEventIngestor: IosSdkEventIngestor;
  private readonly messageEffects: IosHierarchyMessageEffects;

  private constructor(
    device: BootedDevice,
    port: number = IOSCtrlProxyClient.DEFAULT_PORT,
    options: IosCtrlProxyClientDependencies = {},
  ) {
    super(
      options.timer ?? defaultTimer,
      withCtrlProxyRecordingFromEnv(options.wsFactory ?? defaultWebSocketFactory),
      { connectionResetMs: IOSCtrlProxyClient.CONNECTION_RESET_MS },
      options.retryExecutor ?? defaultRetryExecutor,
    );
    this.device = device;
    this.transientObserver = options.transientObserver ?? false;
    this.buildContext = new CtrlProxyBuildContext(
      {
        device,
        timer: this.timer,
        isClosed: () => this.closed,
        getNavigationGraphManager: () => this.getNavigationGraphManager(),
      },
      options,
    );
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
    this.messageEffects = this.createMessageEffects(options.messageEffects);
  }

  /** Delegates each effect to this client's own member at call time, so per-instance overrides still apply. */
  private createMessageEffects(override?: IosHierarchyMessageEffects): IosHierarchyMessageEffects {
    return (
      override ?? {
        ignoreOlderPush: (message) => this.inbound.ignoreOlderHierarchyPush(message),
        retainScaleMetadata: (hierarchy) => this.retainScaleMetadataFrom(hierarchy),
        recordNavigation: (hierarchy, perfTiming) =>
          this.handleHierarchyUpdateForNavigation(hierarchy, perfTiming),
        convert: (hierarchy) => this.convertToViewHierarchyResult(hierarchy),
        recordLayoutTelemetry: (converted) =>
          this.sdkEventIngestor.recordLayoutTelemetryEvent(converted),
        consumeStreamSuppression: (requestId) =>
          this.consumeHierarchyObservationStreamSuppression(requestId),
        pushToObservationStream: (converted, source, frameContext) =>
          this.pushHierarchyToObservationStream(converted, source, frameContext),
        startScreenshotBackoff: () => this.startScreenshotBackoff(),
        notifyPushListeners: (hierarchy) => this.notifyPushUpdateListeners(hierarchy),
        resolveRequest: (requestId, result) => {
          this.requestManager.resolve(requestId, result);
        },
      }
    );
  }

  /**
   * Get singleton instance for a device
   */
  public static getInstance(device: BootedDevice, port?: number): IOSCtrlProxyClient {
    requireBootedDevice(device, "IOSCtrlProxyClient.getInstance");
    const key = device.deviceId;
    const retired = IOSCtrlProxyManager.isDeviceRetired(key);
    const existing = IOSCtrlProxyClient.registry.peek(key);
    if (existing) {
      if (port !== undefined && !existing.closed && !retired) {
        existing.updatePort(port);
      }
      return existing;
    }
    return IOSCtrlProxyClient.registry.get(key, () => {
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
      return client;
    });
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
    return IOSCtrlProxyClient.registry.peek(deviceId) ?? null;
  }

  /** @internal Test seam matching AndroidCtrlProxyClient.registerForTesting. */
  public static registerForTesting(client: IOSCtrlProxyClient, deviceId: string): void {
    IOSCtrlProxyClient.registry.invalidate(deviceId);
    IOSCtrlProxyClient.registry.get(deviceId, () => client);
  }

  /**
   * @internal Clear registry entries for isolated tests only. This closes
   * nothing and resets no ports, observers, or retired-device state. Unlike
   * resetInstances(), it avoids fire-and-forget close() cleanup that can run
   * real socket work and leaves IOSCtrlProxyManager's retired-device state
   * untouched.
   */
  public static clearInstanceRegistryForTesting(): void {
    IOSCtrlProxyClient.registry.closeAll();
  }

  /** Permanently retire the registered client for one device incarnation. */
  public static async retireInstance(deviceId: string): Promise<void> {
    IOSCtrlProxyManager.retireDevice(deviceId);
    const instance = IOSCtrlProxyClient.registry.peek(deviceId);
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
    IOSCtrlProxyClient.registry.invalidate(deviceId);
    IOSCtrlProxyManager.resumeDevice(deviceId);
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
      iosSource: resident?.buildContext.dependencies().iosSource,
      contentHashProvider: resident?.buildContext.dependencies().contentHashProvider,
    });
    if (ownsPortAllocation) {
      client.allocatedPort = port;
    }
    return client;
  }

  /**
   * Diagnostic accessor for doctor: reports the host port this client will use
   * for the runner WebSocket without opening any additional connection.
   */
  public getConnectionPortForDiagnostics(): number {
    return this.port;
  }

  protected override onSessionRebound(): void {
    // iOS deliberately does not rearm on session changes: IOSCtrlProxyManager owns
    // the shared ForcedRestartBudget and rearms it on explicit start or device reappearance.
  }

  /**
   * The session currently receiving this device's navigation events, or null when
   * unbound. Mirrors the Android client.
   */
  public getBoundSessionId(): string | null {
    return this.boundSessionId;
  }

  /** Test-only alias kept for isolation tests that pin the routing invariant. */
  public getBoundSessionIdForTesting(): string | null {
    return this.getBoundSessionId();
  }

  /**
   * Get the NavigationGraphManager for the bound session, or the global singleton.
   */
  private getNavigationGraphManager(): NavGraph {
    return this.boundSessionId
      ? NavigationGraphManager.getInstanceForSession(this.boundSessionId)
      : NavigationGraphManager.getInstance();
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTesting(
    device: BootedDevice,
    port: number,
    wsFactory: WebSocketFactory,
    timer: Timer,
    dependencies: IosCtrlProxyClientTestOptions = {},
  ): IOSCtrlProxyClient {
    const {
      serviceManagerFactory = noOpServiceManagerFactory,
      bootedDeviceLister,
      deviceConnectionLostNotifier,
      sdkEventIngestor,
      retryExecutor,
      options = false,
    } = dependencies;
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
    for (const instance of IOSCtrlProxyClient.registry.closeAll()) {
      void instance.close();
    }
    IOSCtrlProxyManager.resetRetiredDevicesForTesting();
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
    this.buildContext.close();
    this.runnerRecovery.close();
    try {
      await super.close();
    } finally {
      const registered = IOSCtrlProxyClient.registry.peek(this.device.deviceId);
      if (registered === this) {
        IOSCtrlProxyClient.registry.invalidate(this.device.deviceId, this);
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
        // Same teardown a lost connection gets (pending requests rejected,
        // per-connection caches/polling reset via onConnectionClosed, an error
        // listener kept on the closing socket), minus auto-reconnect.
        this.retireLiveSocket(new CtrlProxyServicePortChangedError());
      }
    }
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
    this.sdkEvents.noteSdkEventPollWsActivity();
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      this.processMessage(message);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to parse message: ${error}`);
    }
  }

  /**
   * Push THIS device's mock rules and error simulation from the host store.
   * Used after a session release clears the store (issue #10061); the
   * reconnect path runs the same two syncs.
   */
  public async syncNetworkStateFromHost(): Promise<void> {
    await this.syncNetworkMockRulesIfAvailable();
    this.networkSync.syncNetworkErrorSimulationToDevice();
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
    this.runnerRecovery.connectionClosed();
    this.cancelScreenshotBackoff();
    this.onClientClosedWithoutConnection();
    this.cachedHierarchy = null;
    this.inbound.resetOlderHierarchyPushRun();
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
    this.sdkEvents.close();
  }

  protected override onConnectionFailureThresholdReached(): void {
    this.runnerRecovery.triggerServiceRestart("connection-failures");
  }

  /**
   * A command (tap, observe hierarchy, ...) that timed out on a runner that
   * then ignored a ping joins the same budgeted force-restart path as failed
   * readiness checks, instead of waiting for the 60 s liveness probe or the
   * process supervisor (#11247). The timed-out command is never replayed.
   */
  protected override onConfirmedRequestStall(_request: TimedOutRequest): void {
    this.runnerRecovery.triggerServiceRestart("observed-failure");
  }

  /** Start runner recovery for this observed failure, subject to the manager budget. */
  public ensureRecoveryStarted(): void {
    this.runnerRecovery.triggerServiceRestart();
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

  protected isCommandSupported(messageType: string): boolean {
    return (
      !this.rejectedCommands.has(messageType) &&
      (this.supportedCommands === null || this.supportedCommands.has(messageType))
    );
  }

  protected override beforeHandshakeWait(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  protected override awaitHandshakePoll(
    work: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    return raceWithDeadline(work, { timer: this.timer, signal, label: "iOS diagnostic handshake" });
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

  protected buildUnsupportedCommandError(messageType: string): string {
    return `iOS CtrlProxy runner does not support ${messageType}. The daemon and runner are out of sync; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.`;
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
}
