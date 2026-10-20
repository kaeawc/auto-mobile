import { makePool } from "../helpers/makePool";
import { expect, test } from "bun:test";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import {
  SessionManager,
  SessionTerminalReleaseInProgressError,
  type Session,
} from "../../src/daemon/sessionManager";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

// Pins the pooledSessionIdentities fence (#11802): the pool records which Session object it bound
// to a device incarnation, and shutdown reservation / autolock rollback trust only that object.
const ORIGINAL = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const REPLACEMENT = { deviceId: "emulator-5556", name: "Pixel R", platform: "android" as const };
const SESSION_ID = "identity-session";

interface Context {
  timer: FakeTimer;
  manager: SessionManager;
  pool: DevicePool;
  session: Session;
  original: PooledDevice;
  replacement: PooledDevice;
}

async function createContext(): Promise<Context> {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [ORIGINAL, REPLACEMENT];
  const pool = makePool(manager, "pooled-identity-test", {
    timer,
    deviceManager,
  });
  await pool.initializeWithDevices([ORIGINAL, REPLACEMENT]);
  await pool.bindOrReuseDeviceSession({
    sessionId: SESSION_ID,
    deviceId: ORIGINAL.deviceId,
    platform: "android",
  });
  const session = manager.getSession(SESSION_ID)!;
  return {
    timer,
    manager,
    pool,
    session,
    original: pool.getDevice(ORIGINAL.deviceId)!,
    replacement: pool.getDevice(REPLACEMENT.deviceId)!,
  };
}

function dispose({ manager, timer }: Context): void {
  manager.stopCleanupTimer();
  timer.reset();
}

test("a session bound through the pool is recorded as that device's identity", async () => {
  const context = await createContext();
  try {
    expect(context.pool.testHooks.pooledSessionIdentities.get(context.original)).toBe(
      context.session,
    );
    expect(context.pool.testHooks.reserveShutdownSessionIdentity(ORIGINAL.deviceId).session).toBe(
      context.session,
    );
  } finally {
    dispose(context);
  }
});

test("System UI ANR recovery moves the session identity to the replacement device", async () => {
  const context = await createContext();
  const { pool, session, original, replacement } = context;
  try {
    // System UI recovery reserves the session for terminal release before rebinding it.
    expect(pool.testHooks.reserveShutdownSessionIdentity(ORIGINAL.deviceId).session).toBe(session);
    await pool.testHooks.restoreSystemUiAnrRecoverySession(
      session,
      ORIGINAL.deviceId,
      replacement,
      undefined,
    );

    expect(session.assignedDevice).toBe(REPLACEMENT.deviceId);
    expect(pool.testHooks.pooledSessionIdentities.get(replacement)).toBe(session);
    // The replacement's identity is trusted: reserving it reaches the session, which is already
    // reserved for terminal release by the recovery above.
    expect(() => pool.testHooks.reserveShutdownSessionIdentity(REPLACEMENT.deviceId)).toThrow(
      SessionTerminalReleaseInProgressError,
    );
    // The original entry still maps to the session object, but the session has moved on.
    expect(pool.testHooks.pooledSessionIdentities.get(original)).toBe(session);
    expect(
      pool.testHooks.reserveShutdownSessionIdentity(ORIGINAL.deviceId).session,
    ).toBeUndefined();
  } finally {
    dispose(context);
  }
});

// Hands the autolock manager the pre-bind snapshot, as persistAcquiredAutolockSession does.
async function bindWithSnapshot(context: Context) {
  const { pool, manager } = context;
  const device = pool.getDevice(REPLACEMENT.deviceId)!;
  const snapshot = pool.testHooks.snapshotSessionAssignment(device);
  await pool.bindOrReuseDeviceSession({
    sessionId: "autolock-session",
    deviceId: REPLACEMENT.deviceId,
    platform: "android",
  });
  const session = manager.getSession("autolock-session")!;
  return { device, snapshot, session };
}

test("a cancelled autolock acquisition restores the device when the pool still holds its session", async () => {
  const context = await createContext();
  try {
    const { device, snapshot, session } = await bindWithSnapshot(context);
    expect(context.pool.testHooks.pooledSessionIdentities.get(device)).toBe(session);

    context.pool.testHooks.autolockManager["restoreCancelledAutolockAssignment"](
      device,
      session,
      snapshot,
    );

    expect(device).toMatchObject({ status: "idle", sessionId: null });
  } finally {
    dispose(context);
  }
});

test("a cancelled autolock acquisition does not roll back when no matching session identity is recorded", async () => {
  const context = await createContext();
  try {
    const { device, snapshot, session } = await bindWithSnapshot(context);
    // Models createSessionOrRestore returning early, which records no identity for the device.
    context.pool.testHooks.pooledSessionIdentities.delete(device);

    context.pool.testHooks.autolockManager["restoreCancelledAutolockAssignment"](
      device,
      session,
      snapshot,
    );

    expect(device).toMatchObject({ status: "busy", sessionId: "autolock-session" });
  } finally {
    dispose(context);
  }
});

test("shutdown identity completion ignores a recorded session that a same-id replacement superseded", async () => {
  const context = await createContext();
  const { pool, manager, session: stale, original } = context;
  try {
    // Non-terminal release reasons allow the UUID to be reused by a newer incarnation.
    await manager.releaseSession(SESSION_ID, "allocation-rollback");
    const live = await manager.createSession(SESSION_ID, ORIGINAL.deviceId, "android", {
      timeoutMs: 1_000,
      heartbeatTimeoutMs: 1_000,
    });
    expect(live).not.toBe(stale);
    expect(pool.testHooks.pooledSessionIdentities.get(original)).toBe(stale);
    const identity = pool.testHooks.reserveShutdownSessionIdentity(ORIGINAL.deviceId);
    expect(identity.session).toBeUndefined();

    pool.testHooks.completeShutdownSessionIdentity(ORIGINAL.deviceId, original, identity);

    expect(identity.session).toBeUndefined();
    expect(identity.releaseSession).toBeUndefined();
  } finally {
    dispose(context);
  }
});

test("an in-flight session creation is not captured for shutdown until the pool records it", async () => {
  const context = await createContext();
  const { pool, manager } = context;
  try {
    const creating = pool.bindOrReuseDeviceSession({
      sessionId: "creating-session",
      deviceId: REPLACEMENT.deviceId,
      platform: "android",
    });
    await drainUntil(() => manager.getSession("creating-session") !== null, {
      description: "creating-session to be published",
    });
    // Published in the session manager, but the pool has not validated or recorded it yet, so a
    // lookup derived from the session manager would capture it mid-creation.
    expect(pool.testHooks.pooledSessionIdentities.get(context.replacement)).toBeUndefined();
    expect(
      pool.testHooks.reserveShutdownSessionIdentity(REPLACEMENT.deviceId).session,
    ).toBeUndefined();

    await creating;
    expect(pool.testHooks.pooledSessionIdentities.get(context.replacement)).toBe(
      manager.getSession("creating-session")!,
    );
  } finally {
    dispose(context);
  }
});
