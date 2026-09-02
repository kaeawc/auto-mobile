import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

/** A promise plus its resolver, so tests can settle tracked writes deterministically. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
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

  describe("trackExisting (issue #2885)", () => {
    it("preserves the navigation handler's original-promise continuation ahead of a concurrent hierarchy path (#3506)", async () => {
      const navWrite = deferred<void>();
      const resolutionOrder: string[] = [];

      const navigationHandler = (async () => {
        // This is the ordering-sensitive CtrlProxy idiom. Its caller must await
        // the original write promise, not the barrier's derived promise.
        void barrier.trackExisting(navWrite.promise);
        expect(barrier.inFlightCount()).toBe(1);
        await navWrite.promise;
        resolutionOrder.push("navigation");
      })();
      const hierarchyPath = navWrite.promise.then(() => {
        resolutionOrder.push("hierarchy");
      });

      navWrite.resolve();
      await Promise.all([navigationHandler, hierarchyPath]);

      expect(resolutionOrder).toEqual(["navigation", "hierarchy"]);
    });

    it("shows a track wrapper lets the concurrent hierarchy path resume first (#3506)", async () => {
      const navWrite = deferred<void>();
      const resolutionOrder: string[] = [];

      const navigationHandler = (async () => {
        await barrier.track(() => navWrite.promise);
        resolutionOrder.push("navigation");
      })();
      const hierarchyPath = navWrite.promise.then(() => {
        resolutionOrder.push("hierarchy");
      });

      navWrite.resolve();
      await Promise.all([navigationHandler, hierarchyPath]);

      // `track` adds one promise-resolution turn before navigation resumes.
      expect(resolutionOrder).toEqual(["hierarchy", "navigation"]);
    });

    it("counts an already-started promise and clears on settle (E1)", async () => {
      const d = deferred<number>();
      const started = d.promise; // the write is already in flight
      void barrier.trackExisting(started);
      expect(barrier.inFlightCount()).toBe(1);
      d.resolve(1);
      await started;
      // Let the barrier's settle handler run.
      await Promise.resolve();
      expect(barrier.inFlightCount()).toBe(0);
    });

    it("drain waits for a trackExisting promise then resolves true (E2)", async () => {
      const d = deferred<void>();
      void barrier.trackExisting(d.promise);
      expect(barrier.inFlightCount()).toBe(1);

      const drainPromise = barrier.drain(1000);
      expect(timer.getPendingTimeoutCount()).toBe(1);

      d.resolve();
      await d.promise;

      expect(await drainPromise).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    it("a wedged trackExisting promise times out at the bound (E2)", async () => {
      const wedged = deferred<void>();
      void barrier.trackExisting(wedged.promise);
      expect(barrier.inFlightCount()).toBe(1);

      const drainPromise = barrier.drain(1000);
      timer.advanceTime(1000);
      expect(await drainPromise).toBe(false);
    });

    it("decrements the counter when the underlying promise rejects (E3)", async () => {
      const d = deferred<void>();
      const started = d.promise;
      const tracked = barrier.trackExisting(started);
      expect(barrier.inFlightCount()).toBe(1);
      d.reject(new Error("boom"));
      // The derived promise never rejects (E4) — it swallows to undefined.
      expect(await tracked).toBeUndefined();
      // The original promise still carries the rejection for the caller.
      await expect(started).rejects.toThrow("boom");
      expect(barrier.inFlightCount()).toBe(0);
    });

    it("returned promise resolves undefined on reject — safe to void (E4)", async () => {
      const d = deferred<void>();
      const started = d.promise;
      // Original owner handles the rejection (mirrors the WS handler's `await`).
      const ownerHandled = started.catch(() => "handled");
      // Fire-and-forget registration must not surface an unhandled rejection.
      void barrier.trackExisting(started);
      d.reject(new Error("boom"));
      expect(await ownerHandled).toBe("handled");
      // Give the microtask queue a beat; no unhandled rejection should escape.
      await Promise.resolve();
      expect(barrier.inFlightCount()).toBe(0);
    });

    it("passes the resolved value through when not draining", async () => {
      const tracked = barrier.trackExisting(Promise.resolve(42));
      expect(await tracked).toBe(42);
    });

    it("short-circuits without counting while draining (E5)", async () => {
      barrier.beginDrain();
      const d = deferred<void>();
      const started = d.promise;
      const tracked = barrier.trackExisting(started);
      // Not counted — the write already started; Part-1 covers the close race.
      expect(barrier.inFlightCount()).toBe(0);
      d.resolve();
      expect(await tracked).toBeUndefined();
    });
  });
});
