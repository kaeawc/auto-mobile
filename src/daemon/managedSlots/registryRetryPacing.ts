import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

interface RegistryRetryPacingOptions {
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  initialDelayMs: number;
  maxDelayMs: number;
  maxBlockedWaitMs: number;
  backoff?: BackoffPolicy;
}

/** Shared quiet time and FIFO turns, following the back-out cleanup pacing (#12107). */
export class RegistryRetryPacing {
  private readonly closing = new AbortController();
  private readonly backoff: BackoffPolicy;
  private quietUntilMs = 0;
  private turn: Promise<void> = Promise.resolve();

  constructor(private readonly options: RegistryRetryPacingOptions) {
    this.backoff = options.backoff ?? exponentialBackoff(options);
  }

  close(): void {
    this.closing.abort();
  }

  delay(attempt: number): number {
    try {
      const delay = this.backoff.delayForAttempt(attempt);
      if (!Number.isFinite(delay)) {
        throw new Error(`Registry retry backoff delay must be finite, got ${delay}`);
      }
      return Math.min(Math.max(delay, this.options.initialDelayMs), this.options.maxDelayMs);
    } catch (error) {
      // An injected policy must not stop expected contention recovery; use its safe cap.
      if (!this.closing.signal.aborted) {
        logger.debug(
          `[ManagedSlots] Registry retry backoff failed; using the cap: ${errorMessage(error)}`,
          error,
        );
      }
      return this.options.maxDelayMs;
    }
  }

  async wait(delayMs: number, stopped?: AbortSignal): Promise<void> {
    let handle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            handle = this.options.timer.setTimeout(resolve, delayMs);
          }),
        { timer: this.options.timer, signal: this.signal(stopped), label: "Registry retry wait" },
      );
    } finally {
      if (handle !== undefined) {
        this.options.timer.clearTimeout(handle);
      }
    }
  }

  async run<T>(
    operation: () => Promise<T>,
    succeeded: (result: T) => boolean,
    stopped?: AbortSignal,
  ): Promise<T> {
    const previous = this.turn;
    const finished = Promise.withResolvers<void>();
    // A cancelled queued turn must not let its successor overtake an earlier active turn.
    this.turn = previous.then(() => finished.promise);
    let startedMs: number | undefined;
    let failed = true;
    try {
      await raceWithDeadline(previous, {
        timer: this.options.timer,
        signal: this.signal(stopped),
        label: "Registry retry turn",
      });
      await this.waitForQuiet(stopped);
      this.signal(stopped).throwIfAborted();
      startedMs = this.options.timer.now();
      const result = await raceWithDeadline(operation, {
        timer: this.options.timer,
        signal: this.signal(stopped),
        label: "Registry retry operation",
      });
      failed = !succeeded(result);
      return result;
    } finally {
      if (failed && startedMs !== undefined && !this.closing.signal.aborted) {
        const endMs = this.options.timer.now();
        this.quietUntilMs = Math.max(
          this.quietUntilMs,
          endMs + Math.min(Math.max(0, endMs - startedMs), this.options.maxBlockedWaitMs),
        );
      }
      finished.resolve();
    }
  }

  private signal(stopped?: AbortSignal): AbortSignal {
    return stopped ? AbortSignal.any([this.closing.signal, stopped]) : this.closing.signal;
  }

  private async waitForQuiet(stopped?: AbortSignal): Promise<void> {
    while (this.options.timer.now() < this.quietUntilMs) {
      await this.wait(this.quietUntilMs - this.options.timer.now(), stopped);
    }
  }
}
