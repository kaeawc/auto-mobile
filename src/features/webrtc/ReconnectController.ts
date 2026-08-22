import { errorMessage } from "../../utils/describeUnknownError";
import { exponentialBackoff, normalizeBackoff, type BackoffInput, type BackoffPolicy } from "../../utils/Backoff";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

export type ReconnectState = "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "stopped";

export interface ReconnectControllerOptions {
  /** Establish (or re-establish) the connection. Rejects on failure. */
  attempt: () => Promise<void>;
  /** Backoff schedule between attempts. Defaults to exponential 1s→30s. */
  backoff?: BackoffInput;
  /** Max attempts per connection cycle before giving up; 0 = unlimited. */
  maxAttempts?: number;
  timer?: Timer;
  onStateChange?: (state: ReconnectState) => void;
}

/**
 * Drives connect / reconnect with backoff, independent of any particular
 * transport. `start()` runs the first attempt; if a live connection later
 * drops, `notifyConnectionLost()` kicks off a retry cycle. All timing goes
 * through an injectable {@link Timer} so retry behavior is deterministically
 * testable with a FakeTimer.
 */
export class ReconnectController {
  private readonly attempt: () => Promise<void>;
  private readonly backoff: BackoffPolicy;
  private readonly maxAttempts: number;
  private readonly timer: Timer;
  private readonly onStateChange?: (state: ReconnectState) => void;

  private state: ReconnectState = "idle";
  private stopped = false;
  private cycleActive = false;
  private pendingHandle: NodeJS.Timeout | null = null;
  private attemptsThisCycle = 0;
  /** A connection-lost report that arrived mid-cycle, to run once the cycle settles. */
  private pendingReconnect = false;

  constructor(options: ReconnectControllerOptions) {
    this.attempt = options.attempt;
    this.backoff = normalizeBackoff(
      options.backoff ?? exponentialBackoff({ initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30_000 })
    );
    this.maxAttempts = options.maxAttempts ?? 0;
    this.timer = options.timer ?? defaultTimer;
    this.onStateChange = options.onStateChange;
  }

  getState(): ReconnectState {
    return this.state;
  }

  /**
   * Begin the first connection. Unlike a reconnect, the initial attempt is NOT
   * retried in the background: it rejects on failure so the caller can surface a
   * real configuration error (bad token, refused endpoint) instead of silently
   * entering a forever-retry loop and reporting success.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("ReconnectController already stopped.");
    }
    this.cycleActive = true;
    this.attemptsThisCycle = 1;
    this.setState("connecting");
    try {
      await this.attempt();
    } catch (error) {
      this.cycleActive = false;
      // stop() may win while an in-flight initial attempt is unwinding. Preserve
      // its terminal state rather than reporting a cancelled start as failed.
      if (this.stopped) {
        return;
      }
      this.setState("failed");
      throw error;
    }
    this.cycleActive = false;
    if (this.stopped) {
      return;
    }
    this.setState("connected");
    this.drainPendingReconnect();
  }

  /**
   * Report that the live connection (or capture source) was lost. Starts a
   * reconnect cycle; if one is already in progress the request is queued and run
   * when that cycle settles, so a failure that races the connect isn't dropped.
   */
  notifyConnectionLost(): void {
    if (this.stopped) {
      return;
    }
    if (this.cycleActive || this.state === "connecting" || this.state === "reconnecting") {
      this.pendingReconnect = true;
      return;
    }
    void this.runReconnectCycle();
  }

  /** Permanently stop; cancels any pending retry. */
  stop(): void {
    this.stopped = true;
    this.pendingReconnect = false;
    this.clearPending();
    this.setState("stopped");
  }

  private drainPendingReconnect(): void {
    if (this.pendingReconnect && !this.stopped) {
      this.pendingReconnect = false;
      void this.runReconnectCycle();
    }
  }

  private async runReconnectCycle(): Promise<void> {
    if (this.stopped || this.cycleActive) {
      return;
    }
    this.cycleActive = true;
    this.attemptsThisCycle = 0;
    this.setState("reconnecting");
    await this.tryOnce();
  }

  private async tryOnce(): Promise<void> {
    if (this.stopped) {
      this.cycleActive = false;
      return;
    }
    this.attemptsThisCycle++;
    try {
      await this.attempt();
      this.cycleActive = false;
      // stop() may win while a reconnect is establishing. Do not resurrect the
      // terminal state after its transport has already been torn down.
      if (this.stopped) {
        return;
      }
      this.setState("connected");
      this.drainPendingReconnect();
    } catch (error) {
      logger.warn(
        `[WebRTC] reconnect attempt ${this.attemptsThisCycle} failed: ${errorMessage(error)}`
      );
      this.scheduleRetryOrFail();
    }
  }

  private scheduleRetryOrFail(): void {
    if (this.stopped) {
      this.cycleActive = false;
      return;
    }
    if (this.maxAttempts > 0 && this.attemptsThisCycle >= this.maxAttempts) {
      this.cycleActive = false;
      this.setState("failed");
      return;
    }

    const delayMs = this.backoff.delayForAttempt(this.attemptsThisCycle);
    this.setState("reconnecting");
    this.clearPending();
    this.pendingHandle = this.timer.setTimeout(() => {
      this.pendingHandle = null;
      void this.tryOnce();
    }, delayMs);
  }

  private clearPending(): void {
    if (this.pendingHandle) {
      this.timer.clearTimeout(this.pendingHandle);
      this.pendingHandle = null;
    }
  }

  private setState(state: ReconnectState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.onStateChange?.(state);
  }
}
