import { freshSwipeHierarchy, withSwipeObservationReadScope } from "./freshSwipeHierarchy";
import { TALKBACK_STATE_UNKNOWN_WARNING } from "../../accessibility/interfaces/AccessibilityDetector";
import { DispatchedObservationError } from "../../../models/DispatchedObservationError";
import { StaleDisplayError, type StaleDisplayDetails } from "../../../models/StaleDisplayError";
import {
  scopedSearchDescription,
  usesScopedSwipeContainer,
  usesScopedSwipeLookFor,
  resolveSwipeLookFor,
} from "./swipeSelectorScopes";
import type { FencedGestureOptions } from "../ExecuteGesture";
import { unsupportedPlatformError } from "../../../models/ActionableError";
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
import { logger } from "../../../utils/logger";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  ElementResolver,
  isMissingContainerError,
  matchedSourceNode,
  type ResolutionAction,
} from "../../utility/ElementResolver";
import { SearchableHierarchy } from "../../utility/SearchableNode";
import type { ResolverSelector } from "../../../server/elementSelectorSchemas";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import type { ObserveScreen } from "../../observe/interfaces/ObserveScreen";
import { AccessibilityDetector } from "../../accessibility/interfaces/AccessibilityDetector";
import { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { FeatureFlagService } from "../../featureFlags/FeatureFlagService";
import { serverConfig } from "../../../utils/ServerConfig";
import { Timer } from "../../../utils/SystemTimer";
import {
  SwipeOnResolvedOptions,
  BoomerangConfig,
  TalkBackSwipeRunner,
  VoiceOverSwipeRunner,
  OverlayAnalyzer,
  ScrollAccessibilityService,
} from "./types";
import { resolveContainerSwipeCoordinates } from "./resolveContainerSwipeCoordinates";
import { getScreenBounds } from "../../../utils/screenBounds";
import {
  effectiveSwipeInsets,
  clipIosChromeBounds,
  deriveIosChromeInsets,
  insetSwipeBounds,
  iosSwipeStartWarning,
  swipeScreenSize,
} from "./iosChromeInsets";
import { exponentialBackoff } from "../../../utils/Backoff";
import { computeHierarchyFingerprint, waitForScrollIdle } from "../../../utils/scrollIdle";
import type { DisplayFence, ProgressCallback } from "../BaseVisualChange";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { throwIfAborted } from "../../../utils/toolUtils";
import { annotateSearchCancellation, type SwipeCounter } from "./searchCancellation";
import { DefaultObserveElementCollector } from "../../observe/ObserveElementCollector";
import {
  getImeOccluderForElement,
  getIosImeOccluder,
  tapPointOutsideIme,
} from "../../observe/output/SkeletonProjection";

import {
  capLookForTravel,
  LOOK_FOR_HOLD_MS,
  oppositeDirection,
  recoverLookForOverlap,
  visibleScrollKeys,
} from "./lookForScroll";

import type { AndroidSearchDragState } from "./androidSearchDrag";

const SCROLL_IDLE_POLL_INTERVAL_MS = 150;

interface ScrollUntilVisibleDependencies {
  device: BootedDevice;
  resolver?: Pick<ElementResolver, "resolve">;
  geometry: ElementGeometry;
  observeScreen: ObserveScreen;
  accessibilityService: ScrollAccessibilityService;
  accessibilityDetector: AccessibilityDetector;
  adb: AdbExecutor;
  featureFlags?: FeatureFlagService;
  overlayDetector: OverlayAnalyzer;
  talkBackExecutor: TalkBackSwipeRunner;
  voiceOverExecutor?: VoiceOverSwipeRunner;
  timer: Timer;
  getDuration: (options: SwipeOnResolvedOptions) => number;
  resolveBoomerangConfig: (options: SwipeOnResolvedOptions) => BoomerangConfig | undefined;
  buildPredictionArgs: (options: SwipeOnOptions) => Record<string, unknown>;
  captureDisplayFence?: () => DisplayFence;
  observedInteraction: <T>(
    action: (observeResult: ObserveResult, fence?: DisplayFence) => Promise<T>,
    options: {
      changeExpected: boolean;
      timeoutMs?: number;
      progress?: ProgressCallback;
      perf?: PerformanceTracker;
      signal?: AbortSignal;
      skipPreviousObserve?: boolean;
      queryOptions?: {
        text?: string;
        elementId?: string;
        containerElementId?: string | undefined;
      };
      predictionContext?: {
        toolName: string;
        toolArgs: Record<string, unknown>;
      };
      deferPostActionScreenshot?: boolean;
      observationTimestampProvider?: () => number | undefined;
    },
  ) => Promise<T & { observation?: ObserveResult }>;
  captureTerminalObservationScreenshot?: (
    observation: ObserveResult | undefined,
    perf: PerformanceTracker,
  ) => Promise<void>;
}

/** Display targeting supplies transport only; matching and scroll recovery stay shared. */
export interface ScrollUntilVisibleStrategy {
  observe: (options?: { freshness: "fresh"; timeoutMs: number }) => Promise<ObserveResult>;
  swipe: (options: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    previousObservation: ObserveResult;
    holdDurationMs?: number;
    onSearchFallback?: () => void;
    searchDragState?: AndroidSearchDragState;
    /**
     * Called when the gesture is handed to the device, never before the strategy's own
     * pre-send checks; a strategy that cannot see its send point calls it as it begins the send.
     */
    onDispatched?: () => void;
  }) => Promise<SwipeOnResult & { observation: ObserveResult }>;
}

interface SearchSwipeDispatchOptions {
  coordinates: { startX: number; startY: number; endX: number; endY: number };
  direction: SwipeDirection;
  duration: number;
  options: SwipeOnResolvedOptions;
  containerElement: Element;
  observation: ObserveResult;
  observationFence?: DisplayFence;
  strategy?: ScrollUntilVisibleStrategy;
  scrollIteration: number;
  perf: PerformanceTracker;
  progress?: ProgressCallback;
  signal?: AbortSignal;
  onSearchFallback: () => void;
  searchDragState: AndroidSearchDragState;
  swipes: SwipeCounter;
}

export class ScrollUntilVisible {
  private static readonly MAX_ATTEMPTS = 5;

  private readonly searchable = new SearchableHierarchy();
  private readonly resolver: Pick<ElementResolver, "resolve">;

  constructor(private readonly deps: ScrollUntilVisibleDependencies) {
    this.resolver = deps.resolver ?? new ElementResolver();
  }

  resolveElement(
    hierarchy: ViewHierarchyResult,
    selector: ResolverSelector,
    action: ResolutionAction = "inspect",
    preserveMatchedNode = false,
  ): Element | null {
    const result = this.resolver.resolve(
      { id: String(hierarchy.updatedAt ?? "swipe"), nodes: this.searchable.project(hierarchy) },
      selector,
      { action },
    );
    if (isMissingContainerError(result.error)) {
      return null;
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    return preserveMatchedNode
      ? (matchedSourceNode(result, selector)?.element ?? null)
      : (result.chosen?.element ?? null);
  }

  resolveSwipeContainer(
    hierarchy: ViewHierarchyResult,
    container: NonNullable<SwipeOnOptions["container"]>,
  ): Element {
    const result = this.resolver.resolve(
      { id: String(hierarchy.updatedAt ?? "swipe"), nodes: this.searchable.project(hierarchy) },
      { container },
      { action: "inspect" },
    );
    if (result.error) {
      throw new ActionableError(result.error);
    }
    const element = result.scope?.element;
    if (!element) {
      throw new ActionableError(
        `Container level 1 not found: ${container.elementId ?? container.text}`,
      );
    }
    return element;
  }

  async execute(
    options: SwipeOnResolvedOptions,
    progress?: ProgressCallback,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<SwipeOnResult> {
    return this.executeWithStrategy({ options, progress, perf, signal });
  }

  async executeWithStrategy(args: {
    options: SwipeOnResolvedOptions;
    progress?: ProgressCallback;
    perf?: PerformanceTracker;
    signal?: AbortSignal;
    strategy?: ScrollUntilVisibleStrategy;
  }): Promise<SwipeOnResult> {
    const swipes: SwipeCounter = { dispatched: 0 };
    try {
      return await withSwipeObservationReadScope(() => this.executeSearch({ ...args, swipes }));
    } catch (error) {
      // A search cancelled after it moved the screen must say so (#10151).
      throw annotateSearchCancellation(error, args.signal, swipes);
    }
  }

  private async executeSearch({
    options,
    progress,
    perf = new NoOpPerformanceTracker(),
    signal,
    strategy,
    swipes,
  }: {
    options: SwipeOnResolvedOptions;
    progress?: ProgressCallback;
    perf?: PerformanceTracker;
    signal?: AbortSignal;
    strategy?: ScrollUntilVisibleStrategy;
    swipes: SwipeCounter;
  }): Promise<SwipeOnResult> {
    const observe =
      strategy?.observe ??
      ((captureOptions?: { freshness: "fresh"; timeoutMs: number }) =>
        this.deps.observeScreen.execute({
          freshness: captureOptions?.freshness ?? "cached-ok",
          timeoutMs: captureOptions?.timeoutMs,
          skipScreenshot: true,
          skipAccessibilityAudit: true,
          signal,
        }));
    throwIfAborted(signal);
    logger.info(
      `[SwipeOn] Starting scroll-until-visible: direction=${options.direction}, lookFor=${JSON.stringify(options.lookFor)}`,
    );

    const observationFence = strategy ? undefined : this.deps.captureDisplayFence?.();
    // Get initial observation
    let lastObservation = await perf.track("initialObserve", async () =>
      freshSwipeHierarchy(
        await observe(),
        (timeoutMs) => observe({ freshness: "fresh", timeoutMs }),
        this.deps.timer,
        signal,
      ),
    );
    throwIfAborted(signal);
    if (!lastObservation.viewHierarchy || !lastObservation.screenSize) {
      throw new Error("Failed to get initial observation for scrolling until visible.");
    }

    // Find the scrollable container
    let containerElement = await perf.track("findContainer", () =>
      this.findScrollableContainer(
        options,
        lastObservation,
        strategy
          ? this.screenBoundsContainer({
              observation: lastObservation,
              includeSystemInsets: options.includeSystemInsets,
            })
          : undefined,
      ),
    );

    logger.info(
      `[SwipeOn] Using container: bounds=${JSON.stringify(containerElement.bounds)}, scrollable=${containerElement.scrollable}`,
    );

    const lookForOptions = this.resolveLookForOptions(options, containerElement, lastObservation);
    let fallbackLogged = false;
    const onSearchFallback = () => {
      if (!fallbackLogged) {
        logger.debug(
          "[SwipeOn] lookFor using slow ADB swipe fallback (600ms, at most 75% viewport)",
        );
        fallbackLogged = true;
      }
    };

    const maxTime = options.lookFor!.maxTime ?? 15000;
    const maxSwipes = options.lookFor!.maxSwipes ?? Number.POSITIVE_INFINITY;
    const startTime = this.deps.timer.now();
    let foundElement: Element | null = null;
    let scrollIteration = 0;
    let lastFingerprint = this.computeHierarchyFingerprint(lastObservation.viewHierarchy!);
    let unchangedScrollCount = 0;
    const maxUnchangedScrolls = 1;

    const scopeDescription = scopedSearchDescription(options);
    const target = options.lookFor!.text
      ? `text "${options.lookFor!.text}"`
      : `element with id "${options.lookFor!.elementId}"`;
    logger.info(`[SwipeOn] Looking for ${target} with maxTime=${maxTime}ms`);

    // Check if TalkBack is enabled (not just any accessibility service)
    const accessibilityWarnings = new Set<string>();
    const isTalkBackEnabled = await perf.track("checkTalkBack", async () => {
      throwIfAborted(signal);
      if (strategy || this.deps.device.platform !== "android") {
        return false;
      }
      // Pass the real ADB executor (not null) so TalkBack detection works on a
      // cold/expired cache instead of silently reporting "not talkback" (#3915).
      // Pass featureFlags so `force-accessibility-mode` / `accessibility-auto-detect`
      // apply to scroll detection uniformly with the observe path (#3925).
      const state = await this.deps.accessibilityDetector.resolveTalkBackState(
        this.deps.device.deviceId,
        this.deps.adb,
        this.deps.featureFlags,
      );
      if (state === null) {
        accessibilityWarnings.add(TALKBACK_STATE_UNKNOWN_WARNING);
      }
      return state === true;
    });

    // First check if element is already visible within the container bounds
    foundElement = await perf.track("initialSearch", () =>
      this.findElementInHierarchy(
        options.lookFor!,
        lastObservation.viewHierarchy!,
        options.container,
        containerElement,
      ),
    );

    if (
      foundElement &&
      !this.isElementWithinContainer(foundElement, containerElement.bounds, lastObservation)
    ) {
      logger.info(
        `[SwipeOn] Found ${target} initially but it is outside container bounds (element center y=${Math.floor((foundElement.bounds.top + foundElement.bounds.bottom) / 2)}, container=${JSON.stringify(containerElement.bounds)}), will scroll`,
      );
      foundElement = null;
    }

    if (foundElement) {
      logger.info(
        `[SwipeOn] Element already visible at bounds=${JSON.stringify(foundElement.bounds)}, no scrolling needed`,
      );

      // Set accessibility focus on found element if requested
      if (isTalkBackEnabled && options.focusTarget) {
        throwIfAborted(signal);
        await this.setAccessibilityFocusOnElement(foundElement, perf);
      }

      perf.end();
      throwIfAborted(signal);
      await this.deps.captureTerminalObservationScreenshot?.(lastObservation, perf);
      return {
        success: true,
        targetType: "element",
        element: foundElement,
        found: true,
        ...(accessibilityWarnings.size ? { warnings: [...accessibilityWarnings] } : {}),
        scrollIterations: 0,
        elapsedMs: this.deps.timer.now() - startTime,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        duration: 0,
        observation: lastObservation,
      };
    }

    const searchDragState: AndroidSearchDragState = {};
    let overlapRecoveryUsed = false;
    let interruptedDisplay: StaleDisplayDetails | undefined;
    let swipeWarning: string | undefined;
    let lastAndroidSwipeError: string | undefined;

    // Overshoot recovery state
    let reverseMode = false;
    const reverseDirection = oppositeDirection(options.direction);
    const reverseOptions = { ...lookForOptions, speed: "slow" as const };

    // Scroll until element is found
    while (this.deps.timer.now() - startTime < maxTime && scrollIteration < maxSwipes) {
      throwIfAborted(signal);
      scrollIteration++;
      logger.info(
        `[SwipeOn] Iteration ${scrollIteration}: elapsed=${this.deps.timer.now() - startTime}ms, reverseMode=${reverseMode}, unchangedScrollCount=${unchangedScrollCount}/${maxUnchangedScrolls}`,
      );

      // The container was resolved from the latest observation (initially above,
      // then after each settled swipe). Derive both directions from its bounds.
      const swipeCoordinates = this.resolveContainerSwipeCoordinates(
        options,
        lastObservation.viewHierarchy!,
        containerElement,
        lastObservation,
      );
      swipeWarning = swipeCoordinates.warning ?? swipeWarning;
      const reverseBounds = this.resolveReverseBounds(options, containerElement, lastObservation);
      const reverseSwipeCoords = this.computeHalfScreenReverseCoords(
        reverseDirection,
        reverseBounds,
      );

      // Perform scroll
      const previousKeys = visibleScrollKeys(lastObservation, containerElement);
      const activeCoords =
        this.deps.device.platform === "android" && strategy && !reverseMode
          ? capLookForTravel(swipeCoordinates, reverseBounds)
          : reverseMode
            ? reverseSwipeCoords
            : swipeCoordinates;
      const activeDirection = reverseMode ? reverseDirection : options.direction;
      const activeDuration = this.deps.getDuration(
        strategy && this.deps.device.platform === "android"
          ? { ...lookForOptions, duration: undefined, speed: "slow" }
          : reverseMode
            ? reverseOptions
            : lookForOptions,
      );
      const { startX, startY, endX, endY } = activeCoords;
      const chromeStartWarning = iosSwipeStartWarning({
        observation: lastObservation,
        platform: this.deps.device.platform,
        startX: Math.floor(startX),
        startY: Math.floor(startY),
      });
      logger.info(
        `[SwipeOn] Swipe: direction=${activeDirection}, coords=(${Math.floor(startX)},${Math.floor(startY)})→(${Math.floor(endX)},${Math.floor(endY)}), duration=${activeDuration}ms`,
      );

      searchDragState.pagingStep = false;
      const swipeResult = await this.dispatchSearchSwipe({
        coordinates: activeCoords,
        direction: activeDirection,
        duration: activeDuration,
        options,
        containerElement,
        observation: lastObservation,
        observationFence,
        strategy,
        scrollIteration,
        perf,
        progress,
        signal,
        onSearchFallback,
        searchDragState,
        swipes,
      });
      throwIfAborted(signal);

      for (const warning of swipeResult.warnings ?? []) {
        accessibilityWarnings.add(warning);
      }
      if (swipeResult.observation?.viewHierarchy) {
        lastObservation = swipeResult.observation;
      }

      if (swipeResult.staleDisplay && !swipeResult.outcomeIndeterminate) {
        // The retained capture is validated, but the later read is not. It can
        // prove a match; it cannot authorize another swipe, even near timeout.
        interruptedDisplay = swipeResult.staleDisplay;
        foundElement = await this.matchInterruptedDisplaySearch(
          options,
          lastObservation,
          containerElement,
          interruptedDisplay,
        );
        break;
      }

      if (
        !swipeResult.success &&
        swipeResult.outcomeIndeterminate &&
        this.deps.device.platform === "ios"
      ) {
        // The swipe was dispatched but unconfirmed: report it, never `found: false`.
        perf.end();
        throw new ActionableError(
          `${swipeResult.error ?? "iOS scroll swipe outcome is indeterminate."} The scroll may have happened. Observe before retrying.`,
        );
      }

      if (!swipeResult.success && this.deps.device.platform === "ios") {
        perf.end();
        throwIfAborted(signal);
        await this.deps.captureTerminalObservationScreenshot?.(lastObservation, perf);
        return {
          ...swipeResult,
          targetType: "screen",
          found: false,
          scrollIterations: scrollIteration,
          elapsedMs: this.deps.timer.now() - startTime,
        };
      }

      const failedAndroidSwipe = this.deps.device.platform === "android" && !swipeResult.success;
      if (failedAndroidSwipe) {
        const swipeError = swipeResult.error ?? "Android scroll swipe failed";
        if (swipeResult.outcomeIndeterminate) {
          perf.end();
          throw new ActionableError(
            `${swipeError} The scroll may have happened. Observe before retrying.`,
          );
        }
        if (lastAndroidSwipeError !== undefined || !swipeResult.observation?.viewHierarchy) {
          perf.end();
          throw new ActionableError(`Scroll swipe failed: ${swipeError}`);
        }
        // Preserve one transient rejection's observation/search, without treating it as scroll-end evidence.
        lastAndroidSwipeError = swipeError;
        logger.warn(`[SwipeOn] Scroll swipe failed; tolerating one rejection: ${swipeError}`);
      } else {
        lastAndroidSwipeError = undefined;
      }

      // Update observation
      if (!swipeResult.observation?.viewHierarchy) {
        throw new Error("Lost observation after swipe during scroll until visible.");
      }

      // If the post-swipe fingerprint matches the pre-swipe fingerprint, the
      // observation likely returned stale cached data (the swipe gesture was
      // dispatched but the cache hadn't been invalidated yet) rather than
      // reflecting an actually-stationary list. This is the canonical signal
      // that the scroll-end detector below will misfire, so surface it loudly.
      const postSwipeFingerprint = this.computeHierarchyFingerprint(lastObservation.viewHierarchy!);
      if (postSwipeFingerprint === lastFingerprint) {
        logger.warn(
          `[SwipeOn] iter=${scrollIteration} post-swipe fingerprint matches pre-swipe — ` +
            `observation may be stale (cache hit) or swipe had no visible effect`,
        );
      }

      // Wait for scroll animation to fully settle before inspecting the hierarchy.
      // The post-swipe observation may reflect a mid-scroll position (the accessibility service
      // can return a cached hierarchy captured before the fling decelerates to rest). Polling
      // until two consecutive fingerprints match ensures we evaluate lookFor against the final
      // idle state rather than a transient mid-scroll frame.
      const elapsedMs = this.deps.timer.now() - startTime;
      const idleCheckMaxMs = Math.min(1500, Math.max(0, maxTime - elapsedMs - 300));
      if (idleCheckMaxMs > 100) {
        lastObservation = await waitForScrollIdle(lastObservation, {
          observe,
          timer: this.deps.timer,
          maxWaitMs: idleCheckMaxMs,
          pollIntervalMs: SCROLL_IDLE_POLL_INTERVAL_MS,
          logPrefix: "[SwipeOn]",
          signal,
        });
      }

      foundElement = await this.findVisibleSearchTarget(options, lastObservation, containerElement);
      if (foundElement) {
        break;
      }
      let recoveryAttempted = false;

      // Only Android coordinate search steps retain overlap; paging and iOS do not.
      if (
        this.shouldGuardSearchStep({
          failedAndroidSwipe,
          reverseMode,
          overlapRecoveryUsed,
          searchDragState,
        })
      ) {
        const recovered = await this.recoverSearchObservation({
          previousKeys,
          observe,
          deadline: startTime + maxTime,
          dispatch: {
            coordinates: activeCoords,
            direction: activeDirection,
            duration: activeDuration,
            options,
            containerElement,
            observation: lastObservation,
            observationFence,
            strategy,
            scrollIteration,
            perf,
            progress,
            signal,
            onSearchFallback,
            searchDragState,
            swipes,
          },
          onRecovery: () => {
            recoveryAttempted = true;
            // One bounded recovery episode prevents ambiguous pages repeatedly undoing forward progress.
            overlapRecoveryUsed = true;
          },
        });
        lastObservation = recovered.observation;
        interruptedDisplay = recovered.staleDisplay;
      }

      if (recoveryAttempted) {
        foundElement = await this.findVisibleSearchTarget(
          options,
          lastObservation,
          containerElement,
        );
        if (foundElement) {
          break;
        }
      }

      // Check if hierarchy changed (detect scroll end)
      let currentFingerprint = this.computeHierarchyFingerprint(lastObservation.viewHierarchy!);
      if (
        !recoveryAttempted &&
        currentFingerprint === lastFingerprint &&
        lastObservation.freshness?.isFresh === false
      ) {
        logger.info(
          `[SwipeOn] Iteration ${scrollIteration}: stale unchanged observation; re-observing once before scroll-end decision`,
        );
        lastObservation = await observe();
        currentFingerprint = this.computeHierarchyFingerprint(lastObservation.viewHierarchy!);
        foundElement = await this.findVisibleSearchTarget(
          options,
          lastObservation,
          containerElement,
        );
        if (foundElement) {
          break;
        }
      }
      // A guard-restored page is not evidence that the forward step reached the end.
      const fingerprintChanged = recoveryAttempted || currentFingerprint !== lastFingerprint;
      logger.info(
        `[SwipeOn] Iteration ${scrollIteration}: hierarchy ${fingerprintChanged ? "changed" : "UNCHANGED"} (fingerprint[0:40]="${currentFingerprint.slice(0, 40)}")`,
      );

      // The settled (or corroborating) observation also owns the target bounds
      // checked below. Keep the previous container when this frame omits it.
      containerElement = await this.findScrollableContainer(
        options,
        lastObservation,
        containerElement,
      );

      if (!fingerprintChanged && chromeStartWarning) {
        perf.end();
        throw new ActionableError(
          `${chromeStartWarning} Cannot determine end of container from this swipe. Retry without includeSystemInsets.`,
        );
      }

      // A second stale unchanged capture is still not end-of-list evidence.
      if (
        !failedAndroidSwipe &&
        !fingerprintChanged &&
        lastObservation.freshness?.isFresh !== false
      ) {
        unchangedScrollCount++;
        logger.info(
          `[SwipeOn] Iteration ${scrollIteration}: unchanged count now ${unchangedScrollCount}/${maxUnchangedScrolls}`,
        );

        if (unchangedScrollCount >= maxUnchangedScrolls) {
          this.checkReverseExhausted(reverseMode, {
            perf,
            startTime,
            maxUnchangedScrolls,
            target,
            scopeDescription,
            scrollIteration,
          });
          // Switch to reverse half-screen recovery
          reverseMode = true;
          unchangedScrollCount = 0;
          logger.info(
            `[SwipeOn] Reached end in forward direction without finding ${target}, switching to reverse half-screen recovery`,
          );
        }
      } else if (fingerprintChanged) {
        unchangedScrollCount = 0;
        lastFingerprint = currentFingerprint;
      }

      logger.info(`[SwipeOn] Iteration ${scrollIteration}: ${target} not yet found`);
    }

    if (!foundElement) {
      throwIfAborted(signal);
      perf.end();
      const elapsed = this.deps.timer.now() - startTime;
      if (lastAndroidSwipeError !== undefined) {
        throw new ActionableError(`Scroll swipe failed: ${lastAndroidSwipeError}`);
      }
      throw new ActionableError(
        `${target} not found${scopeDescription} after scrolling for ${elapsed}ms (${scrollIteration} iterations, timeout=${maxTime}ms).`,
      );
    }

    // Set accessibility focus on found element if requested
    if (isTalkBackEnabled && options.focusTarget) {
      throwIfAborted(signal);
      await this.setAccessibilityFocusOnElement(foundElement, perf);
    }

    perf.end();
    throwIfAborted(signal);
    await this.deps.captureTerminalObservationScreenshot?.(lastObservation, perf);
    return {
      success: true,
      targetType: "element",
      element: foundElement,
      found: true,
      scrollIterations: scrollIteration,
      elapsedMs: this.deps.timer.now() - startTime,
      observation: lastObservation,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      duration: 0,
      warning: swipeWarning,
      ...(accessibilityWarnings.size ? { warnings: [...accessibilityWarnings] } : {}),
      ...(interruptedDisplay ? { staleDisplay: interruptedDisplay } : {}),
    };
  }

  private checkReverseExhausted(
    reverseMode: boolean,
    context: {
      perf: PerformanceTracker;
      startTime: number;
      maxUnchangedScrolls: number;
      target: string;
      scopeDescription: string;
      scrollIteration: number;
    },
  ): void {
    const { perf, startTime, maxUnchangedScrolls, target, scopeDescription, scrollIteration } =
      context;
    if (reverseMode) {
      // Reverse also exhausted — element truly not found
      perf.end();
      const elapsed = this.deps.timer.now() - startTime;
      throw new ActionableError(
        `Scroll reached end of container (no change after ${maxUnchangedScrolls} scrolls). ` +
          `${target} not found${scopeDescription} after ${scrollIteration} iterations (${elapsed}ms).`,
      );
    }
  }

  private resolveLookForOptions(
    options: SwipeOnResolvedOptions,
    containerElement: Element,
    observation: ObserveResult,
  ): SwipeOnResolvedOptions {
    // Calculate container height as percentage of screen height
    const containerHeight = containerElement.bounds.bottom - containerElement.bounds.top;
    const screenHeight = observation.screenSize!.height;
    const heightPercentage = (containerHeight / screenHeight) * 100;

    // Limit speed for lookFor to prevent skipping elements
    let effectiveSpeed = options.speed;
    if (heightPercentage >= 80) {
      if (!effectiveSpeed || effectiveSpeed === "fast") {
        effectiveSpeed = "normal";
        logger.info(
          `[SwipeOn] Container is ${heightPercentage.toFixed(1)}% of screen height, limiting lookFor speed to "normal"`,
        );
      }
    } else {
      if (!effectiveSpeed || effectiveSpeed === "normal" || effectiveSpeed === "fast") {
        effectiveSpeed = "slow";
        logger.info(
          `[SwipeOn] Container is ${heightPercentage.toFixed(1)}% of screen height, limiting lookFor speed to "slow"`,
        );
      }
    }

    return { ...options, speed: effectiveSpeed };
  }

  private shouldGuardSearchStep(options: {
    failedAndroidSwipe: boolean;
    reverseMode: boolean;
    overlapRecoveryUsed: boolean;
    searchDragState: AndroidSearchDragState;
  }): boolean {
    return (
      this.deps.device.platform === "android" &&
      !options.failedAndroidSwipe &&
      !options.reverseMode &&
      !options.overlapRecoveryUsed &&
      !options.searchDragState.pagingStep
    );
  }

  private async findVisibleSearchTarget(
    options: SwipeOnResolvedOptions,
    observation: ObserveResult,
    previousContainer: Element,
  ): Promise<Element | null> {
    const container = await this.findScrollableContainer(options, observation, previousContainer);
    const element = await this.findElementInHierarchy(
      options.lookFor!,
      observation.viewHierarchy!,
      options.container,
      container,
    );
    return element && this.isElementWithinContainer(element, container.bounds, observation)
      ? element
      : null;
  }

  private async recoverSearchObservation({
    previousKeys,
    dispatch,
    observe,
    deadline,
    onRecovery,
  }: {
    previousKeys: Map<string, number>;
    dispatch: SearchSwipeDispatchOptions;
    observe: () => Promise<ObserveResult>;
    deadline: number;
    onRecovery: () => void;
  }): Promise<{ observation: ObserveResult; staleDisplay?: StaleDisplayDetails }> {
    const { options, containerElement } = dispatch;
    let staleDisplay: StaleDisplayDetails | undefined;
    const observation = await recoverLookForOverlap({
      previousKeys,
      observation: dispatch.observation,
      timer: this.deps.timer,
      deadline,
      signal: dispatch.signal,
      hasTarget: async (observation) =>
        Boolean(await this.findVisibleSearchTarget(options, observation, containerElement)),
      keys: async (observation) =>
        visibleScrollKeys(
          observation,
          await this.findScrollableContainer(options, observation, containerElement),
        ),
      backScroll: async (observation) => {
        onRecovery();
        const recovered = await this.performOverlapBackScroll(
          { ...dispatch, observation },
          observe,
          deadline,
        );
        staleDisplay = recovered.staleDisplay;
        return recovered.observation;
      },
    });
    return { observation, staleDisplay };
  }

  private async performOverlapBackScroll(
    dispatch: SearchSwipeDispatchOptions,
    observe: () => Promise<ObserveResult>,
    deadline: number,
  ): Promise<{ observation: ObserveResult; staleDisplay?: StaleDisplayDetails }> {
    const { options, observation, signal } = dispatch;
    const container = await this.findScrollableContainer(
      options,
      observation,
      dispatch.containerElement,
    );
    const direction = oppositeDirection(dispatch.direction);
    const result = await this.dispatchSearchSwipe({
      ...dispatch,
      coordinates: this.computeHalfScreenReverseCoords(
        direction,
        this.resolveReverseBounds(options, container, observation),
      ),
      direction,
      duration: this.deps.getDuration({ ...options, speed: "slow" }),
      containerElement: container,
    });
    throwIfAborted(signal);
    if (result.outcomeIndeterminate) {
      throw new ActionableError(result.error ?? "Recovery scroll outcome is indeterminate");
    }
    if (result.staleDisplay) {
      // A kept validated capture may prove the target, but never authorize more recovery gestures.
      await this.matchInterruptedDisplaySearch(
        options,
        result.observation!,
        container,
        result.staleDisplay,
      );
      return { observation: result.observation!, staleDisplay: result.staleDisplay };
    }
    if (!result.success || !result.observation?.viewHierarchy) {
      // Confirmed recovery rejection is optional; the original search can continue safely.
      logger.debug("[SwipeOn] Overlap recovery unavailable; continuing forward", result.error);
      return { observation };
    }
    if (await this.findVisibleSearchTarget(options, result.observation, container)) {
      return { observation: result.observation };
    }
    return {
      observation: await waitForScrollIdle(result.observation, {
        observe,
        timer: this.deps.timer,
        maxWaitMs: Math.min(1500, Math.max(0, deadline - this.deps.timer.now())),
        pollIntervalMs: SCROLL_IDLE_POLL_INTERVAL_MS,
        logPrefix: "[SwipeOn] overshoot",
        signal,
      }),
    };
  }

  private async dispatchSearchSwipe({
    coordinates,
    direction,
    duration,
    options,
    containerElement,
    observation,
    observationFence,
    strategy,
    scrollIteration,
    perf,
    progress,
    signal,
    onSearchFallback,
    searchDragState,
    swipes,
  }: SearchSwipeDispatchOptions): Promise<SwipeResult> {
    const { startX, startY, endX, endY } = coordinates;
    const activeDuration = duration;
    const activeDirection = direction;
    const lastObservation = observation;
    const boomerang = this.deps.resolveBoomerangConfig(options);
    const gestureOptions: FencedGestureOptions = {
      duration: activeDuration,
      scrollMode: options.scrollMode,
      searchScroll: this.deps.device.platform === "android",
      searchScrollBounds: this.resolveReverseBounds(options, containerElement, observation),
      onSearchFallback,
      searchDragState,
    };

    // Execute swipe with observedInteraction
    let iosDispatchTimestamp: number | undefined;
    if (strategy) {
      // The caller's loop and recoveries check the signal, but not between that check and here.
      throwIfAborted(signal);
    }
    // The strategy sits behind observedInteraction's own awaits and abort checks, so a swipe is
    // counted only when it reports the gesture reached the device, once per swipe.
    let counted = false;
    const onDispatched = () => {
      if (!counted) {
        counted = true;
        swipes.dispatched++;
      }
    };
    return strategy
      ? await strategy.swipe({
          x1: Math.floor(startX),
          y1: Math.floor(startY),
          x2: Math.floor(endX),
          y2: Math.floor(endY),
          duration: activeDuration,
          holdDurationMs: this.deps.device.platform === "android" ? LOOK_FOR_HOLD_MS : undefined,
          onSearchFallback,
          searchDragState,
          previousObservation: lastObservation,
          onDispatched,
        })
      : await this.deps.observedInteraction(
          async (_observeResult, fence) => {
            gestureOptions.displayFence = {
              assertCurrent: () => {
                observationFence?.assertCurrent();
                fence?.assertCurrent();
              },
            };
            throwIfAborted(signal);
            swipes.dispatched++;
            const swipeRunner =
              this.deps.device.platform === "ios"
                ? this.deps.voiceOverExecutor
                : this.deps.talkBackExecutor;
            if (!swipeRunner) {
              throw new Error(
                "VoiceOver swipe runner is not configured for iOS scroll-until-visible",
              );
            }
            const result = await swipeRunner.executeSwipeGesture(
              Math.floor(startX),
              Math.floor(startY),
              Math.floor(endX),
              Math.floor(endY),
              activeDirection,
              containerElement,
              gestureOptions,
              perf,
              boomerang,
              signal,
            );
            // An unconfirmed swipe may still have scrolled, so the next read must not be pre-swipe.
            if (
              this.deps.device.platform === "ios" &&
              (result.success || result.outcomeIndeterminate)
            ) {
              iosDispatchTimestamp = this.deps.timer.now();
              IOSCtrlProxyClient.getExistingInstance(this.deps.device.deviceId)?.invalidateCache();
            }
            return result;
          },
          {
            changeExpected: false,
            timeoutMs: 500,
            progress,
            perf,
            signal,
            skipPreviousObserve: scrollIteration > 1,
            deferPostActionScreenshot: true,
            observationTimestampProvider: () => iosDispatchTimestamp,
            predictionContext: {
              toolName: "swipeOn",
              toolArgs: this.deps.buildPredictionArgs(options),
            },
          },
        );
  }

  private async matchInterruptedDisplaySearch(
    options: SwipeOnOptions,
    observation: ObserveResult,
    container: Element,
    details: StaleDisplayDetails,
  ): Promise<Element> {
    const element = await this.findElementInHierarchy(
      options.lookFor!,
      observation.viewHierarchy!,
      options.container,
      container,
    );
    if (element && this.isElementWithinContainer(element, container.bounds, observation)) {
      return element;
    }
    throw new DispatchedObservationError(new StaleDisplayError(details));
  }

  async findTargetElement(
    options: SwipeOnOptions,
    viewHierarchy: ViewHierarchyResult,
    attempt: number = 0,
    signal?: AbortSignal,
  ): Promise<Element> {
    throwIfAborted(signal);
    let element: Element | null = null;

    if (!options.container) {
      throw new ActionableError("Container must be specified for element swipe");
    }

    if (!options.container.text && !options.container.elementId) {
      throw new ActionableError("Container must specify either text or elementId");
    }
    if (usesScopedSwipeContainer(options.container)) {
      return this.resolveSwipeContainer(viewHierarchy, options.container);
    }
    element = this.resolveElement(
      viewHierarchy,
      options.container,
      "inspect",
      options.container.text !== undefined,
    );

    // Retry logic similar to TapOnElement
    if (!element && attempt < ScrollUntilVisible.MAX_ATTEMPTS) {
      const delayNextAttempt = exponentialBackoff({
        initialDelayMs: 10,
        maxDelayMs: 1000,
      }).delayForAttempt(attempt + 1);
      await this.deps.timer.sleep(delayNextAttempt);
      throwIfAborted(signal);

      const latestViewHierarchy = await this.refreshContainerHierarchy(options.container, signal);

      if (latestViewHierarchy) {
        logger.info(`Retrying to find element after ${delayNextAttempt}ms delay`);
        return await this.findTargetElement(options, latestViewHierarchy, attempt + 1, signal);
      }
    }

    if (!element) {
      if (options.container.text) {
        throw new ActionableError(
          `Element not found with provided text '${options.container.text}'`,
        );
      } else {
        throw new ActionableError(
          `Element not found with provided elementId '${options.container.elementId}'`,
        );
      }
    }

    return element;
  }

  private async refreshContainerHierarchy(
    container: NonNullable<SwipeOnOptions["container"]>,
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult | null | undefined> {
    switch (this.deps.device.platform) {
      case "android":
        const queryOptions = {
          query: container.text || container.elementId || "",
          containerElementId: undefined,
        };
        return await this.deps.accessibilityService.getAccessibilityHierarchy(
          queryOptions,
          undefined,
          undefined,
          undefined,
          serverConfig.isRawElementSearchEnabled(),
        );
      case "ios":
        // Refresh through ObserveScreen so retrying a selector sees the same
        // cleaned iOS projection that introduced it, rather than CtrlProxy's
        // separate action-only conversion.
        return (
          await this.deps.observeScreen.execute({
            freshness: "cached-ok",
            skipScreenshot: true,
            skipAccessibilityAudit: true,
            signal,
          })
        ).viewHierarchy;
      default:
        throw unsupportedPlatformError(this.deps.device.platform, "scroll until visible");
    }
  }

  async findScrollableContainer(
    options: SwipeOnOptions,
    observeResult: ObserveResult,
    fallbackElement: Element = this.screenBoundsContainer({ observation: observeResult }),
  ): Promise<Element> {
    let element: Element | null = null;
    const viewHierarchy = observeResult.viewHierarchy!;

    if (options.container) {
      if (usesScopedSwipeContainer(options.container)) {
        return this.resolveSwipeContainer(viewHierarchy, options.container);
      }
      if (options.container.elementId || options.container.text) {
        element = this.resolveElement(viewHierarchy, options.container);
      }
    }
    if (!element) {
      // Automatic scrolling keeps traversal priority: the outer scrollable
      // precedes nested carousels in the same window.
      const resolution = this.resolver.resolve(
        {
          id: String(viewHierarchy.updatedAt ?? "swipe"),
          nodes: this.searchable.project(viewHierarchy),
        },
        {},
        { action: "scroll" },
      );
      // The app's main hierarchy remains the first automatic scroll target;
      // transient higher-layer windows such as an IME are fallback targets.
      const candidates = [...resolution.candidates].sort(
        (a, b) => Number(a.rootGroup !== 0) - Number(b.rootGroup !== 0),
      );
      element = candidates.find((candidate) => candidate.element)?.element ?? null;
      if (element) {
        logger.info(`[SwipeOn] Found scrollable container automatically`);
      }
    }

    // If still no element, keep the last known container before using screen bounds.
    if (!element) {
      logger.info(`[SwipeOn] No scrollable container found, using fallback bounds`);
      element = fallbackElement;
    }

    return element;
  }

  private screenBoundsContainer({
    observation,
    includeSystemInsets,
  }: {
    observation: ObserveResult;
    includeSystemInsets?: boolean;
  }): Element {
    const insetOptions = { observation, platform: this.deps.device.platform, includeSystemInsets };
    const screenSize = swipeScreenSize(insetOptions) || { width: 1080, height: 1920 };
    return {
      bounds: getScreenBounds(screenSize, effectiveSwipeInsets(insetOptions)),
      scrollable: true,
    } as Element;
  }

  async findElementInHierarchy(
    lookFor: NonNullable<SwipeOnOptions["lookFor"]>,
    viewHierarchy: ViewHierarchyResult,
    container?: SwipeOnOptions["container"],
    containerElement?: Element,
  ): Promise<Element | null> {
    if (!lookFor.text && !lookFor.elementId) {
      return null;
    }
    if (!usesScopedSwipeContainer(container) && !usesScopedSwipeLookFor(lookFor)) {
      return this.resolveElement(viewHierarchy, { ...lookFor, container }, "inspect", true);
    }
    // A legacy container keeps its fallback semantics. Only its actual match,
    // never the automatically selected scrollable, constrains a scoped lookFor.
    const explicitContainer = usesScopedSwipeContainer(container)
      ? containerElement
      : container
        ? this.resolveElement(viewHierarchy, container)
        : undefined;
    return resolveSwipeLookFor({
      lookFor,
      container: usesScopedSwipeContainer(container) || explicitContainer ? container : undefined,
      containerElement: explicitContainer ?? undefined,
      resolver: this.resolver,
      nodes: this.searchable.project(viewHierarchy),
      id: String(viewHierarchy.updatedAt ?? "swipe"),
    });
  }

  computeHierarchyFingerprint(viewHierarchy: ViewHierarchyResult): string {
    return computeHierarchyFingerprint(viewHierarchy);
  }

  private async setAccessibilityFocusOnElement(
    element: Element,
    perf: PerformanceTracker,
  ): Promise<void> {
    try {
      await perf.track("setAccessibilityFocus", async () => {
        const resourceId = element["resource-id"];
        if (!resourceId) {
          logger.warn("[SwipeOn] Cannot set accessibility focus: element has no resource-id");
          return;
        }

        await this.deps.accessibilityService.requestAction("focus", resourceId, 5000, perf);
        logger.info(`[SwipeOn] Set accessibility focus on element: ${resourceId}`);
      });
    } catch (error) {
      logger.warn(`[SwipeOn] Failed to set accessibility focus: ${error}`);
    }
  }

  private isElementWithinContainer(
    element: Element,
    containerBounds: { top: number; bottom: number; left: number; right: number },
    observation: ObserveResult,
  ): boolean {
    const centerY = (element.bounds.top + element.bounds.bottom) / 2;
    const centerX = (element.bounds.left + element.bounds.right) / 2;
    const centerWithinContainer =
      centerY >= containerBounds.top &&
      centerY <= containerBounds.bottom &&
      centerX >= containerBounds.left &&
      centerX <= containerBounds.right;
    return this.deps.device.platform === "ios"
      ? this.isIosElementWithinContainer(
          element,
          containerBounds,
          observation,
          centerWithinContainer,
        )
      : centerWithinContainer;
  }

  private isIosElementWithinContainer(
    element: Element,
    containerBounds: Element["bounds"],
    observation: ObserveResult,
    centerWithinContainer: boolean,
  ): boolean {
    const hierarchy = observation.viewHierarchy;
    const screen = swipeScreenSize({ observation, platform: "ios" });
    if (!hierarchy || !screen) {
      return centerWithinContainer;
    }
    const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios");
    const ime = elements && getImeOccluderForElement(elements, element);
    const chromeInsets = deriveIosChromeInsets(hierarchy, {
      observationScreenSize: observation.screenSize,
    });
    // Without captured occluders, preserve the legacy centre-in-container test.
    // A content-only hierarchy root need not describe the full iOS screen.
    if (!ime && !Object.values(chromeInsets).some((inset) => inset > 0)) {
      return centerWithinContainer;
    }
    // includeSystemInsets affects the gesture, never whether a covered target is found.
    const safe = getScreenBounds(screen, observation.systemInsets ?? hierarchy.systemInsets);
    const bounds = {
      left: Math.max(containerBounds.left, safe.left),
      top: Math.max(containerBounds.top, safe.top),
      right: Math.min(containerBounds.right, safe.right),
      bottom: Math.min(containerBounds.bottom, safe.bottom),
    };
    // The dispatchability minimum belongs to the element, never to the viewport.
    const exposed = clipIosChromeBounds({
      bounds: element.bounds,
      hierarchy,
      screen,
      elements: [element],
      forTapTarget: true,
    }).bounds;
    if (!exposed) {
      return false;
    }
    const viewport = clipIosChromeBounds({ bounds, hierarchy, screen, elements: [element] }).bounds;
    if (!viewport) {
      return false;
    }
    const visible = {
      left: Math.max(exposed.left, viewport.left),
      top: Math.max(exposed.top, viewport.top),
      right: Math.min(exposed.right, viewport.right),
      bottom: Math.min(exposed.bottom, viewport.bottom),
    };
    const { left, top, right, bottom } = visible;
    // A partial match is found when the exposed portion has a dispatchable tap point.
    const imeBounds = ime && getIosImeOccluder(ime, screen).bounds;
    const center = this.deps.geometry.getElementCenter({ bounds: visible });
    const candidates = imeBounds
      ? [tapPointOutsideIme([left, top, right, bottom], imeBounds), center]
      : [center];
    return candidates.some(
      (point) =>
        point !== null &&
        Number.isInteger(point.x) &&
        Number.isInteger(point.y) &&
        this.deps.geometry.isPointInElement({ bounds: visible }, point.x, point.y) &&
        point.x < right &&
        point.y < bottom &&
        !(
          imeBounds &&
          point.x >= imeBounds[0] &&
          point.x < imeBounds[2] &&
          point.y >= imeBounds[1] &&
          point.y < imeBounds[3]
        ),
    );
  }

  private computeHalfScreenReverseCoords(
    reverseDir: SwipeDirection,
    effectiveBounds: { left: number; top: number; right: number; bottom: number },
  ): { startX: number; startY: number; endX: number; endY: number } {
    const cx = (effectiveBounds.left + effectiveBounds.right) / 2;
    const cy = (effectiveBounds.top + effectiveBounds.bottom) / 2;
    const h = effectiveBounds.bottom - effectiveBounds.top;
    const w = effectiveBounds.right - effectiveBounds.left;

    switch (reverseDir) {
      case "down":
        return {
          startX: cx,
          startY: effectiveBounds.top + h * 0.25,
          endX: cx,
          endY: effectiveBounds.top + h * 0.75,
        };
      case "up":
        return {
          startX: cx,
          startY: effectiveBounds.bottom - h * 0.25,
          endX: cx,
          endY: effectiveBounds.top + h * 0.25,
        };
      case "right":
        return {
          startX: effectiveBounds.left + w * 0.25,
          startY: cy,
          endX: effectiveBounds.left + w * 0.75,
          endY: cy,
        };
      case "left":
        return {
          startX: effectiveBounds.right - w * 0.25,
          startY: cy,
          endX: effectiveBounds.left + w * 0.25,
          endY: cy,
        };
    }
  }

  private resolveReverseBounds(
    options: SwipeOnResolvedOptions,
    containerElement: Element,
    observation: ObserveResult,
  ): Element["bounds"] {
    return insetSwipeBounds({
      observation,
      platform: this.deps.device.platform,
      includeSystemInsets: options.includeSystemInsets,
      bounds: containerElement.bounds,
    });
  }

  private resolveContainerSwipeCoordinates(
    options: SwipeOnResolvedOptions,
    viewHierarchy: ViewHierarchyResult,
    containerElement: Element,
    observeResult: ObserveResult,
  ): { startX: number; startY: number; endX: number; endY: number; warning?: string } {
    return resolveContainerSwipeCoordinates({
      geometry: this.deps.geometry,
      overlayDetector: this.deps.overlayDetector,
      options,
      viewHierarchy,
      containerElement,
      observeResult,
      platform: this.deps.device.platform,
    });
  }
}
