import { afterEach, describe, expect, test } from "bun:test";
import { runExclusiveResetTest } from "./resetTestSerialLock";

/**
 * Behavioural pins for the cross-file reset-test serialization lock (issue
 * #2942). The lock is a module-scoped FIFO mutex shared by every reset suite, so
 * a test that leaves it held wedges every later caller in the process. These
 * cases prove the four properties that keep that from happening — FIFO
 * exclusion, release-on-throw, cross-caller error isolation, and value
 * passthrough — while never leaving the shared lock held (see afterEach).
 */

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Pump the macrotask queue enough turns that any number of chained
 * `await prior.catch(...)` hops inside runExclusiveResetTest have settled. A
 * single `await Promise.resolve()` is NOT enough — awaiting a predecessor costs
 * ≥2 ticks — so this flushes generously (issue #4186 correction).
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("runExclusiveResetTest", () => {
  // Gates a failing assertion might otherwise leave unresolved, wedging the
  // shared module lock for every later caller. ALWAYS released in teardown so a
  // red assertion can never deadlock the rest of the suite.
  const openGates: Array<() => void> = [];
  afterEach(() => {
    for (const release of openGates.splice(0)) {
      release();
    }
  });

  test("holds the lock so a later caller cannot start until the earlier releases", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    openGates.push(() => firstGate.resolve());

    const firstDone = runExclusiveResetTest(async () => {
      order.push("first-start");
      await firstGate.promise;
      order.push("first-end");
    });
    const secondDone = runExclusiveResetTest(async () => {
      order.push("second-start");
      await Promise.resolve();
      order.push("second-end");
    });

    await flush();
    // The second caller is still parked behind the lock the first holds.
    expect(order).toEqual(["first-start"]);

    firstGate.resolve();
    await Promise.all([firstDone, secondDone]);

    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  test("releases the lock when a body throws so the next caller still runs", async () => {
    const ran: string[] = [];

    await expect(
      runExclusiveResetTest(async () => {
        ran.push("throwing");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the throwing body did not release, this await would hang forever.
    await runExclusiveResetTest(async () => {
      ran.push("after-throw");
    });

    expect(ran).toEqual(["throwing", "after-throw"]);
  });

  test("an earlier caller's rejection does not fail a later caller", async () => {
    const failing = runExclusiveResetTest(async () => {
      throw new Error("upstream");
    });
    const later = runExclusiveResetTest(async () => "recovered");

    await expect(failing).rejects.toThrow("upstream");
    await expect(later).resolves.toBe("recovered");
  });

  test("resolves with the body's returned value", async () => {
    await expect(runExclusiveResetTest(async () => 42)).resolves.toBe(42);
  });
});
