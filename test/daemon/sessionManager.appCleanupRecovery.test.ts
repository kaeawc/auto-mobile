import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const deviceId = "fake-device";
let timer: FakeTimer;
let manager: SessionManager;
let markers: InMemoryDeviceHealthMarkers;
let incarnation: number;
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
beforeEach(() => {
  timer = new FakeTimer();
  manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  markers = new InMemoryDeviceHealthMarkers(timer);
  incarnation = 1;
  manager.setDeviceHealthMarkers(
    markers,
    () => incarnation,
    () => true,
  );
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  manager.stopCleanupTimer();
  timer.reset();
  warn.mockRestore();
});

function mark(retry: () => Promise<void>, key: string) {
  manager.markDeviceNeedsAppCleanup(deviceId, retry, 5000, key);
}
const marked = () => markers.get(deviceId, incarnation, "app-cleanup");
async function step(ms: number) {
  await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
  await drainUntilQuiescent(timer);
}

test("different apps both run and quarantine waits for both settlements", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const calls: string[] = [];
  mark(async () => {
    calls.push("app.a");
    await first.promise;
  }, "app.a");
  await step(1000);
  mark(async () => {
    calls.push("app.b");
    await second.promise;
  }, "app.b");
  first.resolve();
  await step(0);
  expect(marked()).toBeDefined();
  await step(1000);
  expect(calls).toEqual(["app.a", "app.b"]);
  expect(marked()).toBeDefined();
  second.resolve();
  await step(0);
  expect(marked()).toBeUndefined();
});

test("same app replaces its closure before dispatch", async () => {
  const calls: string[] = [];
  mark(async () => {
    calls.push("old");
  }, "app.a");
  mark(async () => {
    calls.push("latest");
  }, "app.a");
  await step(1000);
  expect(calls).toEqual(["latest"]);
  expect(marked()).toBeUndefined();
});

test("different cleanup steps for one app both settle before the marker clears", async () => {
  const clear = Promise.withResolvers<void>();
  const terminate = Promise.withResolvers<void>();
  const calls: string[] = [];
  mark(async () => {
    calls.push("clearAppData");
    await clear.promise;
  }, "app.a:clearAppData");
  mark(async () => {
    calls.push("terminateApp");
    await terminate.promise;
  }, "app.a:terminateApp");
  await step(1000);
  expect(calls).toEqual(["clearAppData", "terminateApp"]);
  clear.resolve();
  await step(0);
  expect(marked()).toBeDefined();
  terminate.resolve();
  await step(0);
  expect(marked()).toBeUndefined();
});

test("later successful app cannot acknowledge an exhausted app", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  mark(async () => {
    firstCalls++;
    throw new Error("app.a still dirty");
  }, "app.a");
  for (const delay of [1000, 2000, 4000]) {
    await step(delay);
  }
  expect(firstCalls).toBe(3);
  expect(marked()).toBeDefined();
  mark(async () => {
    secondCalls++;
  }, "app.b");
  await step(1000);
  expect(secondCalls).toBe(1);
  expect(marked()).toBeDefined();
  expect(firstCalls).toBe(4);
});

test("same app replacement during dispatch remains owed after old success", async () => {
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  mark(async () => {
    calls.push("old");
    await gate.promise;
  }, "app.a");
  await step(1000);
  mark(async () => {
    calls.push("latest");
  }, "app.a");
  gate.resolve();
  await step(0);
  expect(marked()).toBeDefined();
  await step(1000);
  expect(calls).toEqual(["old", "latest"]);
  expect(marked()).toBeUndefined();
});

test.each(["clear", "incarnation"])("%s drops exhausted app work", async (action) => {
  let old = 0;
  mark(async () => {
    old++;
    throw new Error("still dirty");
  }, "app.a");
  for (const delay of [1000, 2000, 4000]) {
    await step(delay);
  }
  if (action === "clear") {
    markers.clear(deviceId);
  } else {
    incarnation++;
  }
  mark(async () => {}, "app.b");
  await step(1000);
  expect(old).toBe(3);
  expect(marked()).toBeUndefined();
});
