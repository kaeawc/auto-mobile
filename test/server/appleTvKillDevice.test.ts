import { describe, expect } from "bun:test";
import fixtureJson from "../fixtures/ios-simctl/list-all-appletv-26-5.json";
import { ActionableError, type BootedDevice, type DeviceInfo } from "../../src/models";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { FakeAppleTvSimctl } from "../fakes/FakeAppleTvSimctl";
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

const runtimeId = "com.apple.CoreSimulator.SimRuntime.tvOS-26-5";
const capturedTv = fixtureJson.devices[runtimeId][0];
const labelledIos: BootedDevice = {
  platform: "ios",
  name: capturedTv.name,
  deviceId: capturedTv.udid,
};
function host(ios: DeviceInfo[] = []) {
  const tv = new FakeAppleTvSimctl();
  tv.listing = structuredClone(fixtureJson);
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
  ).withAppleTvSimulators(new AppleTvSimulatorInventory(tv, "arm64"));
  return { tv, killed, reads, manager, timer, simctl };
}

describe("Apple TV killDevice routing", () => {
  const { test } = restartStopHarness();
  test("a listed iOS simulator keeps its fast path without reading Apple TVs", async () => {
    const h = host([{ ...labelledIos, isRunning: true }]);
    h.tv.listingError = new Error("must not read TVs");
    await h.manager.killDevice(labelledIos);
    expect(h.killed).toEqual([labelledIos]);
    expect(h.reads.ios).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
  test("a physical iOS UDID bypasses simulator inventory", async () => {
    const h = host();
    h.tv.listingError = new Error("must not read TVs");
    const physical = { ...labelledIos, deviceId: "00008110-001234567890001E" };
    expect(await h.manager.resolveKillDeviceTarget(physical)).toEqual(physical);
    expect(h.reads.ios).toBe(0);
  });
  test("an Apple TV UDID supplied as ios is shut down as tvos", async () => {
    const h = host();
    await h.manager.killDevice(labelledIos);
    expect(h.killed).toEqual([{ ...labelledIos, platform: "tvos" }]);
    expect(resolveKillDeviceStableTarget(h.killed[0], undefined)).toEqual({
      platform: "tvos",
      stableId: labelledIos.deviceId,
    });
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
  test("a UDID absent from both listings retains the existing iOS path", async () => {
    const h = host();
    h.tv.listing = { devices: {} };
    await h.manager.killDevice(labelledIos);
    expect(h.killed).toEqual([labelledIos]);
  });
  test("a failed Apple TV inventory fails closed before shutdown", async () => {
    const h = host();
    h.tv.listingError = new Error("simctl failed");
    await expect(h.manager.killDevice(labelledIos)).rejects.toBeInstanceOf(ActionableError);
    expect(h.killed).toEqual([]);
  });
  test("missing Apple TV inventory fails closed", async () => {
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
  test("the handler admits, shuts down and labels a mislabelled Apple TV as tvos", async () => {
    const h = host();
    const killed: BootedDevice[] = [];
    const manager = Object.assign(new FakeDeviceUtils(), {
      resolveKillDeviceTarget: h.manager.resolveKillDeviceTarget.bind(h.manager),
      killDevice: async (device: BootedDevice) => {
        killed.push(device);
        manager.setBootedDevices("tvos", []);
      },
    });
    manager.setBootedDevices("tvos", [{ ...labelledIos, platform: "tvos" }]);
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
      platform: "tvos",
      message: `tvos '${labelledIos.name}' shutdown successfully`,
    });
    expect(killed).toEqual([{ ...labelledIos, platform: "tvos" }]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
  test("an already stopped Apple TV has a successful tvos label", () => {
    expect(
      toolJson(
        createKillDeviceResponse(
          { device: { ...labelledIos, platform: "tvos" } },
          {},
          "already stopped",
        ),
      ),
    ).toMatchObject({ platform: "tvos", message: `tvos '${labelledIos.name}' already shut down` });
  });
});
