import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DefaultIosObservationCollector } from "../../../src/features/observe/collectors/IosObservationCollector";
import {
  ObservedAndroidDisplayCache,
  observedIosDisplay,
} from "../../../src/features/observe/ObservationDisplay";
import {
  parseDevicectlDisplayInfo,
  type DevicectlDisplayInfo,
  type DevicectlDisplayInfoSource,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayInfo";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeHierarchyCollector } from "../../fakes/FakeHierarchyCollector";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeLogger } from "../../fakes/FakeLogger";
import { buildObserveResult } from "../../helpers/observeFixture";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";

const fixtureDir = join(process.cwd(), "test/fixtures");
function displays(panel: "inner" | "cover"): DevicectlDisplayInfo[] {
  const parsed = parseDevicectlDisplayInfo(
    readFileSync(
      join(fixtureDir, `ios-devicectl/info-displays-duo-${panel}-active-17087b.json`),
      "utf8",
    ),
    new FakeLogger(),
  );
  if (parsed.kind !== "ok") {
    throw new Error("Expected captured displays");
  }
  return parsed.displays;
}
const stale: Pick<ObserveResult, "screenSize"> = JSON.parse(
  readFileSync(join(fixtureDir, "ios-duo/observe-opened-reports-cover-17087b.json"), "utf8"),
);
const device: BootedDevice = {
  name: "iPhone Duo",
  platform: "ios",
  deviceId: "CE71304F-5D4E-4E51-831A-E5465C14FD8C",
  displays: simulatorDeviceDisplays(
    parseSimulatorDisplays(loadDuoEnumerate()),
    "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  ),
};
class FakeDisplaySource implements DevicectlDisplayInfoSource {
  calls = 0;
  constructor(public value: DevicectlDisplayInfo[] | Error) {}
  async readDisplays(): Promise<DevicectlDisplayInfo[]> {
    this.calls++;
    if (this.value instanceof Error) {
      throw this.value;
    }
    return this.value;
  }
}
async function collect(
  source?: DevicectlDisplayInfoSource,
  options: {
    rotation?: number;
    size?: { width: number; height: number };
    target?: BootedDevice;
  } = {},
) {
  const target = options.target ?? device;
  const size = options.size ?? stale.screenSize;
  const hierarchy: ViewHierarchyResult = {
    hierarchy: {},
    pixelWidth: 1398,
    pixelHeight: 2034,
    screenWidth: size.width,
    screenHeight: size.height,
    rotation: options.rotation ?? 0,
  };
  const hierarchyCollector = new FakeHierarchyCollector();
  hierarchyCollector.extractScreenSize = () => size;
  const collector = new DefaultIosObservationCollector({
    hierarchyCollector: () => hierarchyCollector,
    viewHierarchy: () => new FakeViewHierarchy(),
    device: () => target,
    iosDisplayInfoSource: source,
  });
  const result = buildObserveResult({
    updatedAt: 0,
    screenSize: size,
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  await collector.collect({
    result,
    queryOptions: undefined,
    perf: new NoOpPerformanceTracker(),
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    readOnly: false,
    capturedHierarchy: hierarchy,
    readOptions: undefined,
  });
  result.display = observedIosDisplay(target, result.viewHierarchy);
  return result;
}
afterEach(() => ObservedAndroidDisplayCache.release(device.deviceId));

test("active inner panel overrides stale cover pixels and points", async () => {
  const result = await collect(new FakeDisplaySource(displays("inner")));
  expect(result.display).toMatchObject({ key: "primary-1", role: "inner", posture: "opened" });
  expect(result.screenSize).toEqual({ width: 669, height: 951 });
});
test("active cover panel reports closed and keeps runner points", async () => {
  const result = await collect(new FakeDisplaySource(displays("cover")));
  expect(result.display).toMatchObject({ key: "primary", role: "cover", posture: "closed" });
  expect(result.screenSize).toEqual(stale.screenSize);
});
test("unavailable, failed, zero and multiple active displays discard previous live evidence", async () => {
  for (const value of [
    undefined,
    new Error("read failed"),
    [],
    displays("inner").map((d) => ({ ...d, active: false })),
    displays("inner").map((d) => ({ ...d, active: true })),
  ]) {
    await collect(new FakeDisplaySource(displays("inner")));
    const result = await collect(value === undefined ? undefined : new FakeDisplaySource(value));
    expect(result.display).toMatchObject({ key: "primary", role: "cover", posture: "closed" });
    expect(result.screenSize).toEqual(stale.screenSize);
  }
});
test("ambiguous or unmatched panel sizes use the runner fallback", async () => {
  for (const panels of [
    device.displays!.panels.map((p) => ({ ...p, sizePx: { width: 2007, height: 2853 } })),
    device.displays!.panels.map((p) => ({ ...p, sizePx: { width: 10, height: 20 } })),
  ]) {
    const target = { ...device, displays: { ...device.displays!, panels } };
    ObservedAndroidDisplayCache.clear(device.deviceId);
    const expected = observedIosDisplay(target, { pixelWidth: 1398, pixelHeight: 2034 });
    const result = await collect(new FakeDisplaySource(displays("inner")), { target });
    expect(result.display).toEqual(expected);
    expect(result.screenSize).toEqual(stale.screenSize);
  }
});
test("inner bounds follow landscape rotation and preserve matching runner orientation", async () => {
  const source = new FakeDisplaySource(displays("inner"));
  expect((await collect(source, { rotation: 1 })).screenSize).toEqual({ width: 951, height: 669 });
  for (const size of [
    { width: 669, height: 951 },
    { width: 951, height: 669 },
  ]) {
    expect((await collect(source, { rotation: 3, size })).screenSize).toEqual(size);
  }
});
test("remembered half-open posture applies to the active inner panel", async () => {
  ObservedAndroidDisplayCache.rememberIosPosture(device.deviceId, {
    key: "primary-1",
    role: "inner",
    posture: "half_opened",
    generation: 0,
  });
  expect((await collect(new FakeDisplaySource(displays("inner")))).display.posture).toBe(
    "half_opened",
  );
});
test("single-panel collection does not read devicectl", async () => {
  const source = new FakeDisplaySource(displays("inner"));
  await collect(source, {
    target: { ...device, displays: { ...device.displays!, panels: [device.displays!.panels[0]] } },
  });
  expect(source.calls).toBe(0);
});
test("clear and release discard live panel evidence", async () => {
  for (const clear of [ObservedAndroidDisplayCache.clear, ObservedAndroidDisplayCache.release]) {
    await collect(new FakeDisplaySource(displays("inner")));
    clear(device.deviceId);
    expect(observedIosDisplay(device, { pixelWidth: 1398, pixelHeight: 2034 }).key).toBe("primary");
  }
});

test("active display bounds reuse the existing point-size panel matcher", async () => {
  const listing = displays("inner").map((display) => ({ ...display, nativeSize: undefined }));
  const result = await collect(new FakeDisplaySource(listing));
  expect(result.display).toMatchObject({ key: "primary-1", role: "inner", posture: "opened" });
  expect(result.screenSize).toEqual({ width: 669, height: 951 });
});
