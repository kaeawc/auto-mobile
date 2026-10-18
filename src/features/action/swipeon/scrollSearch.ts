import {
  ActionableError,
  type Element,
  type SwipeOnResult,
  type SwipeResult,
} from "../../../models";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { logger } from "../../../utils/logger";
import { waitForScrollIdle } from "../../../utils/scrollIdle";
import { throwIfAborted } from "../../../utils/toolUtils";
import { TALKBACK_STATE_UNKNOWN_WARNING } from "../../accessibility/interfaces/AccessibilityDetector";
import type { StaleDisplayDetails } from "../../observe/StaleDisplayError";
import { freshSwipeHierarchy } from "./freshSwipeHierarchy";
import { iosSwipeStartWarning } from "./iosChromeInsets";
import { capLookForTravel, oppositeDirection, visibleScrollKeys } from "./lookForScroll";
import { scopedSearchDescription } from "./swipeSelectorScopes";
import type {
  ScrollSearchArgs,
  ScrollSearchContext,
  ScrollSearchOperations,
  ScrollSearchState,
  ScrollSearchIterationState,
  SearchCoordinates,
  SearchSwipeDispatchOptions,
} from "./scrollSearchTypes";

interface SearchStep {
  coordinates: SearchCoordinates;
  direction: SearchSwipeDispatchOptions["direction"];
  duration: number;
  previousKeys: Map<string, number>;
  chromeStartWarning?: string;
}

function createSearchObserver(context: ScrollSearchContext): ScrollSearchState["observe"] {
  const { strategy, signal } = context;
  return (
    strategy?.observe ??
    ((captureOptions?: { freshness: "fresh"; timeoutMs: number }) =>
      context.deps.observeScreen.execute({
        freshness: captureOptions?.freshness ?? "cached-ok",
        timeoutMs: captureOptions?.timeoutMs,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        signal,
      }))
  );
}

async function observeInitialSearch(context: ScrollSearchContext) {
  const { options, perf, signal, strategy } = context;
  const observe = createSearchObserver(context);
  throwIfAborted(signal);
  logger.info(
    `[SwipeOn] Starting scroll-until-visible: direction=${options.direction}, lookFor=${JSON.stringify(options.lookFor)}`,
  );

  const observationFence = strategy ? undefined : context.deps.captureDisplayFence?.();
  // Get initial observation
  const lastObservation = await perf.track("initialObserve", async () =>
    freshSwipeHierarchy(
      await observe(),
      (timeoutMs) => observe({ freshness: "fresh", timeoutMs }),
      context.deps.timer,
      signal,
    ),
  );
  throwIfAborted(signal);
  if (!lastObservation.viewHierarchy || !lastObservation.screenSize) {
    throw new Error("Failed to get initial observation for scrolling until visible.");
  }

  return { observe, observationFence, lastObservation };
}

function searchFallbackLogger(): () => void {
  let fallbackLogged = false;
  const onSearchFallback = () => {
    if (!fallbackLogged) {
      logger.debug("[SwipeOn] lookFor using slow ADB swipe fallback (600ms, at most 75% viewport)");
      fallbackLogged = true;
    }
  };

  return onSearchFallback;
}

async function createSearchState(context: ScrollSearchContext): Promise<ScrollSearchState> {
  const { options, perf, strategy } = context;
  const { observe, observationFence, lastObservation } = await observeInitialSearch(context);
  // Find the scrollable container
  const containerElement = await perf.track("findContainer", () =>
    context.findScrollableContainer(
      options,
      lastObservation,
      strategy
        ? context.screenBoundsContainer({
            observation: lastObservation,
            includeSystemInsets: options.includeSystemInsets,
          })
        : undefined,
    ),
  );

  logger.info(
    `[SwipeOn] Using container: bounds=${JSON.stringify(containerElement.bounds)}, scrollable=${containerElement.scrollable}`,
  );

  const lookForOptions = context.resolveLookForOptions(options, containerElement, lastObservation);

  const onSearchFallback = searchFallbackLogger();
  const maxTime = options.lookFor!.maxTime ?? 15000;
  const maxSwipes = options.lookFor!.maxSwipes ?? Number.POSITIVE_INFINITY;
  const startTime = context.deps.timer.now();
  const foundElement: Element | null = null;
  const scrollIteration = 0;
  const lastFingerprint = context.computeHierarchyFingerprint(lastObservation.viewHierarchy!);
  const unchangedScrollCount = 0;
  const maxUnchangedScrolls = 1;

  const scopeDescription = scopedSearchDescription(options);
  const target = options.lookFor!.text
    ? `text "${options.lookFor!.text}"`
    : `element with id "${options.lookFor!.elementId}"`;
  logger.info(`[SwipeOn] Looking for ${target} with maxTime=${maxTime}ms`);

  return {
    observe,
    observationFence,
    lastObservation,
    containerElement,
    lookForOptions,
    onSearchFallback,
    maxTime,
    maxSwipes,
    startTime,
    foundElement,
    scrollIteration,
    lastFingerprint,
    unchangedScrollCount,
    maxUnchangedScrolls,
    scopeDescription,
    target,
    accessibilityWarnings: new Set<string>(),
  };
}

async function checkSearchTalkBack(
  context: ScrollSearchContext,
  state: ScrollSearchState,
): Promise<boolean> {
  const { perf, signal, strategy } = context;
  return await perf.track("checkTalkBack", async () => {
    throwIfAborted(signal);
    if (strategy || context.deps.device.platform !== "android") {
      return false;
    }
    // Pass the real ADB executor (not null) so TalkBack detection works on a
    // cold/expired cache instead of silently reporting "not talkback" (#3915).
    // Pass featureFlags so `force-accessibility-mode` / `accessibility-auto-detect`
    // apply to scroll detection uniformly with the observe path (#3925).
    const talkBackState = await context.deps.accessibilityDetector.resolveTalkBackState(
      context.deps.device.deviceId,
      context.deps.adb,
      context.deps.featureFlags,
    );
    if (talkBackState === null) {
      state.accessibilityWarnings.add(TALKBACK_STATE_UNKNOWN_WARNING);
    }
    return talkBackState === true;
  });
}

async function locateInitialTarget(
  context: ScrollSearchContext,
  state: ScrollSearchState,
): Promise<void> {
  const { options, perf } = context;
  // First check if element is already visible within the container bounds
  state.foundElement = await perf.track("initialSearch", () =>
    context.findElementInHierarchy(
      options.lookFor!,
      state.lastObservation.viewHierarchy!,
      options.container,
      state.containerElement,
      options.layer,
    ),
  );
  if (
    state.foundElement &&
    !context.isElementWithinContainer(
      state.foundElement,
      state.containerElement.bounds,
      state.lastObservation,
    )
  ) {
    logger.info(
      `[SwipeOn] Found ${state.target} initially but it is outside container bounds (element center y=${Math.floor((state.foundElement.bounds.top + state.foundElement.bounds.bottom) / 2)}, container=${JSON.stringify(state.containerElement.bounds)}), will scroll`,
    );
    state.foundElement = null;
  }
}

async function finishInitialSearch(
  context: ScrollSearchContext,
  state: ScrollSearchState,
  isTalkBackEnabled: boolean,
  foundElement: Element,
): Promise<SwipeOnResult> {
  const { options, perf, signal } = context;
  logger.info(
    `[SwipeOn] Element already visible at bounds=${JSON.stringify(foundElement.bounds)}, no scrolling needed`,
  );
  // Set accessibility focus on found element if requested
  if (isTalkBackEnabled && options.focusTarget) {
    throwIfAborted(signal);
    await context.setAccessibilityFocusOnElement(foundElement, perf);
  }
  perf.end();
  throwIfAborted(signal);
  await context.deps.captureTerminalObservationScreenshot?.(state.lastObservation, perf);
  return {
    success: true,
    targetType: "element",
    element: foundElement,
    found: true,
    ...(state.accessibilityWarnings.size ? { warnings: [...state.accessibilityWarnings] } : {}),
    scrollIterations: 0,
    elapsedMs: context.deps.timer.now() - state.startTime,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    duration: 0,
    observation: state.lastObservation,
  };
}

function createIterationState(
  context: ScrollSearchContext,
  state: ScrollSearchState,
): ScrollSearchIterationState {
  // Overshoot recovery is initialized only after the initial visible-target path.
  const reverseDirection = oppositeDirection(context.options.direction);
  const reverseOptions = { ...state.lookForOptions, speed: "slow" as const };
  return {
    ...state,
    searchDragState: {},
    overlapRecoveryUsed: false,
    reverseMode: false,
    reverseDirection,
    reverseOptions,
  };
}

function prepareSearchStep(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
): SearchStep {
  const { options, signal, strategy } = context;
  throwIfAborted(signal);
  state.scrollIteration++;
  logger.info(
    `[SwipeOn] Iteration ${state.scrollIteration}: elapsed=${context.deps.timer.now() - state.startTime}ms, reverseMode=${state.reverseMode}, unchangedScrollCount=${state.unchangedScrollCount}/${state.maxUnchangedScrolls}`,
  );
  // The container was resolved from the latest observation (initially above,
  // then after each settled swipe). Derive both directions from its bounds.
  const swipeCoordinates = context.resolveContainerSwipeCoordinates(
    options,
    state.lastObservation.viewHierarchy!,
    state.containerElement,
    state.lastObservation,
  );
  state.swipeWarning = swipeCoordinates.warning ?? state.swipeWarning;
  const reverseBounds = context.resolveReverseBounds(
    options,
    state.containerElement,
    state.lastObservation,
  );
  const reverseSwipeCoords = context.computeHalfScreenReverseCoords(
    state.reverseDirection,
    reverseBounds,
  );
  // Perform scroll
  const previousKeys = visibleScrollKeys(state.lastObservation, state.containerElement);
  const activeCoords =
    context.deps.device.platform === "android" && strategy && !state.reverseMode
      ? capLookForTravel(swipeCoordinates, reverseBounds)
      : state.reverseMode
        ? reverseSwipeCoords
        : swipeCoordinates;
  const activeDirection = state.reverseMode ? state.reverseDirection : options.direction;
  const activeDuration = context.deps.getDuration(
    strategy && context.deps.device.platform === "android"
      ? { ...state.lookForOptions, duration: undefined, speed: "slow" }
      : state.reverseMode
        ? state.reverseOptions
        : state.lookForOptions,
  );
  const { startX, startY, endX, endY } = activeCoords;
  const chromeStartWarning = iosSwipeStartWarning({
    observation: state.lastObservation,
    platform: context.deps.device.platform,
    startX: Math.floor(startX),
    startY: Math.floor(startY),
  });
  logger.info(
    `[SwipeOn] Swipe: direction=${activeDirection}, coords=(${Math.floor(startX)},${Math.floor(startY)})→(${Math.floor(endX)},${Math.floor(endY)}), duration=${activeDuration}ms`,
  );
  return {
    coordinates: activeCoords,
    direction: activeDirection,
    duration: activeDuration,
    previousKeys,
    chromeStartWarning,
  };
}

function searchDispatchOptions(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  step: SearchStep,
): SearchSwipeDispatchOptions {
  const { options, perf, progress, signal, strategy } = context;
  return {
    coordinates: step.coordinates,
    direction: step.direction,
    duration: step.duration,
    options,
    containerElement: state.containerElement,
    observation: state.lastObservation,
    observationFence: state.observationFence,
    strategy,
    scrollIteration: state.scrollIteration,
    perf,
    progress,
    signal,
    onSearchFallback: state.onSearchFallback,
    searchDragState: state.searchDragState,
    swipes: context.swipes,
  };
}

function retainSwipeObservation(state: ScrollSearchIterationState, swipeResult: SwipeResult): void {
  for (const warning of swipeResult.warnings ?? []) {
    state.accessibilityWarnings.add(warning);
  }
  if (swipeResult.observation?.viewHierarchy) {
    state.lastObservation = swipeResult.observation;
  }
}

async function matchInterruptedSearch(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  details: StaleDisplayDetails,
): Promise<void> {
  // The retained capture can prove a match, but cannot authorize another swipe.
  state.interruptedDisplay = details;
  state.foundElement = await context.matchInterruptedDisplaySearch(
    context.options,
    state.lastObservation,
    state.containerElement,
    state.interruptedDisplay,
  );
}

async function handleIosSwipeFailure(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  swipeResult: SwipeResult,
): Promise<SwipeOnResult> {
  const { perf, signal } = context;
  if (swipeResult.outcomeIndeterminate) {
    // The swipe was dispatched but unconfirmed: report it, never `found: false`.
    perf.end();
    throw new ActionableError(
      `${swipeResult.error ?? "iOS scroll swipe outcome is indeterminate."} The scroll may have happened. Observe before retrying.`,
    );
  }
  perf.end();
  throwIfAborted(signal);
  await context.deps.captureTerminalObservationScreenshot?.(state.lastObservation, perf);
  return {
    ...swipeResult,
    targetType: "screen",
    found: false,
    scrollIterations: state.scrollIteration,
    elapsedMs: context.deps.timer.now() - state.startTime,
  };
}

function handleAndroidSwipeFailure(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  swipeResult: SwipeResult,
): boolean {
  const { perf } = context;
  const failedAndroidSwipe = context.deps.device.platform === "android" && !swipeResult.success;
  if (failedAndroidSwipe) {
    const swipeError = swipeResult.error ?? "Android scroll swipe failed";
    if (swipeResult.outcomeIndeterminate) {
      perf.end();
      throw new ActionableError(
        `${swipeError} The scroll may have happened. Observe before retrying.`,
      );
    }
    if (state.lastAndroidSwipeError !== undefined || !swipeResult.observation?.viewHierarchy) {
      perf.end();
      throw new ActionableError(`Scroll swipe failed: ${swipeError}`);
    }
    // Preserve one transient rejection's observation/search, without treating it as scroll-end evidence.
    state.lastAndroidSwipeError = swipeError;
    logger.warn(`[SwipeOn] Scroll swipe failed; tolerating one rejection: ${swipeError}`);
  } else {
    state.lastAndroidSwipeError = undefined;
  }
  return failedAndroidSwipe;
}

async function settleSearchObservation(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  swipeResult: SwipeResult,
): Promise<void> {
  const { signal } = context;
  // Update observation
  if (!swipeResult.observation?.viewHierarchy) {
    throw new Error("Lost observation after swipe during scroll until visible.");
  }
  // If the post-swipe fingerprint matches the pre-swipe fingerprint, the
  // observation likely returned stale cached data (the swipe gesture was
  // dispatched but the cache hadn't been invalidated yet) rather than
  // reflecting an actually-stationary list. This is the canonical signal
  // that the scroll-end detector below will misfire, so surface it loudly.
  const postSwipeFingerprint = context.computeHierarchyFingerprint(
    state.lastObservation.viewHierarchy!,
  );
  if (postSwipeFingerprint === state.lastFingerprint) {
    logger.warn(
      `[SwipeOn] iter=${state.scrollIteration} post-swipe fingerprint matches pre-swipe — ` +
        `observation may be stale (cache hit) or swipe had no visible effect`,
    );
  }
  // Wait for scroll animation to fully settle before inspecting the hierarchy.
  // The post-swipe observation may reflect a mid-scroll position (the accessibility service
  // can return a cached hierarchy captured before the fling decelerates to rest). Polling
  // until two consecutive fingerprints match ensures we evaluate lookFor against the final
  // idle state rather than a transient mid-scroll frame.
  const elapsedMs = context.deps.timer.now() - state.startTime;
  const idleCheckMaxMs = Math.min(1500, Math.max(0, state.maxTime - elapsedMs - 300));
  if (idleCheckMaxMs > 100) {
    state.lastObservation = await waitForScrollIdle(state.lastObservation, {
      observe: state.observe,
      timer: context.deps.timer,
      maxWaitMs: idleCheckMaxMs,
      pollIntervalMs: 150,
      logPrefix: "[SwipeOn]",
      signal,
    });
  }
}

async function recoverSearchStep(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  step: SearchStep,
  failedAndroidSwipe: boolean,
): Promise<boolean> {
  let recoveryAttempted = false;
  // Only Android coordinate search steps retain overlap; paging and iOS do not.
  if (
    context.shouldGuardSearchStep({
      failedAndroidSwipe,
      reverseMode: state.reverseMode,
      overlapRecoveryUsed: state.overlapRecoveryUsed,
      searchDragState: state.searchDragState,
    })
  ) {
    const recovered = await context.recoverSearchObservation({
      previousKeys: step.previousKeys,
      observe: state.observe,
      deadline: state.startTime + state.maxTime,
      dispatch: searchDispatchOptions(context, state, step),
      onRecovery: () => {
        recoveryAttempted = true;
        // One bounded recovery episode prevents ambiguous pages repeatedly undoing forward progress.
        state.overlapRecoveryUsed = true;
      },
    });
    state.lastObservation = recovered.observation;
    state.interruptedDisplay = recovered.staleDisplay;
  }
  return recoveryAttempted;
}
async function locateSearchTarget(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
): Promise<boolean> {
  state.foundElement = await context.findVisibleSearchTarget(
    context.options,
    state.lastObservation,
    state.containerElement,
  );
  return Boolean(state.foundElement);
}

async function corroborateSearchBoundary(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  recoveryAttempted: boolean,
): Promise<string> {
  const { options } = context;
  // Check if hierarchy changed (detect scroll end)
  let currentFingerprint = context.computeHierarchyFingerprint(
    state.lastObservation.viewHierarchy!,
  );
  if (
    !recoveryAttempted &&
    currentFingerprint === state.lastFingerprint &&
    state.lastObservation.freshness?.isFresh === false
  ) {
    logger.info(
      `[SwipeOn] Iteration ${state.scrollIteration}: stale unchanged observation; re-observing once before scroll-end decision`,
    );
    state.lastObservation = await state.observe();
    currentFingerprint = context.computeHierarchyFingerprint(state.lastObservation.viewHierarchy!);
    state.foundElement = await context.findVisibleSearchTarget(
      options,
      state.lastObservation,
      state.containerElement,
    );
    if (state.foundElement) {
      return currentFingerprint;
    }
  }
  return currentFingerprint;
}

async function updateSearchBoundary(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  step: SearchStep,
  evidence: {
    currentFingerprint: string;
    recoveryAttempted: boolean;
    failedAndroidSwipe: boolean;
  },
): Promise<void> {
  const { options, perf } = context;
  const { chromeStartWarning } = step;
  const { currentFingerprint, recoveryAttempted, failedAndroidSwipe } = evidence;
  // A guard-restored page is not evidence that the forward step reached the end.
  const fingerprintChanged = recoveryAttempted || currentFingerprint !== state.lastFingerprint;
  logger.info(
    `[SwipeOn] Iteration ${state.scrollIteration}: hierarchy ${fingerprintChanged ? "changed" : "UNCHANGED"} (fingerprint[0:40]="${currentFingerprint.slice(0, 40)}")`,
  );
  // The settled (or corroborating) observation also owns the target bounds
  // checked below. Keep the previous container when this frame omits it.
  state.containerElement = await context.findScrollableContainer(
    options,
    state.lastObservation,
    state.containerElement,
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
    state.lastObservation.freshness?.isFresh !== false
  ) {
    state.unchangedScrollCount++;
    logger.info(
      `[SwipeOn] Iteration ${state.scrollIteration}: unchanged count now ${state.unchangedScrollCount}/${state.maxUnchangedScrolls}`,
    );
    if (state.unchangedScrollCount >= state.maxUnchangedScrolls) {
      checkReverseExhausted(context, state);
      // Switch to reverse half-screen recovery
      state.reverseMode = true;
      state.unchangedScrollCount = 0;
      logger.info(
        `[SwipeOn] Reached end in forward direction without finding ${state.target}, switching to reverse half-screen recovery`,
      );
    }
  } else if (fingerprintChanged) {
    state.unchangedScrollCount = 0;
    state.lastFingerprint = currentFingerprint;
  }
  logger.info(`[SwipeOn] Iteration ${state.scrollIteration}: ${state.target} not yet found`);
}

function checkReverseExhausted(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
): void {
  const { perf } = context;
  if (state.reverseMode) {
    // Reverse also exhausted — element truly not found
    perf.end();
    const elapsed = context.deps.timer.now() - state.startTime;
    throw new ActionableError(
      `Scroll reached end of container (no change after ${state.maxUnchangedScrolls} scrolls). ` +
        `${state.target} not found${state.scopeDescription} after ${state.scrollIteration} iterations (${elapsed}ms).`,
    );
  }
}

async function finishScrolledSearch(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
  isTalkBackEnabled: boolean,
): Promise<SwipeOnResult> {
  const { options, perf, signal } = context;
  if (!state.foundElement) {
    throwIfAborted(signal);
    perf.end();
    const elapsed = context.deps.timer.now() - state.startTime;
    if (state.lastAndroidSwipeError !== undefined) {
      throw new ActionableError(`Scroll swipe failed: ${state.lastAndroidSwipeError}`);
    }
    throw new ActionableError(
      `${state.target} not found${state.scopeDescription} after scrolling for ${elapsed}ms (${state.scrollIteration} iterations, timeout=${state.maxTime}ms).`,
    );
  }
  // Set accessibility focus on found element if requested
  if (isTalkBackEnabled && options.focusTarget) {
    throwIfAborted(signal);
    await context.setAccessibilityFocusOnElement(state.foundElement, perf);
  }
  perf.end();
  throwIfAborted(signal);
  await context.deps.captureTerminalObservationScreenshot?.(state.lastObservation, perf);
  return {
    success: true,
    targetType: "element",
    element: state.foundElement,
    found: true,
    scrollIterations: state.scrollIteration,
    elapsedMs: context.deps.timer.now() - state.startTime,
    observation: state.lastObservation,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    duration: 0,
    warning: state.swipeWarning,
    ...(state.accessibilityWarnings.size ? { warnings: [...state.accessibilityWarnings] } : {}),
    ...(state.interruptedDisplay ? { staleDisplay: state.interruptedDisplay } : {}),
  };
}

async function searchIteration(
  context: ScrollSearchContext,
  state: ScrollSearchIterationState,
): Promise<SwipeOnResult | "stop" | undefined> {
  const step = prepareSearchStep(context, state);
  state.searchDragState.pagingStep = false;
  const swipeResult = await context.dispatchSearchSwipe(
    searchDispatchOptions(context, state, step),
  );
  throwIfAborted(context.signal);
  retainSwipeObservation(state, swipeResult);
  if (swipeResult.staleDisplay && !swipeResult.outcomeIndeterminate) {
    await matchInterruptedSearch(context, state, swipeResult.staleDisplay);
    return "stop";
  }
  if (!swipeResult.success && context.deps.device.platform === "ios") {
    return handleIosSwipeFailure(context, state, swipeResult);
  }
  const failedAndroidSwipe = handleAndroidSwipeFailure(context, state, swipeResult);
  await settleSearchObservation(context, state, swipeResult);
  if (await locateSearchTarget(context, state)) {
    return "stop";
  }
  const recoveryAttempted = await recoverSearchStep(context, state, step, failedAndroidSwipe);
  if (recoveryAttempted && (await locateSearchTarget(context, state))) {
    return "stop";
  }
  const currentFingerprint = await corroborateSearchBoundary(context, state, recoveryAttempted);
  if (state.foundElement) {
    return "stop";
  }
  await updateSearchBoundary(context, state, step, {
    currentFingerprint,
    recoveryAttempted,
    failedAndroidSwipe,
  });
  return undefined;
}

export async function executeScrollSearch(
  operations: ScrollSearchOperations,
  args: ScrollSearchArgs,
): Promise<SwipeOnResult> {
  const { perf = new NoOpPerformanceTracker() } = args;
  const context: ScrollSearchContext = { ...operations, ...args, perf };
  const initialState = await createSearchState(context);
  const isTalkBackEnabled = await checkSearchTalkBack(context, initialState);
  await locateInitialTarget(context, initialState);
  if (initialState.foundElement) {
    return finishInitialSearch(context, initialState, isTalkBackEnabled, initialState.foundElement);
  }
  const state = createIterationState(context, initialState);
  while (
    context.deps.timer.now() - state.startTime < state.maxTime &&
    state.scrollIteration < state.maxSwipes
  ) {
    const result = await searchIteration(context, state);
    if (result === "stop") {
      break;
    }
    if (result) {
      return result;
    }
  }
  return finishScrolledSearch(context, state, isTalkBackEnabled);
}
