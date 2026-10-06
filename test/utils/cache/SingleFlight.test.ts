import { describe, expect, test } from "bun:test";
import { SingleFlight } from "../../../src/utils/cache/SingleFlight";

describe("SingleFlight", () => {
  test("shares one active task for a key and starts a new task after settlement", async () => {
    const first = Promise.withResolvers<number>();
    let calls = 0;
    const singleFlight = new SingleFlight<string, number>();
    const task = () => {
      calls += 1;
      return first.promise;
    };

    const waiters = Array.from({ length: 8 }, () => singleFlight.run("inventory", task));
    await Promise.resolve();
    expect(calls).toBe(1);

    first.resolve(42);
    await expect(Promise.all(waiters)).resolves.toEqual(Array(8).fill(42));

    await expect(singleFlight.run("inventory", async () => ++calls)).resolves.toBe(2);
  });

  test("lets a cancelled leader stop waiting without aborting shared work", async () => {
    const work = Promise.withResolvers<string>();
    const leader = new AbortController();
    const follower = new AbortController();
    const cancellation = new Error("leader disconnected");
    let calls = 0;
    const singleFlight = new SingleFlight<string, string>();

    const leaderResult = singleFlight.run(
      "inventory",
      () => {
        calls += 1;
        return work.promise;
      },
      leader.signal,
    );
    const followerResult = singleFlight.run("inventory", () => work.promise, follower.signal);

    leader.abort(cancellation);
    await expect(leaderResult).rejects.toBe(cancellation);
    expect(follower.signal.aborted).toBe(false);

    work.resolve("fresh snapshot");
    await expect(followerResult).resolves.toBe("fresh snapshot");
    expect(calls).toBe(1);
  });

  test("shares a failure and permits the next caller to retry", async () => {
    const failure = new Error("adb unavailable");
    let calls = 0;
    const singleFlight = new SingleFlight<string, number>();
    const task = async () => {
      calls += 1;
      throw failure;
    };

    const first = singleFlight.run("inventory", task).catch((error: unknown) => error);
    const second = singleFlight.run("inventory", task).catch((error: unknown) => error);
    await expect(Promise.all([first, second])).resolves.toEqual([failure, failure]);
    expect(calls).toBe(1);

    await expect(singleFlight.run("inventory", async () => ++calls)).resolves.toBe(2);
  });

  test("does not start work for an already-cancelled caller", async () => {
    const controller = new AbortController();
    const cancellation = new Error("already cancelled");
    controller.abort(cancellation);
    let calls = 0;
    const singleFlight = new SingleFlight<string, number>();

    await expect(
      singleFlight.run(
        "inventory",
        async () => {
          calls += 1;
          return 1;
        },
        controller.signal,
      ),
    ).rejects.toBe(cancellation);
    expect(calls).toBe(0);
  });

  test("cancels opt-in shared work only after the last waiter aborts", async () => {
    const pending = Promise.withResolvers<string>();
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    let flightSignal: AbortSignal | undefined;
    let calls = 0;
    const singleFlight = new SingleFlight<string, string>();
    const task = (signal?: AbortSignal) => {
      calls += 1;
      flightSignal = signal;
      return pending.promise;
    };

    const first = singleFlight.run("inventory", task, firstCaller.signal, {
      cancelWhenAllWaitersAbort: true,
    });
    const second = singleFlight.run("inventory", task, secondCaller.signal, {
      cancelWhenAllWaitersAbort: true,
    });
    await Promise.resolve();
    firstCaller.abort();
    await expect(first).rejects.toThrow(/abort/i);
    expect(flightSignal?.aborted).toBe(false);

    secondCaller.abort();
    await expect(second).rejects.toThrow(/abort/i);
    expect(flightSignal?.aborted).toBe(true);

    const retry = Promise.withResolvers<string>();
    const retried = singleFlight.run(
      "inventory",
      async () => {
        calls += 1;
        return await retry.promise;
      },
      undefined,
      { cancelWhenAllWaitersAbort: true },
    );
    await Promise.resolve();
    expect(calls).toBe(2);
    retry.resolve("fresh flight");
    await expect(retried).resolves.toBe("fresh flight");
    pending.resolve("abandoned flight");
  });

  test("a new waiter keeps opt-in work alive after another waiter aborts", async () => {
    const pending = Promise.withResolvers<string>();
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    const lateCaller = new AbortController();
    let flightSignal: AbortSignal | undefined;
    const singleFlight = new SingleFlight<string, string>();
    const task = (signal?: AbortSignal) => {
      flightSignal = signal;
      return pending.promise;
    };

    const first = singleFlight.run("inventory", task, firstCaller.signal, {
      cancelWhenAllWaitersAbort: true,
    });
    const second = singleFlight.run("inventory", task, secondCaller.signal, {
      cancelWhenAllWaitersAbort: true,
    });
    firstCaller.abort();
    await expect(first).rejects.toThrow(/abort/i);
    const late = singleFlight.run("inventory", task, lateCaller.signal, {
      cancelWhenAllWaitersAbort: true,
    });
    await Promise.resolve();
    secondCaller.abort();
    await expect(second).rejects.toThrow(/abort/i);
    expect(flightSignal?.aborted).toBe(false);
    pending.resolve("still running");
    await expect(late).resolves.toBe("still running");
  });

  test("has() reports a joinable flight only until it settles or is abandoned", async () => {
    const pending = Promise.withResolvers<string>();
    const waiter = new AbortController();
    const singleFlight = new SingleFlight<string, string>();
    expect(singleFlight.has("inventory")).toBe(false);

    const abandoned = singleFlight.run("inventory", () => pending.promise, waiter.signal, {
      cancelWhenAllWaitersAbort: true,
    });
    expect(singleFlight.has("inventory")).toBe(true);
    waiter.abort();
    await expect(abandoned).rejects.toThrow(/abort/i);
    expect(singleFlight.has("inventory")).toBe(false);

    const settled = singleFlight.run("inventory", async () => "done");
    expect(singleFlight.has("inventory")).toBe(true);
    await settled;
    expect(singleFlight.has("inventory")).toBe(false);
  });
});
