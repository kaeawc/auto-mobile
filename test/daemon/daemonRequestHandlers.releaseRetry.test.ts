import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const deviceId = "emulator-5554";
const explicitSessionId = "00000000-0000-4000-8000-000000000001";

describe.each([false, true])("terminal release retry (autolock=%s)", (autolock) => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let pool: DevicePool;
  let state: DaemonStateAccess;
  let sessionId: string;
  let previousAutolock: string | undefined;
  let barrier: FakeDbWriteBarrier;

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock ? "1" : "0";
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    barrier = new FakeDbWriteBarrier();
    manager = new SessionManager(timer, persistence, () => barrier);
    // Drive the sweep explicitly, rather than firing every periodic tick on advance.
    manager.stopCleanupTimer();
    const deviceManager = new FakeDeviceManager(
      [],
      [{ deviceId, name: "Pixel_8", platform: "android" }],
    );
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "release-retry", {
        timer,
        deviceManager,
        deviceSessionRepository: new FakeDeviceSessionRepository(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        idGenerator: new FakeIdGenerator(),
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      }),
    );
    await pool.initializeWithDevices(deviceManager.bootedDevices);
    sessionId = autolock
      ? (await pool.autolockDevice(deviceId, "android", "client"))!
      : await pool.bindOrReuseDeviceSession(explicitSessionId, deviceId, "android");
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    expect(pool.getDevice(deviceId)).toMatchObject({ sessionId, status: "busy" });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

  const release = (id = sessionId) =>
    handleDaemonRequest(
      {
        id: "release",
        type: "daemon_request",
        method: "daemon/releaseSession",
        params: { sessionId: id, requireKnown: true },
      },
      state,
    );

  async function failTerminalWrite(): Promise<void> {
    persistence.failure = "release";
    await expect(release()).rejects.toThrow("Failed to persist terminal release");
    expect(manager.hasSession(sessionId)).toBe(true);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(manager.getReleasingSession(sessionId)).toBeNull();
    expect(pool.getDevice(deviceId)).toMatchObject({ sessionId, status: "busy" });
  }

  async function sweep(): Promise<void> {
    const tracked = spyOn(barrier, "trackExisting");
    try {
      manager.cleanupExpiredSessions();
      await Promise.allSettled(tracked.mock.calls.map(([work]) => work));
    } finally {
      tracked.mockRestore();
    }
  }

  test("a healthy retry completes the fenced release", async () => {
    const free = spyOn(pool, "releaseDevice");
    try {
      await failTerminalWrite();
      expect(free).not.toHaveBeenCalled();
      persistence.failure = null;
      expect(await release()).toMatchObject({
        success: true,
        result: { device: deviceId, alreadyReleased: false },
      });
      expect(manager.hasSession(sessionId)).toBe(false);
      expect(pool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      expect(free).toHaveBeenCalledTimes(1);
      expect(await release()).toMatchObject({ success: true, result: { alreadyReleased: true } });
      expect(free).toHaveBeenCalledTimes(1);
    } finally {
      free.mockRestore();
    }
  });

  test("repeated failure surfaces; expiry retains ownership until a healthy sweep frees once", async () => {
    const free = spyOn(pool, "releaseDevice");
    try {
      await failTerminalWrite();
      await expect(release()).rejects.toThrow("Failed to persist terminal release");
      timer.advanceTime(24 * 3600_000);
      await sweep();
      expect(manager.hasSession(sessionId)).toBe(true);
      expect(pool.getDevice(deviceId)).toMatchObject({ sessionId, status: "busy" });
      expect(free).not.toHaveBeenCalled();
      persistence.failure = null;
      await sweep();
      expect(manager.hasSession(sessionId)).toBe(false);
      expect(pool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      expect(pool.getAvailableDeviceCount()).toBe(1);
      expect(free).toHaveBeenCalledTimes(1);
      await sweep();
      expect(await release()).toMatchObject({ result: { alreadyReleased: true } });
      expect(free).toHaveBeenCalledTimes(1);
    } finally {
      free.mockRestore();
    }
  });

  test("expiry alone completes a failed explicit release and frees once", async () => {
    const free = spyOn(pool, "releaseDevice");
    try {
      await failTerminalWrite();
      persistence.failure = null;
      timer.advanceTime(24 * 3600_000);
      await sweep();
      expect(manager.hasSession(sessionId)).toBe(false);
      expect(pool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      expect(free).toHaveBeenCalledTimes(1);
      await sweep();
      expect(free).toHaveBeenCalledTimes(1);
    } finally {
      free.mockRestore();
    }
  });

  test.each(["retry", "sweep"])("%s never frees a different owner", async (path) => {
    await failTerminalWrite();
    if (path === "sweep") {
      timer.advanceTime(24 * 3600_000);
    }
    // Model a newer pool assignment without exercising or altering rebind code.
    const replacementId = "00000000-0000-4000-8000-000000000002";
    await manager.createSession(replacementId, deviceId, "android");
    const device = pool.getDevice(deviceId)!;
    device.sessionId = replacementId;
    device.assignmentCount++;
    persistence.failure = null;
    if (path === "retry") {
      expect(await release()).toMatchObject({ success: true, result: { alreadyReleased: false } });
    } else {
      await sweep();
    }
    expect(manager.hasSession(sessionId)).toBe(false);
    expect(manager.hasSession(replacementId)).toBe(true);
    expect(pool.getDevice(deviceId)).toMatchObject({ sessionId: replacementId, status: "busy" });
  });

  test("normal release and genuinely absent retries remain idempotent", async () => {
    const free = spyOn(pool, "releaseDevice");
    try {
      expect(await release()).toMatchObject({
        success: true,
        result: { device: deviceId, alreadyReleased: false },
      });
      expect(manager.hasSession(sessionId)).toBe(false);
      expect(pool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      expect(await release()).toMatchObject({ success: true, result: { alreadyReleased: true } });
      // #11148: a UUID this daemon never issued is refused rather than reported as released.
      expect(await release("never-existed")).toMatchObject({
        success: false,
        code: "daemon_session_not_found",
      });
      expect(free).toHaveBeenCalledTimes(1);
    } finally {
      free.mockRestore();
    }
  });
});
