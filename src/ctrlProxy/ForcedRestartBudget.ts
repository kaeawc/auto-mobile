import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export interface ForcedRestartSnapshot {
  readonly state: "idle" | "backoff" | "exhausted" | "suspended";
  readonly attempts: number;
  readonly lastFailureReason?: string;
  readonly nextAttemptAtMs?: number;
}

/** One manager-owned admission policy for client-triggered forced restarts. */
export class ForcedRestartBudget {
  private attempts = 0;
  private lastFailureReason: string | undefined;
  private nextAttemptAtMs: number | undefined;
  private suspendedReason: string | undefined;
  private inFlight = false;
  private generation = 0;
  private firstAttemptAtMs: number | undefined;

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly maxAttempts = 3,
    private readonly backoff: BackoffPolicy = exponentialBackoff({
      initialDelayMs: 30_000,
      multiplier: 2,
      maxDelayMs: 300_000,
    }),
    private readonly maxElapsedMs?: number,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("Forced restart maxAttempts must be a positive integer");
    }
    if (maxElapsedMs !== undefined && (!Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0)) {
      throw new Error("Forced restart maxElapsedMs must be positive and finite");
    }
  }

  /** Time left in this recovery episode; the first admitted attempt starts the clock. */
  timeRemainingMs(): number | undefined {
    return this.firstAttemptAtMs === undefined || this.maxElapsedMs === undefined
      ? undefined
      : Math.max(0, this.firstAttemptAtMs + this.maxElapsedMs - this.timer.now());
  }

  /** Reports the current admission state, including the next retry time while backing off. */
  snapshot(): ForcedRestartSnapshot {
    if (this.suspendedReason !== undefined) {
      return {
        state: "suspended",
        attempts: this.attempts,
        lastFailureReason: this.suspendedReason,
      };
    }
    if (this.timeRemainingMs() === 0) {
      return {
        state: "exhausted",
        attempts: this.attempts,
        lastFailureReason:
          `Recovery exceeded ${this.maxElapsedMs} ms` +
          (this.lastFailureReason ? `; last failure: ${this.lastFailureReason}` : ""),
      };
    }
    if (this.attempts >= this.maxAttempts) {
      return {
        state: "exhausted",
        attempts: this.attempts,
        ...(this.lastFailureReason === undefined
          ? {}
          : { lastFailureReason: this.lastFailureReason }),
      };
    }
    if (this.nextAttemptAtMs !== undefined && this.timer.now() < this.nextAttemptAtMs) {
      return {
        state: "backoff",
        attempts: this.attempts,
        ...(this.lastFailureReason === undefined
          ? {}
          : { lastFailureReason: this.lastFailureReason }),
        nextAttemptAtMs: this.nextAttemptAtMs,
      };
    }
    return { state: "idle", attempts: this.attempts };
  }

  /** Atomically admit one attempt. Its token invalidates late completions after rearm/suspend. */
  tryBeginAttempt(): number | undefined {
    if (this.inFlight || this.snapshot().state !== "idle") {
      return undefined;
    }
    this.inFlight = true;
    this.firstAttemptAtMs ??= this.timer.now();
    return ++this.generation;
  }

  /** Records only the current admitted attempt; stale tokens cannot consume budget. */
  recordFailure(reason: string, token: number): void {
    if (!this.inFlight || token !== this.generation) {
      return;
    }
    this.inFlight = false;
    this.lastFailureReason = reason;
    this.attempts++;
    this.nextAttemptAtMs =
      this.attempts >= this.maxAttempts
        ? undefined
        : this.timer.now() + this.backoff.delayForAttempt(this.attempts);
  }

  /**
   * Gives back an admitted attempt that never exercised the runner (e.g. the device was absent), so
   * it consumes no budget, records no failure, and starts no backoff. Stale tokens are ignored.
   */
  releaseAttempt(token: number): void {
    if (!this.inFlight || token !== this.generation) {
      return;
    }
    this.inFlight = false;
    if (this.attempts === 0) {
      // Time spent waiting for the device must not count toward the episode's elapsed limit.
      this.firstAttemptAtMs = undefined;
    }
  }

  /** Rearms the budget on success, rejecting a completion from an invalidated attempt. */
  recordSuccess(token?: number): boolean {
    if (token !== undefined && (!this.inFlight || token !== this.generation)) {
      return false;
    }
    if (token !== undefined && this.snapshot().state === "exhausted") {
      return false;
    }
    this.rearm("restart succeeded");
    return true;
  }

  /** Suspends admission and invalidates any in-flight attempt token. */
  suspend(reason: string): void {
    this.generation++;
    this.inFlight = false;
    this.suspendedReason = reason;
    this.nextAttemptAtMs = undefined;
  }

  /** Clears failures and suspension, invalidating any in-flight token so its completion is ignored. */
  rearm(_reason: string): void {
    this.generation++;
    this.inFlight = false;
    this.attempts = 0;
    this.firstAttemptAtMs = undefined;
    this.lastFailureReason = undefined;
    this.nextAttemptAtMs = undefined;
    this.suspendedReason = undefined;
  }
}
