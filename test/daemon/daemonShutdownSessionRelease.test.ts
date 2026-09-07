import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as daemonFilesModule from "../../src/daemon/daemonFiles";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
  DeviceSessionRepository,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import {
  KeepScreenAwakeManager,
  type KeepScreenAwakeState,
} from "../../src/utils/KeepScreenAwakeManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";

class FakeDeviceSessionRepository {
  readonly events: string[] = [];
  readonly sessions = new Map<
    string,
    {
      status: DeviceSessionStatus;
      releasedAtMs: number | null;
      reason: string | null;
    }
  >();

  async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    this.sessions.set(record.sessionUuid, {
      status: "active",
      releasedAtMs: null,
      reason: null,
    });
  }

  async recordActivity(_sessionUuid: string, _update: DeviceSessionActivityUpdate): Promise<void> {}

  async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    this.events.push("markReleased");
    this.sessions.set(sessionUuid, { status, releasedAtMs, reason });
  }

  async markStaleActiveSessionsExpired(): Promise<void> {}
}

interface DaemonSocketServerInternals {
  socketServer: {
    quiesce(): Promise<void>;
    drainSessionReleaseNotifications(): Promise<void>;
    close(): Promise<void>;
  } | null;
}

describe("Daemon shutdown session release (issue #5303)", () => {
  // Daemon shutdown drains the process-wide write barrier. These unit tests mock
  // closeDatabase(), so reset that global explicitly to retain test isolation.
  beforeEach(() => resetDbWriteBarrier());

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("releases active sessions before closing the database", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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
      await devicePool.initializeWithDevices([
        {
          name: "Physical Android",
          deviceId,
          platform: "android",
        },
      ]);
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
      repository as unknown as DeviceSessionRepository,
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
      await devicePool.initializeWithDevices([
        {
          name: "Managed Android",
          deviceId: "managed-physical-device",
          platform: "android",
        },
      ]);
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
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const brokenSessionId = "broken-shutdown-session";
    const healthySessionId = "healthy-shutdown-session";
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore")
      .mockRejectedValueOnce(new Error("simulated restore failure"))
      .mockResolvedValue(undefined);
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await devicePool.initializeWithDevices([
        { name: "Broken Android", deviceId: "broken-device", platform: "android" },
        { name: "Healthy Android", deviceId: "healthy-device", platform: "android" },
      ]);
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

      await expect(daemon.stop()).resolves.toBeUndefined();

      expect(restoreSpy).toHaveBeenCalledTimes(2);
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
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
    const sessionManager = daemon.getSessionManager();
    const events: string[] = [];
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
      loggerCloseSpy.mockRestore();
    }
  });

  test("rejects a session creation that outlives control-socket quiescence (#6336)", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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

  test("drains a monitor release that removed its session before shutdown snapshots it", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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
      await sessionManager.createSession(
        "blocked-terminal-session",
        "emulator-5560",
        "android",
      );
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
      expect(events.filter((event) => event.startsWith("release:blocked-terminal-session:"))).toEqual(
        [fallback],
      );
    } finally {
      persistence.resolve();
      markReleasedSpy.mockRestore();
      unsubscribe();
      loggerCloseSpy.mockRestore();
    }
  });

  test("releases expired sessions that remain in memory during shutdown", async () => {
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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
      await devicePool.initializeWithDevices([
        {
          name: "Expired Android",
          deviceId,
          platform: "android",
        },
      ]);
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
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
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
});
