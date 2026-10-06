import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";

const deviceId = "panel-eligibility";
const imageSize = { width: 200, height: 200 };
const twoPanels: BootedDevice["displays"] = {
  panels: [
    { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
    { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
  ],
  postures: [],
};

afterEach(() => {
  mock.restore();
  resetObserveCacheStore();
  resetScreenshotStateStore();
  displayTransitions.reset(deviceId);
});

function setup(displays: BootedDevice["displays"], display: string | undefined) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const hierarchy: ViewHierarchyResult = {
    hierarchy: { node: {} },
    screenWidth: 200,
    screenHeight: 200,
    rotation: 0,
    ...(displays ? { displayId: 2 } : {}),
  };
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy(hierarchy);
  const cacheStore = new FakeObserveCacheStore(timer);
  const store = new FakeScreenshotStateStore(timer);
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    stderr: "",
  });
  let captureFails = false;
  const screen = new RealObserveScreen(
    { deviceId, name: "Fake", platform: "android", displays },
    new FakeAdbClientFactory(adb),
    {
      viewHierarchy,
      hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, "android"),
      screenshot: {
        execute: async () =>
          captureFails
            ? { success: false, error: "capture failed" }
            : { success: true, path: "/fake/read.png", screenshotImageSize: imageSize },
        generateScreenshotPath: () => "/fake/read.png",
        getActivityHash: async () => "",
      },
      screenshotRecorder: new FakeScreenshotRecorder(),
      display,
      screenshotEvidenceFiles: { stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }) },
      cacheStore,
      screenshotStateStore: store,
    },
    timer,
  );
  spyOn(screen["performanceAuditor"], "run").mockResolvedValue(undefined);
  spyOn(screen["accessibilityAuditor"], "run").mockResolvedValue(undefined);
  spyOn(screen["accessibilityStateDetector"], "run").mockResolvedValue(undefined);
  return {
    screen,
    store,
    cacheStore,
    failCapture: () => {
      captureFails = true;
    },
  };
}

/** Cache an observation the way an observe of the named panel would, with its own screenshot. */
async function cachePanelScreenshot(
  cacheStore: FakeObserveCacheStore,
  observed: ObserveResult,
  stamp: { key: string; path: string; generation?: number },
) {
  await cacheStore.put(deviceId, {
    ...observed,
    display: {
      ...observed.display,
      key: stamp.key,
      role: stamp.key === "cover" ? "cover" : "external",
      generation: stamp.generation ?? observed.display.generation,
    },
    screenshotPath: stamp.path,
  });
}

test("a default-display read does not reuse another panel's cached screenshot", async () => {
  const { screen, cacheStore, failCapture } = setup(twoPanels, undefined);
  const fresh = await screen.executeDeviceRead();
  const otherKey = fresh.display.key === "cover" ? "external" : "cover";
  await cachePanelScreenshot(cacheStore, fresh, { key: otherKey, path: "/fake/other-panel.png" });
  failCapture();
  const result = await screen.executeDeviceRead();
  expect(result.screenshotPath).toBeUndefined();
  expect(result.screenshotSettled).toBe(false);
});

test("a default-display read does not reuse the device-wide state-store path on multi-panel devices", async () => {
  const { screen, store, failCapture } = setup(twoPanels, undefined);
  store.update(deviceId, "/fake/other-panel-state.png");
  failCapture();
  const result = await screen.executeDeviceRead();
  expect(result.screenshotPath).toBeUndefined();
});

test("a cached screenshot from an older display generation is not reused", async () => {
  const { screen, cacheStore, failCapture } = setup(twoPanels, undefined);
  const fresh = await screen.executeDeviceRead();
  await cachePanelScreenshot(cacheStore, fresh, {
    key: fresh.display.key,
    path: "/fake/old-generation.png",
    generation: fresh.display.generation + 1,
  });
  failCapture();
  const result = await screen.executeDeviceRead();
  expect(result.screenshotPath).toBeUndefined();
});

test("a default-display read still reuses the same panel's cached screenshot", async () => {
  const { screen, cacheStore, failCapture } = setup(twoPanels, undefined);
  const fresh = await screen.executeDeviceRead();
  await cachePanelScreenshot(cacheStore, fresh, {
    key: fresh.display.key,
    path: "/fake/same-panel.png",
  });
  failCapture();
  const result = await screen.executeDeviceRead();
  expect(result).toMatchObject({
    screenshotPath: "/fake/same-panel.png",
    screenshotSource: "cached",
  });
});

test("an explicit-display read reuses only its own panel's cached screenshot", async () => {
  const { screen, cacheStore, failCapture } = setup(twoPanels, "external");
  const fresh = await screen.executeDeviceRead();
  expect(fresh.display.key).toBe("external");
  await cachePanelScreenshot(cacheStore, fresh, { key: "cover", path: "/fake/cover.png" });
  failCapture();
  expect((await screen.executeDeviceRead()).screenshotPath).toBeUndefined();
  await cachePanelScreenshot(cacheStore, fresh, { key: "external", path: "/fake/external.png" });
  expect(await screen.executeDeviceRead()).toMatchObject({
    screenshotPath: "/fake/external.png",
    screenshotSource: "cached",
  });
});

test("single-display devices keep the cached and state-store fallbacks", async () => {
  const { screen, cacheStore, store, failCapture } = setup(undefined, undefined);
  const fresh = await screen.executeDeviceRead();
  failCapture();
  store.update(deviceId, "/fake/state.png");
  expect((await screen.executeDeviceRead()).screenshotPath).toBe("/fake/state.png");
  await cacheStore.put(deviceId, { ...fresh, screenshotPath: "/fake/cached.png" });
  expect((await screen.executeDeviceRead()).screenshotPath).toBe("/fake/cached.png");
});
