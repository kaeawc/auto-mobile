import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import type { BindingJournal } from "./bindingJournal";

export const BINDING_JOURNAL_STOP_BUDGET_MS = 100;

/** How often the daemon's owner loop re-runs a redrive pass. */
export const BINDING_JOURNAL_REDRIVE_INTERVAL_MS = 5_000;

/**
 * The durable local owner of journal redrive: one pass at start (daemon startup), then one every
 * interval. Each pass drives every due entry once, so no entry starves and none is abandoned.
 */
export class BindingJournalRedriveLoop {
  private stopped = false;
  private running: Promise<void> | undefined;
  private stopping: Promise<"stopped" | "timed_out"> | undefined;
  private readonly controller = new AbortController();
  private cancelWait: (() => void) | undefined;

  constructor(
    private readonly journal: Pick<BindingJournal, "runPass">,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    private readonly intervalMs: number = BINDING_JOURNAL_REDRIVE_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.stopped) {
      this.running ??= this.loop();
    }
  }

  /** Prevent new work, interrupt waits, and join owned work within the shutdown budget. */
  stop(budgetMs: number = BINDING_JOURNAL_STOP_BUDGET_MS): Promise<"stopped" | "timed_out"> {
    this.stopped = true;
    this.controller.abort();
    this.cancelWait?.();
    this.stopping ??= this.join(budgetMs);
    return this.stopping;
  }

  private async join(budgetMs: number): Promise<"stopped" | "timed_out"> {
    try {
      await raceWithDeadline(this.running ?? Promise.resolve(), {
        timer: this.timer,
        timeoutMs: budgetMs,
        label: "journal redrive stop",
      });
      return "stopped";
    } catch (error) {
      logger.warn(`[BindingJournal] redrive stop failed: ${errorMessage(error)}`, error);
      return "timed_out";
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.timer.setTimeout(() => {
        this.cancelWait = undefined;
        resolve();
      }, this.intervalMs);
      this.cancelWait = () => {
        this.timer.clearTimeout(handle);
        this.cancelWait = undefined;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.journal.runPass({ signal: this.controller.signal });
      } catch (error) {
        // The registry may be briefly unreadable; the next pass retries every open entry.
        logger.warn(`[BindingJournal] redrive pass failed: ${errorMessage(error)}`, error);
      }
      if (this.stopped) {
        return;
      }
      await this.wait();
    }
  }
}
