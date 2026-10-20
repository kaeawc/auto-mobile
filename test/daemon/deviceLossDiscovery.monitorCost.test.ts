import { beforeEach, describe, expect, test } from "bun:test";
import {
  discoverAndReconcile,
  type DeviceLossDiscoveryPool,
} from "../../src/daemon/deviceLossDiscovery";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
} from "../../src/devices/deviceUtils";
import { evaluateDeviceDisconnects } from "../../src/daemon/disconnectMonitor";
import type { BootedDevice } from "../../src/models";
import type { DiscoverySource } from "../../src/utils/discoverySource";
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

type MonitorDeviceManager = Pick<MultiPlatformDeviceManager, "getBootedDevicesDetailed">;

/** Models command completion just after a tick, keeping the next tick inside the TTL. */
class CachedMonitorDeviceManager implements MonitorDeviceManager {
  snapshotId = 0;
  present = false;
  failed = false;
  bypasses = 0;
  readonly requests: BootedDeviceDiscoveryOptions[] = [];
  private expiresAt = 0;
  private cached: BootedDeviceDiscovery | undefined;

  constructor(
    readonly device: BootedDevice,
    private readonly source: DiscoverySource,
    private readonly timer: FakeTimer,
  ) {}

  async getBootedDevicesDetailed(
    _platform: Parameters<MonitorDeviceManager["getBootedDevicesDetailed"]>[0],
    options: BootedDeviceDiscoveryOptions = {},
  ): Promise<BootedDeviceDiscovery> {
    this.requests.push(options);
    const bypass =
      this.source === "android"
        ? options.bypassAndroidDeviceListCache
        : this.source === "ios-simulator"
          ? options.bypassIosDeviceListCache
          : options.bypassPhysicalIosDeviceListCache;
    if (bypass) {
      this.bypasses++;
    }
    if (!bypass && this.cached && this.timer.now() < this.expiresAt) {
      return this.cached;
    }
    if (this.failed) {
      return { devices: [], succeededPlatforms: new Set(), succeededSources: new Set() };
    }
    this.snapshotId++;
    this.expiresAt = this.timer.now() + 5_001;
    this.cached = {
      devices: this.present ? [this.device] : [],
      succeededPlatforms: new Set([this.device.platform]),
      succeededSources: new Set([this.source]),
    };
    return this.cached;
  }
}

function missingMonitorHarness(device: BootedDevice, source: DiscoverySource, heldOnly = false) {
  const timer = new FakeTimer();
  const manager = new CachedMonitorDeviceManager(device, source, timer);
  const misses = new Map<string, number>();
  const countedSnapshots = new Set<number>();
  const pool = poolFor(heldOnly ? [] : [device]);
  const sweep = async (planActive = false) => {
    timer.advanceTime(5_000);
    const discovery = await discoverAndReconcile(pool, manager, {
      planActive,
      heldDevices: heldOnly ? [{ platform: device.platform, assignedDevice: device.deviceId }] : [],
    });
    if (discovery.succeededSources?.has(source) && discovery.devices.length === 0) {
      countedSnapshots.add(manager.snapshotId);
    }
    return evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds: new Set(discovery.devices.map(({ deviceId }) => deviceId)),
      candidateDeviceIds: new Set([device.deviceId]),
      candidatePlatforms: new Map([[device.deviceId, device.platform]]),
      succeededPlatforms: discovery.succeededPlatforms,
      succeededSources: discovery.succeededSources,
    });
  };
  return { timer, manager, pool, misses, countedSnapshots, sweep };
}

const MISSING_CASES: Array<[BootedDevice, DiscoverySource]> = [
  [{ platform: "android", deviceId: "emulator-5554", name: "Pixel" }, "android"],
  [SIM, "ios-simulator"],
  [PHONE, "ios-physical"],
];

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

  test.each(MISSING_CASES)(
    "fake %j listing repeats snapshots on alternate ticks",
    async (device, source) => {
      const { timer, manager } = missingMonitorHarness(device, source);
      const snapshots: number[] = [];
      for (let tick = 0; tick < 5; tick++) {
        timer.advanceTime(5_000);
        await manager.getBootedDevicesDetailed("either");
        snapshots.push(manager.snapshotId);
      }
      expect(snapshots).toEqual([1, 1, 2, 2, 3]);
    },
  );

  test.each(MISSING_CASES)(
    "%j requires three DISTINCT missing snapshots",
    async (device, source) => {
      const h = missingMonitorHarness(device, source);
      let confirmed = false;
      for (let tick = 0; tick < 5 && !confirmed; tick++) {
        const result = await h.sweep();
        expect(result.disconnected).toEqual(h.countedSnapshots.size < 3 ? [] : [device.deviceId]);
        confirmed = result.disconnected.length > 0;
      }
      expect(confirmed).toBe(true);
      expect(h.countedSnapshots.size).toBe(3);
      expect(h.misses.get(device.deviceId)).toBe(3);
      const confirmation = h.manager.requests.at(-1);
      expect(confirmation?.bypassAndroidDeviceListCache).toBe(source === "android");
      expect(confirmation?.bypassIosDeviceListCache).toBe(source === "ios-simulator");
      expect(confirmation?.bypassPhysicalIosDeviceListCache).toBe(source === "ios-physical");
    },
  );

  test.each(MISSING_CASES)(
    "%j fresh failure holds and fresh presence resets",
    async (device, source) => {
      const h = missingMonitorHarness(device, source, true);
      await h.sweep();
      await h.sweep();
      expect(h.misses.get(device.deviceId)).toBe(2);
      // The cheap read still replays absence; the requested fresh confirmation fails.
      h.manager.failed = true;
      expect((await h.sweep()).disconnected).toEqual([]);
      expect(h.misses.get(device.deviceId)).toBe(2);
      h.manager.failed = false;
      h.manager.present = true;
      expect((await h.sweep()).disconnected).toEqual([]);
      expect(h.misses.has(device.deviceId)).toBe(false);
    },
  );

  test.each(MISSING_CASES)(
    "%j healthy tracked sweeps never bypass caches",
    async (device, source) => {
      const h = missingMonitorHarness(device, source);
      h.manager.present = true;
      for (let tick = 0; tick < 6; tick++) {
        await h.sweep();
      }
      expect(h.manager.bypasses).toBe(0);
    },
  );

  test.each(MISSING_CASES)(
    "%j plan-time polling keeps its cheap capped evidence and never reconciles membership",
    async (device, source) => {
      const h = missingMonitorHarness(device, source);
      let reconciliations = 0;
      h.pool.reconcileDiscoveryObservation = async () => {
        reconciliations++;
      };
      await h.sweep(true);
      expect(h.manager.bypasses).toBe(0);
      expect(reconciliations).toBe(0);
    },
  );

  test("an explicitly fresh Android sweep needs no second listing", async () => {
    const device = MISSING_CASES[0][0];
    const h = missingMonitorHarness(device, "android");
    await discoverAndReconcile(h.pool, h.manager, {
      planActive: true,
      platform: "android",
      bypassAndroidDeviceListCache: true,
    });
    expect(h.manager.requests).toHaveLength(1);
  });

  test("six simulator-only monitor sweeps never ask devicectl", async () => {
    const rig = managerWithPhysicalCounter();
    for (let tick = 0; tick < 6; tick++) {
      await discoverAndReconcile(poolFor([SIM]), rig.manager, { planActive: false });
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
      await discoverAndReconcile(poolFor([SIM]), rig.manager, { planActive: false });
      const result = await discoverAndReconcile(
        poolFor(trackedBy === "pool" ? [PHONE] : [SIM]),
        rig.manager,
        {
          planActive: false,
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
      await discoverAndReconcile(pool, manager, { planActive: false, platform: "android" });
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
