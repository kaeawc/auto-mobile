import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PooledDevice } from "../../src/daemon/devicePoolTypes";
import type { BootedDevice } from "../../src/models";
import {
  HeldDeviceFormFactorResolver,
  sessionlessDeviceReadFor,
} from "../../src/server/deviceObservationAccess";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import type { AvdConfigReader } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAvdConfigReader } from "../fakes/FakeAvdConfigReader";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";

const emulator: BootedDevice = {
  deviceId: "emulator-5620",
  name: "mtwear-api37",
  platform: "android",
};

function heldEmulator(): PooledDevice {
  return {
    id: emulator.deviceId,
    name: emulator.name,
    platform: "android",
    sessionId: "held-session",
    status: "busy",
    lastUsedAt: 0,
    assignmentCount: 1,
    errorCount: 0,
    incarnation: 1,
  };
}

test("unpooled emulator is enriched from watch config without mutating readiness", async () => {
  const timer = new FakeTimer();
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const resolver = new HeldDeviceFormFactorResolver(reader, timer);

  expect(await resolver.enrichUnpooled(emulator)).toEqual({ ...emulator, formFactor: "watch" });
  expect(emulator).not.toHaveProperty("formFactor");
  expect(reader.readConfigCalls).toEqual([emulator.name]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("unpooled hung config returns readiness unchanged at the default deadline", async () => {
  const timer = new FakeTimer();
  const reader: AvdConfigReader = { readConfig: () => new Promise(() => {}) };
  const resolver = new HeldDeviceFormFactorResolver(reader, timer);
  const result = resolver.enrichUnpooled(emulator);

  expect(timer.getPendingTimeouts()).toEqual([2000]);
  timer.advanceTime(1999);
  expect(timer.getPendingTimeoutCount()).toBe(1);
  timer.advanceTime(1);
  expect(await result).toBe(emulator);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test.each([
  { ...emulator, formFactor: "phone" as const },
  { ...emulator, formFactor: "watch" as const },
  { ...emulator, deviceId: "physical-usb" },
  { ...emulator, deviceId: "127.0.0.1:5555" },
  { ...emulator, platform: "ios" as const },
])("unpooled ineligible device is unchanged without reading config: %j", async (device) => {
  const timer = new FakeTimer();
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const resolver = new HeldDeviceFormFactorResolver(reader, timer);

  expect(await resolver.enrichUnpooled(device)).toBe(device);
  expect(reader.readConfigCalls).toEqual([]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("unpooled device without an injected config reader is unchanged", async () => {
  const timer = new FakeTimer();
  const resolver = new HeldDeviceFormFactorResolver(undefined, timer);
  expect(await resolver.enrichUnpooled(emulator)).toBe(emulator);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("held-session hung config read returns without form factor at the default deadline", async () => {
  const timer = new FakeTimer();
  const reader: AvdConfigReader = { readConfig: () => new Promise(() => {}) };
  const resolver = new HeldDeviceFormFactorResolver(reader, timer);
  const result = resolver.enrich(emulator, heldEmulator());

  expect(timer.getPendingTimeouts()).toEqual([2000]);
  timer.advanceTime(2000);
  expect(await result).toBe(emulator);
  expect(await result).not.toHaveProperty("formFactor");
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("held-session retries timed-out config once and caches the successful watch result", async () => {
  const timer = new FakeTimer();
  const watch = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const readConfig = mock<AvdConfigReader["readConfig"]>(() => new Promise(() => {}));
  const resolver = new HeldDeviceFormFactorResolver({ readConfig }, timer, 25);
  const pooled = heldEmulator();
  const first = resolver.enrich(emulator, pooled);
  const concurrent = resolver.enrich(emulator, pooled);

  expect(readConfig).toHaveBeenCalledTimes(1);
  expect(timer.getPendingTimeouts()).toEqual([25]);
  timer.advanceTime(25);
  expect(await first).not.toHaveProperty("formFactor");
  expect(await concurrent).not.toHaveProperty("formFactor");

  readConfig.mockImplementation((name) => watch.readConfig(name));
  expect((await resolver.enrich(emulator, pooled)).formFactor).toBe("watch");
  expect((await resolver.enrich(emulator, pooled)).formFactor).toBe("watch");
  expect(readConfig).toHaveBeenCalledTimes(2);
  expect(watch.readConfigCalls).toEqual([emulator.name]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

function readAccess(device: BootedDevice, avdConfigReader: AvdConfigReader, withStatus = false) {
  return sessionlessDeviceReadFor({
    listBooted: async () => [device],
    ...(withStatus
      ? {
          listBootedWithStatus: async () => ({
            devices: [device],
            scanned: { android: true, ios: true, watchos: false, tvos: false, visionos: false },
          }),
        }
      : {}),
    isAuthorized: () => true,
    avdConfigReader,
  });
}

async function observe(device: BootedDevice) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(
    "shell dumpsys display",
    createExecResult(
      readFileSync(
        new URL("../fixtures/wear-os/dumpsys-display-captured-round.txt", import.meta.url),
        "utf8",
      ),
      "",
    ),
  );
  const timer = new FakeTimer();
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(adb),
    {
      deviceReadOnly: true,
      screenshot: {
        execute: async () => ({ success: false, error: "Screenshot unavailable in fixture" }),
        generateScreenshotPath: () => "/fake/round-read.png",
        getActivityHash: async () => "",
      },
      hierarchyCapture: {
        capture: async () => ({
          captureId: "round-read",
          platform: "android",
          requestedFreshness: "fresh",
          receivedAt: 0,
          hierarchy: loadAndroidHomeObserve().observe.viewHierarchy!,
          nodes: [],
        }),
      },
    },
    { timer },
  );
  const result = await screen.executeDeviceRead();
  return { result, commands: adb.getExecutedCommands() };
}

test.each([false, true])(
  "sessionless watch config reaches observe (status listing: %s)",
  async (status) => {
    const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
    const access = readAccess(emulator, reader, status);
    const device = await access.resolve(emulator.deviceId);
    expect(device.formFactor).toBe("watch");
    expect((await access.findRunning(emulator.deviceId))?.formFactor).toBe("watch");
    expect(emulator).not.toHaveProperty("formFactor");
    expect(reader.readConfigCalls).toEqual(["mtwear-api37", "mtwear-api37"]);
    const { result, commands } = await observe(device);
    expect(result.isScreenRound).toBe(true);
    expect(commands).toEqual(["shell dumpsys activity activities", "shell dumpsys display"]);
  },
);

test("phone config enriches without extra adb commands", async () => {
  const reader = new FakeAvdConfigReader({
    deviceName: "pixel_6",
    screenWidth: 1080,
    screenHeight: 2400,
    screenDensity: 420,
  });
  const device = await readAccess(emulator, reader).resolve(emulator.deviceId);
  expect(device.formFactor).toBe("phone");
  const { result, commands } = await observe(device);
  expect(result).not.toHaveProperty("isScreenRound");
  expect(commands).toEqual(["shell dumpsys activity activities"]);
});

test.each(["missing", "throws", "unknown"] as const)(
  "%s config leaves form factor and roundness absent",
  async (mode) => {
    const reader: AvdConfigReader =
      mode === "throws"
        ? {
            readConfig: async () => {
              throw new Error("unreadable config");
            },
          }
        : new FakeAvdConfigReader(mode === "unknown" ? { deviceName: "unrecognized" } : null);
    const device = await readAccess(emulator, reader).resolve(emulator.deviceId);
    expect(device).not.toHaveProperty("formFactor");
    const { result, commands } = await observe(device);
    expect(result).not.toHaveProperty("isScreenRound");
    // An unclassified device is asked once whether it is an XR headset (#17908).
    expect(commands).toEqual([
      "shell pm has-feature android.software.xr.api.spatial",
      "shell dumpsys activity activities",
    ]);
  },
);

test.each([
  { ...emulator, deviceId: "physical-usb" },
  { ...emulator, deviceId: "127.0.0.1:5555" },
  { ...emulator, platform: "ios" as const },
  { ...emulator, name: "" },
  { ...emulator, name: emulator.deviceId },
  { ...emulator, name: `Unknown (${emulator.deviceId})` },
  { ...emulator, formFactor: "phone" as const },
])("does not read config for ineligible device %j", async (input) => {
  const reader = new FakeAvdConfigReader({ deviceName: "wearos_small_round" });
  const resolved = await readAccess(input, reader).resolve(
    input.deviceId,
    undefined,
    input.platform,
  );
  expect(resolved).toEqual(input);
  expect(reader.readConfigCalls).toEqual([]);
});
