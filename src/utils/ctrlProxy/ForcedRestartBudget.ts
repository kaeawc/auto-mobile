import { exponentialBackoff, type BackoffPolicy } from "../Backoff";
import { defaultTimer, type Timer } from "../SystemTimer";

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

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly maxAttempts = 3,
    private readonly backoff: BackoffPolicy = exponentialBackoff({
      initialDelayMs: 30_000,
      multiplier: 2,
      maxDelayMs: 300_000,
    }),
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("Forced restart maxAttempts must be a positive integer");
    }
  }

  snapshot(): ForcedRestartSnapshot {
    if (this.suspendedReason !== undefined) {
      return {
        state: "suspended",
        attempts: this.attempts,
        lastFailureReason: this.suspendedReason,
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
    return ++this.generation;
  }

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

  recordSuccess(token?: number): boolean {
    if (token !== undefined && (!this.inFlight || token !== this.generation)) {
      return false;
    }
    this.rearm("restart succeeded");
    return true;
  }

  suspend(reason: string): void {
    this.generation++;
    this.inFlight = false;
    this.suspendedReason = reason;
    this.nextAttemptAtMs = undefined;
  }

  rearm(_reason: string): void {
    this.generation++;
    this.inFlight = false;
    this.attempts = 0;
    this.lastFailureReason = undefined;
    this.nextAttemptAtMs = undefined;
    this.suspendedReason = undefined;
  }
}
