import { afterEach, describe, expect, test } from "bun:test";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { computeFreshness } from "../../../src/features/observe/observationFreshness";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "cached-freshness", name: "Device", platform: "android" };

afterEach(() => {
  resetObserveCacheStore();
  displayTransitions.reset(device.deviceId);
});

function setup() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  const cacheStore = new FakeObserveCacheStore(timer);
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    { cacheStore },
    timer,
  );
  const result = screen.createBaseResult();
  result.screenSize = { width: 1080, height: 2400 };
  result.viewHierarchy = {
    updatedAt: timer.now(),
    receivedAt: timer.now(),
    fresh: true,
    hierarchy: { node: { bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } } },
  } as ObserveResult["viewHierarchy"];
  result.displayRevision = displayTransitions.revision(device.deviceId);
  result.freshness = computeFreshness({
    actualTimestamp: timer.now(),
    now: timer.now(),
    verified: true,
  });
  return { timer, cacheStore, screen, result };
}

describe("ObserveScreen cached freshness", () => {
  test("retracts a stored fresh verdict after the age budget without mutating the cache", async () => {
    const { timer, cacheStore, screen, result } = setup();
    await cacheStore.put(device.deviceId, result);
    timer.advanceTime(120_000);

    const read = await screen.getMostRecentCachedObserveResult();
    expect(read).not.toBe(result);
    expect(read.freshness).toMatchObject({ isFresh: false, category: "cache_age", ageMs: 120_000 });
    expect(result.freshness).toMatchObject({ isFresh: true, ageMs: 0 });
    expect((await cacheStore.getMostRecent(device.deviceId))?.freshness?.isFresh).toBe(true);
  });

  test("stays fresh within the budget", async () => {
    const { timer, cacheStore, screen, result } = setup();
    await cacheStore.put(device.deviceId, result);
    timer.advanceTime(1_000);

    expect((await screen.getMostRecentCachedObserveResult()).freshness).toMatchObject({
      isFresh: true,
      ageMs: 1_000,
    });
  });

  test("keeps a stored negative verdict and its category", async () => {
    const { timer, cacheStore, screen, result } = setup();
    result.freshness = {
      ...result.freshness,
      isFresh: false,
      category: "window_identity",
      warning: "Wrong window at capture",
    };
    await cacheStore.put(device.deviceId, result);
    timer.advanceTime(120_000);

    expect((await screen.getMostRecentCachedObserveResult()).freshness).toMatchObject({
      isFresh: false,
      category: "window_identity",
      warning: "Wrong window at capture",
      ageMs: 120_000,
    });
  });

  test("retracts freshness when display revision changes", async () => {
    const { cacheStore, screen, result } = setup();
    displayTransitions.notifyTransition(device.deviceId, "display changed");
    await cacheStore.put(device.deviceId, result);

    expect((await screen.getMostRecentCachedObserveResult()).freshness).toMatchObject({
      isFresh: false,
      category: "cache_age",
    });
  });

  test("retracts freshness when recorded geometry differs", async () => {
    const { cacheStore, screen, result } = setup();
    displayTransitions.record(device.deviceId, {
      display: result.display,
      screenSize: { width: 1200, height: 2400 },
    });
    await cacheStore.put(device.deviceId, result);

    expect((await screen.getMostRecentCachedObserveResult()).freshness).toMatchObject({
      isFresh: false,
      category: "cache_age",
    });
  });
});
