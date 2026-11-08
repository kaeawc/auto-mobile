import { createExecResult } from "../../../../src/utils/execResult";
import { DefaultAndroidObservationCollector } from "../../../../src/features/observe/collectors/AndroidObservationCollector";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { observeResultSchema } from "../../../../src/server/toolOutputSchemas/observation";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createObserveResultForTest } from "../flatHierarchyBuilders";
import type { BootedDevice } from "../../../../src/models";
import { fixtureHierarchy, readCarAppHostFixture } from "../automotive/carAppHostFixtures";

const capture = (name: string): string =>
  readFileSync(
    new URL(`../../../fixtures/automotive/aaos-34-userdebug/cap-${name}.txt`, import.meta.url),
    "utf8",
  );
function setup(formFactor: BootedDevice["formFactor"] = "automotive") {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const collector = new DeviceStateCollector({
    device: { platform: "android", deviceId: "fake", name: "fake", formFactor },
    adb,
    timer,
    window: new FakeWindow(),
    backStack: { execute: async () => ({ depth: 0, activities: [], tasks: [] }) },
  });
  const result = createObserveResultForTest({ updatedAt: 0 });
  adb.setCommandResponse(
    "CarDrivingStateService",
    createExecResult(capture("drivingstate-moving"), ""),
  );
  adb.setCommandResponse(
    "CarUxRestrictionsManagerService",
    createExecResult(capture("uxr-moving"), ""),
  );
  adb.setCommandResponse(
    "get-do-activities com.android.car.settings",
    createExecResult(capture("do-activities-car-settings"), ""),
  );
  adb.setCommandResponse(
    "get-do-activities com.android.settings",
    createExecResult(capture("do-activities-android-settings"), ""),
  );
  return { adb, timer, collector, result };
}

test("automotive collector reports DO and blocking without sleeping", async () => {
  const { collector, result, adb, timer } = setup();
  result.activeWindow = {
    appId: "com.android.car.settings",
    activityName: ".common.CarSettingActivities$HomepageActivity",
    layoutSeqSum: 0,
  };
  await collector.collectAutomotive(result);
  expect(result.automotive).toEqual({
    drivingState: "moving",
    uxRestrictions: { requiresDistractionOptimization: true, activeRestrictions: 255 },
    foregroundActivity: { distractionOptimized: true },
    blocked: false,
  });
  result.activeWindow = {
    appId: "com.android.settings",
    activityName: ".Settings",
    layoutSeqSum: 0,
  };
  await collector.collectAutomotive(result);
  expect(result.automotive?.blocked).toBe(true);
  expect(result.automotive?.foregroundActivity?.distractionOptimized).toBe(false);
  expect(adb.getExecutedArgv()[2]).toEqual([
    "shell",
    "cmd",
    "car_service",
    "get-do-activities",
    "com.android.car.settings",
  ]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("phone payload is byte-identical and performs no automotive reads", async () => {
  const { collector, result, adb } = setup("phone");
  const before = JSON.stringify(result);
  await collector.collectAutomotive(result);
  expect(JSON.stringify(result)).toBe(before);
  expect(Object.hasOwn(result, "automotive")).toBe(false);
  expect(adb.getExecutedCommands()).toEqual([]);
});

test("unknown foreground and unavailable replies do not assert blocking or DO", async () => {
  const { collector, result, adb } = setup();
  await collector.collectAutomotive(result, undefined, 3);
  expect(result.automotive?.uxRestrictions?.activeRestrictions).toBe(511);
  expect(result.automotive?.blocked).toBe(false);
  expect(result.automotive?.foregroundActivity).toBeUndefined();
  adb.setDefaultError(new Error("unavailable"));
  await collector.collectAutomotive(result);
  expect(result.automotive).toEqual({ blocked: false });
});

test("Android payload assembly attaches automotive state after foreground attribution", async () => {
  const { collector, result, timer } = setup();
  const android = new DefaultAndroidObservationCollector({
    device: () => ({
      name: "fake",
      deviceId: "fake",
      platform: "android",
      formFactor: "automotive",
    }),
    deviceStateCollector: () => collector,
    hierarchyCollector: () => new FakeHierarchyCollector("com.android.settings/.Settings"),
    viewHierarchy: () => new FakeViewHierarchy(),
  });
  await android.collect({
    result,
    queryOptions: undefined,
    perf: new NoOpPerformanceTracker(),
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    readOnly: true,
    capturedHierarchy: undefined,
    readOptions: undefined,
    skipBackStack: true,
    displayId: 0,
  });
  expect(result.activeWindow?.activityName).toBe("com.android.settings.Settings");
  expect(result.automotive?.blocked).toBe(true);
  const parsed = observeResultSchema.parse(result);
  expect(parsed.automotive).toEqual(result.automotive);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("parked non-DO activity is unblocked and signal reaches each read", async () => {
  const { collector, result, adb } = setup();
  adb.setCommandResponse(
    "CarDrivingStateService",
    createExecResult(capture("drivingstate-parked"), ""),
  );
  adb.setCommandResponse(
    "CarUxRestrictionsManagerService",
    createExecResult(capture("uxr-parked"), ""),
  );
  result.activeWindow = {
    appId: "com.android.settings",
    activityName: "com.android.settings.Settings",
    layoutSeqSum: 0,
  };
  const signal = new AbortController().signal;
  await collector.collectAutomotive(result, signal);
  expect(result.automotive?.blocked).toBe(false);
  expect(result.automotive?.drivingState).toBe("parked");
  expect(result.automotive?.foregroundActivity?.distractionOptimized).toBe(false);
  expect(adb.getCommandCalls().every((call) => call.signal === signal)).toBe(true);
});

test("a captured Car App Library template screen carries the host-rendered marker", async () => {
  const { collector, result, adb } = setup();
  const grid = readCarAppHostFixture("grid");
  result.activeWindow = grid.activeWindow;
  result.viewHierarchy = fixtureHierarchy(grid);
  await collector.collectAutomotive(result);
  expect(result.automotive?.hostRenderedUi).toEqual({
    kind: "carAppLibrary",
    hostPackage: "com.google.android.apps.automotive.templates.host",
  });
  expect(observeResultSchema.parse(result).automotive).toEqual(result.automotive);
  const reads = adb.getExecutedCommands().length;
  result.activeWindow = {
    appId: "com.android.settings",
    activityName: ".Settings",
    layoutSeqSum: 0,
  };
  result.viewHierarchy = { hierarchy: { node: {} } };
  await collector.refreshAutomotiveForegroundActivity(result);
  expect(Object.hasOwn(result.automotive ?? {}, "hostRenderedUi")).toBe(false);
  expect(adb.getExecutedCommands()).toHaveLength(reads + 1);
});
