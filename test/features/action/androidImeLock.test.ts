import { expect, test } from "bun:test";
import { withAndroidImeLock } from "../../../src/features/action/androidImeLock";

let deviceNumber = 0;

test("aborts a queued middle waiter promptly and preserves FIFO for other waiters", async () => {
  const deviceId = `ime-lock-cancel-${++deviceNumber}`;
  const events: string[] = [];
  let releaseHolder: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  const holder = withAndroidImeLock(deviceId, async () => {
    events.push("holder");
    await held;
  });
  const first = withAndroidImeLock(deviceId, async () => {
    events.push("first");
  });
  const controller = new AbortController();
  let canceled = false;
  const middle = withAndroidImeLock(
    deviceId,
    async () => {
      events.push("middle");
    },
    controller.signal,
  ).catch(() => {
    canceled = true;
  });
  const last = withAndroidImeLock(deviceId, async () => {
    events.push("last");
  });

  controller.abort();
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  const canceledBeforeRelease = canceled;
  const eventsBeforeRelease = [...events];
  releaseHolder();
  await Promise.all([holder, first, middle, last]);
  await withAndroidImeLock(deviceId, async () => {
    events.push("after");
  });

  expect(canceledBeforeRelease).toBe(true);
  expect(eventsBeforeRelease).toEqual(["holder"]);
  expect(events).toEqual(["holder", "first", "last", "after"]);
});

test("rejects an already aborted waiter before its action runs", async () => {
  const deviceId = `ime-lock-cancel-${++deviceNumber}`;
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  await expect(
    withAndroidImeLock(
      deviceId,
      async () => {
        ran = true;
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(ran).toBe(false);
});
