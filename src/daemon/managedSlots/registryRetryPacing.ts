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

interface SharedRetryState {
  quietUntilMs: number;
  turn: Promise<void>;
}

const retryStates = new WeakMap<RegistryRetryPacingOptions["timer"], SharedRetryState>();

/**
 * Quiet time and FIFO turns are shared by pacers using the same timer object.
 * The back-out cleanup pacer in managedSlotAcquisition.ts is not joined yet.
 */
export class RegistryRetryPacing {
  private readonly closing = new AbortController();
  private readonly backoff: BackoffPolicy;
  private readonly shared: SharedRetryState;

  constructor(private readonly options: RegistryRetryPacingOptions) {
    this.backoff = options.backoff ?? exponentialBackoff(options);
    let shared = retryStates.get(options.timer);
    if (!shared) {
      shared = { quietUntilMs: 0, turn: Promise.resolve() };
      retryStates.set(options.timer, shared);
    }
    this.shared = shared;
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

  /** An expedited signal wakes this wait successfully; stop/close still cancel it. */
  async wait(delayMs: number, stopped?: AbortSignal, expedited?: AbortSignal): Promise<void> {
    let handle: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            wake = resolve;
            expedited?.addEventListener("abort", wake, { once: true });
            if (expedited?.aborted) {
              resolve();
            } else {
              handle = this.options.timer.setTimeout(resolve, delayMs);
            }
          }),
        { timer: this.options.timer, signal: this.signal(stopped), label: "Registry retry wait" },
      );
    } finally {
      if (wake) {
        expedited?.removeEventListener("abort", wake);
      }
      if (handle !== undefined) {
        this.options.timer.clearTimeout(handle);
      }
    }
  }

  async run<T>(
    operation: () => Promise<T>,
    succeeded: (result: T) => boolean,
    stopped?: AbortSignal,
    expedited?: AbortSignal,
  ): Promise<T> {
    while (true) {
      // Quiet waiters own no turn, so an expedited waiter can reach the next free turn.
      if (!expedited?.aborted && this.options.timer.now() < this.shared.quietUntilMs) {
        await this.waitForQuiet(stopped, expedited);
      }
      const previous = this.shared.turn;
      const finished = Promise.withResolvers<void>();
      // A cancelled queued turn must not let its successor overtake an earlier active turn.
      this.shared.turn = previous.then(() => finished.promise);
      let startedMs: number | undefined;
      let failed = true;
      try {
        await raceWithDeadline(previous, {
          timer: this.options.timer,
          signal: this.signal(stopped),
          label: "Registry retry turn",
        });
        this.signal(stopped).throwIfAborted();
        // The preceding turn may have extended quiet time while we queued. Yield and rejoin.
        // Future quiet time awaits a timer above; an expedite instead awaits the next turn.
        if (!expedited?.aborted && this.options.timer.now() < this.shared.quietUntilMs) {
          continue;
        }
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
          this.shared.quietUntilMs = Math.max(
            this.shared.quietUntilMs,
            endMs + Math.min(Math.max(0, endMs - startedMs), this.options.maxBlockedWaitMs),
          );
        }
        finished.resolve();
      }
    }
  }

  private signal(stopped?: AbortSignal): AbortSignal {
    return stopped ? AbortSignal.any([this.closing.signal, stopped]) : this.closing.signal;
  }

  private async waitForQuiet(stopped?: AbortSignal, expedited?: AbortSignal): Promise<void> {
    while (!expedited?.aborted && this.options.timer.now() < this.shared.quietUntilMs) {
      await this.wait(this.shared.quietUntilMs - this.options.timer.now(), stopped, expedited);
    }
  }
}
