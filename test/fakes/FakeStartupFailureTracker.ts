import {
  STARTUP_FAILURE_WINDOW_MS,
  type StartupFailureTracker,
} from "../../src/daemon/DaemonStartupFailureTracker";
import type { DatabaseFailureKind } from "../../src/db/databaseFailureClassification";

/**
 * In-memory fake of the cross-process startup failure tracker.
 *
 * `recordFailure` returns a caller-controlled count when one is queued, otherwise the
 * number of failures inside the rolling window (reset() clears it), matching
 * DefaultStartupFailureTracker so the circuit-breaker path can be driven without a file.
 */
export class FakeStartupFailureTracker implements StartupFailureTracker {
  readonly recorded: Array<{ kind: DatabaseFailureKind; now: number }> = [];
  resetCalls = 0;
  private counts: number[] = [];
  private windowTimes: number[] = [];

  /** Queue the counts `recordFailure` will return, in order. */
  setCounts(counts: number[]): void {
    this.counts = [...counts];
  }

  recordFailure(kind: DatabaseFailureKind, now: number): number {
    this.recorded.push({ kind, now });
    this.windowTimes = this.windowTimes.filter((at) => now - at <= STARTUP_FAILURE_WINDOW_MS);
    this.windowTimes.push(now);
    const queued = this.counts.shift();
    return queued ?? this.windowTimes.length;
  }

  reset(): void {
    this.resetCalls += 1;
    this.windowTimes = [];
  }
}
