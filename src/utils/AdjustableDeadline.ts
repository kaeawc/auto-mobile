import type { Timer } from "./SystemTimer";

type DeadlineClock = Pick<Timer, "now">;
type ExpiryTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

/**
 * An absolute deadline that its owner may move while waiters are already racing it.
 *
 * Waiters (see `raceWithDeadline`) re-arm their timers on every change, so a moved deadline
 * applies to operations that are already running; this is how a start flight splits a queue phase
 * from a launch phase (#15227) without restarting the work that holds the flight.
 */
export class AdjustableDeadline {
  private current: number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly clock: DeadlineClock,
    deadlineMs: number,
  ) {
    this.current = deadlineMs;
  }

  get deadlineMs(): number {
    return this.current;
  }

  remainingMs(): number {
    return Math.max(0, this.current - this.clock.now());
  }

  /** Move the deadline (earlier or later) and re-arm every waiter. */
  set(deadlineMs: number): void {
    if (deadlineMs === this.current) {
      return;
    }
    this.current = deadlineMs;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** Subscribe to deadline moves; returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Call `onExpired` once the deadline passes, following any move of the deadline. Returns the
   * cancel function, which is safe to call after expiry. `onArmed` sees each timer handle.
   */
  whenExpired(
    timer: ExpiryTimer,
    onExpired: () => void,
    onArmed?: (handle: NodeJS.Timeout) => void,
  ): () => void {
    let handle: NodeJS.Timeout | undefined;
    let done = false;
    const clear = (): void => {
      if (handle !== undefined) {
        timer.clearTimeout(handle);
        handle = undefined;
      }
    };
    const arm = (): void => {
      if (done) {
        return;
      }
      clear();
      handle = timer.setTimeout(() => {
        handle = undefined;
        // The deadline may have moved later since this timer was armed.
        if (this.remainingMs() > 0) {
          arm();
          return;
        }
        done = true;
        stopWatching();
        onExpired();
      }, this.remainingMs());
      onArmed?.(handle);
    };
    const stopWatching = this.onChange(arm);
    arm();
    return () => {
      done = true;
      stopWatching();
      clear();
    };
  }
}
