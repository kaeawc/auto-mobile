import { describe, expect, test } from "bun:test";
import { IdleDeviceReaper, type IdleDeviceReaperPoolPort } from "../../src/daemon/idleDeviceReaper";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

const simulatorId = "11111111-2222-3333-4444-555555555555";
const phoneId = "00008120-001A2B3C4D5E6F70";

function pooledDevice(id = simulatorId): PooledDevice {
  return {
    id,
    name: "iPhone",
    platform: "ios",
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
  };
}

function discovery(
  ids: string[],
  succeededSources: Array<"ios-simulator" | "ios-physical">,
  freshIds = ids,
): BootedDeviceDiscovery {
  return {
    devices: ids.map((deviceId) => ({ deviceId, name: "iPhone", platform: "ios" })),
    succeededPlatforms: new Set(succeededSources.includes("ios-simulator") ? ["ios" as const] : []),
    succeededSources: new Set(succeededSources),
    freshDeviceIds: new Set(freshIds),
  };
}

describe("IdleDeviceReaper", () => {
  test("removes a stale idle simulator under the assignment lock", async () => {
    const device = pooledDevice();
    const devices = new Map([[device.id, device]]);
    let lockHeld = false;
    const removals: string[] = [];
    const pool: IdleDeviceReaperPoolPort = {
      getDevice: (id) => devices.get(id) ?? null,
      removeDevice: async (id, awaitCacheCleanup, expected) => {
        expect(lockHeld).toBe(true);
        expect(awaitCacheCleanup).toBe(false);
        expect(expected).toBe(device);
        removals.push(id);
        devices.delete(id);
      },
      withAssignmentLock: async (operation) => {
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      },
    };
    const reaper = new IdleDeviceReaper(pool, {
      getBootedDevicesDetailed: async () => discovery([], ["ios-simulator", "ios-physical"]),
    });

    expect(await reaper.pruneStaleIdleIosDevices([device])).toBe(1);
    expect(removals).toEqual([simulatorId]);
  });

  test("ignores a stale sweep after the pooled incarnation changes", async () => {
    const timer = new FakeTimer();
    const original = pooledDevice();
    const replacement = { ...original, incarnation: 2 };
    const devices = new Map([[original.id, original]]);
    let removals = 0;
    const pool: IdleDeviceReaperPoolPort = {
      getDevice: (id) => devices.get(id) ?? null,
      removeDevice: async () => {
        removals++;
      },
      withAssignmentLock: async (operation) => await operation(),
    };
    const reaper = new IdleDeviceReaper(pool, {
      getBootedDevicesDetailed: async () => {
        await timer.sleep(5);
        return discovery([], ["ios-simulator", "ios-physical"]);
      },
    });

    const prune = reaper.pruneStaleIdleIosDevices([original]);
    devices.set(original.id, replacement);
    timer.advanceTime(5);
    expect(await prune).toBe(0);
    expect(removals).toBe(0);
    expect(devices.get(original.id)).toBe(replacement);
  });

  test("keeps an idle phone when its source fails, even if retained in the listing", async () => {
    const device = pooledDevice(phoneId);
    let removals = 0;
    const pool: IdleDeviceReaperPoolPort = {
      getDevice: () => device,
      removeDevice: async () => {
        removals++;
      },
      withAssignmentLock: async (operation) => await operation(),
    };
    const reaper = new IdleDeviceReaper(pool, {
      getBootedDevicesDetailed: async () => discovery([phoneId], ["ios-simulator"], []),
    });

    const snapshot = await reaper.getIosLivenessSnapshot();
    expect(reaper.getIdleDeviceLivenessStatus(device, snapshot)).toBe("unknown");
    expect(await reaper.pruneStaleIdleIosDevices([device])).toBe(0);
    expect(removals).toBe(0);
  });

  test("accepts a freshly observed phone during an incomplete source sweep", async () => {
    const device = pooledDevice(phoneId);
    const reaper = new IdleDeviceReaper(
      {
        getDevice: () => device,
        removeDevice: async () => {
          throw new Error("fresh phone must not be removed");
        },
        withAssignmentLock: async (operation) => await operation(),
      },
      { getBootedDevicesDetailed: async () => discovery([phoneId], ["ios-simulator"]) },
    );

    const snapshot = await reaper.getIosLivenessSnapshot();
    expect(reaper.getIdleDeviceLivenessStatus(device, snapshot)).toBe("assignable");
    expect(await reaper.pruneStaleIdleIosDevices([device])).toBe(0);
  });
});
