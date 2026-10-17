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
  let { options } = request;
  options = deps.withObservationScreenSize(options, observeResult);
  const stableMatchesRequired = androidPreTapConsecutiveStableMatchesRequired(options);
  const originalSelection = observeResult.viewHierarchy
    ? deps.findElementInHierarchy(options, observeResult.viewHierarchy).selection
    : null;
  const original = originalSelection?.matchedElement ?? originalSelection?.element ?? null;

  let prevBounds: Element["bounds"] | null = null;
  let consecutiveStable = 0;
  let best: {
    viewHierarchy: ViewHierarchyResult;
    tapElement: Element;
    usedParent: boolean;
    selection: ElementSelectionResult;
  } | null = null;

  const startTime = deps.timer.now();
  // Wall-clock time NOT attributable to productive polling — the "no hierarchy"
  // recovery sleeps AND the wall-clock the failed refreshes themselves consumed.
  // Excluded from the deadline so a temporarily-unresponsive ctrl-proxy WebSocket
  // doesn't consume the element's patience (that streak is bounded separately by
  // ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE).
  let noHierarchyTimeMs = 0;
  let budgetMs = ANDROID_PRE_TAP_REFIND_BUDGET_MS;
  let minProductivePolls = ANDROID_PRE_TAP_REFIND_MIN_POLLS;
  let consecutiveNoHierarchy = 0;
  let refindAttempt = 0;
  let firstIteration = true;
  let iterations = 0;
  // Extra polls allowed past the deadline to finish confirming an already-stable
  // candidate, so a sibling selector isn't failed at the boundary (e.g. a null
  // streak resets stability progress right as the deadline passes). Bounded by
  // stableMatchesRequired so a perpetually-shifting target can't extend forever.
  let deadlineGracePolls = stableMatchesRequired;

  while (true) {
    throwIfAborted(signal);
    if (++iterations > ANDROID_PRE_TAP_MAX_ITERATIONS) {
      break;
    }

    // Keep polling until BOTH the productive-poll floor and the wall-clock
    // deadline are exceeded; the floor guarantees we never poll fewer times than
    // the old fixed attempt count on a slow device.
    const productiveElapsedMs = deps.timer.now() - startTime - noHierarchyTimeMs;
    const budgetExhausted = refindAttempt >= minProductivePolls && productiveElapsedMs >= budgetMs;
    const midStabilityRun =
      best !== null && consecutiveStable > 0 && consecutiveStable < stableMatchesRequired;
    if (!firstIteration && consecutiveNoHierarchy === 0 && budgetExhausted) {
      if (midStabilityRun && deadlineGracePolls > 0) {
        deadlineGracePolls--;
      } else {
        break;
      }
    }

    if (!firstIteration) {
      const inNoHierarchyRecovery = consecutiveNoHierarchy > 0;
      const delayMs = inNoHierarchyRecovery
        ? ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS
        : ANDROID_PRE_TAP_REFIND_DELAY_MS;
      await deps.timer.sleep(delayMs);
      if (inNoHierarchyRecovery) {
        noHierarchyTimeMs += delayMs;
      }
    }
    firstIteration = false;

    const refreshStart = deps.timer.now();
    const freshHierarchy = await deps.tapVerificationRefresh({
      refresh: options.verification?.refresh,
      screenSize: observeResult.screenSize,
      signal,
    })(ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS);
    if (!freshHierarchy) {
      // The failed refresh itself burned wall-clock (up to the timeout); exclude
      // that from the deadline too, not just the recovery sleep, otherwise a slow
      // unresponsive proxy still eats the element's patience.
      noHierarchyTimeMs += deps.timer.now() - refreshStart;
      consecutiveNoHierarchy++;
      logger.warn(
        `[TapOnElement] Android pre-tap refresh returned no hierarchy ` +
          `(consecutive: ${consecutiveNoHierarchy}/${ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE}, ` +
          `refind attempt: ${refindAttempt})`,
      );
      if (consecutiveNoHierarchy >= ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE) {
        return {
          ok: false,
          error:
            `Android tap aborted: accessibility service was unreachable for ${consecutiveNoHierarchy} consecutive attempts ` +
            `(ctrl-proxy WebSocket unresponsive). The device may be under heavy load or the accessibility service may need reconnection.`,
        };
      }
      consecutiveStable = 0;
      prevBounds = null;
      continue;
    }

    consecutiveNoHierarchy = 0;
    refindAttempt++;

    if (
      androidViewHierarchyIndicatesLikelyBlockingLoading(freshHierarchy, deps.elementParser) &&
      budgetMs < ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING
    ) {
      budgetMs = ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING;
      minProductivePolls = ANDROID_PRE_TAP_REFIND_MIN_POLLS_WHEN_LOADING;
      logger.info(
        `[TapOnElement] Android pre-tap: loading/progress indicators present; ` +
          `extending refind budget to ${budgetMs}ms / ${minProductivePolls} polls`,
      );
    }

    const refind = deps.findElementInHierarchy(options, freshHierarchy);
    if (!refind.selection.element) {
      logger.warn(
        `[TapOnElement] Android pre-tap refresh attempt ${refindAttempt} did not re-find tap target`,
      );
      consecutiveStable = 0;
      prevBounds = null;
      continue;
    }

    if (
      original?.["resource-id"] &&
      original["resource-id"] !==
        (refind.selection.matchedElement ?? refind.selection.element)["resource-id"]
    ) {
      return {
        ok: false,
        error:
          "Stale tap target: the fresh capture matched a different native ID. Observe again before acting.",
      };
    }

    const staleSynthetic =
      options.elementId !== undefined && options.elementId === original?.["view-id"]
        ? deps.staleSyntheticTarget(original, observeResult.viewHierarchy, freshHierarchy)
        : undefined;
    if (staleSynthetic) {
      return { ok: false, error: staleSynthetic };
    }

    const refreshed = deps.resolveTapTargetElement(
      refind.selection.element as Element,
      freshHierarchy,
      action,
      { requireResourceId, scoped: options.container !== undefined },
    );
    const b = refreshed.element.bounds;
    if (b === undefined || b === null) {
      consecutiveStable = 0;
      prevBounds = null;
      continue;
    }

    if (
      prevBounds !== null &&
      boundsNearlyEqual(prevBounds, b, ANDROID_PRE_TAP_BOUNDS_EPSILON_PX)
    ) {
      consecutiveStable++;
    } else {
      consecutiveStable = 1;
    }
    prevBounds = b;
    const refreshedCaptureId = getHierarchySnapshot(freshHierarchy)?.captureId;
    best = {
      viewHierarchy: freshHierarchy,
      tapElement: refreshed.element,
      usedParent: refreshed.usedParent,
      // Carry the refreshed selection so the caller can rebuild selectedElement
      // metadata (bounds/indexInMatches/totalMatches) from the node actually
      // tapped, not the stale pre-refresh selection (#5888).
      selection: refreshedCaptureId
        ? { ...refind.selection, captureId: refreshedCaptureId }
        : refind.selection,
    };

    if (consecutiveStable >= stableMatchesRequired) {
      logger.info(
        `[TapOnElement] Android tap target stable after ${refindAttempt} refresh(es) (bounds matched on last ${stableMatchesRequired} consecutive re-find(s), ε=${ANDROID_PRE_TAP_BOUNDS_EPSILON_PX}px)`,
      );
      return { ok: true, ...best };
    }
  }

  return {
    ok: false,
    error:
      "Android tap aborted: could not re-find the target in the accessibility hierarchy with stable bounds after repeated refreshes (refusing tap using pre-observe coordinates). The UI may still be updating (list, keyboard, loading overlay, or animation).",
  };
}
