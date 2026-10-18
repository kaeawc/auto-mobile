import { describe, expect, test } from "bun:test";
import type { DbWriteBarrier } from "../../src/db/dbWriteBarrier";

export interface DbWriteBarrierContractHarness {
  barrier: DbWriteBarrier;
  /** Moves the barrier's injected timer forward so a bounded drain can expire. */
  advance(ms: number): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Shared contract for every {@link DbWriteBarrier}: in-flight accounting, the
 * bounded shutdown drain, and the draining short-circuit. Run against the real
 * InMemoryDbWriteBarrier and FakeDbWriteBarrier so the fake cannot drift into
 * reporting an idle barrier or an instantly-drained one (issue #11868).
 */
export const runDbWriteBarrierContract = (
  description: string,
  make: () => DbWriteBarrierContractHarness,
): void => {
  describe(`DbWriteBarrier contract: ${description}`, function () {
    test("runs tracked work, returns its value and leaves nothing in flight", async function () {
      const { barrier } = make();

      expect(await barrier.track(async () => 42)).toBe(42);
      expect(barrier.inFlightCount()).toBe(0);
      expect(barrier.isDraining()).toBe(false);
    });

    test("counts concurrent tracked writes until they settle", async function () {
      const { barrier } = make();
      const first = deferred<void>();
      const second = deferred<void>();

      const tracked = [barrier.track(() => first.promise), barrier.track(() => second.promise)];
      expect(barrier.inFlightCount()).toBe(2);

      first.resolve();
      second.resolve();
      await Promise.all(tracked);
      expect(barrier.inFlightCount()).toBe(0);
    });

    test("propagates a rejection and still decrements the count", async function () {
      const { barrier } = make();
      const write = deferred<void>();

      const tracked = barrier.track(() => write.promise);
      expect(barrier.inFlightCount()).toBe(1);
      write.reject(new Error("boom"));

      await expect(tracked).rejects.toThrow("boom");
      expect(barrier.inFlightCount()).toBe(0);
    });

    test("drain resolves true immediately when idle and latches draining", async function () {
      const { barrier } = make();

      expect(await barrier.drain(1000)).toBe(true);
      expect(barrier.isDraining()).toBe(true);
    });

    test("drain waits for outstanding writes and resolves true once they settle", async function () {
      const { barrier } = make();
      const write = deferred<void>();
      const tracked = barrier.track(() => write.promise);

      let drained: boolean | undefined;
      const drain = barrier.drain(1000).then((result) => {
        drained = result;
      });
      await Promise.resolve();
      expect(drained).toBeUndefined();

      write.resolve();
      await tracked;
      await drain;
      expect(drained).toBe(true);
    });

    test("a wedged write cannot hold drain past its bound", async function () {
      const { barrier, advance } = make();
      void barrier.track(() => deferred<void>().promise);

      const drain = barrier.drain(1000);
      advance(1000);

      expect(await drain).toBe(false);
    });

    test("beginDrain latches draining and track short-circuits without running the work", async function () {
      const { barrier } = make();
      barrier.beginDrain();
      let ran = false;

      const result = await barrier.track(async () => {
        ran = true;
        return 7;
      });

      expect(barrier.isDraining()).toBe(true);
      expect(ran).toBe(false);
      expect(result).toBeUndefined();
      expect(barrier.inFlightCount()).toBe(0);
    });

    test("trackExisting counts an already-started write and releases it on settle", async function () {
      const { barrier } = make();
      const write = deferred<number>();

      const tracked = barrier.trackExisting(write.promise);
      expect(barrier.inFlightCount()).toBe(1);
      write.resolve(5);

      expect(await tracked).toBe(5);
      expect(barrier.inFlightCount()).toBe(0);
    });

    test("trackExisting never rejects but leaves the original rejection to the caller", async function () {
      const { barrier } = make();
      const write = deferred<void>();
      const started = write.promise;

      const tracked = barrier.trackExisting(started);
      write.reject(new Error("boom"));

      expect(await tracked).toBeUndefined();
      await expect(started).rejects.toThrow("boom");
      expect(barrier.inFlightCount()).toBe(0);
    });

    test("drain waits for a trackExisting write", async function () {
      const { barrier } = make();
      const write = deferred<void>();
      void barrier.trackExisting(write.promise);

      let drained: boolean | undefined;
      const drain = barrier.drain(1000).then((result) => {
        drained = result;
      });
      await Promise.resolve();
      expect(drained).toBeUndefined();

      write.resolve();
      await drain;
      expect(drained).toBe(true);
    });

    test("trackExisting while draining does not count the write and swallows rejection", async function () {
      const { barrier } = make();
      barrier.beginDrain();
      const write = deferred<number>();

      const tracked = barrier.trackExisting(write.promise);
      expect(barrier.inFlightCount()).toBe(0);
      write.reject(new Error("late"));

      expect(await tracked).toBeUndefined();
      await expect(write.promise).rejects.toThrow("late");
    });
  });
};
