import { beforeEach, describe, expect, test } from "bun:test";
import {
  discoverAndReconcile,
  logDisconnectMisses,
  PLAN_DEVICE_DISCONNECT_MISS_CAP,
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
import { DeviceLossMisses } from "../../src/daemon/deviceLossMisses";

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
  const misses = new DeviceLossMisses();
  const countedSnapshots = new Set<number>();
  const pool = poolFor(heldOnly ? [] : [device]);
  const sweep = async (planActive = false) => {
    timer.advanceTime(5_000);
    const discovery = await discoverAndReconcile(pool, manager, {
      iosDeviceListMaxAgeMs: 15_000,
      isPlanDevice: (id) => planActive && id === device.deviceId,
      heldDevices: heldOnly ? [{ platform: device.platform, assignedDevice: device.deviceId }] : [],
    });
    if (discovery.succeededSources?.has(source) && discovery.devices.length === 0) {
      countedSnapshots.add(manager.snapshotId);
    }
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds: new Set(discovery.devices.map(({ deviceId }) => deviceId)),
      candidateDeviceIds: new Set([device.deviceId]),
      candidatePlatforms: new Map([[device.deviceId, device.platform]]),
      succeededPlatforms: discovery.succeededPlatforms,
      succeededSources: discovery.succeededSources,
    });
    logDisconnectMisses(
      misses,
      result,
      new Set(planActive ? [device.deviceId] : []),
      new Set(discovery.devices.map(({ deviceId }) => deviceId)),
    );
    return result;
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
    {
      physicalIosDevices: {
        listConnectedDevices: async () => {
          physicalCalls++;
          return { devices: [PHONE], complete: true };
        },
      },
    },
  );
  return { manager, calls: () => physicalCalls };
}

describe("deviceLossDiscovery monitor cost", () => {
  beforeEach(() => resetAndroidInventoryEnrichmentCache());

  test("monitor cheap read allows a fifteen-second simulator snapshot; missing confirmation is fresh", async () => {
    const h = missingMonitorHarness(SIM, "ios-simulator");
    await h.sweep();
    expect(h.manager.requests).toHaveLength(2);
    expect(h.manager.requests[0]).toMatchObject({ iosDeviceListMaxAgeMs: 15_000 });
    expect(h.manager.requests[0]?.bypassIosDeviceListCache).toBeUndefined();
    expect(h.manager.requests[1]?.bypassIosDeviceListCache).toBe(true);
    expect(h.manager.requests[1]).not.toHaveProperty("iosDeviceListMaxAgeMs");
  });

  test.each([undefined, 15_000])(
    "transitional listings refresh only with max age %s, reusing missing confirmation",
    async (iosDeviceListMaxAgeMs) => {
      for (const tracked of [false, true]) {
        const requests: BootedDeviceDiscoveryOptions[] = [];
        const manager: MonitorDeviceManager = {
          getBootedDevicesDetailed: async (_platform, options = {}) => {
            requests.push(options);
            return {
              devices: options.bypassIosDeviceListCache ? [SIM] : [],
              transitionalSimulators: options.bypassIosDeviceListCache
                ? []
                : [{ device: SIM, state: "Booting" }],
              succeededPlatforms: new Set(["ios"]),
              succeededSources: new Set(["ios-simulator"]),
            };
          },
        };
        const discovery = await discoverAndReconcile(poolFor(tracked ? [SIM] : []), manager, {
          iosDeviceListMaxAgeMs,
        });
        const refresh = tracked || iosDeviceListMaxAgeMs !== undefined;
        expect(requests).toHaveLength(refresh ? 2 : 1);
        if (refresh) {
          expect(requests[1]?.bypassIosDeviceListCache).toBe(true);
          expect(requests[1]).not.toHaveProperty("iosDeviceListMaxAgeMs");
          expect(discovery.devices).toEqual([SIM]);
          expect(discovery.transitionalSimulators).toEqual([]);
        }
      }
    },
  );

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
      for (let tick = 0; tick < 5; tick++) {
        expect((await h.sweep(true)).disconnected).toEqual([]);
        expect(h.misses.get(device.deviceId)).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
      }
      expect(h.manager.bypasses).toBe(0);
      expect(reconciliations).toBe(0);
    },
  );

  test.each([false, true])(
    "an explicitly fresh Android sweep needs no second listing (plan=%s)",
    async (planActive) => {
      const device = MISSING_CASES[0][0];
      const h = missingMonitorHarness(device, "android");
      await discoverAndReconcile(h.pool, h.manager, {
        isPlanDevice: (id) => planActive && id === device.deviceId,
        platform: "android",
        bypassAndroidDeviceListCache: true,
      });
      expect(h.manager.requests).toHaveLength(1);
    },
  );

  test.each(MISSING_CASES)(
    "%j confirms non-plan absence beside a deferred device without double-counting",
    async (device, source) => {
      const h = missingMonitorHarness(device, source);
      const planned = { ...device, deviceId: `${device.deviceId.slice(0, -1)}1` };
      const pool = poolFor([device, planned]);
      const candidates = [device, planned];
      for (let tick = 0; tick < 3; tick++) {
        const discovery = await discoverAndReconcile(pool, h.manager, {
          isPlanDevice: (id) => id === planned.deviceId,
        });
        const bootedDeviceIds = new Set(discovery.devices.map(({ deviceId }) => deviceId));
        const result = evaluateDeviceDisconnects({
          deviceDisconnectMisses: h.misses,
          confirmedDisconnectedDeviceIds: new Set(),
          bootedDeviceIds,
          candidateDeviceIds: new Set(candidates.map(({ deviceId }) => deviceId)),
          candidatePlatforms: new Map(
            candidates.map(({ deviceId, platform }) => [deviceId, platform]),
          ),
          succeededPlatforms: discovery.succeededPlatforms,
          succeededSources: discovery.succeededSources,
        });
        logDisconnectMisses(h.misses, result, new Set([planned.deviceId]), bootedDeviceIds);
        expect(h.misses.get(device.deviceId)).toBe(tick + 1);
        expect(h.misses.get(planned.deviceId)).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
        expect(result.disconnected).toEqual(tick === 2 ? [device.deviceId] : []);
      }
      expect(h.manager.requests).toHaveLength(6);
      expect(h.manager.bypasses).toBe(3);
    },
  );

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
