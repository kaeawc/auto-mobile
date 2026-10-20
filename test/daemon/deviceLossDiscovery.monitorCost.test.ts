import { beforeEach, describe, expect, test } from "bun:test";
import {
  discoverAndReconcile,
  type DeviceLossDiscoveryPool,
} from "../../src/daemon/deviceLossDiscovery";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice } from "../../src/models";
import {
  DefaultAndroidDeviceInventoryScanner,
  resetAndroidInventoryEnrichmentCache,
} from "../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { createPooledDevice } from "./helpers/DaemonDisconnectHarness";

const PHONE: BootedDevice = {
  platform: "ios",
  deviceId: "00008130-000A1B2C3D4E5F60",
  name: "Phone",
};
const SIM: BootedDevice = {
  platform: "ios",
  deviceId: "1E2A3B4C-5D6E-4F70-8192-A3B4C5D6E7F8",
  name: "Simulator",
};

function poolFor(devices: BootedDevice[] = []): DeviceLossDiscoveryPool {
  return {
    getAllDevices: () =>
      devices.map((device) => createPooledDevice(device.deviceId, { platform: device.platform })),
    getAndroidTransportAliases: () => [],
    mapAndroidDiscovery: (devices) => devices.slice(),
    normalizeAndroidDiscovery: async (devices) => devices.slice(),
    reconcileDiscoveryObservation: async () => {},
  };
}

function managerWithPhysicalCounter() {
  let physicalCalls = 0;
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl({
      isAvailable: async () => true,
      getBootedSimulatorsChecked: async () => [SIM],
    }),
    createFakeAndroidEmulator({ getBootedDevicesChecked: async () => [] }),
    undefined,
    undefined,
    {
      listConnectedDevices: async () => {
        physicalCalls++;
        return { devices: [PHONE], complete: true };
      },
    },
  );
  return { manager, calls: () => physicalCalls };
}

describe("deviceLossDiscovery monitor cost", () => {
  beforeEach(() => resetAndroidInventoryEnrichmentCache());

  test("reconciles other devices while plan observations remain presence-only", async () => {
    const rig = managerWithPhysicalCounter();
    const pool = poolFor([SIM, PHONE]);
    const reconciled: string[][] = [];
    pool.reconcileDiscoveryObservation = async (devices) => {
      reconciled.push(devices.map((device) => device.deviceId));
    };
    const discovery = await discoverAndReconcile(pool, rig.manager, {
      isPlanDevice: (id) => id === SIM.deviceId,
    });
    expect(reconciled).toEqual([[PHONE.deviceId]]);
    expect(discovery.devices).toContainEqual(SIM);
    expect(discovery.devices).toContainEqual(PHONE);
  });

  test("six simulator-only monitor sweeps never ask devicectl", async () => {
    const rig = managerWithPhysicalCounter();
    for (let tick = 0; tick < 6; tick++) {
      await discoverAndReconcile(poolFor([SIM]), rig.manager, {});
    }
    expect(rig.calls()).toBe(0);
    // Allocation/default discovery still includes physical devices.
    const allocation = await rig.manager.getBootedDevicesDetailed("either");
    expect(rig.calls()).toBe(1);
    expect(allocation.devices).toContainEqual(PHONE);
  });

  test.each(["pool", "held"])(
    "a physical iOS device in the %s keeps physical-source liveness",
    async (trackedBy) => {
      const rig = managerWithPhysicalCounter();
      await discoverAndReconcile(poolFor([SIM]), rig.manager, {});
      const result = await discoverAndReconcile(
        poolFor(trackedBy === "pool" ? [PHONE] : [SIM]),
        rig.manager,
        {
          heldDevices:
            trackedBy === "held" ? [{ platform: "ios", assignedDevice: PHONE.deviceId }] : [],
        },
      );
      expect(rig.calls()).toBe(1);
      expect(result.devices).toContainEqual(PHONE);
      expect(result.succeededSources?.has("ios-physical")).toBe(true);
    },
  );

  test("six monitor sweeps retain AVD identity without display, model or profile work", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbClient();
    const devices: BootedDevice[] = [
      { platform: "android", deviceId: "emulator-5554", name: "emulator-5554", observedAt: 1 },
      { platform: "android", deviceId: "R58M123ABC", name: "R58M123ABC", observedAt: 1 },
    ];
    adb.setDevices(devices);
    let avdNames = 0;
    let profiles = 0;
    const scanner = new DefaultAndroidDeviceInventoryScanner({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(adb),
      observationSequence: () => ({ next: () => 1 }),
      avdConfigReader: () => ({
        readConfig: async () => {
          profiles++;
          return null;
        },
      }),
      getRunningAvdName: async () => {
        avdNames++;
        return { name: "Pixel_9" };
      },
      isUnknownEmulatorName: (name, id) => name === `Unknown (${id})`,
      unknownEmulatorName: (id) => `Unknown (${id})`,
      throwIfAborted: () => {},
    });
    const manager = new MultiPlatformDeviceManager(
      adb,
      fakeDeviceManagerSimctl(),
      createFakeAndroidEmulator({
        getBootedDevicesChecked: async (onlyEmulators, options, signal) =>
          (await scanner.getBootedDevicesWithDiagnostics(onlyEmulators, options, signal)).devices,
      }),
    );
    const reconciled: BootedDevice[][] = [];
    const pool = poolFor();
    pool.reconcileDiscoveryObservation = async (observations) => {
      reconciled.push(observations.slice());
    };
    for (let tick = 0; tick < 6; tick++) {
      timer.advanceTime(5_000);
      await discoverAndReconcile(pool, manager, { platform: "android" });
    }
    expect(reconciled).toHaveLength(6);
    expect(reconciled[5].map(({ deviceId, name }) => ({ deviceId, name }))).toEqual([
      { deviceId: "emulator-5554", name: "Pixel_9" },
      { deviceId: "R58M123ABC", name: "R58M123ABC" },
    ]);
    expect(avdNames).toBe(6); // Reconciliation uses this to catch serial reuse.
    expect({ profiles, adbCommands: adb.getInteractionLog().length }).toEqual({
      profiles: 0,
      adbCommands: 0,
    });
  });
});
