import { describe, expect, test } from "bun:test";
import { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import { FakeTimer } from "../fakes/FakeTimer";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SingleFlightInterval", () => {
  test("drops an interval tick while the previous tick is still active", async () => {
    const timer = new FakeTimer();
    const firstTick = deferred();
    let starts = 0;
    const interval = new SingleFlightInterval(timer, 5_000, () => {
      starts++;
      return starts === 1 ? firstTick.promise : Promise.resolve();
    });

    interval.start();
    timer.advanceTime(5_000);
    expect(starts).toBe(1);

    // A slow poll must not create a second, concurrent polling epoch.
    timer.advanceTime(5_000);
    expect(starts).toBe(1);

    firstTick.resolve();
    await Promise.resolve();
    await Promise.resolve();

    timer.advanceTime(5_000);
    expect(starts).toBe(2);
    await interval.stop();
  });

  test("stops scheduling and waits for an active tick to settle", async () => {
    const timer = new FakeTimer();
    const activeTick = deferred();
    let starts = 0;
    const interval = new SingleFlightInterval(
      timer,
      5_000,
      () => {
        starts++;
        return activeTick.promise;
      },
      { stopTimeoutMs: 10_000 },
    );

    interval.start();
    timer.advanceTime(5_000);
    const stopped = interval.stop();

    expect(timer.getPendingIntervalCount()).toBe(0);
    timer.advanceTime(5_000);
    expect(starts).toBe(1);

    activeTick.resolve();
    await expect(stopped).resolves.toBe(true);
  });

  test("bounds shutdown when an active tick does not settle", async () => {
    const timer = new FakeTimer();
    const activeTick = deferred();
    const interval = new SingleFlightInterval(timer, 5_000, () => activeTick.promise, {
      stopTimeoutMs: 50,
    });

    interval.start();
    timer.advanceTime(5_000);
    const stopped = interval.stop();

    timer.advanceTime(49);
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    timer.advanceTime(1);
    await expect(stopped).resolves.toBe(false);
  });

  test("reports a rejected active tick and treats it as settled during shutdown", async () => {
    const timer = new FakeTimer();
    let rejectTick!: (error: Error) => void;
    const activeTick = new Promise<void>((_resolve, reject) => {
      rejectTick = reject;
    });
    const errors: Error[] = [];
    const interval = new SingleFlightInterval(timer, 5_000, () => activeTick, {
      onError: (error) => {
        errors.push(error as Error);
      },
    });

    interval.start();
    timer.advanceTime(5_000);
    const stopped = interval.stop();
    const failure = new Error("reap failed");
    rejectTick(failure);

    await expect(stopped).resolves.toBe(true);
    expect(errors).toEqual([failure]);
  });
});
