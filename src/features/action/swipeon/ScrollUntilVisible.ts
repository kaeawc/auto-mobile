import { ScrollSearchSession } from "./ScrollSearchSession";
import { assertGestureOnLayer, scopeHierarchyForSelector } from "../../observe/hierarchyLayer";
import { withSwipeObservationReadScope } from "./freshSwipeHierarchy";

import { DispatchedObservationError } from "../../../models/DispatchedObservationError";
import { StaleDisplayError, type StaleDisplayDetails } from "../../observe/StaleDisplayError";
import {
  usesScopedSwipeContainer,
  usesScopedSwipeLookFor,
  resolveSwipeLookFor,
} from "./swipeSelectorScopes";
import type { FencedGestureOptions } from "../ExecuteGesture";
import { type ContainerFailure, unsupportedPlatformError } from "../../../models/ActionableError";
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
  type ElementResolution,
} from "../../utility/ElementResolver";
import { SearchableHierarchy } from "../../utility/SearchableNode";
import { DefaultElementParser } from "../../utility/ElementParser";
import { AutoTargetSelector } from "./AutoTargetSelector";
import { resolveScrollableSwipeTarget } from "./scrollableAncestor";
import type { ResolverSelector } from "../../../models/elementSelectorSchemas";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import type { ObserveScreen } from "../../observe/interfaces/ObserveScreen";
import { AccessibilityDetector } from "../../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { FeatureFlagReader } from "../../featureFlags/FeatureFlagService";
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
  LOOK_FOR_HOLD_MS,
  oppositeDirection,
  recoverLookForOverlap,
  visibleScrollKeys,
} from "./lookForScroll";

import type { AndroidSearchDragState } from "./androidSearchDrag";
import { resolveActionCallWithPerf, type ActionCall } from "../ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "../observedInteractionProfiles";
import type {
  ObservedActionResult,
  ObservedChangeOptions,
  ObservedEnvelope,
} from "../observedInteractionTypes";

const SCROLL_IDLE_POLL_INTERVAL_MS = 150;
/** Backoff bounds for re-reading the hierarchy when the scroll container is not yet resolvable. */
const CONTAINER_RETRY_INITIAL_DELAY_MS = 10;
const CONTAINER_RETRY_MAX_DELAY_MS = 1_000;

export interface ScrollUntilVisibleDependencies {
  device: BootedDevice;
  resolver?: Pick<ElementResolver, "resolve">;
  geometry: ElementGeometry;
  observeScreen: Pick<ObserveScreen, "execute">;
  accessibilityService: ScrollAccessibilityService;
  accessibilityDetector: AccessibilityDetector;
  adb: AdbExecutor;
  featureFlags?: FeatureFlagReader;
  overlayDetector: OverlayAnalyzer;
  talkBackExecutor: TalkBackSwipeRunner;
  voiceOverExecutor?: VoiceOverSwipeRunner;
  timer: Timer;
  getDuration: (options: SwipeOnResolvedOptions) => number;
  resolveBoomerangConfig: (options: SwipeOnResolvedOptions) => BoomerangConfig | undefined;
  buildPredictionArgs: (options: SwipeOnOptions) => Record<string, unknown>;
  captureDisplayFence?: () => DisplayFence;
  observedInteraction: <R extends ObservedActionResult>(
    action: (observeResult: ObserveResult, fence?: DisplayFence) => Promise<R>,
    options: ObservedChangeOptions,
  ) => Promise<R & ObservedEnvelope>;
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

export interface SearchSwipeDispatchOptions {
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
  private readonly parser = new DefaultElementParser();
  private readonly autoTarget = new AutoTargetSelector();
  private readonly resolver: Pick<ElementResolver, "resolve">;

  constructor(private readonly deps: ScrollUntilVisibleDependencies) {
    this.resolver = deps.resolver ?? new ElementResolver();
  }

  /**
   * A single-level named swipe container that does not itself scroll in the swipe direction (a
   * pager page, a wrapper) resolves to its nearest scrollable ancestor (#10752); see
   * `resolveScrollableSwipeTarget`. A scoped container chain names its innermost scope on purpose
   * and is never promoted.
   */
  resolveSwipeTarget(
    hierarchy: ViewHierarchyResult,
    element: Element,
    direction: SwipeDirection,
  ): Element {
    return resolveScrollableSwipeTarget({
      hierarchy,
      element,
      direction,
      parser: this.parser,
      scrollsInDirection: (candidate, dir) => this.autoTarget.scrollsInDirection(candidate, dir),
    });
  }

  private resolveNamedSwipeContainer(
    hierarchy: ViewHierarchyResult,
    options: SwipeOnOptions,
  ): Element | null {
    const element = this.resolveElement(hierarchy, options.container!);
    return element && this.resolveSwipeTarget(hierarchy, element, options.direction);
  }

  resolveElement(
    hierarchy: ViewHierarchyResult,
    selector: ResolverSelector,
    action: ResolutionAction = "inspect",
    preserveMatchedNode = false,
  ): Element | null {
    const result: ElementResolution & { containerFailure?: ContainerFailure } =
      this.resolver.resolve(
        { id: String(hierarchy.updatedAt ?? "swipe"), nodes: this.searchable.project(hierarchy) },
        selector,
        { action },
      );
    if (isMissingContainerError(result.error)) {
      return null;
    }
    if (result.error) {
      throw new ActionableError(result.error, { containerFailure: result.containerFailure });
    }
    return preserveMatchedNode
      ? (matchedSourceNode(result, selector)?.element ?? null)
      : (result.chosen?.element ?? null);
  }

  resolveSwipeContainer(
    hierarchy: ViewHierarchyResult,
    container: NonNullable<SwipeOnOptions["container"]>,
  ): Element {
    const result: ElementResolution & { containerFailure?: ContainerFailure } =
      this.resolver.resolve(
        { id: String(hierarchy.updatedAt ?? "swipe"), nodes: this.searchable.project(hierarchy) },
        { container },
        { action: "inspect" },
      );
    if (result.error) {
      throw new ActionableError(result.error, { containerFailure: result.containerFailure });
    }
    const element = result.scope?.element;
    if (!element) {
      throw new ActionableError(
        `Container level 1 not found: ${container.elementId ?? container.text}`,
        { containerFailure: { level: 1, reason: "not-found", selector: container } },
      );
    }
    return element;
  }

  async execute(options: SwipeOnResolvedOptions, call?: ActionCall): Promise<SwipeOnResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    options: SwipeOnResolvedOptions,
    progress?: ProgressCallback,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<SwipeOnResult>;
  async execute(
    options: SwipeOnResolvedOptions,
    progressOrCall?: ProgressCallback | ActionCall,
    perfArg?: PerformanceTracker,
    signalArg?: AbortSignal,
  ): Promise<SwipeOnResult> {
    const {
      progress,
      perf = new NoOpPerformanceTracker(),
      signal,
    } = resolveActionCallWithPerf(progressOrCall, perfArg, signalArg);
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
      return await withSwipeObservationReadScope(() =>
        new ScrollSearchSession(
          { ...args, swipes },
          this.deps,
          {
            findScrollableContainer: (...args) => this.findScrollableContainer(...args),
            screenBoundsContainer: (...args) => this.screenBoundsContainer(...args),
            resolveLookForOptions: (...args) => this.resolveLookForOptions(...args),
            computeHierarchyFingerprint: (...args) => this.computeHierarchyFingerprint(...args),
            findElementInHierarchy: (...args) => this.findElementInHierarchy(...args),
            isElementWithinContainer: (...args) => this.isElementWithinContainer(...args),
            setAccessibilityFocusOnElement: (...args) =>
              this.setAccessibilityFocusOnElement(...args),
            resolveContainerSwipeCoordinates: (...args) =>
              this.resolveContainerSwipeCoordinates(...args),
            resolveReverseBounds: (...args) => this.resolveReverseBounds(...args),
            computeHalfScreenReverseCoords: (...args) =>
              this.computeHalfScreenReverseCoords(...args),
            dispatchSearchSwipe: (...args) => this.dispatchSearchSwipe(...args),
            matchInterruptedDisplaySearch: (...args) => this.matchInterruptedDisplaySearch(...args),
            findVisibleSearchTarget: (...args) => this.findVisibleSearchTarget(...args),
            shouldGuardSearchStep: (...args) => this.shouldGuardSearchStep(...args),
            recoverSearchObservation: (...args) => this.recoverSearchObservation(...args),
            checkReverseExhausted: (...args) => this.checkReverseExhausted(...args),
          },
          args.perf ?? new NoOpPerformanceTracker(),
        ).execute(),
      );
    } catch (error) {
      // A search cancelled after it moved the screen must say so (#10151).
      throw annotateSearchCancellation(error, args.signal, swipes);
    }
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
      options.layer,
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
    // The window under the start point receives the whole swipe (issue #9305).
    assertGestureOnLayer(
      observation.viewHierarchy,
      options.layer,
      [{ x: Math.floor(startX), y: Math.floor(startY) }],
      "swipe",
    );
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
            const result = await swipeRunner.executeSwipeGesture({
              x1: Math.floor(startX),
              y1: Math.floor(startY),
              x2: Math.floor(endX),
              y2: Math.floor(endY),
              direction: activeDirection,
              containerElement,
              gestureOptions,
              perf,
              boomerang,
              signal,
            });
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
            ...OBSERVED_INTERACTION_PROFILES.selectorResolvedGesture,
            timeoutMs: SETTLE_BUDGET_MS.brief,
            progress,
            perf,
            signal,
            // The gesture coordinates come from this in-call read, so it is the pre-action read
            // the display fence checks; after a fold it passes once it is at the new revision.
            previousObservation: lastObservation,
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
      options.layer,
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
    viewHierarchy = scopeHierarchyForSelector(viewHierarchy, options.layer);

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
        initialDelayMs: CONTAINER_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: CONTAINER_RETRY_MAX_DELAY_MS,
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

    return this.resolveSwipeTarget(viewHierarchy, element, options.direction);
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
        return await this.deps.accessibilityService.getAccessibilityHierarchy(queryOptions, {
          disableAllFiltering: serverConfig.isRawElementSearchEnabled(),
        });
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
    const viewHierarchy = scopeHierarchyForSelector(observeResult.viewHierarchy!, options.layer);

    if (options.container) {
      if (usesScopedSwipeContainer(options.container)) {
        return this.resolveSwipeContainer(viewHierarchy, options.container);
      }
      if (options.container.elementId || options.container.text) {
        element = this.resolveNamedSwipeContainer(viewHierarchy, options);
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
    layer?: SwipeOnOptions["layer"],
  ): Promise<Element | null> {
    if (!lookFor.text && !lookFor.elementId) {
      return null;
    }
    viewHierarchy = scopeHierarchyForSelector(viewHierarchy, layer);
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
