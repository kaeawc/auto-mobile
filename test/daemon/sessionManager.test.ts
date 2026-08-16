import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  SessionManager,
  type KeepScreenAwakeRestorer,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import type { KeepScreenAwakeState } from "../../src/utils/KeepScreenAwakeManager";

function makeHierarchy(label: string): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        "$": { "resource-id": `com.example:id/${label}` },
        "view-id": `com.example:id/${label}`,
      },
    },
  };
}

const HEARTBEAT_ENV_KEYS = [
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
] as const;

function clearHeartbeatEnv(): void {
  for (const key of HEARTBEAT_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    clearHeartbeatEnv();
    fakeTimer = new FakeTimer();
    sessionManager = new SessionManager(fakeTimer);
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    clearHeartbeatEnv();
  });

  describe("createSession", () => {
    test("should create new session with assigned device", async () => {
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android");
      expect(session.sessionId).toBe("session-1");
      expect(session.assignedDevice).toBe("emulator-5554");
      expect(session.cacheData).toEqual({});
      expect(typeof session.createdAt).toBe("number");
      expect(typeof session.lastUsedAt).toBe("number");
      expect(typeof session.expiresAt).toBe("number");
    });

    test("should return existing session if already created", async () => {
      const session1 = await sessionManager.createSession("session-1", "emulator-5554", "android");
      const session2 = await sessionManager.createSession("session-1", "emulator-5556", "android");
      expect(session1.sessionId).toBe(session2.sessionId);
      expect(session1.assignedDevice).toBe("emulator-5554");
      expect(session2.assignedDevice).toBe("emulator-5554"); // Should return original
    });

    test("should set correct expiration time for session", async () => {
      const beforeCreate = fakeTimer.now();
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android");
      const expectedExpiry = beforeCreate + 30 * 60 * 1000; // 30 minutes
      expect(session.expiresAt).toBe(expectedExpiry);
    });

    test("should persist custom timeout on the session", async () => {
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android", 5000);
      expect(session.sessionTimeoutMs).toBe(5000);
      expect(session.expiresAt).toBe(fakeTimer.now() + 5000);
    });

    test("should use configured default heartbeat timeout", async () => {
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = "15000";
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android");

      expect(session.heartbeatTimeoutMs).toBe(15_000);
      expect(session.heartbeatTimeoutSource).toBe("default");
    });

    test("should mark explicitly provided heartbeat timeout as custom", async () => {
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = "15000";
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android", 30_000, 15_000);

      expect(session.heartbeatTimeoutMs).toBe(15_000);
      expect(session.heartbeatTimeoutSource).toBe("custom");
    });
  });

  describe("getOrCreateSession", () => {
    test("should return existing session without creating new one", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const session = await sessionManager.getOrCreateSession("session-1");
      expect(session.sessionId).toBe("session-1");
      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });

    test("should update last used time when getting session", async () => {
      const session1 = await sessionManager.createSession("session-1", "emulator-5554", "android");
      const initialLastUsed = session1.lastUsedAt;
      const initialExpiry = session1.expiresAt;
      fakeTimer.advanceTime(10);
      const session2 = await sessionManager.getOrCreateSession("session-1");
      expect(session2.lastUsedAt).toBe(initialLastUsed + 10);
      expect(session2.expiresAt).toBe(initialExpiry + 10);
    });

    test("should bump lastHeartbeat when resolving an existing session", async () => {
      // The daemon heartbeat watchdog reaps sessions on a stale lastHeartbeat.
      // Resolving a session for a tool call must count as activity, otherwise an
      // actively-used autolock client (which sends no explicit heartbeats) would
      // be reaped mid-use.
      const session1 = await sessionManager.createSession("session-1", "emulator-5554", "android", 60_000, 60_000);
      const initialHeartbeat = session1.lastHeartbeat;
      fakeTimer.advanceTime(30_000);

      const session2 = await sessionManager.getOrCreateSession("session-1");

      expect(session2.lastHeartbeat).toBe(initialHeartbeat + 30_000);
      expect(session2.lastHeartbeat).toBe(fakeTimer.now());
    });

    test("should preserve custom timeout when getting existing session", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android", 5000);
      fakeTimer.advanceTime(4000);

      const session = await sessionManager.getOrCreateSession("session-1");

      expect(session.expiresAt).toBe(fakeTimer.now() + 5000);
    });

    test("should throw error for non-existent session without device pool", async () => {
      try {
        await sessionManager.getOrCreateSession("non-existent");
        expect.unreachable("Should have thrown error");
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("not found");
      }
    });

    test("allows distinct unseen session IDs to begin assignment independently", async () => {
      const assignedSessionIds: string[] = [];
      let releaseAssignments!: () => void;
      const assignmentsReleased = new Promise<void>((resolve) => {
        releaseAssignments = resolve;
      });
      let signalBothAssignmentsStarted!: () => void;
      const bothAssignmentsStarted = new Promise<void>((resolve) => {
        signalBothAssignmentsStarted = resolve;
      });
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          assignedSessionIds.push(sessionId);
          if (assignedSessionIds.length === 2) {
            signalBothAssignmentsStarted();
          }
          await assignmentsReleased;
          const session = await sessionManager.createSession(sessionId, `device-${sessionId}`, "android");
          return session.assignedDevice;
        },
      };

      const sessionsPromise = Promise.all([
        sessionManager.getOrCreateSession("session-a", devicePool),
        sessionManager.getOrCreateSession("session-b", devicePool),
      ]);

      await bothAssignmentsStarted;
      expect(assignedSessionIds).toEqual(["session-a", "session-b"]);

      releaseAssignments();
      const [first, second] = await sessionsPromise;
      expect(first.assignedDevice).toBe("device-session-a");
      expect(second.assignedDevice).toBe("device-session-b");
    });

    test("allows a retry after an unseen-session assignment fails", async () => {
      let attempts = 0;
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          attempts++;
          if (attempts === 1) {
            throw new Error("first assignment failed");
          }
          const session = await sessionManager.createSession(sessionId, "retry-device", "android");
          return session.assignedDevice;
        },
      };

      await expect(sessionManager.getOrCreateSession("retry-session", devicePool)).rejects.toThrow(
        "first assignment failed",
      );

      await expect(sessionManager.getOrCreateSession("retry-session", devicePool)).resolves.toMatchObject({
        sessionId: "retry-session",
        assignedDevice: "retry-device",
      });
      expect(attempts).toBe(2);
    });

    test("should return null session when expired session requested", async () => {
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android");
      // Force expiration by setting expiresAt to past
      fakeTimer.advanceTime(2000);
      const oneSecondAgo = fakeTimer.now() - 1000;
      (session as any).expiresAt = oneSecondAgo;
      const retrieved = sessionManager.getSession("session-1");
      expect(retrieved).toBeNull();
    });
  });

  describe("cache management", () => {
    test("should update session cache data", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const hierarchy = makeHierarchy("root");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: hierarchy,
        lastObserveTime: 987654,
      });
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache?.lastHierarchy).toEqual(hierarchy);
      expect(cache?.lastObserveTime).toBe(987654);
    });

    test("setLastHierarchy stores a ViewHierarchyResult in the typed top-level slot and stamps lastObserveTime (#2917)", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      fakeTimer.setCurrentTime(123456);
      const hierarchy = makeHierarchy("root");

      sessionManager.setLastHierarchy("session-1", hierarchy);

      const session = sessionManager.getSession("session-1")!;
      // Canonical slot is the typed top-level field, NOT customData.
      expect(session.cacheData.lastHierarchy).toEqual(hierarchy);
      expect(session.cacheData.lastHierarchy?.hierarchy.node?.["view-id"]).toBe("com.example:id/root");
      expect(session.cacheData.lastObserveTime).toBe(123456);
      // The dormant-decoy key never leaks into an untyped bag — the `customData`
      // escape hatch no longer exists at all (#2917/#2973).
      expect((session.cacheData as Record<string, unknown>).customData).toBeUndefined();
    });

    test("setLastHierarchy on a missing session is a no-op (no throw)", () => {
      expect(() => sessionManager.setLastHierarchy("nope", makeHierarchy("x"))).not.toThrow();
      expect(sessionManager.getSession("nope")).toBeNull();
    });

    test("should get session cache without modifying other fields", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        deviceLabels: { A: "session-1" },
      });
      const session1 = sessionManager.getSession("session-1");
      const initialLastUsed = session1?.lastUsedAt ?? 0;
      fakeTimer.advanceTime(10);
      const cache = sessionManager.getSessionCache("session-1");
      const session2 = sessionManager.getSession("session-1");
      expect(cache?.deviceLabels).toEqual({ A: "session-1" });
      expect((session2?.lastUsedAt ?? 0)).toBe(initialLastUsed + 10);
    });

    test("should clear specific cache key", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: makeHierarchy("root"),
        lastObserveTime: 987654,
      });
      sessionManager.clearSessionCache("session-1", "lastHierarchy");
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache?.lastHierarchy).toBeUndefined();
      expect(cache?.lastObserveTime).toBe(987654);
    });

    test("should clear all cache when no key specified", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: makeHierarchy("root"),
        lastObserveTime: 987654,
        deviceLabels: { A: "session-1" },
      });
      sessionManager.clearSessionCache("session-1");
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache).toEqual({});
    });
  });

  describe("releaseSession", () => {
    test("should release session and return device id", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const deviceId = await sessionManager.releaseSession("session-1");
      expect(deviceId).toBe("emulator-5554");
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("should return null for non-existent session", async () => {
      const deviceId = await sessionManager.releaseSession("non-existent");
      expect(deviceId).toBeNull();
    });

    test("coalesces concurrent releases before callbacks and persistence", async () => {
      const released: string[] = [];
      const callbacks: string[] = [];
      let beginRestore!: () => void;
      const restoreStarted = new Promise<void>(resolve => { beginRestore = resolve; });
      let finishRestore!: () => void;
      const restoreFinished = new Promise<void>(resolve => { finishRestore = resolve; });
      const restorer: KeepScreenAwakeRestorer = {
        async restore(_state: KeepScreenAwakeState): Promise<void> {
          beginRestore();
          await restoreFinished;
        },
      };
      const repository = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(sessionId: string): Promise<void> { released.push(sessionId); },
        async markStaleActiveSessionsExpired(): Promise<void> {},
      };
      const manager = new SessionManager(
        fakeTimer,
        repository,
        () => new FakeDbWriteBarrier(),
        () => restorer,
      );
      try {
        await manager.createSession("s1", "device-1", "android");
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
        manager.onSessionRelease(sessionId => callbacks.push(sessionId));

        const first = manager.releaseSession("s1", "heartbeat");
        await restoreStarted;
        const second = manager.releaseSession("s1", "daemon-shutdown");
        finishRestore();

        await expect(Promise.all([first, second])).resolves.toEqual(["device-1", "device-1"]);
        expect(callbacks).toEqual(["s1"]);
        expect(released).toEqual(["s1"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("waits for tracked setup before restoring and removing a session", async () => {
      let finishSetup!: () => void;
      const setupFinished = new Promise<void>(resolve => { finishSetup = resolve; });
      const manager = new SessionManager(fakeTimer, {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(): Promise<void> {},
        async markStaleActiveSessionsExpired(): Promise<void> {},
      }, () => new FakeDbWriteBarrier());
      try {
        const session = await manager.createSession("s1", "device-1", "android");
        const setup = manager.trackSessionSetup(session, () => setupFinished);
        const release = manager.releaseSession("s1", "daemon-shutdown");

        await Promise.resolve();
        expect(manager.getSession("s1")).not.toBeNull();

        finishSetup();
        await setup;
        await expect(release).resolves.toBe("device-1");
        expect(manager.getSession("s1")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("does not admit setup that arrives after release begins", async () => {
      let finishInitialSetup!: () => void;
      const initialSetup = new Promise<void>(resolve => { finishInitialSetup = resolve; });
      const manager = new SessionManager(fakeTimer, {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(): Promise<void> {},
        async markStaleActiveSessionsExpired(): Promise<void> {},
      }, () => new FakeDbWriteBarrier());
      try {
        const session = await manager.createSession("s1", "device-1", "android");
        const setup = manager.trackSessionSetup(session, () => initialSetup);
        const release = manager.releaseSession("s1", "daemon-shutdown");
        let lateSetupStarted = false;

        await Promise.resolve();
        await manager.trackSessionSetup(session, async () => { lateSetupStarted = true; });
        expect(lateSetupStarted).toBe(false);

        finishInitialSetup();
        await setup;
        await expect(release).resolves.toBe("device-1");
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("keeps an expiring session assigned until its release finishes", async () => {
      let finishSetup!: () => void;
      const setupFinished = new Promise<void>(resolve => { finishSetup = resolve; });
      const manager = new SessionManager(fakeTimer, {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(): Promise<void> {},
        async markStaleActiveSessionsExpired(): Promise<void> {},
      }, () => new FakeDbWriteBarrier());
      try {
        const session = await manager.createSession("s1", "device-1", "android", 1);
        const setup = manager.trackSessionSetup(session, () => setupFinished);
        const release = manager.releaseSession("s1", "daemon-shutdown", true);

        fakeTimer.advanceTime(1);
        manager.cleanupExpiredSessions();

        await expect(manager.createSession("s1", "device-2", "android")).resolves.toBe(session);
        finishSetup();
        await setup;
        await expect(release).resolves.toBe("device-1");
        expect(manager.getSession("s1")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("bounds a drain of an already-started release", async () => {
      let finishRestore!: () => void;
      const restoreFinished = new Promise<void>(resolve => { finishRestore = resolve; });
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => await restoreFinished }),
      );
      try {
        await manager.createSession("s1", "device-1", "android");
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
        const release = manager.releaseSession("s1", "daemon-shutdown");
        await Promise.resolve();
        const drain = manager.drainReleasePromises(1_000);
        fakeTimer.advanceTime(1_000);
        await expect(drain).resolves.toBe(false);

        finishRestore();
        await expect(release).resolves.toBe("device-1");
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("waits for an old session's terminal write before recreating its UUID", async () => {
      let finishFirstPersistence!: () => void;
      const firstPersistence = new Promise<void>(resolve => { finishFirstPersistence = resolve; });
      let firstPersistenceStarted!: () => void;
      const firstPersistenceStartedPromise = new Promise<void>(resolve => { firstPersistenceStarted = resolve; });
      const releases: string[] = [];
      const repository = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(_sessionId: string, _status: string, _releasedAt: number, reason: string): Promise<void> {
          releases.push(reason);
          if (reason === "first") {
            firstPersistenceStarted();
            await firstPersistence;
          }
        },
        async markStaleActiveSessionsExpired(): Promise<void> {},
      };
      const manager = new SessionManager(fakeTimer, repository, () => new FakeDbWriteBarrier());
      try {
        await manager.createSession("s1", "device-1", "android");
        const first = manager.releaseSession("s1", "first");
        await firstPersistenceStartedPromise;
        const replacement = manager.createSession("s1", "device-2", "android");

        expect(manager.getSession("s1")).toBeNull();
        finishFirstPersistence();
        await expect(first).resolves.toBe("device-1");
        await expect(replacement).resolves.toMatchObject({ assignedDevice: "device-2" });
        await expect(manager.releaseSession("s1", "second")).resolves.toBe("device-2");
        expect(releases).toEqual(["first", "second"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("persists terminal state when keep-awake restoration times out", async () => {
      const released: string[] = [];
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(sessionId: string): Promise<void> { released.push(sessionId); },
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => await new Promise<void>(() => {}) }),
      );
      try {
        await manager.createSession("s1", "device-1", "android");
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
        const release = manager.releaseSession("s1", "daemon-shutdown");
        await Promise.resolve();
        fakeTimer.advanceTime(1_000);
        await expect(release).resolves.toBe("device-1");

        expect(manager.getSession("s1")).toBeNull();
        expect(released).toEqual(["s1"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("coalesces a failed in-flight release into terminal cleanup", async () => {
      let rejectRestore!: (error: Error) => void;
      const restore = new Promise<void>((_resolve, reject) => { rejectRestore = reject; });
      const released: string[] = [];
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(sessionId: string): Promise<void> { released.push(sessionId); },
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => await restore }),
      );
      try {
        await manager.createSession("s1", "device-1", "android");
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });

        const first = manager.releaseSession("s1", "heartbeat");
        const joined = manager.releaseSession("s1", "daemon-shutdown", true);
        rejectRestore(new Error("restore failed"));

        await expect(Promise.all([first, joined])).resolves.toEqual(["device-1", "device-1"]);
        expect(manager.getSession("s1")).toBeNull();
        expect(released).toEqual(["s1"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });
  });

  describe("recordHeartbeat", () => {
    test("should extend expiry using the session's custom timeout", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android", 5000);
      fakeTimer.advanceTime(4000);

      sessionManager.recordHeartbeat("session-1");
      fakeTimer.advanceTime(4000);
      expect(sessionManager.getSession("session-1")).not.toBeNull();

      fakeTimer.advanceTime(1500);
      expect(sessionManager.getSession("session-1")).toBeNull();
    });
  });

  describe("getSessionForDevice", () => {
    test("should return session id for assigned device", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBe("session-1");
    });

    test("should return null for unknown device", () => {
      expect(sessionManager.getSessionForDevice("emulator-9999")).toBeNull();
    });

    test("should return null after session is released", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      await sessionManager.releaseSession("session-1");
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
    });
  });

  describe("statistics", () => {
    test("should return correct session statistics", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      await sessionManager.createSession("session-2", "emulator-5556", "android");
      const stats = sessionManager.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.expiredSessions).toBe(0);
      expect(stats.assignedDevices).toBe(2);
    });
  });

  describe("onSessionRelease callbacks", () => {
    test("should invoke release callbacks when session is released", async () => {
      await sessionManager.createSession("session-cb", "emulator-5554", "android");

      const released: { sessionId: string; deviceId: string }[] = [];
      sessionManager.onSessionRelease((sessionId, deviceId) => {
        released.push({ sessionId, deviceId });
      });

      await sessionManager.releaseSession("session-cb");

      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-cb");
      expect(released[0].deviceId).toBe("emulator-5554");
    });

    test("should continue releasing even if a callback throws", async () => {
      await sessionManager.createSession("session-err", "emulator-5554", "android");

      const results: string[] = [];
      sessionManager.onSessionRelease(() => {
        throw new Error("callback error");
      });
      sessionManager.onSessionRelease(sessionId => {
        results.push(sessionId);
      });

      await sessionManager.releaseSession("session-err");

      // Second callback should still fire despite first throwing
      expect(results).toEqual(["session-err"]);
    });

    test("should invoke release callbacks when expired session is accessed via getSession", async () => {
      await sessionManager.createSession("session-expiry", "emulator-5554", "android");

      const released: { sessionId: string; deviceId: string }[] = [];
      sessionManager.onSessionRelease((sessionId, deviceId) => {
        released.push({ sessionId, deviceId });
      });

      // Advance time past the 30-minute session timeout
      fakeTimer.advanceTime(31 * 60 * 1000);

      // Accessing the expired session should trigger cleanup + callback
      const result = sessionManager.getSession("session-expiry");
      expect(result).toBeNull();
      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-expiry");
      expect(released[0].deviceId).toBe("emulator-5554");
    });

    test("should invoke release callbacks when cleanup timer fires for expired sessions", async () => {
      await sessionManager.createSession("session-timer", "emulator-5556", "android");

      const released: { sessionId: string; deviceId: string }[] = [];
      sessionManager.onSessionRelease((sessionId, deviceId) => {
        released.push({ sessionId, deviceId });
      });

      // Advance past session timeout + cleanup interval (30min + 5min)
      fakeTimer.advanceTime(36 * 60 * 1000);

      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-timer");
      expect(released[0].deviceId).toBe("emulator-5556");
    });
  });

  describe("shutdown draining (issue #2792)", () => {

    // Minimal repo double capturing the fire-and-forget session writes.
    function makeRepo(): { repo: any; activity: string[]; released: string[] } {
      const activity: string[] = [];
      const released: string[] = [];
      const repo = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(sessionId: string): Promise<void> { activity.push(sessionId); },
        async markReleased(sessionId: string): Promise<void> { released.push(sessionId); },
        async markStaleActiveSessionsExpired(): Promise<void> {},
      };
      return { repo, activity, released };
    }

    test("routes fire-and-forget session activity writes through the barrier", async () => {
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        mgr.recordHeartbeat("s1");
        await Promise.resolve(); // let the void-tracked write run
        expect(activity).toContain("s1");
        // Exactly one barrier-tracked write: a single recordHeartbeat drives one
        // fire-and-forget recordSessionActivity. createSession's persistSession is
        // awaited, not barrier-tracked. A regression that fires the barrier twice
        // for one logical write (#2912's failure mode) would push this to 2.
        expect(barrier.ran.length).toBe(1);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("skips fire-and-forget session writes while draining", async () => {
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        barrier.beginDrain();
        mgr.recordHeartbeat("s1");
        await Promise.resolve();
        // The heartbeat's activity write was short-circuited by the drain.
        expect(activity).toHaveLength(0);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    // The cleanup interval is the ONE best-effort DB writer that fires on its own
    // timer rather than an external socket. With per-write barrier resolution
    // (#2912) it would resolve a fresh, non-draining barrier if it fired after
    // closeDatabase()'s reset — so `daemon.stop()` stops it before draining. These
    // two tests pin the property that call relies on: the timer routes a tracked
    // write when it fires, and stopping it neutralizes that writer.
    test("cleanup timer routes an expired-session release through the barrier", async () => {
      const { repo, released } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        // Past session timeout (30m) + cleanup interval (5m): the timer fires.
        fakeTimer.advanceTime(36 * 60 * 1000);
        await Promise.resolve();
        expect(released).toContain("s1");
        // Exactly one barrier-tracked write: the cleanup sweep releases the single
        // expired session once, routing one fire-and-forget markReleased through the
        // barrier. A duplicate-write regression would push this to 2.
        expect(barrier.ran.length).toBe(1);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("stopCleanupTimer prevents the timer from routing any further tracked write", async () => {
      const { repo, released } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      await mgr.createSession("s1", "emulator-5554", "android");

      // Model the shutdown ordering: stop the timer BEFORE the (would-be) drain.
      mgr.stopCleanupTimer();

      fakeTimer.advanceTime(36 * 60 * 1000);
      await Promise.resolve();

      // No cleanup fired, so no tracked write was ever attempted against a
      // reopened/closed connection.
      expect(released).toHaveLength(0);
      expect(barrier.trackCalls).toBe(0);
    });
  });

  // Side-effect-free diff-baseline reader (issue #3053 part 3). The
  // `--actions-diff-observe` baseline store did get (getSessionCache →
  // recordSessionActivity) + set (updateSessionCache → recordSessionActivity)
  // = two fire-and-forget activity UPDATEs per diffed action. A dedicated
  // read-only reader halves that: the read must NOT record activity.
  describe("getLastRenderedObservation (issue #3053)", () => {
    function makeObservation(id: string): any {
      return {
        updatedAt: 1,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { packageName: "com.example", hierarchy: { node: { "resource-id": id } } },
      };
    }

    // Minimal repo double capturing the fire-and-forget activity writes.
    function makeRepo(): { repo: any; activity: string[] } {
      const activity: string[] = [];
      const repo = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(sessionId: string): Promise<void> { activity.push(sessionId); },
        async markReleased(): Promise<void> {},
        async markStaleActiveSessionsExpired(): Promise<void> {},
      };
      return { repo, activity };
    }

    test("EC3.1: returns the observation stored via setLastRenderedObservation", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      const obs = makeObservation("root");
      sessionManager.setLastRenderedObservation("s1", obs);

      expect(sessionManager.getLastRenderedObservation("s1")).toEqual(obs);
    });

    test("EC3.2: the read records NO session activity, unlike getSessionCache", async () => {
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        mgr.setLastRenderedObservation("s1", makeObservation("root"));
        await Promise.resolve();
        const activityAfterSet = activity.length;

        // The side-effect-free reader must not append any activity write.
        mgr.getLastRenderedObservation("s1");
        await Promise.resolve();
        expect(activity.length).toBe(activityAfterSet);

        // Contrast: getSessionCache DOES record activity (the behavior we avoid).
        mgr.getSessionCache("s1");
        await Promise.resolve();
        expect(activity.length).toBe(activityAfterSet + 1);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("EC3.2: a full baseline-store cycle (read + write) records activity exactly once", async () => {
      // The #3053 defect: the diff baseline did get (→recordActivity) +
      // set (→recordActivity) = TWO activity UPDATEs per diffed action. With the
      // side-effect-free reader, one non-observe action's baseline read + update
      // must record activity exactly once (the write), proving the halving.
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        await Promise.resolve();
        const before = activity.length;

        // Model one diffed action: read the baseline, then update it.
        mgr.getLastRenderedObservation("s1");
        mgr.setLastRenderedObservation("s1", makeObservation("root"));
        await Promise.resolve();

        expect(activity.length).toBe(before + 1);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("EC3.3: returns undefined for an unknown session without throwing", () => {
      expect(sessionManager.getLastRenderedObservation("missing")).toBeUndefined();
    });

    test("EC3.3: returns undefined when no observation was ever stored", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      expect(sessionManager.getLastRenderedObservation("s1")).toBeUndefined();
    });
  });
});
