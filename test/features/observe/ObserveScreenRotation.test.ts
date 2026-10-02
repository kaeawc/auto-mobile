import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import {
  SnapshotReferenceStore,
  snapshotReferenceUnavailable,
} from "../../../src/features/observe/SnapshotReferenceStore";
import { cropSnapshot } from "../../../src/features/observe/screenshot/snapshotCrop";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { issue8379Hierarchy } from "../../fixtures/issue8379Hierarchy";
import { normalizeIosHierarchy } from "../../../src/features/observe/HierarchyNormalization";
import { iosProjectionFixture } from "../../fixtures/iosProjectionFixture";

const device: BootedDevice = { deviceId: "ios-rotation-test", name: "iPhone", platform: "ios" };

afterEach(() => {
  mock.restore();
  resetObserveCacheStore();
  resetScreenshotStateStore();
  displayTransitions.reset(device.deviceId);
});

function portraitHierarchy(): ViewHierarchyResult {
  return {
    ...normalizeIosHierarchy(iosProjectionFixture()),
    hierarchy: {
      ...normalizeIosHierarchy(iosProjectionFixture()).hierarchy,
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
    },
    screenWidth: 402,
    screenHeight: 874,
    nativeScale: 3,
    frameContext: "epoch:1:hash",
  };
}

function setup(hierarchy: ViewHierarchyResult, platform: "ios" | "android" = "ios") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy(hierarchy);
  const cacheStore = new FakeObserveCacheStore(timer);
  const adb = new FakeAdbExecutor();
  const screen = new RealObserveScreen(
    { ...device, platform },
    new FakeAdbClientFactory(adb),
    {
      viewHierarchy,
      screenshot: {
        execute: async () => ({ success: true, path: "/fake/screen.png" }),
        generateScreenshotPath: () => "/fake/screen.png",
        getActivityHash: async () => "",
      },
      screenshotEvidenceFiles: { stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }) },
      hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, platform),
      cacheStore,
      screenshotStateStore: new FakeScreenshotStateStore(timer),
    },
    timer,
  );
  spyOn(screen["performanceAuditor"], "run").mockResolvedValue(undefined);
  spyOn(screen["accessibilityAuditor"], "run").mockResolvedValue(undefined);
  spyOn(screen["accessibilityStateDetector"], "run").mockResolvedValue(undefined);
  return { screen, cacheStore, timer, adb };
}

test.each([
  ["old runner portrait", portraitHierarchy(), 0, 402, 874],
  ["Duo pixel-settled landscape", issue8379Hierarchy(), 1, 951, 669],
  ["runner landscape right", { ...issue8379Hierarchy(), rotation: 3 }, 3, 951, 669],
  ["Duo interface portrait", { ...issue8379Hierarchy(), rotation: 0 }, 0, 951, 669],
  ["fixed portrait display", { ...portraitHierarchy(), rotation: 1 }, 0, 402, 874],
] as const)(
  "collects %s and preserves it through execute/cache/device reads",
  async (_name, hierarchy, rotation, width, height) => {
    const { screen } = setup(hierarchy);
    const collected = screen.createBaseResult();
    await screen.collectAllData(collected);
    expect(collected.rotation).toBe(rotation);
    expect(collected.screenSize).toMatchObject({ width, height });
    expect(collected.viewHierarchy?.rotation).toBe(hierarchy.rotation);
    const executed = await screen.execute({ skipScreenshot: true, skipBackStack: true });
    expect(executed.rotation).toBe(rotation);
    expect(RealObserveScreen.getRecentCachedObservation()?.result.rotation).toBe(rotation);
    expect(RealObserveScreen.getRecentCachedResult()?.rotation).toBe(rotation);
    expect(RealObserveScreen.getRecentCachedResultForDevice(device.deviceId)?.rotation).toBe(
      rotation,
    );
    await screen.cacheObserveResult(executed);
    expect((await screen.getMostRecentCachedObserveResult()).rotation).toBe(rotation);
    expect((await screen.getMostRecentCachedObserveResult()).rotation).toBe(rotation);
    expect((await screen.executeDeviceRead(undefined, "none")).rotation).toBe(rotation);
    const screenshotRead = await screen.executeDeviceRead();
    expect(screenshotRead.rotation).toBe(rotation);
    expect(screenshotRead.screenshotPath).toBe("/fake/screen.png");
  },
);

test("normalizes an old cached observation without changing its hierarchy or stored result", async () => {
  const { screen, cacheStore } = setup(portraitHierarchy());
  const cached = {
    ...screen.createBaseResult(),
    screenSize: { width: 951, height: 669 },
    viewHierarchy: issue8379Hierarchy(),
  };
  await cacheStore.put(device.deviceId, cached);
  const read = await screen.getMostRecentCachedObserveResult();
  expect(read.rotation).toBe(1);
  expect(read.viewHierarchy?.rotation).toBeUndefined();
  expect(cached.rotation).toBeUndefined();
});

test("recapture uses pixel-settled size and updates only observation rotation", () => {
  const { screen } = setup(portraitHierarchy());
  const result = { ...screen.createBaseResult(), rotation: 0 };
  screen["applyRecapturedHierarchy"](result, issue8379Hierarchy());
  expect(result.screenSize).toEqual({ width: 951, height: 669 });
  expect(result.rotation).toBe(1);
  expect(result.viewHierarchy?.rotation).toBeUndefined();
});

test("post-action observation inherits the fallback from real ObserveScreen", async () => {
  const { screen, adb, timer } = setup(issue8379Hierarchy());
  const action = new BaseVisualChange(device, adb, timer);
  action.observeScreen = screen;
  const result = await action["takeObservation"]({ success: true }, null, {
    changeExpected: false,
    deferPostActionScreenshot: true,
  });
  expect(result.observation.rotation).toBe(1);
  expect(result.observation.viewHierarchy?.rotation).toBeUndefined();
});

test("iOS fallback enables snapshot references and rotation still invalidates them", async () => {
  const { screen, timer } = setup(portraitHierarchy());
  const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });
  const store = new SnapshotReferenceStore(timer, new CountingIdGenerator());
  expect(snapshotReferenceUnavailable(result)).toEqual([]);
  const capture = store.capture(device.deviceId, result);
  expect(capture.status).toBe("captured");
  if (capture.status !== "captured") {
    throw new Error("Missing reference");
  }
  expect(
    store.staleReason(capture.reference.snapshotId, device.deviceId, { ...result, rotation: 1 }),
  ).toContain("rotation");
  expect(result.viewHierarchy?.rotation).toBeUndefined();
});

test("tapOn hierarchy replacements reconcile rotation from the replacement size", () => {
  const portrait = portraitHierarchy();
  const landscape: ViewHierarchyResult = {
    ...portrait,
    hierarchy: {
      ...portrait.hierarchy,
      bounds: { left: 0, top: 0, right: portrait.screenHeight!, bottom: portrait.screenWidth! },
    },
    screenWidth: portrait.screenHeight,
    screenHeight: portrait.screenWidth,
  };
  const { screen, adb, timer } = setup(portrait);
  const action = new TapOnElement(device, adb, { timer });
  const result = { ...screen.createBaseResult(), rotation: 1 };
  for (const [hierarchy, rotation] of [
    [portrait, 0],
    [landscape, 1],
    [{ ...landscape, rotation: 3 }, 3],
  ] as const) {
    action["replaceObservationHierarchy"](result, hierarchy, false);
    expect(result.screenSize).toEqual({
      width: hierarchy.screenWidth,
      height: hierarchy.screenHeight,
    });
    expect(result.rotation).toBe(rotation);
    expect(result.screenSize.width < result.screenSize.height).toBe(rotation === 0);
    expect(result.viewHierarchy?.rotation).toBe(hierarchy.rotation);
  }
});

test("pinch capture geometry resolves rotation without altering screenshot orientation evidence", async () => {
  const hierarchy = issue8379Hierarchy();
  const { screen, adb, timer } = setup(hierarchy);
  const capture = new FakeHierarchyCapture(() => hierarchy, "ios");
  const action = new PinchOn(device, adb, { timer, capture });
  const snapshot = await capture.capture({ freshness: "fresh" });
  const result = action["withCaptureGeometry"](
    { ...screen.createBaseResult(), rotation: 0 },
    snapshot,
  );
  expect(result.rotation).toBe(1);
  expect(result.viewHierarchy?.rotation).toBeUndefined();
});

test("snapshotOf crop input retains absent runner rotation rather than guessing a quarter-turn", async () => {
  const { screen } = setup(issue8379Hierarchy());
  const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });
  expect(result.rotation).toBe(1);
  const image = new FakeImageBackend();
  image.setMetadataResult({ width: 2007, height: 2853, format: "png", size: 12 });
  await expect(
    cropSnapshot(
      Buffer.from("fake"),
      { left: 0, top: 0, right: 10, bottom: 10 },
      {
        platform: "ios",
        screenSize: result.screenSize,
        rotation: result.viewHierarchy?.rotation,
        nativeScale: result.viewHierarchy?.nativeScale,
      },
      image,
    ),
  ).rejects.toThrow("incompatible aspect ratios");
  expect(result.viewHierarchy?.rotation).toBeUndefined();
});

test("Android collection, recapture and old cache keep runner-only rotation", async () => {
  const hierarchy: ViewHierarchyResult = {
    hierarchy: { node: { $: { class: "android.widget.FrameLayout" } } },
    screenWidth: 402,
    screenHeight: 874,
    rotation: 3,
  };
  const { screen, cacheStore } = setup(hierarchy, "android");
  const collected = screen.createBaseResult();
  await screen.collectAllData(collected);
  expect(collected.rotation).toBe(3);
  const result = screen.createBaseResult();
  screen["applyRecapturedHierarchy"](result, hierarchy);
  expect(result.rotation).toBe(3);
  screen["applyRecapturedHierarchy"](result, { ...hierarchy, rotation: undefined });
  expect(result.rotation).toBeUndefined();
  await cacheStore.put(device.deviceId, result);
  expect((await screen.getMostRecentCachedObserveResult()).rotation).toBeUndefined();
});
