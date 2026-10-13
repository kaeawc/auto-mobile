import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";

interface RecorderRetry {
  retry: () => Promise<void>;
  retryTimeoutMs: number;
}

/** Unconfirmed work survives exhaustion; keyed replacements cannot be acknowledged by old work. */
export class RecorderTeardownRetries {
  private readonly entries = new Map<string | symbol, RecorderRetry>();
  revision = 0;

  add(retry: () => Promise<void>, retryTimeoutMs: number, retryKey?: string): void {
    this.entries.set(retryKey ?? Symbol(), { retry, retryTimeoutMs });
    this.revision++;
  }

  get empty(): boolean {
    return this.entries.size === 0;
  }

  get timeoutMs(): number {
    return Math.max(0, ...Array.from(this.entries.values(), (entry) => entry.retryTimeoutMs));
  }

  async dispatch(): Promise<void> {
    const snapshot = [...this.entries];
    await Promise.all(
      snapshot.map(async ([key, entry]) => {
        try {
          await entry.retry();
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }
        } catch (error) {
          logger.warn("Recorder teardown retry remains unconfirmed", error);
        }
      }),
    );
    if (!this.empty) {
      throw new Error("Recorder teardown retries remain unconfirmed");
    }
  }
}

interface RecorderRecoveryDeps {
  timer: Timer;
  delays: number[];
  isCurrent(): Promise<boolean>;
  canRecover(): boolean;
  acceptingSessions(): boolean;
  dispatch(retry: () => Promise<void>): Promise<void>;
  publishDeadline(deadline: number | undefined): void;
  clear(): void;
  drop(): void;
}

function remainingBudget(
  retries: RecorderTeardownRetries,
  delays: number[],
  attempt: number,
  sleeping: boolean,
): number {
  return delays
    .slice(attempt - 1)
    .reduce(
      (total, delay, index) =>
        total + retries.timeoutMs * (attempt + index) + (index > 0 || sleeping ? delay : 0),
      0,
    );
}

async function settleDispatch(
  inFlight: Promise<void>,
  timeoutMs: number,
  deps: RecorderRecoveryDeps,
): Promise<void> {
  const timeout = new Error("Recorder teardown recovery timed out");
  try {
    await raceWithDeadline(inFlight, {
      timer: deps.timer,
      timeoutMs,
      label: "Recorder teardown recovery",
      timeoutError: () => timeout,
    });
  } catch (error) {
    logger.warn("Recorder teardown recovery dispatch failed", error);
    if (error === timeout) {
      deps.publishDeadline(undefined);
      // Never overlap a timed-out composite; its individual late successes still count.
      try {
        await inFlight;
      } catch (lateError) {
        logger.warn("Timed-out recorder teardown recovery failed late", lateError);
      }
    }
  }
}

/** Only dispatched attempts consume the budget; additions get a fresh three-attempt budget. */
export async function recoverRecorderTeardowns(
  retries: RecorderTeardownRetries,
  deps: RecorderRecoveryDeps,
): Promise<number> {
  let revision = retries.revision;
  for (let attempt = 1; attempt <= 3;) {
    if (revision !== retries.revision) {
      attempt = 1;
      revision = retries.revision;
    }
    deps.publishDeadline(deps.timer.now() + remainingBudget(retries, deps.delays, attempt, true));
    await deps.timer.sleep(deps.delays[attempt - 1]!);
    if (!(await deps.isCurrent())) {
      deps.drop();
      return retries.revision;
    }
    if (!deps.canRecover()) {
      if (!deps.acceptingSessions()) {
        return retries.revision;
      }
      continue;
    }
    if (revision !== retries.revision) {
      attempt = 1;
    }
    revision = retries.revision;
    const timeoutMs = retries.timeoutMs * attempt;
    deps.publishDeadline(deps.timer.now() + remainingBudget(retries, deps.delays, attempt, false));
    const inFlight = deps.dispatch(() => retries.dispatch());
    await settleDispatch(inFlight, timeoutMs, deps);
    if (!(await deps.isCurrent())) {
      deps.drop();
      return retries.revision;
    }
    if (retries.empty) {
      deps.clear();
      deps.drop();
      return retries.revision;
    }
    attempt = revision !== retries.revision ? 1 : attempt + 1;
    revision = retries.revision;
  }
  return revision;
}
