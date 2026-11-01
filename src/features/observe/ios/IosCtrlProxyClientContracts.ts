import { resolveAssetVersion, resolvePinnedVersion } from "../../../constants/release";
import { CtrlProxyIosManager, IOSCtrlProxyManager } from "../../../ctrlProxy/IOSCtrlProxyManager";
import {
  BootedDevice,
  HighlightShape,
  ImeAction,
  ScreenScaleMetadata,
  ViewHierarchyResult,
} from "../../../models";
import type { IosAppMetadataSource } from "../../../models/IosAppMetadataSource";
import type { ContentHashProvider } from "../../../utils/ContentHashProvider";
import { compareStrictNumericVersions } from "../../../utils/deviceMatcher";
import { PlatformDeviceManagerFactory } from "../../../utils/factories/PlatformDeviceManagerFactory";
import type { MultiFingerSwipeRequest } from "../../../utils/interfaces/MultiFingerSwipeRequest";
import { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { defaultRetryExecutor, RetryExecutor } from "../../../utils/retry/RetryExecutor";
import { defaultTimer, Timer } from "../../../utils/SystemTimer";
import type { InputKeyModifier, InputKeyName } from "../../action/InputKey";
import { NavigationGraphManager } from "../../navigation/NavigationGraphManager";
import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import type { SetTextOptions } from "../DeviceService";
import { WebSocketFactory } from "../DeviceServiceClient";
import type { LatestHierarchyOptions } from "../android/types";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";
import type { PinchRequest, TapCoordinatesRequest } from "../shared/SharedGestureDelegate";
import type {
  BaseResult,
  DispatchOptions,
  DragRequest,
  GestureTimingResult,
  SwipeRequest,
} from "../shared/types";
import { type IOSDispatchResult, type IosFrameDispatchOptions } from "./CtrlProxyDispatch";
import { type IosNetworkErrorSimulationConfig } from "./CtrlProxyNetworkSync";
import { type SdkTriggerRequest } from "./CtrlProxySdkTrigger";
import type { IosActivateAccessibilityLinkRequest } from "./CtrlProxyVoiceOver";
import {
  type CtrlProxyRequestActionOptions,
  type VoiceOverActivationOptions,
} from "./CtrlProxyVoiceOver";
import type { IosHierarchyMessageEffects } from "./IosHierarchyMessageEffects";
import { type IosSdkEventIngestor } from "./IosSdkEventIngestor";
import { NoOpIOSCtrlProxyManager } from "./NoOpIOSCtrlProxyManager";
import type {
  CtrlProxyActionResult,
  CtrlProxyClipboardResult,
  CtrlProxyDragResult,
  CtrlProxyHierarchyResponse,
  CtrlProxyHighlightResult,
  CtrlProxyHingeAngleResult,
  CtrlProxyLocationRequest,
  CtrlProxyLocationResult,
  CtrlProxyAppearanceResult,
  CtrlProxySiriResult,
  CtrlProxyImeActionResult,
  CtrlProxyKeyboardResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyMagicTapResult,
  CtrlProxyPinchResult,
  CtrlProxyPressBackResult,
  CtrlProxyPressButtonResult,
  CtrlProxyPressHomeResult,
  CtrlProxyPressKeyResult,
  CtrlProxyRecentAppsResult,
  CtrlProxyResetPermissionsResult,
  CtrlProxyRotateResult,
  CtrlProxyScreenshotResult,
  CtrlProxySdkTriggerResult,
  CtrlProxySelectAllResult,
  CtrlProxySetTextResult,
  CtrlProxyShakeResult,
  CtrlProxySwipeResult,
  CtrlProxySyncedHierarchy,
  CtrlProxyTapResult,
  CtrlProxyVoiceOverResult,
  XCTestHierarchy,
} from "./types";

/**
 * Factory function type for creating CtrlProxyIosManager instances.
 * Used for testing to inject fake service managers.
 */
export type ServiceManagerFactory = (device: BootedDevice) => CtrlProxyIosManager;

/** Default production factory that delegates to the real singleton. */
export type NavGraph = ReturnType<typeof NavigationGraphManager.getInstance>;

export const defaultServiceManagerFactory: ServiceManagerFactory = (d) =>
  IOSCtrlProxyManager.getInstance(d);

export type BootedDeviceLister = () => Promise<BootedDevice[]>;

export interface IosCtrlProxyClientOptions {
  transientObserver?: boolean;
  iosSource?: IosAppMetadataSource;
  contentHashProvider?: ContentHashProvider;
}

export interface IosCtrlProxyClientDependencies extends IosCtrlProxyClientOptions {
  wsFactory?: WebSocketFactory;
  timer?: Timer;
  serviceManagerFactory?: ServiceManagerFactory;
  bootedDeviceLister?: BootedDeviceLister;
  deviceConnectionLostNotifier?: DeviceConnectionLostNotifier;
  sdkEventIngestor?: IosSdkEventIngestor;
  logDemandProbe?: (deviceId: string) => boolean;
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
  logDemandProbe?: (deviceId: string) => boolean;
  retryExecutor?: RetryExecutor;
  options?: boolean | IosCtrlProxyClientOptions;
}

// Test-created clients must never fall through to simctl/devicectl for provenance.
export const noOpIosMetadataSource: IosAppMetadataSource = {
  listApps: async () => [],
  getPhysicalDeviceAppInfo: async () => null,
};

/** Default production lister that queries the real device manager. */
export const defaultBootedDeviceLister: BootedDeviceLister = () =>
  PlatformDeviceManagerFactory.getInstance().getBootedDevices("ios");

export const noOpServiceManagerFactory: ServiceManagerFactory = () => new NoOpIOSCtrlProxyManager();

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
    options?: LatestHierarchyOptions & { skipWaitForFresh?: boolean },
  ): Promise<CtrlProxyHierarchyResponse>;

  requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
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

  /** The runner's reported screen scale, or null until a hierarchy that carried it arrives. */
  getScreenScaleMetadata(): ScreenScaleMetadata | null;

  requestSwipe(request: SwipeRequest): Promise<IOSDispatchResult<CtrlProxySwipeResult>>;

  requestDoubleTapCoordinates(
    x: number,
    y: number,
    timeoutMs?: number,
    options?: IosFrameDispatchOptions,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>>;

  requestTapCoordinates(
    request: TapCoordinatesRequest,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>>;

  requestDrag(request: DragRequest): Promise<CtrlProxyDragResult>;

  requestPathGesture(
    points: ReadonlyArray<{ x: number; y: number; offsetMs: number }>,
    timeoutMs?: number,
    options?: IosFrameDispatchOptions,
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
    options?: Pick<SetTextOptions, "abortSignal" | "deadlineMs" | "onDispatch"> & {
      frameContext?: string;
    },
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
    options?: { abortSignal?: AbortSignal; onDispatch?: () => void },
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
    options?: DispatchOptions & { perf?: PerformanceTracker },
  ): Promise<IOSDispatchResult<CtrlProxyPressKeyResult>>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    options?: DispatchOptions & { perf?: PerformanceTracker },
  ): Promise<CtrlProxyClipboardResult & { acknowledged?: boolean }>;

  requestPressHome(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: IosFrameDispatchOptions,
  ): Promise<IOSDispatchResult<CtrlProxyPressHomeResult>>;

  requestPressBack(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: IosFrameDispatchOptions,
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
    options?: IosFrameDispatchOptions,
  ): Promise<IOSDispatchResult<CtrlProxyPressButtonResult>>;

  requestRecentApps(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: IosFrameDispatchOptions,
  ): Promise<IOSDispatchResult<CtrlProxyRecentAppsResult>>;

  requestRotate(
    orientation: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyRotateResult>;

  requestSetHingeAngle(angle: number, timeoutMs?: number): Promise<CtrlProxyHingeAngleResult>;

  requestLocation(
    request: CtrlProxyLocationRequest,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CtrlProxyLocationResult>;

  requestSiri(text: string, timeoutMs?: number, signal?: AbortSignal): Promise<CtrlProxySiriResult>;

  requestAppearance(
    appearance?: "light" | "dark",
    timeoutMs?: number,
  ): Promise<CtrlProxyAppearanceResult>;

  requestLaunchApp(
    bundleId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: { coldBoot?: boolean; signal?: AbortSignal },
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
    options?: VoiceOverActivationOptions & { perf?: PerformanceTracker },
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
    options?: CtrlProxyRequestActionOptions & { timeoutMs?: number },
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
export const IOS_RUNNER_FEATURE_FLAGS_MIN_RELEASE = "0.0.67";

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

export function iosCtrlProxyTestDependencies(
  device: BootedDevice,
  wsFactory: WebSocketFactory,
  timer: Timer,
  dependencies: IosCtrlProxyClientTestOptions,
): IosCtrlProxyClientDependencies {
  const {
    serviceManagerFactory = noOpServiceManagerFactory,
    bootedDeviceLister,
    deviceConnectionLostNotifier,
    sdkEventIngestor,
    logDemandProbe,
    retryExecutor,
    options = false,
  } = dependencies;
  // Default test lister always reports the device as booted so existing tests
  // are unaffected. Tests that verify boot-check behavior supply their own lister.
  const lister = bootedDeviceLister ?? (async () => [device]);
  return {
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
    logDemandProbe,
    retryExecutor,
  };
}

export const defaultObservationReadDependencies = {
  timer: defaultTimer,
  serviceManagerFactory: defaultServiceManagerFactory,
  bootedDeviceLister: defaultBootedDeviceLister,
  deviceConnectionLostNotifier: observationStreamDeviceConnectionLostNotifier,
  retryExecutor: defaultRetryExecutor,
};
