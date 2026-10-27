import type { SwipeOnCtrlProxy } from "./types";
import { freshSwipeHierarchy } from "./freshSwipeHierarchy";
import { executeAndroidSearchDrag, type AndroidSearchDragState } from "./androidSearchDrag";
import { DispatchedObservationError } from "../../../models/DispatchedObservationError";
import { SETTLE_BUDGET_MS } from "../observedInteractionProfiles";
import { inputDurationArgument } from "../touchscreenInput";
import { usesScopedSwipeContainer } from "./swipeSelectorScopes";
import { runBoomerangReturnLeg, throwIfAbortedKeepingForwardNote } from "./boomerangReturnLeg";
import { isDeviceLostError } from "../../../models/DeviceLostError";
import {
  withStaleDisplay,
  StaleDisplayError,
  staleDisplayError,
} from "../../observe/StaleDisplayError";
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
  SwipeResult,
  ViewHierarchyResult,
} from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ScrollableElementsQuery } from "../../../utils/interfaces/ElementTraitQueries";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import { logger } from "../../../utils/logger";
import type { ObserveScreen } from "../../observe/interfaces/ObserveScreen";
import { resolveSwipeDirection } from "./swipeOnUtils";
import {
  AccessibilityDetector,
  TALKBACK_STATE_UNKNOWN_WARNING,
} from "../../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { talkBackDisplayRefusal } from "../../talkback/talkBackDisplayRefusal";
import { SwipeOnResolvedOptions, BoomerangConfig } from "./types";
import {
  resolveSwipeDuration,
  resolveBoomerangConfig,
  getReturnDuration,
  validateSwipeTimingOptions,
} from "./swipeTiming";
import { TalkBackSwipeExecutor } from "./TalkBackSwipeExecutor";
import { ScrollUntilVisible, type ScrollUntilVisibleStrategy } from "./ScrollUntilVisible";
import { getScreenBounds } from "../../../utils/screenBounds";
import { edgeSwipeCoordinates, validateResolvedEdgeSwipe } from "./edgeSwipe";
import { insetSwipeBounds, swipeScreenSize } from "./iosChromeInsets";
import { explicitDuration } from "./swipeDurationReport";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "../TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "../touchscreenInput";
import { type FeatureFlagReader } from "../../featureFlags/FeatureFlagService";
import { unsupportedDisplayOptionMessage } from "../../observe/SessionDisplayContext";
import type { AutoTargetDecision, SwipeOnAutoTargeting } from "./SwipeOnAutoTargeting";
import type { DisplayTransitionReader } from "../../observe/DisplayTransition";
import type { BaseActionResult } from "../../../models/BaseActionResult";
import type { Timer } from "../../../utils/SystemTimer";

/**
 * SwipeOnAndroidDisplay - explicit-display (`display`) swipes on Android.
 *
 * Extracted from SwipeOn (max-class-lines): display validation, TalkBack handling, the single
 * swipe, boomerang return leg and the lookFor search on a selected display. Reads SwipeOn's
 * collaborators through a {@link SwipeOnDisplayContext} provider so they stay shared and lazy.
 */
export interface SwipeOnDisplayContext {
  device: BootedDevice;
  adb: AdbExecutor;
  timer: Timer;
  observeScreen: ObserveScreen;
  displayTransitionReader: DisplayTransitionReader;
  accessibilityService: SwipeOnCtrlProxy;
  accessibilityDetector: AccessibilityDetector;
  featureFlags: FeatureFlagReader;
  talkBackExecutor: TalkBackSwipeExecutor;
  scrollUntilVisible: ScrollUntilVisible;
  scrollables: ScrollableElementsQuery;
  geometry: ElementGeometry;
  lastRenderedObservation: RenderedObservationReader | undefined;
  autoTargeting: SwipeOnAutoTargeting;
  visual: Pick<BaseVisualChange, "observedInteraction">;
  getDuration(options: SwipeOnResolvedOptions): number;
  createErrorResult(error: string): SwipeOnResult;
  observedSwipeInteraction(
    block: (observation: ObserveResult, fence?: DisplayFence) => Promise<SwipeOnResult>,
    options: Parameters<BaseVisualChange["observedInteraction"]>[1],
    diagnostics: { boomerang?: BoomerangConfig },
  ): Promise<SwipeOnResult>;
  checkPostActionDisplay(
    result: Pick<BaseActionResult, "observation" | "staleDisplay">,
    assertCurrent: (() => void) | undefined,
    signal?: AbortSignal,
  ): boolean;
  rethrowObservationAbort(error: unknown, signal?: AbortSignal, enabled?: boolean): void;
  resolveContainerSwipeCoordinates(
    options: SwipeOnResolvedOptions,
    viewHierarchy: ViewHierarchyResult,
    containerElement: Element,
    observeResult: ObserveResult,
  ): { startX: number; startY: number; endX: number; endY: number; warning?: string };
}

const DISPLAY_SWIPE_OPTIONS = [
  "lookFor",
  "focusTarget",
  "autoTarget",
  "includeSystemInsets",
  "scrollMode",
  // Display routes resolve and dispatch without the layer checks below (issue #9305).
  "layer",
] as const;

/** TalkBack state for an explicit-display swipe; `unknownWarning` is set when detection is unconfirmed. */
export type DisplayTalkBackState = { enabled: boolean; unknownWarning?: string };

function withUnknownTalkBackWarning(result: SwipeOnResult, warning?: string): SwipeOnResult {
  if (!warning || result.warnings?.includes(warning)) {
    return result;
  }
  return { ...result, warnings: [...(result.warnings ?? []), warning] };
}

function unsupportedDisplaySwipeOption({
  options,
  platform,
}: {
  options: SwipeOnOptions;
  platform: BootedDevice["platform"];
}) {
  return DISPLAY_SWIPE_OPTIONS.find(
    (key) =>
      options[key] !== undefined &&
      (platform !== "android" || key === "focusTarget" || key === "layer"),
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
  if (options.fromEdge) {
    return edgeSwipeCoordinates({
      edge: options.fromEdge,
      bounds: rect,
      inset: options.edgeInset,
      at: options.at,
    });
  }
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

/** The structured container diagnostic a selector failure carries onto the result (#10325). */
export function containerFailureOf(error: unknown): Pick<SwipeOnResult, "containerFailure"> {
  return error instanceof ActionableError && error.containerFailure
    ? { containerFailure: error.containerFailure }
    : {};
}

export class SwipeOnAndroidDisplay {
  constructor(private readonly ctx: () => SwipeOnDisplayContext) {}

  private async executeOnAndroidDisplay({
    options: requestedOptions,
    target,
    signal,
    talkBack,
  }: {
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
    talkBack: DisplayTalkBackState;
  }): Promise<SwipeOnResult> {
    let resolutionObservation = target.observation;
    if (requestedOptions.container || requestedOptions.autoTarget === true) {
      resolutionObservation = await freshSwipeHierarchy(
        resolutionObservation,
        (timeoutMs) =>
          this.ctx().observeScreen.execute({
            ...INTERMEDIATE_OBSERVATION_OPTIONS,
            display: target.observation.display.key,
            freshness: "fresh",
            timeoutMs,
            signal,
          }),
        this.ctx().timer,
        signal,
      );
    }
    const observation = this.validateSelectedDisplayObservation({
      observation: resolutionObservation,
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
    const duration = resolveSwipeDuration({ ...options, geometry: this.ctx().geometry });
    const boomerang = resolveBoomerangConfig(options);
    if (talkBack.enabled) {
      // A raw one-finger swipe only moves TalkBack focus; reuse the default route's executor.
      const swipe = await this.dispatchTalkBackDisplaySwipe({
        options,
        element: decision.element,
        coordinates: { x1, y1, x2, y2 },
        duration,
        boomerang,
        target,
        signal,
      });
      return this.ctx().autoTargeting.withAutoTargetDecision({
        result: { ...swipe, targetType, warning },
        decision,
      });
    }
    const useCtrlProxy = await this.resolveDisplaySwipeRoute({ options, target });
    await this.dispatchDisplaySwipeLeg({ x1, y1, x2, y2, duration, target, useCtrlProxy, signal });
    let totalDuration = duration;
    if (boomerang) {
      const returnDuration = getReturnDuration({
        forwardDuration: duration,
        returnSpeed: boomerang.returnSpeed,
      });
      totalDuration += boomerang.apexPauseMs + returnDuration;
      // The forward leg landed: a pause cancel, a failed return leg or a throw must say so (#9973).
      const returnResult = await runBoomerangReturnLeg({
        timer: this.ctx().timer,
        apexPauseMs: boomerang.apexPauseMs,
        signal,
        returnSwipe: () =>
          this.dispatchDisplayReturnLeg({
            x1: x2,
            y1: y2,
            x2: x1,
            y2: y1,
            duration: returnDuration,
            target,
            useCtrlProxy,
            signal,
          }),
      });
      if (!returnResult.success) {
        return this.ctx().autoTargeting.withAutoTargetDecision({
          result: {
            ...returnResult,
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
    }
    return this.ctx().autoTargeting.withAutoTargetDecision({
      result: {
        success: true,
        targetType,
        x1,
        y1,
        x2,
        y2,
        duration: totalDuration,
        warning,
        ...(talkBack.unknownWarning ? { warnings: [talkBack.unknownWarning] } : {}),
      },
      decision,
    });
  }

  /**
   * TalkBack on for an explicit display: refuse a non-default display before any dispatch (the
   * shared TalkBack driver has no display-addressed request); an unknown state keeps the raw
   * gesture and carries the same warning as the default route (#9905).
   */
  private async resolveDisplayTalkBack(
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
    signal?: AbortSignal,
  ): Promise<DisplayTalkBackState> {
    const state = await this.ctx().accessibilityDetector.resolveTalkBackState(
      this.ctx().device.deviceId,
      this.ctx().adb,
      this.ctx().featureFlags,
    );
    throwIfAborted(signal);
    if (state !== true) {
      return {
        enabled: false,
        unknownWarning: state === null ? TALKBACK_STATE_UNKNOWN_WARNING : undefined,
      };
    }
    const refusal = talkBackDisplayRefusal(target.displayId, "scrolling");
    if (refusal) {
      throw refusal;
    }
    return { enabled: true };
  }

  private async dispatchTalkBackDisplaySwipe({
    options,
    element,
    coordinates,
    duration,
    boomerang,
    target,
    signal,
  }: {
    options: SwipeOnOptions;
    element?: Element | null;
    coordinates: { x1: number; y1: number; x2: number; y2: number };
    duration: number;
    boomerang?: BoomerangConfig;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
  }): Promise<SwipeResult> {
    const direction = resolveSwipeDirection(options);
    if (!direction.direction) {
      throw new ActionableError(direction.error ?? "direction is required");
    }
    target.assertCurrent();
    const { x1, y1, x2, y2 } = coordinates;
    const swipe = await this.ctx().talkBackExecutor.executeSwipeGesture({
      x1,
      y1,
      x2,
      y2,
      direction: direction.direction,
      containerElement: element ?? null,
      gestureOptions: {
        displayFence: { assertCurrent: target.assertCurrent },
        duration,
        durationExplicit: explicitDuration(options),
        scrollMode: options.scrollMode,
      },
      perf: undefined,
      boomerang,
      signal,
    });
    throwIfAborted(signal);
    if (!swipe.success) {
      throw new ActionableError(swipe.error ?? "TalkBack swipe failed");
    }
    return swipe;
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
      const coordinates = this.ctx().resolveContainerSwipeCoordinates(
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
      ? this.ctx().scrollables.findScrollableElements(observation.viewHierarchy)
      : [];
    const decision = this.ctx().autoTargeting.resolveAutoTargetDecision({
      scrollables,
      candidates: this.ctx().autoTargeting.buildScrollableCandidates(scrollables),
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
      this.ctx().accessibilityService,
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
    const insetOptions = { observation, platform: this.ctx().device.platform };
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
        this.ctx().displayTransitionReader.identityRevision(this.ctx().device.deviceId),
        this.ctx().displayTransitionReader.currentObservedPanel(this.ctx().device.deviceId)?.key,
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

  private async resolveSearchDisplaySwipeRoute({
    options,
    target,
    signal,
  }: {
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (options.scrollMode === "a11y") {
      return this.resolveDisplaySwipeRoute({ options, target });
    }
    try {
      return await this.resolveDisplaySwipeRoute({ options, target });
    } catch (error) {
      throwIfAborted(signal);
      // Auto mode's optional capability probe sends no gesture, so ADB remains safe.
      logger.debug("[SwipeOn] CtrlProxy display gesture capability unavailable", error);
      return false;
    }
  }

  /** The TalkBack executor exposes no send point, so its swipes are counted as attempted. */
  private executeDisplayTalkBackSwipe(input: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    direction: SwipeDirection;
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    searchDragState?: AndroidSearchDragState;
    signal?: AbortSignal;
    onDispatched?: () => void;
  }): Promise<SwipeResult> {
    input.onDispatched?.();
    return this.ctx().talkBackExecutor.executeSwipeGesture({
      x1: input.x1,
      y1: input.y1,
      x2: input.x2,
      y2: input.y2,
      direction: input.direction,
      containerElement: null,
      gestureOptions: {
        displayFence: { assertCurrent: input.target.assertCurrent },
        duration: input.duration,
        scrollMode: input.options.scrollMode,
        searchDragState: input.searchDragState,
      },
      perf: undefined,
      boomerang: undefined,
      signal: input.signal,
    });
  }

  /**
   * Forward optional finalization/cache seams while checking every capture, including
   * BaseVisualChange's retries and settle polls.
   */
  private validatedObserveScreen(
    validateObservation: (observation: ObserveResult) => ObserveResult,
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
  ): ObserveScreen {
    const observeScreen = this.ctx().observeScreen;
    return {
      execute: async (captureOptions) => {
        target.assertCurrent();
        return validateObservation(await observeScreen.execute(captureOptions));
      },
      getMostRecentCachedObserveResult:
        observeScreen.getMostRecentCachedObserveResult.bind(observeScreen),
      appendRawViewHierarchy: observeScreen.appendRawViewHierarchy.bind(observeScreen),
      captureScreenshot: observeScreen.captureScreenshot?.bind(observeScreen),
      runAccessibilityAudit: observeScreen.runAccessibilityAudit?.bind(observeScreen),
      processRecomposition: observeScreen.processRecomposition?.bind(observeScreen),
      captureCacheGeneration: observeScreen.captureCacheGeneration?.bind(observeScreen),
      cacheObserveResult: observeScreen.cacheObserveResult?.bind(observeScreen),
    };
  }

  private async searchOnAndroidDisplay({
    options,
    target,
    progress,
    signal,
    talkBack,
  }: {
    options: SwipeOnOptions;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    progress?: ProgressCallback;
    signal?: AbortSignal;
    talkBack: DisplayTalkBackState;
  }): Promise<SwipeOnResult> {
    const direction = resolveSwipeDirection(options);
    if (direction.error) {
      throw new ActionableError(direction.error);
    }
    const useCtrlProxy = await this.resolveSearchDisplaySwipeRoute({ options, target, signal });
    const display = target.observation.display.key;
    const validateObservation = (observation: ObserveResult) =>
      this.validateSelectedDisplayObservation({
        observation,
        target,
        includeSystemInsets: options.includeSystemInsets,
      });
    const postActionObserveScreen = this.validatedObserveScreen(validateObservation, target);
    let dispatched = false;
    const observe: ScrollUntilVisibleStrategy["observe"] = async (captureOptions) => {
      try {
        target.assertCurrent();
        return validateObservation(
          await this.ctx().observeScreen.execute({
            display,
            freshness: captureOptions?.freshness ?? "cached-ok",
            timeoutMs: captureOptions?.timeoutMs,
            skipScreenshot: true,
            skipAccessibilityAudit: true,
            signal,
          }),
        );
      } catch (error) {
        this.ctx().rethrowObservationAbort(error, signal);
        logger.warn(`[SwipeOn] Display search read failed: ${errorMessage(error)}`, error);
        throw dispatched ? new DispatchedObservationError(error) : error;
      }
    };
    const result = await this.ctx().scrollUntilVisible.executeWithStrategy({
      options: { ...options, direction: direction.direction as SwipeDirection },
      progress,
      signal,
      strategy: {
        observe,
        swipe: async ({ previousObservation, searchDragState, onDispatched, ...coordinates }) => {
          const result = await this.ctx().visual.observedInteraction<SwipeOnResult>(
            async () => {
              const fallback = async () => {
                coordinates.onSearchFallback?.();
                await this.dispatchDisplaySwipeLeg({
                  ...coordinates,
                  target,
                  useCtrlProxy: false,
                  signal,
                  onDispatched,
                });
                dispatched = true;
                return { ...coordinates, success: true };
              };
              const gesture = await (talkBack.enabled
                ? this.executeDisplayTalkBackSwipe({
                    ...coordinates,
                    direction: direction.direction as SwipeDirection,
                    options,
                    target,
                    searchDragState,
                    signal,
                    onDispatched,
                  })
                : useCtrlProxy
                  ? executeAndroidSearchDrag({
                      ...coordinates,
                      searchDragState,
                      client: this.ctx().accessibilityService,
                      signal,
                      displayId: target.displayId === 0 ? undefined : target.displayId,
                      beforeSend: target.assertCurrent,
                      fallback,
                      onDispatched,
                      onIndeterminate: (cause) => {
                        throw new DispatchedObservationError(cause);
                      },
                    })
                  : fallback());
              dispatched ||= gesture.success;
              return gesture;
            },
            {
              changeExpected: false,
              timeoutMs: SETTLE_BUDGET_MS.brief,
              display,
              previousObservation,
              progress,
              signal,
              deferPostActionScreenshot: true,
              postActionObserveScreen,
            },
          );
          this.ctx().checkPostActionDisplay(
            result,
            () => validateObservation(result.observation!),
            signal,
          );
          return {
            ...coordinates,
            targetType: "screen",
            success: result.success,
            error: result.error,
            outcomeIndeterminate: result.outcomeIndeterminate,
            observation: result.observation!,
            staleDisplay: result.staleDisplay,
          };
        },
      },
    });
    if (dispatched) {
      // A changed revision cannot support a found claim, even with a kept capture.
      this.ctx().checkPostActionDisplay({}, target.assertCurrent, signal);
    } else {
      target.assertCurrent();
    }
    return withUnknownTalkBackWarning(result, talkBack.unknownWarning);
  }

  /**
   * Return leg of a display-addressed boomerang as a SwipeResult, so a plain dispatch failure
   * reaches `runBoomerangReturnLeg` as a result it can mark partially applied. Cancellation, device
   * loss and stale-display errors stay thrown: the callers branch on those types.
   */
  private async dispatchDisplayReturnLeg(
    options: Parameters<SwipeOnAndroidDisplay["dispatchDisplaySwipeLeg"]>[0],
  ): Promise<SwipeResult> {
    const { x1, y1, x2, y2, duration, signal } = options;
    try {
      await this.dispatchDisplaySwipeLeg(options);
      return { success: true, x1, y1, x2, y2, duration };
    } catch (error) {
      throwIfAborted(signal);
      if (isDeviceLostError(error) || error instanceof StaleDisplayError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      logger.warn(`swipeOn display return leg failed: ${errorMessage(error)}`, error);
      return { success: false, error: errorMessage(error), x1, y1, x2, y2, duration };
    }
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
    /** Fires as the gesture is handed to the device, after the pre-send checks. */
    onDispatched?: () => void;
  }): Promise<void> {
    const { x1, y1, x2, y2, duration, target, useCtrlProxy, signal, onDispatched } = options;
    target.assertCurrent();
    throwIfAborted(signal);
    if (useCtrlProxy) {
      const result = await this.ctx().accessibilityService.requestSwipe({
        x1,
        y1,
        x2,
        y2,
        duration,
        onDispatch: onDispatched,
        signal,
        displayId: target.displayId === 0 ? undefined : target.displayId,
        beforeSend: target.assertCurrent,
      });
      throwIfAborted(signal);
      if (!result.success) {
        throw new ActionableError(result.error ?? "Android swipe failed");
      }
    } else {
      await executeTouchscreenInput(
        this.ctx().adb,
        `swipe ${x1} ${y1} ${x2} ${y2} ${inputDurationArgument(duration)}`,
        target.displayId,
        signal,
        target.assertCurrent,
        { onDispatch: onDispatched },
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
      return this.ctx().scrollUntilVisible.resolveSwipeContainer(
        observation.viewHierarchy,
        options.container,
      ).bounds;
    }
    const container = this.ctx().scrollUntilVisible.resolveElement(
      observation.viewHierarchy,
      options.container,
      "inspect",
      options.container.text !== undefined,
    );
    // A page inside a pager swipes as its scrollable ancestor (#10752).
    return container && options.direction
      ? this.ctx().scrollUntilVisible.resolveSwipeTarget(
          observation.viewHierarchy,
          container,
          options.direction,
        ).bounds
      : container?.bounds;
  }

  async executeExplicitDisplay(
    options: SwipeOnOptions,
    context: { progress?: ProgressCallback; signal?: AbortSignal } = {},
  ): Promise<SwipeOnResult | undefined> {
    const { progress, signal } = context;
    if (options.display !== undefined) {
      try {
        const unsupported = unsupportedDisplaySwipeOption({
          options,
          platform: this.ctx().device.platform,
        });
        if (unsupported) {
          throw new ActionableError(unsupportedDisplayOptionMessage(unsupported));
        }
        const validationError =
          validateSwipeTimingOptions(options, this.ctx().getDuration(options)) ??
          validateResolvedEdgeSwipe(options);
        if (validationError) {
          throw new ActionableError(validationError);
        }
        const target = await prepareTargetDisplayAction(
          this.ctx().device,
          options.display,
          this.ctx().observeScreen,
          this.ctx().adb,
          {
            lastRenderedObservation: this.ctx().lastRenderedObservation,
            signal,
            transitions: this.ctx().displayTransitionReader,
          },
        );
        throwIfAborted(signal);
        if (this.ctx().device.platform === "android") {
          this.validateSelectedDisplayObservation({
            observation: target.observation,
            target,
            includeSystemInsets: options.includeSystemInsets,
          });
          const talkBack = await this.resolveDisplayTalkBack(target, signal);
          return options.lookFor
            ? await this.searchOnAndroidDisplay({ options, target, progress, signal, talkBack })
            : await this.ctx().observedSwipeInteraction(
                () => this.executeOnAndroidDisplay({ options, target, signal, talkBack }),
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
        // throwIfAborted would replace this with a generic cancellation that loses the swipe count.
        if (error instanceof SwipeSearchCancelledError) {
          throw error;
        }
        throwIfAbortedKeepingForwardNote(signal, error);
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        logger.warn(`swipeOn display routing failed: ${errorMessage(error)}`, error);
        return withStaleDisplay(
          { ...this.ctx().createErrorResult(errorMessage(error)), ...containerFailureOf(error) },
          error,
        );
      }
    }
    return undefined;
  }
}
