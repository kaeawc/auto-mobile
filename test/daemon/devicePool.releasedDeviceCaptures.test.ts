import { expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Pins the releasedDeviceCaptures fence (#11802): an explicit session release records which pooled
// device incarnation and assignment generation it owns, so the later caller-ordered pool release
// cannot snapshot and free a same-UUID replacement assignment.
const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const OTHER = { deviceId: "emulator-5556", name: "Pixel B", platform: "android" as const };
const HOLDER = "capture-holder";

async function createContext() {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [DEVICE, OTHER];
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "released-captures-test", {
      timer,
      deviceManager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  await pool.initializeWithDevices([DEVICE, OTHER]);
  await pool.bindOrReuseDeviceSession(HOLDER, DEVICE.deviceId, "android");
  const captures = pool["releasedDeviceCaptures"];
  return { timer, manager, pool, captures };
}

function dispose({ manager, timer }: Awaited<ReturnType<typeof createContext>>): void {
  manager.stopCleanupTimer();
  timer.reset();
}

test("a capture records the held device and its assignment generation", async () => {
  const context = await createContext();
  try {
    const { pool, captures } = context;
    pool["captureReleasedDevice"](HOLDER, DEVICE.deviceId);

    const device = pool.getDevice(DEVICE.deviceId)!;
    expect(captures.get(HOLDER)).toEqual({
      device,
      deviceId: DEVICE.deviceId,
      assignmentCount: device.assignmentCount,
    });
  } finally {
    dispose(context);
  }
});

test("a capture is not recorded for a session that does not hold the device", async () => {
  const context = await createContext();
  try {
    const { pool, captures } = context;
    pool["captureReleasedDevice"]("someone-else", DEVICE.deviceId);
    pool["captureReleasedDevice"](HOLDER, "missing-device");

    expect(captures.size).toBe(0);
  } finally {
    dispose(context);
  }
});

test("discarding a capture only removes the capture for the named device", async () => {
  const context = await createContext();
  try {
    const { pool, captures } = context;
    pool["captureReleasedDevice"](HOLDER, DEVICE.deviceId);

    pool["discardReleasedCapture"](HOLDER, OTHER.deviceId);
    expect(captures.has(HOLDER)).toBe(true);

    pool["discardReleasedCapture"](HOLDER, DEVICE.deviceId);
    expect(captures.has(HOLDER)).toBe(false);
  } finally {
    dispose(context);
  }
});

test("the pool release consumes the capture and frees the captured device exactly once", async () => {
  const context = await createContext();
  try {
    const { pool, captures } = context;
    pool["captureReleasedDevice"](HOLDER, DEVICE.deviceId);

    await pool.releaseDevice(DEVICE.deviceId, HOLDER);

    expect(captures.has(HOLDER)).toBe(false);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  } finally {
    dispose(context);
  }
});

test("the pool release does not free a same-UUID replacement assigned after the capture", async () => {
  const context = await createContext();
  try {
    const { pool, captures } = context;
    pool["captureReleasedDevice"](HOLDER, DEVICE.deviceId);
    // A same-UUID replacement assignment bumps the generation before the caller-ordered release.
    pool.getDevice(DEVICE.deviceId)!.assignmentCount++;

    await pool.releaseDevice(DEVICE.deviceId, HOLDER);

    expect(captures.has(HOLDER)).toBe(false);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: HOLDER });
  } finally {
    dispose(context);
  }
});

test("a capture recorded for a non-holder cannot block that session's later release", async () => {
  const context = await createContext();
  try {
    const { pool, manager } = context;
    pool["captureReleasedDevice"]("later-session", DEVICE.deviceId);
    await manager.releaseSession(HOLDER, "explicit-release");
    await pool.releaseDevice(DEVICE.deviceId, HOLDER);
    await pool.bindOrReuseDeviceSession("later-session", DEVICE.deviceId, "android");

    await pool.releaseDevice(DEVICE.deviceId, "later-session");

    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  } finally {
    dispose(context);
  }
});

test("device-loss release drops the capture the session release recorded (#11123)", async () => {
  const context = await createContext();
  try {
    const { pool, captures } = context;
    const device = pool.getDevice(DEVICE.deviceId)!;

    const released = await pool["releaseSessionForEvictedDevice"](device, undefined);

    expect(released).toBe(true);
    expect(device.sessionId).toBeNull();
    expect(captures.has(HOLDER)).toBe(false);
  } finally {
    dispose(context);
  }
});
