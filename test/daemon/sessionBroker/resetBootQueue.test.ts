import { describe, expect, test } from "bun:test";
import { ResetBootQueue } from "../../../src/daemon/sessionBroker/resetBootQueue";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

describe("reset boot cleanup queue", () => {
  test("excess resets wait before entering the gate and release slots on failure", async () => {
    const timer = new FakeTimer();
    const queue = new ResetBootQueue(1, timer);
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = queue.run(async () => {
      events.push("first");
      await finish.promise;
      throw new Error("failed");
    });
    const rejected = first.catch((error: unknown) => error);
    const second = queue.run(async () => {
      events.push("second");
    });
    await drainUntilQuiescent(timer);
    expect(events).toEqual(["first"]);
    finish.resolve();
    expect(await rejected).toMatchObject({ message: "failed" });
    await second;
    expect(events).toEqual(["first", "second"]);
  });

  test("cancelled queued reset never enters native work or starves its successor", async () => {
    const timer = new FakeTimer();
    const queue = new ResetBootQueue(1, timer);
    const finish = Promise.withResolvers<void>();
    const controller = new AbortController();
    const events: string[] = [];
    const first = queue.run(() => finish.promise);
    const second = queue.run(async () => {
      events.push("cancelled");
    }, controller.signal);
    const rejected = second.catch((error: unknown) => error);
    const third = queue.run(async () => {
      events.push("third");
    });
    controller.abort(new Error("cancelled"));
    expect(await rejected).toMatchObject({ message: expect.stringContaining("cancelled") });
    finish.resolve();
    await Promise.all([first, third]);
    expect(events).toEqual(["third"]);
  });

  test("reports how long each run waited for a slot", async () => {
    const timer = new FakeTimer();
    const queue = new ResetBootQueue(1, timer, () => timer.now());
    const finish = Promise.withResolvers<void>();
    const waits: number[] = [];
    const first = queue.run(
      () => finish.promise,
      undefined,
      (ms) => waits.push(ms),
    );
    const second = queue.run(
      async () => {},
      undefined,
      (ms) => waits.push(ms),
    );
    timer.advanceTime(750);
    finish.resolve();
    await Promise.all([first, second]);
    expect(waits).toEqual([0, 750]);
  });
});
