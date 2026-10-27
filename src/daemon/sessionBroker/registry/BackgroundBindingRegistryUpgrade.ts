import { exponentialBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";

/** Post-listener upgrade retries, cancelled and joined by the registry shutdown stage. */
export class BackgroundBindingRegistryUpgrade {
  private readonly controller = new AbortController();
  private readonly backoff: BackoffPolicy;
  private task: Promise<boolean> | undefined;
  private retryWait: { handle: NodeJS.Timeout; resolve: () => void } | undefined;

  constructor(
    private readonly open: (signal: AbortSignal) => Promise<unknown>,
    private readonly options: { timer: Timer; backoff?: BackoffPolicy },
  ) {
    this.backoff =
      options.backoff ??
      exponentialBackoff({
        initialDelayMs: 5_000,
        maxDelayMs: 300_000,
      });
  }

  start(): void {
    if (this.controller.signal.aborted) {
      return;
    }
    this.task ??= this.run().catch((error: unknown) => {
      logger.warn(`[Daemon] Binding registry upgrade stopped: ${errorMessage(error)}`, error);
      return false;
    });
  }

  private async run(): Promise<boolean> {
    for (let attempt = 1; !this.controller.signal.aborted; attempt++) {
      const delayMs = this.backoff.delayForAttempt(attempt);
      if (await this.tryOpen(attempt, delayMs)) {
        return true;
      }
      if (!this.controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const handle = this.options.timer.setTimeout(() => {
            this.retryWait = undefined;
            resolve();
          }, delayMs);
          this.retryWait = { handle, resolve };
        });
      }
    }
    return false;
  }

  private async tryOpen(attempt: number, delayMs: number): Promise<boolean> {
    try {
      await this.open(this.controller.signal);
      return true;
    } catch (error) {
      if (!this.controller.signal.aborted) {
        logger.warn(
          `[Daemon] Binding registry upgrade deferred: ${errorMessage(error)} (attempt ${attempt}; retry delay ${delayMs}ms)`,
          error,
        );
      }
      return false;
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    if (this.retryWait) {
      this.options.timer.clearTimeout(this.retryWait.handle);
      this.retryWait.resolve();
      this.retryWait = undefined;
    }
    await this.task;
  }
}
