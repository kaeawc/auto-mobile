import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { afterEach, describe, expect, test } from "bun:test";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import { computeFreshness } from "../../../src/features/observe/observationFreshness";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";

const device: BootedDevice = { deviceId: "cached-freshness", name: "Device", platform: "android" };

afterEach(() => {
  resetObserveCacheStore();
  displayTransitions.reset(device.deviceId);
  ObservedAndroidDisplayCache.release(device.deviceId);
  AndroidCtrlProxyClient.removeInstance(device.deviceId);
});

function setup() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  const cacheStore = new FakeObserveCacheStore(timer);
  const protection = new FakeScreenshotPathProtection(timer);
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    { cacheStore, screenshotPathProtection: protection },
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
  return { timer, cacheStore, screen, result, protection };
}

function panelSetup(singleDisplay = false) {
  const target: BootedDevice = {
    ...device,
    displays: singleDisplay
      ? undefined
      : {
          panels: [
            // Inventory order must not decide the active panel.
            { key: "cover", role: "cover", sizePx: { width: 100, height: 150 } },
            { key: "inner", role: "inner", sizePx: { width: 200, height: 300 } },
          ],
          postures: [],
        },
  };
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  for (const displayId of [0, 2]) {
    adb.setForegroundApp({ packageName: "com.example", userId: 0 }, { displayId });
  }
  AndroidCtrlProxyClient.registerForTesting(
    new FakeCtrlProxy() as unknown as AndroidCtrlProxyClient,
    device.deviceId,
  );
  adb.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 300}\nDisplay id 2: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 150}',
    stderr: "",
  });
  const cacheStore = new FakeObserveCacheStore(timer);
  setObserveCacheStore(cacheStore);
  const viewHierarchy = new FakeViewHierarchy();
  const capture = new FakeHierarchyCapture(() => {
    const cover = capture.requests.at(-1)?.displayId === 2;
    const key = singleDisplay ? "0" : cover ? "cover" : "inner";
    const width = cover ? 100 : 200;
    const height = cover ? 150 : 300;
    return {
      hierarchy: {
        node: {
          $: {
            text: key,
            package: "com.example",
            clickable: "true",
            bounds: `[0,0][${width},${height}]`,
          },
        },
      },
      displayId: cover ? 2 : 0,
      panelUniqueId: `local:${key}`,
      screenWidth: width,
      screenHeight: height,
      updatedAt: timer.now(),
      receivedAt: timer.now(),
      fresh: true,
      packageName: "com.example",
      foregroundActivity: "com.example/.MainActivity",
    };
  });
  viewHierarchy.configureHierarchy({
    hierarchy: { node: { $: { text: "inner", package: "com.example", bounds: "[0,0][200,300]" } } },
    screenWidth: 200,
    screenHeight: 300,
    displayId: 0,
    panelUniqueId: "local:inner",
    updatedAt: timer.now(),
    receivedAt: timer.now(),
    fresh: true,
    packageName: "com.example",
    foregroundActivity: "com.example/.MainActivity",
  });
  const createScreen = (display?: string) =>
    new RealObserveScreen(
      target,
      new FakeAdbClientFactory(adb),
      {
        display,
        viewHierarchy,
        hierarchyCapture: capture,
        screenshotPathProtection: new FakeScreenshotPathProtection(timer),
      },
      timer,
      new FakeIdGenerator(),
    );
  const screen = createScreen();
  const observe = (display?: string) =>
    screen.execute({
      display,
      freshness: "cached-ok",
      skipScreenshot: true,
      skipBackStack: true,
      skipPerformanceAudit: true,
      skipAccessibilityAudit: true,
    });
  return { target, adb, capture, cacheStore, screen, createScreen, observe };
}

describe("ObserveScreen cached panel targeting", () => {
  test("an explicit cover capture before any default observe is a miss for an unscoped read", async () => {
    const h = panelSetup();
    const cover = await h.observe("cover");
    expect(cover.display.key).toBe("cover");
    expect(cover.freshness).toMatchObject({ isFresh: true });
    const cached = await h.createScreen().getMostRecentCachedObserveResult();
    expect(cached.freshness?.isFresh).not.toBe(true);
    expect(cached.viewHierarchy).toBeUndefined();
    expect(cached.error).toBe("No cached observe result available");
    expect((await h.observe()).display.key).toBe("inner");
    expect(h.capture.requests).toHaveLength(2);
  });

  test("a cover capture cannot supply the accepted default panel's hierarchy", async () => {
    const h = panelSetup();
    const inner = await h.observe();
    await h.observe("cover");
    expect(displayTransitions.currentObservedPanel(device.deviceId)?.key).toBe("inner");
    expect(displayTransitions.revision(device.deviceId)).toBe(inner.displayRevision!);
    expect((await h.screen.getMostRecentCachedObserveResult()).viewHierarchy).toBeUndefined();
  });

  test("default observe remains a cache hit without further device reads", async () => {
    const h = panelSetup();
    const inner = await h.observe();
    const commands = h.adb.getExecutedCommands();
    const cached = await h.createScreen().getMostRecentCachedObserveResult();
    expect(cached.viewHierarchy).toEqual(inner.viewHierarchy);
    expect(cached.freshness?.isFresh).toBe(true);
    expect(h.capture.requests).toHaveLength(1);
    expect(h.adb.getExecutedCommands()).toEqual(commands);
  });

  test("explicit cover cache read rejects a default-panel entry", async () => {
    const h = panelSetup();
    await h.observe();
    expect(
      (await h.createScreen("cover").getMostRecentCachedObserveResult()).viewHierarchy,
    ).toBeUndefined();
  });

  test("repeated explicit cover reads retain their cached baseline", async () => {
    const h = panelSetup();
    await h.observe();
    const cover = await h.observe("cover");
    const cached = await h.createScreen("cover").getMostRecentCachedObserveResult();
    expect(cached.viewHierarchy).toEqual(cover.viewHierarchy);
    expect(cached.display.key).toBe("cover");
    expect(cached.freshness).toMatchObject({ isFresh: false, category: "cache_age" });
    expect(h.cacheStore.getPutCallCount()).toBe(2);
    expect(h.capture.requests).toHaveLength(2);
  });

  test("a session pin targets its panel while explicit active bypasses the pin", async () => {
    const h = panelSetup();
    await h.observe();
    const cover = await h.observe("cover");
    await runWithSelectedDisplayPin({ pin: "cover", inventory: h.target.displays }, async () => {
      expect((await h.screen.getMostRecentCachedObserveResult()).viewHierarchy).toEqual(
        cover.viewHierarchy,
      );
      expect(
        (await h.createScreen("active").getMostRecentCachedObserveResult()).viewHierarchy,
      ).toBeUndefined();
    });
  });

  test("single-display cached reads preserve cache hits and device read counts", async () => {
    const h = panelSetup(true);
    const observation = await h.observe();
    const commands = h.adb.getExecutedCommands();
    for (let i = 0; i < 3; i++) {
      const cached = await h.createScreen().getMostRecentCachedObserveResult();
      expect(cached.viewHierarchy).toEqual(observation.viewHierarchy);
      expect(cached.freshness?.isFresh).toBe(true);
    }
    expect(h.capture.requests).toHaveLength(1);
    expect(h.cacheStore.getPutCallCount()).toBe(1);
    expect(h.adb.getExecutedCommands()).toEqual(commands);
  });
});

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

test("a cached observe result recomputes and extends its screenshot return deadline", async () => {
  const { timer, cacheStore, screen, result, protection } = setup();
  result.screenshotPath = "/cached.png";
  result.screenshotExpiresAt = 1;
  await cacheStore.put(device.deviceId, result);
  const first = await screen.getMostRecentCachedObserveResult();
  expect(first.screenshotExpiresAt).toBe(timer.now() + 600_000);
  timer.advanceTime(100_000);
  const second = await screen.getMostRecentCachedObserveResult();
  expect(second.screenshotExpiresAt).toBe(timer.now() + 600_000);
  timer.advanceTime(500_001);
  expect(protection.isProtected("/cached.png")).toBe(true);
});
