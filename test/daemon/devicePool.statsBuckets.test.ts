import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { DevicePool } from "../../src/daemon/devicePool";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import { poolHoldFor } from "../../src/server/deviceDescription";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { listDevicePayloads } from "../../src/server/deviceTools";
import { assignManagedSlotDevice } from "./managedSlots/managedSlotFixtures";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract: every surface reports the same status for a device. A device in the pool's
// `error` state that is also reserved (restart-recovery reservation) is reported `error` by
// listDevices/booted resources (the pool status wins), but getStats() counts it in BOTH `error`
// and `assigned`, so idle + assigned + error exceeds total on the available-devices and
// refreshDevices daemon handlers.

const SIM_A = "SIM-ERR-A";
const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });

describe("pool stats for an errored device that is also reserved", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;
  let healthMarkers: InMemoryDeviceHealthMarkers;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    healthMarkers = new InMemoryDeviceHealthMarkers(timer);
    const manager = new FakeDeviceManager();
    manager.bootedDevices = [ios(SIM_A)];
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "inventory-error-reserved", {
        timer,
        deviceHealthMarkers: healthMarkers,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([ios(SIM_A)]);
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("each device lands in exactly one stats bucket", async () => {
    await pool.reserveDevicesForRehydration([
      { sessionId: "row-a", target: { platform: "ios", stableDeviceId: SIM_A, deviceId: SIM_A } },
    ]);
    for (let i = 0; i < 10; i++) {
      pool.recordDeviceError(SIM_A);
    }
    expect(pool.getDevice(SIM_A)?.status).toBe("error");
    expect(poolHoldFor(pool, SIM_A)).toEqual({ reserved: true });

    const stats = pool.getStats();
    expect(stats.idle + stats.assigned + stats.error).toBe(stats.total);
  });

  // An idle device carrying an unhealthy marker is `idle` on listDevices/booted resources (pool
  // status) yet getStats() counts it nowhere: not idle (ineligible), not assigned, not error.
  test("an idle unhealthy device is still counted in a bucket matching its listed status", () => {
    const incarnation = pool.getDeviceIncarnation(SIM_A) ?? 0;
    healthMarkers.mark(SIM_A, incarnation, "app-cleanup");
    expect(pool.getDeviceHealthMarker(SIM_A)).toBeDefined();
    expect(pool.getDevice(SIM_A)?.status).toBe("idle");

    const stats = pool.getStats();
    expect(stats.idle + stats.assigned + stats.error).toBe(stats.total);
  });
});

// #11387: one pool built with every state; stats, per-device status and listDevices agree.
describe("every pooled device is in exactly one stats bucket matching its listed status", () => {
  const ids = ["BUSY", "ERR", "ERR-RES", "FREE", "REHYDRATE", "SLOT", "UNHEALTHY"];
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;
  let devices: BootedDevice[];

  beforeEach(async () => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const registry = new FakeSlotRegistry(timer);
    await assignManagedSlotDevice(registry, "ios", "SLOT");
    const healthMarkers = new InMemoryDeviceHealthMarkers(timer);
    const manager = new FakeDeviceManager();
    devices = ids.map(ios);
    manager.bootedDevices = devices;
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "stats-buckets", {
        timer,
        deviceHealthMarkers: healthMarkers,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices(devices);
    await pool.managedSlotStableIds("ios");
    await pool.reserveDevicesForRehydration(
      ["ERR-RES", "REHYDRATE"].map((id) => ({
        sessionId: `row-${id}`,
        target: { platform: "ios" as const, stableDeviceId: id, deviceId: id },
      })),
    );
    for (const id of ["ERR", "ERR-RES"]) {
      for (let i = 0; i < 10; i++) {
        pool.recordDeviceError(id);
      }
    }
    healthMarkers.mark("UNHEALTHY", pool.getDeviceIncarnation("UNHEALTHY") ?? 0, "app-cleanup");
    const busy = pool.getDevice("BUSY");
    if (busy) {
      busy.status = "busy";
    }
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("stats partition the pool and match each device's listed status", () => {
    const expected: Record<string, string> = {
      BUSY: "assigned",
      ERR: "error",
      "ERR-RES": "error",
      FREE: "idle",
      REHYDRATE: "assigned",
      SLOT: "assigned",
      UNHEALTHY: "assigned",
    };
    const listed = listDevicePayloads(devices, pool, new Map());
    for (const entry of listed) {
      expect(entry.runtime.poolStatus).toBe(expected[entry.runtime.deviceId]!);
      expect(pool.poolBucket(entry.runtime.deviceId)).toBe(expected[entry.runtime.deviceId]!);
    }
    for (const stats of [pool.getStats(), pool.getStatsForPlatform("ios")]) {
      expect(stats).toMatchObject({ total: 7, idle: 1, assigned: 4, error: 2 });
      expect(stats.idle + stats.assigned + stats.error).toBe(stats.total);
    }
  });
});
