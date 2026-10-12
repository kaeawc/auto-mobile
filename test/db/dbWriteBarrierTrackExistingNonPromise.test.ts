import { describe, expect, test } from "bun:test";
import { InMemoryDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

describe("trackExisting tolerates non-promises without leaking a count", () => {
  for (const draining of [false, true]) {
    test.each([undefined, 42])(`non-thenable %j while draining=${draining}`, async (value) => {
      const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
      if (draining) {
        barrier.beginDrain();
      }
      const result = barrier.trackExisting(value as unknown as Promise<number | undefined>);
      expect(await result).toBe(draining ? undefined : value);
      expect(barrier.inFlightCount()).toBe(0);
      expect(await barrier.drain(1)).toBe(true);
    });
  }

  test("a native promise settles the count before its caller resumes, without an extra turn", async () => {
    const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
    const work = Promise.withResolvers<number>();
    const result = barrier.trackExisting(work.promise);
    expect(barrier.inFlightCount()).toBe(1);
    work.resolve(7);
    await work.promise;
    expect(barrier.inFlightCount()).toBe(0);
    expect(await result).toBe(7);
    expect(await barrier.drain(1)).toBe(true);
  });

  test("drain's idle wait completes when a pending native promise settles", async () => {
    const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
    const work = Promise.withResolvers<void>();
    const result = barrier.trackExisting(work.promise);
    const drained = barrier.drain(1);
    work.resolve();
    await result;
    expect(await drained).toBe(true);
    expect(barrier.inFlightCount()).toBe(0);
  });

  test.each([false, true])("rejection resolves undefined while draining=%s", async (draining) => {
    const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
    if (draining) {
      barrier.beginDrain();
    }
    const work = Promise.withResolvers<void>();
    const result = barrier.trackExisting(work.promise);
    expect(barrier.inFlightCount()).toBe(draining ? 0 : 1);
    work.reject(new Error("write failed"));
    expect(await result).toBeUndefined();
    expect(barrier.inFlightCount()).toBe(0);
    expect(await barrier.drain(1)).toBe(true);
  });
});
