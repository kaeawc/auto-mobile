import { expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Pins the post-await replacement guard in DevicePool.rollbackAssignments (#11802). If a replacement
// session under the same id ever binds the same device while the rollback awaits
// sessionManager.releaseSession, releasing the device would strand that live session on an idle
// device. Every production assignment path holds assignmentMutex, which rollbackAssignments also
// holds across the await, so the guard is defense in depth behind that mutex; the test injects the
// interleaving directly. It is kept rather than deleted because the mutex is a convention, not a type.
const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const OTHER_DEVICE_ID = "emulator-5556";
const SESSION_ID = "rollback-session";

interface Context {
  timer: FakeTimer;
  manager: SessionManager;
  pool: DevicePool;
  allocated: Session;
}

async function createContext(): Promise<Context> {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [DEVICE];
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "rollback-guard-test", {
      timer,
      deviceManager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  await pool.initializeWithDevices([DEVICE]);
  await pool.bindOrReuseDeviceSession(SESSION_ID, DEVICE.deviceId, "android");
  return { timer, manager, pool, allocated: manager.getSession(SESSION_ID)! };
}

function dispose({ manager, timer }: Context): void {
  manager.stopCleanupTimer();
  timer.reset();
}

test("rollback releases the device when no replacement session appears", async () => {
  const context = await createContext();
  const { manager, pool, allocated } = context;
  try {
    await pool["rollbackAssignments"](
      new Map([[SESSION_ID, { deviceId: DEVICE.deviceId, session: allocated }]]),
    );

    expect(manager.getSession(SESSION_ID)).toBeNull();
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  } finally {
    dispose(context);
  }
});

test("rollback keeps the device bound when a replacement session binds it during the release await", async () => {
  const context = await createContext();
  const { manager, pool, allocated } = context;
  const originalRelease = manager.releaseSession.bind(manager);
  let replacement: Session | undefined;
  const releaseSpy = spyOn(manager, "releaseSession").mockImplementation(
    async (...args: Parameters<SessionManager["releaseSession"]>) => {
      const released = await originalRelease(...args);
      replacement = await manager.createSession(
        SESSION_ID,
        DEVICE.deviceId,
        "android",
        1_000,
        1_000,
      );
      return released;
    },
  );

  try {
    await pool["rollbackAssignments"](
      new Map([[SESSION_ID, { deviceId: DEVICE.deviceId, session: allocated }]]),
    );

    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(allocated);
    expect(manager.getSession(SESSION_ID)).toBe(replacement!);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
      status: "busy",
      sessionId: SESSION_ID,
    });
  } finally {
    releaseSpy.mockRestore();
    dispose(context);
  }
});

test("rollback still frees the device when the replacement session is bound to another device", async () => {
  const context = await createContext();
  const { manager, pool, allocated } = context;
  const originalRelease = manager.releaseSession.bind(manager);
  let replacement: Session | undefined;
  const releaseSpy = spyOn(manager, "releaseSession").mockImplementation(
    async (...args: Parameters<SessionManager["releaseSession"]>) => {
      const released = await originalRelease(...args);
      replacement = await manager.createSession(
        SESSION_ID,
        OTHER_DEVICE_ID,
        "android",
        1_000,
        1_000,
      );
      return released;
    },
  );

  try {
    await pool["rollbackAssignments"](
      new Map([[SESSION_ID, { deviceId: DEVICE.deviceId, session: allocated }]]),
    );

    expect(manager.getSession(SESSION_ID)).toBe(replacement!);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  } finally {
    releaseSpy.mockRestore();
    dispose(context);
  }
});
