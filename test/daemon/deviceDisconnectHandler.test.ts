import { describe, expect, test } from "bun:test";
import {
  DeviceDisconnectHandler,
  INCARNATION_ANY,
  type DeviceDisconnectPoolPort,
} from "../../src/daemon/deviceDisconnectHandler";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import type { DeviceInfo } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

function pooledDevice(incarnation = 1): PooledDevice {
  return {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    avdName: "Pixel",
    androidImage: { name: "Pixel", platform: "android", isRunning: true },
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation,
  };
}

function discovery(names: string[], succeeded = true): BootedDeviceDiscovery {
  return {
    devices: names.map((name) => ({ deviceId: "emulator-5554", name, platform: "android" })),
    succeededPlatforms: new Set(succeeded ? ["android" as const] : []),
  };
}

function harness() {
  const timer = new FakeTimer();
  const device = pooledDevice();
  const devices = new Map([[device.id, device]]);
  const markers = new Map<string, number>();
  const events: string[] = [];
  let reserved = false;
  let recoveryEnabled = false;
  let rebootResult = false;
  let manager = { getBootedDevicesDetailed: async () => discovery([]) };
  const port: DeviceDisconnectPoolPort = {
    getPooledDevice: (id) => devices.get(id),
    getIntentionalShutdownMarker: (id) => markers.get(id),
    deleteIntentionalShutdownMarker: (id) => {
      events.push("marker-deleted");
      markers.delete(id);
    },
    isReservedForShutdown: () => reserved,
    removeDevice: async (_id, awaitCacheCleanup, expected) => {
      events.push(`remove:${awaitCacheCleanup}`);
      expect(devices.get(device.id)).toBe(expected);
      devices.delete(device.id);
    },
    finishEmulatorLossIncident: async (_id, outcome) => {
      events.push(`finish:${outcome}`);
    },
    recordEmulatorLossIncident: async () => {
      events.push("record");
      return "recorded";
    },
    shouldRebootDisconnectedAndroidDevice: () => recoveryEnabled,
    rebootDisconnectedAndroidDevice: async () => {
      events.push("reboot");
      return rebootResult;
    },
    settleEmulatorLossIncident: () => events.push("settle"),
    suppressAutoStartForDevice: () => events.push("suppress"),
    completeEmulatorLossRecovery: async (_id, outcome) => {
      events.push(`complete:${outcome}`);
    },
    getRecoveryPolicy: () => ({ onLoss: recoveryEnabled, maxAttempts: 2 }),
    isAndroidEmulatorActiveRelaunchEligible: (
      candidate,
    ): candidate is PooledDevice & { avdName: string; androidImage: DeviceInfo } =>
      candidate.platform === "android" &&
      typeof candidate.avdName === "string" &&
      candidate.androidImage !== undefined,
    getDeviceManager: () => manager,
    androidRediscoveryMatches: (candidate, id, avdName) =>
      candidate.deviceId === id && candidate.name === avdName,
  };
  return {
    timer,
    device,
    devices,
    markers,
    events,
    port,
    handler: new DeviceDisconnectHandler(port),
    reserve: () => {
      reserved = true;
    },
    enableRecovery: () => {
      recoveryEnabled = true;
    },
    setRebootResult: (result: boolean) => {
      rebootResult = result;
    },
    setManager: (next: typeof manager) => {
      manager = next;
    },
  };
}

describe("DeviceDisconnectHandler", () => {
  test("finishes a missing or mismatched incarnation without cleanup", async () => {
    const h = harness();
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident", pooledDevice(2));
    h.devices.delete(h.device.id);
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["finish:not-attempted", "finish:not-attempted"]);
  });

  test("defers a reserved or assigned device", async () => {
    const h = harness();
    h.reserve();
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["finish:not-attempted"]);
    const assigned = harness();
    assigned.device.sessionId = "session";
    await assigned.handler.removeDisconnectedDevice(assigned.device.id, false, "incident");
    expect(assigned.events).toEqual(["finish:not-attempted"]);
    expect(assigned.devices.get(assigned.device.id)).toBe(assigned.device);
  });

  test("consumes an intentional marker and removes only its captured incarnation", async () => {
    const h = harness();
    h.markers.set(h.device.id, INCARNATION_ANY);
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["marker-deleted", "remove:true", "finish:not-attempted"]);
    expect(h.markers.size).toBe(0);
  });

  test("retains an assigned intentional shutdown marker until release", async () => {
    const h = harness();
    h.device.sessionId = "session";
    h.markers.set(h.device.id, h.device.incarnation);
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.markers.get(h.device.id)).toBe(h.device.incarnation);
    expect(h.events).toEqual(["finish:not-attempted"]);
  });

  test("drops a prior incarnation's marker and cleans up the replacement", async () => {
    const h = harness();
    const replacement = pooledDevice(2);
    h.devices.set(h.device.id, replacement);
    h.markers.set(h.device.id, h.device.incarnation);
    await h.handler.removeDisconnectedDevice(h.device.id, false);
    expect(h.events).toEqual([
      "marker-deleted",
      "record",
      "reboot",
      "suppress",
      "complete:not-attempted",
      "remove:true",
      "settle",
    ]);
  });

  test("keeps a rediscovered device and reports unknown when discovery fails", async () => {
    const h = harness();
    h.enableRecovery();
    h.setManager({ getBootedDevicesDetailed: async () => discovery(["Pixel"]) });
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("recovered");
    await h.handler.removeDisconnectedDevice(h.device.id, true, "incident");
    expect(h.events).toEqual(["finish:not-attempted"]);
    h.setManager({ getBootedDevicesDetailed: async () => discovery([], false) });
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("unknown");
    expect(h.devices.get(h.device.id)).toBe(h.device);
  });

  test("retains an intentional marker when the stale signal still sees its AVD", async () => {
    const h = harness();
    h.enableRecovery();
    h.markers.set(h.device.id, h.device.incarnation);
    h.setManager({ getBootedDevicesDetailed: async () => discovery(["Pixel"]) });
    await h.handler.removeDisconnectedDevice(h.device.id, true, "incident");
    expect(h.markers.get(h.device.id)).toBe(h.device.incarnation);
    expect(h.events).toEqual(["finish:not-attempted"]);
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("recovered");
  });

  test("settles without removing a replacement installed during reboot", async () => {
    const h = harness();
    const replacement = pooledDevice(2);
    h.port.rebootDisconnectedAndroidDevice = async () => {
      h.events.push("reboot");
      h.devices.set(h.device.id, replacement);
      return false;
    };
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["reboot", "settle"]);
    expect(h.devices.get(h.device.id)).toBe(replacement);
  });

  test("does not complete an already-attempted failed recovery", async () => {
    const h = harness();
    h.enableRecovery();
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["reboot", "suppress", "remove:true", "settle"]);
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("recovered");
  });

  test("rechecks incarnation after a delayed stale-signal discovery", async () => {
    const h = harness();
    h.timer.enableAutoAdvance();
    h.enableRecovery();
    h.setManager({
      getBootedDevicesDetailed: async () => {
        await h.timer.sleep(5);
        return discovery([]);
      },
    });
    const cleanup = h.handler.removeDisconnectedDevice(h.device.id, true, "incident");
    const replacement = pooledDevice(2);
    h.devices.set(h.device.id, replacement);
    await cleanup;
    expect(h.devices.get(h.device.id)).toBe(replacement);
    expect(h.events).toEqual(["finish:not-attempted"]);
  });

  test("preserves record, reboot, completion, removal, and settlement order", async () => {
    const h = harness();
    await h.handler.removeDisconnectedDevice(h.device.id, false);
    expect(h.events).toEqual([
      "record",
      "reboot",
      "suppress",
      "complete:not-attempted",
      "remove:true",
      "settle",
    ]);
    const recovered = harness();
    recovered.enableRecovery();
    recovered.setRebootResult(true);
    await recovered.handler.removeDisconnectedDevice(recovered.device.id, false, "incident");
    expect(recovered.events).toEqual(["reboot", "settle"]);
    expect(recovered.devices.get(recovered.device.id)).toBe(recovered.device);
  });
});
