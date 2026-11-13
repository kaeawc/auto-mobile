import type { ObserveScreen } from "./interfaces/ObserveScreen";
import type { SettleObserve, SettleOptions, SettleResult } from "./interfaces/SettleObserve";
import { diffObserveResult, isSameObservationScreen } from "./output/ObserveResultOutput";
import type { ObserveDiff } from "./output/ObserveResultOutput";
import { pollObserveUntil } from "./ObservePoll";
import { prototypeMotionActive } from "./prototypeMotion";
import {
  VolatileTextTracker,
  splitVolatileChanges,
  untrackableIdentities,
} from "./settleVolatileText";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import type { ObserveResult } from "../../models";

export const DEFAULT_SETTLE_TIMEOUT_MS = 2500;
export const DEFAULT_SETTLE_POLL_MS = 150;
export const DEFAULT_SETTLE_STABLE_READS = 2;

/**
 * Whether a structural diff represents a *stable* screen for settle purposes.
 * Stable means: nothing added or removed, no diffed top-level `fields` changed
 * (`diffObserveResult` only sets `fields` on an actual change, so absence means
 * unchanged), and no matched node changes. The shared diff ignores volatile
 * capture attributes, including occlusion metadata, so every remaining change is
 * actionable instability.
 */
export function isStabilityDiffEmpty(diff: ObserveDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.fields === undefined
  );
}

/**
 * Feed the tracker the diff from the caller's own capture to the first poll
 * (#17749): a genuine device read of the same screen, so a node already ticking
 * across the action needs one poll fewer to be proven volatile. The diff never
 * counts toward the stable-read run. Skipped for another screen or a capture
 * taken mid-motion, where the diff is not a tick.
 */
function seedFromReference(
  tracker: VolatileTextTracker,
  reference: ObserveResult | undefined,
  first: ObserveResult,
): void {
  if (
    reference === undefined ||
    prototypeMotionActive(reference.viewHierarchy) > 0 ||
    !isSameObservationScreen(reference, first)
  ) {
    return;
  }
  tracker.mask(diffObserveResult(reference, first), untrackableIdentities(reference, first));
}

/**
 * Poll the screen until the view hierarchy is structurally stable (issue #4389).
 *
 * The stability comparator is the #3053 structural diff (`diffObserveResult`
 * emptiness, gated by `isSameObservationScreen`) — NOT `JSON.stringify`. The diff
 * ignores volatile attributes (`extras`, synthetic `view-id`) and treats a pure
 * scroll as a small keyed delta, so a genuinely static screen settles even when
 * its raw JSON churns, while a spinner/animation correctly reads as not-settled
 * and the mandatory timeout governs. A node whose text alone changes in two
 * of three recent diffs (a running clock, a typing indicator) is masked for the
 * rest of the settle by {@link VolatileTextTracker}, so such a screen settles once
 * everything else holds still (#17670). A node that blinks (its visibility
 * flips) is treated the same way, and while ticks are the only change the loop
 * may spend `volatileExtensionMs` past its budget to confirm them (#17749).
 *
 * Returns only the final snapshot — the intermediate transition hierarchies never
 * reach the caller. DI mirrors `AwaitIdle`: `timer` is the last constructor param.
 */
export class RealSettleObserve implements SettleObserve {
  constructor(
    private readonly observeScreen: ObserveScreen,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async captureScreenshot(observation: ObserveResult, signal?: AbortSignal): Promise<void> {
    await this.observeScreen.captureScreenshot?.(undefined, { signal, observation });
  }

  async execute(options: SettleOptions = {}): Promise<SettleResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_SETTLE_POLL_MS;
    const stableReads = options.stableReads ?? DEFAULT_SETTLE_STABLE_READS;

    // Length of the current run of consecutive structurally-equal snapshots.
    let equalRun = 0;
    // The next poll must read the device, not serve the cached capture that reported motion: an
    // animation ending changes no node and fires no event, so a cache would stay "active" (#15114).
    let motionPending = false;
    // Repeated text ticks or visibility blinks are masked once confirmed (#17670, #17749).
    const volatileText = new VolatileTextTracker();
    // Whether only ticking or blinking nodes have changed since the last tick (#17749).
    let onlyTicking = false;
    const volatileExtensionMs = Math.max(0, options.volatileExtensionMs ?? 0);

    const outcome = await pollObserveUntil(
      this.observeScreen,
      this.timer,
      {
        display: options.display,
        timeoutMs,
        pollMs,
        signal: options.signal,
        initialMinTimestampMs: options.initialMinTimestampMs,
        skipWaitForFresh: options.skipWaitForFresh,
        get requireFreshExtraction() {
          return motionPending || options.requireFreshExtraction;
        },
        resumeOnTerminalMismatch: options.resumeOnTerminalMismatch,
        hardBudget: options.hardBudget,
        budgetExtensionMs: () => (onlyTicking ? volatileExtensionMs : 0),
        skipPerformanceAudit: options.skipPerformanceAudit,
        skipRecompositionTracking: options.skipRecompositionTracking,
      },
      (observation, previous) => {
        // A prototype fade or slide changes no node, so two identical trees prove nothing while the
        // device still reports animations settling (#15114); the timeout bounds the wait.
        motionPending = prototypeMotionActive(observation.viewHierarchy) > 0;
        if (motionPending) {
          onlyTicking = false;
          equalRun = 0;
          // A motion read is not diffed, so later diffs are not consecutive with
          // earlier ones, and the screen may change behind it: start over.
          volatileText.reset();
          return false;
        }
        if (previous === undefined) {
          seedFromReference(volatileText, options.referenceObservation, observation);
          equalRun = 1;
          return equalRun >= stableReads;
        }
        if (!isSameObservationScreen(previous, observation)) {
          onlyTicking = false;
          volatileText.reset();
          equalRun = 1;
          return equalRun >= stableReads;
        }
        const diff = diffObserveResult(previous, observation);
        const untrackable = untrackableIdentities(previous, observation);
        const split = splitVolatileChanges(diff, untrackable);
        // A tick grants the extension and any other change withdraws it; an
        // empty diff keeps it, so a tick confirmed on this read can still
        // finish its terminal back-stack read.
        onlyTicking = isStabilityDiffEmpty(split.rest) && (split.ticks > 0 || onlyTicking);
        const structurallyStable = isStabilityDiffEmpty(volatileText.mask(diff, untrackable));
        equalRun = structurallyStable ? equalRun + 1 : 1;
        return equalRun >= stableReads;
      },
    );

    return {
      observation: outcome.observation,
      settled: outcome.stopped,
      polls: outcome.polls,
      waitMs: outcome.waitMs,
      terminalReason: outcome.terminalReason === "matched" ? "settled" : outcome.terminalReason,
    };
  }
}
