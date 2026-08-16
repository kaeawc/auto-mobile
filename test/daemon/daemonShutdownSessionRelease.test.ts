import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as databaseModule from "../../src/db";
import {
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
  DeviceSessionRepository,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { KeepScreenAwakeManager, type KeepScreenAwakeState } from "../../src/utils/KeepScreenAwakeManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";

class FakeDeviceSessionRepository {
  readonly events: string[] = [];
  readonly sessions = new Map<string, {
    status: DeviceSessionStatus;
    releasedAtMs: number | null;
    reason: string | null;
  }>();

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

describe("Daemon shutdown session release (issue #5303)", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
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
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore")
      .mockResolvedValue(undefined);
    const releaseDeviceSpy = spyOn(devicePool, "releaseDevice");
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);
    const closeDatabaseSpy = spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
      repository.events.push("closeDatabase");
    });

    try {
      await devicePool.initializeWithDevices([{
        name: "Physical Android",
        deviceId,
        platform: "android",
      }]);
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
    const releaseSpy = spyOn(sessionManager, "releaseSession")
      .mockImplementation(async (sessionId, reason) => {
        if (sessionId === brokenSessionId) {
          throw new Error("simulated release failure");
        }
        return await originalRelease(sessionId, reason);
      });
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

  test("releases the session when keep-awake restoration fails", async () => {
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
    const sessionId = "restore-failure-shutdown-session";
    const deviceId = "restore-failure-device";
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore")
      .mockRejectedValue(new Error("simulated restore failure"));
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await devicePool.initializeWithDevices([{
        name: "Restore Failure Android",
        deviceId,
        platform: "android",
      }]);
      await devicePool.assignDeviceToSession(sessionId, "android");
      sessionManager.setKeepScreenAwake(sessionId, { applied: true, method: "svc", svcWasEnabled: false });

      await expect(daemon.stop()).resolves.toBeUndefined();

      expect(sessionManager.getSession(sessionId)).toBeNull();
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

  test("releases sessions that expired after cleanup stopped", async () => {
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
    const restoreSpy = spyOn(KeepScreenAwakeManager.prototype, "restore")
      .mockResolvedValue(undefined);
    const loggerCloseSpy = spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined);

    try {
      await devicePool.initializeWithDevices([{
        name: "Expired Android",
        deviceId,
        platform: "android",
      }]);
      await devicePool.assignDeviceToSession(sessionId, "android");
      sessionManager.setKeepScreenAwake(sessionId, keepAwakeState);
      sessionManager.onSessionRelease(releasedSessionId => releasedCallbacks.push(releasedSessionId));
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
});
