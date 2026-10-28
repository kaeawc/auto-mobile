import { androidCtrlProxyClientForPlatform } from "../observe/android/androidCtrlProxyClientFor";
import {
  TapAnyAndroidTapper,
  assertSelectedCapture,
  type TapAnyAccessibilityService,
  type CapturedTapTarget,
  type RefreshViewHierarchy,
} from "./TapAnyAndroidTapper";
import { TapAnyIosTapper } from "./TapAnyIosTapper";
import { readFreshPlatformHierarchy } from "./tapHierarchyRead";
import {
  containerSelectorError,
  failedTapResult,
  isContainerAvailable,
  resolveSearchUntilDuration,
} from "./tapSharedHelpers";
import {
  withObservationReadScope,
  wasHierarchyReadDuringCall,
} from "../observe/observationReadScope";
import { freshTapHierarchy } from "./freshTapHierarchy";
import {
  TALKBACK_STATE_UNKNOWN_WARNING,
  resolveTalkBackStateConfirmation,
} from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import {
  prepareTargetDisplayAction,
  refreshTargetDisplayHierarchy,
  sessionRenderedObservation,
  type RenderedObservationReader,
} from "./TargetDisplayAction";
import {
  DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
  createDeviceHierarchyCapture,
} from "../observe/DeviceHierarchyCapture";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { type DisplayFence, type DisplayFenceDependencies } from "./BaseVisualChange";
import { withStaleDisplay, StaleDisplayError } from "../observe/StaleDisplayError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import {
  DefaultHierarchyCapture,
  identifyObservedHierarchy,
  type HierarchyCapture,
  type HierarchySnapshot,
} from "../observe/HierarchyCapture";
import type { TapAnyElementResult } from "../../models/TapAnyElementResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  TapAnyElementOptions,
  TapOnElementResult,
  ViewHierarchyResult,
  requireAndroidOrIosPlatform,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import {
  DefaultElementGeometry,
  type ScreenSizeForOffscreenCheckOptions,
} from "../utility/ElementGeometry";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import { logger } from "../../utils/logger";
import { type AndroidCtrlProxy } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import { pollSearchUntil } from "./searchUntilPoller";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { type Timer } from "../../utils/SystemTimer";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import { FeatureFlagService, type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import type { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../ctrlProxy/accessibility/AccessibilityDetector";
import { androidDisplayTapDispatch } from "./coordinateTapDispatch";
import { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import { assertAppGestureNotUnderPrototype } from "../observe/hierarchyLayer";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import { deadlineRequest, resolveDeadlineActionCall, type ActionCall } from "./ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";
import { TAP_ANY_SEARCH_UNTIL_DEFAULT_MS, TAP_ANY_SEARCH_UNTIL_MAX_MS } from "./tapAnyBudgets";
import { findTapAnyClickableElement, resolveTapAnyPoint } from "./tapAnyTargetGeometry";
import {
  capturedTapAnyTarget,
  getTapAnyLongPressDuration,
  throwMissingTapAnyElement,
  prepareTapAnyHierarchyForResponse,
} from "./tapAnyObservation";

export {
  TAP_ANY_SEARCH_UNTIL_DEFAULT_MS,
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS,
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID,
  TAP_ANY_SEARCH_UNTIL_MAX_MS,
  TAP_ANY_ORDINARY_TAP_DURATION_MS,
  TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS,
  TAP_ANY_DOUBLE_TAP_GAP_MS,
  TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS,
  TAP_ANY_TERMINAL_SCREENSHOT_WORST_CASE_MS,
  TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
  TAP_ANY_LONG_PRESS_MAX_DURATION_MS,
} from "./tapAnyBudgets";

export { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "./gestureTransportTimeout";

interface TapAnyElementDependencies extends DisplayFenceDependencies {
  androidTapper?: Pick<TapAnyAndroidTapper, "executeAndroidTap" | "retryAndroidTapIfNoChange">;
  iosTapper?: Pick<TapAnyIosTapper, "executeIosTap">;
  lastRenderedObservation?: RenderedObservationReader;
  hierarchyCapture?: HierarchyCapture;
  timer?: Timer;
  elementSelector?: ElementSelector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagReader;
  accessibilityDetector?: AccessibilityDetector;
  talkBackStrategy?: Pick<
    TalkBackTapStrategy,
    | "executeDirectActivation"
    | "executeCoordinateFallback"
    | "executeLongPress"
    | "executePreciseTap"
  >;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  accessibilityService?: TapAnyAccessibilityService;
}
export { TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS } from "./tapAnyCtrlProxyTimeout";

export class TapAnyElement extends BaseVisualChange {
  private readonly androidTapper: Pick<
    TapAnyAndroidTapper,
    "executeAndroidTap" | "retryAndroidTapIfNoChange"
  >;
  private readonly iosTapper: Pick<TapAnyIosTapper, "executeIosTap">;
  /** tapAny drives only Android and iOS; a watch is rejected before any platform-specific step. */
  private readonly tapPlatform = requireAndroidOrIosPlatform(this.device.platform, "tapAny");
  private readonly iosMultiPanel =
    this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1;
  private readonly lastRenderedObservation: RenderedObservationReader;
  private geometry: ElementGeometry;
  private elementSelector: ElementSelector;
  private accessibilityService: TapAnyAccessibilityService;
  private hierarchyAccessibilityService: AndroidCtrlProxy;
  private viewHierarchy: ViewHierarchy;
  private hierarchyCapture: HierarchyCapture;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private featureFlags: FeatureFlagReader;
  private accessibilityDetector: AccessibilityDetector;
  private talkBackStrategy: Pick<
    TalkBackTapStrategy,
    | "executeDirectActivation"
    | "executeCoordinateFallback"
    | "executeLongPress"
    | "executePreciseTap"
  >;
  private talkBackDriverFactory: TalkBackNavigationDriverFactory;
  private refreshViewHierarchyOverrideForTesting?: (
    refresh: RefreshViewHierarchy,
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
  ) => Promise<ViewHierarchyResult | null>;
  private beforeAndroidTapForTesting?: () => void;

  private static readonly SEARCH_UNTIL_DEFAULT_MS = TAP_ANY_SEARCH_UNTIL_DEFAULT_MS;
  private static readonly SEARCH_UNTIL_MIN_MS = 100;
  private static readonly SEARCH_UNTIL_MAX_MS = TAP_ANY_SEARCH_UNTIL_MAX_MS;
  private static readonly SEARCH_POLL_INTERVAL_MS = 100;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    options: TapAnyElementDependencies = {},
  ) {
    super(device, adb, options.timer, options.renderedDisplayRevision, options);
    this.lastRenderedObservation = options.lastRenderedObservation ?? sessionRenderedObservation;
    this.geometry = new DefaultElementGeometry();
    this.elementSelector =
      options.elementSelector ??
      new ResolverElementSelector(undefined, undefined, {
        platform: this.tapPlatform,
        iosMultiPanel: this.iosMultiPanel,
      });
    this.accessibilityService =
      options.accessibilityService ?? androidCtrlProxyClientForPlatform(device, this.adbFactory);
    this.hierarchyAccessibilityService = androidCtrlProxyClientForPlatform(device, this.adbFactory);
    this.viewHierarchy = new ViewHierarchy(device, this.adbFactory);
    this.hierarchyCapture =
      options.hierarchyCapture ??
      new DefaultHierarchyCapture(
        this.tapPlatform,
        {
          readCached: (request) =>
            this.viewHierarchy.getViewHierarchy(
              {},
              {
                skipWaitForFresh: true,
                minTimestamp: request.minTimestamp ?? 0,
                signal: request.signal,
                timeoutMs: request.timeoutMs,
              },
            ),
          readFresh: async (request) => {
            if (request.displayId !== undefined) {
              return (
                await createDeviceHierarchyCapture(device, {
                  adbFactory: this.adbFactory,
                  timer: this.timer,
                }).capture(request)
              ).hierarchy;
            }
            const hierarchy = await this.readFreshHierarchy(
              request.timeoutMs ?? TAP_ANY_SEARCH_UNTIL_DEFAULT_MS,
              undefined,
              request.signal,
              request.requireFreshExtraction,
            );
            if (!hierarchy) {
              throw new ActionableError("Unable to retrieve a fresh tapAny hierarchy");
            }
            return hierarchy;
          },
          projectVisible: (hierarchy) => this.viewHierarchy.projectActionableHierarchy(hierarchy),
        },
        this.timer,
      );
    this.iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
    this.accessibilityDetector = options.accessibilityDetector ?? defaultAccessibilityDetector;
    this.talkBackDriverFactory =
      options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(this.adbFactory);
    this.talkBackStrategy =
      options.talkBackStrategy ??
      new TalkBackTapStrategy({ timer: this.timer, driverFactory: this.talkBackDriverFactory });
    const tappers = this.createTappers(options);
    this.androidTapper = tappers.android;
    this.iosTapper = tappers.ios;
  }

  private createTappers(options: TapAnyElementDependencies) {
    const android =
      options.androidTapper ??
      new TapAnyAndroidTapper({
        device: this.device,
        timer: this.timer,
        getAdb: () => this.adb,
        accessibilityService: this.accessibilityService,
        accessibilityDetector: this.accessibilityDetector,
        featureFlags: this.featureFlags,
        talkBackStrategy: this.talkBackStrategy,
        talkBackDriverFactory: this.talkBackDriverFactory,
        beforeTap: () => this.beforeAndroidTapForTesting?.(),
        refreshViewHierarchy: (timeout, size, signal, forceCapture) =>
          this.refreshViewHierarchy(timeout, size, signal, forceCapture),
        findClickableElement: (options, hierarchy, size) =>
          this.findClickableElement(options, hierarchy, size),
        resolveTapPoint: (target, size) => this.resolveTapPoint(target, size),
      });
    const ios =
      options.iosTapper ??
      new TapAnyIosTapper({
        device: this.device,
        iosVoiceOverDetector: this.iosVoiceOverDetector,
        featureFlags: this.featureFlags,
      });
    return { android, ios };
  }

  /** @internal Typed view of private seams for unit tests; not part of the public API. */
  get testHooks() {
    return {
      findClickableElement: this.findClickableElement.bind(this),
      refreshViewHierarchy: this.refreshViewHierarchy.bind(this),
      readFreshHierarchy: this.readFreshHierarchy.bind(this),
      /** Supplies the post-gesture hierarchy probe result. */
      setRefreshViewHierarchy: (
        refresh: NonNullable<typeof this.refreshViewHierarchyOverrideForTesting>,
      ): void => {
        this.refreshViewHierarchyOverrideForTesting = refresh;
      },
      /** Observes when Android gesture dispatch begins. */
      setBeforeAndroidTap: (callback: () => void): void => {
        this.beforeAndroidTapForTesting = callback;
      },
    };
  }

  private createErrorResult(action: string, error: string): TapOnElementResult {
    return failedTapResult(action, error);
  }

  private getSearchUntilDuration(options: TapAnyElementOptions): number {
    return resolveSearchUntilDuration(options.searchUntil?.duration, {
      defaultMs: TapAnyElement.SEARCH_UNTIL_DEFAULT_MS,
      minMs: TapAnyElement.SEARCH_UNTIL_MIN_MS,
      maxMs: TapAnyElement.SEARCH_UNTIL_MAX_MS,
    });
  }

  private isContainerAvailable(
    viewHierarchy: ViewHierarchyResult,
    container?: ElementContainerSelector,
  ): boolean {
    return isContainerAvailable(this.elementSelector, viewHierarchy, container);
  }

  private findClickableElement(
    options: TapAnyElementOptions,
    viewHierarchy: ViewHierarchyResult,
    sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
  ): { element: Element | null; containerFound: boolean } {
    return findTapAnyClickableElement(
      {
        elementSelector: this.elementSelector,
        isContainerAvailable: (hierarchy, container) =>
          this.isContainerAvailable(hierarchy, container),
        platform: this.tapPlatform,
        iosMultiPanel: this.iosMultiPanel,
      },
      options,
      viewHierarchy,
      sizeOptions,
    );
  }

  private resolveTapPoint(
    target: CapturedTapTarget,
    sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
  ): { x: number; y: number } {
    return resolveTapAnyPoint(
      {
        geometry: this.geometry,
        platform: this.tapPlatform,
        iosMultiPanel: this.iosMultiPanel,
      },
      target,
      sizeOptions,
    );
  }

  private async refreshViewHierarchy(
    timeoutMs: number,
    _screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    if (this.refreshViewHierarchyOverrideForTesting) {
      return this.refreshViewHierarchyOverrideForTesting(
        (timeout, size, abort) =>
          this.refreshViewHierarchyDefault(timeout, size, abort, forceCapture),
        timeoutMs,
        _screenSize,
        signal,
      );
    }
    return this.refreshViewHierarchyDefault(timeoutMs, _screenSize, signal, forceCapture);
  }

  private async refreshViewHierarchyDefault(
    timeoutMs: number,
    _screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    if (timeoutMs <= 0) {
      return null;
    }
    try {
      const snapshot = await this.hierarchyCapture.capture({
        freshness: "fresh",
        ...(forceCapture ? { requireFreshExtraction: true } : {}),
        searchRaw: serverConfig.isRawElementSearchEnabled(),
        timeoutMs,
        signal,
      });
      identifyObservedHierarchy(
        this.tapPlatform,
        snapshot.hierarchy,
        "fresh",
        this.timer,
        undefined,
        { captureId: snapshot.captureId, iosMultiPanel: this.iosMultiPanel },
      );
      return snapshot.hierarchy;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[TapAnyElement] Fresh capture failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private async readFreshHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    return readFreshPlatformHierarchy(
      {
        device: this.device,
        adb: this.adb,
        timer: this.timer,
        androidService: this.hierarchyAccessibilityService,
        viewHierarchy: this.viewHierarchy,
        prepareForResponse: (raw, size) => this.prepareViewHierarchyForResponse(raw, size),
        actionLabel: "tap any element",
      },
      { timeoutMs, screenSize, signal, forceCapture },
    );
  }

  private async pollClickableTarget({
    options,
    observeResult,
    refresh,
    signal,
    selectedCapture,
    searchDurationMs,
    startTime,
    lastHash,
    containerFoundEver,
  }: {
    options: TapAnyElementOptions;
    observeResult: ObserveResult;
    refresh: RefreshViewHierarchy;
    signal?: AbortSignal;
    selectedCapture: HierarchySnapshot;
    searchDurationMs: number;
    startTime: number;
    lastHash: string | null;
    containerFoundEver: boolean;
  }) {
    let requestCount = 0;
    let changeCount = 0;
    let element: Element | null = null;
    const polled = await pollSearchUntil({
      timer: this.timer,
      startTime,
      durationMs: searchDurationMs,
      intervalMs: TapAnyElement.SEARCH_POLL_INTERVAL_MS,
      pacing: "sleepFirst",
      // A hierarchy request can consume the last millisecond of the search window. Do not
      // select from its result after the deadline: CtrlProxy may have served a stale fallback
      // when its synchronous refresh timed out, and a late candidate must not turn a bounded
      // search into an unbounded tap.
      discardLateResult: true,
      signal,
      fetch: (remainingTimeMs) => refresh(remainingTimeMs, observeResult.screenSize, signal),
      accept: (refreshed) => {
        const hash = hierarchyFingerprint(refreshed);
        if (hash && hash !== lastHash) {
          changeCount += 1;
          lastHash = hash;
        }

        selectedCapture = identifyObservedHierarchy(
          this.tapPlatform,
          refreshed,
          "fresh",
          this.timer,
          undefined,
          { iosMultiPanel: this.iosMultiPanel },
        );
        const found = this.findClickableElement(options, selectedCapture.hierarchy, {
          observationScreenSize: observeResult.screenSize,
          display: observeResult.viewHierarchy,
        });
        element = found.element;
        containerFoundEver = containerFoundEver || found.containerFound;
        return element !== null;
      },
    });
    requestCount = polled.requestCount;

    if (!element) {
      throwMissingTapAnyElement(options, containerFoundEver);
    }

    return { element, selectedCapture, startTime, requestCount, changeCount };
  }

  private async tapObservedElement({
    options,
    observeResult,
    fence,
    targetDisplay,
    refresh,
    onActivationWarnings,
    onDispatched,
    perf,
    signal,
    requestDeadlineMs,
  }: {
    options: TapAnyElementOptions;
    observeResult: ObserveResult;
    fence?: DisplayFence;
    targetDisplay: Awaited<ReturnType<typeof prepareTargetDisplayAction>> | undefined;
    refresh: RefreshViewHierarchy;
    onActivationWarnings: (messages?: string[]) => void;
    onDispatched: () => void;
    perf: PerformanceTracker;
    signal?: AbortSignal;
    requestDeadlineMs?: number;
  }) {
    throwIfAborted(signal);

    let viewHierarchy = observeResult.viewHierarchy;
    if (!viewHierarchy) {
      perf.end();
      return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
    }

    let talkBackState: boolean | null | undefined;
    if (this.device.platform === "android") {
      const confirmation = await resolveTalkBackStateConfirmation(
        this.accessibilityDetector,
        this.device.deviceId,
        this.adb,
        this.featureFlags,
      );
      talkBackState = confirmation.talkBack;
      if (confirmation.unconfirmed) {
        onActivationWarnings([TALKBACK_STATE_UNKNOWN_WARNING]);
      }
      if (talkBackState) {
        viewHierarchy = await freshTapHierarchy(
          (timeout) => refresh(timeout, observeResult.screenSize, signal),
          this.timer,
          signal,
        );
        observeResult.viewHierarchy = viewHierarchy;
      }
    }
    let selectedCapture = identifyObservedHierarchy(
      this.tapPlatform,
      viewHierarchy,
      "cached-ok",
      this.timer,
      undefined,
      { captureId: observeResult.observationId, iosMultiPanel: this.iosMultiPanel },
    );
    const searchDurationMs = this.getSearchUntilDuration(options);
    let startTime = this.timer.now();
    let requestCount = 0;
    let changeCount = 0;
    const lastHash = hierarchyFingerprint(viewHierarchy);

    const found = this.findClickableElement(options, selectedCapture.hierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    let element = found.element;
    const containerFoundEver = found.containerFound;

    if (!element) {
      ({ element, selectedCapture, requestCount, changeCount } = await this.pollClickableTarget({
        options,
        observeResult,
        refresh,
        signal,
        selectedCapture,
        searchDurationMs,
        startTime,
        lastHash,
        containerFoundEver,
      }));
    }
    const cachedRefresh = await this.refreshCachedHierarchy(
      viewHierarchy,
      talkBackState,
      requestCount,
      {
        refresh,
        screenSize: observeResult.screenSize,
        signal,
        requestDeadlineMs,
      },
    );
    talkBackState = cachedRefresh.accessibilityEnabled;
    if (cachedRefresh.hierarchy) {
      viewHierarchy = cachedRefresh.hierarchy;
      observeResult.viewHierarchy = viewHierarchy;
      startTime = this.timer.now();
      selectedCapture = identifyObservedHierarchy(
        this.tapPlatform,
        viewHierarchy,
        "fresh",
        this.timer,
      );
      const current = this.findClickableElement(options, selectedCapture.hierarchy, {
        observationScreenSize: observeResult.screenSize,
        display: viewHierarchy,
      });
      element = current.element;
      if (!element) {
        // Start the same search window as a cache miss, from the fresh tree.
        ({ element, selectedCapture, requestCount, changeCount } = await this.pollClickableTarget({
          options,
          observeResult,
          refresh,
          signal,
          selectedCapture,
          searchDurationMs,
          startTime,
          lastHash: hierarchyFingerprint(viewHierarchy),
          containerFoundEver: current.containerFound,
        }));
      }
    }
    const target = capturedTapAnyTarget(options, observeResult, {
      element,
      capture: selectedCapture,
      talkBackState,
    });
    const tapPoint = this.resolveTapPoint(target);
    // The element resolved in the scoped tree; the touch lands on whatever is on top (#9305).
    assertAppGestureNotUnderPrototype(target.capture.hierarchy, options.layer, tapPoint, "tap");
    const action = options.action;
    await this.dispatchTapTarget({
      options,
      observeResult,
      fence,
      targetDisplay,
      refresh,
      onActivationWarnings,
      onDispatched,
      signal,
      tapPoint,
      target,
      action,
    });
    perf.end();
    return this.createSuccessResult(action, target, startTime, requestCount, changeCount);
  }

  private async refreshCachedHierarchy(
    hierarchy: ViewHierarchyResult,
    accessibilityEnabled: boolean | null | undefined,
    requestCount: number,
    context: {
      refresh: RefreshViewHierarchy;
      screenSize: ObserveResult["screenSize"];
      signal?: AbortSignal;
      requestDeadlineMs?: number;
    },
  ): Promise<{
    hierarchy?: ViewHierarchyResult;
    accessibilityEnabled: boolean | null | undefined;
  }> {
    if (
      (this.device.platform !== "android" && this.device.platform !== "ios") ||
      accessibilityEnabled ||
      requestCount !== 0 ||
      wasHierarchyReadDuringCall(hierarchy)
    ) {
      return { accessibilityEnabled };
    }
    if (this.device.platform === "ios") {
      accessibilityEnabled = await this.iosVoiceOverDetector.isVoiceOverActiveOrUnknown(
        this.device.deviceId,
        IOSCtrlProxyClient.getInstance(this.device),
        this.featureFlags,
        undefined,
        context.signal,
      );
      if (accessibilityEnabled) {
        return { accessibilityEnabled };
      }
    }
    const refreshed = await freshTapHierarchy(
      (timeout) =>
        this.device.platform === "ios"
          ? context.refresh(timeout, context.screenSize, context.signal, true)
          : context.refresh(timeout, context.screenSize, context.signal),
      this.timer,
      context.signal,
      {
        timeoutMs: Math.min(
          DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
          context.requestDeadlineMs === undefined
            ? DEFAULT_HIERARCHY_READ_TIMEOUT_MS
            : context.requestDeadlineMs - this.timer.now(),
        ),
        context: "while revalidating a cached observation",
        platform: this.device.platform,
      },
    );
    return { hierarchy: refreshed, accessibilityEnabled };
  }

  private async dispatchTapTarget({
    options,
    observeResult,
    fence,
    targetDisplay,
    refresh,
    onActivationWarnings,
    onDispatched,
    signal,
    tapPoint,
    target,
    action,
  }: {
    options: TapAnyElementOptions;
    observeResult: ObserveResult;
    fence?: DisplayFence;
    targetDisplay: Awaited<ReturnType<typeof prepareTargetDisplayAction>> | undefined;
    refresh: RefreshViewHierarchy;
    onActivationWarnings: (messages?: string[]) => void;
    onDispatched: () => void;
    signal?: AbortSignal;
    tapPoint: { x: number; y: number };
    target: CapturedTapTarget;
    action: TapAnyElementOptions["action"];
  }): Promise<void> {
    const { element, capture: selectedCapture } = target;
    const longPressDuration = getTapAnyLongPressDuration(
      { platform: this.device.platform, timer: this.timer },
      options,
    );
    const tapContext = { signal, displayFence: fence, onActivationWarnings };

    logger.info(
      `[TapAnyElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on clickable element: ` +
        `text=${JSON.stringify(element.text)}, ` +
        `bounds=${JSON.stringify(element.bounds)}`,
    );

    switch (this.device.platform) {
      case "android": {
        const preTapHash = hierarchyFingerprint(selectedCapture.hierarchy);
        const dispatch = targetDisplay
          ? await androidDisplayTapDispatch(
              this.accessibilityService,
              this.adb,
              { action, duration: longPressDuration },
              {
                target: targetDisplay,
                signal,
                onDispatched,
                timer: this.timer,
                onWarning: (warning) => onActivationWarnings([warning]),
                // Same TalkBack state the default route uses; unknown/off keeps the raw gesture.
                talkBack:
                  target.talkBackState === true
                    ? {
                        strategy: this.talkBackStrategy,
                        driver: this.talkBackDriverFactory.createDriver(this.device),
                      }
                    : undefined,
              },
            )
          : undefined;
        if (dispatch) {
          assertSelectedCapture(selectedCapture);
          await dispatch(tapPoint);
        } else {
          await this.androidTapper.executeAndroidTap(
            action,
            tapPoint.x,
            tapPoint.y,
            longPressDuration,
            target,
            tapContext,
          );
        }
        await this.androidTapper.retryAndroidTapIfNoChange(
          preTapHash,
          target,
          action,
          longPressDuration,
          observeResult.screenSize,
          { ...tapContext, selectionOptions: options, refresh, dispatch },
        );
        break;
      }
      case "ios":
        targetDisplay?.assertCurrent();
        assertSelectedCapture(selectedCapture);
        await this.iosTapper.executeIosTap(
          action,
          tapPoint.x,
          tapPoint.y,
          longPressDuration,
          element,
          {
            signal,
            displayFence: fence,
            scoped: target.scoped,
            voiceOverEnabled: target.talkBackState ?? undefined,
          },
        );
        break;
      default:
        throw unsupportedPlatformError(this.device.platform, "tap any element");
    }
  }

  async execute(options: TapAnyElementOptions, call?: ActionCall): Promise<TapAnyElementResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    request?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult>;
  async execute(
    options: TapAnyElementOptions,
    progressOrCall?: ProgressCallback | ActionCall,
    signalArg?: AbortSignal,
    requestArg?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult> {
    const { progress, signal, deadlineMs } = resolveDeadlineActionCall(
      progressOrCall,
      signalArg,
      requestArg,
    );
    const request = deadlineRequest(deadlineMs);
    return withObservationReadScope(() =>
      this.executeWithReadScope(options, progress, signal, request),
    );
  }

  private async executeWithReadScope(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    // Internal transport context; never part of public options or tool schemas.
    request?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult> {
    if (!options.action) {
      return this.createErrorResult(options.action, "tap action is required");
    }

    const validationError = containerSelectorError(options.container, "tapAny");
    if (validationError) {
      return this.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAnyElement");

    let tapsDelivered = 0;
    let rethrowAbort = options.display !== undefined;
    try {
      // Reject before display resolution/observation can issue device commands.
      getTapAnyLongPressDuration(
        { platform: this.device.platform, timer: this.timer },
        options,
        request,
      );
      throwIfAborted(signal);

      const targetDisplay =
        options.display === undefined
          ? undefined
          : await prepareTargetDisplayAction(
              this.device,
              options.display,
              this.observeScreen,
              this.adb,
              {
                lastRenderedObservation: this.lastRenderedObservation,
                signal,
                transitions: this.displayTransitionReader,
              },
            );
      const refresh: RefreshViewHierarchy =
        targetDisplay && this.device.platform === "android"
          ? (timeoutMs, _screenSize, refreshSignal) =>
              refreshTargetDisplayHierarchy(
                targetDisplay,
                this.hierarchyCapture,
                timeoutMs,
                () =>
                  this.staleDisplay(
                    targetDisplay.observation.display.generation ??
                      this.displayTransitionReader.identityRevision(this.device.deviceId),
                  ),
                refreshSignal,
              )
          : this.refreshViewHierarchy.bind(this);
      const warnings = new Set<string>();
      const onActivationWarnings = (messages: string[] = []) => {
        for (const warning of messages) {
          warnings.add(warning);
        }
      };
      const result = await this.observedInteraction<TapAnyElementResult>(
        (observeResult, fence) =>
          this.tapObservedElement({
            options,
            observeResult,
            fence,
            targetDisplay,
            refresh,
            onActivationWarnings,
            onDispatched: () => {
              tapsDelivered++;
              rethrowAbort = options.action !== "doubleTap" || tapsDelivered !== 1;
            },
            perf,
            signal,
            requestDeadlineMs: request?.requestDeadlineMs,
          }),
        {
          ...OBSERVED_INTERACTION_PROFILES.selectorResolvedGesture,
          display: targetDisplay?.observation.display.key,
          previousObservation: targetDisplay?.observation,
          timeoutMs: SETTLE_BUDGET_MS.gesture,
          progress,
          perf,
          signal,
          predictionContext: {
            toolName: "tapAny",
            toolArgs: {
              action: options.action,
              duration: options.duration,
              container: options.container,
              selectionStrategy: options.selectionStrategy,
              scrollableContainer: options.scrollableContainer,
              platform: this.device.platform,
            },
          },
        },
      );

      this.checkTapDeliveryDisplay(result, targetDisplay?.assertCurrent, signal);
      return { ...result, ...(warnings.size > 0 ? { warnings: [...warnings] } : {}) };
    } catch (error) {
      perf.end();
      this.rethrowObservationAbort(error, signal, rethrowAbort);
      const errorMsg = errorMessage(error);
      logger.warn(`[TapAnyElement] Tap failed: ${errorMsg}`, error);
      if (error instanceof StaleDisplayError) {
        return withStaleDisplay(this.createErrorResult(options.action, error.message), error);
      }
      return withStaleDisplay(
        {
          success: false,
          action: options.action,
          error: `Failed to tap clickable element: ${errorMsg}`,
          element: {
            bounds: { left: 0, top: 0, right: 0, bottom: 0 },
          } as Element,
        },
        error,
      );
    }
  }

  private checkTapDeliveryDisplay(
    result: TapAnyElementResult,
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): void {
    // A successful block returns only after the selected tap was delivered.
    if (result.success) {
      this.checkPostActionDisplay(result, assertCurrent, signal);
    } else {
      assertCurrent?.();
    }
  }

  private createSuccessResult(
    action: TapAnyElementOptions["action"],
    target: CapturedTapTarget,
    startTime: number,
    requestCount: number,
    changeCount: number,
  ): TapAnyElementResult {
    return {
      success: true,
      action,
      element: target.element,
      captureId: target.capture.captureId,
      searchUntil: {
        durationMs: Math.max(0, Math.round(this.timer.now() - startTime)),
        requestCount,
        changeCount,
      },
    };
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult {
    return prepareTapAnyHierarchyForResponse(
      { platform: this.device.platform, viewHierarchy: this.viewHierarchy },
      rawHierarchy,
      screenSize,
    );
  }
}
