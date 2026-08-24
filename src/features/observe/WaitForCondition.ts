import type { ObserveScreen } from "./interfaces/ObserveScreen";
import type {
  ConditionEvaluation,
  ConditionPredicate,
  WaitForCondition,
  WaitForConditionOptions,
  WaitForConditionResult,
} from "./interfaces/WaitForCondition";
import { pollObserveUntil } from "./ObservePoll";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 150;

/**
 * Poll the screen until a predicate over the hierarchy holds (issue #4389).
 *
 * Resolves with the matched element; on timeout returns the last poll's near-
 * matches so the model can debug a failed wait rather than getting a bare
 * `false`. Shares `pollObserveUntil` with `RealSettleObserve`, so the monotonic-
 * minTimestamp freshness guarantee is identical. The predicate is injected and
 * cross-platform — the tool layer builds it from a declarative selector.
 */
export class RealWaitForCondition implements WaitForCondition {
  constructor(
    private readonly observeScreen: ObserveScreen,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async execute(
    predicate: ConditionPredicate,
    options: WaitForConditionOptions = {},
  ): Promise<WaitForConditionResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

    let lastEvaluation: ConditionEvaluation = { matched: false, candidates: [] };

    const outcome = await pollObserveUntil(
      this.observeScreen,
      this.timer,
      { timeoutMs, pollMs, signal: options.signal },
      (observation) => {
        lastEvaluation = predicate(observation);
        return lastEvaluation.matched;
      },
    );

    if (outcome.stopped) {
      return {
        matched: true,
        matchedElement: lastEvaluation.matchedElement,
        candidates: [],
        observation: outcome.observation,
        polls: outcome.polls,
        waitMs: outcome.waitMs,
        timedOut: false,
      };
    }

    return {
      matched: false,
      matchedElement: undefined,
      candidates: lastEvaluation.candidates ?? [],
      observation: outcome.observation,
      polls: outcome.polls,
      waitMs: outcome.waitMs,
      timedOut: true,
    };
  }
}
