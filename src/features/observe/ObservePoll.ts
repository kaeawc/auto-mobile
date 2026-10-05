import type { ObserveResult } from "../../models";
import type { ObserveScreen } from "./interfaces/ObserveScreen";
import { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { logger } from "../../utils/logger";
import { hierarchyUpdatedAtToMillis } from "./observeTimestamp";

/**
 * Shared observe poll loop for the settle / wait-for-condition primitives
 * (issue #4389). Both are the same loop with a different stop test, so the
 * monotonic-freshness and budget logic — the subtle correctness — lives here
 * once.
 */
export interface ObservePollOptions {
  /** Physical panel for every capture in this poll. */
  display?: string;
  /**
   * Hard budget in ms. Mandatory: the loop stops scheduling polls once elapsed
   * time reaches it. Poll sleeps are capped at the remaining budget; terminal
   * work may outlive the loop budget, so `waitMs` can still exceed `timeoutMs`.
   */
  timeoutMs: number;
  /** Poll interval in ms between observations. */
  pollMs: number;
  signal?: AbortSignal;
  /**
   * Optional seed for the entering reference / monotonic floor, in the SAME
   * clock domain they live in end-to-end: the device-authored `updatedAt`
   * (issue #6284). Supply a device-clock-domain timestamp (e.g. the capture
   * that triggered a post-tap settle) so the FIRST poll is forced STRICTLY past
   * that capture (`> reference`) — it can neither re-read that same cache entry
   * nor accept it as terminal evidence. Omit it for the default path: the first
   * poll then takes a baseline capture (which likewise cannot be terminal) and
   * subsequent polls are forced strictly past THAT baseline until a genuine
   * post-invocation read arrives.
   *
   * Never pass a host-clock timestamp here. An Android device clock trailing
   * the daemon (issue #5377) would make every genuinely-fresh device capture
   * look older than a host-domain floor, so the freshness gate
   * (`updatedAt >= minTimestamp`) would reject fresh reads and the loop would
   * burn its whole budget instead of settling promptly.
   */
  initialMinTimestampMs?: number;
  /**
   * Opt out of waiting for a hierarchy push when a cache misses the floor.
   * The embedded settle gate uses the existing sync re-extraction path on a
   * still screen; the strict device-timestamp floor remains unchanged.
   * Default false preserves standalone settle and waitFor push-wait behaviour.
   */
  skipWaitForFresh?: boolean;
  /** Embedded gate only: re-extract unverified Android cache hits with a positive floor. */
  requireFreshExtraction?: boolean;
  /**
   * Resume polling when a finishing capture invalidates a match and budget remains.
   * Embedded settle opts in; default false preserves standalone terminal behaviour.
   */
  resumeOnTerminalMismatch?: boolean;
  /**
   * Skip the performance audit on every poll (issue #6890 review).
   *
   * Polls already skip the screenshot and the accessibility audit because they
   * are intermediate state, but the performance audit is the expensive one: it
   * drives up to three synthetic touches plus ADB/database work that honours
   * none of this loop's budget, so on a short-budget loop it both perturbs the
   * screen being observed and corrupts its own measurement. Off by default so
   * the long-budget public `waitFor`/`observe` paths keep today's behaviour;
   * the embedded-observation settle gate (#6866), which runs after EVERY
   * navigation action on a one-second budget, opts in.
   */
  skipPerformanceAudit?: boolean;
  /**
   * Skip recomposition processing on intermediate polls, then process only the
   * terminal observation once (#6932).
   */
  skipRecompositionTracking?: boolean;
  /** Keep activity-dependent predicates reconciled each poll; otherwise defer the read (D42/#6598). */
  readBackStackEachPoll?: boolean;
}

export interface ObservePollOutcome {
  /** The observation the loop stopped on (matched/settled, or last polled). */
  observation: ObserveResult;
  /** Number of observations taken. */
  polls: number;
  /** Wall-clock spent (per the injected Timer). */
  waitMs: number;
  /**
   * True when `onObservation` requested the stop (matched/settled); false when
   * the loop exited on the budget or a screen-off fast-fail.
   */
  stopped: boolean;
  /** Why the loop produced this observation. */
  terminalReason: "matched" | "screen_off" | "timeout";
}

/**
 * Screen-off is Android-only (`wakefulness`). iOS observations carry no
 * wakefulness signal, so they read as awake — the loop stays cross-platform.
 */
function isScreenOff(observation: ObserveResult): boolean {
  return observation.wakefulness === "Asleep";
}

/** A rootless screen-off sample is terminal only when ADB read it on this call. */
function isIndependentScreenOff(observation: ObserveResult): boolean {
  return isScreenOff(observation) && observation.wakefulnessSource === "adb";
}

/**
 * A poll can advance a device-clock floor only when it carries a complete
 * hierarchy and that hierarchy itself carries the device capture timestamp.
 * The top-level observation timestamp can be host-created for a partial base
 * result, so it must never participate in this contract.
 */
function deviceCaptureTimestamp(observation: ObserveResult): number | undefined {
  const hierarchy = observation.viewHierarchy;
  if (
    !hierarchy ||
    typeof hierarchy.hierarchy !== "object" ||
    hierarchy.hierarchy === null ||
    "error" in hierarchy.hierarchy
  ) {
    return undefined;
  }
  return hierarchyUpdatedAtToMillis(hierarchy);
}

/**
 * The `minTimestamp` floor for the next poll (issue #6284). Before a genuine
 * post-invocation capture exists, force the poll STRICTLY past the entering
 * reference (`reference + 1`) so the delegate cannot serve a still-fresh
 * pre-call cache entry as the answer. Afterwards, floor inclusively on the
 * monotonic device floor so a static screen settles without a fresh-wait every
 * poll. `0` means "no floor" to `ObserveScreen.execute` (only `> 0` constrains).
 */
function nextPollMinTimestamp(
  hasPostInvocationEvidence: boolean,
  deviceFloor: number | undefined,
  enteringReference: number | undefined,
): number {
  if (hasPostInvocationEvidence) {
    return deviceFloor !== undefined && deviceFloor > 0 ? deviceFloor : 0;
  }
  return enteringReference !== undefined && enteringReference > 0 ? enteringReference + 1 : 0;
}

/**
 * Await terminal best-effort work only while this poll still has budget and its
 * request remains live. Losing either race leaves the underlying work running:
 * its eventual settlement is observed here so it cannot become unhandled.
 */
async function awaitFinalizationWhilePollIsLive(
  workPromise: Promise<void>,
  timer: Timer,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const timedOut = new Error("Observe poll finalization deadline reached");
  let result: "settled" | "deadline" | "aborted";
  try {
    await raceWithDeadline(workPromise, {
      timer,
      timeoutMs: Math.max(0, remainingMs),
      signal,
      label: "Observe poll finalization",
      timeoutError: () => timedOut,
    });
    result = "settled";
  } catch (error) {
    if (signal?.aborted) {
      result = "aborted";
    } else if (error === timedOut) {
      result = "deadline";
    } else {
      throw error;
    }
  }

  if (result === "settled") {
    return;
  }

  void workPromise
    .then(() => {
      logger.debug("[ObservePoll] Background terminal finalization settled after poll completion");
    })
    .catch((error: unknown) => {
      // A late best-effort persistence failure cannot change an already-returned observation.
      logger.debug(`[ObservePoll] Background terminal finalization failed: ${error}`);
    });
}

type PollingObserveScreen = Pick<
  ObserveScreen,
  | "execute"
  | "processRecomposition"
  | "captureCacheGeneration"
  | "cacheObserveResult"
  | "collectDeferredBackStack"
>;

interface PollCapture {
  observation: ObserveResult;
  generation?: number;
  cachedAt: number;
}

function isCompleteFreshCapture(observation: ObserveResult): boolean {
  return (
    deviceCaptureTimestamp(observation) !== undefined &&
    observation.freshness?.isFresh !== false &&
    observation.freshness?.verified !== false
  );
}

interface PollFreshnessState {
  enteringReference?: number;
  // Monotonic device-clock-domain floor; `undefined` until the first capture.
  deviceFloor?: number;
  // Set once any capture is strictly newer than the entering reference — from
  // then on the floor relaxes to inclusive so a static screen can settle.
  hasPostInvocationEvidence: boolean;
}

function isExplicitlyStaleCapture(observation: ObserveResult): boolean {
  // A timestamp alone cannot make a capture admissible. ObserveScreen marks
  // wrong-window and incomplete hierarchies stale even when CtrlProxy was
  // able to stamp them; those trees must neither satisfy a predicate nor
  // advance stateful settle predicates.
  // `isFresh` can be normalized back to true when a cached hierarchy happens
  // to meet a requested timestamp floor. The delegate's `verified: false`
  // still says that no synchronous device read confirmed this sample, so it
  // cannot become polling evidence merely because its cached timestamp is
  // recent enough.
  return observation.freshness?.isFresh === false || observation.freshness?.verified === false;
}

function selectTimeoutCapture(last: PollCapture, newestTrustworthy?: PollCapture) {
  return {
    capture: newestTrustworthy ?? last,
    canProcessRecomposition: newestTrustworthy !== undefined,
  };
}

function isAdmissibleCapture(
  observedMs: number | undefined,
  deviceFloor: number | undefined,
  isExplicitlyStale: boolean,
): boolean {
  // `Math.max` guarantees a stale/cached capture can never LOWER the floor.
  const meetsPriorFloor =
    observedMs !== undefined && (deviceFloor === undefined || observedMs >= deviceFloor);
  return meetsPriorFloor && !isExplicitlyStale;
}

function recordPollFreshness(observation: ObserveResult, state: PollFreshnessState) {
  const observedMs = deviceCaptureTimestamp(observation);
  const isExplicitlyStale = isExplicitlyStaleCapture(observation);
  // Unseeded: the first observation is a throwaway baseline. It establishes
  // the entering reference (and the floor) but can never itself be terminal
  // evidence — it may be the pre-call cache the loop must read past.
  if (state.enteringReference === undefined && observedMs !== undefined) {
    state.enteringReference = observedMs;
  }
  const isAdmissibleEvidence = isAdmissibleCapture(
    observedMs,
    state.deviceFloor,
    isExplicitlyStale,
  );
  if (isAdmissibleEvidence && observedMs !== undefined) {
    state.deviceFloor =
      state.deviceFloor === undefined ? observedMs : Math.max(state.deviceFloor, observedMs);
  }
  // Strictly newer than the entering/baseline capture => a genuine
  // post-invocation read the caller may act on.
  const isPostInvocation =
    observedMs !== undefined &&
    state.enteringReference !== undefined &&
    observedMs > state.enteringReference &&
    isAdmissibleEvidence;
  if (isPostInvocation) {
    state.hasPostInvocationEvidence = true;
  }
  return { isAdmissibleEvidence, isPostInvocation };
}

function isTerminalScreenOff(
  observation: ObserveResult,
  isAdmissibleEvidence: boolean,
  isPostInvocation: boolean,
): boolean {
  const isHierarchySourcedScreenOff =
    isScreenOff(observation) && observation.wakefulnessSource === "hierarchy";
  return (
    isIndependentScreenOff(observation) ||
    (isScreenOff(observation) &&
      isAdmissibleEvidence &&
      (!isHierarchySourcedScreenOff || isPostInvocation))
  );
}

interface PollFinalizationContext {
  observeScreen: PollingObserveScreen;
  timer: Timer;
  options: ObservePollOptions;
  start: number;
  onObservation: Parameters<typeof pollObserveUntil>[3];
}

type PollFinalizationResult =
  | { kind: "terminal"; outcome: ObservePollOutcome }
  | {
      kind: "resume";
      outcome: ObservePollOutcome;
      capture: PollCapture;
      isAdmissibleEvidence: boolean;
    };

/** Keep rejected finishing reads out of both the baseline and timeout evidence. */
function adoptResumedCapture(
  result: Extract<PollFinalizationResult, { kind: "resume" }>,
  original: ObserveResult,
  newestTrustworthyCapture: PollCapture | undefined,
) {
  if (result.isAdmissibleEvidence) {
    return { previous: result.capture.observation, newestTrustworthyCapture: result.capture };
  }
  return { previous: original, newestTrustworthyCapture };
}

function revalidateTerminalMatch(
  context: PollFinalizationContext,
  freshnessState: PollFreshnessState,
  outcome: ObservePollOutcome,
  original: ObserveResult,
  capture: PollCapture,
): PollFinalizationResult | undefined {
  if (!outcome.stopped) {
    return undefined;
  }
  const { options, timer, start, onObservation } = context;
  const evidence = options.resumeOnTerminalMismatch
    ? recordPollFreshness(capture.observation, freshnessState)
    : { isAdmissibleEvidence: true, isPostInvocation: true };
  const stillMatched =
    evidence.isAdmissibleEvidence &&
    evidence.isPostInvocation &&
    onObservation(capture.observation, original, outcome.polls);
  if (stillMatched) {
    return undefined;
  }
  outcome.stopped = false;
  outcome.terminalReason = "timeout";
  // Publish the newest full-pipeline capture only on a terminal outcome.
  // Embedded settle instead resumes with admissible evidence while time remains.
  if (options.resumeOnTerminalMismatch && timer.now() - start < options.timeoutMs) {
    return {
      kind: "resume",
      outcome,
      capture,
      isAdmissibleEvidence: evidence.isAdmissibleEvidence,
    };
  }
  return undefined;
}

function createPollFinalizer(context: PollFinalizationContext, freshnessState: PollFreshnessState) {
  const { observeScreen, timer, options, start } = context;
  return async (
    outcome: ObservePollOutcome,
    canProcessRecomposition: boolean = true,
    generation?: number,
    cachedAt?: number,
  ): Promise<PollFinalizationResult> => {
    const refreshed = await reconcileTerminalCapture(
      observeScreen,
      timer,
      options,
      outcome.observation,
      nextPollMinTimestamp(
        freshnessState.hasPostInvocationEvidence,
        freshnessState.deviceFloor,
        freshnessState.enteringReference,
      ),
    );
    if (refreshed) {
      const original = outcome.observation;
      outcome.observation = refreshed.observation;
      outcome.polls++;
      outcome.waitMs = timer.now() - start;
      generation = refreshed.generation;
      cachedAt = refreshed.cachedAt;
      canProcessRecomposition = isCompleteFreshCapture(refreshed.observation);
      const resume = revalidateTerminalMatch(context, freshnessState, outcome, original, refreshed);
      if (resume) {
        return resume;
      }
    }
    throwIfAborted(options.signal);
    if (
      options.skipRecompositionTracking &&
      canProcessRecomposition &&
      observeScreen.processRecomposition
    ) {
      const workPromise = (async (): Promise<void> => {
        await observeScreen.processRecomposition!(outcome.observation);
        await observeScreen.cacheObserveResult?.(outcome.observation, generation, cachedAt);
      })();
      await awaitFinalizationWhilePollIsLive(
        workPromise,
        timer,
        options.timeoutMs - (timer.now() - start),
        options.signal,
      );
    } else {
      await observeScreen.cacheObserveResult?.(outcome.observation, generation, cachedAt);
    }
    return { kind: "terminal", outcome };
  };
}

/** Bind deferred cache metadata to the capture that will actually be published. */
async function capturePoll(
  observeScreen: PollingObserveScreen,
  timer: Timer,
  options: ObservePollOptions,
  minTimestamp: number,
  timeoutMs?: number,
  readBackStackEachPoll = options.readBackStackEachPoll,
): Promise<PollCapture> {
  const generation = observeScreen.captureCacheGeneration?.();
  const cachedAt = timer.now();
  const observation = await observeScreen.execute({
    display: options.display,
    freshness: options.display === undefined ? undefined : "fresh",
    minTimestamp,
    timeoutMs,
    skipWaitForFresh: options.skipWaitForFresh ?? false,
    requireFreshExtraction: options.requireFreshExtraction,
    signal: options.signal,
    // Polls defer evidence and persistence until the selected terminal capture.
    skipScreenshot: true,
    skipStaleWindowRecovery: true,
    skipCache: true,
    skipBackStack: readBackStackEachPoll === true ? undefined : true,
    skipAccessibilityAudit: true,
    skipPerformanceAudit: options.skipPerformanceAudit,
    skipRecompositionTracking: options.skipRecompositionTracking,
  });
  return { observation, generation, cachedAt };
}

/** Terminal work may outlive the loop budget, but never cancellation. */
async function reconcileTerminalCapture(
  observeScreen: PollingObserveScreen,
  timer: Timer,
  options: ObservePollOptions,
  observation: ObserveResult,
  minTimestamp: number,
): Promise<PollCapture | undefined> {
  if (options.readBackStackEachPoll || !observeScreen.collectDeferredBackStack) {
    return undefined;
  }
  const disagrees = await raceWithDeadline(
    () => observeScreen.collectDeferredBackStack!(observation, { signal: options.signal }),
    { timer, signal: options.signal, label: "Observe poll terminal back stack" },
  );
  throwIfAborted(options.signal);
  if (!disagrees) {
    return undefined;
  }
  try {
    // No exhausted remaining budget: use execute's normal capture timeout,
    // while the outer race (like the terminal read) is bounded only by abort.
    const capture = await raceWithDeadline(
      () => capturePoll(observeScreen, timer, options, minTimestamp, undefined, true),
      { timer, signal: options.signal, label: "Observe poll attribution reconciliation" },
    );
    throwIfAborted(options.signal);
    return capture;
  } catch (error) {
    throwIfAborted(options.signal);
    logger.warn(
      "[ObservePoll] Terminal attribution poll failed; returning original observation",
      error,
    );
    return undefined;
  }
}

/**
 * Poll `observeScreen` until `onObservation` returns true or the budget expires.
 *
 * Freshness lives in ONE clock domain end-to-end — the device-authored
 * `updatedAt` (issue #6284) — and turns on two related quantities:
 *
 *  - The **entering reference**: the device timestamp the loop must get strictly
 *    PAST before any observation can count as terminal evidence. Seeded from
 *    `initialMinTimestampMs` when the caller supplies one (the capture that
 *    triggered a post-tap settle); otherwise the loop's own FIRST observation is
 *    a throwaway baseline that establishes it. Either way that reference is a
 *    pre-invocation capture, so a match against it would prove nothing about the
 *    current screen: a public `waitFor` could report a condition that ceased to
 *    be true just before the call, and a settle could declare stability without
 *    ever reading past the cache the call started from. So until the loop
 *    obtains a capture whose `updatedAt` is STRICTLY newer than the entering
 *    reference (`> reference`, via a `reference + 1` floor that forces the
 *    delegate past any still-fresh cache entry — issue #6284 P1), a `true` from
 *    `onObservation` is ignored.
 *  - The **monotonic device floor**: once a genuine post-invocation capture is
 *    in hand, later polls floor INCLUSIVELY (`updatedAt >= floor`, floor =
 *    `Math.max` of every capture seen) so a static screen settles promptly
 *    instead of forcing a full fresh-wait every poll, while a stale/cached
 *    capture returned by a timed-out sub-poll can never LOWER the floor and
 *    re-satisfy a predicate with an older hash.
 *
 * Never pass a host-clock value as `initialMinTimestampMs`: a device clock
 * trailing the daemon (issue #5377) would make every fresh capture look older
 * than a host-domain floor and burn the whole budget. On a screen-off (Android)
 * capture the loop fast-fails rather than burning the budget against a dark
 * screen.
 */
export async function pollObserveUntil(
  observeScreen: PollingObserveScreen,
  timer: Timer,
  options: ObservePollOptions,
  onObservation: (
    observation: ObserveResult,
    previous: ObserveResult | undefined,
    pollIndex: number,
  ) => boolean,
): Promise<ObservePollOutcome> {
  const start = timer.now();
  let previous: ObserveResult | undefined;
  let lastCapture: PollCapture | undefined;
  let polls = 0;
  // The device timestamp the loop must get STRICTLY past before an observation
  // can be terminal. `undefined` until seeded by the caller or by the first
  // (baseline) observation.
  const freshnessState: PollFreshnessState = {
    enteringReference: options.initialMinTimestampMs,
    deviceFloor: options.initialMinTimestampMs,
    hasPostInvocationEvidence: false,
  };
  // Preserve the newest complete, non-regressing device capture for timeout
  // results. A late stale fallback must not replace evidence that already met a
  // raised floor (e.g. 10 -> 30 -> 20).
  let newestTrustworthyCapture: PollCapture | undefined;
  const finalize = createPollFinalizer(
    { observeScreen, timer, options, start, onObservation },
    freshnessState,
  );

  while (true) {
    throwIfAborted(options.signal);
    if (lastCapture && timer.now() - start >= options.timeoutMs) {
      const { capture, canProcessRecomposition } = selectTimeoutCapture(
        lastCapture,
        newestTrustworthyCapture,
      );
      return (
        await finalize(
          {
            observation: capture.observation,
            polls,
            waitMs: timer.now() - start,
            stopped: false,
            terminalReason: "timeout",
          },
          canProcessRecomposition,
          capture.generation,
          capture.cachedAt,
        )
      ).outcome;
    }

    const minTimestamp = nextPollMinTimestamp(
      freshnessState.hasPostInvocationEvidence,
      freshnessState.deviceFloor,
      freshnessState.enteringReference,
    );
    const capture = await capturePoll(
      observeScreen,
      timer,
      options,
      minTimestamp,
      Math.max(1, options.timeoutMs - (timer.now() - start)),
    );
    const { observation, generation: cacheGeneration, cachedAt: cacheStartedAt } = capture;
    polls++;
    lastCapture = capture;
    throwIfAborted(options.signal);

    const { isAdmissibleEvidence, isPostInvocation } = recordPollFreshness(
      observation,
      freshnessState,
    );
    if (isAdmissibleEvidence) {
      newestTrustworthyCapture = capture;
    }

    // A screen-off terminal is only meaningful when the same observation passed
    // the admission contract. A stale cached "Asleep" frame after the device
    // wakes must not fast-fail a public wait or be promoted by tap settlement.
    // A hierarchy reports wakefulness from the same cache as its tree. Even a
    // young cache may predate the invocation, so hierarchy-sourced screen-off
    // needs the same strictly-post-invocation proof as an ordinary match. ADB
    // wakefulness is independently sampled on this poll and remains terminal
    // immediately, including when no hierarchy is available.
    if (isTerminalScreenOff(observation, isAdmissibleEvidence, isPostInvocation)) {
      return (
        await finalize(
          {
            observation,
            polls,
            waitMs: timer.now() - start,
            stopped: false,
            terminalReason: "screen_off",
          },
          isAdmissibleEvidence,
          cacheGeneration,
          cacheStartedAt,
        )
      ).outcome;
    }

    // Rejected observations are deliberately invisible to stateful predicates:
    // allowing a below-floor A to update `previous` between B and a later A
    // could manufacture a two-sample settle from regressed evidence.
    const matched = isAdmissibleEvidence && onObservation(observation, previous, polls);
    if (matched && isPostInvocation) {
      const result = await finalize(
        {
          observation,
          polls,
          waitMs: timer.now() - start,
          stopped: true,
          terminalReason: "matched",
        },
        true,
        cacheGeneration,
        cacheStartedAt,
      );
      if (result.kind === "terminal") {
        return result.outcome;
      }
      polls = result.outcome.polls;
      lastCapture = result.capture;
      ({ previous, newestTrustworthyCapture } = adoptResumedCapture(
        result,
        observation,
        newestTrustworthyCapture,
      ));
      // Yield at least one timer tick on retries, even with pollMs: 0, so
      // repeated terminal contradictions cannot spin without spending budget.
      await awaitWhileRequestIsLive(
        timer.sleep(
          Math.min(
            Math.max(1, options.pollMs),
            Math.max(0, options.timeoutMs - (timer.now() - start)),
          ),
        ),
        options.signal,
      );
      continue;
    }

    if (isAdmissibleEvidence) {
      previous = observation;
    }

    if (timer.now() - start >= options.timeoutMs) {
      const { capture: timeoutCapture, canProcessRecomposition } = selectTimeoutCapture(
        capture,
        newestTrustworthyCapture,
      );
      return (
        await finalize(
          {
            observation: timeoutCapture.observation,
            polls,
            waitMs: timer.now() - start,
            stopped: false,
            terminalReason: "timeout",
          },
          canProcessRecomposition,
          timeoutCapture.generation,
          timeoutCapture.cachedAt,
        )
      ).outcome;
    }

    await awaitWhileRequestIsLive(
      timer.sleep(Math.min(options.pollMs, Math.max(0, options.timeoutMs - (timer.now() - start)))),
      options.signal,
    );
  }
}
