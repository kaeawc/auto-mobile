/** Measures how much later than its cadence a periodic tick fired. */
export class TickLatenessClock {
  private lastTickAt: number | undefined;

  constructor(private readonly intervalMs: number) {}

  /** Record a tick starting at `now`; returns how late it was (0 for the first tick). */
  note(now: number): number {
    const lateness =
      this.lastTickAt === undefined ? 0 : Math.max(0, now - this.lastTickAt - this.intervalMs);
    this.lastTickAt = now;
    return lateness;
  }

  /** Forget the previous tick, e.g. when the keeper stops and a later start is not "late". */
  reset(): void {
    this.lastTickAt = undefined;
  }
}
