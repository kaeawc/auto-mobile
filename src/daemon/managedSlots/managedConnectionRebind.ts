import { DaemonShuttingDownError } from "../client";
import { DAEMON_SHUTTING_DOWN_ERROR_CODE } from "../constants";
import { exponentialBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

export interface ManagedConnectionRebindAttempts {
  attempt(): Promise<void>;
  stillWanted(): boolean;
  describe?(): string;
}

export interface ManagedConnectionRebind {
  /** Schedule retries after the caller's awaited first attempt failed. */
  start(attempts: ManagedConnectionRebindAttempts, failure: unknown): void;
  cancel(): void;
}

const backoff = exponentialBackoff({ initialDelayMs: 50, maxDelayMs: 1_000 });

export const MANAGED_CONNECTION_REBIND_WARN_AFTER_MS = 60_000;

interface RetryChain {
  attempts: ManagedConnectionRebindAttempts;
  nextAttempt: number;
  sinceMs: number;
  warned: boolean;
  handle?: NodeJS.Timeout;
}

/** One cancellable chain per connection, with all waits supplied by the caller's timer. */
export class TimerManagedConnectionRebind implements ManagedConnectionRebind {
  private chain: RetryChain | undefined;

  constructor(private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">) {}

  start(attempts: ManagedConnectionRebindAttempts, failure: unknown): void {
    if (this.chain?.attempts === attempts && attempts.stillWanted()) {
      return;
    }
    this.cancel();
    const chain: RetryChain = {
      attempts,
      nextAttempt: 1,
      sinceMs: this.timer.now(),
      warned: false,
    };
    this.chain = chain;
    this.schedule(chain, failure);
  }

  cancel(): void {
    if (this.chain?.handle !== undefined) {
      this.timer.clearTimeout(this.chain.handle);
    }
    this.chain = undefined;
  }

  private schedule(chain: RetryChain, failure: unknown): void {
    if (this.chain !== chain) {
      return;
    }
    const fields = failure !== null && typeof failure === "object" ? failure : {};
    if (!chain.attempts.stillWanted()) {
      this.cancel();
      return;
    }
    if (this.refusalStopsRetries(failure)) {
      this.cancel();
      return;
    }
    const elapsedMs = this.timer.now() - chain.sinceMs;
    if (!chain.warned && elapsedMs > MANAGED_CONNECTION_REBIND_WARN_AFTER_MS) {
      chain.warned = true;
      logger.warn(
        `[ManagedSlots] Managed re-bind still pending for ${chain.attempts.describe?.() ?? "managed connection"} after ${elapsedMs} ms (${chain.nextAttempt} attempts): ${errorMessage(failure)}`,
      );
    }
    const retryAfterMs = Reflect.get(fields, "retryAfterMs");
    const minimum =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
        ? Math.max(0, retryAfterMs)
        : 0;
    const wait = Math.max(backoff.delayForAttempt(chain.nextAttempt++), minimum);
    chain.handle = this.timer.setTimeout(() => {
      chain.handle = undefined;
      void this.retry(chain);
    }, wait);
  }

  private refusalStopsRetries(failure: unknown): boolean {
    const fields = failure !== null && typeof failure === "object" ? failure : {};
    if (
      failure instanceof DaemonShuttingDownError ||
      Reflect.get(fields, "code") === DAEMON_SHUTTING_DOWN_ERROR_CODE
    ) {
      // The socket is going away; the next connection re-binds its held sessions.
      logger.debug(
        `[ManagedSlots] Connection re-bind stopped for daemon shutdown: ${errorMessage(failure)}`,
      );
      return true;
    }
    const retryable = Reflect.get(fields, "retryable");
    if (
      retryable === false ||
      (typeof Reflect.get(fields, "code") === "string" && retryable !== true)
    ) {
      logger.warn(
        `[ManagedSlots] Managed re-bind refused permanently; socket stays confined: ${errorMessage(failure)}`,
      );
      return true;
    }
    return false;
  }

  private async retry(chain: RetryChain): Promise<void> {
    if (this.chain !== chain) {
      return;
    }
    if (!chain.attempts.stillWanted()) {
      this.cancel();
      return;
    }
    try {
      await chain.attempts.attempt();
      if (this.chain === chain && chain.attempts.stillWanted()) {
        logger.info(
          `[ManagedSlots] Managed re-bind bound ${chain.attempts.describe?.() ?? "managed connection"} after ${this.timer.now() - chain.sinceMs} ms (${chain.nextAttempt} attempts)`,
        );
        this.cancel();
      } else if (this.chain === chain) {
        this.cancel();
      }
    } catch (error) {
      // A cancelled or replaced socket cannot use or report its late result. Silence after
      // cancel is deliberate, pinned by "cancelling an in-flight attempt prevents its failure from scheduling again".
      if (this.chain !== chain || !chain.attempts.stillWanted()) {
        if (this.chain === chain) {
          // The socket no longer wants this best-effort bind; it stays fail-closed.
          logger.debug(
            `[ManagedSlots] Connection re-bind no longer wanted: ${errorMessage(error)}`,
          );
          this.cancel();
        }
        return;
      }
      // Re-binding is best effort; the socket remains fail-closed while a transient refusal clears.
      logger.debug(`[ManagedSlots] Connection re-bind retry failed: ${errorMessage(error)}`);
      this.schedule(chain, error);
    }
  }
}
