import { exponentialBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

export interface ManagedConnectionRebindAttempts {
  attempt(): Promise<void>;
  stillWanted(): boolean;
}

export interface ManagedConnectionRebind {
  /** Schedule retries after the caller's awaited first attempt failed. */
  start(attempts: ManagedConnectionRebindAttempts, failure: unknown): void;
  cancel(): void;
}

const backoff = exponentialBackoff({ initialDelayMs: 250, maxDelayMs: 5_000 });

interface RetryChain {
  attempts: ManagedConnectionRebindAttempts;
  nextAttempt: number;
  handle?: NodeJS.Timeout;
}

/** One cancellable chain per connection, with all waits supplied by the caller's timer. */
export class TimerManagedConnectionRebind implements ManagedConnectionRebind {
  private chain: RetryChain | undefined;

  constructor(private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">) {}

  start(attempts: ManagedConnectionRebindAttempts, failure: unknown): void {
    if (this.chain) {
      return;
    }
    const chain: RetryChain = { attempts, nextAttempt: 1 };
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
    const retryable = Reflect.get(fields, "retryable");
    if (
      retryable === false ||
      (typeof Reflect.get(fields, "code") === "string" && retryable !== true)
    ) {
      logger.warn(
        `[ManagedSlots] Managed re-bind refused permanently; socket stays confined: ${errorMessage(failure)}`,
      );
      this.cancel();
      return;
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
      if (this.chain === chain) {
        this.cancel();
      }
    } catch (error) {
      // Re-binding is best effort; the socket remains fail-closed while a transient refusal clears.
      logger.debug(`[ManagedSlots] Connection re-bind retry failed: ${errorMessage(error)}`);
      this.schedule(chain, error);
    }
  }
}
