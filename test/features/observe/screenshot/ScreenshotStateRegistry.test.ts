import { afterEach, describe, expect, test } from "bun:test";
import {
  InMemoryScreenshotStateStore,
  MAX_CLEARED_OBSERVATION_TOMBSTONES_PER_DEVICE,
  OBSERVE_RESULT_CACHE_TTL_MS,
  getScreenshotStateStore,
  resetScreenshotStateStore,
  setScreenshotStateStore,
} from "../../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeScreenshotStateStore } from "../../../fakes/FakeScreenshotStateStore";

describe("InMemoryScreenshotStateStore", () => {
  test("update + getPath round-trips for a single device", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", "/tmp/screen.png");

    expect(store.getPath("device-A")).toBe("/tmp/screen.png");
    expect(store.getError("device-A")).toBeUndefined();
  });

  test("update with error clears path and stores error", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", undefined, "boom");

    expect(store.getPath("device-A")).toBeUndefined();
    expect(store.getError("device-A")).toBe("boom");
  });

  test("getPath() without deviceId returns most recent across devices", () => {
    const timer = new FakeTimer();
    const store = new InMemoryScreenshotStateStore(timer);

    timer.setCurrentTime(1000);
    store.update("device-A", "/tmp/a.png");
    timer.setCurrentTime(2000);
    store.update("device-B", "/tmp/b.png");
    timer.setCurrentTime(1500);
    store.update("device-C", "/tmp/c.png");

    // device-B has the most recent timestamp (2000)
    expect(store.getPath()).toBe("/tmp/b.png");
  });

  test("per-device entries are isolated", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", "/tmp/a.png");
    store.update("device-B", undefined, "bad");

    expect(store.getPath("device-A")).toBe("/tmp/a.png");
    expect(store.getError("device-A")).toBeUndefined();
    expect(store.getPath("device-B")).toBeUndefined();
    expect(store.getError("device-B")).toBe("bad");
  });

  test("TTL expiry evicts per-device entry on read", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", "/tmp/a.png");
    expect(store.getPath("device-A")).toBe("/tmp/a.png");

    // Advance just past TTL
    timer.setCurrentTime(1000 + OBSERVE_RESULT_CACHE_TTL_MS + 1);
    expect(store.getPath("device-A")).toBeUndefined();
    expect(store.getError("device-A")).toBeUndefined();
  });

  test("TTL expiry evicts entries when scanning across devices", () => {
    const timer = new FakeTimer();
    const store = new InMemoryScreenshotStateStore(timer);

    timer.setCurrentTime(1000);
    store.update("device-A", "/tmp/a.png");
    timer.setCurrentTime(2000);
    store.update("device-B", "/tmp/b.png");

    // Advance so device-A is expired but device-B is not
    timer.setCurrentTime(1000 + OBSERVE_RESULT_CACHE_TTL_MS + 1);

    expect(store.getPath()).toBe("/tmp/b.png");
    // Device A should have been evicted
    expect(store.getPath("device-A")).toBeUndefined();
  });

  test("entries within TTL are not evicted", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", "/tmp/a.png");

    // Advance just under TTL
    timer.setCurrentTime(1000 + OBSERVE_RESULT_CACHE_TTL_MS - 1);
    expect(store.getPath("device-A")).toBe("/tmp/a.png");
  });

  test("clear(deviceId) removes only the specified device", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", "/tmp/a.png");
    store.update("device-B", "/tmp/b.png");

    store.clear("device-A");

    expect(store.getPath("device-A")).toBeUndefined();
    expect(store.getPath("device-B")).toBe("/tmp/b.png");
  });

  test("clear() without deviceId removes all devices", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", "/tmp/a.png");
    store.update("device-B", "/tmp/b.png");

    store.clear();

    expect(store.getPath()).toBeUndefined();
    expect(store.getPath("device-A")).toBeUndefined();
    expect(store.getPath("device-B")).toBeUndefined();
  });

  test("update overwrites prior state for the same device", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.update("device-A", undefined, "earlier error");
    timer.setCurrentTime(1100);
    store.update("device-A", "/tmp/a.png");

    expect(store.getPath("device-A")).toBe("/tmp/a.png");
    expect(store.getError("device-A")).toBeUndefined();
  });

  test("keeps a bounded history of observation-scoped screenshot states", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    for (let index = 1; index <= 11; index++) {
      timer.setCurrentTime(1000 + index);
      store.updateForObservation("device-A", `observation-${index}`, `/tmp/${index}.png`);
    }

    expect(store.getPathForObservation("device-A", "observation-1")).toBeUndefined();
    expect(store.getPathForObservation("device-A", "observation-2")).toBe("/tmp/2.png");
    expect(store.getPathForObservation("device-A", "observation-11")).toBe("/tmp/11.png");
  });

  test("keeps observation-scoped state isolated from the device-wide latest state", () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());

    store.update("device-A", "/tmp/latest.png");
    store.updateForObservation("device-A", "observation-A", "/tmp/exact.png");

    expect(store.getPath("device-A")).toBe("/tmp/latest.png");
    expect(store.getPathForObservation("device-A", "observation-A")).toBe("/tmp/exact.png");
  });

  test("does not recreate cleared observation state when its cancelled capture finishes late", () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());

    store.beginObservation("device-A", "observation-A");
    store.clear("device-A");
    store.updateForObservation("device-A", "observation-A", "/tmp/late.png");
    store.endObservation("device-A", "observation-A", "capture cancelled");

    expect(store.getPathForObservation("device-A", "observation-A")).toBeUndefined();
    expect(store.getErrorForObservation("device-A", "observation-A")).toBeUndefined();
  });

  test("tombstones only observations still pending at clear time", () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());

    store.beginObservation("device-A", "completed-observation");
    store.updateForObservation("device-A", "completed-observation", "/tmp/done.png");
    store.beginObservation("device-A", "pending-observation");
    store.clear("device-A");

    expect(store.clearedObservationCount("device-A")).toBe(1);
    // The pending job's late callbacks are dropped ...
    store.updateForObservation("device-A", "pending-observation", "/tmp/late.png");
    expect(store.getPathForObservation("device-A", "pending-observation")).toBeUndefined();
    // ... while a completed id (which cannot call back late) is not fenced, so a
    // fresh write under that id behaves like any other new observation.
    store.updateForObservation("device-A", "completed-observation", "/tmp/again.png");
    expect(store.getPathForObservation("device-A", "completed-observation")).toBe("/tmp/again.png");
  });

  test("retires tombstones once late callbacks can no longer arrive", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const store = new InMemoryScreenshotStateStore(timer);

    store.beginObservation("device-A", "observation-A");
    store.clear("device-A");
    expect(store.clearedObservationCount("device-A")).toBe(1);

    timer.setCurrentTime(1000 + OBSERVE_RESULT_CACHE_TTL_MS + 1);
    store.updateForObservation("device-A", "observation-A", "/tmp/late.png");

    expect(store.clearedObservationCount("device-A")).toBe(0);
    expect(store.getPathForObservation("device-A", "observation-A")).toBe("/tmp/late.png");
  });

  test("caps tombstones per device with insertion-order eviction across repeated clears", () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());
    const total = MAX_CLEARED_OBSERVATION_TOMBSTONES_PER_DEVICE + 5;

    for (let index = 0; index < total; index++) {
      store.beginObservation("device-A", `observation-${index}`);
      store.clear("device-A");
    }

    expect(store.clearedObservationCount("device-A")).toBe(
      MAX_CLEARED_OBSERVATION_TOMBSTONES_PER_DEVICE,
    );
    // The oldest tombstones were evicted; the newest are still fenced.
    store.updateForObservation("device-A", "observation-0", "/tmp/evicted.png");
    expect(store.getPathForObservation("device-A", "observation-0")).toBe("/tmp/evicted.png");
    store.updateForObservation("device-A", `observation-${total - 1}`, "/tmp/fenced.png");
    expect(store.getPathForObservation("device-A", `observation-${total - 1}`)).toBeUndefined();
  });

  test("allows a new observation to write after a device clear", () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());

    store.beginObservation("device-A", "obsolete-observation");
    store.clear("device-A");
    store.beginObservation("device-A", "new-observation");
    store.updateForObservation("device-A", "new-observation", "/tmp/new.png");

    expect(store.getPathForObservation("device-A", "new-observation")).toBe("/tmp/new.png");
  });

  test("waits for the observation-scoped write, then settles on update", async () => {
    const timer = new FakeTimer();
    const store = new InMemoryScreenshotStateStore(timer);

    store.beginObservation("device-A", "observation-A");
    let settled = false;
    const waiting = store.waitForObservation("device-A", "observation-A", 1_000).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    store.updateForObservation("device-A", "observation-A", "/tmp/exact.png");
    await waiting;

    expect(settled).toBe(true);
  });

  test("waitForObservation uses the injected timer for its timeout", async () => {
    const timer = new FakeTimer();
    const store = new InMemoryScreenshotStateStore(timer);

    store.beginObservation("device-A", "observation-A");
    const waiting = store.waitForObservation("device-A", "observation-A", 1_000);
    timer.advanceTime(1_000);

    await waiting;
  });

  test("returns undefined when no state exists", () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());

    expect(store.getPath()).toBeUndefined();
    expect(store.getError()).toBeUndefined();
    expect(store.getPath("device-X")).toBeUndefined();
    expect(store.getError("device-X")).toBeUndefined();
  });
});

describe("module-level screenshot state store", () => {
  afterEach(() => {
    resetScreenshotStateStore();
  });

  test("getScreenshotStateStore returns a working default", () => {
    const store = getScreenshotStateStore();
    store.update("device-default", "/tmp/x.png");
    expect(store.getPath("device-default")).toBe("/tmp/x.png");
  });

  test("setScreenshotStateStore swaps in a custom implementation", () => {
    const fake = new FakeScreenshotStateStore(new FakeTimer());
    setScreenshotStateStore(fake);

    const store = getScreenshotStateStore();
    expect(store).toBe(fake);

    store.update("device-fake", "/tmp/fake.png");
    expect(fake.getStateForDevice("device-fake")?.path).toBe("/tmp/fake.png");
  });

  test("resetScreenshotStateStore clears any swapped-in implementation", () => {
    const fake = new FakeScreenshotStateStore(new FakeTimer());
    setScreenshotStateStore(fake);
    resetScreenshotStateStore();

    expect(getScreenshotStateStore()).not.toBe(fake);
  });
});
