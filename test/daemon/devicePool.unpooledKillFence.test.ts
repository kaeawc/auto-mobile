import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS } from "../../src/daemon/unpooledShutdownFences";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { makePool } from "../helpers/makePool";

const device: BootedDevice = { deviceId: "unpooled-handset", name: "Handset", platform: "android" };
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
  manager.setBootedDevices("android", [device]);
  const pool = makePool(sessions, "unpooled-kill-test", { timer, deviceManager: manager });
  cleanups.push(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });
  return { pool, manager, timer };
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

test("pickup refuses an unpooled shutdown recorded during discovery", async () => {
  const { pool, manager } = harness();
  const gate = parkDiscovery(manager);
  const result = pool.pickUpRunningDevice(device).then(
    () => undefined,
    (error: unknown) => error,
  );
  await gate.entered;
  expect(
    await pool.reserveDeviceForShutdown(
      device.deviceId,
      undefined,
      undefined,
      undefined,
      undefined,
      { fenceUnpooled: true },
    ),
  ).toBeUndefined();
  gate.release();
  const error = await result;
  expect(error).toBeInstanceOf(ActionableError);
  expect(String(error)).toContain("being shut down");
  expect(pool.getDevice(device.deviceId)).toBeNull();
});

test("exact-device discovery refuses an unpooled shutdown recorded during discovery", async () => {
  const { pool, manager } = harness();
  const gate = parkDiscovery(manager);
  const result = pool
    .bindOrReuseDeviceSession({
      sessionId: "exact-session",
      deviceId: device.deviceId,
      platform: "android",
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await gate.entered;
  expect(
    await pool.reserveDeviceForShutdown(
      device.deviceId,
      undefined,
      undefined,
      undefined,
      undefined,
      { fenceUnpooled: true },
    ),
  ).toBeUndefined();
  gate.release();
  const error = await result;
  expect(error).toBeInstanceOf(ActionableError);
  expect(String(error)).toContain(
    `Device '${device.deviceId}' is not available in the device pool.`,
  );
  expect(pool.getDevice(device.deviceId)).toBeNull();
});

test("pickup refuses an active unpooled shutdown before discovery", async () => {
  const { pool, manager } = harness();
  expect(
    await pool.reserveDeviceForShutdown(
      device.deviceId,
      undefined,
      undefined,
      undefined,
      undefined,
      { fenceUnpooled: true },
    ),
  ).toBeUndefined();
  const discovery = spyOn(manager, "getBootedDevicesDetailed");
  await expect(pool.pickUpRunningDevice(device)).rejects.toThrow("being shut down");
  expect(discovery).toHaveBeenCalledTimes(0);
  expect(pool.getDevice(device.deviceId)).toBeNull();
});

test("pickup inserts after the unpooled shutdown fence expires", async () => {
  const { pool, timer } = harness();
  expect(
    await pool.reserveDeviceForShutdown(
      device.deviceId,
      undefined,
      undefined,
      undefined,
      undefined,
      { fenceUnpooled: true },
    ),
  ).toBeUndefined();
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(true);
  timer.advanceTime(31_000);
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(true);
  pool.settleUnpooledShutdown(device.deviceId);
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

test("clearIntentionalShutdown lifts an unpooled shutdown fence", async () => {
  const { pool } = harness();
  expect(
    await pool.reserveDeviceForShutdown(
      device.deviceId,
      undefined,
      undefined,
      undefined,
      undefined,
      { fenceUnpooled: true },
    ),
  ).toBeUndefined();
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(true);
  pool.clearIntentionalShutdown(device.deviceId);
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

test("pooled shutdown reserves the entry without an unpooled fence", async () => {
  const { pool } = harness();
  await pool.addDevice(device);
  const entry = pool.getDevice(device.deviceId)!;
  const reservation = await pool.reserveDeviceForShutdown(
    device.deviceId,
    undefined,
    undefined,
    undefined,
    undefined,
    { fenceUnpooled: true },
  );
  expect(reservation?.device).toBe(entry);
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(false);
  await reservation?.release();
});

test("unpooled recovery reservation without opt-in permits pickup", async () => {
  const { pool } = harness();
  expect(await pool.reserveDeviceForShutdown(device.deviceId)).toBeUndefined();
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(false);
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

test("unpooled recovery reservation without opt-in permits exact insertion", async () => {
  const { pool } = harness();
  expect(await pool.reserveDeviceForShutdown(device.deviceId)).toBeUndefined();
  await pool.bindOrReuseDeviceSession({
    sessionId: "recovery-session",
    deviceId: device.deviceId,
    platform: "android",
  });
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

test("refresh refuses an unpooled kill during discovery and admits after grace", async () => {
  const { pool, manager, timer } = harness();
  const gate = parkDiscovery(manager);
  const refresh = pool.refreshDevices();
  await gate.entered;
  await pool.reserveDeviceForShutdown(device.deviceId, undefined, undefined, undefined, undefined, {
    fenceUnpooled: true,
  });
  gate.release();
  expect(await refresh).toBe(0);
  expect(pool.getDevice(device.deviceId)).toBeNull();
  pool.settleUnpooledShutdown(device.deviceId);
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  expect(await pool.refreshDevices()).toBe(1);
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

test("refresh refuses a shutdown marker recorded during discovery", async () => {
  const { pool, manager } = harness();
  const gate = parkDiscovery(manager);
  const refresh = pool.refreshDevices();
  await gate.entered;
  pool.testHooks.intentionalShutdowns.set(device.deviceId, -1);
  gate.release();
  expect(await refresh).toBe(0);
  expect(pool.getDevice(device.deviceId)).toBeNull();
});

test("refresh still folds an existing pooled entry with a stale fence", async () => {
  const { pool, manager } = harness();
  await pool.reserveDeviceForShutdown(device.deviceId, undefined, undefined, undefined, undefined, {
    fenceUnpooled: true,
  });
  await pool.addDevice(device);
  manager.setBootedDevices("android", [{ ...device, name: "Updated handset", observedAt: 42 }]);
  await pool.refreshDevices();
  expect(pool.getDevice(device.deviceId)?.name).toBe("Updated handset");
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(true);
});

test("refresh remembers an entry-time marker cleared during discovery", async () => {
  const { pool, manager } = harness();
  pool.testHooks.intentionalShutdowns.set(device.deviceId, -1);
  const gate = parkDiscovery(manager);
  const refresh = pool.refreshDevices();
  await gate.entered;
  pool.testHooks.intentionalShutdowns.delete(device.deviceId);
  gate.release();
  expect(await refresh).toBe(0);
  expect(pool.getDevice(device.deviceId)).toBeNull();
});

test("a stale unpooled fence settler cannot shorten a newer shutdown", () => {
  const { pool, timer } = harness();
  const settleOld = pool.fenceUnpooledShutdown(device.deviceId);
  const settleCurrent = pool.fenceUnpooledShutdown(device.deviceId);
  settleOld();
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(true);
  settleCurrent();
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(false);
});
