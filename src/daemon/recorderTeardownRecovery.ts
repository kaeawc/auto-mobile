import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import { DeviceUnreachableError } from "../models/DeviceUnreachableError";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";

export const ORPHAN_SCREENRECORD_EXIT_MARGIN_MS = 5_000;
export const RECORDER_TEARDOWN_RECHECK_MS =
  ANDROID_SCREENRECORD_MAX_SECONDS * 1_000 + ORPHAN_SCREENRECORD_EXIT_MARGIN_MS;

interface RecorderRetry {
  retry: () => Promise<void>;
  retryTimeoutMs: number;
}

/** Unconfirmed work survives exhaustion; keyed replacements cannot be acknowledged by old work. */
export class RecorderTeardownRetries {
  private readonly entries = new Map<string | symbol, RecorderRetry>();
  revision = 0;
  recheckUsed = false;

  constructor(
    private readonly reason: "recording-teardown" | "app-cleanup" = "recording-teardown",
  ) {}

  add(retry: () => Promise<void>, retryTimeoutMs: number, retryKey?: string): () => void {
    const key = retryKey ?? Symbol();
    const entry = { retry, retryTimeoutMs };
    this.entries.set(key, entry);
    this.revision++;
    this.recheckUsed = false;
    return () => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    };
  }

  get empty(): boolean {
    return this.entries.size === 0;
  }

  get timeoutMs(): number {
    return Math.max(0, ...Array.from(this.entries.values(), (entry) => entry.retryTimeoutMs));
  }

  async dispatch(): Promise<void> {
    const snapshot = [...this.entries];
    const failures: unknown[] = [];
    await Promise.all(
      snapshot.map(async ([key, entry]) => {
        try {
          await entry.retry();
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }
        } catch (error) {
          failures.push(error);
          logger.warn(
            `${this.reason === "recording-teardown" ? "Recorder teardown" : "App cleanup"} retry remains unconfirmed`,
            error,
          );
        }
      }),
    );
    if (!this.empty) {
      const Failure =
        this.reason === "recording-teardown" &&
        failures.length > 0 &&
        failures.every((error) => error instanceof DeviceUnreachableError)
          ? DeviceUnreachableError
          : Error;
      throw new Failure(
        `${this.reason === "recording-teardown" ? "Recorder teardown" : "App cleanup"} retries remain unconfirmed`,
      );
    }
  }
}

interface RecorderRecoveryDeps {
  reason?: "recording-teardown" | "app-cleanup";
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
): Promise<boolean> {
  const label = deps.reason === "app-cleanup" ? "App cleanup" : "Recorder teardown";
  const timeout = new Error(`${label} recovery timed out`);
  try {
    await raceWithDeadline(inFlight, {
      timer: deps.timer,
      timeoutMs,
      label: `${label} recovery`,
      timeoutError: () => timeout,
    });
  } catch (error) {
    logger.warn(`${label} recovery dispatch failed`, error);
    if (error === timeout) {
      deps.publishDeadline(undefined);
      // Never overlap a timed-out composite; its individual late successes still count.
      try {
        await inFlight;
      } catch (lateError) {
        logger.warn(`Timed-out ${label.toLowerCase()} recovery failed late`, lateError);
        return lateError instanceof DeviceUnreachableError;
      }
    } else {
      return error instanceof DeviceUnreachableError;
    }
  }
  return false;
}

/** Only reached attempts consume the budget; additions get a fresh three-attempt budget. */
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
    const unreachable = await settleDispatch(inFlight, timeoutMs, deps);
    if (!(await deps.isCurrent())) {
      deps.drop();
      return retries.revision;
    }
    if (retries.empty) {
      deps.clear();
      deps.drop();
      return retries.revision;
    }
    if (unreachable) {
      if (!deps.acceptingSessions()) {
        return retries.revision;
      }
      continue;
    }
    attempt = revision !== retries.revision ? 1 : attempt + 1;
    revision = retries.revision;
  }
  return revision;
}
