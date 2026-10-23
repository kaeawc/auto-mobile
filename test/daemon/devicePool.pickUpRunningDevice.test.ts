import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { makePool } from "../helpers/makePool";

const device: BootedDevice = {
  deviceId: "pickup-handset",
  name: "Stale name",
  platform: "android",
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function harness() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceUtils();
  const pool = makePool(sessions, "pickup-test", { timer, deviceManager: manager });
  cleanups.push(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });
  return { pool, manager };
}

function parkDiscovery(manager: FakeDeviceUtils) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = manager.getBootedDevicesDetailed.bind(manager);
  spyOn(manager, "getBootedDevicesDetailed").mockImplementation(async (...args) => {
    const snapshot = await original(...args);
    entered.resolve();
    await release.promise;
    return snapshot;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

test("pickup adds the fresh discovered record instead of the caller snapshot", async () => {
  const { pool, manager } = harness();
  manager.setBootedDevices("android", [{ ...device, name: "Fresh name" }]);
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)?.name).toBe("Fresh name");
  expect(pool.getDevice(device.deviceId)?.identityUnresolved).not.toBe(true);
});

test("pickup verifies iOS liveness from fresh discovery", async () => {
  const { pool, manager } = harness();
  const target: BootedDevice = { deviceId: "pickup-ios", name: "Fresh iPhone", platform: "ios" };
  manager.setBootedDevices("ios", [target]);
  await pool.pickUpRunningDevice({ ...target, name: "Stale iPhone" });
  expect(pool.getDevice(target.deviceId)?.name).toBe(target.name);
});

test("pickup refuses retained iOS presence from a failed discovery source", async () => {
  const { pool, manager } = harness();
  const target: BootedDevice = { deviceId: "pickup-ios", name: "iPhone", platform: "ios" };
  manager.setBootedDevices("ios", [target]);
  const retained = await manager.getBootedDevicesDetailed("ios");
  spyOn(manager, "getBootedDevicesDetailed").mockResolvedValue({
    ...retained,
    succeededPlatforms: new Set(),
    succeededSources: new Set(),
    freshDeviceIds: new Set(),
  });
  await expect(pool.pickUpRunningDevice(target)).rejects.toThrow("Unable to verify iOS");
  expect(pool.getDevice(target.deviceId)).toBeNull();
});

test("pickup refuses a device absent from fresh discovery", async () => {
  const { pool } = harness();
  await expect(pool.pickUpRunningDevice(device)).rejects.toBeInstanceOf(ActionableError);
  await expect(pool.pickUpRunningDevice(device)).rejects.toThrow("no longer running");
  expect(pool.getDevice(device.deviceId)).toBeNull();
});

test("pickup removal fence refuses retirement between discovery and insertion", async () => {
  const { pool, manager } = harness();
  manager.setBootedDevices("android", [device]);
  const gate = parkDiscovery(manager);
  const result = pool.pickUpRunningDevice(device).then(
    () => undefined,
    (error: unknown) => error,
  );
  await gate.entered;
  await pool.addDevice(device);
  await pool.removeDevice(device.deviceId);
  gate.release();
  expect(await result).toBeInstanceOf(ActionableError);
  expect(String(await result)).toContain("being shut down");
  expect(pool.getDevice(device.deviceId)).toBeNull();
  expect(pool.getDeviceRemovalStampCountForTest()).toBe(0);
});

for (const fence of ["reservation", "marker"] as const) {
  for (const timing of ["before pickup", "during discovery"] as const) {
    test(`pickup refuses shutdown ${fence} ${timing} and leaves no entry`, async () => {
      const { pool, manager } = harness();
      manager.setBootedDevices("android", [device]);
      const gate = timing === "during discovery" ? parkDiscovery(manager) : undefined;
      const result = gate
        ? pool.pickUpRunningDevice(device).then(
            () => undefined,
            (error: unknown) => error,
          )
        : undefined;
      if (gate) {
        await gate.entered;
      }
      await pool.addDevice(device);
      const reservation =
        fence === "reservation" ? await pool.reserveDeviceForShutdown(device.deviceId) : undefined;
      if (fence === "marker") {
        pool.markIntentionalShutdown(device.deviceId);
      }
      await pool.removeDevice(device.deviceId);
      try {
        gate?.release();
        if (result) {
          expect(await result).toBeInstanceOf(ActionableError);
          expect(String(await result)).toContain("being shut down");
        } else {
          await expect(pool.pickUpRunningDevice(device)).rejects.toThrow("being shut down");
        }
        expect(pool.getDevice(device.deviceId)).toBeNull();
      } finally {
        gate?.release();
        await reservation?.release();
      }
    });
  }
}

test("pickup is a no-op for an already pooled device", async () => {
  const { pool, manager } = harness();
  await pool.addDevice(device);
  const entry = pool.getDevice(device.deviceId);
  const discovery = spyOn(manager, "getBootedDevicesDetailed");
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)).toBe(entry);
  expect(discovery).not.toHaveBeenCalled();
});

test("pickup preserves an entry added while discovery was pending", async () => {
  const { pool, manager } = harness();
  manager.setBootedDevices("android", [device]);
  const gate = parkDiscovery(manager);
  const pickup = pool.pickUpRunningDevice(device);
  await gate.entered;
  await pool.addDevice({ ...device, name: "Concurrent entry" });
  const entry = pool.getDevice(device.deviceId);
  gate.release();
  await pickup;
  expect(pool.getDevice(device.deviceId)).toBe(entry);
  expect(entry?.name).toBe("Concurrent entry");
});

test("aborted pickup cannot publish after its discovery finishes", async () => {
  const { pool, manager } = harness();
  manager.setBootedDevices("android", [device]);
  const gate = parkDiscovery(manager);
  const controller = new AbortController();
  const result = pool.pickUpRunningDevice(device, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  await gate.entered;
  const reason = new Error("pickup cancelled");
  controller.abort(reason);
  expect(await result).toBe(reason);
  gate.release();
  expect(pool.getDevice(device.deviceId)).toBeNull();
});
