import { type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { RetryExecutor } from "../../../utils/retry/RetryExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import type { RegistryRetryPacing } from "../registry/registryRetryPacing";

/** What {@link RegistryStepRetrier} reads from the drain that owns it. */
export interface RegistryStepRetrierContext {
  timer: Timer;
  registryRetry: RetryExecutor;
  recoveryPacing: RegistryRetryPacing;
  backoff: BackoffPolicy;
  /** Aborted when the drain closes: ends a retry's wait and stops it before its next call. */
  closing: AbortSignal;
  isClosed(): boolean;
  /** Warns, unless the drain has closed. */
  warn(message: string, error?: unknown): void;
  settlementCapMs: number;
  settlementSlowPollMs: number;
  /** Per-turn deadline of a startup recovery read. */
  recoveryTurnBudgetMs: number;
  /** A recovery still failing after this long is warned about once. */
  recoveryWarnAfterMs: number;
}

/** The retry policy for the registry steps of the managed-execution drain (#11616). */
export class RegistryStepRetrier {
  constructor(private readonly ctx: RegistryStepRetrierContext) {}

  /**
   * Run one registry step of the drain, retrying while it throws (#11616). Retries follow the
   * injected backoff until `deadline` (the settlement cap) and the slow re-check cadence after
   * it, so a busy registry is never hammered and the step still lands whenever the registry
   * recovers. It stops, without a further registry call, when this daemon closes or when
   * `stopWhen` says the step is no longer needed; `done: false` then tells the caller the step
   * did NOT happen, so it must not go on as if it had.
   */
  async run<T>(
    what: string,
    deadline: number,
    step: () => Promise<T>,
    stopWhen?: () => boolean,
    schedule?: { fastRecovery: true },
  ): Promise<{ done: true; value: T } | { done: false }> {
    if (schedule?.fastRecovery) {
      return this.runRecovery(what, step);
    }
    const { timer } = this.ctx;
    let warnedPastCap = false;
    const result = await this.ctx.registryRetry.execute(step, {
      maxAttempts: Number.MAX_SAFE_INTEGER,
      signal: this.ctx.closing,
      shouldRetry: () => !(stopWhen?.() ?? false),
      delays: (attempt) =>
        timer.now() >= deadline
          ? this.ctx.settlementSlowPollMs
          : this.ctx.backoff.delayForAttempt(attempt),
      onRetry: (error, attempt, delayMs) => {
        if (attempt === 1) {
          this.ctx.warn(
            `[BrokerExecutionRelease] ${what} failed; retrying in ${delayMs}ms: ${error.message}`,
            error,
          );
        }
        if (timer.now() >= deadline && !warnedPastCap) {
          warnedPastCap = true;
          this.ctx.warn(
            `[BrokerExecutionRelease] ${what} has kept failing past the ` +
              `${this.ctx.settlementCapMs}ms settlement cap; it is retried every ` +
              `${this.ctx.settlementSlowPollMs}ms until the registry recovers. ` +
              "a daemon restart (its settled-binding recovery) also recovers the binding: " +
              error.message,
            error,
          );
        }
      },
      expectedFailure: { reason: "the drain reports why it stopped retrying a registry step" },
    });
    if (result.success) {
      return { done: true, value: result.value as T };
    }
    if (!this.ctx.isClosed()) {
      this.ctx.warn(
        `[BrokerExecutionRelease] ${what} failed and is no longer needed, so it is not ` +
          `retried: ${errorMessage(result.error)}`,
        result.error,
      );
    }
    return { done: false };
  }

  /** Startup recovery bounds each shared turn, retaining late reads; drain defaults stay unchanged. */
  private async runRecovery<T>(
    what: string,
    step: () => Promise<T>,
  ): Promise<{ done: true; value: T } | { done: false }> {
    const sinceMs = this.ctx.timer.now();
    let attempts = 0;
    let warned = false;
    let pending: Promise<T> | undefined;
    while (!this.ctx.isClosed()) {
      attempts++;
      try {
        const value = await this.ctx.recoveryPacing.run(
          async () => {
            let timedOut = false;
            try {
              return await raceWithDeadline(
                () => {
                  pending ??= step();
                  return pending;
                },
                {
                  timer: this.ctx.timer,
                  timeoutMs: this.ctx.recoveryTurnBudgetMs,
                  signal: this.ctx.closing,
                  label: what,
                  onTimeout: () => {
                    timedOut = true;
                  },
                },
              );
            } finally {
              // A timed-out read may already have landed; consume it on the next shared turn.
              if (!timedOut) {
                pending = undefined;
              }
            }
          },
          () => true,
        );
        if (this.ctx.isClosed()) {
          return { done: false };
        }
        if (attempts > 1) {
          logger.info(
            `[BrokerExecutionRelease] ${what} resolved after ${this.ctx.timer.now() - sinceMs} ms (${attempts} attempts)`,
          );
        }
        return { done: true, value };
      } catch (error) {
        // Contention leaves recovery owed; shutdown safely leaves it to the next daemon.
        if (this.ctx.isClosed()) {
          return { done: false };
        }
        logger.debug(`[BrokerExecutionRelease] ${what} failed: ${errorMessage(error)}`, error);
        if (!warned && this.ctx.timer.now() - sinceMs > this.ctx.recoveryWarnAfterMs) {
          warned = true;
          this.ctx.warn(
            `[BrokerExecutionRelease] ${what} still failing after ${this.ctx.timer.now() - sinceMs} ms (${attempts} attempts): ${errorMessage(error)}`,
            error,
          );
        }
      }
      try {
        await this.ctx.recoveryPacing.wait(this.ctx.recoveryPacing.delay(attempts));
      } catch (error) {
        // Closing cancels the wait; the next daemon owns startup recovery.
        if (!this.ctx.isClosed()) {
          logger.debug(
            `[BrokerExecutionRelease] Recovery retry wait cancelled: ${errorMessage(error)}`,
            error,
          );
        }
        return { done: false };
      }
    }
    return { done: false };
  }
}
