import { freshSwipeHierarchy } from "./freshSwipeHierarchy";
import { TALKBACK_STATE_UNKNOWN_WARNING } from "../../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { type StaleDisplayDetails } from "../../observe/StaleDisplayError";
import { scopedSearchDescription } from "./swipeSelectorScopes";
import {
  ActionableError,
  Element,
  ObserveResult,
  SwipeDirection,
  SwipeOnOptions,
  SwipeOnResult,
  SwipeResult,
  ViewHierarchyResult,
} from "../../../models";
import { logger } from "../../../utils/logger";
import { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { SwipeOnResolvedOptions } from "./types";
import { iosSwipeStartWarning } from "./iosChromeInsets";
import { waitForScrollIdle } from "../../../utils/scrollIdle";
import type { DisplayFence, ProgressCallback } from "../BaseVisualChange";
import { throwIfAborted } from "../../../utils/toolUtils";
import { type SwipeCounter } from "./searchCancellation";
import { capLookForTravel, oppositeDirection, visibleScrollKeys } from "./lookForScroll";
import type { AndroidSearchDragState } from "./androidSearchDrag";
import type {
  ScrollUntilVisibleDependencies,
  ScrollUntilVisibleStrategy,
  SearchSwipeDispatchOptions,
} from "./ScrollUntilVisible";
interface ScrollSearchRequest {
  options: SwipeOnResolvedOptions;
  progress?: ProgressCallback;
  signal?: AbortSignal;
  strategy?: ScrollUntilVisibleStrategy;
  swipes: SwipeCounter;
}
interface ScrollSearchOperations {
  findScrollableContainer(
    options: SwipeOnOptions,
    observeResult: ObserveResult,
    fallbackElement?: Element,
  ): Promise<Element>;
  screenBoundsContainer(options: {
    observation: ObserveResult;
    includeSystemInsets?: boolean;
  }): Element;
  resolveLookForOptions(
    options: SwipeOnResolvedOptions,
    containerElement: Element,
    observation: ObserveResult,
  ): SwipeOnResolvedOptions;
  computeHierarchyFingerprint(viewHierarchy: ViewHierarchyResult): string;
  findElementInHierarchy(
    lookFor: NonNullable<SwipeOnOptions["lookFor"]>,
    viewHierarchy: ViewHierarchyResult,
    container?: SwipeOnOptions["container"],
    containerElement?: Element,
    layer?: SwipeOnOptions["layer"],
  ): Promise<Element | null>;
  isElementWithinContainer(
    element: Element,
    containerBounds: { top: number; bottom: number; left: number; right: number },
    observation: ObserveResult,
  ): boolean;
  setAccessibilityFocusOnElement(element: Element, perf: PerformanceTracker): Promise<void>;
  resolveContainerSwipeCoordinates(
    options: SwipeOnResolvedOptions,
    viewHierarchy: ViewHierarchyResult,
    containerElement: Element,
    observeResult: ObserveResult,
  ): { startX: number; startY: number; endX: number; endY: number; warning?: string };
  resolveReverseBounds(
    options: SwipeOnResolvedOptions,
    containerElement: Element,
    observation: ObserveResult,
  ): Element["bounds"];
  computeHalfScreenReverseCoords(
    reverseDir: SwipeDirection,
    effectiveBounds: { left: number; top: number; right: number; bottom: number },
  ): { startX: number; startY: number; endX: number; endY: number };
  dispatchSearchSwipe(options: SearchSwipeDispatchOptions): Promise<SwipeResult>;
  matchInterruptedDisplaySearch(
    options: SwipeOnOptions,
    observation: ObserveResult,
    container: Element,
    details: StaleDisplayDetails,
  ): Promise<Element>;
  findVisibleSearchTarget(
    options: SwipeOnResolvedOptions,
    observation: ObserveResult,
    previousContainer: Element,
  ): Promise<Element | null>;
  shouldGuardSearchStep(options: {
    failedAndroidSwipe: boolean;
    reverseMode: boolean;
    overlapRecoveryUsed: boolean;
    searchDragState: AndroidSearchDragState;
  }): boolean;
  recoverSearchObservation(options: {
    previousKeys: Map<string, number>;
    dispatch: SearchSwipeDispatchOptions;
    observe: () => Promise<ObserveResult>;
    deadline: number;
    onRecovery: () => void;
  }): Promise<{ observation: ObserveResult; staleDisplay?: StaleDisplayDetails }>;
  checkReverseExhausted(
    reverseMode: boolean,
    context: {
      perf: PerformanceTracker;
      startTime: number;
      maxUnchangedScrolls: number;
      target: string;
      scopeDescription: string;
      scrollIteration: number;
    },
  ): void;
}
interface SearchStep {
  dispatch: SearchSwipeDispatchOptions;
  previousKeys: Map<string, number>;
  chromeStartWarning?: string;
}
type SearchStepOutcome =
  | { kind: "interrupted" }
  | { kind: "failed"; result: SwipeOnResult }
  | { kind: "continue"; failedAndroidSwipe: boolean };
const SCROLL_IDLE_POLL_INTERVAL_MS = 150;
/** One scroll search, with explicit dispatch, recovery and end-of-container stages. */
export class ScrollSearchSession {
  private readonly observe: (options?: {
    freshness: "fresh";
    timeoutMs: number;
  }) => Promise<ObserveResult>;
  private observationFence?: DisplayFence;
  private lastObservation!: ObserveResult;
  private containerElement!: Element;
  private lookForOptions!: SwipeOnResolvedOptions;
  private maxTime = 0;
  private maxSwipes = 0;
  private startTime = 0;
  private foundElement: Element | null = null;
  private scrollIteration = 0;
  private lastFingerprint = "";
  private unchangedScrollCount = 0;
  private maxUnchangedScrolls = 1;
  private scopeDescription = "";
  private target = "";
  private accessibilityWarnings = new Set<string>();
  private isTalkBackEnabled = false;
  private searchDragState: AndroidSearchDragState = {};
  private overlapRecoveryUsed = false;
  private interruptedDisplay?: StaleDisplayDetails;
  private swipeWarning?: string;
  private lastAndroidSwipeError?: string;
  private reverseMode = false;
  private reverseDirection!: SwipeDirection;
  private reverseOptions!: SwipeOnResolvedOptions;
  private fallbackLogged = false;
  private readonly onSearchFallback = () => {
    if (!this.fallbackLogged) {
      logger.debug("[SwipeOn] lookFor using slow ADB swipe fallback (600ms, at most 75% viewport)");
      this.fallbackLogged = true;
    }
  };
  constructor(
    private readonly request: ScrollSearchRequest,
    private readonly deps: Pick<
      ScrollUntilVisibleDependencies,
      | "device"
      | "observeScreen"
      | "timer"
      | "captureDisplayFence"
      | "accessibilityDetector"
      | "adb"
      | "featureFlags"
      | "getDuration"
      | "captureTerminalObservationScreenshot"
    >,
    private readonly host: ScrollSearchOperations,
    private readonly perf: PerformanceTracker,
  ) {
    this.observe =
      request.strategy?.observe ??
      ((captureOptions) =>
        deps.observeScreen.execute({
          freshness: captureOptions?.freshness ?? "cached-ok",
          timeoutMs: captureOptions?.timeoutMs,
          skipScreenshot: true,
          skipAccessibilityAudit: true,
          signal: request.signal,
        }));
  }

  async execute(): Promise<SwipeOnResult> {
    await this.initialize();
    await this.initialSearch();
    if (this.foundElement) {
      return this.initialSuccess();
    }
    this.initializeLoop();
    while (
      this.deps.timer.now() - this.startTime < this.maxTime &&
      this.scrollIteration < this.maxSwipes
    ) {
      const step = this.createStep();
      const outcome = await this.dispatchStep(step);
      if (outcome.kind === "interrupted") {
        break;
      }
      if (outcome.kind === "failed") {
        return outcome.result;
      }
      await this.settleAndSearch();
      if (this.foundElement) {
        break;
      }
      const recoveryAttempted = await this.recoverAndSearch(step, outcome.failedAndroidSwipe);
      if (this.foundElement) {
        break;
      }
      const currentFingerprint = await this.recheckStaleObservation(recoveryAttempted);
      if (this.foundElement) {
        break;
      }
      await this.finishIteration({
        recoveryAttempted,
        currentFingerprint,
        failedAndroidSwipe: outcome.failedAndroidSwipe,
        chromeStartWarning: step.chromeStartWarning,
      });
    }
    return this.finish();
  }

  private async initialize(): Promise<void> {
    throwIfAborted(this.request.signal);
    logger.info(
      `[SwipeOn] Starting scroll-until-visible: direction=${this.request.options.direction}, lookFor=${JSON.stringify(this.request.options.lookFor)}`,
    );

    this.observationFence = this.request.strategy ? undefined : this.deps.captureDisplayFence?.();
    // Get initial observation
    this.lastObservation = await this.perf.track("initialObserve", async () =>
      freshSwipeHierarchy(
        await this.observe(),
        (timeoutMs) => this.observe({ freshness: "fresh", timeoutMs }),
        this.deps.timer,
        this.request.signal,
      ),
    );
    throwIfAborted(this.request.signal);
    if (!this.lastObservation.viewHierarchy || !this.lastObservation.screenSize) {
      throw new Error("Failed to get initial observation for scrolling until visible.");
    }

    // Find the scrollable container
    this.containerElement = await this.perf.track("findContainer", () =>
      this.host.findScrollableContainer(
        this.request.options,
        this.lastObservation,
        this.request.strategy
          ? this.host.screenBoundsContainer({
              observation: this.lastObservation,
              includeSystemInsets: this.request.options.includeSystemInsets,
            })
          : undefined,
      ),
    );

    logger.info(
      `[SwipeOn] Using container: bounds=${JSON.stringify(this.containerElement.bounds)}, scrollable=${this.containerElement.scrollable}`,
    );

    this.lookForOptions = this.host.resolveLookForOptions(
      this.request.options,
      this.containerElement,
      this.lastObservation,
    );
    this.maxTime = this.request.options.lookFor!.maxTime ?? 15000;
    this.maxSwipes = this.request.options.lookFor!.maxSwipes ?? Number.POSITIVE_INFINITY;
    this.startTime = this.deps.timer.now();
    this.foundElement = null;
    this.scrollIteration = 0;
    this.lastFingerprint = this.host.computeHierarchyFingerprint(
      this.lastObservation.viewHierarchy!,
    );
    this.unchangedScrollCount = 0;
    this.maxUnchangedScrolls = 1;

    this.scopeDescription = scopedSearchDescription(this.request.options);
    this.target = this.request.options.lookFor!.text
      ? `text "${this.request.options.lookFor!.text}"`
      : `element with id "${this.request.options.lookFor!.elementId}"`;
    logger.info(`[SwipeOn] Looking for ${this.target} with maxTime=${this.maxTime}ms`);

    // Check if TalkBack is enabled (not just any accessibility service)
    this.accessibilityWarnings = new Set<string>();
    this.isTalkBackEnabled = await this.perf.track("checkTalkBack", async () => {
      throwIfAborted(this.request.signal);
      if (this.request.strategy || this.deps.device.platform !== "android") {
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
        this.accessibilityWarnings.add(TALKBACK_STATE_UNKNOWN_WARNING);
      }
      return state === true;
    });
  }

  private async initialSearch(): Promise<void> {
    // First check if element is already visible within the container bounds
    this.foundElement = await this.perf.track("initialSearch", () =>
      this.host.findElementInHierarchy(
        this.request.options.lookFor!,
        this.lastObservation.viewHierarchy!,
        this.request.options.container,
        this.containerElement,
        this.request.options.layer,
      ),
    );

    if (
      this.foundElement &&
      !this.host.isElementWithinContainer(
        this.foundElement,
        this.containerElement.bounds,
        this.lastObservation,
      )
    ) {
      logger.info(
        `[SwipeOn] Found ${this.target} initially but it is outside container bounds (element center y=${Math.floor((this.foundElement.bounds.top + this.foundElement.bounds.bottom) / 2)}, container=${JSON.stringify(this.containerElement.bounds)}), will scroll`,
      );
      this.foundElement = null;
    }
  }

  private async initialSuccess(): Promise<SwipeOnResult> {
    if (!this.foundElement) {
      throw new Error("Initial search did not find an element");
    }
    logger.info(
      `[SwipeOn] Element already visible at bounds=${JSON.stringify(this.foundElement.bounds)}, no scrolling needed`,
    );

    // Set accessibility focus on found element if requested
    if (this.isTalkBackEnabled && this.request.options.focusTarget) {
      throwIfAborted(this.request.signal);
      await this.host.setAccessibilityFocusOnElement(this.foundElement, this.perf);
    }

    this.perf.end();
    throwIfAborted(this.request.signal);
    await this.deps.captureTerminalObservationScreenshot?.(this.lastObservation, this.perf);
    return {
      success: true,
      targetType: "element",
      element: this.foundElement,
      found: true,
      ...(this.accessibilityWarnings.size ? { warnings: [...this.accessibilityWarnings] } : {}),
      scrollIterations: 0,
      elapsedMs: this.deps.timer.now() - this.startTime,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      duration: 0,
      observation: this.lastObservation,
    };
  }

  private initializeLoop(): void {
    this.searchDragState = {};
    this.overlapRecoveryUsed = false;

    // Overshoot recovery state
    this.reverseMode = false;
    this.reverseDirection = oppositeDirection(this.request.options.direction);
    this.reverseOptions = { ...this.lookForOptions, speed: "slow" as const };
  }

  private createStep(): SearchStep {
    throwIfAborted(this.request.signal);
    this.scrollIteration++;
    logger.info(
      `[SwipeOn] Iteration ${this.scrollIteration}: elapsed=${this.deps.timer.now() - this.startTime}ms, reverseMode=${this.reverseMode}, unchangedScrollCount=${this.unchangedScrollCount}/${this.maxUnchangedScrolls}`,
    );

    // The container was resolved from the latest observation (initially above,
    // then after each settled swipe). Derive both directions from its bounds.
    const swipeCoordinates = this.host.resolveContainerSwipeCoordinates(
      this.request.options,
      this.lastObservation.viewHierarchy!,
      this.containerElement,
      this.lastObservation,
    );
    this.swipeWarning = swipeCoordinates.warning ?? this.swipeWarning;
    const reverseBounds = this.host.resolveReverseBounds(
      this.request.options,
      this.containerElement,
      this.lastObservation,
    );
    const reverseSwipeCoords = this.host.computeHalfScreenReverseCoords(
      this.reverseDirection,
      reverseBounds,
    );

    // Perform scroll
    const previousKeys = visibleScrollKeys(this.lastObservation, this.containerElement);
    const activeCoords =
      this.deps.device.platform === "android" && this.request.strategy && !this.reverseMode
        ? capLookForTravel(swipeCoordinates, reverseBounds)
        : this.reverseMode
          ? reverseSwipeCoords
          : swipeCoordinates;
    const activeDirection = this.reverseMode
      ? this.reverseDirection
      : this.request.options.direction;
    const activeDuration = this.deps.getDuration(
      this.request.strategy && this.deps.device.platform === "android"
        ? { ...this.lookForOptions, duration: undefined, speed: "slow" }
        : this.reverseMode
          ? this.reverseOptions
          : this.lookForOptions,
    );
    const { startX, startY, endX, endY } = activeCoords;
    const chromeStartWarning = iosSwipeStartWarning({
      observation: this.lastObservation,
      platform: this.deps.device.platform,
      startX: Math.floor(startX),
      startY: Math.floor(startY),
    });
    logger.info(
      `[SwipeOn] Swipe: direction=${activeDirection}, coords=(${Math.floor(startX)},${Math.floor(startY)})→(${Math.floor(endX)},${Math.floor(endY)}), duration=${activeDuration}ms`,
    );

    return {
      previousKeys,
      chromeStartWarning,
      dispatch: {
        coordinates: activeCoords,
        direction: activeDirection,
        duration: activeDuration,
        options: this.request.options,
        containerElement: this.containerElement,
        observation: this.lastObservation,
        observationFence: this.observationFence,
        strategy: this.request.strategy,
        scrollIteration: this.scrollIteration,
        perf: this.perf,
        progress: this.request.progress,
        signal: this.request.signal,
        onSearchFallback: this.onSearchFallback,
        searchDragState: this.searchDragState,
        swipes: this.request.swipes,
      },
    };
  }

  private async dispatchStep(step: SearchStep): Promise<SearchStepOutcome> {
    this.searchDragState.pagingStep = false;
    const swipeResult = await this.host.dispatchSearchSwipe(step.dispatch);
    throwIfAborted(this.request.signal);

    for (const warning of swipeResult.warnings ?? []) {
      this.accessibilityWarnings.add(warning);
    }
    if (swipeResult.observation?.viewHierarchy) {
      this.lastObservation = swipeResult.observation;
    }

    if (swipeResult.staleDisplay && !swipeResult.outcomeIndeterminate) {
      // The retained capture is validated, but the later read is not. It can
      // prove a match; it cannot authorize another swipe, even near timeout.
      this.interruptedDisplay = swipeResult.staleDisplay;
      this.foundElement = await this.host.matchInterruptedDisplaySearch(
        this.request.options,
        this.lastObservation,
        this.containerElement,
        this.interruptedDisplay,
      );
      return { kind: "interrupted" };
    }

    const iosFailure = await this.validateIosSwipe(swipeResult);
    if (iosFailure) {
      return { kind: "failed", result: iosFailure };
    }
    const failedAndroidSwipe = this.validateAndroidSwipe(swipeResult);

    // Update observation
    if (!swipeResult.observation?.viewHierarchy) {
      throw new Error("Lost observation after swipe during scroll until visible.");
    }

    return { kind: "continue", failedAndroidSwipe };
  }

  private async validateIosSwipe(swipeResult: SwipeResult): Promise<SwipeOnResult | undefined> {
    if (
      !swipeResult.success &&
      swipeResult.outcomeIndeterminate &&
      this.deps.device.platform === "ios"
    ) {
      // The swipe was dispatched but unconfirmed: report it, never `found: false`.
      this.perf.end();
      throw new ActionableError(
        `${swipeResult.error ?? "iOS scroll swipe outcome is indeterminate."} The scroll may have happened. Observe before retrying.`,
      );
    }

    if (!swipeResult.success && this.deps.device.platform === "ios") {
      this.perf.end();
      throwIfAborted(this.request.signal);
      await this.deps.captureTerminalObservationScreenshot?.(this.lastObservation, this.perf);
      return {
        ...swipeResult,
        targetType: "screen",
        found: false,
        scrollIterations: this.scrollIteration,
        elapsedMs: this.deps.timer.now() - this.startTime,
      };
    }

    return undefined;
  }

  private validateAndroidSwipe(swipeResult: SwipeResult): boolean {
    const failedAndroidSwipe = this.deps.device.platform === "android" && !swipeResult.success;
    if (failedAndroidSwipe) {
      const swipeError = swipeResult.error ?? "Android scroll swipe failed";
      if (swipeResult.outcomeIndeterminate) {
        this.perf.end();
        throw new ActionableError(
          `${swipeError} The scroll may have happened. Observe before retrying.`,
        );
      }
      if (this.lastAndroidSwipeError !== undefined || !swipeResult.observation?.viewHierarchy) {
        this.perf.end();
        throw new ActionableError(`Scroll swipe failed: ${swipeError}`);
      }
      // Preserve one transient rejection's observation/search, without treating it as scroll-end evidence.
      this.lastAndroidSwipeError = swipeError;
      logger.warn(`[SwipeOn] Scroll swipe failed; tolerating one rejection: ${swipeError}`);
    } else {
      this.lastAndroidSwipeError = undefined;
    }

    return failedAndroidSwipe;
  }

  private async settleAndSearch(): Promise<void> {
    // If the post-swipe fingerprint matches the pre-swipe fingerprint, the
    // observation likely returned stale cached data (the swipe gesture was
    // dispatched but the cache hadn't been invalidated yet) rather than
    // reflecting an actually-stationary list. This is the canonical signal
    // that the scroll-end detector below will misfire, so surface it loudly.
    const postSwipeFingerprint = this.host.computeHierarchyFingerprint(
      this.lastObservation.viewHierarchy!,
    );
    if (postSwipeFingerprint === this.lastFingerprint) {
      logger.warn(
        `[SwipeOn] iter=${this.scrollIteration} post-swipe fingerprint matches pre-swipe — ` +
          `observation may be stale (cache hit) or swipe had no visible effect`,
      );
    }

    // Wait for scroll animation to fully settle before inspecting the hierarchy.
    // The post-swipe observation may reflect a mid-scroll position (the accessibility service
    // can return a cached hierarchy captured before the fling decelerates to rest). Polling
    // until two consecutive fingerprints match ensures we evaluate lookFor against the final
    // idle state rather than a transient mid-scroll frame.
    const elapsedMs = this.deps.timer.now() - this.startTime;
    const idleCheckMaxMs = Math.min(1500, Math.max(0, this.maxTime - elapsedMs - 300));
    if (idleCheckMaxMs > 100) {
      this.lastObservation = await waitForScrollIdle(this.lastObservation, {
        observe: this.observe,
        timer: this.deps.timer,
        maxWaitMs: idleCheckMaxMs,
        pollIntervalMs: SCROLL_IDLE_POLL_INTERVAL_MS,
        logPrefix: "[SwipeOn]",
        signal: this.request.signal,
      });
    }

    this.foundElement = await this.host.findVisibleSearchTarget(
      this.request.options,
      this.lastObservation,
      this.containerElement,
    );
  }

  private async recoverAndSearch(step: SearchStep, failedAndroidSwipe: boolean): Promise<boolean> {
    let recoveryAttempted = false;

    // Only Android coordinate search steps retain overlap; paging and iOS do not.
    if (
      this.host.shouldGuardSearchStep({
        failedAndroidSwipe,
        reverseMode: this.reverseMode,
        overlapRecoveryUsed: this.overlapRecoveryUsed,
        searchDragState: this.searchDragState,
      })
    ) {
      const recovered = await this.host.recoverSearchObservation({
        previousKeys: step.previousKeys,
        observe: this.observe,
        deadline: this.startTime + this.maxTime,
        dispatch: { ...step.dispatch, observation: this.lastObservation },
        onRecovery: () => {
          recoveryAttempted = true;
          // One bounded recovery episode prevents ambiguous pages repeatedly undoing forward progress.
          this.overlapRecoveryUsed = true;
        },
      });
      this.lastObservation = recovered.observation;
      this.interruptedDisplay = recovered.staleDisplay;
    }

    if (recoveryAttempted) {
      this.foundElement = await this.host.findVisibleSearchTarget(
        this.request.options,
        this.lastObservation,
        this.containerElement,
      );
    }

    return recoveryAttempted;
  }

  private async recheckStaleObservation(recoveryAttempted: boolean): Promise<string> {
    // Check if hierarchy changed (detect scroll end)
    let currentFingerprint = this.host.computeHierarchyFingerprint(
      this.lastObservation.viewHierarchy!,
    );
    if (
      !recoveryAttempted &&
      currentFingerprint === this.lastFingerprint &&
      this.lastObservation.freshness?.isFresh === false
    ) {
      logger.info(
        `[SwipeOn] Iteration ${this.scrollIteration}: stale unchanged observation; re-observing once before scroll-end decision`,
      );
      this.lastObservation = await this.observe();
      currentFingerprint = this.host.computeHierarchyFingerprint(
        this.lastObservation.viewHierarchy!,
      );
      this.foundElement = await this.host.findVisibleSearchTarget(
        this.request.options,
        this.lastObservation,
        this.containerElement,
      );
    }
    return currentFingerprint;
  }

  private async finishIteration({
    recoveryAttempted,
    currentFingerprint,
    failedAndroidSwipe,
    chromeStartWarning,
  }: {
    recoveryAttempted: boolean;
    currentFingerprint: string;
    failedAndroidSwipe: boolean;
    chromeStartWarning?: string;
  }): Promise<void> {
    // A guard-restored page is not evidence that the forward step reached the end.
    const fingerprintChanged = recoveryAttempted || currentFingerprint !== this.lastFingerprint;
    logger.info(
      `[SwipeOn] Iteration ${this.scrollIteration}: hierarchy ${fingerprintChanged ? "changed" : "UNCHANGED"} (fingerprint[0:40]="${currentFingerprint.slice(0, 40)}")`,
    );

    // The settled (or corroborating) observation also owns the target bounds
    // checked below. Keep the previous container when this frame omits it.
    this.containerElement = await this.host.findScrollableContainer(
      this.request.options,
      this.lastObservation,
      this.containerElement,
    );

    if (!fingerprintChanged && chromeStartWarning) {
      this.perf.end();
      throw new ActionableError(
        `${chromeStartWarning} Cannot determine end of container from this swipe. Retry without includeSystemInsets.`,
      );
    }

    // A second stale unchanged capture is still not end-of-list evidence.
    if (
      !failedAndroidSwipe &&
      !fingerprintChanged &&
      this.lastObservation.freshness?.isFresh !== false
    ) {
      this.unchangedScrollCount++;
      logger.info(
        `[SwipeOn] Iteration ${this.scrollIteration}: unchanged count now ${this.unchangedScrollCount}/${this.maxUnchangedScrolls}`,
      );

      if (this.unchangedScrollCount >= this.maxUnchangedScrolls) {
        this.host.checkReverseExhausted(this.reverseMode, {
          perf: this.perf,
          startTime: this.startTime,
          maxUnchangedScrolls: this.maxUnchangedScrolls,
          target: this.target,
          scopeDescription: this.scopeDescription,
          scrollIteration: this.scrollIteration,
        });
        // Switch to reverse half-screen recovery
        this.reverseMode = true;
        this.unchangedScrollCount = 0;
        logger.info(
          `[SwipeOn] Reached end in forward direction without finding ${this.target}, switching to reverse half-screen recovery`,
        );
      }
    } else if (fingerprintChanged) {
      this.unchangedScrollCount = 0;
      this.lastFingerprint = currentFingerprint;
    }

    logger.info(`[SwipeOn] Iteration ${this.scrollIteration}: ${this.target} not yet found`);
  }

  private async finish(): Promise<SwipeOnResult> {
    if (!this.foundElement) {
      throwIfAborted(this.request.signal);
      this.perf.end();
      const elapsed = this.deps.timer.now() - this.startTime;
      if (this.lastAndroidSwipeError !== undefined) {
        throw new ActionableError(`Scroll swipe failed: ${this.lastAndroidSwipeError}`);
      }
      throw new ActionableError(
        `${this.target} not found${this.scopeDescription} after scrolling for ${elapsed}ms (${this.scrollIteration} iterations, timeout=${this.maxTime}ms).`,
      );
    }

    // Set accessibility focus on found element if requested
    if (this.isTalkBackEnabled && this.request.options.focusTarget) {
      throwIfAborted(this.request.signal);
      await this.host.setAccessibilityFocusOnElement(this.foundElement, this.perf);
    }

    this.perf.end();
    throwIfAborted(this.request.signal);
    await this.deps.captureTerminalObservationScreenshot?.(this.lastObservation, this.perf);
    return {
      success: true,
      targetType: "element",
      element: this.foundElement,
      found: true,
      scrollIterations: this.scrollIteration,
      elapsedMs: this.deps.timer.now() - this.startTime,
      observation: this.lastObservation,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      duration: 0,
      warning: this.swipeWarning,
      ...(this.accessibilityWarnings.size ? { warnings: [...this.accessibilityWarnings] } : {}),
      ...(this.interruptedDisplay ? { staleDisplay: this.interruptedDisplay } : {}),
    };
  }
}
