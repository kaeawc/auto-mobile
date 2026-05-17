import { afterEach, describe, expect, test } from "bun:test";
import {
  InMemoryScreenshotStateStore,
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
    const fake = new FakeScreenshotStateStore();
    setScreenshotStateStore(fake);

    const store = getScreenshotStateStore();
    expect(store).toBe(fake);

    store.update("device-fake", "/tmp/fake.png");
    expect(fake.getStateForDevice("device-fake")?.path).toBe("/tmp/fake.png");
  });

  test("resetScreenshotStateStore clears any swapped-in implementation", () => {
    const fake = new FakeScreenshotStateStore();
    setScreenshotStateStore(fake);
    resetScreenshotStateStore();

    expect(getScreenshotStateStore()).not.toBe(fake);
  });
});
