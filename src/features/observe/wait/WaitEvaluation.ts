/**
 * waitFor / settle evaluation moved out of observeTools.ts (#11828): the condition DSL, display-wait
 * evidence, the poll loop and its orchestration helpers. The element search lives in
 * WaitElement.ts, the condition predicates in WaitPredicates.ts and the settle
 * hashing in WaitSettle.ts (#12676); this module re-exports their public names.
 * Behaviour is unchanged; observeTools.ts re-exports the public names.
 */
import { DEFAULT_WAIT_FOR_TIMEOUT_MS, DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS } from "../waitForTimeout";
import { canDisplayExist, type DisplayInventoryClassification } from "../../../utils/deviceMatcher";
import type { DisplayPanel } from "../../../models/DisplayPanel";
import { type ObserveScreenshotOptions } from "../screenshot/screenshotOptions";
import { ActionableError } from "../../../models/ActionableError";
import { hasUsableHierarchy } from "../ObserveScreen";
import type { ObserveScreen, ObserveScreenExecuteOptions } from "../interfaces/ObserveScreen";
import { RealSettleObserve } from "../SettleObserve";
import { RealWaitForCondition } from "../WaitForCondition";
import { hierarchyUpdatedAtToMillis } from "../observeTimestamp";
import type { ConditionPredicate } from "../interfaces/WaitForCondition";
import {
  appear,
  disappear,
  clickable,
  textEquals,
  countStable,
  ConditionSelector,
  waitCaptureUnavailableReason,
} from "../ConditionPredicates";
import { throwIfAborted, awaitWhileRequestIsLive } from "../../../utils/toolUtils";
import {
  isDeviceLostError,
  throwDeviceLostFromAbortSignal,
} from "../../../utils/deviceLossOutcome";
import { BootedDevice, Element, ObserveResult } from "../../../models";
import { createGlobalPerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  ElementResolver,
  type MatchMode,
  type ContainerFailure,
} from "../../utility/ElementResolver";
import type { ConditionResolver } from "../ConditionPredicates";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import {
  resolveScreenshotMode,
  shouldSkipObserveWaitForScreenshot,
  type ScreenshotMode,
} from "../automaticScreenshotPolicy";
import type {
  ObserveWaitForOptions,
  SettledOptions,
  WaitForWithSettled,
  WaitForConditionDsl,
  WaitForConditionKind,
} from "./WaitForSchemas";
import { hasElementPredicate } from "./WaitElement";
import {
  type ObserveConditionEvaluation,
  containerFailureMetadata,
  trackContainerFailure,
  layerScopedObservation,
  evaluateWaitForObservation,
} from "./WaitPredicates";
import { hashHierarchyForSettle } from "./WaitSettle";

export { findWaitForElement, hasElementPredicate } from "./WaitElement";
export { hashHierarchyForSettle } from "./WaitSettle";

const WAIT_FOR_POLL_INTERVAL_MS = 100;

/** Metadata produced by an `observe.waitFor` poll. */
export interface WaitForObservationOutcome {
  observation: ObserveResult;
  awaitedElement?: Element;
  awaitDuration: number;
  awaitTimeout: boolean;
  matched?: boolean;
  settled?: boolean;
  timedOut: boolean;
  timeoutReason?: string;
  polls: number;
  waitMs: number;
  matchedElement?: Element;
  candidates?: Element[];
  containerFailure?: ContainerFailure;
}

/** True when the waitFor options are the #4398 declarative `for` DSL form. */
const isConditionDsl = (waitFor: ObserveWaitForOptions): waitFor is WaitForConditionDsl =>
  (waitFor as { for?: unknown }).for !== undefined;

/**
 * Build the #4389 {@link ConditionPredicate} for a DSL `for` kind (issue #4398).
 * `stable` is intentionally not handled here — the handler routes it to
 * `RealSettleObserve` (whole-screen settle) rather than a predicate. Throws an
 * `ActionableError` for `textEquals` without a `text` value, mirroring the zod
 * refinement so the standalone tool path fails with the same actionable message.
 */
export const buildConditionPredicate = (
  finder: ConditionResolver,
  kind: WaitForConditionKind,
  selector: ConditionSelector,
  options?: { stableReads?: number },
): ConditionPredicate => {
  switch (kind) {
    case "appear":
      return appear(finder, selector);
    case "disappear":
      return disappear(finder, selector);
    case "clickable":
      return clickable(finder, selector);
    case "textEquals":
      if (selector.text === undefined) {
        throw new ActionableError(
          'waitFor "for: textEquals" requires text (the exact expected value)',
        );
      }
      return textEquals(finder, selector, selector.text);
    case "countStable":
      return countStable(finder, selector, options);
    default: {
      const exhaustive: never = kind;
      throw new ActionableError(`Unknown waitFor condition: ${String(exhaustive)}`);
    }
  }
};

/**
 * Run the declarative `for` DSL (issue #4398) and adapt its result to the shared
 * `waitForObservation` return shape. `stable` runs the settle loop
 * (`RealSettleObserve`); every other kind runs `RealWaitForCondition` with the
 * predicate for that kind. `awaitedElement` carries the matched element (never set
 * for settle / countStable, which have no single element); `awaitTimeout` reflects
 * "did not settle" / "timed out".
 */
const runWaitForConditionDsl = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForConditionDsl,
  signal: AbortSignal | undefined,
  {
    timer,
    skipBackStack = false,
    platform,
  }: { skipBackStack?: boolean; platform?: BootedDevice["platform"] } & { timer: Timer },
): Promise<WaitForObservationOutcome> => {
  const startTime = timer.now();
  const timeoutMs =
    waitFor.timeout ??
    waitFor.timeoutMs ??
    (waitFor.for === "stable" ? DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS : DEFAULT_WAIT_FOR_TIMEOUT_MS);
  const pollingScreen = waitPollingScreen(observeScreen, skipBackStack);
  const settled = (waitFor as WaitForWithSettled).settled;
  const pollMs = waitFor.pollMs;
  const applySettledGate = createSettledGate({
    settled,
    timer,
    startTime,
    timeoutMs,
    signal,
    pollingScreen,
    skipBackStack,
    platform,
  });
  if (waitFor.for === "stable") {
    const settle = await new RealSettleObserve(pollingScreen, timer).execute({
      timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
      pollMs,
      stableReads: waitFor.stableReads,
      signal,
    });
    const outcome: WaitForObservationOutcome = {
      observation: settle.observation,
      awaitedElement: undefined,
      awaitDuration: settle.waitMs,
      awaitTimeout: !settle.settled,
      settled: settle.settled,
      // The terminal reason preserves whether an Asleep observation was an
      // admissible screen-off fast-fail or merely the last stale frame at the
      // end of an exhausted timeout budget.
      timedOut: settle.terminalReason === "timeout",
      polls: settle.polls,
      waitMs: settle.waitMs,
    };
    return applySettledGate(outcome, settle.settled);
  }

  const tracked = trackContainerFailure(new ElementResolver(), waitFor.container);
  const evaluate = buildConditionPredicate(
    tracked.finder,
    waitFor.for,
    {
      elementId: waitFor.elementId,
      text: waitFor.text,
      container: waitFor.container,
      selectionStrategy: waitFor.selectionStrategy,
    },
    { stableReads: waitFor.stableReads },
  );
  const predicate: ConditionPredicate = (observation) => {
    tracked.reset();
    const evaluation = evaluate(
      layerScopedObservation(observation, (waitFor as WaitForWithSettled).layer),
    );
    return { ...evaluation, ...containerFailureMetadata(!evaluation.matched, tracked.failure()) };
  };
  const result = await new RealWaitForCondition(pollingScreen, timer).execute(predicate, {
    timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
    pollMs,
    signal,
  });
  const outcome: WaitForObservationOutcome = {
    observation: result.observation,
    awaitedElement: result.matchedElement,
    awaitDuration: result.waitMs,
    awaitTimeout: result.timedOut,
    matched: result.matched,
    timedOut: result.timedOut,
    polls: result.polls,
    waitMs: result.waitMs,
    matchedElement: result.matchedElement,
    candidates: result.candidates,
    ...containerFailureMetadata(result.timedOut, tracked.failure()),
    ...(result.diagnostic
      ? {
          timeoutReason: `Timed out after ${result.waitMs} ms waiting for ${waitFor.for}; ${result.diagnostic}`,
        }
      : {}),
  };
  return applySettledGate(outcome, result.matched, predicate);
};

function waitPollingScreen(observeScreen: ObserveScreen, skipBackStack: boolean): ObserveScreen {
  // Omit collectDeferredBackStack here: explicit skipBackStack opts out of terminal reads too.
  return skipBackStack
    ? {
        execute: (options?: ObserveScreenExecuteOptions) =>
          observeScreen.execute({ ...options, skipBackStack: true }),
        appendRawViewHierarchy: (result, abortSignal) =>
          observeScreen.appendRawViewHierarchy(result, abortSignal),
        getMostRecentCachedObserveResult: () => observeScreen.getMostRecentCachedObserveResult(),
        ...(observeScreen.captureScreenshot
          ? {
              captureScreenshot: (
                ...args: Parameters<NonNullable<ObserveScreen["captureScreenshot"]>>
              ) => observeScreen.captureScreenshot!(...args),
            }
          : {}),
        ...(observeScreen.runAccessibilityAudit
          ? {
              runAccessibilityAudit: (
                ...args: Parameters<NonNullable<ObserveScreen["runAccessibilityAudit"]>>
              ) => observeScreen.runAccessibilityAudit!(...args),
            }
          : {}),
        ...(observeScreen.processRecomposition
          ? {
              processRecomposition: (
                ...args: Parameters<NonNullable<ObserveScreen["processRecomposition"]>>
              ) => observeScreen.processRecomposition!(...args),
            }
          : {}),
        ...(observeScreen.captureCacheGeneration
          ? { captureCacheGeneration: () => observeScreen.captureCacheGeneration!() }
          : {}),
        ...(observeScreen.cacheObserveResult
          ? {
              cacheObserveResult: (
                ...args: Parameters<NonNullable<ObserveScreen["cacheObserveResult"]>>
              ) => observeScreen.cacheObserveResult!(...args),
            }
          : {}),
      }
    : observeScreen;
}

interface DisplayWaitTimeoutEvidence {
  knownValueObserved: boolean;
  hierarchyCaptured: boolean;
  lastObservedReason: string;
}

function displayWaitTimeoutReason(
  waitKind: "posture" | "activeDisplay",
  requested: string,
  duration: number,
  {
    inventory,
    evidence,
  }: { inventory: DisplayInventoryClassification; evidence: DisplayWaitTimeoutEvidence },
): string {
  let reason = evidence.lastObservedReason;
  if (!evidence.knownValueObserved) {
    if (inventory === "unavailable") {
      reason =
        waitKind === "posture"
          ? "display inventory was unavailable so posture support was never confirmed"
          : "display inventory was unavailable so the active display was never confirmed";
    } else if (!evidence.hierarchyCaptured) {
      reason =
        waitKind === "posture"
          ? "posture was never observable because no hierarchy was captured"
          : "the active display was never observable because no hierarchy was captured";
    }
  }
  return `Timed out after ${duration} ms waiting for ${waitKind} "${requested}"; ${reason}`;
}

function recordDisplayWaitEvidence(
  observation: ObserveResult,
  postureEvidence: DisplayWaitTimeoutEvidence,
  activeDisplayEvidence: DisplayWaitTimeoutEvidence,
): void {
  if (observation.display?.posture !== undefined) {
    postureEvidence.lastObservedReason = `last observed posture "${observation.display.posture}"`;
  }
  postureEvidence.knownValueObserved ||=
    observation.display !== undefined && observation.display.posture !== "unknown";
  postureEvidence.hierarchyCaptured ||= hasUsableHierarchy(observation.viewHierarchy);
  activeDisplayEvidence.lastObservedReason = observation.display
    ? `last observed active display "${observation.display.key}" (${observation.display.role})`
    : 'last observed active display "unknown"';
  activeDisplayEvidence.knownValueObserved ||=
    observation.display !== undefined &&
    !(observation.display.key === "0" && observation.display.role === "unknown");
  activeDisplayEvidence.hierarchyCaptured ||= hasUsableHierarchy(observation.viewHierarchy);
}

function scopedWaitTimeoutMetadata(evaluation: ObserveConditionEvaluation, waitMs: number) {
  return {
    ...containerFailureMetadata(!evaluation.matched, evaluation.containerFailure),
    ...(evaluation.diagnostic
      ? {
          candidates: evaluation.candidates,
          timeoutReason: `Timed out after ${waitMs} ms waiting for element; ${evaluation.diagnostic}`,
        }
      : {}),
  };
}

export interface WaitForObservationOptions {
  signal?: AbortSignal;
  skipBackStack?: boolean;
  timer?: Timer;
  platform?: BootedDevice["platform"];
  screenshot?: ScreenshotMode;
  screenshotOptions?: ObserveScreenshotOptions;
  displayInventory?: DisplayInventoryClassification;
  displayPanels?: readonly Pick<DisplayPanel, "key" | "role">[];
}

function resolveWaitOptions(options: WaitForObservationOptions) {
  const {
    signal,
    skipBackStack = false,
    timer = defaultTimer,
    platform,
    screenshot,
    screenshotOptions,
    displayInventory = "unavailable",
    displayPanels = [],
  } = options;
  return {
    signal,
    skipBackStack,
    timer,
    platform,
    screenshot,
    screenshotOptions,
    displayInventory,
    displayPanels,
  };
}

export const waitForObservation = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForWithSettled,
  options: WaitForObservationOptions = {},
): Promise<WaitForObservationOutcome> => {
  const {
    signal,
    skipBackStack,
    timer,
    platform,
    screenshot,
    screenshotOptions,
    displayInventory,
    displayPanels,
  } = resolveWaitOptions(options);
  const iosMultiPanel = hasIosWaitPanels(platform, displayPanels);
  const postureEvidence: DisplayWaitTimeoutEvidence = {
    lastObservedReason: 'last observed posture "unknown"',
    knownValueObserved: false,
    hierarchyCaptured: false,
  };
  const activeDisplayEvidence: DisplayWaitTimeoutEvidence = {
    lastObservedReason: 'last observed active display "unknown"',
    knownValueObserved: false,
    hierarchyCaptured: false,
  };
  const complete = createWaitCompletion({
    waitFor,
    displayInventory,
    postureEvidence,
    activeDisplayEvidence,
    screenshot,
    observeScreen,
    signal,
    screenshotOptions,
  });

  // Declarative `for` DSL (issue #4398) routes to the #4389 primitives; the
  // legacy element/textAny/activeWindow path below is unchanged (back-compat).
  if (isConditionDsl(waitFor)) {
    return complete(
      await runWaitForConditionDsl(observeScreen, waitFor, signal, {
        timer,
        skipBackStack,
        platform,
      }),
    );
  }

  const startTime = timer.now();
  const timeoutMs = legacyWaitTimeout(waitFor);
  const settled = waitFor.settled;
  const finder = new ElementResolver();
  const queryOptions = waitObservationQuery(waitFor);

  // Back-stack collection may stay disabled during waitFor polling to preserve its
  // timeout budget. Screenshots always stay suppressed during polls; when opted
  // in, `complete` captures exactly one screenshot from the terminal state.
  const skipPollingOverhead = !serverConfig.isWaitForPollingOverheadEnabled();

  const observeOnce = createWaitObserver({
    observeScreen,
    queryOptions,
    timeoutMs,
    timer,
    startTime,
    signal,
    skipPollingOverhead,
    skipBackStack,
    postureEvidence,
    activeDisplayEvidence,
  });

  // Settle gate (issue #3490 §3): once the predicate matches, hold until the
  // hierarchy hash is unchanged for settled.quietPeriodMs. `matchedHash === null`
  // means "no stable candidate yet"; a changed hash restarts the quiet window.
  let matchedHash: string | null = null;
  let quietStart = startTime;
  const settleReady = (observation: ObserveResult): boolean => {
    if (!settled) {
      return true;
    }
    const hash = hashHierarchyForSettle(observation.viewHierarchy);
    // An unhashable tree (null) is never quiet: fall through to restart the
    // window so the gate cannot resolve early on an unverifiable snapshot.
    if (hash === null || matchedHash === null || hash !== matchedHash) {
      matchedHash = hash;
      quietStart = timer.now();
      return false;
    }
    return timer.now() - quietStart >= settled.quietPeriodMs;
  };

  const resetMatchedHash = () => {
    matchedHash = null;
  };

  throwIfAborted(signal);
  // Evaluate the current cache on the first poll, then use its device-clock
  // timestamp to request a strictly newer hierarchy on later polls.
  let observation = await observeOnce(0);
  throwIfAborted(signal);
  checkWaitDisplaySupport(waitFor, displayInventory, displayPanels);
  const baselineTimestamp = waitBaselineTimestamp(observation);
  // A posture-only stamp is read independently of hierarchy capture, including
  // while folding locks the device. UI predicates/settling still need a fresh tree.
  const needsHierarchyFreshness = needsWaitHierarchyFreshness(waitFor, settled);
  const minTimestamp = waitTimestampFloor(needsHierarchyFreshness, baselineTimestamp);
  let polls = 1;
  const modes = new Map<string, MatchMode>();
  let waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation, {
    devicePlatform: platform,
    displayInventory,
    modes,
    iosMultiPanel,
  });

  if (waitMatchReady(waitEvaluation, observation, settleReady, resetMatchedHash)) {
    const waitMs = timer.now() - startTime;
    return complete(matchedWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
  }
  if (timer.now() - startTime >= timeoutMs) {
    const waitMs = timer.now() - startTime;
    return complete(timedOutWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
  }

  while (timer.now() - startTime < timeoutMs) {
    await awaitWhileRequestIsLive(timer.sleep(WAIT_FOR_POLL_INTERVAL_MS), signal);
    throwIfAborted(signal);

    polls++;
    try {
      observation = await observeOnce(minTimestamp);
    } catch (error) {
      throwDeviceLostFromAbortSignal(signal);
      if (shouldRethrowWaitObservationError(error, waitFor, signal)) {
        logger.debug("[observe] Wait observation failed", error);
        throw error;
      }
      // A fold may lock/disconnect capture before posture is observable; retry within the deadline.
      logger.debug("[observe] Posture transition interrupted observation; retrying", error);
      waitEvaluation = { matched: false };
      matchedHash = null;
      continue;
    }
    throwIfAborted(signal);
    checkWaitDisplaySupport(waitFor, displayInventory, displayPanels);
    const observedTimestamp = hierarchyUpdatedAtToMillis(observation.viewHierarchy);
    // A timed-out delegate may return its old cache despite the requested
    // floor. It must not satisfy waitFor as post-invocation evidence.
    waitEvaluation = evaluateFreshWaitObservation({
      minTimestamp,
      observedTimestamp,
      finder,
      waitFor,
      observation,
      platform,
      displayInventory,
      modes,
      iosMultiPanel,
    });

    if (waitMatchReady(waitEvaluation, observation, settleReady, resetMatchedHash)) {
      const waitMs = timer.now() - startTime;
      return complete(matchedWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
    }
  }

  const waitMs = timer.now() - startTime;
  return complete(timedOutWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
};

function createSettledGate({
  settled,
  timer,
  startTime,
  timeoutMs,
  signal,
  pollingScreen,
  skipBackStack,
  platform,
}: {
  settled: SettledOptions | undefined;
  timer: Timer;
  startTime: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  pollingScreen: ObserveScreen;
  skipBackStack: boolean;
  platform: BootedDevice["platform"] | undefined;
}) {
  return async (
    outcome: WaitForObservationOutcome,
    matched: boolean,
    recheck: ConditionPredicate = () => ({ matched: true }),
  ): Promise<WaitForObservationOutcome> => {
    if (!settled || !matched) {
      return outcome;
    }
    let observation = outcome.observation;
    // The floor must be in the device clock domain, like the `updatedAt` it is
    // compared with (#9878, same class as #6430). The matched capture's own
    // device stamp is inclusive, so it admits that capture (as the host
    // `startTime` floor did with no skew) without rejecting every read of a
    // still screen on a device whose clock trails the host. No device stamp
    // (unavailable capture) means unfloored, as the #6430 loop does. iOS keeps
    // the host `startTime` floor: the runner stamps `updatedAt` with its own
    // `Date()`, which is the host clock for simulators but not clearly
    // comparable for a physical device, so that path is unchanged.
    const minTimestamp = settledGateFloor(observation, platform, startTime);
    let matchedHash = hashHierarchyForSettle(observation.viewHierarchy);
    let quietStart = timer.now();
    let polls = outcome.polls;
    let matchedElement = outcome.matchedElement;
    let awaitedElement = outcome.awaitedElement;
    let conditionMatched = true;
    let lastEvaluation: ObserveConditionEvaluation = { matched: true };
    while (timer.now() - startTime < timeoutMs) {
      if (matchedHash !== null && timer.now() - quietStart >= settled.quietPeriodMs) {
        return {
          ...outcome,
          observation,
          matchedElement,
          awaitedElement,
          matched: true,
          settled: true,
          timedOut: false,
          awaitTimeout: false,
          waitMs: timer.now() - startTime,
          awaitDuration: timer.now() - startTime,
          polls,
        };
      }
      await awaitWhileRequestIsLive(timer.sleep(WAIT_FOR_POLL_INTERVAL_MS), signal);
      throwIfAborted(signal);
      observation = await pollingScreen.execute({
        timeoutMs: Math.max(0, timeoutMs - (timer.now() - startTime)),
        skipWaitForFresh: false,
        minTimestamp,
        signal,
        skipBackStack: skipBackStack || undefined,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipStaleWindowRecovery: true,
      });
      throwIfAborted(signal);
      polls++;
      const unavailableReason = waitCaptureUnavailableReason(observation);
      const evaluation: ObserveConditionEvaluation = unavailableReason
        ? { matched: false, diagnostic: unavailableReason }
        : recheck(observation);
      lastEvaluation = evaluation;
      if (!evaluation.matched) {
        conditionMatched = false;
        matchedHash = null;
        quietStart = timer.now();
        matchedElement = undefined;
        awaitedElement = undefined;
        continue;
      }
      conditionMatched = true;
      matchedElement = evaluation.matchedElement;
      awaitedElement = evaluation.matchedElement;
      const hash = hashHierarchyForSettle(observation.viewHierarchy);
      if (hash === null || hash !== matchedHash) {
        matchedHash = hash;
        quietStart = timer.now();
      }
    }
    const unavailableReason = waitCaptureUnavailableReason(observation);
    return {
      ...outcome,
      observation,
      matchedElement,
      awaitedElement,
      settled: false,
      timedOut: true,
      matched: conditionMatched,
      ...containerFailureMetadata(!conditionMatched, lastEvaluation.containerFailure),
      ...scopedWaitTimeoutMetadata(
        { matched: conditionMatched, diagnostic: unavailableReason },
        timer.now() - startTime,
      ),
      awaitTimeout: true,
      waitMs: timer.now() - startTime,
      awaitDuration: timer.now() - startTime,
      polls,
    };
  };
}

function createWaitCompletion({
  waitFor,
  displayInventory,
  postureEvidence,
  activeDisplayEvidence,
  screenshot,
  observeScreen,
  signal,
  screenshotOptions,
}: {
  waitFor: WaitForWithSettled;
  displayInventory: DisplayInventoryClassification;
  postureEvidence: DisplayWaitTimeoutEvidence;
  activeDisplayEvidence: DisplayWaitTimeoutEvidence;
  screenshot: ScreenshotMode | undefined;
  observeScreen: ObserveScreen;
  signal: AbortSignal | undefined;
  screenshotOptions: ObserveScreenshotOptions | undefined;
}) {
  return async (outcome: WaitForObservationOutcome): Promise<WaitForObservationOutcome> => {
    if (outcome.timedOut && waitFor.posture !== undefined) {
      outcome.timeoutReason = displayWaitTimeoutReason(
        "posture",
        waitFor.posture,
        outcome.awaitDuration,
        { inventory: displayInventory, evidence: postureEvidence },
      );
    } else if (outcome.timedOut && waitFor.activeDisplay !== undefined) {
      outcome.timeoutReason = displayWaitTimeoutReason(
        "activeDisplay",
        waitFor.activeDisplay,
        outcome.awaitDuration,
        { inventory: displayInventory, evidence: activeDisplayEvidence },
      );
    }
    const mode = resolveScreenshotMode(screenshot);
    if (
      mode === "settled" ||
      (mode === "async" &&
        (!shouldSkipObserveWaitForScreenshot() || serverConfig.isAccessibilityAuditEnabled()))
    ) {
      await observeScreen.captureScreenshot?.(createGlobalPerformanceTracker(), {
        signal,
        observation: outcome.observation,
        screenshot,
        screenshotOptions,
      });
    } else {
      await observeScreen.runAccessibilityAudit?.(
        outcome.observation,
        createGlobalPerformanceTracker(),
      );
    }
    return outcome;
  };
}

function createWaitObserver({
  observeScreen,
  queryOptions,
  timeoutMs,
  timer,
  startTime,
  signal,
  skipPollingOverhead,
  skipBackStack,
  postureEvidence,
  activeDisplayEvidence,
}: {
  observeScreen: ObserveScreen;
  queryOptions: { text: string | undefined; elementId: string | undefined };
  timeoutMs: number;
  timer: Timer;
  startTime: number;
  signal: AbortSignal | undefined;
  skipPollingOverhead: boolean;
  skipBackStack: boolean;
  postureEvidence: DisplayWaitTimeoutEvidence;
  activeDisplayEvidence: DisplayWaitTimeoutEvidence;
}) {
  return async (minTimestamp: number) => {
    const observation = await observeScreen.execute({
      queryOptions,
      timeoutMs: Math.max(0, timeoutMs - (timer.now() - startTime)),
      perf: createGlobalPerformanceTracker(),
      skipWaitForFresh: false,
      minTimestamp,
      signal,
      skipBackStack: skipPollingOverhead || skipBackStack,
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipStaleWindowRecovery: true,
    });
    recordDisplayWaitEvidence(observation, postureEvidence, activeDisplayEvidence);
    return observation;
  };
}

interface WaitOutcomeState {
  observation: ObserveResult;
  waitEvaluation: ReturnType<typeof evaluateWaitForObservation>;
  waitMs: number;
  settled: SettledOptions | undefined;
  polls: number;
}

function matchedWaitOutcome({
  observation,
  waitEvaluation,
  waitMs,
  settled,
  polls,
}: WaitOutcomeState): WaitForObservationOutcome {
  return {
    observation,
    awaitedElement: waitEvaluation.awaitedElement,
    awaitDuration: waitMs,
    awaitTimeout: false,
    matched: true,
    settled: settled ? true : undefined,
    timedOut: false,
    polls,
    waitMs,
    matchedElement: waitEvaluation.awaitedElement,
  };
}

function timedOutWaitOutcome({
  observation,
  waitEvaluation,
  waitMs,
  settled,
  polls,
}: WaitOutcomeState): WaitForObservationOutcome {
  return {
    observation,
    awaitedElement: waitEvaluation.matched ? waitEvaluation.awaitedElement : undefined,
    awaitDuration: waitMs,
    awaitTimeout: true,
    matched: waitEvaluation.matched,
    settled: settled ? false : undefined,
    timedOut: true,
    polls,
    waitMs,
    matchedElement: waitEvaluation.matched ? waitEvaluation.awaitedElement : undefined,
    ...scopedWaitTimeoutMetadata(waitEvaluation, waitMs),
  };
}

function needsWaitHierarchyFreshness(
  waitFor: WaitForWithSettled,
  settled: SettledOptions | undefined,
): boolean {
  return (
    waitFor.posture === undefined ||
    hasElementPredicate(waitFor) ||
    waitFor.absent !== undefined ||
    waitFor.activeWindow !== undefined ||
    settled !== undefined
  );
}

function shouldRethrowWaitObservationError(
  error: unknown,
  waitFor: WaitForWithSettled,
  signal: AbortSignal | undefined,
): boolean | undefined {
  return (
    isDeviceLostError(error) ||
    waitFor.posture === undefined ||
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function checkWaitDisplaySupport(
  waitFor: WaitForWithSettled,
  displayInventory: DisplayInventoryClassification,
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[],
): void {
  if (
    waitFor.activeDisplay !== undefined &&
    !canDisplayExist(displayInventory, displayPanels, waitFor.activeDisplay)
  ) {
    throw new ActionableError(
      "Cannot wait for activeDisplay: this device has no display inventory. Select a device that reports display panels and posture and retry.",
    );
  }
  if (waitFor.posture !== undefined && displayInventory === "single") {
    throw new ActionableError(
      "Cannot wait for posture: this device has no display inventory. Select a device that reports display panels and posture and retry.",
    );
  }
}

function hasIosWaitPanels(
  platform: BootedDevice["platform"] | undefined,
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[],
): boolean {
  return platform === "ios" && displayPanels.length > 1;
}

function legacyWaitTimeout(waitFor: WaitForWithSettled): number {
  return waitFor.timeout ?? waitFor.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
}

function waitObservationQuery(waitFor: WaitForWithSettled) {
  return {
    text: waitFor.text ?? waitFor.textAny?.[0] ?? waitFor.contentDescription,
    elementId: waitFor.elementId,
  };
}

function waitTimestampFloor(
  needsHierarchyFreshness: boolean,
  baselineTimestamp: number | undefined,
): number {
  return needsHierarchyFreshness && baselineTimestamp !== undefined && baselineTimestamp > 0
    ? baselineTimestamp + 1
    : 0;
}

/** Settled-gate floor: iOS keeps the host `startTime`; otherwise the matched capture's own device stamp, else unfloored. */
function settledGateFloor(
  observation: ObserveResult,
  platform: BootedDevice["platform"] | undefined,
  startTime: number,
): number {
  return platform === "ios" ? startTime : (waitBaselineTimestamp(observation) ?? 0);
}

function waitBaselineTimestamp(observation: ObserveResult): number | undefined {
  return waitCaptureUnavailableReason(observation)
    ? undefined
    : hierarchyUpdatedAtToMillis(observation.viewHierarchy);
}

function evaluateFreshWaitObservation({
  minTimestamp,
  observedTimestamp,
  finder,
  waitFor,
  observation,
  platform,
  displayInventory,
  modes,
  iosMultiPanel,
}: {
  minTimestamp: number;
  observedTimestamp: number | undefined;
  finder: ElementResolver;
  waitFor: WaitForWithSettled;
  observation: ObserveResult;
  platform: BootedDevice["platform"] | undefined;
  displayInventory: DisplayInventoryClassification;
  modes: Map<string, MatchMode>;
  iosMultiPanel: boolean;
}): ReturnType<typeof evaluateWaitForObservation> {
  return minTimestamp > 0 && (observedTimestamp === undefined || observedTimestamp < minTimestamp)
    ? {
        matched: false,
        awaitedElement: undefined,
        diagnostic: waitCaptureUnavailableReason(observation),
      }
    : evaluateWaitForObservation(finder, waitFor, observation, {
        devicePlatform: platform,
        displayInventory,
        modes,
        iosMultiPanel,
      });
}

function waitMatchReady(
  waitEvaluation: ReturnType<typeof evaluateWaitForObservation>,
  observation: ObserveResult,
  settleReady: (observation: ObserveResult) => boolean,
  resetMatchedHash: () => void,
): boolean {
  if (waitEvaluation.matched) {
    return settleReady(observation);
  }
  resetMatchedHash();
  return false;
}
