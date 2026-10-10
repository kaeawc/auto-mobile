import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { Session, SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import * as daemonFilesModule from "../../src/daemon/daemonFiles";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import {
  KeepScreenAwakeManager,
  type KeepScreenAwakeState,
} from "../../src/utils/KeepScreenAwakeManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { BootedDevice } from "../../src/models";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

interface DaemonSocketServerInternals {
  socketServer: {
    quiesce(): Promise<void>;
    drainSessionReleaseNotifications(): Promise<void>;
    close(): Promise<void>;
  } | null;
}

interface DaemonReleaseInternals {
  cancelAndReleaseSession(
    sessionId: string,
    reason: string,
    allowExpired?: boolean,
    expectedSession?: Session,
    shouldCommit?: () => boolean,
  ): Promise<boolean>;
}

/**
 * Point a daemon-owned pool's discovery at a fake that lists exactly these
 * devices. A pooled Android entry is re-proved present against discovery before
 * it is handed out (handsets included), and the daemon builds its pool with the
 * real device manager, which would shell out to adb.
 */
function stubPoolDiscovery(devicePool: DevicePool, devices: BootedDevice[]): void {
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [...devices];
  Object.assign(devicePool, { deviceManager });
}

describe("Daemon shutdown session release (issue #5303)", () => {
  let appearanceSync: ReturnType<typeof spyOn>;
  // Daemon shutdown drains the process-wide write barrier. These unit tests mock
  // closeDatabase(), so reset that global explicitly to retain test isolation.
  beforeEach(async () => {
    resetDbWriteBarrier();
    appearanceSync = spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(
      undefined,
    );
    // daemon.stop() lists active recordings before closing the DB. Without a fake
    // repository that read reaches getDatabase(): the unit-test guard makes it
    // throw instantly, but a caller-exported AUTOMOBILE_DB_DIR stands the guard
    // down and the real file I/O outlives the FakeTimer-bounded cleanup stage.
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
  });

  afterEach(() => {
    resetVideoRecordingManagerDependencies();
    appearanceSync.mockRestore();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("retried release keeps the device busy and unclaimable during backoff", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const manager = daemon.getSessionManager();
    const pool = daemon.getDevicePool();
    // One allocation attempt proves another session cannot claim the busy device.
    Object.assign(pool, { DEVICE_WAIT_TIMEOUT_MS: 1000 });
    const device: BootedDevice = {
      name: "Physical Android",
      deviceId: "release-device",
      platform: "android",
    };
    const originalPersist = repository.markReleased.bind(repository);
    const persist = spyOn(repository, "markReleased")
      .mockImplementationOnce(async () => {
        throw new Error("first release persistence failed");
      })
      .mockImplementation(originalPersist);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const free = spyOn(pool, "releaseDevice");
    let retry: Promise<void> | undefined;
    try {
      stubPoolDiscovery(pool, [device]);
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("release-session", "android");
      retry = (
        pool as unknown as {
          releaseDisconnectedRecoverySessionWithRetry(
            id: string,
            device: string,
            reason: string,
          ): Promise<void>;
        }
      ).releaseDisconnectedRecoverySessionWithRetry(
        "release-session",
        device.deviceId,
        "device-restart:Physical Android",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(timer.getPendingSleeps()).toEqual([1000]);
      expect(manager.hasSession("release-session")).toBe(false);
      expect(pool.getDevice(device.deviceId)).toMatchObject({
        sessionId: "release-session",
        status: "busy",
      });
      await expect(pool.assignDeviceToSession("other-session", "android")).rejects.toThrow();
      expect(pool.getDevice(device.deviceId)?.sessionId).toBe("release-session");
      await timer.resolvePromise(retry, 1000);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(free).toHaveBeenCalledTimes(1);
      expect(pool.getDevice(device.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
    } finally {
      if (retry) {
        await timer.resolvePromise(retry, 1000);
      }
      free.mockRestore();
      persist.mockRestore();
      warn.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test("exhausted release retries free the removed session's device exactly once", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const manager = daemon.getSessionManager();
    const pool = daemon.getDevicePool();
    const device: BootedDevice = {
      name: "Physical Android",
      deviceId: "release-device",
      platform: "android",
    };
    const persist = spyOn(repository, "markReleased").mockRejectedValue(
      new Error("persistence unavailable"),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const free = spyOn(pool, "releaseDevice");
    const originalRelease = manager.releaseSession.bind(manager);
    let originalError: unknown;
    const release = spyOn(manager, "releaseSession").mockImplementation(async (...args) => {
      try {
        return await originalRelease(...args);
      } catch (error) {
        originalError = error;
        throw error;
      }
    });
    try {
      stubPoolDiscovery(pool, [device]);
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("release-session", "android");
      const retry = (
        pool as unknown as {
          releaseDisconnectedRecoverySessionWithRetry(
            id: string,
            device: string,
            reason: string,
          ): Promise<void>;
        }
      ).releaseDisconnectedRecoverySessionWithRetry(
        "release-session",
        device.deviceId,
        "device-restart:Physical Android",
      );
      const outcome = retry.then(
        () => undefined,
        (error: unknown) => error,
      );
      for (let attempt = 1; attempt < 3; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(persist).toHaveBeenCalledTimes(attempt);
        expect(timer.getPendingSleeps()).toEqual([1000]);
        expect(pool.getDevice(device.deviceId)).toMatchObject({
          sessionId: "release-session",
          status: "busy",
        });
        expect(free).not.toHaveBeenCalled();
        timer.advanceTime(1000);
      }
      expect(await outcome).toBe(originalError);
      expect(originalError).toBeDefined();
      expect(persist).toHaveBeenCalledTimes(3);
      expect(free).toHaveBeenCalledTimes(1);
      expect(pool.getDevice(device.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
    } finally {
      release.mockRestore();
      persist.mockRestore();
      free.mockRestore();
      warn.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test.each(["idle", "other-session"])(
    "attempt two skips a device now %s without a warning or success log",
    async (owner) => {
      const timer = new FakeTimer();
      const repository = new FakeDeviceSessionRepository();
      const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
      const manager = daemon.getSessionManager();
      const pool = daemon.getDevicePool();
      const device: BootedDevice = {
        name: "Physical Android",
        deviceId: "release-device",
        platform: "android",
      };
      const originalPersist = repository.markReleased.bind(repository);
      const persist = spyOn(repository, "markReleased")
        .mockImplementationOnce(async () => {
          throw new Error("first release failed");
        })
        .mockImplementation(originalPersist);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const info = spyOn(logger, "info").mockImplementation(() => {});
      const free = spyOn(pool, "releaseDevice");
      const cancel = spyOn(daemon as unknown as DaemonReleaseInternals, "cancelAndReleaseSession");
      try {
        stubPoolDiscovery(pool, [device]);
        await pool.initializeWithDevices([device]);
        await pool.assignDeviceToSession("release-session", "android");
        const retry = (
          pool as unknown as {
            releaseDisconnectedRecoverySessionWithRetry(
              id: string,
              device: string,
              reason: string,
            ): Promise<void>;
          }
        ).releaseDisconnectedRecoverySessionWithRetry(
          "release-session",
          device.deviceId,
          "device-restart:Physical Android",
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(timer.getPendingSleeps()).toEqual([1000]);
        const pooled = pool.getDevice(device.deviceId)!;
        pooled.sessionId = owner === "idle" ? null : owner;
        pooled.status = owner === "idle" ? "idle" : "busy";
        pooled.assignmentCount++;
        warn.mockClear();
        info.mockClear();
        await timer.resolvePromise(retry, 1000);
        expect(persist).toHaveBeenCalledTimes(2);
        expect(await cancel.mock.results[1].value).toBe(false);
        expect(free).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(
          info.mock.calls.some(([message]) => String(message).includes("and released device")),
        ).toBe(false);
        expect(pooled).toMatchObject({
          sessionId: owner === "idle" ? null : owner,
          status: owner === "idle" ? "idle" : "busy",
        });
      } finally {
        cancel.mockRestore();
        persist.mockRestore();
        free.mockRestore();
        warn.mockRestore();
        info.mockRestore();
        manager.stopCleanupTimer();
      }
    },
  );

  test("daemon fallback pool failure warns and preserves the original release error", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const manager = daemon.getSessionManager();
    const pool = daemon.getDevicePool();
    const device: BootedDevice = {
      name: "Physical Android",
      deviceId: "release-device",
      platform: "android",
    };
    const persist = spyOn(repository, "markReleased").mockRejectedValue(
      new Error("persistence failed"),
    );
    const poolError = new Error("fallback failed");
    const free = spyOn(pool, "releaseDevice").mockRejectedValue(poolError);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const originalRelease = manager.releaseSession.bind(manager);
    let originalError: unknown;
    const release = spyOn(manager, "releaseSession").mockImplementation(async (...args) => {
      try {
        return await originalRelease(...args);
      } catch (error) {
        originalError = error;
        throw error;
      }
    });
    try {
      stubPoolDiscovery(pool, [device]);
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("release-session", "android");
      const result = (daemon as unknown as DaemonReleaseInternals).cancelAndReleaseSession(
        "release-session",
        "device-restart:Physical Android",
      );
      await expect(result).rejects.toThrow("Failed to persist non-terminal release");
      await expect(result).rejects.toBe(originalError);
      expect(manager.hasSession("release-session")).toBe(false);
      expect(free).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "Failed to free device release-device after session release-session release",
        poolError,
      );
    } finally {
      release.mockRestore();
      persist.mockRestore();
      free.mockRestore();
      warn.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test.each(["ordinary", "owned", "conditional"] as const)(
    "release persistence failure respects the real caller reason: %s",
    async (branch) => {
      const repository = new FakeDeviceSessionRepository();
      const daemon = new Daemon({}, new FakeInstalledAppsRepository(), new FakeTimer(), repository);
      const manager = daemon.getSessionManager();
      const pool = daemon.getDevicePool();
      const device: BootedDevice = {
        name: "Physical Android",
        deviceId: "release-device",
        platform: "android",
      };
      const failure = new Error("release persistence failed after removal");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const persist = spyOn(repository, "markReleased").mockImplementation(async () => {
        expect(manager.hasSession("release-session")).toBe(branch !== "ordinary");
        throw failure;
      });
      const originalRelease = manager.releaseSession.bind(manager);
      let reportedError: unknown;
      const release = spyOn(manager, "releaseSession").mockImplementation(async (...args) => {
        try {
          return await originalRelease(...args);
        } catch (error) {
          reportedError = error;
          throw error;
        }
      });
      try {
        stubPoolDiscovery(pool, [device]);
        await pool.initializeWithDevices([device]);
        await pool.assignDeviceToSession("release-session", "android");
        const session = manager.getSession("release-session");
        if (!session) {
          throw new Error("expected session");
        }
        const result = (daemon as unknown as DaemonReleaseInternals).cancelAndReleaseSession(
          "release-session",
          branch === "ordinary" ? "daemon-shutdown" : "device-disconnected:release-device",
          false,
          branch === "owned" ? session : undefined,
          branch === "conditional" ? () => true : undefined,
        );
        if (branch === "ordinary") {
          // Shutdown is non-terminal: the manager logs failed persistence and
          // completes removal. Disconnect reasons retain a terminal fence.
          expect(await result).toBe(true);
          expect(pool.getDevice(device.deviceId)).toMatchObject({
            sessionId: null,
            status: "idle",
          });
        } else {
          await expect(result).rejects.toThrow("Failed to persist terminal release");
          await expect(result).rejects.toBe(reportedError);
          expect(reportedError).toBeDefined();
          expect(pool.getDevice(device.deviceId)).toMatchObject({
            sessionId: "release-session",
            status: "busy",
          });
        }
        expect(manager.hasSession("release-session")).toBe(branch !== "ordinary");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      } finally {
        release.mockRestore();
        persist.mockRestore();
        warn.mockRestore();
        manager.stopCleanupTimer();
      }
    },
  );

  test.each(["ordinary", "owned", "conditional"] as const)(
    "successful daemon release frees its device: %s",
    async (branch) => {
      const daemon = new Daemon(
        {},
        new FakeInstalledAppsRepository(),
        new FakeTimer(),
        new FakeDeviceSessionRepository(),
      );
      const manager = daemon.getSessionManager();
      const pool = daemon.getDevicePool();
      const device: BootedDevice = {
        name: "Physical Android",
        deviceId: "release-device",
        platform: "android",
      };
      try {
        stubPoolDiscovery(pool, [device]);
        await pool.initializeWithDevices([device]);
        await pool.assignDeviceToSession("release-session", "android");
        const session = manager.getSession("release-session");
        if (!session) {
          throw new Error("expected session");
        }
        expect(
          await (daemon as unknown as DaemonReleaseInternals).cancelAndReleaseSession(
            "release-session",
            "explicit-release",
            false,
            branch === "owned" ? session : undefined,
            branch === "conditional" ? () => true : undefined,
          ),
        ).toBe(true);
        expect(manager.hasSession("release-session")).toBe(false);
        expect(pool.getDevice(device.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      } finally {
        manager.stopCleanupTimer();
      }
    },
  );

  test("persistence failure keeps device ownership for a newer same-UUID incarnation", async () => {
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), new FakeTimer(), repository);
    const manager = daemon.getSessionManager();
    const pool = daemon.getDevicePool();
    const device: BootedDevice = {
      name: "Physical Android",
      deviceId: "release-device",
      platform: "android",
    };
    let original: Session;
    const persist = spyOn(repository, "markReleased").mockImplementation(async () => {
      expect(manager.hasSession("release-session")).toBe(false);
      // Model a replacement publishing after removal without waiting on the
      // old incarnation's in-flight release promise from createSession().
      (manager as unknown as { sessions: Map<string, Session> }).sessions.set("release-session", {
        ...original,
      });
      throw new Error("old incarnation persistence failed");
    });
    const free = spyOn(pool, "releaseDevice");
    try {
      stubPoolDiscovery(pool, [device]);
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("release-session", "android");
      const session = manager.getSession("release-session");
      if (!session) {
        throw new Error("expected session");
      }
      original = session;
      await expect(
        (daemon as unknown as DaemonReleaseInternals).cancelAndReleaseSession(
          "release-session",
          "device-restart:test",
        ),
      ).rejects.toThrow("old incarnation persistence failed");
      expect(manager.hasSession("release-session")).toBe(true);
      expect(manager.getSession("release-session")).not.toBe(original);
      expect(free).not.toHaveBeenCalled();
      expect(pool.getDevice(device.deviceId)).toMatchObject({
        sessionId: "release-session",
        status: "busy",
      });
    } finally {
      free.mockRestore();
      persist.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test("waits for pending device cleanup before closing the database", async () => {
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      new FakeTimer(),
      new FakeDeviceSessionRepository(),
    );
    const cleanup = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const events: string[] = [];
    const drain = daemon
      .getSessionManager()
      .drainPendingDeviceCleanups.bind(daemon.getSessionManager());
    const drainSpy = spyOn(
      daemon.getSessionManager(),
      "drainPendingDeviceCleanups",
    ).mockImplementation(async (timeoutMs) => {
      cleanupStarted.resolve();
      const result = await drain(timeoutMs);
      events.push("cleanup settled");
      return result;
    });
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      events.push("database closed");
    });
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    try {
      daemon.getSessionManager().registerPendingDeviceCleanup("sim-dirty", cleanup.promise);
      const stopping = daemon.stop();
      await cleanupStarted.promise;
      expect(events).toEqual([]);

      cleanup.resolve();
      await stopping;
      expect(events).toEqual(["cleanup settled", "database closed"]);
    } finally {
      cleanup.resolve();
      drainSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("continues shutdown when pending device cleanup exceeds its deadline", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const cleanup = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const drain = daemon
      .getSessionManager()
      .drainPendingDeviceCleanups.bind(daemon.getSessionManager());
    const drainSpy = spyOn(
      daemon.getSessionManager(),
      "drainPendingDeviceCleanups",
    ).mockImplementation(async (timeoutMs) => {
      cleanupStarted.resolve();
      return await drain(timeoutMs);
    });
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined);
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    try {
      daemon.getSessionManager().registerPendingDeviceCleanup("sim-dirty", cleanup.promise);
      const stopping = daemon.stop();
      await cleanupStarted.promise;
      timer.advanceTime(2_000);

      await stopping;
      expect(drainSpy).toHaveReturned();
      expect(closeDatabaseSpy).toHaveBeenCalledTimes(1);
      expect(daemon.getSessionManager().getPendingDeviceCleanup("sim-dirty")).not.toBeNull();
    } finally {
      cleanup.resolve();
      drainSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("releases active sessions before closing the database", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const sessionId = "shutdown-session";
    const deviceId = "physical-device";
    const keepAwakeState: KeepScreenAwakeState = {
      applied: true,
      method: "settings",
      originalStayOnWhilePluggedIn: "0",
      originalScreenOffTimeout: "60000",
      appliedSettings: { stayOnWhilePluggedIn: true, screenOffTimeout: true },
    };
    const releasedCallbacks: Array<{ sessionId: string; deviceId: string }> = [];
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore").mockResolvedValue(
      undefined,
    );
    const releaseDeviceSpy = spyOn(devicePool, "releaseDevice");
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      repository.events.push("closeDatabase");
    });

    try {
      const pooledDevices: BootedDevice[] = [
        { name: "Physical Android", deviceId, platform: "android" },
      ];
      stubPoolDiscovery(devicePool, pooledDevices);
      await devicePool.initializeWithDevices(pooledDevices);
      await devicePool.assignDeviceToSession(sessionId, "android");
      sessionManager.setKeepScreenAwake(sessionId, keepAwakeState);
      sessionManager.onSessionRelease((releasedSessionId, releasedDeviceId) => {
        releasedCallbacks.push({ sessionId: releasedSessionId, deviceId: releasedDeviceId });
      });

      await daemon.stop();

      expect(restoreSpy).toHaveBeenCalledWith(keepAwakeState);
      expect(releasedCallbacks).toContainEqual({ sessionId, deviceId });
      expect(releaseDeviceSpy).toHaveBeenCalledWith(deviceId, sessionId);
      expect(sessionManager.getSession(sessionId)).toBeNull();
      expect(devicePool.getDevice(deviceId)).toMatchObject({
        sessionId: null,
        status: "idle",
      });
      expect(repository.sessions.get(sessionId)).toMatchObject({
        status: "released",
        releasedAtMs: timer.now(),
        reason: "daemon-shutdown",
      });
      expect(repository.events).toEqual(["markReleased", "closeDatabase"]);
    } finally {
      restoreSpy.mockRestore();
      releaseDeviceSpy.mockRestore();
      loggerCloseSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
    }
  });

  test("stops a managed ADB server after releasing active sessions", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env,
      async () => {
        repository.events.push("stopManagedAdbServer");
      },
    );
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      repository.events.push("closeDatabase");
    });

    try {
      const pooledDevices: BootedDevice[] = [
        { name: "Managed Android", deviceId: "managed-physical-device", platform: "android" },
      ];
      stubPoolDiscovery(devicePool, pooledDevices);
      await devicePool.initializeWithDevices(pooledDevices);
      await devicePool.assignDeviceToSession("managed-adb-session", "android");

      await daemon.stop();

      expect(sessionManager.getSession("managed-adb-session")).toBeNull();
      expect(repository.events).toEqual(["markReleased", "stopManagedAdbServer", "closeDatabase"]);
    } finally {
      loggerCloseSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
    }
  });

  test("continues releasing other sessions when one teardown fails", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const brokenSessionId = "broken-shutdown-session";
    const healthySessionId = "healthy-shutdown-session";
    const originalRelease = sessionManager.releaseSession.bind(sessionManager);
    const releaseSpy = spyOn(sessionManager, "releaseSession").mockImplementation(
      async (sessionId, reason) => {
        if (sessionId === brokenSessionId) {
          throw new Error("simulated release failure");
        }
        return await originalRelease(sessionId, reason);
      },
    );
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await sessionManager.createSession(brokenSessionId, "broken-device", "android");
      await sessionManager.createSession(healthySessionId, "healthy-device", "android");

      await expect(daemon.stop()).resolves.toBeUndefined();

      expect(releaseSpy).toHaveBeenCalledWith(brokenSessionId, "daemon-shutdown", true);
      expect(releaseSpy).toHaveBeenCalledWith(healthySessionId, "daemon-shutdown", true);
      expect(sessionManager.getSession(healthySessionId)).toBeNull();
      expect(repository.sessions.get(healthySessionId)).toMatchObject({
        status: "released",
        reason: "daemon-shutdown",
      });
    } finally {
      releaseSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("continues releasing remaining sessions when restoration fails", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const brokenSessionId = "broken-shutdown-session";
    const healthySessionId = "healthy-shutdown-session";
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore")
      .mockRejectedValueOnce(new Error("simulated restore failure"))
      .mockResolvedValue(undefined);
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      const pooledDevices: BootedDevice[] = [
        { name: "Broken Android", deviceId: "broken-device", platform: "android" },
        { name: "Healthy Android", deviceId: "healthy-device", platform: "android" },
      ];
      stubPoolDiscovery(devicePool, pooledDevices);
      await devicePool.initializeWithDevices(pooledDevices);
      await devicePool.assignDeviceToSession(brokenSessionId, "android");
      await devicePool.assignDeviceToSession(healthySessionId, "android");
      sessionManager.setKeepScreenAwake(brokenSessionId, {
        applied: true,
        method: "svc",
        svcWasEnabled: false,
      });
      sessionManager.setKeepScreenAwake(healthySessionId, {
        applied: true,
        method: "svc",
        svcWasEnabled: false,
      });

      let stopped = false;
      const stopping = daemon.stop().then(() => {
        stopped = true;
      });
      // The failed restore is retried after a FakeTimer delay before the device is freed (#11145).
      for (let tick = 0; tick < 20 && !stopped; tick++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await timer.advanceTimeAsync(250);
      }
      await expect(stopping).resolves.toBeUndefined();

      expect(restoreSpy).toHaveBeenCalledTimes(3);
      expect(sessionManager.getSession(brokenSessionId)).toBeNull();
      expect(sessionManager.getSession(healthySessionId)).toBeNull();
      expect(repository.sessions.get(brokenSessionId)).toMatchObject({
        status: "released",
        reason: "daemon-shutdown",
      });
      expect(repository.sessions.get(healthySessionId)).toMatchObject({
        status: "released",
        reason: "daemon-shutdown",
      });
    } finally {
      restoreSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("publishes each concurrent bound-session shutdown before closing the control socket (#6336)", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const events: string[] = [];
    const stopAcceptingSessionCreations =
      sessionManager.stopAcceptingSessionCreations.bind(sessionManager);
    const stopAcceptingSessionCreationsSpy = spyOn(
      sessionManager,
      "stopAcceptingSessionCreations",
    ).mockImplementation(() => {
      events.push("session:fence");
      stopAcceptingSessionCreations();
    });
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      events.push(`release:${sessionId}:${reason}`);
    });
    (daemon as unknown as DaemonSocketServerInternals).socketServer = {
      quiesce: async () => {
        events.push("socket:quiesce");
      },
      drainSessionReleaseNotifications: async () => {
        events.push("socket:drain-releases");
      },
      close: async () => {
        events.push("socket:close");
      },
    };
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await sessionManager.createSession("session-a", "emulator-5554", "android");
      await sessionManager.createSession("session-b", "emulator-5556", "android");

      await daemon.stop();

      expect(events[0]).toBe("socket:quiesce");
      expect(events[1]).toBe("session:fence");
      expect(events.filter((event) => event === "release:session-a:daemon-shutdown")).toHaveLength(
        1,
      );
      expect(events.filter((event) => event === "release:session-b:daemon-shutdown")).toHaveLength(
        1,
      );
      const drainIndex = events.indexOf("socket:drain-releases");
      expect(drainIndex).toBeGreaterThan(events.indexOf("release:session-a:daemon-shutdown"));
      expect(drainIndex).toBeGreaterThan(events.indexOf("release:session-b:daemon-shutdown"));
      expect(events.indexOf("socket:close")).toBeGreaterThan(drainIndex);
      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSession("session-b")).toBeNull();
    } finally {
      unsubscribe();
      stopAcceptingSessionCreationsSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("rejects a session creation that outlives control-socket quiescence (#6336)", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const continueAcquisition = Promise.withResolvers<void>();
    const lateCreation = (async () => {
      await continueAcquisition.promise;
      return await sessionManager.createSession(
        "late-shutdown-session",
        "emulator-5558",
        "android",
      );
    })();
    const lateCreationOutcome = lateCreation.then(
      () => undefined,
      (error: unknown) => error,
    );
    (daemon as unknown as DaemonSocketServerInternals).socketServer = {
      quiesce: async () => {
        continueAcquisition.resolve();
        await Promise.resolve();
      },
      drainSessionReleaseNotifications: async () => {},
      close: async () => {},
    };
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await daemon.stop();

      expect(await lateCreationOutcome).toEqual(
        expect.objectContaining({
          message:
            "Cannot create device session late-shutdown-session: the daemon is shutting down.",
        }),
      );
      expect(sessionManager.getSession("late-shutdown-session")).toBeNull();
      expect(repository.sessions.has("late-shutdown-session")).toBe(false);
    } finally {
      loggerCloseSpy.mockRestore();
    }
  });

  test("bounds shutdown while a pending assignment cannot settle (#6336)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const finishAssignment = Promise.withResolvers<void>();
    const assignmentStarted = Promise.withResolvers<void>();
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(): Promise<string> {
        assignmentStarted.resolve();
        await finishAssignment.promise;
        throw new Error("assignment stopped with daemon");
      },
    };
    const assignment = sessionManager.getOrCreateSession("pending-shutdown-assignment", devicePool);
    const assignmentOutcome = assignment.catch((error: unknown) => error);
    await assignmentStarted.promise;
    const events: string[] = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      events.push(`release:${sessionId}:${reason}`);
    });
    (daemon as unknown as DaemonSocketServerInternals).socketServer = {
      quiesce: async () => {},
      drainSessionReleaseNotifications: async () => {
        events.push("socket:drain-releases");
      },
      close: async () => {
        events.push("socket:close");
      },
    };
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await daemon.stop();

      const fallback = "release:pending-shutdown-assignment:daemon-shutdown";
      expect(events.filter((event) => event === fallback)).toHaveLength(1);
      expect(events.indexOf("socket:drain-releases")).toBeGreaterThan(events.indexOf(fallback));
      expect(events.indexOf("socket:close")).toBeGreaterThan(
        events.indexOf("socket:drain-releases"),
      );
    } finally {
      finishAssignment.resolve();
      await assignmentOutcome;
      unsubscribe();
      loggerCloseSpy.mockRestore();
    }
  });

  test("drains a monitor release that removed its session before shutdown snapshots it", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    let allowPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      allowPersistence = resolve;
    });
    let persistenceStarted!: () => void;
    const persistenceStartedPromise = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const originalMarkReleased = repository.markReleased.bind(repository);
    const markReleasedSpy = spyOn(repository, "markReleased").mockImplementation(
      async (...args) => {
        persistenceStarted();
        await persistence;
        await originalMarkReleased(...args);
      },
    );
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      repository.events.push("closeDatabase");
    });
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await sessionManager.createSession("in-flight-session", "in-flight-device", "android");
      const release = sessionManager.releaseSession("in-flight-session", "heartbeat");
      await persistenceStartedPromise;

      const stop = daemon.stop();
      await Promise.resolve();
      expect(closeDatabaseSpy).not.toHaveBeenCalled();

      allowPersistence();
      await release;
      await stop;
      expect(repository.events).toEqual(["markReleased", "closeDatabase"]);
    } finally {
      markReleasedSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("publishes a shutdown fallback when terminal persistence outlives the drain (#6336)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const events: string[] = [];
    const persistence = Promise.withResolvers<void>();
    const persistenceStarted = Promise.withResolvers<void>();
    const originalMarkReleased = repository.markReleased.bind(repository);
    const markReleasedSpy = spyOn(repository, "markReleased").mockImplementation(
      async (...args) => {
        persistenceStarted.resolve();
        await persistence.promise;
        await originalMarkReleased(...args);
      },
    );
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      events.push(`release:${sessionId}:${reason}`);
    });
    (daemon as unknown as DaemonSocketServerInternals).socketServer = {
      quiesce: async () => {},
      drainSessionReleaseNotifications: async () => {
        events.push("socket:drain-releases");
      },
      close: async () => {
        events.push("socket:close");
      },
    };
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await sessionManager.createSession("blocked-terminal-session", "emulator-5560", "android");
      const terminalRelease = sessionManager.releaseSession(
        "blocked-terminal-session",
        "heartbeat-timeout",
      );
      await persistenceStarted.promise;

      await daemon.stop();

      const fallback = "release:blocked-terminal-session:daemon-shutdown";
      expect(events.filter((event) => event === fallback)).toHaveLength(1);
      expect(events.indexOf("socket:drain-releases")).toBeGreaterThan(events.indexOf(fallback));
      expect(events.indexOf("socket:close")).toBeGreaterThan(
        events.indexOf("socket:drain-releases"),
      );

      persistence.resolve();
      await terminalRelease;
      expect(events.filter((event) => event === fallback)).toHaveLength(1);
      expect(
        events.filter((event) => event.startsWith("release:blocked-terminal-session:")),
      ).toEqual([fallback]);
    } finally {
      persistence.resolve();
      markReleasedSpy.mockRestore();
      unsubscribe();
      loggerCloseSpy.mockRestore();
    }
  });

  test("publishes a daemon-shutdown reason upgrade after an ordinary release callback (#6336)", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const persistence = Promise.withResolvers<void>();
    const persistenceStarted = Promise.withResolvers<void>();
    const originalMarkReleased = repository.markReleased.bind(repository);
    const markReleasedSpy = spyOn(repository, "markReleased").mockImplementation(
      async (...args) => {
        if (args[3] === "explicit-release") {
          persistenceStarted.resolve();
          await persistence.promise;
        }
        await originalMarkReleased(...args);
      },
    );
    const shutdownReleaseStarted = Promise.withResolvers<void>();
    const originalRelease = sessionManager.releaseSession.bind(sessionManager);
    const releaseSpy = spyOn(sessionManager, "releaseSession").mockImplementation(
      async (sessionId, reason, allowExpired) => {
        if (reason === "daemon-shutdown") {
          shutdownReleaseStarted.resolve();
        }
        return await originalRelease(sessionId, reason, allowExpired);
      },
    );
    const events: string[] = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      events.push(`release:${sessionId}:${reason}`);
    });
    let ordinaryRelease: Promise<string | null> | undefined;
    (daemon as unknown as DaemonSocketServerInternals).socketServer = {
      quiesce: async () => {
        ordinaryRelease = sessionManager.releaseSession("upgraded-release", "explicit-release");
        await persistenceStarted.promise;
      },
      drainSessionReleaseNotifications: async () => {},
      close: async () => {},
    };
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await sessionManager.createSession("upgraded-release", "emulator-5562", "android");
      const stop = daemon.stop();
      await shutdownReleaseStarted.promise;
      persistence.resolve();
      await Promise.all([ordinaryRelease!, stop]);

      expect(
        events.filter((event) => event === "release:upgraded-release:explicit-release"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event === "release:upgraded-release:daemon-shutdown"),
      ).toHaveLength(1);
    } finally {
      persistence.resolve();
      markReleasedSpy.mockRestore();
      releaseSpy.mockRestore();
      unsubscribe();
      loggerCloseSpy.mockRestore();
    }
  });

  test("does not block shutdown on a deferred recovery sweep that never settles", async () => {
    const timer = new FakeTimer();
    // stop() reaches the sweep drain only after a number of earlier cleanup stages whose
    // async depth depends on process-global state, so a fixed count of microtask turns
    // before advancing time can run ahead of the drain deadline's registration.
    timer.enableAutoAdvance();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const internals = daemon as unknown as {
      trackDeferredSessionRecoverySweep(sweep: Promise<void>): void;
    };
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const warnSpy = spyOn(logger, "warn");

    try {
      internals.trackDeferredSessionRecoverySweep(Promise.withResolvers<void>().promise);
      await daemon.stop();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("deferred session recovery sweeps"),
      );
    } finally {
      loggerCloseSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("releases expired sessions that remain in memory during shutdown", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const sessionId = "expired-shutdown-session";
    const deviceId = "expired-device";
    const keepAwakeState: KeepScreenAwakeState = {
      applied: true,
      method: "svc",
      originalStayOnWhilePluggedIn: "0",
    };
    const releasedCallbacks: string[] = [];
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore").mockResolvedValue(
      undefined,
    );
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      const pooledDevices: BootedDevice[] = [
        { name: "Expired Android", deviceId, platform: "android" },
      ];
      stubPoolDiscovery(devicePool, pooledDevices);
      await devicePool.initializeWithDevices(pooledDevices);
      await devicePool.assignDeviceToSession(sessionId, "android");
      sessionManager.setKeepScreenAwake(sessionId, keepAwakeState);
      sessionManager.onSessionRelease((releasedSessionId) =>
        releasedCallbacks.push(releasedSessionId),
      );
      sessionManager.stopCleanupTimer();
      timer.advanceTime(31 * 60 * 1000);

      await daemon.stop();

      expect(restoreSpy).toHaveBeenCalledWith(keepAwakeState);
      expect(releasedCallbacks).toContain(sessionId);
      expect(devicePool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      expect(repository.sessions.get(sessionId)).toMatchObject({
        status: "released",
        reason: "daemon-shutdown",
      });
    } finally {
      restoreSpy.mockRestore();
      loggerCloseSpy.mockRestore();
    }
  });

  test("cleans up daemon pid/socket files only after the logger has flushed and closed (issue #6194)", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const events: string[] = [];
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      events.push("closeDatabase");
    });
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockImplementation(async () => {
      events.push("logger");
    });
    const cleanupDaemonFilesSpy = spyOn(daemonFilesModule, "cleanupDaemonFiles").mockImplementation(
      async () => {
        events.push("daemon files");
        return true;
      },
    );

    try {
      await daemon.stop();

      // The pid record is this daemon's ONLY externally-observable liveness
      // signal, and the process keeps holding its inherited launch-log fd
      // through every earlier shutdown stage. Removing the pid record before the
      // logger has fully flushed and closed opens a window where a concurrent
      // pruning sweep in another process reads "no daemon" while this one is
      // still alive and still writing, and unlinks a launch log out from under
      // it (issue #6194) — so "daemon files" cleanup must run LAST.
      expect(events).toEqual(["closeDatabase", "logger", "daemon files"]);
    } finally {
      closeDatabaseSpy.mockRestore();
      loggerCloseSpy.mockRestore();
      cleanupDaemonFilesSpy.mockRestore();
    }
  });

  test("stop releases CtrlProxy forwarding leases, bounded, before closing the database", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const events: string[] = [];
    const releaseSpy = spyOn(
      AndroidCtrlProxyClient,
      "releaseForwardLeasesForShutdown",
    ).mockImplementation(async () => {
      events.push("releaseLeases");
    });
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      events.push("closeDatabase");
    });
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const cleanupFilesSpy = spyOn(daemonFilesModule, "cleanupDaemonFiles").mockResolvedValue(
      undefined,
    );
    try {
      await daemon.stop();

      expect(releaseSpy).toHaveBeenCalledWith(timer, 3_000);
      expect(events).toEqual(["releaseLeases", "closeDatabase"]);
    } finally {
      releaseSpy.mockRestore();
      closeDatabaseSpy.mockRestore();
      loggerCloseSpy.mockRestore();
      cleanupFilesSpy.mockRestore();
    }
  });
});
