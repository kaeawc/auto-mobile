import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { toActionableError } from "../../models/ActionableError";

export class ResetBootQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(
    private readonly limit = Number.POSITIVE_INFINITY,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
    private readonly now: () => number = () => defaultTimer.now(),
  ) {}

  /** `onAdmitted` receives the milliseconds this call waited for a slot (0 when none was queued). */
  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    onAdmitted?: (waitMs: number) => void,
  ): Promise<T> {
    signal?.throwIfAborted();
    const queuedAt = this.now();
    if (this.active >= this.limit) {
      const admitted = Promise.withResolvers<void>();
      const start = () => {
        this.active += 1;
        admitted.resolve();
      };
      this.pending.push(start);
      try {
        await raceWithDeadline(() => admitted.promise, {
          timer: this.timer,
          signal,
          label: "Reset boot cleanup queue",
        });
      } catch (error) {
        const index = this.pending.indexOf(start);
        if (index >= 0) {
          this.pending.splice(index, 1);
        } else {
          this.release();
        }
        throw toActionableError(error, "Reset boot cleanup queue was cancelled");
      }
    } else {
      this.active += 1;
    }
    try {
      signal?.throwIfAborted();
      onAdmitted?.(this.now() - queuedAt);
      return await operation();
    } finally {
      this.release();
    }
  }

  private release(): void {
    this.active -= 1;
    this.pending.shift()?.();
  }
}
