import { expect, test } from "bun:test";
import type { BootedDevice } from "../../../../src/models";
import { DefaultAndroidObservationCollector } from "../../../../src/features/observe/collectors/AndroidObservationCollector";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { queryDisplaySize } from "../../../../src/features/record/android/AxisRanges";
import { createExecResult } from "../../../../src/utils/execResult";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

// `adb shell wm size` on the API 24 emulator in #18982.
const WM_SIZE_API24 = "Physical size: 720x1280\n";

// Below Android 10 the display inventory is unreadable, so the device carries no panels.
const device: BootedDevice = { platform: "android", deviceId: "api24-no-inventory", name: "fake" };

async function collectSize(options: {
  key: string;
  rotation?: number;
  wmSize?: string;
  withReader?: boolean;
}) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell wm size", createExecResult(options.wmSize ?? WM_SIZE_API24, ""));
  const deviceState = new DeviceStateCollector({
    device,
    adb: new FakeAdbExecutor(),
    timer: new FakeTimer(),
    window: new FakeWindow(),
    backStack: { execute: async () => ({ depth: 0, activities: [], tasks: [] }) },
  });
  const collector = new DefaultAndroidObservationCollector({
    device: () => device,
    deviceStateCollector: () => deviceState,
    hierarchyCollector: () => new FakeHierarchyCollector(),
    viewHierarchy: () => new FakeViewHierarchy(),
    readDisplaySize: options.withReader === false ? undefined : () => queryDisplaySize(adb),
  });
  const result = createObserveResultForTest({
    display: { key: options.key, role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 0, height: 0 },
    rotation: options.rotation ?? 0,
  });
  await collector.collect({
    result,
    queryOptions: undefined,
    perf: new NoOpPerformanceTracker(),
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    readOnly: true,
    capturedHierarchy: { hierarchy: {} },
    readOptions: undefined,
    skipBackStack: true,
    displayId: 0,
  });
  return result.screenSize;
}

test("a default display with no inventory is sized from wm size", async () => {
  expect(await collectSize({ key: "0" })).toEqual({ width: 720, height: 1280 });
});

test("a landscape rotation swaps the wm size axes", async () => {
  expect(await collectSize({ key: "0", rotation: 1 })).toEqual({ width: 1280, height: 720 });
});

test("an override size wins over the physical size", async () => {
  const wmSize = "Physical size: 720x1280\nOverride size: 540x960\n";
  expect(await collectSize({ key: "0", wmSize })).toEqual({ width: 540, height: 960 });
});

test("an unparseable wm size leaves the size unknown", async () => {
  expect(await collectSize({ key: "0", wmSize: "error\n" })).toEqual({ width: 0, height: 0 });
});

test("without a wm size reader the size stays unknown", async () => {
  expect(await collectSize({ key: "0", withReader: false })).toEqual({ width: 0, height: 0 });
});

test("a named non-default display does not borrow wm size", async () => {
  expect(await collectSize({ key: "disconnected-panel" })).toEqual({ width: 0, height: 0 });
});
