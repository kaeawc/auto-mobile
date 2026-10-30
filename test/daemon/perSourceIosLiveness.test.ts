import { makePool } from "../helpers/makePool";
import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { evaluateDeviceDisconnects } from "../../src/daemon/disconnectMonitor";
import {
  MultiPlatformDeviceManager,
  type DeviceManagerSimCtl,
} from "../../src/devices/deviceUtils";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import type { BootedDevice, Platform } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { IOS_LIVENESS_REDISCOVERY_DELAYS_MS } from "../../src/daemon/devicePoolParts/contracts";
import { IdleDeviceReaper } from "../../src/daemon/idleDeviceReaper";
import { DevicectlDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import { FakeDiscoveryObservationSequence } from "../fakes/FakeDiscoveryObservationSequence";
import { createExecResult } from "../../src/utils/execResult";
import {
  loadDerivedDevicectlListing,
  derivePhysicalDevicectlRecord,
} from "../helpers/devicectlListFixtures";
import { DeviceLossMisses } from "../../src/daemon/deviceLossMisses";

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
 * The simctl surface `MultiPlatformDeviceManager.getBootedDevicesDetailed` actually calls is
 * `isAvailable` and `getBootedSimulatorsChecked`; every other operation of the real handle type
 * refuses, so a drift in what the manager drives fails loudly.
 */
class FakeBootedSimctl implements DeviceManagerSimCtl {
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

  async listSimulatorImages(): Promise<never> {
    throw new TypeError("FakeBootedSimctl.listSimulatorImages is not stubbed");
  }

  async getBootedSimulators(): Promise<never> {
    throw new TypeError("FakeBootedSimctl.getBootedSimulators is not stubbed");
  }

  async startSimulator(): Promise<never> {
    throw new TypeError("FakeBootedSimctl.startSimulator is not stubbed");
  }

  async deleteSimulator(): Promise<never> {
    throw new TypeError("FakeBootedSimctl.deleteSimulator is not stubbed");
  }

  async killSimulator(): Promise<never> {
    throw new TypeError("FakeBootedSimctl.killSimulator is not stubbed");
  }

  async waitForSimulatorReady(): Promise<never> {
    throw new TypeError("FakeBootedSimctl.waitForSimulatorReady is not stubbed");
  }
}

const bootedEmulator = () => createFakeAndroidEmulator({ getBootedDevicesChecked: async () => [] });

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
      ),
      bootedEmulator(),
      undefined,
      undefined,
      {
        listConnectedDevices: async () =>
          options.devicectlOk
            ? { devices: [PHYSICAL], complete: true }
            : {
                devices: options.retainedPhysical ? [PHYSICAL] : [],
                complete: false,
                error: {
                  code: "failed",
                  message: "devicectl could not list physical iOS devices (failed): fake",
                },
              },
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

  test("a replayed iPhone is reported but not fresh", async () => {
    const manager = new MultiPlatformDeviceManager(
      null,
      new FakeBootedSimctl([SIMULATOR]),
      bootedEmulator(),
      undefined,
      undefined,
      {
        listConnectedDevices: async () => ({
          devices: [PHYSICAL],
          complete: false,
          error: {
            code: "failed",
            message: "devicectl could not list physical iOS devices (failed): fake",
          },
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
  let timer: FakeTimer;

  function arrangeHarness(): void {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    deviceManager = new FakeDeviceManager();
    devicePool = makePool(sessionManager, "test-daemon-session-id", {
      timer,
      deviceManager: deviceManager,
    });
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  const pool = async (devices: BootedDevice[]): Promise<void> => {
    deviceManager.bootedDevices = devices;
    await devicePool.initializeWithDevices(devices);
  };

  /**
   * An exact-device bind whose iOS liveness listing failed re-lists after each backoff delay
   * (#15289) before refusing. Walk the fake clock through every delay so the refusal settles
   * without any real waiting, then return the message the bind rejected with.
   */
  const rejectionAfterRelists = async (bind: Promise<unknown>): Promise<string> => {
    const rejection = bind.then(
      () => "bind resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    for (const delayMs of IOS_LIVENESS_REDISCOVERY_DELAYS_MS) {
      await drainUntilQuiescent(timer);
      timer.advanceTime(delayMs);
    }
    return await rejection;
  };

  arranged("a confirmed physical iPhone stays assignable when simctl fails", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-simulator");

    await expect(
      devicePool.bindOrReuseDeviceSession({
        sessionId: "session-a",
        deviceId: PHYSICAL_UDID,
        platform: "ios",
      }),
    ).resolves.toBeDefined();
    expect(devicePool.getDevice(PHYSICAL_UDID)?.sessionId).toBe("session-a");
  });

  arranged("an idle simulator stays assignable when devicectl fails", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-physical");

    await expect(
      devicePool.bindOrReuseDeviceSession({
        sessionId: "session-b",
        deviceId: SIMULATOR_UDID,
        platform: "ios",
      }),
    ).resolves.toBeDefined();
    expect(devicePool.getDevice(SIMULATOR_UDID)?.sessionId).toBe("session-b");
  });

  arranged("a failing simctl sweep does not prune the simulator it could not list", async () => {
    await pool([PHYSICAL, SIMULATOR]);
    deviceManager.failedSources.add("ios-simulator");

    const message = await rejectionAfterRelists(
      devicePool.bindOrReuseDeviceSession({
        sessionId: "session-c",
        deviceId: SIMULATOR_UDID,
        platform: "ios",
      }),
    );
    expect(message).toMatch(/Unable to verify iOS simulator/);
    // Unverifiable, never proven gone: the pooled entry survives.
    expect(devicePool.getDevice(SIMULATOR_UDID)).toBeDefined();
  });

  arranged(
    "a skipped unrelated devicectl record keeps a still-present idle iPhone fresh and assignable",
    async () => {
      await pool([PHYSICAL, SIMULATOR]);
      const timer = new FakeTimer();
      // DERIVED mixed inventory: only reality/udid/platform change on a captured simulator.
      const listing = loadDerivedDevicectlListing();
      const phone = derivePhysicalDevicectlRecord(listing.result.devices[0], PHYSICAL_UDID);
      listing.result.devices.push(phone);
      const lister = new DevicectlDeviceLister({
        platform: () => "darwin",
        timer,
        observationSequence: new FakeDiscoveryObservationSequence(),
        execute: async () => createExecResult("", ""),
        readFile: async () => JSON.stringify(listing),
        mkdtemp: async () => "/fake/devicectl",
        rm: async () => {},
        tmpdir: () => "/fake",
        logger: { warn: () => {}, debug: () => {} },
      });
      const manager = new MultiPlatformDeviceManager(
        null,
        new FakeBootedSimctl([SIMULATOR]),
        bootedEmulator(),
        undefined,
        undefined,
        lister,
      );
      expect((await lister.listConnectedDevices()).complete).toBe(true);
      const originalPlatform = listing.result.devices[0].properties.hardware.platform;
      // DERIVED unknown platform in a DIFFERENT record; the recognized phone remains present.
      // The sweep is incomplete (no absence evidence) but the phone it recognized stays fresh.
      listing.result.devices[0].properties.hardware.platform = "futureOS";
      timer.advanceTime(3_000);
      const discovery = await manager.getBootedDevicesDetailed("ios");
      expect(discovery.devices.map((device) => device.deviceId)).toContain(PHYSICAL_UDID);
      expect(discovery.succeededSources!.has("ios-physical")).toBe(false);
      expect(discovery.freshDeviceIds!.has(PHYSICAL_UDID)).toBe(true);
      expect(discovery.sourceErrors?.["ios-physical"]).toBeDefined();
      const reaper = new IdleDeviceReaper(
        {
          getDevice: (id) => devicePool.getDevice(id),
          removeDevice: (id, cleanup, expected) => devicePool.removeDevice(id, cleanup, expected),
          withAssignmentLock: async (operation) => await operation(),
        },
        manager,
      );
      const device = devicePool.getDevice(PHYSICAL_UDID)!;
      const snapshot = await reaper.getIosLivenessSnapshot();
      expect(reaper.getIdleDeviceLivenessStatus(device, snapshot)).toBe("assignable");
      expect(await reaper.pruneStaleIdleIosDevices([device])).toBe(0);

      // Feed the complete listing into the pool's existing fake manager.
      deviceManager.bootedDevices = discovery.devices;

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-d",
          deviceId: PHYSICAL_UDID,
          platform: "ios",
        }),
      ).resolves.toBeDefined();
      expect(devicePool.getDevice(PHYSICAL_UDID)?.sessionId).toBe("session-d");

      // A complete listing genuinely missing the phone is still authoritative.
      listing.result.devices[0].properties.hardware.platform = originalPlatform;
      listing.result.devices = listing.result.devices.filter((record) => record !== phone);
      timer.advanceTime(3_000);
      const absent = await manager.getBootedDevicesDetailed("ios");
      expect(absent.succeededSources!.has("ios-physical")).toBe(true);
      expect(absent.freshDeviceIds!.has(PHYSICAL_UDID)).toBe(false);
      expect(absent.devices.map((record) => record.deviceId)).not.toContain(PHYSICAL_UDID);
    },
  );

  arranged(
    "a retained-but-unverified iPhone is not assignable when both sources fail",
    async () => {
      await pool([PHYSICAL, SIMULATOR]);
      // devicectl failed but replays its last-good listing, and simctl failed
      // too. Nothing observed the iPhone this sweep, so presence in the returned
      // list must not be read as proof it is still plugged in.
      deviceManager.failedSources.add("ios-physical");
      deviceManager.retainedSources.add("ios-physical");
      deviceManager.failedSources.add("ios-simulator");

      const message = await rejectionAfterRelists(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-f",
          deviceId: PHYSICAL_UDID,
          platform: "ios",
        }),
      );
      expect(message).toMatch(/Unable to verify iOS device/);
      // Unverifiable, never proven gone: retained, not pruned.
      expect(devicePool.getDevice(PHYSICAL_UDID)).toBeDefined();
    },
  );

  arranged(
    "a pre-lock bind sweep that no longer lists an iPhone rejects without pruning",
    async () => {
      await pool([PHYSICAL, SIMULATOR]);
      deviceManager.bootedDevices = [SIMULATOR];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-e",
          deviceId: PHYSICAL_UDID,
          platform: "ios",
        }),
      ).rejects.toThrow();
      expect(devicePool.getDevice(PHYSICAL_UDID)?.status).toBe("idle");
    },
  );
});

describe("disconnect monitor ages out only devices whose own source succeeded (#5683)", () => {
  const evaluate = (succeededSources: Array<"ios-simulator" | "ios-physical">) => {
    const misses = new DeviceLossMisses();
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
