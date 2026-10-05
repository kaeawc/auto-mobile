import { executeAndroidSearchDrag } from "./androidSearchDrag";
import { inputDurationArgument } from "../touchscreenInput";
import { usesScopedSwipeContainer } from "./swipeSelectorScopes";
import {
  withStaleDisplay,
  StaleDisplayError,
  staleDisplayError,
} from "../../../models/StaleDisplayError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { throwIfAborted } from "../../../utils/toolUtils";
import { BaseVisualChange, ProgressCallback, type DisplayFence } from "../BaseVisualChange";
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
} from "../../../models";
import { AdbClient } from "../../../utils/android-cmdline-tools/AdbClient";
import type { ElementFinder } from "../../../utils/interfaces/ElementFinder";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import { DefaultElementFinder } from "../../utility/ElementFinder";
import { DefaultElementGeometry } from "../../utility/ElementGeometry";
import { DefaultElementParser } from "../../utility/ElementParser";
import { ExecuteGesture, type FencedGestureOptions } from "../ExecuteGesture";
import { logger } from "../../../utils/logger";
import {
  createGlobalPerformanceTracker,
  PerformanceTracker,
  NoOpPerformanceTracker,
} from "../../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../../observe/android";
import { buildElementSearchDebugContext } from "../../utility/ElementSearchDebugContext";
import type { ObserveScreen } from "../../observe/interfaces/ObserveScreen";
import { resolveSwipeDirection } from "./swipeOnUtils";
import { AccessibilityDetector } from "../../accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../accessibility/AccessibilityDetector";
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
  getReturnDuration,
  validateSwipeTimingOptions,
} from "./swipeTiming";
import { OverlayDetector } from "./OverlayDetector";
import { AutoTargetSelector } from "./AutoTargetSelector";
import { TalkBackSwipeExecutor } from "./TalkBackSwipeExecutor";
import { VoiceOverSwipeExecutor } from "./VoiceOverSwipeExecutor";
import { ScrollUntilVisible } from "./ScrollUntilVisible";
import { buildContainerFromElement, isTruthyFlag } from "../../utility/elementProperties";
import { getScreenBounds } from "../../../utils/screenBounds";
import {
  effectiveSwipeInsets,
  insetSwipeBounds,
  iosSwipeStartWarning,
  swipeScreenSize,
} from "./iosChromeInsets";
import { resolveContainerSwipeCoordinates } from "./resolveContainerSwipeCoordinates";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "../TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "../touchscreenInput";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../accessibility/IosVoiceOverDetector";
import { FeatureFlagService } from "../../featureFlags/FeatureFlagService";
import { unsupportedDisplayOptionMessage } from "../../observe/SessionDisplayContext";

const DISPLAY_SWIPE_OPTIONS = [
  "lookFor",
  "focusTarget",
  "autoTarget",
  "includeSystemInsets",
  "scrollMode",
] as const;

type AutoTargetDecision = {
  element?: Element;
  container?: SwipeOnOptions["container"];
  warning?: string;
  scrollableCandidates?: ScrollableCandidate[];
};

function unsupportedDisplaySwipeOption({
  options,
  platform,
}: {
  options: SwipeOnOptions;
  platform: BootedDevice["platform"];
}) {
  return DISPLAY_SWIPE_OPTIONS.find(
    (key) => options[key] !== undefined && (platform !== "android" || key === "focusTarget"),
  );
}

function displaySwipeCoordinates(
  options: SwipeOnOptions,
  observation: ObserveResult,
  bounds?: Element["bounds"],
): { x1: number; y1: number; x2: number; y2: number } {
  const rect = bounds ?? {
    left: 0,
    top: 0,
    right: observation.screenSize.width,
    bottom: observation.screenSize.height,
  };
  const centerX = Math.round((rect.left + rect.right) / 2);
  const centerY = Math.round((rect.top + rect.bottom) / 2);
  const dx = Math.round((rect.right - rect.left) * 0.6) / 2;
  const dy = Math.round((rect.bottom - rect.top) * 0.6) / 2;
  switch (options.direction) {
    case "left":
      return { x1: centerX + dx, y1: centerY, x2: centerX - dx, y2: centerY };
    case "right":
      return { x1: centerX - dx, y1: centerY, x2: centerX + dx, y2: centerY };
    case "up":
      return { x1: centerX, y1: centerY + dy, x2: centerX, y2: centerY - dy };
    default:
      return { x1: centerX, y1: centerY - dy, x2: centerX, y2: centerY + dy };
  }
}

export class SwipeOn extends BaseVisualChange {
  private readonly skipCallerDisplayFence: boolean;
  private readonly stopAfterIosGestureFailure: boolean;
  private readonly iosLockScreenSwipe?: boolean;
  private readonly iosGestureTimeoutMs?: () => number;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private executeGesture: GestureExecutor;
  private finder: ElementFinder;
  private geometry: ElementGeometry;
  private accessibilityService: AndroidCtrlProxyClient;
  private accessibilityDetector: AccessibilityDetector;
  private overlayDetector: OverlayDetector;
  private autoTargetSelector: AutoTargetSelectorService;
  private talkBackExecutor: TalkBackSwipeExecutor;
  private voiceOverExecutor: VoiceOverSwipeRunner;
  private scrollUntilVisible: ScrollUntilVisible;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    dependencies: SwipeOnDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.skipCallerDisplayFence = dependencies.skipCallerDisplayFence ?? false;
    this.stopAfterIosGestureFailure = dependencies.stopAfterIosGestureFailure ?? false;
    this.iosLockScreenSwipe = dependencies.iosLockScreenSwipe;
    this.iosGestureTimeoutMs = dependencies.iosGestureTimeoutMs;
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.executeGesture = dependencies.executeGesture ?? new ExecuteGesture(device, adb);
    const parser = dependencies.parser ?? new DefaultElementParser();
    this.finder = dependencies.finder ?? new DefaultElementFinder();
    this.geometry = dependencies.geometry ?? new DefaultElementGeometry();
    this.accessibilityService = AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.accessibilityDetector = dependencies.accessibilityDetector || defaultAccessibilityDetector;
    const featureFlags = dependencies.featureFlags ?? FeatureFlagService.getInstance();
    this.visionConfig = dependencies.visionConfig ?? DEFAULT_VISION_CONFIG;
    this.screenshotCapturer =
      dependencies.screenshotCapturer ?? new TakeScreenshotCapturer(device, this.adbFactory);
    this.visionAnalyzer = dependencies.visionAnalyzer;
    if (dependencies.observeScreen) {
      this.observeScreen = dependencies.observeScreen;
    }

    // Initialize extracted modules
    this.overlayDetector = new OverlayDetector(this.finder, this.geometry, parser);
    this.autoTargetSelector = dependencies.autoTargetSelector ?? new AutoTargetSelector();
    this.talkBackExecutor = new TalkBackSwipeExecutor(
      device,
      this.executeGesture,
      this.accessibilityService,
      this.accessibilityDetector,
      this.adb,
      this.timer,
      featureFlags,
    );
    const iosVoiceOverDetector = dependencies.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.voiceOverExecutor =
      dependencies.voiceOverExecutor ??
      new VoiceOverSwipeExecutor(
        device,
        this.executeGesture,
        IOSCtrlProxyClient.getInstance(device),
        iosVoiceOverDetector,
        this.timer,
        featureFlags,
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
      timer: this.timer,
      getDuration: this.getDuration.bind(this),
      resolveBoomerangConfig: this.resolveBoomerangConfig.bind(this),
      buildPredictionArgs: this.buildPredictionArgs.bind(this),
      observedInteraction: this.observedInteraction.bind(this),
      captureDisplayFence: () => this.captureDisplayFence(),
      captureTerminalObservationScreenshot: this.captureTerminalObservationScreenshot.bind(this),
    });
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

  private async getScrollableContext(signal?: AbortSignal): Promise<{
    scrollables: Element[];
    candidates: ScrollableCandidate[];
    observeResult?: ObserveResult;
  }> {
    throwIfAborted(signal);
    let observeResult = await this.observeScreen.getMostRecentCachedObserveResult();
    const staleCachedRefetch = BaseVisualChange.shouldRefetchCachedObservation(observeResult);
    if (
      staleCachedRefetch ||
      !observeResult.viewHierarchy ||
      observeResult.viewHierarchy.hierarchy?.error
    ) {
      throwIfAborted(signal);
      observeResult = await this.observeScreen.execute({
        freshness: staleCachedRefetch ? "fresh" : "cached-ok",
        signal,
      });
    }

    if (
      !observeResult.viewHierarchy ||
      (staleCachedRefetch && observeResult.viewHierarchy.hierarchy?.error)
    ) {
      return { scrollables: [], candidates: [], observeResult };
    }

    const scrollables = this.finder.findScrollableElements(observeResult.viewHierarchy);
    const candidates = this.buildScrollableCandidates(scrollables);
    return { scrollables, candidates, observeResult };
  }

  private buildScrollableCandidates(scrollables: Element[]): ScrollableCandidate[] {
    const candidates: ScrollableCandidate[] = [];
    const seen = new Set<string>();

    for (const scrollable of scrollables) {
      const candidate: ScrollableCandidate = {
        elementId: scrollable["resource-id"],
        text: scrollable.text,
        contentDesc: scrollable["content-desc"],
        className: scrollable.class,
      };

      if (
        !candidate.elementId &&
        !candidate.text &&
        !candidate.contentDesc &&
        !candidate.className
      ) {
        continue;
      }

      const key = `${candidate.elementId ?? ""}|${candidate.text ?? ""}|${candidate.contentDesc ?? ""}|${candidate.className ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push(candidate);
    }

    return candidates;
  }

  private async executeOnAndroidDisplay({
    options: requestedOptions,
    target,
    signal,
  }: {
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
  }): Promise<SwipeOnResult> {
    const observation = this.validateSelectedDisplayObservation({
      observation: target.observation,
      target,
      includeSystemInsets: requestedOptions.includeSystemInsets,
    });
    const { options, decision } = this.selectedDisplayAutoTarget({
      options: requestedOptions,
      observation,
    });
    const { x1, y1, x2, y2, targetType, warning } = this.resolveDisplaySwipeCoordinates({
      options,
      decision,
      observation,
    });
    const duration = resolveSwipeDuration({ ...options, geometry: this.geometry });
    const useCtrlProxy = await this.resolveDisplaySwipeRoute({ options, target });
    await this.dispatchDisplaySwipeLeg({ x1, y1, x2, y2, duration, target, useCtrlProxy, signal });
    const boomerang = resolveBoomerangConfig(options);
    let totalDuration = duration;
    if (boomerang) {
      if (boomerang.apexPauseMs > 0) {
        await this.timer.sleep(boomerang.apexPauseMs);
      }
      target.assertCurrent();
      throwIfAborted(signal);
      const returnDuration = getReturnDuration({
        forwardDuration: duration,
        returnSpeed: boomerang.returnSpeed,
      });
      await this.dispatchDisplaySwipeLeg({
        x1: x2,
        y1: y2,
        x2: x1,
        y2: y1,
        duration: returnDuration,
        target,
        useCtrlProxy,
        signal,
      });
      totalDuration += boomerang.apexPauseMs + returnDuration;
    }
    return this.withAutoTargetDecision({
      result: {
        success: true,
        targetType,
        x1,
        y1,
        x2,
        y2,
        duration: totalDuration,
        warning,
      },
      decision,
    });
  }

  private resolveDisplaySwipeCoordinates({
    options,
    decision,
    observation,
  }: {
    options: SwipeOnOptions;
    decision: AutoTargetDecision;
    observation: ObserveResult;
  }): Pick<SwipeOnResult, "x1" | "y1" | "x2" | "y2" | "targetType" | "warning"> {
    if (decision.element && observation.viewHierarchy) {
      const coordinates = this.resolveContainerSwipeCoordinates(
        { ...options, direction: options.direction! },
        observation.viewHierarchy,
        decision.element,
        observation,
      );
      return {
        x1: coordinates.startX,
        y1: coordinates.startY,
        x2: coordinates.endX,
        y2: coordinates.endY,
        targetType: "element",
        warning: coordinates.warning,
      };
    }
    const bounds = this.selectedDisplayContainerBounds(options, observation);
    if (options.container && !bounds) {
      throw new ActionableError("Swipe container not found on selected display");
    }
    return {
      ...displaySwipeCoordinates(
        options,
        observation,
        this.resolveDisplaySwipeBounds(options, observation, bounds),
      ),
      targetType: bounds ? "element" : "screen",
    };
  }

  private resolveDisplaySwipeBounds(
    options: SwipeOnOptions,
    observation: ObserveResult,
    bounds?: Element["bounds"],
  ): Element["bounds"] | undefined {
    // Preserve explicit display-container geometry; automatic screen fallback
    // uses available per-display insets unless the caller opts into system bars.
    return options.includeSystemInsets === false ||
      (options.autoTarget === true && !bounds && options.includeSystemInsets !== true)
      ? this.insetDisplaySwipeBounds({ observation, bounds })
      : bounds;
  }

  private selectedDisplayAutoTarget({
    options,
    observation,
  }: {
    options: SwipeOnOptions;
    observation: ObserveResult;
  }): { options: SwipeOnOptions; decision: AutoTargetDecision } {
    if (options.autoTarget !== true || options.container) {
      return { options, decision: {} };
    }
    const direction = resolveSwipeDirection(options);
    if (!direction.direction) {
      throw new ActionableError(direction.error ?? "direction is required");
    }
    const scrollables = observation.viewHierarchy
      ? this.finder.findScrollableElements(observation.viewHierarchy)
      : [];
    const decision = this.resolveAutoTargetDecision({
      scrollables,
      candidates: this.buildScrollableCandidates(scrollables),
      observeResult: observation,
      direction: direction.direction,
      includeSystemInsets: options.includeSystemInsets,
    });
    return {
      options: { ...options, direction: direction.direction, container: decision.container },
      decision,
    };
  }

  private async resolveDisplaySwipeRoute({
    options,
    target,
  }: {
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
  }): Promise<boolean> {
    if (options.scrollMode === "adb") {
      return false;
    }
    const supported = await supportsCtrlProxyGestureDisplay(
      this.accessibilityService,
      target.displayId,
    );
    if (options.scrollMode === "a11y" && !supported) {
      throw new ActionableError(
        `scrollMode "a11y" requires CtrlProxy capability gesture_display_id_v1 for display "${target.observation.display.key}". Update CtrlProxy or use scrollMode "adb".`,
      );
    }
    return supported;
  }

  private insetDisplaySwipeBounds({
    observation,
    bounds,
  }: {
    observation: ObserveResult;
    bounds?: Element["bounds"];
  }): Element["bounds"] {
    const insetOptions = { observation, platform: this.device.platform };
    const screenSize = swipeScreenSize(insetOptions) ?? observation.screenSize;
    return insetSwipeBounds({ ...insetOptions, bounds: bounds ?? getScreenBounds(screenSize) });
  }

  private validateSelectedDisplayObservation(options: {
    observation: ObserveResult;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    includeSystemInsets?: boolean;
  }): ObserveResult {
    const { observation, target, includeSystemInsets } = options;
    target.assertCurrent();
    if (observation.display.key !== target.observation.display.key) {
      throw staleDisplayError(
        target.observation.display.generation,
        this.displayTransitionReader.identityRevision(this.device.deviceId),
        this.displayTransitionReader.currentObservedPanel(this.device.deviceId)?.key,
      );
    }
    if (includeSystemInsets !== undefined && observation.insets?.available !== true) {
      throw new ActionableError(
        `includeSystemInsets is not supported with \`display\` for display "${target.observation.display.key}": per-display system insets are unavailable`,
      );
    }
    // Unavailable metadata can contain default-display or compatibility values.
    return observation.insets?.available === true
      ? observation
      : { ...observation, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
  }

  private async searchOnAndroidDisplay({
    options,
    target,
    progress,
    signal,
  }: {
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    progress?: ProgressCallback;
    signal?: AbortSignal;
  }): Promise<SwipeOnResult> {
    const direction = resolveSwipeDirection(options);
    if (direction.error) {
      throw new ActionableError(direction.error);
    }
    let useCtrlProxy = false;
    if (options.scrollMode !== "adb") {
      try {
        useCtrlProxy = await supportsCtrlProxyGestureDisplay(
          this.accessibilityService,
          target.displayId,
        );
      } catch (error) {
        throwIfAborted(signal);
        // The optional display capability probe sends no gesture, so ADB remains safe.
        logger.debug("[SwipeOn] CtrlProxy display gesture capability unavailable", error);
      }
    }
    const display = target.observation.display.key;
    const validateObservation = (observation: ObserveResult) =>
      this.validateSelectedDisplayObservation({
        observation,
        target,
        includeSystemInsets: options.includeSystemInsets,
      });
    // Forward optional finalization/cache seams while checking every capture,
    // including BaseVisualChange's retries and settle polls.
    const postActionObserveScreen: ObserveScreen = {
      execute: async (captureOptions) => {
        target.assertCurrent();
        return validateObservation(await this.observeScreen.execute(captureOptions));
      },
      getMostRecentCachedObserveResult: this.observeScreen.getMostRecentCachedObserveResult.bind(
        this.observeScreen,
      ),
      appendRawViewHierarchy: this.observeScreen.appendRawViewHierarchy.bind(this.observeScreen),
      captureScreenshot: this.observeScreen.captureScreenshot?.bind(this.observeScreen),
      runAccessibilityAudit: this.observeScreen.runAccessibilityAudit?.bind(this.observeScreen),
      processRecomposition: this.observeScreen.processRecomposition?.bind(this.observeScreen),
      captureCacheGeneration: this.observeScreen.captureCacheGeneration?.bind(this.observeScreen),
      cacheObserveResult: this.observeScreen.cacheObserveResult?.bind(this.observeScreen),
    };
    const result = await this.scrollUntilVisible.executeWithStrategy({
      options: { ...options, direction: direction.direction as SwipeDirection },
      progress,
      signal,
      strategy: {
        observe: async () => {
          target.assertCurrent();
          return validateObservation(
            await this.observeScreen.execute({
              display,
              freshness: "cached-ok",
              skipScreenshot: true,
              skipAccessibilityAudit: true,
              signal,
            }),
          );
        },
        swipe: async ({ previousObservation, ...coordinates }) => {
          const result = await this.observedInteraction(
            async () => {
              const fallback = async () => {
                coordinates.onSearchFallback?.();
                await this.dispatchDisplaySwipeLeg({
                  ...coordinates,
                  target,
                  useCtrlProxy: false,
                  signal,
                });
                return { ...coordinates, success: true };
              };
              return useCtrlProxy
                ? executeAndroidSearchDrag({
                    ...coordinates,
                    client: this.accessibilityService,
                    signal,
                    displayId: target.displayId === 0 ? undefined : target.displayId,
                    beforeSend: target.assertCurrent,
                    fallback,
                  })
                : fallback();
            },
            {
              changeExpected: false,
              timeoutMs: 500,
              display,
              previousObservation,
              progress,
              signal,
              deferPostActionScreenshot: true,
              postActionObserveScreen,
            },
          );
          return {
            ...coordinates,
            targetType: "screen",
            success: result.success,
            error: result.error,
            outcomeIndeterminate: result.outcomeIndeterminate,
            observation: validateObservation(result.observation),
          };
        },
      },
    });
    target.assertCurrent();
    return result;
  }

  private async dispatchDisplaySwipeLeg(options: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    useCtrlProxy: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { x1, y1, x2, y2, duration, target, useCtrlProxy, signal } = options;
    target.assertCurrent();
    throwIfAborted(signal);
    if (useCtrlProxy) {
      const result = await this.accessibilityService.requestSwipe(
        x1,
        y1,
        x2,
        y2,
        duration,
        undefined,
        undefined,
        undefined,
        undefined,
        signal,
        target.displayId === 0 ? undefined : target.displayId,
        target.assertCurrent,
      );
      throwIfAborted(signal);
      if (!result.success) {
        throw new ActionableError(result.error ?? "Android swipe failed");
      }
    } else {
      await executeTouchscreenInput(
        this.adb,
        `swipe ${x1} ${y1} ${x2} ${y2} ${inputDurationArgument(duration)}`,
        target.displayId,
        signal,
        target.assertCurrent,
      );
    }
  }

  private selectedDisplayContainerBounds(
    options: SwipeOnOptions,
    observation: ObserveResult,
  ): Element["bounds"] | undefined {
    if (!options.container || !observation.viewHierarchy) {
      return undefined;
    }
    if (usesScopedSwipeContainer(options.container)) {
      return this.scrollUntilVisible.resolveSwipeContainer(
        observation.viewHierarchy,
        options.container,
      ).bounds;
    }
    return this.scrollUntilVisible.resolveElement(
      observation.viewHierarchy,
      options.container,
      "inspect",
      options.container.text !== undefined,
    )?.bounds;
  }

  private async executeExplicitDisplay(
    options: SwipeOnOptions,
    context: { progress?: ProgressCallback; signal?: AbortSignal } = {},
  ): Promise<SwipeOnResult | undefined> {
    const { progress, signal } = context;
    if (options.display !== undefined) {
      try {
        const unsupported = unsupportedDisplaySwipeOption({
          options,
          platform: this.device.platform,
        });
        if (unsupported) {
          throw new ActionableError(unsupportedDisplayOptionMessage(unsupported));
        }
        const validationError = validateSwipeTimingOptions(options, this.getDuration(options));
        if (validationError) {
          throw new ActionableError(validationError);
        }
        const target = await prepareTargetDisplayAction(
          this.device,
          options.display,
          this.observeScreen,
          this.adb,
          this.lastRenderedObservation,
          signal,
          this.displayTransitionReader,
        );
        throwIfAborted(signal);
        if (this.device.platform === "android") {
          this.validateSelectedDisplayObservation({
            observation: target.observation,
            target,
            includeSystemInsets: options.includeSystemInsets,
          });
          return options.lookFor
            ? await this.searchOnAndroidDisplay({ options, target, progress, signal })
            : await this.observedSwipeInteraction(
                () => this.executeOnAndroidDisplay({ options, target, signal }),
                {
                  changeExpected: false,
                  display: target.observation.display.key,
                  previousObservation: target.observation,
                  signal,
                },
                { boomerang: resolveBoomerangConfig(options) },
              );
        }
      } catch (error) {
        throwIfAborted(signal);
        logger.warn(`swipeOn display routing failed: ${errorMessage(error)}`, error);
        return withStaleDisplay(this.createErrorResult(errorMessage(error)), error);
      }
    }
    return undefined;
  }

  async execute(
    options: SwipeOnOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SwipeOnResult> {
    throwIfAborted(signal);
    const targeted = await this.executeExplicitDisplay(options, { progress, signal });
    if (targeted) {
      return targeted;
    }
    return this.executeLegacy(options, progress, signal);
  }

  private resolveAutoTargetDecision({
    scrollables,
    candidates,
    observeResult,
    direction,
    includeSystemInsets,
  }: {
    scrollables: Element[];
    candidates: ScrollableCandidate[];
    observeResult?: ObserveResult;
    direction: SwipeDirection;
    includeSystemInsets?: boolean;
  }): AutoTargetDecision {
    if (scrollables.length === 0) {
      logger.info(`[SwipeOn] Mode: screen swipe (no scrollables found)`);
      return {};
    }
    const screenBounds = observeResult
      ? this.autoTargetSelector.getScreenBounds(observeResult, {
          platform: this.device.platform,
          includeSystemInsets,
        })
      : null;
    const element = this.autoTargetSelector.selectAutoTargetScrollable(
      scrollables,
      screenBounds,
      direction,
    );
    if (!element) {
      logger.info(
        `[SwipeOn] Mode: screen swipe (scrollables found but none matched direction=${direction})`,
      );
      return {
        warning:
          "Scrollable containers found but none matched the swipe direction; swiping the screen. Set autoTarget: false to force screen swipes.",
        scrollableCandidates: candidates,
      };
    }
    const container = buildContainerFromElement(element);
    if (!container && this.device.platform === "android") {
      logger.info(`[SwipeOn] Mode: element swipe (auto-target element has no usable identifier)`);
      return {
        element,
        warning:
          "Auto-targeted scrollable container lacks a usable identifier; swiping within its bounds without container metadata.",
        scrollableCandidates: candidates,
      };
    }
    if (!container) {
      logger.info(`[SwipeOn] Mode: screen swipe (auto-target element has no usable identifier)`);
      return {
        warning:
          "Auto-targeted scrollable container lacks a usable identifier; swiping the screen. Provide container.elementId or container.text to target it explicitly.",
        scrollableCandidates: candidates,
      };
    }
    logger.info(
      `[SwipeOn] Mode: auto-target element swipe (container=${JSON.stringify(container)})`,
    );
    return {
      container,
      warning: `Auto-targeted scrollable container (${this.autoTargetSelector.describeContainer(container)}). Set autoTarget: false to force full-screen swipes.`,
      scrollableCandidates: candidates,
    };
  }

  private withAutoTargetDecision({
    result,
    decision,
  }: {
    result: SwipeOnResult;
    decision: AutoTargetDecision;
  }): SwipeOnResult {
    if (!decision.warning) {
      return result;
    }
    return {
      ...result,
      warning: this.autoTargetSelector.mergeWarnings(result.warning, decision.warning),
      scrollableCandidates: decision.scrollableCandidates,
    };
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
    const context = await this.getScrollableContext(signal);
    const decision = this.resolveAutoTargetDecision({
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
            )
          : await this.executeScreenSwipe(options, progress, perf, signal);
    return this.withAutoTargetDecision({ result, decision });
  }

  // oxlint-disable-next-line max-lines-per-function -- Keep the existing dispatch branches together while threading cancellation.
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
      // Determine which mode to use
      if (normalizedOptions.lookFor) {
        // Scroll-until-visible mode
        logger.info(`[SwipeOn] Mode: scroll-until-visible`);
        return await this.scrollUntilVisible.execute(normalizedOptions, progress, perf, signal);
      } else if (!normalizedOptions.container) {
        const autoTargetEnabled = normalizedOptions.autoTarget !== false;
        if (!autoTargetEnabled) {
          logger.info(`[SwipeOn] Mode: screen swipe (autoTarget disabled)`);
          return await this.executeScreenSwipe(normalizedOptions, progress, perf, signal);
        }

        return await this.executeAutoTargetSwipe({
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
        return await this.executeElementSwipe(normalizedOptions, progress, perf, signal);
      }
    } catch (error) {
      perf.end();
      throwIfAborted(signal);

      logger.warn(`Swipe failed: ${errorMessage(error)}`, error);
      if (error instanceof StaleDisplayError) {
        return withStaleDisplay(this.createErrorResult(error.message), error);
      }

      // Build debug context if debug mode is enabled and we have search criteria
      const debugContext =
        normalizedOptions.lookFor || normalizedOptions.container
          ? await buildElementSearchDebugContext(this.device, {
              text: normalizedOptions.lookFor?.text,
              resourceId:
                normalizedOptions.lookFor?.elementId || normalizedOptions.container?.elementId,
              container: normalizedOptions.container,
            })
          : undefined;
      throwIfAborted(signal);

      // Apply vision fallback for element-related errors
      const baseErrorMessage = errorMessage(error);
      let errorMsg = `Failed to perform swipeOn: ${baseErrorMessage}`;

      if (this.visionConfig.enabled && (normalizedOptions.lookFor || normalizedOptions.container)) {
        let searchCriteria: import("../../../vision/VisionTypes").ElementSearchCriteria | null =
          null;
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

        if (searchCriteria) {
          throwIfAborted(signal);
          const cachedObserve = await this.observeScreen.getMostRecentCachedObserveResult();
          const viewHierarchy = cachedObserve?.viewHierarchy ?? null;
          errorMsg = await getVisionEnrichedError(
            this.screenshotCapturer,
            viewHierarchy,
            searchCriteria,
            this.visionConfig,
            errorMsg,
            undefined,
            this.visionAnalyzer,
          );
        }
      }

      const timing = this.device.platform === "ios" ? perf.getTimings() : null;
      return {
        success: false,
        error: errorMsg,
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

    return validateSwipeTimingOptions(options, this.getDuration(options));
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
    const result: SwipeOnResult = await this.observedInteraction(async (observation, fence) => {
      previous = observation;
      return block(observation, fence);
    }, options);
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

  private unchangedSwipeWarning(result: SwipeOnResult, previous: ObserveResult | null): string {
    const scrollables = previous?.viewHierarchy
      ? this.finder.findScrollableElements(previous.viewHierarchy)
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
  ): Promise<SwipeOnResult> {
    logger.info(`[SwipeOn] Starting screen swipe: direction=${options.direction}`);
    let iosDispatchTimestamp: number | undefined;
    const boomerang = this.resolveBoomerangConfig(options);

    return this.observedSwipeInteraction(
      async (observeResult: ObserveResult, fence) => {
        throwIfAborted(signal);
        const insetOptions = {
          observation: observeResult,
          platform: this.device.platform,
          includeSystemInsets: options.includeSystemInsets,
        };
        const screenSize = swipeScreenSize(insetOptions);
        if (!screenSize) {
          throw new ActionableError("Could not determine screen size");
        }
        const bounds = getScreenBounds(screenSize, effectiveSwipeInsets(insetOptions));

        const { startX, startY, endX, endY } = this.geometry.getSwipeWithinBounds(
          options.direction,
          bounds,
        );

        const duration = this.getDuration(options);
        const gestureOptions: FencedGestureOptions = {
          displayFence: fence,
          duration,
          scrollMode: options.scrollMode,
          timeoutMs: this.iosGestureTimeoutMs?.(),
          lockScreen: this.iosLockScreenSwipe,
        };
        if (gestureOptions.timeoutMs !== undefined && gestureOptions.timeoutMs <= 0) {
          throw new ActionableError("iOS swipe budget exhausted before gesture dispatch");
        }

        throwIfAborted(signal);
        const swipeResult = await perf.track("executeScreenSwipe", () =>
          this.device.platform === "ios"
            ? this.voiceOverExecutor.executeSwipeGesture(
                Math.floor(startX),
                Math.floor(startY),
                Math.floor(endX),
                Math.floor(endY),
                options.direction,
                null, // No container for screen swipe
                gestureOptions,
                perf,
                boomerang,
                signal,
              )
            : this.talkBackExecutor.executeSwipeGesture(
                Math.floor(startX),
                Math.floor(startY),
                Math.floor(endX),
                Math.floor(endY),
                options.direction,
                null, // No container for screen swipe
                gestureOptions,
                perf,
                boomerang,
                signal,
              ),
        );
        if (
          this.stopAfterIosGestureFailure &&
          this.device.platform === "ios" &&
          !swipeResult.success
        ) {
          // A timed-out request may still be executing in the Swift runner.
          // Skip observedInteraction's post-swipe reads on this recovery path.
          throw new ActionableError(swipeResult.error ?? "iOS lock-screen swipe failed");
        }
        throwIfAborted(signal);
        if (this.device.platform === "ios" && swipeResult.success) {
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
        changeExpected: false,
        display: options.display,
        timeoutMs: 500,
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
    selected?: { element: Element; observation: ObserveResult },
  ): Promise<SwipeOnResult> {
    logger.info(
      `[SwipeOn] Starting element swipe: direction=${options.direction}, container=${JSON.stringify(options.container)}`,
    );
    let iosDispatchTimestamp: number | undefined;
    const boomerang = this.resolveBoomerangConfig(options);

    return this.observedSwipeInteraction(
      async (observeResult: ObserveResult, fence) => {
        throwIfAborted(signal);
        const viewHierarchy = observeResult.viewHierarchy;
        if (!viewHierarchy) {
          throw new ActionableError("Unable to get view hierarchy, cannot swipe on element");
        }

        // Find the container element
        const element =
          selected?.element ??
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

        const duration = this.getDuration(options);
        const gestureOptions: FencedGestureOptions = {
          displayFence: fence,
          duration,
          scrollMode: options.scrollMode,
        };

        throwIfAborted(signal);
        const swipeResult = await perf.track("executeElementSwipe", () =>
          this.device.platform === "ios"
            ? this.voiceOverExecutor.executeSwipeGesture(
                Math.floor(startX),
                Math.floor(startY),
                Math.floor(endX),
                Math.floor(endY),
                options.direction,
                element ?? null, // Use the container element
                gestureOptions,
                perf,
                boomerang,
                signal,
              )
            : this.talkBackExecutor.executeSwipeGesture(
                Math.floor(startX),
                Math.floor(startY),
                Math.floor(endX),
                Math.floor(endY),
                options.direction,
                element, // Use the container element
                gestureOptions,
                perf,
                boomerang,
                signal,
              ),
        );
        throwIfAborted(signal);
        if (this.device.platform === "ios" && swipeResult.success) {
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
        timeoutMs: 500,
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
      platform: this.device.platform,
    });
  }

  private getDuration(options: SwipeOnResolvedOptions): number {
    return resolveSwipeDuration({ ...options, geometry: this.geometry });
  }

  private resolveBoomerangConfig(options: SwipeOnResolvedOptions): BoomerangConfig | undefined {
    return resolveBoomerangConfig(options);
  }
}
