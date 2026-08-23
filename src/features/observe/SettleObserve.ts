import type { ObserveScreen } from "./interfaces/ObserveScreen";
import type { SettleObserve, SettleOptions, SettleResult } from "./interfaces/SettleObserve";
import { diffObserveResult, isSameObservationScreen } from "./output/ObserveResultOutput";
import type { ObserveDiff } from "./output/ObserveResultOutput";
import { pollObserveUntil } from "./ObservePoll";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_POLL_MS = 150;
const DEFAULT_STABLE_READS = 2;

/**
 * Whether a structural diff represents a *stable* screen for settle purposes.
 * Stable means: nothing added or removed, no diffed top-level `fields` changed
 * (`diffObserveResult` only sets `fields` on an actual change, so absence means
 * unchanged), and no matched node changes. The shared diff ignores volatile
 * capture attributes, including occlusion metadata, so every remaining change is
 * actionable instability.
 */
function isStabilityDiffEmpty(diff: ObserveDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.fields === undefined
  );
}

/**
 * Poll the screen until the view hierarchy is structurally stable (issue #4389).
 *
 * The stability comparator is the #3053 structural diff (`diffObserveResult`
 * emptiness, gated by `isSameObservationScreen`) — NOT `JSON.stringify`. The diff
 * ignores volatile attributes (`extras`, synthetic `view-id`) and treats a pure
 * scroll as a small keyed delta, so a genuinely static screen settles even when
 * its raw JSON churns, while a spinner/animation correctly reads as not-settled
 * and the mandatory timeout governs.
 *
 * Returns only the final snapshot — the intermediate transition hierarchies never
 * reach the caller. DI mirrors `AwaitIdle`: `timer` is the last constructor param.
 */
export class RealSettleObserve implements SettleObserve {
  constructor(
    private readonly observeScreen: ObserveScreen,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async execute(options: SettleOptions = {}): Promise<SettleResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const stableReads = options.stableReads ?? DEFAULT_STABLE_READS;

    // Length of the current run of consecutive structurally-equal snapshots.
    let equalRun = 0;

    const outcome = await pollObserveUntil(
      this.observeScreen,
      this.timer,
      { timeoutMs, pollMs, signal: options.signal },
      (observation, previous) => {
        if (previous === undefined) {
          equalRun = 1;
          return equalRun >= stableReads;
        }
        const structurallyStable =
          isSameObservationScreen(previous, observation) &&
          isStabilityDiffEmpty(diffObserveResult(previous, observation));
        equalRun = structurallyStable ? equalRun + 1 : 1;
        return equalRun >= stableReads;
      },
    );

    return {
      observation: outcome.observation,
      settled: outcome.stopped,
      polls: outcome.polls,
      waitMs: outcome.waitMs,
    };
  }
}
