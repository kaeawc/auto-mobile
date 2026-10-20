import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { makePool } from "../helpers/makePool";
import { bindDevice, markDeviceError, statusOf } from "../../src/daemon/deviceBinding";
import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { DevicePool, type PoolStatusBucket } from "../../src/daemon/devicePool";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import { poolHoldFor } from "../../src/daemon/deviceDescription";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { listDevicePayloads } from "../../src/server/deviceTools";
import { assignBindingDevice } from "./sessionBroker/provisioning/bindingFixtures";
import { FakeTimer } from "../fakes/FakeTimer";

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

  async function arrangeHarness(): Promise<void> {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    healthMarkers = new InMemoryDeviceHealthMarkers(timer);
    const manager = new FakeDeviceManager();
    manager.bootedDevices = [ios(SIM_A)];
    pool = makePool(sessions, "inventory-error-reserved", {
      timer,
      deviceHealthMarkers: healthMarkers,
      deviceManager: manager,
    });
    await pool.initializeWithDevices([ios(SIM_A)]);
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
    sessions.stopCleanupTimer();
    timer.reset();
  });

  arranged("listing JSON and report text retain legacy status without exposing health", () => {
    const device = pool.getDevice(SIM_A)!;
    const listed = () => JSON.stringify(listDevicePayloads([ios(SIM_A)], pool, new Map()));
    const healthy = listed();
    expect(healthy).not.toContain('"health"');
    markDeviceError(device);
    const errored = healthy.replace('"poolStatus":"idle"', '"poolStatus":"error"');
    expect(errored).not.toBe(healthy);
    expect(listed()).toBe(errored);
    expect(pool.getStatusReport()).toContain(`  ❌ ${SIM_A}: error (0 uses, 0 errors)`);
    bindDevice(device, "owner");
    const busy = listed();
    expect(busy).not.toContain('"health"');
    expect(statusOf(device)).toBe("busy");
    markDeviceError(device);
    const boundError = busy.replace('"poolStatus":"assigned"', '"poolStatus":"error"');
    expect(boundError).not.toBe(busy);
    expect(listed()).toBe(boundError);
    expect(pool.getStatusReport()).toContain(`  ❌ ${SIM_A}: error (owner) (0 uses, 0 errors)`);
  });

  arranged("each device lands in exactly one stats bucket", async () => {
    await pool.reserveDevicesForRehydration([
      { sessionId: "row-a", target: { platform: "ios", stableDeviceId: SIM_A, deviceId: SIM_A } },
    ]);
    for (let i = 0; i < 10; i++) {
      pool.recordDeviceError(SIM_A);
    }
    expect(statusOf(pool.getDevice(SIM_A)!)).toBe("error");
    expect(poolHoldFor(pool, SIM_A)).toEqual({ reserved: true });

    const stats = pool.getStats();
    expect(stats.idle + stats.assigned + stats.error).toBe(stats.total);
  });

  // An idle device carrying an unhealthy marker is `idle` on listDevices/booted resources (pool
  // status) yet getStats() counts it nowhere: not idle (ineligible), not assigned, not error.
  arranged(
    "an idle unhealthy device is still counted in a bucket matching its listed status",
    () => {
      const incarnation = pool.getDeviceIncarnation(SIM_A) ?? 0;
      healthMarkers.mark(SIM_A, incarnation, "app-cleanup");
      expect(pool.getDeviceHealthMarker(SIM_A)).toBeDefined();
      expect(pool.getDevice(SIM_A)?.status).toBe("idle");

      const stats = pool.getStats();
      expect(stats.idle + stats.assigned + stats.error).toBe(stats.total);
    },
  );
});

// #11387: one pool built with every state; stats, per-device status and listDevices agree.
describe("every pooled device is in exactly one stats bucket matching its listed status", () => {
  const ids = ["BUSY", "ERR", "ERR-RES", "FREE", "REHYDRATE", "SLOT", "UNHEALTHY"];
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;
  let devices: BootedDevice[];

  async function arrangeHarness2(): Promise<void> {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const registry = new FakeBindingRegistry(timer);
    await assignBindingDevice(registry, "ios", "SLOT");
    const healthMarkers = new InMemoryDeviceHealthMarkers(timer);
    const manager = new FakeDeviceManager();
    devices = ids.map(ios);
    manager.bootedDevices = devices;
    pool = makePool(sessions, "stats-buckets", {
      timer,
      deviceHealthMarkers: healthMarkers,
      deviceManager: manager,
      bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
    });
    await pool.initializeWithDevices(devices);
    await pool.bindingStableIds("ios");
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
      patchDeviceBinding(busy, { status: "busy" });
    }
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged2(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness2();
        await fn();
      },
      timeout,
    );
  }

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  arranged2("stats partition the pool and match each device's listed status", () => {
    const expected: Record<string, PoolStatusBucket> = {
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
      const deviceId = entry.runtime.deviceId;
      if (deviceId === null) {
        throw new Error("listed device has no deviceId");
      }
      expect(entry.runtime.poolStatus).toBe(expected[deviceId]!);
      expect(pool.poolBucket(deviceId)).toBe(expected[deviceId]!);
    }
    for (const stats of [pool.getStats(), pool.getStatsForPlatform("ios")]) {
      expect(stats).toMatchObject({ total: 7, idle: 1, assigned: 4, error: 2 });
      expect(stats.idle + stats.assigned + stats.error).toBe(stats.total);
    }
  });
});
