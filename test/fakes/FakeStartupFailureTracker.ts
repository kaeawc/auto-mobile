import type { StartupFailureTracker } from "../../src/daemon/DaemonStartupFailureTracker";
import type { DatabaseFailureKind } from "../../src/db/databaseFailureClassification";

/**
 * In-memory fake of the cross-process startup failure tracker.
 *
 * `recordFailure` returns a caller-controlled count so tests can drive the
 * circuit-breaker/backoff path deterministically without a real file.
 */
export class FakeStartupFailureTracker implements StartupFailureTracker {
  readonly recorded: Array<{ kind: DatabaseFailureKind; now: number }> = [];
  resetCalls = 0;
  private counts: number[] = [];

  /** Queue the counts `recordFailure` will return, in order. */
  setCounts(counts: number[]): void {
    this.counts = [...counts];
  }

  recordFailure(kind: DatabaseFailureKind, now: number): number {
    this.recorded.push({ kind, now });
    return this.counts.length > 0 ? this.counts.shift()! : this.recorded.length;
  }

  reset(): void {
    this.resetCalls += 1;
  }
}
