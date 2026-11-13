import { expect, test } from "bun:test";
import { CachedAndroidXrDisplaySize } from "../../../../src/features/observe/android/AndroidXrDisplaySize";
import { DefaultActiveWindowAttributionReconciler } from "../../../../src/features/observe/ActiveWindowAttribution";
import { DisplayTransitionTracker } from "../../../../src/features/observe/DisplayTransition";
import { readFileSync } from "node:fs";
import type { ViewHierarchyResult } from "../../../../src/models";
import { DefaultAndroidObservationCollector } from "../../../../src/features/observe/collectors/AndroidObservationCollector";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { queryDisplaySize } from "../../../../src/features/record/android/AxisRanges";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../../fakes/FakeAndroidXrDetector";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeLogger } from "../../../fakes/FakeLogger";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

const fixture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/android-xr/observe-settings-search-ime-up-screensize-17881.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function setup(xr: boolean | undefined) {
  const device = { platform: "android", deviceId: "fake-xr-size", name: "fake" } as const;
  const adb = new FakeAdbClient();
  adb.setCommandResult("shell wm size", "Physical size: 2560x2558");
  const logger = new FakeLogger();
  const timer = new FakeTimer();
  const viewHierarchy = new FakeViewHierarchy();
  const deviceStateCollector = new DeviceStateCollector({
    device,
    adb,
    timer,
    window: new FakeWindow(),
    backStack: { execute: async () => ({ depth: 0, activities: [], tasks: [] }) },
  });
  const xrDisplaySize = new CachedAndroidXrDisplaySize({
    device: () => device,
    adb: () => adb,
    xrDetector: xr === undefined ? undefined : new FakeAndroidXrDetector(xr),
    readDisplaySize: () => queryDisplaySize(adb),
    logger,
    hierarchyCollector: () => new FakeHierarchyCollector(),
  });
  const collector = new DefaultAndroidObservationCollector({
    xrDisplaySize,
    device: () => device,
    deviceStateCollector: () => deviceStateCollector,
    hierarchyCollector: () => new FakeHierarchyCollector(),
    viewHierarchy: () => viewHierarchy,
  });
  const reconciler = new DefaultActiveWindowAttributionReconciler({
    xrDisplaySize,
    device: () => device,
    viewHierarchy: () => viewHierarchy,
    deviceStateCollector: () => deviceStateCollector,
    platformValidator: () => ({ validate: () => ({ valid: true }) }),
    resolveObservationTimestampMs: (result) => result.viewHierarchy?.updatedAt,
    extractScreenSizeFromHierarchy: () => null,
  });
  async function collect(rotation = 0, displayId = 0) {
    const hierarchy = structuredClone(fixture.viewHierarchy);
    hierarchy.rotation = rotation;
    const result = createObserveResultForTest();
    await collector.collect({
      result,
      queryOptions: undefined,
      perf: new NoOpPerformanceTracker(),
      skipWaitForFresh: true,
      minTimestamp: 0,
      signal: undefined,
      readOnly: true,
      capturedHierarchy: hierarchy,
      readOptions: undefined,
      skipBackStack: true,
      displayId,
    });
    return result;
  }
  return { adb, logger, collect, reconciler, viewHierarchy, timer };
}

test("XR IME process bounds use the display size and reconcile all hierarchy fields", async () => {
  const { collect, adb } = setup(true);
  const result = await collect();
  expect(result.screenSize).toEqual({ width: 2560, height: 2558 });
  expect(result.viewHierarchy).toMatchObject({
    screenWidth: 2560,
    screenHeight: 2558,
    pixelWidth: 2560,
    pixelHeight: 2558,
  });
  await collect();
  // Each observe re-reads wm size so a mid-instance override is not hidden (#17915).
  expect(adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(2);
  adb.setCommandResult("shell wm size", "Physical size: 2560x2558\nOverride size: 2000x1900");
  expect((await collect()).screenSize).toEqual({ width: 2000, height: 1900 });
  expect((await collect(1)).screenSize).toEqual({ width: 1900, height: 2000 });
  expect(adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(4);
});

test("non-XR and non-default displays retain captured size without wm size", async () => {
  for (const [xr, displayId] of [
    [false, 0],
    [true, 2],
  ] as const) {
    const { collect, adb } = setup(xr);
    expect((await collect(0, displayId)).screenSize).toEqual({ width: 1080, height: 608 });
    expect(adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(0);
    expect(adb.getAllCommands().filter((command) => command.includes("has-feature"))).toHaveLength(
      0,
    );
  }
});

test("failed size read warns and falls back", async () => {
  const { collect, adb, logger } = setup(true);
  adb.setCommandError("shell wm size", new Error("size unavailable"));
  expect((await collect()).screenSize).toEqual({ width: 1080, height: 608 });
  expect(logger.messages).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("XR display size read failed"),
    }),
  );
});

test("wm override size takes precedence", async () => {
  const { adb } = setup(true);
  adb.setCommandResult("shell wm size", "Physical size: 2560x2558\nOverride size: 2000x1900");
  expect(await queryDisplaySize(adb)).toEqual({ width: 2000, height: 1900 });
});

test.each([true, false])("recapture keeps collector geometry with XR=%s", async (xr) => {
  const { collect, reconciler, adb, timer } = setup(xr);
  const result = await collect();
  const size = { ...result.screenSize };
  const transitions = new DisplayTransitionTracker(() => undefined);
  transitions.record("fake-xr-size", result);
  const hierarchy = structuredClone(fixture.viewHierarchy);
  reconciler.applyRecapturedHierarchy(result, hierarchy);
  expect(result.screenSize).toEqual(
    xr ? { width: 2560, height: 2558 } : { width: 1080, height: 608 },
  );
  expect(result.screenSize).toEqual(size);
  expect(transitions.geometryChanged("fake-xr-size", result.screenSize)).toBe(false);
  expect(hierarchy.screenWidth).toBe(size.width);
  expect(hierarchy.screenHeight).toBe(size.height);
  if (xr) {
    expect(hierarchy.pixelWidth).toBe(size.width);
    expect(hierarchy.pixelHeight).toBe(size.height);
  }
  expect(adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(
    xr ? 1 : 0,
  );
  expect(timer.getSleepHistory()).toEqual([]);
});

test("async overlay recapture primes a new rotation parity and reuses it", async () => {
  const { collect, reconciler, adb, viewHierarchy } = setup(true);
  const result = await collect();
  const hierarchy = structuredClone(fixture.viewHierarchy);
  hierarchy.rotation = 1;
  hierarchy.fresh = true;
  hierarchy.updatedAt = (result.viewHierarchy?.updatedAt ?? 0) + 1;
  viewHierarchy.configureHierarchy(hierarchy);
  expect(await reconciler.recaptureHierarchyForSystemUiOverlay(result)).toBe(true);
  expect(result.screenSize).toEqual({ width: 2558, height: 2560 });
  expect(result.viewHierarchy).toMatchObject({
    screenWidth: 2558,
    screenHeight: 2560,
    pixelWidth: 2558,
    pixelHeight: 2560,
  });
  expect(await reconciler.recaptureHierarchyForSystemUiOverlay(result)).toBe(true);
  expect(adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(2);
});

test("recapture does not apply default-display cache to another display", async () => {
  const { collect, reconciler, adb } = setup(true);
  const result = await collect();
  const hierarchy = structuredClone(fixture.viewHierarchy);
  hierarchy.displayId = 2;
  await reconciler.primeRecapturedHierarchy(result, hierarchy);
  reconciler.applyRecapturedHierarchy(result, hierarchy);
  expect(result.screenSize).toEqual({ width: 1080, height: 608 });
  expect(adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(1);
});
