import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { FakeAppleTvSimctl } from "../fakes/FakeAppleTvSimctl";
import { describe, expect } from "bun:test";
import fixtureJson from "../fixtures/ios-simctl/list-all-visionos-26-5.json";
import { ActionableError, type BootedDevice, type DeviceInfo } from "../../src/models";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { AppleVisionSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import { FakeAppleVisionSimctl } from "../fakes/FakeAppleVisionSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { restartStopHarness } from "../helpers/restartStopHarness";
import { toolJson } from "../helpers/toolResponse";
import {
  DEVICE_SHUTDOWN_TIMEOUT_MS,
  isShutdownTimeoutError,
  resolveKillDeviceStableTarget,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { createKillDeviceResponse } from "../../src/server/deviceToolsShutdown";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createLifecycleHandlers } from "../../src/server/deviceToolsLifecycle";
import { FakeTimer } from "../fakes/FakeTimer";

const runtimeId = "com.apple.CoreSimulator.SimRuntime.xrOS-26-5";
const capturedVision = fixtureJson.devices[runtimeId][0];
const labelledIos: BootedDevice = {
  platform: "ios",
  name: capturedVision.name,
  deviceId: capturedVision.udid,
};
function host(ios: DeviceInfo[] = []) {
  const headset = new FakeAppleVisionSimctl();
  headset.listing = structuredClone(fixtureJson);
  const killed: BootedDevice[] = [];
  const reads = { ios: 0 };
  const timer = new FakeTimer();
  const simctl = fakeDeviceManagerSimctl({
    listSimulatorImages: async () => {
      reads.ios++;
      return ios;
    },
    killSimulator: async (device) => {
      killed.push(device);
    },
  });
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    simctl,
    createFakeAndroidEmulator(),
    { timer },
  )
    .withAppleVisionSimulators(new AppleVisionSimulatorInventory(headset, "arm64"))
    .withAppleTvSimulators(new AppleTvSimulatorInventory(new FakeAppleTvSimctl()));
  return { headset, killed, reads, manager, timer, simctl };
}

describe("Apple Vision Pro killDevice routing", () => {
  const { test } = restartStopHarness();
  test("a listed iOS simulator keeps its fast path without reading Apple Vision Pros", async () => {
    const h = host([{ ...labelledIos, isRunning: true }]);
    h.headset.listingError = new Error("must not read headsets");
    await h.manager.killDevice(labelledIos);
    expect(h.killed).toEqual([labelledIos]);
    expect(h.reads.ios).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
  test("a physical iOS UDID bypasses simulator inventory", async () => {
    const h = host();
    h.headset.listingError = new Error("must not read headsets");
    const physical = { ...labelledIos, deviceId: "00008110-001234567890001E" };
    expect(await h.manager.resolveKillDeviceTarget(physical)).toEqual(physical);
    expect(h.reads.ios).toBe(0);
  });
  test("an explicitly identified Vision Pro never reads an iOS inventory before shutdown", async () => {
    const h = host();
    const device = { ...labelledIos, platform: "visionos" } as const;
    await h.manager.killDevice(device);
    expect(h.killed).toEqual([device]);
    expect(h.reads.ios).toBe(0);
  });
  test("an Apple Vision Pro UDID supplied as ios is shut down as visionos", async () => {
    const h = host();
    await h.manager.killDevice(labelledIos);
    expect(h.killed).toEqual([{ ...labelledIos, platform: "visionos" }]);
    expect(resolveKillDeviceStableTarget(h.killed[0], undefined)).toEqual({
      platform: "visionos",
      stableId: labelledIos.deviceId,
    });
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
  test("a UDID absent from both listings retains the existing iOS path", async () => {
    const h = host();
    h.headset.listing = { devices: {} };
    await h.manager.killDevice(labelledIos);
    expect(h.killed).toEqual([labelledIos]);
  });
  test("a failed Apple Vision Pro inventory fails closed before shutdown", async () => {
    const h = host();
    h.headset.listingError = new Error("simctl failed");
    await expect(h.manager.killDevice(labelledIos)).rejects.toBeInstanceOf(ActionableError);
    expect(h.killed).toEqual([]);
  });
  test("missing Apple Vision Pro inventory fails closed", async () => {
    const killed: BootedDevice[] = [];
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      fakeDeviceManagerSimctl({
        listSimulatorImages: async () => [],
        killSimulator: async (device) => {
          killed.push(device);
        },
      }),
      createFakeAndroidEmulator(),
    );
    await expect(manager.killDevice(labelledIos)).rejects.toThrow(
      "Refresh the simulator inventory and retry",
    );
    expect(killed).toEqual([]);
  });
  test("a failed iOS listing also fails closed", async () => {
    const killed: BootedDevice[] = [];
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      fakeDeviceManagerSimctl({
        listSimulatorImages: async () => {
          throw new Error("iOS listing failed");
        },
        killSimulator: async (device) => {
          killed.push(device);
        },
      }),
      createFakeAndroidEmulator(),
    );
    await expect(manager.killDevice(labelledIos)).rejects.toBeInstanceOf(ActionableError);
    expect(killed).toEqual([]);
  });
  test("a hung iOS listing times out within the shutdown budget", async () => {
    const h = host();
    const signals: (AbortSignal | undefined)[] = [];
    h.simctl.listSimulatorImages = (_options, operationOptions) => {
      signals.push(operationOptions?.signal);
      return new Promise<DeviceInfo[]>(() => {});
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => h.manager,
      timer: h.timer,
    });
    const pending = createLifecycleHandlers().killDeviceHandler({ device: labelledIos });
    const failure = pending.catch((error: unknown) => error);
    await Promise.resolve();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(h.timer.getPendingTimeouts()).toEqual([DEVICE_SHUTDOWN_TIMEOUT_MS]);

    h.timer.advanceTime(DEVICE_SHUTDOWN_TIMEOUT_MS);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(isShutdownTimeoutError(error)).toBe(true);
    if (!(error instanceof Error)) {
      throw new TypeError("Expected a shutdown timeout error");
    }
    expect(error.message).toContain("to resolve platform");
    expect(signals[0]?.aborted).toBe(true);
    expect(h.killed).toEqual([]);
  });
  test("the handler admits, shuts down and labels a mislabelled Apple Vision Pro as visionos", async () => {
    const h = host();
    const killed: BootedDevice[] = [];
    const manager = Object.assign(new FakeDeviceUtils(), {
      resolveKillDeviceTarget: h.manager.resolveKillDeviceTarget.bind(h.manager),
      killDevice: async (device: BootedDevice) => {
        killed.push(device);
        manager.setBootedDevices("visionos", []);
      },
    });
    manager.setBootedDevices("visionos", [{ ...labelledIos, platform: "visionos" }]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      timer: h.timer,
      stopPerformanceMonitoring: () => {},
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    const result = await createLifecycleHandlers().killDeviceHandler({ device: labelledIos });
    expect(toolJson(result)).toMatchObject({
      platform: "visionos",
      message: `visionos '${labelledIos.name}' shutdown successfully`,
    });
    expect(killed).toEqual([{ ...labelledIos, platform: "visionos" }]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
  test("an already stopped Apple Vision Pro has a successful visionos label", () => {
    expect(
      toolJson(
        createKillDeviceResponse(
          { device: { ...labelledIos, platform: "visionos" } },
          {},
          "already stopped",
        ),
      ),
    ).toMatchObject({
      platform: "visionos",
      message: `visionos '${labelledIos.name}' already shut down`,
    });
  });
});
