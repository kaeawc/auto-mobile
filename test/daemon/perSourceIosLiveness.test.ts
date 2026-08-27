import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { evaluateDeviceDisconnects } from "../../src/daemon/disconnectMonitor";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice, Platform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Issue #5683: iOS has two independent discovery sources behind one platform
 * flag. `simctl` lists booted simulators; `devicectl` lists connected physical
 * devices. Either can fail alone, and #5682 had to tie the single per-platform
 * flag to simctl — which left a devicectl-confirmed iPhone unassignable
 * whenever simctl blipped.
 *
 * These pin all four combinations of (simctl ok/failed) x (devicectl ok/failed)
 * with fakes only, so they hold on a host with no iOS tooling at all.
 */
const PHYSICAL_UDID = "00008130-000A1B2C3D4E5F60";
const SIMULATOR_UDID = "1E2A3B4C-5D6E-4F70-8192-A3B4C5D6E7F8";

const iosDevice = (deviceId: string, name: string): BootedDevice => ({
  name,
  platform: "ios",
  deviceId,
});

const PHYSICAL = iosDevice(PHYSICAL_UDID, "Jason's iPhone");
const SIMULATOR = iosDevice(SIMULATOR_UDID, "iPhone 16 Pro");

/**
 * The surface `MultiPlatformDeviceManager.getBootedDevicesDetailed` actually
 * calls on each injected client. Naming them keeps the fakes checked against a
 * real signature: the constructor takes the concrete classes, so the cast at
 * the boundary is unavoidable, but it now covers a declared shape rather than
 * an anonymous literal, and any drift in these two methods fails to compile.
 */
interface SimctlBootedDeviceSurface {
  isAvailable(): Promise<boolean>;
  getBootedSimulatorsChecked(): Promise<BootedDevice[]>;
}

interface EmulatorBootedDeviceSurface {
  getBootedDevicesChecked(): Promise<BootedDevice[]>;
}

class FakeBootedSimctl implements SimctlBootedDeviceSurface {
  constructor(private readonly simulators: BootedDevice[] | Error) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getBootedSimulatorsChecked(): Promise<BootedDevice[]> {
    if (this.simulators instanceof Error) {
      throw this.simulators;
    }
    return this.simulators;
  }
}

class FakeBootedEmulator implements EmulatorBootedDeviceSurface {
  async getBootedDevicesChecked(): Promise<BootedDevice[]> {
    return [];
  }
}

describe("MultiPlatformDeviceManager reports iOS completeness per source (#5683)", () => {
  const manager = (options: {
    simctlOk: boolean;
    devicectlOk: boolean;
    /** Mirrors `DevicectlDeviceLister` replaying its last-good listing. */
    retainedPhysical?: boolean;
  }): MultiPlatformDeviceManager =>
    new MultiPlatformDeviceManager(
      null,
      new FakeBootedSimctl(
        options.simctlOk ? [SIMULATOR] : new Error("simctl list devices failed"),
      ) as unknown as SimCtlClient,
      new FakeBootedEmulator() as unknown as AndroidEmulatorClient,
      undefined,
      undefined,
      {
        listConnectedDevices: async () =>
          options.devicectlOk
            ? { devices: [PHYSICAL], complete: true }
            : { devices: options.retainedPhysical ? [PHYSICAL] : [], complete: false },
      },
    );

  test("both sources succeed: every source is complete and both devices are reported", async () => {
    const discovery = await manager({ simctlOk: true, devicectlOk: true }).getBootedDevicesDetailed(
      "ios",
    );

    expect([...discovery.succeededSources!].sort()).toEqual(["ios-physical", "ios-simulator"]);
    expect(discovery.devices.map((device) => device.deviceId).sort()).toEqual(
      [PHYSICAL_UDID, SIMULATOR_UDID].sort(),
    );
  });

  test("simctl fails, devicectl succeeds: the physical source stays complete", async () => {
    const discovery = await manager({
      simctlOk: false,
      devicectlOk: true,
    }).getBootedDevicesDetailed("ios");

    expect(discovery.succeededSources!.has("ios-physical")).toBe(true);
    expect(discovery.succeededSources!.has("ios-simulator")).toBe(false);
    // The platform aggregate keeps its pre-#5683 simctl-only meaning.
    expect(discovery.succeededPlatforms.has("ios")).toBe(false);
    expect(discovery.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
  });

  test("devicectl fails, simctl succeeds: the simulator source stays complete", async () => {
    const discovery = await manager({
      simctlOk: true,
      devicectlOk: false,
    }).getBootedDevicesDetailed("ios");

    expect(discovery.succeededSources!.has("ios-simulator")).toBe(true);
    expect(discovery.succeededSources!.has("ios-physical")).toBe(false);
    expect(discovery.succeededPlatforms.has("ios")).toBe(true);
    expect(discovery.devices.map((device) => device.deviceId)).toEqual([SIMULATOR_UDID]);
  });

  test("a retained physical listing is reported without marking its source complete", async () => {
    const discovery = await manager({
      simctlOk: true,
      devicectlOk: false,
      retainedPhysical: true,
    }).getBootedDevicesDetailed("ios");

    // Retention exists so a devicectl blip cannot prune a connected iPhone, so
    // the device is still reported -- but its source did not complete.
    expect(discovery.devices.map((device) => device.deviceId).sort()).toEqual(
      [PHYSICAL_UDID, SIMULATOR_UDID].sort(),
    );
    expect(discovery.succeededSources!.has("ios-physical")).toBe(false);
  });

  test("a freshly parsed iPhone is fresh even when a sibling record is unreadable", async () => {
    // `parseDevicectlDeviceList` reports source-wide `complete: false` when any
    // entry is malformed, while still returning the devices it did parse.
    const manager = new MultiPlatformDeviceManager(
      null,
      new FakeBootedSimctl([SIMULATOR]) as unknown as SimCtlClient,
      new FakeBootedEmulator() as unknown as AndroidEmulatorClient,
      undefined,
      undefined,
      { listConnectedDevices: async () => ({ devices: [PHYSICAL], complete: false }) },
    );

    const discovery = await manager.getBootedDevicesDetailed("ios");

    // The source is incomplete, but this device was observed just now.
    expect(discovery.succeededSources!.has("ios-physical")).toBe(false);
    expect(discovery.freshDeviceIds!.has(PHYSICAL_UDID)).toBe(true);
  });

  test("a replayed iPhone is reported but not fresh", async () => {
    const manager = new MultiPlatformDeviceManager(
      null,
      new FakeBootedSimctl([SIMULATOR]) as unknown as SimCtlClient,
      new FakeBootedEmulator() as unknown as AndroidEmulatorClient,
      undefined,
      undefined,
      {
        listConnectedDevices: async () => ({
          devices: [PHYSICAL],
          complete: false,
          retainedDeviceIds: new Set([PHYSICAL_UDID]),
        }),
      },
    );

    const discovery = await manager.getBootedDevicesDetailed("ios");

    expect(discovery.devices.map((device) => device.deviceId)).toContain(PHYSICAL_UDID);
    expect(discovery.freshDeviceIds!.has(PHYSICAL_UDID)).toBe(false);
  });

  test("both sources fail: no source is complete", async () => {
    const discovery = await manager({
      simctlOk: false,
      devicectlOk: false,
    }).getBootedDevicesDetailed("ios");

    expect(discovery.succeededSources!.size).toBe(0);
    expect(discovery.succeededPlatforms.has("ios")).toBe(false);
    expect(discovery.devices).toEqual([]);
    expect(discovery.discoveryErrors?.ios?.code).toBe("failed");
  });
});

describe("DevicePool idle assignability is decided per source (#5683)", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let deviceManager: FakeDeviceManager;

  beforeEach(() => {
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    deviceManager = new FakeDeviceManager();
    devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      timer,
      new FakeInstalledAppsRepository(),
      deviceManager,
      new DefaultRetryExecutor(timer),
    );
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  const pool = async (devices: BootedDevice[]): Promise<void> => {
    deviceManager.bootedDevices = devices;
    await devicePool.initializeWithDevices(devices);
  };

  test("a confirmed physical iPhone stays assignable when simctl fails", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-simulator");

    await expect(
      devicePool.bindOrReuseDeviceSession("session-a", PHYSICAL_UDID, "ios"),
    ).resolves.toBeDefined();
    expect(devicePool.getDevice(PHYSICAL_UDID)?.sessionId).toBe("session-a");
  });

  test("an idle simulator stays assignable when devicectl fails", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-physical");

    await expect(
      devicePool.bindOrReuseDeviceSession("session-b", SIMULATOR_UDID, "ios"),
    ).resolves.toBeDefined();
    expect(devicePool.getDevice(SIMULATOR_UDID)?.sessionId).toBe("session-b");
  });

  test("a failing simctl sweep does not prune the simulator it could not list", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-simulator");

    await expect(
      devicePool.bindOrReuseDeviceSession("session-c", SIMULATOR_UDID, "ios"),
    ).rejects.toThrow(/Unable to verify iOS simulator/);
    // Unverifiable, never proven gone: the pooled entry survives.
    expect(devicePool.getDevice(SIMULATOR_UDID)).toBeDefined();
  });

  test("a failing devicectl sweep does not prune the iPhone it could not list", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-physical");

    await expect(
      devicePool.bindOrReuseDeviceSession("session-d", PHYSICAL_UDID, "ios"),
    ).rejects.toThrow(/Unable to verify iOS device/);
    expect(devicePool.getDevice(PHYSICAL_UDID)).toBeDefined();
  });

  test("a retained-but-unverified iPhone is not assignable when both sources fail", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    // devicectl failed but replays its last-good listing, and simctl failed
    // too. Nothing observed the iPhone this sweep, so presence in the returned
    // list must not be read as proof it is still plugged in.
    deviceManager.failedSources.add("ios-physical");
    deviceManager.retainedSources.add("ios-physical");
    deviceManager.failedSources.add("ios-simulator");

    await expect(
      devicePool.bindOrReuseDeviceSession("session-f", PHYSICAL_UDID, "ios"),
    ).rejects.toThrow(/Unable to verify iOS device/);
    // Unverifiable, never proven gone: retained, not pruned.
    expect(devicePool.getDevice(PHYSICAL_UDID)).toBeDefined();
  });

  test("a freshly parsed iPhone stays assignable when its source is incomplete", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    // devicectl parsed this iPhone but choked on a sibling record, so the
    // source is incomplete while the device itself was seen just now.
    deviceManager.incompleteSources.add("ios-physical");

    await expect(
      devicePool.bindOrReuseDeviceSession("session-g", PHYSICAL_UDID, "ios"),
    ).resolves.toBeDefined();
    expect(devicePool.getDevice(PHYSICAL_UDID)?.sessionId).toBe("session-g");
  });

  test("a complete sweep that no longer lists an iPhone still prunes it", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.bootedDevices = [SIMULATOR];

    await expect(
      devicePool.bindOrReuseDeviceSession("session-e", PHYSICAL_UDID, "ios"),
    ).rejects.toThrow();
    expect(devicePool.getDevice(PHYSICAL_UDID)).toBeNull();
  });
});

describe("disconnect monitor ages out only devices whose own source succeeded (#5683)", () => {
  const evaluate = (succeededSources: Array<"ios-simulator" | "ios-physical">) => {
    const misses = new Map<string, number>();
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set<string>(),
      bootedDeviceIds: new Set<string>(),
      candidateDeviceIds: new Set([PHYSICAL_UDID, SIMULATOR_UDID]),
      succeededPlatforms: new Set<Platform>(
        succeededSources.includes("ios-simulator") ? ["ios"] : [],
      ),
      succeededSources: new Set(succeededSources),
      candidatePlatforms: new Map<string, Platform>([
        [PHYSICAL_UDID, "ios"],
        [SIMULATOR_UDID, "ios"],
      ]),
      missThreshold: 2,
    });
    return result.missed.map((entry) => entry.deviceId).sort();
  };

  test("a failed simctl sweep counts a miss for the iPhone only", () => {
    expect(evaluate(["ios-physical"])).toEqual([PHYSICAL_UDID]);
  });

  test("a failed devicectl sweep counts a miss for the simulator only", () => {
    expect(evaluate(["ios-simulator"])).toEqual([SIMULATOR_UDID]);
  });

  test("both sources complete counts a miss for both", () => {
    expect(evaluate(["ios-simulator", "ios-physical"])).toEqual(
      [PHYSICAL_UDID, SIMULATOR_UDID].sort(),
    );
  });

  test("both sources failed counts no misses at all", () => {
    expect(evaluate([])).toEqual([]);
  });
});
