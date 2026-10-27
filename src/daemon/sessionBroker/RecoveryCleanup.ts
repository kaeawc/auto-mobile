import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

export interface RecoveryCleanupItem {
  resourceId: string;
  run: (signal: AbortSignal) => Promise<void>;
}

/** Bounds actual native concurrency, including work whose pass has stopped waiting for it. */
export class RecoveryCleanup {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly stopping = new AbortController();

  constructor(
    private readonly concurrency = 4,
    private readonly waitMs = 5_000,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new ActionableError("Recovery cleanup concurrency must be a positive integer");
    }
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw new ActionableError("Recovery cleanup wait must be positive and finite");
    }
  }

  async run(items: readonly RecoveryCleanupItem[]): Promise<void> {
    const waiting = new Set<Promise<void>>();
    let next = 0;
    while (!this.stopping.signal.aborted) {
      while (next < items.length && this.inFlight.size < this.concurrency) {
        const item = items[next++]!;
        if (!this.inFlight.has(item.resourceId)) {
          const wait = this.start(item).then(() => {
            waiting.delete(wait);
          });
          waiting.add(wait);
        }
      }
      if (waiting.size === 0) {
        const deferred = items.slice(next).filter((item) => !this.inFlight.has(item.resourceId));
        if (deferred.length > 0 && this.inFlight.size >= this.concurrency) {
          logger.warn(`recovery cleanup slots saturated, ${deferred.length} items deferred`);
        }
        return;
      }
      await raceWithDeadline([...waiting], { timer: this.timer, label: "Recovery cleanup slot" });
    }
  }

  stop(): void {
    this.stopping.abort(new ActionableError("Session broker cleanup is stopping"));
  }

  async join(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private async start(item: RecoveryCleanupItem): Promise<void> {
    const signal = this.stopping.signal;
    const pending = Promise.resolve()
      .then(async () => {
        signal.throwIfAborted();
        await item.run(signal);
      })
      .catch((error: unknown) => {
        // The durable request/resource remains discoverable; one failure cannot starve its peers.
        logger.warn(
          `Session resource ${item.resourceId} recovery cleanup remains pending: ${errorMessage(error)}`,
          error,
        );
      })
      .finally(() => {
        this.inFlight.delete(item.resourceId);
      });
    this.inFlight.set(item.resourceId, pending);
    const timeout = new ActionableError("Recovery cleanup pass wait elapsed");
    try {
      // A deadline bounds only this pass's WAIT, never frees an occupied native slot. Later
      // passes skip the resource until the original work settles, including late failures.
      await raceWithDeadline(pending, {
        timer: this.timer,
        timeoutMs: this.waitMs,
        signal,
        label: `Session resource ${item.resourceId} recovery cleanup`,
        timeoutError: () => timeout,
      });
    } catch (error) {
      if (error === timeout) {
        // Native work keeps its slot; a later pass re-checks expected multi-second resets.
        logger.debug(
          `Session resource ${item.resourceId} cleanup wait ended: ${errorMessage(error)}`,
          error,
        );
        return;
      }
      // Shutdown cancels the wait; close separately aborts/joins the underlying owned work.
      logger.warn(
        `Session resource ${item.resourceId} cleanup wait ended: ${errorMessage(error)}`,
        error,
      );
    }
  }
}
