import { exponentialBackoff, type BackoffPolicy } from "./Backoff";
import { raceWithDeadline } from "./raceWithDeadline";
import type { Timer } from "./SystemTimer";

interface TransitionalWaitBudgetPorts {
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  getSignal: () => AbortSignal | undefined;
  backoff?: BackoffPolicy;
  budgetMs?: number;
}

/** One observation's elapsed budget, shared by its probes and cancellable backoff delays. */
export class TransitionalWaitBudget {
  private firstObservationMs: number | undefined;
  private attempt = 0;
  private readonly backoff: BackoffPolicy;
  private readonly budgetMs: number;

  constructor(private readonly ports: TransitionalWaitBudgetPorts) {
    this.backoff = ports.backoff ?? exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 1_000 });
    this.budgetMs = ports.budgetMs ?? 5_000;
  }

  remainingMs(): number {
    this.firstObservationMs ??= this.ports.timer.now();
    return Math.max(0, this.budgetMs - (this.ports.timer.now() - this.firstObservationMs));
  }

  async waitForNextAttempt(): Promise<boolean> {
    const { timer, getSignal } = this.ports;
    const signal = getSignal();
    signal?.throwIfAborted();
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      return false;
    }
    const delayMs = Math.min(this.backoff.delayForAttempt(++this.attempt), remaining);
    if (delayMs <= 0) {
      return false;
    }
    let handle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            handle = timer.setTimeout(resolve, delayMs);
          }),
        { timer, signal, label: "Exact device adb transport wait" },
      );
    } finally {
      if (handle !== undefined) {
        timer.clearTimeout(handle);
      }
    }
    signal?.throwIfAborted();
    return true;
  }
}
