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

  /** Begin the first connection cycle. Resolves once the first attempt settles. */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("ReconnectController already stopped.");
    }
    await this.runCycle(false);
  }

  /**
   * Report that the live connection was lost. Starts a reconnect cycle unless
   * one is already in progress or the controller has been stopped.
   */
  notifyConnectionLost(): void {
    if (this.stopped || this.cycleActive || this.state === "reconnecting" || this.state === "connecting") {
      return;
    }
    void this.runCycle(true);
  }

  /** Permanently stop; cancels any pending retry. */
  stop(): void {
    this.stopped = true;
    this.clearPending();
    this.setState("stopped");
  }

  private async runCycle(isReconnect: boolean): Promise<void> {
    if (this.stopped || this.cycleActive) {
      return;
    }
    this.cycleActive = true;
    this.attemptsThisCycle = 0;
    this.setState(isReconnect ? "reconnecting" : "connecting");

    // The first attempt of a fresh `start()` cycle should be awaited by the
    // caller; subsequent retries proceed asynchronously via the timer.
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
      this.setState("connected");
    } catch (error) {
      logger.warn(
        `[WebRTC] connection attempt ${this.attemptsThisCycle} failed: ${error instanceof Error ? error.message : String(error)}`
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
