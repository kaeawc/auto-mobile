import type { DbWriteBarrier } from "../../src/db/dbWriteBarrier";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "./FakeTimer";

/**
 * Deterministic in-memory fake of {@link DbWriteBarrier} for unit tests.
 *
 * Mirrors {@link InMemoryDbWriteBarrier}'s observable behaviour (pinned by
 * `test/contracts/DbWriteBarrierContract.ts`): it counts in-flight writes, makes
 * `drain` wait for them bounded by an injected {@link Timer}, and short-circuits
 * tracked work while draining. On top of that it records enough to assert both
 * halves of the shutdown-drain contract: `trackCalls`/`ranCount` count attempts
 * vs. writes that actually ran, and `ran` marks each executed write.
 * `trackExistingCalls`/`trackedExisting` mirror that for {@link trackExisting}
 * (issue #2885).
 */
export class FakeDbWriteBarrier implements DbWriteBarrier {
  draining = false;
  trackCalls = 0;
  ranCount = 0;
  ran: string[] = [];
  trackExistingCalls = 0;
  trackedExisting: string[] = [];

  #inFlight = 0;
  #idleWaiters: Array<() => void> = [];

  constructor(private readonly timer: Timer = new FakeTimer()) {}

  isDraining(): boolean {
    return this.draining;
  }

  inFlightCount(): number {
    return this.#inFlight;
  }

  beginDrain(): void {
    this.draining = true;
  }

  async drain(timeoutMs: number = 0): Promise<boolean> {
    this.draining = true;
    if (this.#inFlight === 0) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const handle = this.timer.setTimeout(() => {
        this.#idleWaiters = this.#idleWaiters.filter((waiter) => waiter !== onIdle);
        resolve(false);
      }, timeoutMs);
      const onIdle = (): void => {
        this.timer.clearTimeout(handle);
        resolve(true);
      };
      this.#idleWaiters.push(onIdle);
    });
  }

  async track<T>(work: () => Promise<T>): Promise<T | undefined> {
    this.trackCalls += 1;
    if (this.draining) {
      return undefined;
    }
    this.ranCount += 1;
    this.ran.push("ran");
    this.#inFlight += 1;
    try {
      return await work();
    } finally {
      this.#leave();
    }
  }

  trackExisting<T>(work: Promise<T>): Promise<T | undefined> {
    this.trackExistingCalls += 1;
    const normalized = Promise.resolve(work);
    if (this.draining) {
      // Not counted while draining (issue #2885); never rejects, safe to `void`.
      return normalized.then(
        () => undefined,
        () => undefined,
      );
    }
    this.trackedExisting.push("tracked");
    this.#inFlight += 1;
    return normalized.then(
      (value) => {
        this.#leave();
        return value as T | undefined;
      },
      () => {
        this.#leave();
        return undefined;
      },
    );
  }

  #leave(): void {
    this.#inFlight -= 1;
    if (this.#inFlight === 0) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }
  }
}
