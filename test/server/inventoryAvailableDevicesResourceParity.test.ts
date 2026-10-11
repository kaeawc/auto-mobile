import { afterEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  BOOTED_DEVICES_RESOURCE_BUDGET_MS,
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract (#11643): for one host state the booted-devices resource's pool counts are
// the pool's own (`getRefreshedStats`, which `daemon/availableDevices` and the in-daemon CLI
// print), or an unknown count (`countUnknown`, which the CLI refuses as `discovery_incomplete`).
// The resource is bounded by a budget and the pool read is not, so the resource may refuse where
// the pool later answers; it must never print a different number.

const emulator1: BootedDevice = { platform: "android", name: "Pixel_9", deviceId: "emulator-5554" };
const emulator2: BootedDevice = { platform: "android", name: "Pixel_8", deviceId: "emulator-5556" };

type Counts = { idle: number; assigned: number; error: number; total: number };
const counts = (stats: Counts): Counts => ({
  idle: stats.idle,
  assigned: stats.assigned,
  error: stats.error,
  total: stats.total,
});
const UNKNOWN_ANDROID = { countUnknown: { code: "discovery_incomplete", platforms: ["android"] } };

describe("the booted-devices resource counts the pool as the pool does", () => {
  let sessions: SessionManager | undefined;

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.setInstance(null);
  });

  async function daemonWith(pooled: BootedDevice[]) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", pooled);
    manager.setBootedDevices("ios", []);
    const activeSessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = activeSessions;
    const pool = new DevicePool(
      createDevicePoolDependencies(activeSessions, "available-devices-resource-parity", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(pooled);
    DaemonState.getInstance().initialize(activeSessions, pool);
    setDeviceManager(manager);
    PlatformDeviceManagerFactory.setInstance(manager);
    return { timer, manager, pool };
  }

  test("a listed emulator whose row withholds its pool identity is counted as the pool counts it", async () => {
    const { timer, manager, pool } = await daemonWith([emulator1, emulator2]);
    // The first emulator's console went quiet: discovery names it with the placeholder, so its
    // row carries no pool context -- but the pool still holds that serial and counts it.
    manager.setBootedDevices("android", [
      { ...emulator1, name: `Unknown (${emulator1.deviceId})` },
      emulator2,
    ]);

    const resource = await getBootedDevicesForPlatforms(["android"], timer);
    const withheld = resource.devices.find((row) => row.runtime.deviceId === emulator1.deviceId);
    expect(withheld?.runtime.poolStatus).toBeNull();
    expect(withheld?.identityUnresolved).toBe(true);

    const poolStats = counts(await pool.getRefreshedStats());
    expect(poolStats.total).toBe(2);
    expect(counts(resource.poolStatus!)).toEqual(poolStats);
    expect(resource.poolStatus?.countUnknown).toBeUndefined();
  });

  test("the budget elapsing before a pooled platform is listed is an unknown count, then the pool's number", async () => {
    const { timer, manager, pool } = await daemonWith([emulator1]);
    manager.setBootedDevicesDetailedHangs("android", true);

    const bounded = await getBootedDevicesForPlatforms(["android"], timer);

    expect(timer.now()).toBeGreaterThanOrEqual(BOOTED_DEVICES_RESOURCE_BUDGET_MS);
    expect(bounded.enrichment).toMatchObject({ complete: false, retryable: true });
    expect(bounded.devices).toEqual([]);
    expect(bounded.poolStatus).toMatchObject({ idle: 0, total: 0, ...UNKNOWN_ANDROID });

    // Once the listing answers, the retry and the pool give one number.
    manager.setBootedDevicesDetailedHangs("android", false);
    resetBootedDevicesResourceCache();
    const retried = await getBootedDevicesForPlatforms(["android"], timer);
    expect(retried.poolStatus?.countUnknown).toBeUndefined();
    expect(counts(retried.poolStatus!)).toEqual(counts(await pool.getRefreshedStats()));
  });

  test("the budget elapsing while a listed platform's held devices are still being placed is an unknown count", async () => {
    const { timer, manager, pool } = await daemonWith([emulator1]);
    await pool.assignDeviceToSession("session-held");
    // adb lists the held emulator `offline`, so discovery drops it; only the state probe can
    // place it, and this read's probe outlives the budget.
    manager.setBootedDevices("android", []);
    let probes = 0;
    manager.getAndroidListedDeviceStates = async (ids) => {
      probes += 1;
      if (probes === 1) {
        await timer.sleep(BOOTED_DEVICES_RESOURCE_BUDGET_MS * 2);
      }
      return new Map(ids.map((id) => [id, "offline"]));
    };

    const bounded = await getBootedDevicesForPlatforms(["android"], timer);

    expect(bounded.enrichment).toMatchObject({ complete: false, retryable: true });
    // Not "0 pooled devices": the pool counts the held emulator once its own probe answers.
    expect(bounded.poolStatus).toMatchObject({ idle: 0, ...UNKNOWN_ANDROID });
    expect(counts(await pool.getRefreshedStats())).toEqual({
      idle: 0,
      assigned: 1,
      error: 0,
      total: 1,
    });
  });

  test("a step of the resource's own read failing after the listing is an unknown count, not a guess", async () => {
    const { timer, pool } = await daemonWith([emulator1]);
    pool.reconcileDiscoveryObservation = async () => {
      throw new Error("identity reconciliation failed");
    };

    const resource = await getBootedDevicesForPlatforms(["android"], timer);

    // Pinned: the rows cannot be joined to pooled identity, so the resource reports no devices
    // and an unknown count while the pool's own read (which needs no reconciliation) answers.
    expect(resource.observationComplete).toBe(false);
    expect(resource.devices).toEqual([]);
    expect(resource.poolStatus).toMatchObject({ idle: 0, total: 0, ...UNKNOWN_ANDROID });
    expect(counts(await pool.getRefreshedStats()).idle).toBe(1);
  });
});
