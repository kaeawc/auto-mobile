import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice } from "../../../../src/models";
import { DefaultAndroidObservationCollector } from "../../../../src/features/observe/collectors/AndroidObservationCollector";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { parseAndroidDeviceDisplays } from "../../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

const fixture = (path: string): string =>
  readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), "utf8");
const clusterKey = "4619827551948147201";
const mainKey = "4619827259835644672";
const virtualKey = "virtual:com.android.emulator.multidisplay:1234562";
// The existing SurfaceFlinger capture names the same two physical emulator panels.
const displays = parseAndroidDeviceDisplays(
  fixture("android-display/fold-surfaceflinger.txt"),
  fixture("android-aaos-cluster-screen-size/dumpsys-display.txt"),
  "",
  { automotive: true },
);
const device: BootedDevice = {
  platform: "android",
  deviceId: "targeted-display-size",
  name: "fake",
  displays,
};

async function collectScreenSize(key: string | undefined) {
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
  });
  const result = createObserveResultForTest({
    display: { key: key ?? "", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 0, height: 0 },
  });
  if (key === undefined) {
    // Exercise a degraded runtime result without weakening the public DisplayRef type.
    Reflect.deleteProperty(result.display, "key");
  }
  await collector.collect({
    result,
    queryOptions: undefined,
    perf: new NoOpPerformanceTracker(),
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    readOnly: true,
    // FakeHierarchyCollector passes this through without adding screen dimensions.
    capturedHierarchy: { hierarchy: {} },
    readOptions: undefined,
    skipBackStack: true,
    displayId: key === clusterKey ? 2 : key === virtualKey ? 3 : 0,
  });
  expect(result.viewHierarchy?.screenWidth).toBeUndefined();
  expect(result.viewHierarchy?.screenHeight).toBeUndefined();
  return result.screenSize;
}

test("the captured before observation targets the cluster but reports the main size", () => {
  const before: { content: { text: string }[] } = JSON.parse(
    fixture("android-aaos-cluster-screen-size/observe-cluster-display-before.json"),
  );
  const observation: { display: { key: string }; screenSize: { width: number; height: number } } =
    JSON.parse(before.content[0].text);
  expect(observation.display.key).toBe(clusterKey);
  expect(observation.screenSize).toMatchObject({ width: 1024, height: 768 });
  expect(displays?.panels.find((panel) => panel.key === clusterKey)?.role).toBe("cluster");
});

test.each([
  [clusterKey, 400, 600],
  [mainKey, 1024, 768],
  [virtualKey, 1280, 720],
] as const)("missing hierarchy dimensions use targeted panel %s", async (key, width, height) => {
  expect(await collectScreenSize(key)).toEqual({ width, height });
});

test("no display key retains the active panel size fallback", async () => {
  expect(await collectScreenSize(undefined)).toEqual({ width: 1024, height: 768 });
});

test("an unknown display key degrades to the active panel size without throwing", async () => {
  expect(await collectScreenSize("disconnected-panel")).toEqual({ width: 1024, height: 768 });
});
