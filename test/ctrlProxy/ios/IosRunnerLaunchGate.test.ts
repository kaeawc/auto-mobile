import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { expect, test } from "bun:test";
import {
  DefaultIosRunnerLaunchGate,
  resolveIosRunnerLaunchConcurrency,
} from "../../../src/ctrlProxy/ios/IosRunnerLaunchGate";

test("launch gate limits five acquirers to two in FIFO order and release is idempotent", async () => {
  const gate = new DefaultIosRunnerLaunchGate(2);
  const first = await gate.acquire();
  const second = await gate.acquire();
  const order: number[] = [];
  const pending = [3, 4, 5].map((id) =>
    gate.acquire().then((slot) => {
      order.push(id);
      return slot;
    }),
  );
  await Promise.resolve();
  expect(order).toEqual([]);
  first.release();
  const third = await pending[0]!;
  first.release();
  expect(order).toEqual([3]);
  second.release();
  const fourth = await pending[1]!;
  third.release();
  const fifth = await pending[2]!;
  expect(order).toEqual([3, 4, 5]);
  fourth.release();
  fifth.release();
});

test("queued abort rejects without releasing a held slot or blocking the next waiter", async () => {
  const gate = new DefaultIosRunnerLaunchGate(1);
  const slot = await gate.acquire();
  const controller = new AbortController();
  const aborted = gate.acquire(controller.signal);
  const rejection = aborted.then(
    () => undefined,
    (error: unknown) => error,
  );
  let granted = false;
  const next = gate.acquire().then((nextSlot) => {
    granted = true;
    return nextSlot;
  });
  controller.abort(new Error("cancelled"));
  expect(await rejection).toEqual(new Error("cancelled"));
  await drainMicrotasks(10);
  expect(granted).toBe(false);
  slot.release();
  (await next).release();
  await expect(gate.acquire(controller.signal)).rejects.toThrow("cancelled");
});

test.each([
  [undefined, 2],
  ["1", 1],
  ["0", 2],
  ["abc", 2],
  ["1.5", 2],
  ["-2", 2],
])("launch concurrency %s resolves to %s", (value, expected) => {
  expect(
    resolveIosRunnerLaunchConcurrency(
      value === undefined ? {} : { AUTOMOBILE_IOS_RUNNER_LAUNCH_CONCURRENCY: value },
    ),
  ).toBe(expected);
});

test("queue status tracks waiting owners, grants and aborts", async () => {
  const gate = new DefaultIosRunnerLaunchGate(2);
  const first = await gate.acquire(undefined, "held-1");
  const second = await gate.acquire(undefined, "held-2");
  const controller = new AbortController();
  const third = gate.acquire(undefined, "third");
  const fourth = gate.acquire(controller.signal, "fourth");
  const fifth = gate.acquire(undefined, "fifth");
  const rejected = fourth.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(gate.queueStatus("third")).toEqual({ position: 1, ahead: 2, limit: 2 });
  expect(gate.queueStatus("fourth")).toEqual({ position: 2, ahead: 3, limit: 2 });
  expect(gate.queueStatus("fifth")).toEqual({ position: 3, ahead: 4, limit: 2 });
  expect(gate.queueStatus("unknown")).toBeUndefined();
  expect(gate.queueStatus("held-1")).toBeUndefined();
  first.release();
  expect(gate.queueStatus("third")).toBeUndefined();
  expect(gate.queueStatus("fifth")).toEqual({ position: 2, ahead: 3, limit: 2 });
  controller.abort(new Error("cancelled"));
  expect(await rejected).toEqual(new Error("cancelled"));
  expect(gate.queueStatus("fourth")).toBeUndefined();
  expect(gate.queueStatus("fifth")).toEqual({ position: 1, ahead: 2, limit: 2 });
  second.release();
  (await third).release();
  (await fifth).release();
  expect(gate.queueStatus("fifth")).toBeUndefined();
});

test("queue observers see queued and admitted only for a launch that waited", async () => {
  const gate = new DefaultIosRunnerLaunchGate(1);
  const events: string[] = [];
  const watch = (owner: string) =>
    gate.watchQueue(owner, {
      queued: () => events.push(`${owner}:queued`),
      admitted: () => events.push(`${owner}:admitted`),
      left: () => events.push(`${owner}:left`),
    });
  const stopImmediate = watch("immediate");
  const held = await gate.acquire(undefined, "immediate");
  expect(events).toEqual([]);
  stopImmediate();
  const stopWaiter = watch("waiter");
  watch("bystander");
  const waiting = gate.acquire(undefined, "waiter");
  expect(events).toEqual(["waiter:queued"]);
  held.release();
  expect(events).toEqual(["waiter:queued", "waiter:admitted"]);
  stopWaiter();
  (await waiting).release();
  expect(events).toEqual(["waiter:queued", "waiter:admitted"]);
});

test("a queued launch that aborts is reported as left, never admitted and unsubscribing is idempotent", async () => {
  const gate = new DefaultIosRunnerLaunchGate(1);
  const events: string[] = [];
  const stop = gate.watchQueue("owner", {
    queued: () => events.push("queued"),
    admitted: () => events.push("admitted"),
    left: () => events.push("left"),
  });
  const held = await gate.acquire();
  const controller = new AbortController();
  const aborted = gate.acquire(controller.signal, "owner").then(
    () => undefined,
    (error: unknown) => error,
  );
  controller.abort(new Error("cancelled"));
  expect(await aborted).toEqual(new Error("cancelled"));
  held.release();
  expect(events).toEqual(["queued", "left"]);
  stop();
  stop();
  const next = gate.acquire();
  const waiting = gate.acquire(undefined, "owner");
  (await next).release();
  (await waiting).release();
  expect(events).toEqual(["queued", "left"]);
});

test("a throwing queue observer cannot stall the hand-off to the next launch", async () => {
  const gate = new DefaultIosRunnerLaunchGate(1);
  gate.watchQueue("owner", {
    queued: () => {},
    admitted: () => {
      throw new Error("observer failed");
    },
    left: () => {},
  });
  const held = await gate.acquire();
  const waiting = gate.acquire(undefined, "owner");
  held.release();
  (await waiting).release();
  expect((await gate.acquire()).release).toBeFunction();
});
