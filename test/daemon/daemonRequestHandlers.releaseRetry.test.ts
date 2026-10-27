import { defaultTimer } from "../../src/utils/SystemTimer";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { registerScreenLockSessionCleanup } from "../../src/daemon/screenLockSessionCleanup";
import { registerPowerSessionCleanup } from "../../src/daemon/powerSessionCleanup";
import { AdbPowerClient } from "../../src/features/utility/power/AndroidPowerClient";
import { PowerRegistry } from "../../src/features/utility/power/PowerRegistry";
import { FakePowerAdb } from "../fakes/FakePowerAdb";
import { ScreenLockRegistry } from "../../src/features/utility/screenLock/ScreenLockRegistry";
import { logger } from "../../src/utils/logger";
import { FakeLockSettingsClient } from "../fakes/FakeLockSettingsClient";

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

  async function arrangeHarness(): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock ? "1" : "0";
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    barrier = new FakeDbWriteBarrier();
    manager = new SessionManager(timer, persistence, { barrier: () => barrier });
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
      : await pool.bindOrReuseDeviceSession({
          sessionId: explicitSessionId,
          deviceId,
          platform: "android",
        });
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    expect(pool.getDevice(deviceId)).toMatchObject({ sessionId, status: "busy" });
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

  function arrangedEach<T>(table: readonly T[]) {
    return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
      test.each<T>([...table])(
        name,
        async (row: T) => {
          await arrangeHarness();
          await fn(row);
        },
        timeout,
      );
    };
  }

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

  arranged("a healthy retry completes the fenced release", async () => {
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

  arranged(
    "repeated failure surfaces; expiry retains ownership until a healthy sweep frees once",
    async () => {
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
    },
  );

  arranged("expiry alone completes a failed explicit release and frees once", async () => {
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

  arrangedEach(["retry", "sweep"])("%s never frees a different owner", async (path) => {
    await failTerminalWrite();
    if (path === "sweep") {
      timer.advanceTime(24 * 3600_000);
    }
    // Model a newer pool assignment without exercising or altering rebind code.
    const replacementId = "00000000-0000-4000-8000-000000000002";
    await manager.createSession(replacementId, deviceId, "android");
    const device = pool.getDevice(deviceId)!;
    patchDeviceBinding(device, { sessionId: replacementId });
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

  arrangedEach([undefined, "restored_to_baseline", "failed"] as const)(
    "release result adds only a known keep-awake report (%s)",
    async (reported) => {
      const report = {
        status: reported ?? "restored_to_baseline",
        settings: [
          reported === "failed"
            ? { setting: "screen_off_timeout", error: "write rejected" }
            : { setting: "screen_off_timeout", value: "60000" },
        ],
      };
      const getter = spyOn(manager, "getKeepAwakeRestoreReport").mockImplementation(() => {
        expect(manager.hasSession(sessionId)).toBe(false);
        return reported ? report : undefined;
      });
      try {
        expect(await release()).toEqual({
          success: true,
          result: {
            message: `Session ${sessionId} released`,
            device: deviceId,
            alreadyReleased: false,
            ...(reported ? { keepAwakeRestore: report } : {}),
            ...(reported === "failed" ? { cleanup: "failed" } : {}),
          },
        });
        expect(await release()).toEqual({
          success: true,
          result: {
            message: `Session ${sessionId} already released${reported === "failed" ? "; cleanup failed" : ""}`,
            known: true,
            alreadyReleased: true,
            ...(reported ? { keepAwakeRestore: report } : {}),
            ...(reported === "failed" ? { cleanup: "failed" } : {}),
          },
        });
      } finally {
        getter.mockRestore();
      }
    },
  );

  arrangedEach(["screenLock", "power"] as const)(
    "already released reports pending %s cleanup",
    async (kind) => {
      await release();
      const cleanupTimer = new FakeTimer();
      const screenLock = new ScreenLockRegistry();
      const power = new PowerRegistry();
      if (kind === "screenLock") {
        screenLock.noteRestore(sessionId, new Promise(() => {}));
      } else {
        power.noteRestore(sessionId, new Promise(() => {}));
      }
      state = { ...state, getScreenLockRegistry: () => screenLock, getPowerRegistry: () => power };
      const timeout = spyOn(defaultTimer, "setTimeout").mockImplementation(
        cleanupTimer.setTimeout.bind(cleanupTimer),
      );
      const clear = spyOn(defaultTimer, "clearTimeout").mockImplementation(
        cleanupTimer.clearTimeout.bind(cleanupTimer),
      );
      cleanupTimer.enableAutoAdvance();
      try {
        const response = await release();
        expect(response).toMatchObject({
          success: true,
          result: {
            alreadyReleased: true,
            known: true,
            cleanup: "pending",
            message: `Session ${sessionId} already released; cleanup still pending`,
          },
        });
      } finally {
        timeout.mockRestore();
        clear.mockRestore();
      }
    },
  );

  arranged("a lock-screen clear that fails is reported in the release result", async () => {
    const registry = new ScreenLockRegistry();
    const client = new FakeLockSettingsClient({ type: "pin", credential: "1357" });
    client.nextResults.push({ outcome: "failed" }, { outcome: "failed" });
    const cleanupTimer = new FakeTimer();
    cleanupTimer.enableAutoAdvance();
    registerScreenLockSessionCleanup(manager, {
      registry,
      timer: cleanupTimer,
      clientFactory: () => client,
      forgetRememberedUnlock: async () => {},
    });
    registry.record({ deviceId, sessionId, type: "pin", credential: "1357" });
    state = { ...state, getScreenLockRegistry: () => registry };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const released = await release();
      expect(released).toMatchObject({
        success: true,
        result: { screenLockRestore: { status: "failed", deviceId, type: "pin" } },
      });
      expect(JSON.stringify(released)).not.toContain("1357");
      expect(await release()).toMatchObject({
        result: { alreadyReleased: true, screenLockRestore: { status: "failed" } },
      });
    } finally {
      warn.mockRestore();
    }
  });

  arranged("a power restore that fails is reported in the release result", async () => {
    const registry = new PowerRegistry();
    const adb = new FakePowerAdb();
    adb.failing.add("restrict-background false");
    const cleanupTimer = new FakeTimer();
    cleanupTimer.enableAutoAdvance();
    registerPowerSessionCleanup(manager, {
      registry,
      timer: cleanupTimer,
      clientFactory: () => new AdbPowerClient(adb),
    });
    registry.ensure(deviceId, sessionId).changed.push("dataSaver");
    state = { ...state, getPowerRegistry: () => registry };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await release()).toMatchObject({
        success: true,
        result: {
          powerRestore: {
            status: "failed",
            deviceId,
            fields: [{ field: "dataSaver", status: "failed" }],
          },
        },
      });
      expect(await release()).toMatchObject({
        result: { alreadyReleased: true, powerRestore: { status: "failed" } },
      });
    } finally {
      warn.mockRestore();
    }
  });

  arranged("normal release and genuinely absent retries remain idempotent", async () => {
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
