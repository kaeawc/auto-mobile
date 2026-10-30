import { iosWebScrollIntoView } from "./IosSdkWebScrollIntoView";
import { androidCtrlProxyClientForPlatform } from "../../observe/android/androidCtrlProxyClientFor";
import { SwipeOnAutoTargeting } from "./SwipeOnAutoTargeting";
import { SwipeOnAndroidDisplay, containerFailureOf } from "./SwipeOnAndroidDisplay";
import { freshSwipeHierarchy, withSwipeObservationReadScope } from "./freshSwipeHierarchy";
import {
  pendingWindowResolutionGeneration,
  completeWindowResolutionRead,
} from "../../observe/cache/ObserveCacheRegistry";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../../observe/DeviceHierarchyCapture";
import { hasWrongWindowEvidence } from "../../observe/observationFreshness";
import { DispatchedObservationError } from "../../../models/DispatchedObservationError";
import { SETTLE_BUDGET_MS } from "../observedInteractionProfiles";
import { usesScopedSwipeContainer } from "./swipeSelectorScopes";
import { throwIfAbortedKeepingForwardNote } from "./boomerangReturnLeg";
import { withStaleDisplay, StaleDisplayError } from "../../observe/StaleDisplayError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { throwIfAborted } from "../../../utils/toolUtils";
import { SwipeSearchCancelledError } from "./searchCancellation";
import {
  BaseVisualChange,
  INTERMEDIATE_OBSERVATION_OPTIONS,
  ProgressCallback,
  type DisplayFence,
} from "../BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  SwipeDirection,
  SwipeOnOptions,
  SwipeOnResult,
  ScrollableCandidate,
  ViewHierarchyResult,
  requireAndroidOrIosPlatform,
} from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ScrollableElementsQuery } from "../../../utils/interfaces/ElementTraitQueries";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import { DefaultScrollableElementsQuery } from "../../utility/InteractiveElementQueries";
import { DefaultElementGeometry } from "../../utility/ElementGeometry";
import { DefaultElementParser } from "../../utility/ElementParser";
import { ExecuteGesture, type FencedGestureOptions } from "../ExecuteGesture";
import { logger } from "../../../utils/logger";
import {
  createGlobalPerformanceTracker,
  PerformanceTracker,
  NoOpPerformanceTracker,
} from "../../../utils/PerformanceTracker";
import { buildElementSearchDebugContext } from "../../utility/ElementSearchDebugContext";
import { resolveSwipeDirection } from "./swipeOnUtils";
import { AccessibilityDetector } from "../../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../../ctrlProxy/accessibility/AccessibilityDetector";
import {
  DEFAULT_VISION_CONFIG,
  getVisionEnrichedError,
  type VisionFallbackConfig,
  type VisionAnalyzer,
} from "../../../vision/index";
import {
  TakeScreenshotCapturer,
  type ScreenshotCapturer,
} from "../../navigation/SelectionStateTracker";
import {
  GestureExecutor,
  SwipeOnDependencies,
  SwipeOnResolvedOptions,
  BoomerangConfig,
  VoiceOverSwipeRunner,
  AutoTargetSelectorService,
} from "./types";
import {
  resolveSwipeDuration,
  resolveBoomerangConfig,
  validateSwipeTimingOptions,
} from "./swipeTiming";
import { OverlayDetector } from "./OverlayDetector";
import { AutoTargetSelector } from "./AutoTargetSelector";
import { TalkBackSwipeExecutor } from "./TalkBackSwipeExecutor";
import { SwipeOutcomeIndeterminateError } from "./SwipeOutcomeIndeterminateError";
import { VoiceOverSwipeExecutor } from "./VoiceOverSwipeExecutor";
import { iosGestureFailureError, swipeMayHaveMoved } from "./iosSwipeOutcome";
import { deviceIosSdkBridgeSwipeRunner } from "../IosSdkBridgeSwipeRouter";
import { ScrollUntilVisible } from "./ScrollUntilVisible";
import { isTruthyFlag } from "../../utility/elementProperties";
import { getScreenBounds } from "../../../utils/screenBounds";
import { edgeSwipeCoordinates, validateResolvedEdgeSwipe } from "./edgeSwipe";
import {
  effectiveSwipeInsets,
  iosSwipeStartWarning,
  swipeScreenSize,
  screenSwipeBounds,
} from "./iosChromeInsets";
import { resolveContainerSwipeCoordinates } from "./resolveContainerSwipeCoordinates";
import { explicitDuration, withSwipeOnVelocity } from "./swipeDurationReport";
import { type RenderedObservationReader } from "../TargetDisplayAction";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../accessibility/IosVoiceOverDetector";
import { FeatureFlagService, type FeatureFlagReader } from "../../featureFlags/FeatureFlagService";
import { assertGestureOnLayer, scopeHierarchyForSelector } from "../../observe/hierarchyLayer";
import { assessSwipeNavigation } from "./swipeNavigation";
import { settleSdkRouteAssessment, type SdkRouteSource } from "./sdkRouteSettle";
import { resolveActionCall, type ActionCall } from "../ActionCall";

/** Unknown TalkBack state keeps the raw swipe but reports the default route's warning once. */
/**
 * Refuse a swipe whose start point lies on the other `layer`: the window under the down event
 * receives the whole gesture (issue #9305). Resolution itself is scoped where the target is found.
 */
function assertSwipeStartOnLayer(
  hierarchy: ViewHierarchyResult | undefined,
  layer: SwipeOnOptions["layer"],
  startX: number,
  startY: number,
): void {
  assertGestureOnLayer(
    hierarchy,
    layer,
    [{ x: Math.floor(startX), y: Math.floor(startY) }],
    "swipe",
  );
}

function screenEdgeSwipe(
  options: Pick<SwipeOnOptions, "edgeInset" | "at">,
  edge: NonNullable<SwipeOnOptions["fromEdge"]>,
  bounds: Element["bounds"],
): { startX: number; startY: number; endX: number; endY: number } {
  const { x1, y1, x2, y2 } = edgeSwipeCoordinates({
    edge,
    bounds,
    inset: options.edgeInset,
    at: options.at,
  });
  return { startX: x1, startY: y1, endX: x2, endY: y2 };
}

export class SwipeOn extends BaseVisualChange {
  private readonly skipCallerDisplayFence: boolean;
  private readonly stopAfterIosGestureFailure: boolean;
  private readonly iosLockScreenSwipe?: boolean;
  private readonly iosGestureTimeoutMs?: () => number;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private executeGesture!: GestureExecutor;
  private scrollables!: ScrollableElementsQuery;
  private geometry!: ElementGeometry;
  private accessibilityService!: import("./types").SwipeOnCtrlProxy;
  private accessibilityDetector!: AccessibilityDetector;
  private featureFlags!: FeatureFlagReader;
  private overlayDetector: OverlayDetector;
  private autoTargetSelector: AutoTargetSelectorService;
  private readonly autoTargeting: SwipeOnAutoTargeting;
  private readonly androidDisplay: SwipeOnAndroidDisplay;
  private talkBackExecutor: TalkBackSwipeExecutor;
  private voiceOverExecutor: VoiceOverSwipeRunner;
  private scrollUntilVisible: ScrollUntilVisible;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;
  private readonly sdkRouteSourceOverride: SdkRouteSource | undefined;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: SwipeOnDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.skipCallerDisplayFence = dependencies.skipCallerDisplayFence ?? false;
    this.stopAfterIosGestureFailure = dependencies.stopAfterIosGestureFailure ?? false;
    this.iosLockScreenSwipe = dependencies.iosLockScreenSwipe;
    this.iosGestureTimeoutMs = dependencies.iosGestureTimeoutMs;
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    const parser = this.initializeGestureDependencies(device, adb, dependencies);
    const featureFlags = dependencies.featureFlags ?? FeatureFlagService.getInstance();
    this.featureFlags = featureFlags;
    this.visionConfig = dependencies.visionConfig ?? DEFAULT_VISION_CONFIG;
    this.screenshotCapturer =
      dependencies.screenshotCapturer ?? new TakeScreenshotCapturer(device, this.adbFactory);
    this.visionAnalyzer = dependencies.visionAnalyzer;
    this.sdkRouteSourceOverride = dependencies.sdkRouteSource;
    if (dependencies.observeScreen) {
      this.observeScreen = dependencies.observeScreen;
    }

    // Initialize extracted modules
    this.overlayDetector = new OverlayDetector(this.geometry, parser);
    this.autoTargetSelector = dependencies.autoTargetSelector ?? new AutoTargetSelector();
    this.autoTargeting = new SwipeOnAutoTargeting(device, () => this.autoTargetSelector);
    this.androidDisplay = new SwipeOnAndroidDisplay(() => ({
      device: this.device,
      adb: this.adb,
      timer: this.timer,
      observeScreen: this.observeScreen,
      displayTransitionReader: this.displayTransitionReader,
      accessibilityService: this.accessibilityService,
      accessibilityDetector: this.accessibilityDetector,
      featureFlags: this.featureFlags,
      talkBackExecutor: this.talkBackExecutor,
      scrollUntilVisible: this.scrollUntilVisible,
      scrollables: this.scrollables,
      geometry: this.geometry,
      lastRenderedObservation: this.lastRenderedObservation,
      autoTargeting: this.autoTargeting,
      visual: this,
      getDuration: (options) => this.getDuration(options),
      createErrorResult: (error) => this.createErrorResult(error),
      observedSwipeInteraction: (block, options, diagnostics) =>
        this.observedSwipeInteraction(block, options, diagnostics),
      checkPostActionDisplay: (result, assertCurrent, signal) =>
        this.checkPostActionDisplay(result, assertCurrent, signal),
      rethrowObservationAbort: (error, signal, enabled) =>
        this.rethrowObservationAbort(error, signal, enabled),
      resolveContainerSwipeCoordinates: (options, viewHierarchy, containerElement, observeResult) =>
        this.resolveContainerSwipeCoordinates(
          options,
          viewHierarchy,
          containerElement,
          observeResult,
        ),
    }));
    this.talkBackExecutor = new TalkBackSwipeExecutor({
      device,
      executeGesture: this.executeGesture,
      accessibilityService: this.accessibilityService,
      accessibilityDetector: this.accessibilityDetector,
      adb: this.adb,
      timer: this.timer,
      featureFlags,
    });
    const iosVoiceOverDetector = dependencies.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.voiceOverExecutor =
      dependencies.voiceOverExecutor ??
      deviceIosSdkBridgeSwipeRunner(
        device,
        new VoiceOverSwipeExecutor({
          device,
          executeGesture: this.executeGesture,
          iosClient: IOSCtrlProxyClient.getInstance(device),
          iosVoiceOverDetector,
          timer: this.timer,
          featureFlags,
        }),
      );
    this.scrollUntilVisible = new ScrollUntilVisible({
      device,
      resolver: dependencies.resolver,
      geometry: this.geometry,
      observeScreen: this.observeScreen,
      accessibilityService: this.accessibilityService,
      accessibilityDetector: this.accessibilityDetector,
      adb: this.adb,
      featureFlags,
      overlayDetector: this.overlayDetector,
      talkBackExecutor: this.talkBackExecutor,
      voiceOverExecutor: this.voiceOverExecutor,
      webScrollIntoView: iosWebScrollIntoView(device, dependencies.webScrollIntoView),
      timer: this.timer,
      getDuration: this.getDuration.bind(this),
      resolveBoomerangConfig: this.resolveBoomerangConfig.bind(this),
      buildPredictionArgs: this.buildPredictionArgs.bind(this),
      observedInteraction: this.observedInteraction.bind(this),
      captureDisplayFence: () => this.captureDisplayFence(),
      captureTerminalObservationScreenshot: this.captureTerminalObservationScreenshot.bind(this),
    });
  }

  private initializeGestureDependencies(
    device: BootedDevice,
    adb: AdbExecutor | null,
    dependencies: SwipeOnDependencies,
  ) {
    this.executeGesture = dependencies.executeGesture ?? new ExecuteGesture(device, adb);
    const parser = dependencies.parser ?? new DefaultElementParser();
    this.scrollables = dependencies.scrollables ?? new DefaultScrollableElementsQuery();
    this.geometry = dependencies.geometry ?? new DefaultElementGeometry();
    this.accessibilityService =
      dependencies.accessibilityService ??
      androidCtrlProxyClientForPlatform(device, this.adbFactory);
    this.accessibilityDetector = dependencies.accessibilityDetector || defaultAccessibilityDetector;
    return parser;
  }

  private createErrorResult(
    error: string,
    extras: { warning?: string; scrollableCandidates?: ScrollableCandidate[] } = {},
  ): SwipeOnResult {
    return {
      success: false,
      error,
      warning: extras.warning,
      scrollableCandidates: extras.scrollableCandidates,
      targetType: "screen",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      duration: 0,
    };
  }

  private async getScrollableContext(
    signal?: AbortSignal,
    layer?: SwipeOnOptions["layer"],
  ): Promise<{
    scrollables: Element[];
    candidates: ScrollableCandidate[];
    observeResult?: ObserveResult;
  }> {
    throwIfAborted(signal);
    let observeResult = await this.observeScreen.getMostRecentCachedObserveResult();
    const resolutionGeneration = pendingWindowResolutionGeneration(this.device.deviceId);
    const staleCachedRefetch =
      resolutionGeneration !== undefined ||
      BaseVisualChange.shouldRefetchCachedObservation(observeResult);
    if (
      staleCachedRefetch ||
      !observeResult.viewHierarchy ||
      observeResult.viewHierarchy.hierarchy?.error
    ) {
      throwIfAborted(signal);
      observeResult = await this.observeScreen.execute({
        ...INTERMEDIATE_OBSERVATION_OPTIONS,
        freshness: staleCachedRefetch ? "fresh" : "cached-ok",
        timeoutMs: DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
        skipStaleWindowRecovery: true,
        signal,
      });
    }

    observeResult = await freshSwipeHierarchy(
      observeResult,
      (timeoutMs) =>
        this.observeScreen.execute({
          ...INTERMEDIATE_OBSERVATION_OPTIONS,
          freshness: "fresh",
          timeoutMs,
          skipStaleWindowRecovery: true,
          signal,
        }),
      this.timer,
      signal,
    );

    if (!observeResult.viewHierarchy || observeResult.viewHierarchy.hierarchy?.error) {
      return { scrollables: [], candidates: [], observeResult };
    }

    if (hasWrongWindowEvidence(observeResult)) {
      return { scrollables: [], candidates: [], observeResult };
    }

    if (resolutionGeneration !== undefined) {
      completeWindowResolutionRead(this.device.deviceId, resolutionGeneration);
    }
    const scrollables = this.scrollables.findScrollableElements(
      scopeHierarchyForSelector(observeResult.viewHierarchy, layer),
    );
    const candidates = this.autoTargeting.buildScrollableCandidates(scrollables);
    return { scrollables, candidates, observeResult };
  }

  async execute(options: SwipeOnOptions, call?: ActionCall): Promise<SwipeOnResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    options: SwipeOnOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SwipeOnResult>;
  async execute(
    options: SwipeOnOptions,
    progressOrCall?: ProgressCallback | ActionCall,
    signalArg?: AbortSignal,
  ): Promise<SwipeOnResult> {
    const { progress, signal } = resolveActionCall(progressOrCall, signalArg);
    const result = await withSwipeObservationReadScope(() =>
      this.executeWithReadScope(options, progress, signal),
    );
    return withSwipeOnVelocity(result, options);
  }

  /** Explicit-display routing; existing tests replace it to reach the default route. */
  private executeExplicitDisplay(
    options: SwipeOnOptions,
    context: { progress?: ProgressCallback; signal?: AbortSignal } = {},
  ): Promise<SwipeOnResult | undefined> {
    return this.androidDisplay.executeExplicitDisplay(options, context);
  }

  private async executeWithReadScope(
    options: SwipeOnOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SwipeOnResult> {
    throwIfAborted(signal);
    const targeted = await this.executeExplicitDisplay(options, {
      progress,
      signal,
    });
    if (targeted) {
      return targeted;
    }
    return this.executeLegacy(options, progress, signal);
  }

  private async executeAutoTargetSwipe({
    options,
    progress,
    perf,
    signal,
  }: {
    options: SwipeOnResolvedOptions;
    progress?: ProgressCallback;
    perf: PerformanceTracker;
    signal?: AbortSignal;
  }): Promise<SwipeOnResult> {
    const context = await this.getScrollableContext(signal, options.layer);
    const decision = this.autoTargeting.resolveAutoTargetDecision({
      ...context,
      direction: options.direction,
      includeSystemInsets: options.includeSystemInsets,
    });
    const result =
      decision.element && context.observeResult
        ? await this.executeElementSwipe(options, progress, perf, signal, {
            element: decision.element,
            observation: context.observeResult,
          })
        : decision.container
          ? await this.executeElementSwipe(
              { ...options, container: decision.container },
              progress,
              perf,
              signal,
              context.observeResult ? { observation: context.observeResult } : undefined,
            )
          : await this.executeScreenSwipe(options, progress, perf, signal, {
              within: decision.scrollFrame,
            });
    return this.autoTargeting.withAutoTargetDecision({ result, decision });
  }

  private async executeLegacy(
    options: SwipeOnOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SwipeOnResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("swipeOn");
    const validationError = this.validateOptions(options);
    if (validationError) {
      perf.end();
      return this.createErrorResult(validationError);
    }
    const resolvedDirection = resolveSwipeDirection(options);
    if (resolvedDirection.error) {
      perf.end();
      return this.createErrorResult(resolvedDirection.error);
    }
    const normalizedOptions: SwipeOnResolvedOptions = {
      ...options,
      direction: resolvedDirection.direction as SwipeDirection,
    };
    logger.info(
      `[SwipeOn] execute: direction=${normalizedOptions.direction}, lookFor=${JSON.stringify(normalizedOptions.lookFor)}, container=${JSON.stringify(normalizedOptions.container)}, speed=${normalizedOptions.speed}, autoTarget=${normalizedOptions.autoTarget}`,
    );
    try {
      return await SwipeOn.dispatchLegacySwipe(this, normalizedOptions, progress, perf, signal);
    } catch (error) {
      perf.end();
      if (error instanceof SwipeSearchCancelledError) {
        throw error;
      }
      throwIfAbortedKeepingForwardNote(signal, error);

      logger.warn(`Swipe failed: ${errorMessage(error)}`, error);
      if (error instanceof StaleDisplayError || error instanceof DispatchedObservationError) {
        return withStaleDisplay(this.createErrorResult(error.message), error);
      }

      // Build debug context if debug mode is enabled and we have search criteria
      const debugContext =
        normalizedOptions.lookFor || normalizedOptions.container
          ? await buildElementSearchDebugContext(
              this.device,
              SwipeOn.legacyDebugSearchCriteria(normalizedOptions),
            )
          : undefined;
      throwIfAborted(signal);

      // Apply vision fallback for element-related errors
      const baseErrorMessage = errorMessage(error);
      let errorMsg = `Failed to perform swipeOn: ${baseErrorMessage}`;

      const searchCriteria = SwipeOn.legacyVisionSearchCriteria(this, normalizedOptions);
      if (searchCriteria) {
        throwIfAborted(signal);
        const cachedObserve = await this.observeScreen.getMostRecentCachedObserveResult();
        const viewHierarchy = cachedObserve?.viewHierarchy ?? null;
        errorMsg = await getVisionEnrichedError(
          this.screenshotCapturer,
          viewHierarchy,
          searchCriteria,
          this.visionConfig,
          { baseError: errorMsg, visionAnalyzer: this.visionAnalyzer },
        );
      }

      return SwipeOn.legacyFailureResult({
        action: this,
        normalizedOptions,
        perf,
        errorMsg,
        debugContext,
        cause: error,
      });
    }
  }

  private static legacyDebugSearchCriteria(normalizedOptions: SwipeOnResolvedOptions) {
    return {
      text: normalizedOptions.lookFor?.text,
      resourceId: normalizedOptions.lookFor?.elementId || normalizedOptions.container?.elementId,
      container: normalizedOptions.container,
    };
  }

  private static legacyVisionSearchCriteria(
    action: SwipeOn,
    normalizedOptions: SwipeOnResolvedOptions,
  ) {
    if (action.visionConfig.enabled && (normalizedOptions.lookFor || normalizedOptions.container)) {
      let searchCriteria: import("../../../vision/VisionTypes").ElementSearchCriteria | null = null;
      if (normalizedOptions.lookFor) {
        searchCriteria = {
          text: normalizedOptions.lookFor.text,
          resourceId: normalizedOptions.lookFor.elementId,
          description: "Target element to scroll to",
        };
      } else if (normalizedOptions.container) {
        searchCriteria = {
          text: normalizedOptions.container.text,
          resourceId: normalizedOptions.container.elementId,
          description: "Container element for swiping",
        };
      }

      return searchCriteria;
    }
    return null;
  }

  private static legacyFailureResult({
    action,
    normalizedOptions,
    perf,
    errorMsg,
    debugContext,
    cause,
  }: {
    action: SwipeOn;
    normalizedOptions: SwipeOnResolvedOptions;
    perf: PerformanceTracker;
    errorMsg: string;
    debugContext: Awaited<ReturnType<typeof buildElementSearchDebugContext>>;
    /** The caught error; a typed unconfirmed-outcome marker survives onto the result. */
    cause: unknown;
  }): SwipeOnResult {
    const timing = action.device.platform === "ios" ? perf.getTimings() : null;
    return {
      success: false,
      error: errorMsg,
      ...(cause instanceof SwipeOutcomeIndeterminateError ? { outcomeIndeterminate: true } : {}),
      ...containerFailureOf(cause),
      ...(timing ? { timing } : {}),
      targetType: normalizedOptions.container ? "element" : "screen",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      duration: 0,
      ...(debugContext ? { debug: { elementSearch: debugContext } } : {}),
    };
  }

  private static dispatchLegacySwipe(
    action: SwipeOn,
    normalizedOptions: SwipeOnResolvedOptions,
    progress: ProgressCallback | undefined,
    perf: PerformanceTracker,
    signal: AbortSignal | undefined,
  ): Promise<SwipeOnResult> {
    // Determine which mode to use
    if (normalizedOptions.lookFor) {
      // Scroll-until-visible mode
      logger.info(`[SwipeOn] Mode: scroll-until-visible`);
      return action.scrollUntilVisible.execute(normalizedOptions, { progress, perf, signal });
    } else if (!normalizedOptions.container) {
      const autoTargetEnabled = normalizedOptions.autoTarget !== false;
      if (!autoTargetEnabled) {
        logger.info(`[SwipeOn] Mode: screen swipe (autoTarget disabled)`);
        return action.executeScreenSwipe(normalizedOptions, progress, perf, signal);
      }

      return action.executeAutoTargetSwipe({
        options: normalizedOptions,
        progress,
        perf,
        signal,
      });
    } else {
      // Container specified = swipe within container
      logger.info(
        `[SwipeOn] Mode: element swipe (explicit container=${JSON.stringify(normalizedOptions.container)})`,
      );
      return action.executeElementSwipe(normalizedOptions, progress, perf, signal);
    }
  }

  private validateOptions(options: SwipeOnOptions): string | null {
    // Validate container if specified
    if (options.container) {
      const containerFieldCount = [options.container.elementId, options.container.text].filter(
        Boolean,
      ).length;
      if (containerFieldCount === 0) {
        return "container must specify exactly one of elementId or text";
      }
      if (containerFieldCount > 1) {
        return "container must specify exactly one of elementId or text";
      }
    }

    // If lookFor is specified, validate it
    if (options.lookFor) {
      const lookForFieldCount = [options.lookFor.elementId, options.lookFor.text].filter(
        Boolean,
      ).length;
      if (lookForFieldCount !== 1) {
        return "lookFor must specify exactly one of elementId or text";
      }
    }

    return (
      validateSwipeTimingOptions(options, this.getDuration(options)) ??
      validateResolvedEdgeSwipe(options)
    );
  }

  private buildPredictionArgs(options: SwipeOnOptions): Record<string, unknown> {
    return {
      includeSystemInsets: options.includeSystemInsets,
      container: options.container,
      autoTarget: options.autoTarget,
      direction: options.direction,
      lookFor: options.lookFor,
      speed: options.speed,
      boomerang: options.boomerang,
      apexPause: options.apexPause,
      returnSpeed: options.returnSpeed,
      platform: this.device.platform,
    };
  }

  private async observedSwipeInteraction(
    block: (observation: ObserveResult, fence?: DisplayFence) => Promise<SwipeOnResult>,
    options: Parameters<BaseVisualChange["observedInteraction"]>[1],
    diagnostics: { boomerang?: BoomerangConfig },
  ): Promise<SwipeOnResult> {
    let previous: ObserveResult | null = null;
    let swipeEndedAtMs: number | undefined;
    const sdkRoutes = this.sdkRouteSource();
    const result: SwipeOnResult = await this.observedInteraction(
      async (observation, fence) => {
        previous = observation;
        const swipe = await block(observation, fence);
        swipeEndedAtMs = sdkRoutes ? this.timer.now() : undefined;
        return swipe;
      },
      // A boomerang whose return leg failed has moved the content: observe it on iOS too.
      { ...options, observePartialApplication: true },
    );
    await this.annotateSwipeNavigation(result, previous, swipeEndedAtMs, sdkRoutes);
    if (this.device.platform !== "android") {
      return result;
    }
    result.effect = this.deriveInteractionEffect(previous, result.observation);
    // Boomerangs return to the start, or only focus/announce a container in TalkBack mode.
    if (diagnostics.boomerang) {
      return result;
    }
    if (
      result.success &&
      result.effect?.screenChanged === false &&
      result.effect.basis !== "insufficient observation data"
    ) {
      result.warning = this.autoTargetSelector.mergeWarnings(
        result.warning,
        this.unchangedSwipeWarning(result, previous),
      );
    }
    return result;
  }

  /** The Android SDK route store for this device; iOS has no equivalent here. */
  private sdkRouteSource(): SdkRouteSource | undefined {
    if (this.device.platform !== "android") {
      return undefined;
    }
    return (
      this.sdkRouteSourceOverride ?? {
        receivedAtMs: (packageName) =>
          this.accessibilityService.getSdkScreenIdentityReceivedAtMs(packageName),
        awaitRouteAfter: (packageName, sinceMs, timeoutMs) =>
          this.accessibilityService.awaitSdkScreenIdentityAfter(packageName, sinceMs, timeoutMs),
      }
    );
  }

  /** A swipe that opened a different screen (e.g. acted as a tap on a row) must not read as a scroll. */
  private async annotateSwipeNavigation(
    result: SwipeOnResult,
    previous: ObserveResult | null,
    swipeEndedAtMs: number | undefined,
    sdkRoutes: SdkRouteSource | undefined,
  ): Promise<void> {
    if (!result.success) {
      return;
    }
    const assess = () =>
      assessSwipeNavigation(
        previous,
        result.observation,
        { x: result.x1, y: result.y1 },
        requireAndroidOrIosPlatform(this.device.platform, "swipeOn"),
      );
    const assessment = await settleSdkRouteAssessment(assess(), previous, result.observation, {
      swipeEndedAtMs,
      source: sdkRoutes,
      reassess: assess,
    });
    if (!assessment) {
      return;
    }
    result.navigated = assessment.navigated;
    if (assessment.warning) {
      logger.warn(`[SwipeOn] ${assessment.warning}`);
      result.warning = this.autoTargetSelector.mergeWarnings(result.warning, assessment.warning);
    }
  }

  private unchangedSwipeWarning(result: SwipeOnResult, previous: ObserveResult | null): string {
    const scrollables = previous?.viewHierarchy
      ? this.scrollables.findScrollableElements(previous.viewHierarchy)
      : [];
    const regions =
      result.element && isTruthyFlag(result.element.scrollable)
        ? [result.element, ...scrollables]
        : scrollables;
    if (regions.some((element) => this.geometry.isPointInElement(element, result.x1, result.y1))) {
      return "Swipe did not change the screen; the start point was inside the scrollable, which may already be at the end of the scrollable content.";
    }
    return regions.length > 0
      ? "Swipe did not change the screen; the start point was outside every scrollable region, so the gesture geometry may have prevented scrolling."
      : "Swipe did not change the screen; no scrollable region was found in the hierarchy.";
  }

  private async executeScreenSwipe(
    options: SwipeOnResolvedOptions,
    progress?: ProgressCallback,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    { within }: { within?: Element["bounds"] } = {},
  ): Promise<SwipeOnResult> {
    logger.info(`[SwipeOn] Starting screen swipe: direction=${options.direction}`);
    let iosDispatchTimestamp: number | undefined;
    const boomerang = this.resolveBoomerangConfig(options);

    return this.observedSwipeInteraction(
      async (observeResult: ObserveResult, fence) => {
        throwIfAborted(signal);
        const insetOptions = {
          observation: observeResult,
          platform: requireAndroidOrIosPlatform(this.device.platform, "swipeOn"),
          includeSystemInsets: options.includeSystemInsets,
          includeFloatingBars: !options.fromEdge,
        };
        const screenSize = swipeScreenSize(insetOptions);
        if (!screenSize) {
          throw new ActionableError("Could not determine screen size");
        }
        const screenBounds = getScreenBounds(screenSize, effectiveSwipeInsets(insetOptions));
        const bounds = screenSwipeBounds(screenBounds, within, options.fromEdge);

        const { startX, startY, endX, endY } = options.fromEdge
          ? screenEdgeSwipe(options, options.fromEdge, bounds)
          : this.geometry.getSwipeWithinBounds(options.direction, bounds);
        assertSwipeStartOnLayer(observeResult.viewHierarchy, options.layer, startX, startY);

        const duration = this.getDuration(options);
        const gestureOptions: FencedGestureOptions = {
          displayFence: fence,
          duration,
          scrollMode: options.scrollMode,
          durationExplicit: explicitDuration(options),
          timeoutMs: this.iosGestureTimeoutMs?.(),
          lockScreen: this.iosLockScreenSwipe,
        };
        if (gestureOptions.timeoutMs !== undefined && gestureOptions.timeoutMs <= 0) {
          throw new ActionableError("iOS swipe budget exhausted before gesture dispatch");
        }

        throwIfAborted(signal);
        const swipeResult = await perf.track("executeScreenSwipe", () =>
          this.device.platform === "ios"
            ? this.voiceOverExecutor.executeSwipeGesture({
                x1: Math.floor(startX),
                y1: Math.floor(startY),
                x2: Math.floor(endX),
                y2: Math.floor(endY),
                direction: options.direction,
                containerElement: null,
                gestureOptions,
                perf,
                boomerang,
                signal,
                sdkObservation: options.fromEdge ? undefined : observeResult,
              })
            : this.talkBackExecutor.executeSwipeGesture({
                x1: Math.floor(startX),
                y1: Math.floor(startY),
                x2: Math.floor(endX),
                y2: Math.floor(endY),
                direction: options.direction,
                containerElement: null,
                gestureOptions,
                perf,
                boomerang,
                signal,
              }),
        );
        if (
          this.stopAfterIosGestureFailure &&
          this.device.platform === "ios" &&
          !swipeResult.success
        ) {
          // A timed-out request may still be executing in the Swift runner.
          // Skip observedInteraction's post-swipe reads on this recovery path.
          throw iosGestureFailureError(swipeResult);
        }
        throwIfAborted(signal);
        // An unconfirmed swipe may still have scrolled, so the next read must not be pre-swipe.
        if (this.device.platform === "ios" && swipeMayHaveMoved(swipeResult)) {
          iosDispatchTimestamp = this.timer.now();
          IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
        }

        perf.end();
        return {
          ...swipeResult,
          targetType: "screen" as const,
          warning: iosSwipeStartWarning({
            ...insetOptions,
            startX: Math.floor(startX),
            startY: Math.floor(startY),
          }),
        };
      },
      {
        usesObservationForResolution: false,
        changeExpected: false,
        display: options.display,
        timeoutMs: SETTLE_BUDGET_MS.brief,
        progress,
        perf,
        signal,
        skipCallerDisplayFence: this.skipCallerDisplayFence,
        observationTimestampProvider: () => iosDispatchTimestamp,
        predictionContext: {
          toolName: "swipeOn",
          toolArgs: this.buildPredictionArgs(options),
        },
      },
      { boomerang },
    );
  }

  private async executeElementSwipe(
    options: SwipeOnResolvedOptions,
    progress?: ProgressCallback,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    selected?: { element?: Element; observation: ObserveResult },
  ): Promise<SwipeOnResult> {
    logger.info(
      `[SwipeOn] Starting element swipe: direction=${options.direction}, container=${JSON.stringify(options.container)}`,
    );
    let iosDispatchTimestamp: number | undefined;
    const boomerang = this.resolveBoomerangConfig(options);

    return this.observedSwipeInteraction(
      async (observeResult: ObserveResult, fence) => {
        throwIfAborted(signal);
        observeResult = await freshSwipeHierarchy(
          observeResult,
          (timeoutMs) =>
            this.observeScreen.execute({
              ...INTERMEDIATE_OBSERVATION_OPTIONS,
              freshness: "fresh",
              timeoutMs,
              skipStaleWindowRecovery: true,
              display: options.display,
              signal,
            }),
          this.timer,
          signal,
        );
        const viewHierarchy = observeResult.viewHierarchy;
        if (!viewHierarchy || viewHierarchy.hierarchy.error) {
          throw new ActionableError("Unable to get view hierarchy, cannot swipe on element");
        }

        // Find the container element
        const element =
          (selected?.observation.viewHierarchy === viewHierarchy ? selected.element : undefined) ??
          (await perf.track("findElement", () =>
            this.scrollUntilVisible.findTargetElement(options, viewHierarchy, 0, signal),
          ));
        throwIfAborted(signal);

        const { startX, startY, endX, endY, warning } = this.resolveContainerSwipeCoordinates(
          options,
          viewHierarchy,
          element,
          observeResult,
        );
        assertSwipeStartOnLayer(viewHierarchy, options.layer, startX, startY);

        const duration = this.getDuration(options);
        const gestureOptions: FencedGestureOptions = {
          displayFence: fence,
          duration,
          scrollMode: options.scrollMode,
          durationExplicit: explicitDuration(options),
        };

        throwIfAborted(signal);
        const swipeResult = await perf.track("executeElementSwipe", () =>
          this.device.platform === "ios"
            ? this.voiceOverExecutor.executeSwipeGesture({
                x1: Math.floor(startX),
                y1: Math.floor(startY),
                x2: Math.floor(endX),
                y2: Math.floor(endY),
                direction: options.direction,
                containerElement: element ?? null,
                gestureOptions,
                perf,
                boomerang,
                signal,
                sdkObservation: observeResult,
              })
            : this.talkBackExecutor.executeSwipeGesture({
                x1: Math.floor(startX),
                y1: Math.floor(startY),
                x2: Math.floor(endX),
                y2: Math.floor(endY),
                direction: options.direction,
                containerElement: element,
                gestureOptions,
                perf,
                boomerang,
                signal,
              }),
        );
        throwIfAborted(signal);
        // An unconfirmed swipe may still have scrolled, so the next read must not be pre-swipe.
        if (this.device.platform === "ios" && swipeMayHaveMoved(swipeResult)) {
          iosDispatchTimestamp = this.timer.now();
          IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
        }

        perf.end();
        return {
          ...swipeResult,
          targetType: "element" as const,
          element,
          warning,
        };
      },
      {
        previousObservation: selected?.observation,
        resolvesTargetFromRead: true,
        queryOptions:
          selected || usesScopedSwipeContainer(options.container)
            ? undefined
            : {
                text: options.container?.text,
                elementId: options.container?.elementId,
                containerElementId: undefined, // No nested container restriction
              },
        changeExpected: false,
        display: options.display,
        timeoutMs: SETTLE_BUDGET_MS.brief,
        progress,
        perf,
        signal,
        observationTimestampProvider: () => iosDispatchTimestamp,
        predictionContext: {
          toolName: "swipeOn",
          toolArgs: this.buildPredictionArgs(options),
        },
      },
      { boomerang },
    );
  }

  private resolveContainerSwipeCoordinates(
    options: SwipeOnResolvedOptions,
    viewHierarchy: ViewHierarchyResult,
    containerElement: Element,
    observeResult: ObserveResult,
  ): { startX: number; startY: number; endX: number; endY: number; warning?: string } {
    return resolveContainerSwipeCoordinates({
      geometry: this.geometry,
      overlayDetector: this.overlayDetector,
      options,
      viewHierarchy,
      containerElement,
      observeResult,
      platform: requireAndroidOrIosPlatform(this.device.platform, "swipeOn"),
    });
  }

  private getDuration(options: SwipeOnResolvedOptions): number {
    return resolveSwipeDuration({ ...options, geometry: this.geometry });
  }

  private resolveBoomerangConfig(options: SwipeOnResolvedOptions): BoomerangConfig | undefined {
    return resolveBoomerangConfig(options);
  }
}
