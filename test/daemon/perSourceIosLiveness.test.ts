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

describe("MultiPlatformDeviceManager reports iOS completeness per source (#5683)", () => {
  const manager = (options: {
    simctlOk: boolean;
    devicectlOk: boolean;
  }): MultiPlatformDeviceManager =>
    new MultiPlatformDeviceManager(
      null,
      {
        isAvailable: async () => true,
        getBootedSimulatorsChecked: async () => {
          if (!options.simctlOk) {
            throw new Error("simctl list devices failed");
          }
          return [SIMULATOR];
        },
      } as unknown as SimCtlClient,
      { getBootedDevicesChecked: async () => [] } as unknown as AndroidEmulatorClient,
      undefined,
      undefined,
      {
        listConnectedDevices: async () =>
          options.devicectlOk
            ? { devices: [PHYSICAL], complete: true }
            : { devices: [], complete: false },
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
