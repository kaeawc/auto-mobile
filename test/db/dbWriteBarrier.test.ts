import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

/** A promise plus its resolver, so tests can settle tracked writes deterministically. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InMemoryDbWriteBarrier", () => {
  let timer: FakeTimer;
  let barrier: InMemoryDbWriteBarrier;

  beforeEach(() => {
    timer = new FakeTimer();
    barrier = new InMemoryDbWriteBarrier(timer);
  });

  it("runs tracked work and returns its value when not draining", async () => {
    const result = await barrier.track(async () => 42);
    expect(result).toBe(42);
    expect(barrier.inFlightCount()).toBe(0);
  });

  it("counts outstanding tracked writes (A3)", async () => {
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    const p1 = barrier.track(() => d1.promise);
    const p2 = barrier.track(() => d2.promise);
    expect(barrier.inFlightCount()).toBe(2);
    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
    expect(barrier.inFlightCount()).toBe(0);
  });

  it("drain awaits the tracked set and resolves true when all settle (A1)", async () => {
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    const w1 = barrier.track(() => d1.promise);
    const w2 = barrier.track(() => d2.promise);
    expect(barrier.inFlightCount()).toBe(2);

    const drainPromise = barrier.drain(1000);
    // A pending timeout is armed for the bound.
    expect(timer.getPendingTimeoutCount()).toBe(1);

    d1.resolve();
    d2.resolve();
    await Promise.all([w1, w2]);

    expect(await drainPromise).toBe(true);
    // The bound timer is cleared once the drain resolves.
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  it("drain resolves true immediately when nothing is in flight", async () => {
    expect(await barrier.drain(1000)).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  it("wedged write does not block shutdown beyond the bound (A2)", async () => {
    const wedged = deferred<void>();
    // Never resolved — models a #2791 tx that never commits.
    void barrier.track(() => wedged.promise);
    expect(barrier.inFlightCount()).toBe(1);

    const drainPromise = barrier.drain(1000);
    expect(timer.getPendingTimeoutCount()).toBe(1);

    // Advance past the bound: the drain times out instead of hanging.
    timer.advanceTime(1000);
    expect(await drainPromise).toBe(false);
  });

  it("short-circuits tracked writes once draining (A5)", async () => {
    barrier.beginDrain();
    expect(barrier.isDraining()).toBe(true);

    let ran = false;
    const result = await barrier.track(async () => {
      ran = true;
      return 7;
    });
    expect(ran).toBe(false);
    expect(result).toBeUndefined();
    expect(barrier.inFlightCount()).toBe(0);
  });

  it("decrements the counter even when tracked work rejects", async () => {
    const d = deferred<void>();
    const p = barrier.track(() => d.promise);
    expect(barrier.inFlightCount()).toBe(1);
    d.reject(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(barrier.inFlightCount()).toBe(0);
  });
});
