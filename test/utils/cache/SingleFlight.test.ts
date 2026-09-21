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
});
