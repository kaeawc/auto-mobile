import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";
import { ANDROID_PRE_TAP_BOUNDS_EPSILON_PX } from "./tapFocusIdentity";
import {
  ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS,
  ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS,
} from "./freshTapHierarchy";
import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import { Element, ElementSelectionResult, ObserveResult, ViewHierarchyResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { type Timer } from "../../utils/SystemTimer";
import { boundsNearlyEqual } from "../../utils/bounds";
import { androidPreTapConsecutiveStableMatchesRequired } from "./androidPreTapStablePolicy";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../utils/androidTransientLoading";

export const ANDROID_PRE_TAP_REFIND_BUDGET_MS = 2500;
export const ANDROID_PRE_TAP_REFIND_MIN_POLLS = 8;
export const ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING = 10000;

/** Android pre-tap stable-target resolution, extracted from TapOnElement (#11833). */

/**
 * Android: the pre-tap refresh + re-find + stability loop keeps polling until BOTH
 * a minimum number of productive polls AND a wall-clock deadline are exceeded
 * (`refindAttempt >= minPolls && productiveElapsed >= budgetMs`).
 *
 * Two bounds, because neither alone is sufficient:
 * - The **wall-clock deadline** adds patience when fetches are fast: a fixed
 *   "N attempts × poll delay" budget expires in ~1.2s and can miss a list that
 *   repopulates a few seconds later (#1949).
 * - The **minimum productive-poll floor** prevents a regression in the opposite
 *   regime: on a slow device where each hierarchy fetch costs 300–800ms, a pure
 *   wall-clock budget would allow only ~3–5 polls, fewer than the old fixed 8.
 *   The floor guarantees we never poll *fewer* times than the previous
 *   attempt-count implementation, so this change is never less patient.
 *
 * Only *productive* polls count toward the floor and only *productive* wall-clock
 * counts toward the deadline: time spent recovering from "no hierarchy" responses
 * is excluded (see {@link ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE}).
 */

/**
 * Extended deadline + poll floor (hard ceilings) applied when the tree shows a
 * blocking loading overlay (progress/shimmer). List rows can stay absent for
 * several seconds while content loads; give the re-find loop more wall-clock time
 * and more guaranteed polls before aborting.
 */
const ANDROID_PRE_TAP_REFIND_MIN_POLLS_WHEN_LOADING = 32;

/**
 * Defensive upper bound on total loop iterations (productive + no-hierarchy +
 * deadline-grace). Real scenarios terminate far sooner via the deadline/floor,
 * the {@link ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE} cap, or finding the
 * target; this only guards against a future refactor making the loop spin when
 * the injected timer stops advancing.
 */
const ANDROID_PRE_TAP_MAX_ITERATIONS = 1000;

/**
 * Separate budget for consecutive "ctrl-proxy returned no hierarchy" results.
 * When the accessibility service WebSocket is temporarily unresponsive, these
 * shouldn't consume the normal refind attempts (the element is likely still there).
 */
const ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE = 12;

/**
 * Longer backoff when ctrl-proxy returns no hierarchy — gives the WebSocket
 * time to recover rather than hammering it every 150ms.
 */

const ANDROID_PRE_TAP_REFIND_DELAY_MS = 150;

export type StableTapTargetResult =
  | {
      ok: true;
      viewHierarchy: ViewHierarchyResult;
      tapElement: Element;
      usedParent: boolean;
      selection: ElementSelectionResult;
    }
  | { ok: false; error: string };

/** What the stable-target loop needs from the owning tap action (seams tests override). */
export interface StableTapTargetDeps {
  readonly timer: Timer;
  readonly elementParser: ElementParser;
  readonly findElementInHierarchy: (
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ) => { selection: ElementSelectionResult; containerFound: boolean };
  readonly resolveTapTargetElement: (
    element: Element,
    hierarchy: ViewHierarchyResult,
    action: TapOnElementOptions["action"],
    options: { requireResourceId: boolean; scoped: boolean },
  ) => { element: Element; usedParent: boolean };
  readonly staleSyntheticTarget: (
    original: Element | null,
    previous: ViewHierarchyResult | undefined,
    current: ViewHierarchyResult,
  ) => string | undefined;
  readonly tapVerificationRefresh: (context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }) => AndroidTapVerification["refresh"];
  readonly withObservationScreenSize: (
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ) => TapVerificationOptions;
}

type StableTapCandidate = Omit<Extract<StableTapTargetResult, { ok: true }>, "ok">;

interface StableTapPollingState {
  prevBounds: Element["bounds"] | null;
  consecutiveStable: number;
  best: StableTapCandidate | null;
  startTime: number;
  // Exclude failed refreshes and recovery sleeps from the productive deadline.
  noHierarchyTimeMs: number;
  budgetMs: number;
  minProductivePolls: number;
  consecutiveNoHierarchy: number;
  refindAttempt: number;
  firstIteration: boolean;
  iterations: number;
  deadlineGracePolls: number;
}

interface StableTapContext {
  options: TapVerificationOptions;
  observeResult: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>;
  action: TapOnElementOptions["action"];
  requireResourceId: boolean;
  original: Element | null;
  stableMatchesRequired: number;
}

function findOriginalTapElement(
  deps: StableTapTargetDeps,
  options: TapVerificationOptions,
  observeResult: StableTapContext["observeResult"],
): Element | null {
  const selection = observeResult.viewHierarchy
    ? deps.findElementInHierarchy(options, observeResult.viewHierarchy).selection
    : null;
  return selection?.matchedElement ?? selection?.element ?? null;
}

function shouldContinuePolling(
  state: StableTapPollingState,
  timer: Timer,
  stableMatchesRequired: number,
): boolean {
  if (++state.iterations > ANDROID_PRE_TAP_MAX_ITERATIONS) {
    return false;
  }

  // Both the productive-poll floor and wall-clock deadline must be exhausted.
  const productiveElapsedMs = timer.now() - state.startTime - state.noHierarchyTimeMs;
  const budgetExhausted =
    state.refindAttempt >= state.minProductivePolls && productiveElapsedMs >= state.budgetMs;
  const midStabilityRun =
    state.best !== null &&
    state.consecutiveStable > 0 &&
    state.consecutiveStable < stableMatchesRequired;
  if (!state.firstIteration && state.consecutiveNoHierarchy === 0 && budgetExhausted) {
    // Bounded extra polls can finish confirming an already-stable candidate.
    if (midStabilityRun && state.deadlineGracePolls > 0) {
      state.deadlineGracePolls--;
    } else {
      return false;
    }
  }
  return true;
}

function recordMissingHierarchy(
  state: StableTapPollingState,
  timer: Timer,
  refreshStart: number,
): StableTapTargetResult | undefined {
  // Exclude the failed refresh itself, not just its subsequent recovery sleep.
  state.noHierarchyTimeMs += timer.now() - refreshStart;
  state.consecutiveNoHierarchy++;
  logger.warn(
    `[TapOnElement] Android pre-tap refresh returned no hierarchy ` +
      `(consecutive: ${state.consecutiveNoHierarchy}/${ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE}, ` +
      `refind attempt: ${state.refindAttempt})`,
  );
  if (state.consecutiveNoHierarchy >= ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE) {
    return {
      ok: false,
      error:
        `Android tap aborted: accessibility service was unreachable for ${state.consecutiveNoHierarchy} consecutive attempts ` +
        `(ctrl-proxy WebSocket unresponsive). The device may be under heavy load or the accessibility service may need reconnection.`,
    };
  }
  state.consecutiveStable = 0;
  state.prevBounds = null;
  return undefined;
}

function extendLoadingBudget(
  deps: StableTapTargetDeps,
  state: StableTapPollingState,
  freshHierarchy: ViewHierarchyResult,
): void {
  if (
    androidViewHierarchyIndicatesLikelyBlockingLoading(freshHierarchy, deps.elementParser) &&
    state.budgetMs < ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING
  ) {
    state.budgetMs = ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING;
    state.minProductivePolls = ANDROID_PRE_TAP_REFIND_MIN_POLLS_WHEN_LOADING;
    logger.info(
      `[TapOnElement] Android pre-tap: loading/progress indicators present; ` +
        `extending refind budget to ${state.budgetMs}ms / ${state.minProductivePolls} polls`,
    );
  }
}

function staleTapTargetError(
  deps: StableTapTargetDeps,
  context: StableTapContext,
  freshHierarchy: ViewHierarchyResult,
  selection: ElementSelectionResult,
  element: Element,
): string | undefined {
  const { original, options, observeResult } = context;
  if (
    original?.["resource-id"] &&
    original["resource-id"] !== (selection.matchedElement ?? element)["resource-id"]
  ) {
    return "Stale tap target: the fresh capture matched a different native ID. Observe again before acting.";
  }

  return options.elementId !== undefined && options.elementId === original?.["view-id"]
    ? deps.staleSyntheticTarget(original, observeResult.viewHierarchy, freshHierarchy)
    : undefined;
}

function recordStableTapCandidate({
  state,
  freshHierarchy,
  selection,
  refreshed,
  stableMatchesRequired,
}: {
  state: StableTapPollingState;
  freshHierarchy: ViewHierarchyResult;
  selection: ElementSelectionResult;
  refreshed: { element: Element; usedParent: boolean };
  stableMatchesRequired: number;
}): StableTapTargetResult | undefined {
  const b = refreshed.element.bounds;
  if (b === undefined || b === null) {
    state.consecutiveStable = 0;
    state.prevBounds = null;
    return undefined;
  }

  if (
    state.prevBounds !== null &&
    boundsNearlyEqual(state.prevBounds, b, ANDROID_PRE_TAP_BOUNDS_EPSILON_PX)
  ) {
    state.consecutiveStable++;
  } else {
    state.consecutiveStable = 1;
  }
  state.prevBounds = b;
  const refreshedCaptureId = getHierarchySnapshot(freshHierarchy)?.captureId;
  state.best = {
    viewHierarchy: freshHierarchy,
    tapElement: refreshed.element,
    usedParent: refreshed.usedParent,
    // Carry refreshed metadata from the node actually tapped (#5888).
    selection: refreshedCaptureId ? { ...selection, captureId: refreshedCaptureId } : selection,
  };

  if (state.consecutiveStable >= stableMatchesRequired) {
    logger.info(
      `[TapOnElement] Android tap target stable after ${state.refindAttempt} refresh(es) (bounds matched on last ${stableMatchesRequired} consecutive re-find(s), ε=${ANDROID_PRE_TAP_BOUNDS_EPSILON_PX}px)`,
    );
    return { ok: true, ...state.best };
  }
  return undefined;
}

function refindStableTapTarget(
  deps: StableTapTargetDeps,
  context: StableTapContext,
  state: StableTapPollingState,
  freshHierarchy: ViewHierarchyResult,
): StableTapTargetResult | undefined {
  state.consecutiveNoHierarchy = 0;
  state.refindAttempt++;
  extendLoadingBudget(deps, state, freshHierarchy);

  const refind = deps.findElementInHierarchy(context.options, freshHierarchy);
  if (!refind.selection.element) {
    logger.warn(
      `[TapOnElement] Android pre-tap refresh attempt ${state.refindAttempt} did not re-find tap target`,
    );
    state.consecutiveStable = 0;
    state.prevBounds = null;
    return undefined;
  }

  const staleError = staleTapTargetError(
    deps,
    context,
    freshHierarchy,
    refind.selection,
    refind.selection.element,
  );
  if (staleError) {
    return { ok: false, error: staleError };
  }

  const refreshed = deps.resolveTapTargetElement(
    refind.selection.element,
    freshHierarchy,
    context.action,
    {
      requireResourceId: context.requireResourceId,
      scoped: context.options.container !== undefined,
    },
  );
  return recordStableTapCandidate({
    state,
    freshHierarchy,
    selection: refind.selection,
    refreshed,
    stableMatchesRequired: context.stableMatchesRequired,
  });
}

/**
 * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
 * consecutive successful re-finds (±ε); the required count depends on selector type (see
 * {@link androidPreTapConsecutiveStableMatchesRequired}). Refuses to fall back to pre-refresh
 * coordinates when the refreshed tree does not contain a matching target.
 */
export async function resolveAndroidStableTapTarget(
  deps: StableTapTargetDeps,
  request: {
    options: TapVerificationOptions;
    observeResult: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>;
    action: TapOnElementOptions["action"];
    requireResourceId: boolean;
    signal?: AbortSignal;
  },
): Promise<StableTapTargetResult> {
  const { observeResult, action, requireResourceId, signal } = request;
  const options = deps.withObservationScreenSize(request.options, observeResult);
  const stableMatchesRequired = androidPreTapConsecutiveStableMatchesRequired(options);
  const original = findOriginalTapElement(deps, options, observeResult);
  const context: StableTapContext = {
    options,
    observeResult,
    action,
    requireResourceId,
    original,
    stableMatchesRequired,
  };
  const state: StableTapPollingState = {
    prevBounds: null,
    consecutiveStable: 0,
    best: null,
    startTime: deps.timer.now(),
    // The separately bounded no-hierarchy streak must not consume target patience.
    noHierarchyTimeMs: 0,
    budgetMs: ANDROID_PRE_TAP_REFIND_BUDGET_MS,
    minProductivePolls: ANDROID_PRE_TAP_REFIND_MIN_POLLS,
    consecutiveNoHierarchy: 0,
    refindAttempt: 0,
    firstIteration: true,
    iterations: 0,
    // Finish a stability run at the deadline without extending indefinitely.
    deadlineGracePolls: stableMatchesRequired,
  };

  while (true) {
    throwIfAborted(signal);
    if (!shouldContinuePolling(state, deps.timer, stableMatchesRequired)) {
      break;
    }

    if (!state.firstIteration) {
      const inNoHierarchyRecovery = state.consecutiveNoHierarchy > 0;
      const delayMs = inNoHierarchyRecovery
        ? ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS
        : ANDROID_PRE_TAP_REFIND_DELAY_MS;
      await deps.timer.sleep(delayMs);
      if (inNoHierarchyRecovery) {
        state.noHierarchyTimeMs += delayMs;
      }
    }
    state.firstIteration = false;

    const refreshStart = deps.timer.now();
    const freshHierarchy = await deps.tapVerificationRefresh({
      refresh: options.verification?.refresh,
      screenSize: observeResult.screenSize,
      signal,
    })(ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS);
    if (!freshHierarchy) {
      const failure = recordMissingHierarchy(state, deps.timer, refreshStart);
      if (failure) {
        return failure;
      }
      continue;
    }

    const result = refindStableTapTarget(deps, context, state, freshHierarchy);
    if (result) {
      return result;
    }
  }

  return {
    ok: false,
    error:
      "Android tap aborted: could not re-find the target in the accessibility hierarchy with stable bounds after repeated refreshes (refusing tap using pre-observe coordinates). The UI may still be updating (list, keyboard, loading overlay, or animation).",
  };
}
