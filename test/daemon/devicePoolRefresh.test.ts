import { describe, expect, test } from "bun:test";
import { Mutex } from "async-mutex";
import type { BootedDevice, Platform } from "../../src/models";
import type { BootedDeviceDiscovery, PlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { PooledDevice } from "../../src/daemon/devicePool";
import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import { DevicePoolRefresh, type DevicePoolRefreshPort } from "../../src/daemon/devicePoolRefresh";
import { FakeTimer } from "../fakes/FakeTimer";
import { recoveryCoordinatorHarness } from "../helpers/recoveryCoordinatorHarness";

const booted: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition did not settle within 100 microtasks");
}

function harness(
  trackingFailure?: unknown,
  lift?: DevicePoolRefreshPort["liftUnconfirmedRecoveringAndroidImages"],
) {
  const timer = new FakeTimer();
  const devices = new Map<string, PooledDevice>();
  const starts = new Map<string, number>();
  const misses = new Map<string, number>();
  const settled = new Map<string, { incarnation: number; refreshGeneration: number }>();
  const intentional = new Map<string, number>();
  const calls: string[] = [];
  const mutex = new Mutex();
  const resolveDiscoveries: Array<(discovery: BootedDeviceDiscovery) => void> = [];
  let pendingDiscovery = false;
  let nextDiscovery: BootedDeviceDiscovery = {
    devices: [booted],
    succeededPlatforms: new Set<Platform>(["android", "ios"]),
  };
  const manager = {
    getBootedDevicesDetailed: async () => {
      calls.push("discover");
      if (!pendingDiscovery) {
        return nextDiscovery;
      }
      return new Promise<BootedDeviceDiscovery>((resolve) => {
        resolveDiscoveries.push(resolve);
      });
    },
  } as PlatformDeviceManager;
  const port: DevicePoolRefreshPort = {
    getTimer: () => timer,
    getDeviceManager: () => manager,
    getDevices: () => devices,
    getAssignmentMutex: () => mutex,
    getCriteriaMatcher: () => new DeviceCriteriaMatcher(),
    identityEvidenceForBootedDevice: () => ({ unresolved: false }),
    identityEvidenceFields: () => ({}),
    getDeviceSessionStarts: () => starts,
    getRefreshMissingDeviceMisses: () => misses,
    getSettledLateShutdowns: () => settled,
    getIntentionalShutdowns: () => intentional,
    seedLastUsedAt: (now) => now,
    nextDeviceIncarnation: () => 1,
    setDeviceSessionTracking: async () => {
      calls.push("track");
      if (trackingFailure !== undefined) {
        throw trackingFailure;
      }
    },
    clearAutoStartSuppressionForBootedDevice: () => {
      calls.push("unsuppress");
    },
    foldObservationIntoPooledEntry: async () => {
      calls.push("fold");
      return false;
    },
    removeMissingDevicesForRefresh: async () => {
      calls.push("prune");
      return 0;
    },
    notifyDeviceReady: () => {
      calls.push("ready");
    },
    liftUnconfirmedRecoveringAndroidImages:
      lift ??
      (async () => {
        calls.push("lift-recovery-images");
      }),
  };
  const refresh = new DevicePoolRefresh(port);
  return {
    refresh,
    devices,
    calls,
    timer,
    starts,
    misses,
    settled,
    intentional,
    deferDiscovery: () => {
      pendingDiscovery = true;
    },
    resolveDiscovery: (discovery = nextDiscovery) => {
      resolveDiscoveries.shift()?.(discovery);
    },
    setDiscovery: (discovery: BootedDeviceDiscovery) => {
      nextDiscovery = discovery;
    },
  };
}

describe("DevicePoolRefresh", () => {
  test("reports a tracking persistence failure instead of a successful empty refresh", async () => {
    const h = harness(new Error("tracking persistence unavailable"));
    expect(await h.refresh.refreshDevicesInternal(false)).toEqual({
      addedCount: 0,
      failure: "tracking persistence unavailable",
    });
    expect(h.calls).not.toContain("ready");
    expect(h.refresh.getDeviceRemovalStampCountForTest()).toBe(0);
  });

  test("reports a non-Error refresh failure with its reason", async () => {
    const h = harness("tracking write rejected");
    expect(await h.refresh.refreshDevicesInternal(false)).toEqual({
      addedCount: 0,
      failure: "tracking write rejected",
    });
  });

  test("keeps partial discovery errors separate from refresh failures", async () => {
    const h = harness();
    const discoveryErrors: BootedDeviceDiscovery["discoveryErrors"] = {
      ios: { code: "failed", message: "simctl unavailable" },
    };
    const discovery: BootedDeviceDiscovery = {
      devices: [booted],
      succeededPlatforms: new Set<Platform>(["android"]),
      discoveryErrors,
    };
    h.setDiscovery(discovery);
    expect(await h.refresh.refreshDevicesInternal(false)).toEqual({
      addedCount: 1,
      completeness: { succeededPlatforms: discovery.succeededPlatforms },
    });
    expect(discovery.discoveryErrors).toBe(discoveryErrors);
    expect(discovery.discoveryErrors).toEqual({
      ios: { code: "failed", message: "simctl unavailable" },
    });
  });

  test("adds a discovery result and tracks it before notifying readiness", async () => {
    const h = harness();
    h.timer.advanceTime(42);
    expect(await h.refresh.refreshDevices()).toBe(1);
    expect(h.devices.get(booted.deviceId)?.lastUsedAt).toBe(42);
    expect(h.starts.get(booted.deviceId)).toBe(42);
    expect(h.calls).toEqual([
      "discover",
      "prune",
      "unsuppress",
      "track",
      "ready",
      "lift-recovery-images",
    ]);
  });

  test("a removal during discovery fences a stale addition", async () => {
    const h = harness();
    h.deferDiscovery();
    const pending = h.refresh.refreshDevices();
    await flushUntil(() => h.calls.includes("discover"));
    h.refresh.recordDeviceRemoval(booted.deviceId);
    h.resolveDiscovery();
    expect(await pending).toBe(0);
    expect(h.devices.has(booted.deviceId)).toBe(false);
    expect(h.refresh.getDeviceRemovalStampCountForTest()).toBe(0);
  });

  test("a newer refresh invalidates an older discovery snapshot", async () => {
    const h = harness();
    h.deferDiscovery();
    const stale = h.refresh.refreshDevices();
    await flushUntil(() => h.calls.includes("discover"));
    const fresh = h.refresh.refreshDevices();
    await flushUntil(() => h.calls.filter((call) => call === "discover").length === 2);
    h.resolveDiscovery();
    h.resolveDiscovery();
    expect(await stale).toBe(0);
    expect(await fresh).toBe(1);
    expect(h.calls.filter((call) => call === "track")).toHaveLength(1);
  });

  describe("the rejected-kill fence (#9626) and the unconfirmed recovery reservation (#10076)", () => {
    const image = { name: "Pixel", platform: "android" as const, isRunning: false };
    const pooled = (device: BootedDevice): PooledDevice => ({
      id: device.deviceId,
      name: device.name,
      platform: "android",
      avdName: device.name,
      sessionId: null,
      status: "idle",
      lastUsedAt: 0,
      assignmentCount: 0,
      errorCount: 0,
      incarnation: 1,
    });
    const android = (...devices: BootedDevice[]): BootedDeviceDiscovery => ({
      devices,
      succeededPlatforms: new Set<Platform>(["android"]),
    });
    const wired = () => {
      const recovery = recoveryCoordinatorHarness();
      const h = harness(undefined, (discovery, generation) =>
        recovery.coordinator.liftUnconfirmedRecoveringAndroidImages(discovery, generation),
      );
      recovery.coordinator.setRecoveringAndroidImage("Pixel", image);
      recovery.coordinator.finishAndroidRecoveryAttempt(
        "Pixel",
        new Set([booted.deviceId]),
        true,
        Symbol("attempt"),
      );
      return { ...h, recovery };
    };
    const fenceRejectedKill = (h: ReturnType<typeof wired>, device: BootedDevice) => {
      h.devices.set(device.deviceId, pooled(device));
      h.intentional.set(device.deviceId, 1);
      h.settled.set(device.deviceId, { incarnation: 1, refreshGeneration: 0 });
    };

    test("one fresh observation lifts each once, and neither lift touches a later owner", async () => {
      const h = wired();
      fenceRejectedKill(h, booted);
      await h.refresh.refreshDevicesInternal(false);
      expect(h.intentional.size).toBe(0);
      expect(h.settled.size).toBe(0);
      expect(h.recovery.coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);

      // New owners of the same serial and AVD appear; a second observation has
      // nothing of theirs to lift (no settled kill, no unconfirmed entry).
      h.intentional.set(booted.deviceId, 1);
      h.recovery.coordinator.setRecoveringAndroidImage("Pixel", image);
      await h.refresh.refreshDevicesInternal(false);
      expect(h.intentional.get(booted.deviceId)).toBe(1);
      expect(h.recovery.coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
    });

    test("a kill command that has not settled keeps its fence while the reservation still lifts", async () => {
      const h = wired();
      fenceRejectedKill(h, booted);
      h.settled.clear();
      await h.refresh.refreshDevicesInternal(false);
      expect(h.intentional.get(booted.deviceId)).toBe(1);
      expect(h.recovery.coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
    });

    test("an offline serial keeps the reservation while another device's fence lifts", async () => {
      const h = wired();
      const other: BootedDevice = { deviceId: "emulator-5556", name: "Other", platform: "android" };
      h.recovery.port.getAndroidOfflineDeviceIds = async () => new Set([booted.deviceId]);
      fenceRejectedKill(h, other);
      h.setDiscovery(android(other));
      await h.refresh.refreshDevicesInternal(false);
      expect(h.intentional.has(other.deviceId)).toBe(false);
      expect(h.recovery.coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
      expect(h.recovery.coordinator.findUnconfirmedRecoveringAndroidImage(["Pixel"])).toBe("Pixel");
    });
  });
});
