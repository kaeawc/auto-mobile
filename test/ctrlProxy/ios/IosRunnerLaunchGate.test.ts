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
