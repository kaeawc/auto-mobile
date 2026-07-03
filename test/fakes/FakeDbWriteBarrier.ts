import type { DbWriteBarrier } from "../../src/db/dbWriteBarrier";

/**
 * Deterministic in-memory fake of {@link DbWriteBarrier} for unit tests.
 *
 * Records enough to assert both halves of the shutdown-drain contract without a
 * real timer or DB: `trackCalls`/`ranCount` count attempts vs. writes that
 * actually ran, and `ran` marks each executed write. While `draining`, tracked
 * work short-circuits (resolves `undefined`) exactly like
 * {@link InMemoryDbWriteBarrier}, but with no in-flight/idle bookkeeping.
 */
export class FakeDbWriteBarrier implements DbWriteBarrier {
  draining = false;
  trackCalls = 0;
  ranCount = 0;
  ran: string[] = [];

  isDraining(): boolean {
    return this.draining;
  }

  inFlightCount(): number {
    return 0;
  }

  beginDrain(): void {
    this.draining = true;
  }

  async drain(): Promise<boolean> {
    this.draining = true;
    return true;
  }

  async track<T>(work: () => Promise<T>): Promise<T | undefined> {
    this.trackCalls += 1;
    if (this.draining) {
      return undefined;
    }
    this.ranCount += 1;
    this.ran.push("ran");
    return work();
  }
}
