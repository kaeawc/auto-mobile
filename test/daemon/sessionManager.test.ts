import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  SessionManager,
  type BiometricEnrollmentRestorer,
  type KeepScreenAwakeRestorer,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type {
  DeviceSessionPersistence,
  DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession, DeviceSessionStatus } from "../../src/db/types";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import type { KeepScreenAwakeState } from "../../src/utils/KeepScreenAwakeManager";

class DeferredDeviceSessionPersistence implements DeviceSessionPersistence {
  private deferredWrite: Promise<void> | null = null;
  private resolveDeferredWrite: (() => void) | null = null;
  private readonly writeStarted = Promise.withResolvers<void>();
  readonly upsertedDeviceIds: string[] = [];

  deferNextUpsert(): void {
    this.deferredWrite = new Promise<void>((resolve) => {
      this.resolveDeferredWrite = resolve;
    });
  }

  async waitForUpsert(): Promise<void> {
    await this.writeStarted.promise;
  }

  finishUpsert(): void {
    this.resolveDeferredWrite?.();
  }

  async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    this.upsertedDeviceIds.push(record.deviceId);
    const deferredWrite = this.deferredWrite;
    if (!deferredWrite) {
      return;
    }
    this.deferredWrite = null;
    this.writeStarted.resolve();
    await deferredWrite;
  }

  async recordActivity(): Promise<void> {}

  async markReleased(): Promise<void> {}
}

class DeferredReleaseDeviceSessionPersistence extends FakeDeviceSessionPersistence {
  readonly reasons: string[] = [];
  readonly releaseStarted = Promise.withResolvers<void>();
  readonly finishRelease = Promise.withResolvers<void>();

  override async markReleased(
    _sessionUuid: string,
    _status: DeviceSessionStatus,
    _releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    this.reasons.push(reason);
    if (this.reasons.length === 1) {
      this.releaseStarted.resolve();
      await this.finishRelease.promise;
    }
  }
}

function makeHierarchy(label: string): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { "resource-id": `com.example:id/${label}` },
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
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
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
      const session = await sessionManager.createSession(
        "session-1",
        "emulator-5554",
        "android",
        5000,
      );
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
      const session = await sessionManager.createSession(
        "session-1",
        "emulator-5554",
        "android",
        30_000,
        15_000,
      );

      expect(session.heartbeatTimeoutMs).toBe(15_000);
      expect(session.heartbeatTimeoutSource).toBe("custom");
    });

    test("removes every ownership mapping when persistence rejects", async () => {
      const repository = new FakeDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);
      repository.failure = "create";

      try {
        await expect(
          manager.createSession("session-failure", "emulator-5554", "android"),
        ).rejects.toThrow("persist create failed");

        expect(manager.getSession("session-failure")).toBeNull();
        expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
        expect(manager.getActiveSessionCount()).toBe(0);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("releases a session after its pending creation finishes", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        repository.deferNextUpsert();
        const creation = manager.createSession(
          "session-pending-release",
          "emulator-5554",
          "android",
        );
        await repository.waitForUpsert();
        const release = manager.releaseSession("session-pending-release");

        repository.finishUpsert();

        await expect(creation).resolves.toMatchObject({ sessionId: "session-pending-release" });
        await expect(release).resolves.toBe("emulator-5554");
        expect(manager.getSession("session-pending-release")).toBeNull();
        expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("includes a pending creation in the shutdown session snapshot", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        repository.deferNextUpsert();
        const creating = manager.createSession("pending-shutdown", "emulator-5554", "android");
        await repository.waitForUpsert();

        expect(manager.getAllSessionIds()).toEqual([]);
        expect(manager.getAllKnownSessionIds()).toEqual(["pending-shutdown"]);

        repository.finishUpsert();
        await creating;
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("keeps ownership unpublished while a creation write is pending", async () => {
      let rejectFirstWrite!: (error: Error) => void;
      const firstWrite = new Promise<void>((_resolve, reject) => {
        rejectFirstWrite = reject;
      });
      let firstWritePending = true;
      const repository: DeviceSessionPersistence = {
        upsertActiveSession: async () => {
          if (firstWritePending) {
            firstWritePending = false;
            await firstWrite;
          }
        },
        recordActivity: async () => {},
        markReleased: async () => {},
      };
      const manager = new SessionManager(fakeTimer, repository);

      try {
        const initialCreate = manager.createSession("reused", "emulator-old", "android");
        const duplicateCreate = manager.createSession("reused", "emulator-new", "android");

        expect(manager.getSession("reused")).toBeNull();
        expect(manager.getSessionForDevice("emulator-old")).toBeNull();
        expect(manager.getSessionForDevice("emulator-new")).toBeNull();

        rejectFirstWrite(new Error("first persistence failed"));
        await expect(Promise.all([initialCreate, duplicateCreate])).rejects.toThrow(
          "first persistence failed",
        );

        expect(manager.getSession("reused")).toBeNull();
        expect(manager.getActiveSessionCount()).toBe(0);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("does not report a finalized identity as latest while its replacement is being created", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);
      try {
        const original = await manager.createSession("reused", "emulator-old", "android");
        await manager.releaseSession("reused");
        expect(manager.isLatestSessionIdentity(original)).toBe(true);

        repository.deferNextUpsert();
        const replacementCreation = manager.createSession("reused", "emulator-new", "android");
        await repository.waitForUpsert();
        expect(manager.isLatestSessionIdentity(original)).toBe(false);

        repository.finishUpsert();
        const replacement = await replacementCreation;
        expect(manager.isLatestSessionIdentity(original)).toBe(false);
        expect(manager.isLatestSessionIdentity(replacement)).toBe(true);
      } finally {
        manager.stopCleanupTimer();
      }
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
      const session1 = await sessionManager.createSession(
        "session-1",
        "emulator-5554",
        "android",
        60_000,
        60_000,
      );
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

    // #6069: with requireIssuedSession, a never-issued id must NOT be minted a
    // pooled device just because a live device pool is in scope. Admission is
    // decided from the registry, not from pool presence.
    test("requireIssuedSession rejects a never-issued id instead of minting a pooled device", async () => {
      const assignedSessionIds: string[] = [];
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          assignedSessionIds.push(sessionId);
          const session = await sessionManager.createSession(sessionId, "device-x", "android");
          return session.assignedDevice;
        },
      };

      await expect(
        sessionManager.getOrCreateSession("kumquat-D", devicePool, "android", undefined, true),
      ).rejects.toThrow(/not an active daemon session/);
      expect(assignedSessionIds).toEqual([]);
      expect(sessionManager.getSession("kumquat-D")).toBeNull();
    });

    // Regression: requireIssuedSession must NOT block minting for a NEW id when
    // requireIssuedSession is false (device-label / internal derived sessions).
    test("still mints a fresh id when requireIssuedSession is false (default)", async () => {
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          const session = await sessionManager.createSession(sessionId, "device-y", "android");
          return session.assignedDevice;
        },
      };

      const session = await sessionManager.getOrCreateSession("base:B", devicePool, "android");
      expect(session.assignedDevice).toBe("device-y");
    });

    // Regression: live-during-restart recovery — a persisted, non-terminal row is
    // an issued identity, so requireIssuedSession still recovers it.
    test("requireIssuedSession still recovers a persisted, non-terminal session", async () => {
      const persisted: DeviceSession = {
        session_uuid: "restarted-session",
        device_id: "emulator-5560",
        platform: "android",
        status: "active",
        source: null,
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: 25,
        release_reason: "daemon-restart",
        session_timeout_ms: 10,
        heartbeat_timeout_ms: 5,
        has_received_heartbeat: 1,
        created_at: "2026-09-03T00:00:00.000Z",
        updated_at: "2026-09-03T00:00:00.000Z",
      };
      const persistence: DeviceSessionPersistence = {
        async getSession() {
          return persisted;
        },
        async upsertActiveSession() {},
        async recordActivity() {},
        async markReleased() {},
      };
      const restarted = new SessionManager(fakeTimer, persistence);
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          await restarted.createSession(sessionId, "emulator-5560", "android");
          return "emulator-5560";
        },
      };
      try {
        await expect(
          restarted.getOrCreateSession("restarted-session", devicePool, "android", undefined, true),
        ).resolves.toMatchObject({ assignedDevice: "emulator-5560" });
      } finally {
        restarted.stopCleanupTimer();
      }
    });

    // Regression: a terminal persisted row keeps yielding TerminalSessionError,
    // never a pooled assignment, under requireIssuedSession.
    test("requireIssuedSession preserves TerminalSessionError for a terminal persisted row", async () => {
      const persisted: DeviceSession = {
        session_uuid: "lost-session",
        device_id: "emulator-5554",
        platform: "android",
        status: "released",
        source: null,
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: 25,
        release_reason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
        session_timeout_ms: 10,
        heartbeat_timeout_ms: 5,
        has_received_heartbeat: 1,
        created_at: "2026-09-03T00:00:00.000Z",
        updated_at: "2026-09-03T00:00:00.000Z",
      };
      const restarted = new SessionManager(fakeTimer, {
        async getSession() {
          return persisted;
        },
        async upsertActiveSession() {},
        async recordActivity() {},
        async markReleased() {},
      });
      const assignedSessionIds: string[] = [];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          assignedSessionIds.push(sessionId);
          return "emulator-5560";
        },
      };
      try {
        await expect(
          restarted.getOrCreateSession("lost-session", devicePool, "android", undefined, true),
        ).rejects.toThrow("terminal");
        expect(assignedSessionIds).toEqual([]);
      } finally {
        restarted.stopCleanupTimer();
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
          const session = await sessionManager.createSession(
            sessionId,
            `device-${sessionId}`,
            "android",
          );
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

    test("does not report a finalized identity as latest while replacement assignment is pending", async () => {
      const original = await sessionManager.createSession("reused", "emulator-old", "android");
      await sessionManager.releaseSession("reused");
      const assignmentStarted = Promise.withResolvers<void>();
      const finishAssignment = Promise.withResolvers<void>();
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          assignmentStarted.resolve();
          await finishAssignment.promise;
          const replacement = await sessionManager.createSession(
            sessionId,
            "emulator-new",
            "android",
          );
          return replacement.assignedDevice;
        },
      };

      const replacementAssignment = sessionManager.getOrCreateSession("reused", devicePool);
      await assignmentStarted.promise;
      expect(sessionManager.isLatestSessionIdentity(original)).toBe(false);

      finishAssignment.resolve();
      const replacement = await replacementAssignment;
      expect(sessionManager.isLatestSessionIdentity(original)).toBe(false);
      expect(sessionManager.isLatestSessionIdentity(replacement)).toBe(true);
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

      await expect(
        sessionManager.getOrCreateSession("retry-session", devicePool),
      ).resolves.toMatchObject({
        sessionId: "retry-session",
        assignedDevice: "retry-device",
      });
      expect(attempts).toBe(2);
    });

    test("releases a session after its pending automatic assignment finishes", async () => {
      const manager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const assignmentStarted = Promise.withResolvers<void>();
      const finishAssignment = Promise.withResolvers<void>();
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          assignmentStarted.resolve();
          await finishAssignment.promise;
          return (await manager.createSession(sessionId, "emulator-5554", "android"))
            .assignedDevice;
        },
      };

      try {
        const assignment = manager.getOrCreateSession("pending-assignment", devicePool);
        await assignmentStarted.promise;
        const release = manager.releaseSession("pending-assignment", "device-disconnected");
        finishAssignment.resolve();

        await expect(assignment).resolves.toMatchObject({ assignedDevice: "emulator-5554" });
        await expect(release).resolves.toBe("emulator-5554");
        expect(manager.getSession("pending-assignment")).toBeNull();
        expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
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

    test("expires a session before accepting a request that arrives after its deadline", async () => {
      const released: string[] = [];
      sessionManager.setActiveSessionExecutionChecker(
        (_sessionId, startedAtOrBefore) => startedAtOrBefore === undefined,
      );
      sessionManager.onSessionRelease((sessionId) => released.push(sessionId));
      await sessionManager.createSession("session-1", "emulator-5554", "android", 1000);
      fakeTimer.advanceTime(1001);

      // Existing work keeps an expired session assigned, but a new request must
      // not use that protection to revive the session after its deadline.
      expect(sessionManager.getSession("session-1")).not.toBeNull();
      await expect(sessionManager.getOrCreateSession("session-1")).rejects.toThrow("not found");

      expect(released).toEqual(["session-1"]);
      expect(sessionManager.getActiveSessionCount()).toBe(0);
    });

    test("keeps an expired session unavailable while its teardown restores device state", async () => {
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const activity: string[] = [];
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(sessionId: string): Promise<void> {
            activity.push(sessionId);
          },
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
        () => ({
          restore: async (): Promise<void> => {
            restoreStarted();
            await restoration;
          },
        }),
      );
      const assignedSessionIds: string[] = [];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          assignedSessionIds.push(sessionId);
          const replacement = await manager.createSession(sessionId, "device-2", "android");
          return replacement.assignedDevice;
        },
      };
      try {
        const session = await manager.createSession("s1", "device-1", "android", 1);
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
        await Promise.resolve();
        activity.length = 0;
        fakeTimer.advanceTime(2);

        expect(manager.getSession("s1")).toBeNull();
        await restorationStarted;
        expect(manager.getSession("s1")).toBeNull();
        expect(manager.getSessionForNewExecution("s1")).toBeNull();

        const expiresAt = session.expiresAt;
        manager.recordHeartbeat("s1");
        await Promise.resolve();
        expect(session.expiresAt).toBe(expiresAt);
        expect(activity).toEqual([]);

        const replacement = manager.getOrCreateSession("s1", devicePool);
        await Promise.resolve();
        expect(assignedSessionIds).toEqual([]);

        finishRestore();
        await expect(replacement).resolves.toMatchObject({
          sessionId: "s1",
          assignedDevice: "device-2",
        });
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("keeps a periodically expired session unavailable during teardown", async () => {
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
        () => ({
          restore: async (): Promise<void> => {
            restoreStarted();
            await restoration;
          },
        }),
      );
      try {
        const session = await manager.createSession("s1", "device-1", "android", 1);
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
        fakeTimer.advanceTime(5 * 60 * 1000);

        await restorationStarted;
        expect(manager.getSession("s1")).toBeNull();
        expect(manager.getSessionForNewExecution("s1")).toBeNull();
        manager.recordHeartbeat("s1");
        expect(session.expiresAt).toBe(1);

        finishRestore();
        await manager.waitForSessionRelease("s1");
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("waits for expired session terminal work before recreating its UUID", async () => {
      const persistenceStarted = Promise.withResolvers<void>();
      const finishPersistence = Promise.withResolvers<void>();
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {
            persistenceStarted.resolve();
            await finishPersistence.promise;
          },
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
      );
      const assignedSessionIds: string[] = [];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          assignedSessionIds.push(sessionId);
          const replacement = await manager.createSession(sessionId, "device-2", "android");
          return replacement.assignedDevice;
        },
      };
      try {
        await manager.createSession("s1", "device-1", "android", 1);
        fakeTimer.advanceTime(2);
        expect(manager.getSession("s1")).toBeNull();
        await persistenceStarted.promise;

        const replacement = manager.getOrCreateSession("s1", devicePool);
        await Promise.resolve();
        expect(assignedSessionIds).toEqual([]);

        finishPersistence.resolve();
        await expect(replacement).resolves.toMatchObject({
          sessionId: "s1",
          assignedDevice: "device-2",
        });
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("keeps a session when work began before its expiry deadline", async () => {
      const session = await sessionManager.createSession(
        "session-1",
        "emulator-5554",
        "android",
        1000,
      );
      fakeTimer.advanceTime(1001);

      const resolved = await sessionManager.getOrCreateSession("session-1", undefined, undefined, {
        executionId: "pre-deadline",
        startTime: 1000,
      });

      expect(resolved).toBe(session);
      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });

    test("rejects a late execution while earlier work keeps the expired session assigned", async () => {
      sessionManager.setActiveSessionExecutionChecker(
        (_sessionId, query) => query?.excludeExecutionId === "late",
      );
      await sessionManager.createSession("session-1", "emulator-5554", "android", 1000);
      fakeTimer.advanceTime(1001);

      await expect(
        sessionManager.getOrCreateSession("session-1", undefined, undefined, {
          executionId: "late",
          startTime: 1001,
        }),
      ).rejects.toThrow("earlier work is still active");

      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });
  });

  describe("rebindSession", () => {
    test("retains the existing binding when replacement persistence rejects", async () => {
      const repository = new FakeDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        await manager.createSession("session-1", "emulator-old", "android");
        repository.failure = "create";

        await expect(manager.rebindSession("session-1", "emulator-new", "android")).rejects.toThrow(
          "persist create failed",
        );

        expect(manager.getSession("session-1")?.assignedDevice).toBe("emulator-old");
        expect(manager.getSessionForDevice("emulator-old")).toBe("session-1");
        expect(manager.getSessionForDevice("emulator-new")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("clears device-scoped state when a new runtime reuses the serial", async () => {
      const repository = new FakeDeviceSessionPersistence();
      const restoredDevices: string[] = [];
      const manager = new SessionManager(fakeTimer, repository, undefined, (device) => ({
        restore: async () => {
          restoredDevices.push(device.deviceId);
        },
      }));
      const unboundDevices: string[] = [];

      try {
        await manager.createSession("session-1", "emulator-5554", "android");
        manager.setLastHierarchy("session-1", makeHierarchy("old"));
        manager.setKeepScreenAwake("session-1", { applied: true });
        manager.onSessionDeviceUnbound((_sessionId, deviceId) => unboundDevices.push(deviceId));

        await expect(
          manager.rebindSession("session-1", "emulator-5554", "android", { force: true }),
        ).resolves.toMatchObject({
          assignedDevice: "emulator-5554",
          cacheData: {},
        });

        expect(restoredDevices).toEqual(["emulator-5554"]);
        expect(unboundDevices).toEqual(["emulator-5554"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("serializes a pending rebind with release and clears device-scoped state", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const restoredDevices: string[] = [];
      const manager = new SessionManager(fakeTimer, repository, undefined, (device) => ({
        restore: async () => {
          restoredDevices.push(device.deviceId);
        },
      }));
      const unboundDevices: string[] = [];

      try {
        await manager.createSession("session-1", "emulator-old", "android");
        manager.setLastHierarchy("session-1", makeHierarchy("old"));
        manager.setKeepScreenAwake("session-1", { applied: true });
        manager.onSessionDeviceUnbound((_sessionId, deviceId) => unboundDevices.push(deviceId));
        repository.deferNextUpsert();

        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.waitForUpsert();
        const releasing = manager.releaseSession("session-1");
        repository.finishUpsert();

        await expect(rebinding).resolves.toMatchObject({
          assignedDevice: "emulator-new",
          cacheData: {},
        });
        await expect(releasing).resolves.toBe("emulator-new");
        expect(restoredDevices).toEqual(["emulator-old"]);
        expect(unboundDevices).toEqual(["emulator-old"]);
        expect(manager.getSession("session-1")).toBeNull();
        expect(manager.getSessionForDevice("emulator-old")).toBeNull();
        expect(manager.getSessionForDevice("emulator-new")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("publishes live heartbeat and label routing updates after deferred persistence", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository, undefined, () => ({
        restore: async () => {},
      }));
      const labels = {
        primary: "session-1",
        secondary: "session-2",
      };

      try {
        await manager.createSession("session-1", "emulator-old", "android", 1_000);
        manager.setLastHierarchy("session-1", makeHierarchy("old"));
        manager.setKeepScreenAwake("session-1", { applied: true });
        repository.deferNextUpsert();

        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.waitForUpsert();

        fakeTimer.advanceTime(100);
        manager.setDeviceLabels("session-1", labels);
        fakeTimer.advanceTime(50);
        manager.recordHeartbeat("session-1");
        repository.finishUpsert();

        await expect(rebinding).resolves.toMatchObject({
          assignedDevice: "emulator-new",
          lastUsedAt: 150,
          lastHeartbeat: 150,
          expiresAt: 1_150,
          hasReceivedHeartbeat: true,
          cacheData: { deviceLabels: labels },
        });
        expect(manager.getDeviceLabels("session-1")).toEqual(labels);
        expect(manager.getSession("session-1")?.cacheData).toEqual({ deviceLabels: labels });
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("waits for a pending rebind before admitting a new execution", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        await manager.createSession("session-1", "emulator-old", "android");
        repository.deferNextUpsert();

        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.waitForUpsert();
        let resolvedDevice: string | null = null;
        const resolving = manager.getOrCreateSession("session-1").then((session) => {
          resolvedDevice = session.assignedDevice;
          return session;
        });
        await Promise.resolve();

        expect(resolvedDevice).toBeNull();
        repository.finishUpsert();

        await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
        await expect(resolving).resolves.toMatchObject({ assignedDevice: "emulator-new" });
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("does not admit device-state setup while a rebind is pending", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        const session = await manager.createSession("session-1", "emulator-old", "android");
        repository.deferNextUpsert();

        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.waitForUpsert();
        let setupStarted = false;
        await manager.trackSessionSetup(session, async () => {
          setupStarted = true;
        });

        expect(setupStarted).toBe(false);
        repository.finishUpsert();
        await rebinding;
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("serializes expiry cleanup with a pending rebind", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository, () => new FakeDbWriteBarrier());

      try {
        await manager.createSession("session-1", "emulator-old", "android", 1);
        repository.deferNextUpsert();
        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.waitForUpsert();

        fakeTimer.advanceTime(2);
        manager.cleanupExpiredSessions();
        repository.finishUpsert();

        await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
        await expect(manager.drainReleasePromises(10)).resolves.toBe(true);
        expect(manager.getSession("session-1")).toBeNull();
        expect(manager.getSessionForDevice("emulator-old")).toBeNull();
        expect(manager.getSessionForDevice("emulator-new")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("does not remove rebind ownership when lazy expiry observes the pending rebind", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        await manager.createSession("session-1", "emulator-old", "android", 1);
        repository.deferNextUpsert();
        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.waitForUpsert();

        fakeTimer.advanceTime(2);
        expect(manager.getSession("session-1")).toBeNull();
        repository.finishUpsert();

        await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
        await expect(manager.drainReleasePromises(10)).resolves.toBe(true);
        expect(manager.getSession("session-1")).toBeNull();
        expect(manager.getSessionForDevice("emulator-old")).toBeNull();
        expect(manager.getSessionForDevice("emulator-new")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("does not recreate a session when a release wins the rebind race", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = new SessionManager(fakeTimer, repository);

      try {
        await manager.createSession("session-1", "emulator-old", "android");
        const releasing = manager.releaseSession("session-1");
        await expect(manager.rebindSession("session-1", "emulator-new", "android")).rejects.toThrow(
          "Cannot rebind released session session-1",
        );
        await expect(releasing).resolves.toBe("emulator-old");
        expect(manager.getSession("session-1")).toBeNull();
        expect(manager.getSessionForDevice("emulator-new")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
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
      expect(session.cacheData.lastHierarchy?.hierarchy.node?.["view-id"]).toBe(
        "com.example:id/root",
      );
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
      expect(session2?.lastUsedAt ?? 0).toBe(initialLastUsed + 10);
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
      const restoreStarted = new Promise<void>((resolve) => {
        beginRestore = resolve;
      });
      let finishRestore!: () => void;
      const restoreFinished = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      const restorer: KeepScreenAwakeRestorer = {
        async restore(_state: KeepScreenAwakeState): Promise<void> {
          beginRestore();
          await restoreFinished;
        },
      };
      const repository = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(sessionId: string): Promise<void> {
          released.push(sessionId);
        },
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
        manager.onSessionRelease((sessionId) => callbacks.push(sessionId));

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
      const setupFinished = new Promise<void>((resolve) => {
        finishSetup = resolve;
      });
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
      );
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
      const initialSetup = new Promise<void>((resolve) => {
        finishInitialSetup = resolve;
      });
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
      );
      try {
        const session = await manager.createSession("s1", "device-1", "android");
        const setup = manager.trackSessionSetup(session, () => initialSetup);
        const release = manager.releaseSession("s1", "daemon-shutdown");
        let lateSetupStarted = false;

        await Promise.resolve();
        await manager.trackSessionSetup(session, async () => {
          lateSetupStarted = true;
        });
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
      const setupFinished = new Promise<void>((resolve) => {
        finishSetup = resolve;
      });
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
      );
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
      const restoreFinished = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
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
      const firstPersistence = new Promise<void>((resolve) => {
        finishFirstPersistence = resolve;
      });
      let firstPersistenceStarted!: () => void;
      const firstPersistenceStartedPromise = new Promise<void>((resolve) => {
        firstPersistenceStarted = resolve;
      });
      const releases: string[] = [];
      const repository = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(
          _sessionId: string,
          _status: string,
          _releasedAt: number,
          reason: string,
        ): Promise<void> {
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
        expect(manager.getSession("s1")).toMatchObject({ assignedDevice: "device-2" });
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
          async markReleased(sessionId: string): Promise<void> {
            released.push(sessionId);
          },
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

    test("keeps a device quarantined until timed-out keep-awake restoration completes", async () => {
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
          async markStaleActiveSessionsExpired(): Promise<void> {},
        },
        () => new FakeDbWriteBarrier(),
        () => ({
          restore: async () => {
            restoreStarted();
            await restoration;
          },
        }),
      );
      const pool = new DevicePool(
        manager,
        "test-daemon",
        fakeTimer,
        new FakeInstalledAppsRepository(),
        new FakeDeviceManager(),
      );
      try {
        await pool.initializeWithDevices([
          { name: "device-1", deviceId: "device-1", platform: "android" },
        ]);
        await pool.assignDeviceToSession("s1", "android");
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });

        const release = manager.releaseSession("s1", "daemon-shutdown");
        await restorationStarted;
        await Promise.resolve();
        fakeTimer.advanceTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
        const deviceId = await release;
        await pool.releaseDevice(deviceId!, "s1");

        expect(pool.getDevice("device-1")).toMatchObject({ sessionId: "s1", status: "busy" });

        // A same-serial replacement must not be released by the old deferred callback.
        const oldDevice = pool.getDevice("device-1")!;
        oldDevice.sessionId = null;
        oldDevice.status = "idle";
        await pool.removeDevice("device-1");
        await pool.initializeWithDevices([
          { name: "device-1", deviceId: "device-1", platform: "android" },
        ]);
        await pool.assignDeviceToSession("s2", "android");

        finishRestore();
        for (
          let attempt = 0;
          attempt < 10 && pool.getDevice("device-1")?.status !== "idle";
          attempt++
        ) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(pool.getDevice("device-1")).toMatchObject({ sessionId: "s2", status: "busy" });
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("coalesces a failed in-flight release into terminal cleanup", async () => {
      let rejectRestore!: (error: Error) => void;
      const restore = new Promise<void>((_resolve, reject) => {
        rejectRestore = reject;
      });
      const released: string[] = [];
      const manager = new SessionManager(
        fakeTimer,
        {
          async upsertActiveSession(): Promise<void> {},
          async recordActivity(): Promise<void> {},
          async markReleased(sessionId: string): Promise<void> {
            released.push(sessionId);
          },
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

  describe("biometric enrollment restoration", () => {
    test("restores the original iOS Simulator enrollment when a session releases", async () => {
      const restored: string[] = [];
      const restorer: BiometricEnrollmentRestorer = {
        restore: async (enrollment) => {
          restored.push(enrollment);
        },
      };
      const manager = new SessionManager(
        fakeTimer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        () => restorer,
      );
      try {
        await manager.createSession("ios-biometric", "sim-1", "ios");
        manager.setBiometricEnrollment("ios-biometric", { initialEnrollment: "not_enrolled" });
        // The initial state is write-once; a later change must not replace it.
        manager.setBiometricEnrollment("ios-biometric", { initialEnrollment: "enrolled" });

        await manager.releaseSession("ios-biometric");

        expect(restored).toEqual(["not_enrolled"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("restores the old simulator enrollment before a session rebinds", async () => {
      const restored: Array<{ deviceId: string; enrollment: string }> = [];
      const manager = new SessionManager(
        fakeTimer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        (device) => ({
          restore: async (enrollment) => {
            restored.push({ deviceId: device.deviceId, enrollment });
          },
        }),
      );
      try {
        await manager.createSession("ios-rebind", "sim-a", "ios");
        manager.setBiometricEnrollment("ios-rebind", { initialEnrollment: "enrolled" });

        await manager.rebindSession("ios-rebind", "sim-b", "ios");

        expect(restored).toEqual([{ deviceId: "sim-a", enrollment: "enrolled" }]);
        expect(manager.getBiometricEnrollment("ios-rebind")).toBeUndefined();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("waits for an active biometric setup before restoring the old simulator", async () => {
      const restored: string[] = [];
      const manager = new SessionManager(
        fakeTimer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        () => ({ restore: async (enrollment) => restored.push(enrollment) }),
      );
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      try {
        const session = await manager.createSession("ios-rebind-active", "sim-a", "ios");
        manager.setBiometricEnrollment("ios-rebind-active", { initialEnrollment: "enrolled" });
        const setup = manager.trackSessionSetup(session, async () => {
          started.resolve();
          await finished.promise;
        });
        await started.promise;

        const rebind = manager.rebindSession("ios-rebind-active", "sim-b", "ios");
        await Promise.resolve();
        expect(restored).toEqual([]);

        finished.resolve();
        await setup;
        await rebind;

        expect(restored).toEqual(["enrolled"]);
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("keeps the device quarantined and retries when the restore fails", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        () => ({
          restore: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("simctl rejected the restore");
            }
          },
        }),
      );
      try {
        await manager.createSession("ios-restore-retry", "sim-dirty", "ios");
        manager.setBiometricEnrollment("ios-restore-retry", { initialEnrollment: "not_enrolled" });

        await manager.releaseSession("ios-restore-retry");

        // The failed first attempt must leave post-release work outstanding, so
        // DevicePool defers the device instead of idling it dirty.
        const cleanup = manager.getPendingDeviceCleanup("sim-dirty");
        expect(cleanup).not.toBeNull();
        expect(attempts).toBe(1);

        await timer.advanceTimeAsync(250);
        await cleanup;
        expect(attempts).toBe(2);
        expect(manager.getPendingDeviceCleanup("sim-dirty")).toBeNull();
      } finally {
        manager.stopCleanupTimer();
      }
    });

    test("stops retrying the restore after the bounded attempts are exhausted", async () => {
      const timer = new FakeTimer();
      let attempts = 0;
      const manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        () => ({
          restore: async () => {
            attempts += 1;
            throw new Error("simctl rejected the restore");
          },
        }),
      );
      try {
        await manager.createSession("ios-restore-exhausted", "sim-dirty-2", "ios");
        manager.setBiometricEnrollment("ios-restore-exhausted", {
          initialEnrollment: "not_enrolled",
        });

        await manager.releaseSession("ios-restore-exhausted");
        const cleanup = manager.getPendingDeviceCleanup("sim-dirty-2");
        await timer.advanceTimeAsync(250);
        await timer.advanceTimeAsync(250);
        await cleanup;

        // One initial attempt plus the bounded retries, then the device is freed
        // rather than quarantined forever.
        expect(attempts).toBe(3);
      } finally {
        manager.stopCleanupTimer();
      }
    });
  });

  describe("biometric enrollment restoration platform independence", () => {
    test("restores cached enrollment even when the session declares a non-iOS platform", async () => {
      const restored: Array<{ deviceId: string; enrollment: string }> = [];
      const manager = new SessionManager(
        fakeTimer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        (device) => ({
          restore: async (enrollment) => {
            restored.push({ deviceId: device.deviceId, enrollment });
          },
        }),
      );
      try {
        // setActiveDevice stores the caller-declared platform, which can
        // disagree with the simulator actually bound. The cached enrollment is
        // iOS-only evidence and must still be restored.
        await manager.createSession("mislabelled", "sim-1", "android");
        manager.setBiometricEnrollment("mislabelled", { initialEnrollment: "not_enrolled" });

        await manager.releaseSession("mislabelled");

        expect(restored).toEqual([{ deviceId: "sim-1", enrollment: "not_enrolled" }]);
      } finally {
        manager.stopCleanupTimer();
      }
    });
  });

  describe("biometric enrollment restoration on rebind", () => {
    test("quarantines the old simulator and retries when the rebind restore fails", async () => {
      const timer = new FakeTimer();
      const attempts: string[] = [];
      const manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        (device) => ({
          restore: async () => {
            attempts.push(device.deviceId);
            if (attempts.length === 1) {
              throw new Error("simctl rejected the restore");
            }
          },
        }),
      );
      try {
        await manager.createSession("ios-rebind-dirty", "sim-old", "ios");
        manager.setBiometricEnrollment("ios-rebind-dirty", { initialEnrollment: "not_enrolled" });

        await manager.rebindSession("ios-rebind-dirty", "sim-new", "ios");

        // The rebind must not complete by silently abandoning the old simulator.
        const cleanup = manager.getPendingDeviceCleanup("sim-old");
        expect(cleanup).not.toBeNull();
        expect(manager.getPendingDeviceCleanup("sim-new")).toBeNull();

        await timer.advanceTimeAsync(250);
        await cleanup;

        // The retry targets the OLD simulator even though the session has
        // already been reassigned to the new one.
        expect(attempts).toEqual(["sim-old", "sim-old"]);
      } finally {
        manager.stopCleanupTimer();
      }
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
      sessionManager.onSessionRelease((sessionId) => {
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
      await sessionManager.waitForSessionRelease("session-expiry");
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
      await sessionManager.waitForSessionRelease("session-timer");

      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-timer");
      expect(released[0].deviceId).toBe("emulator-5556");
    });

    test("persists expired status for lazy and periodic session expiry", async () => {
      const releases: Array<{ sessionId: string; status: DeviceSessionStatus; reason: string }> =
        [];
      const repository: DeviceSessionPersistence = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {},
        async markReleased(sessionId, status, _releasedAtMs, reason): Promise<void> {
          releases.push({ sessionId, status, reason });
        },
        async markStaleActiveSessionsExpired(): Promise<void> {},
      };
      const manager = new SessionManager(fakeTimer, repository);
      try {
        await manager.createSession("lazy-expiry", "emulator-5554", "android");
        fakeTimer.advanceTime(31 * 60 * 1000);
        expect(manager.getSession("lazy-expiry")).toBeNull();
        await manager.waitForSessionRelease("lazy-expiry");

        await manager.createSession("periodic-expiry", "emulator-5556", "android");
        fakeTimer.advanceTime(36 * 60 * 1000);
        await manager.waitForSessionRelease("periodic-expiry");

        expect(releases).toEqual([
          { sessionId: "lazy-expiry", status: "expired", reason: "lazy-expiry" },
          { sessionId: "periodic-expiry", status: "expired", reason: "cleanup-expired" },
        ]);
      } finally {
        manager.stopCleanupTimer();
      }
    });
  });

  describe("shutdown draining (issue #2792)", () => {
    // Minimal repo double capturing the fire-and-forget session writes.
    function makeRepo(): { repo: any; activity: string[]; released: string[] } {
      const activity: string[] = [];
      const released: string[] = [];
      const repo = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(sessionId: string): Promise<void> {
          activity.push(sessionId);
        },
        async markReleased(sessionId: string): Promise<void> {
          released.push(sessionId);
        },
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
        await mgr.waitForSessionRelease("s1");
        expect(released).toContain("s1");
        // Exactly one release promise is registered before daemon shutdown can
        // begin draining. A duplicate release regression would push this to 2.
        expect(barrier.trackedExisting.length).toBe(1);
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
        async recordActivity(sessionId: string): Promise<void> {
          activity.push(sessionId);
        },
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

  test("terminal device-loss UUID cannot silently allocate another device", async () => {
    await sessionManager.createSession("lost-session", "emulator-5554", "android");
    const released = Promise.withResolvers<void>();
    let releaseSnapshot: unknown;
    sessionManager.onSessionRelease((_sessionId, _deviceId, _reason, snapshot) => {
      releaseSnapshot = snapshot;
      released.resolve();
    });
    await sessionManager.releaseSession(
      "lost-session",
      "device-disconnected:emulator-5554;incident=emulator-loss-1",
    );
    await released.promise;
    let assignmentCount = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession() {
        assignmentCount += 1;
        return "emulator-5560";
      },
    };

    await expect(
      sessionManager.getOrCreateSession("lost-session", assigner, "android"),
    ).rejects.toThrow("terminal");
    expect(assignmentCount).toBe(0);
    expect(releaseSnapshot).toMatchObject({
      sessionId: "lost-session",
      deviceId: "emulator-5554",
      releaseReason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
      terminal: true,
    });
  });

  test("device-killed UUID cannot silently allocate another device", async () => {
    const session = await sessionManager.createSession(
      "killed-session",
      "emulator-5554",
      "android",
    );
    const setup = Promise.withResolvers<void>();
    void sessionManager.trackSessionSetup(session, () => setup.promise);
    const ordinaryRelease = sessionManager.releaseSession("killed-session", "explicit-release");
    const killedRelease = sessionManager.releaseSession("killed-session", "device-killed");
    setup.resolve();
    await Promise.all([ordinaryRelease, killedRelease]);
    let assignmentCount = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession() {
        assignmentCount += 1;
        return "emulator-5560";
      },
    };

    await expect(
      sessionManager.getOrCreateSession("killed-session", assigner, "android"),
    ).rejects.toThrow("terminal after device-killed");
    expect(assignmentCount).toBe(0);
    expect(sessionManager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      sessionId: "killed-session",
      deviceId: "emulator-5554",
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("device-killed upgrade during release persistence remains terminal", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      await manager.createSession("killed-session", "emulator-5554", "android");
      let callbackSnapshot: unknown;
      manager.onSessionRelease((_sessionId, _deviceId, _reason, snapshot) => {
        callbackSnapshot = snapshot;
      });
      const ordinaryRelease = manager.releaseSession("killed-session", "explicit-release");
      await persistence.releaseStarted.promise;
      const killedRelease = manager.releaseSession("killed-session", "device-killed");
      persistence.finishRelease.resolve();
      await Promise.all([ordinaryRelease, killedRelease]);
      let assignmentCount = 0;
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession() {
          assignmentCount += 1;
          return "emulator-5560";
        },
      };

      await expect(
        manager.getOrCreateSession("killed-session", assigner, "android"),
      ).rejects.toThrow("terminal after device-killed");
      expect(assignmentCount).toBe(0);
      expect(persistence.reasons).toEqual(["explicit-release", "device-killed"]);
      expect(callbackSnapshot).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("device-killed supersedes a terminal release during persistence", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession("killed-session", "emulator-5554", "android");
      const callbacks: string[] = [];
      manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));

      const timeoutRelease = manager.releaseSession("killed-session", "heartbeat-timeout");
      await persistence.releaseStarted.promise;
      const killedRelease = manager.releaseSessionIfOwned(
        "killed-session",
        session,
        "emulator-5554",
        "device-killed",
      );
      persistence.finishRelease.resolve();
      await Promise.all([timeoutRelease, killedRelease]);

      expect(persistence.reasons).toEqual(["heartbeat-timeout", "device-killed"]);
      expect(callbacks).toEqual(["device-killed"]);
      expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("device-killed supersedes a finalized terminal release", async () => {
    const reasons: string[] = [];
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, reason) => {
      reasons.push(reason);
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession("killed-session", "emulator-5554", "android");
      const callbacks: string[] = [];
      manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));

      await manager.releaseSession("killed-session", "heartbeat-timeout");
      await manager.releaseSessionIfOwned(
        "killed-session",
        session,
        "emulator-5554",
        "device-killed",
      );

      expect(reasons).toEqual(["heartbeat-timeout", "device-killed"]);
      expect(callbacks).toEqual(["heartbeat-timeout", "device-killed"]);
      expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("device-killed remains terminal when persistence retries through ordinary release", async () => {
    const reasons: string[] = [];
    let failRelease = true;
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, reason) => {
      reasons.push(reason);
      if (failRelease) {
        failRelease = false;
        throw new Error("terminal write failed");
      }
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      await manager.createSession("killed-session", "emulator-5554", "android");
      const callbacks: string[] = [];
      manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));

      await expect(manager.releaseSession("killed-session", "device-killed")).rejects.toThrow(
        "Failed to persist terminal release",
      );
      await manager.releaseSession("killed-session", "explicit-release");

      expect(reasons).toEqual(["device-killed", "device-killed"]);
      expect(callbacks).toEqual(["device-killed"]);
      expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
      await expect(
        manager.getOrCreateSession("killed-session", {
          async assignDeviceToSession() {
            return "emulator-5560";
          },
        }),
      ).rejects.toThrow("terminal after device-killed");
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("retries a failed device-killed upgrade during release persistence", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    let failTerminalRelease = true;
    const markReleased = persistence.markReleased.bind(persistence);
    persistence.markReleased = async (sessionUuid, status, releasedAtMs, reason) => {
      await markReleased(sessionUuid, status, releasedAtMs, reason);
      if (reason === "device-killed" && failTerminalRelease) {
        failTerminalRelease = false;
        throw new Error("terminal write failed");
      }
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession("killed-session", "emulator-5554", "android");
      const callbacks: string[] = [];
      manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));
      const ordinaryRelease = manager.releaseSession("killed-session", "explicit-release");
      await persistence.releaseStarted.promise;
      const killedRelease = manager.releaseSessionIfOwned(
        "killed-session",
        session,
        "emulator-5554",
        "device-killed",
      );
      persistence.finishRelease.resolve();

      await expect(Promise.all([ordinaryRelease, killedRelease])).rejects.toThrow(
        "Failed to persist terminal release",
      );
      await expect(manager.releaseSession("killed-session", "device-killed")).resolves.toBe(
        "emulator-5554",
      );
      await expect(manager.releaseSession("killed-session", "device-killed")).resolves.toBe(
        "emulator-5554",
      );
      await expect(
        manager.releaseSessionIfOwned("killed-session", session, "emulator-5554", "device-killed"),
      ).resolves.toBe("emulator-5554");

      expect(persistence.reasons).toEqual(["explicit-release", "device-killed", "device-killed"]);
      expect(callbacks).toEqual(["explicit-release", "device-killed"]);
      expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("device-killed upgrade after release finalization remains terminal", async () => {
    const reasons: string[] = [];
    const terminalPersistenceStarted = Promise.withResolvers<void>();
    const finishTerminalPersistence = Promise.withResolvers<void>();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, reason) => {
      reasons.push(reason);
      if (reason === "device-killed") {
        terminalPersistenceStarted.resolve();
        await finishTerminalPersistence.promise;
      }
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      await manager.createSession("killed-session", "emulator-5554", "android");
      let killedRelease: Promise<string | null> | undefined;
      const callbacks: string[] = [];
      manager.onSessionRelease((_sessionId, _deviceId, reason) => {
        callbacks.push(reason);
        if (reason === "explicit-release") {
          // Let the ordinary persistence continuation finalize its snapshot,
          // then escalate before releaseSession's outer finally removes the
          // operation. This discriminates the late-finalized branch from the
          // earlier mutable-reason upgrade path.
          void Promise.resolve()
            .then(() => undefined)
            .then(() => undefined)
            .then(() => {
              killedRelease = manager.releaseSession("killed-session", "device-killed");
            });
        }
      });

      const ordinaryRelease = manager.releaseSession("killed-session", "explicit-release");
      await terminalPersistenceStarted.promise;
      const ordinaryOutcome = await Promise.race([
        ordinaryRelease.then(() => "released" as const),
        new Promise<"blocked">((resolve) => setImmediate(() => resolve("blocked"))),
      ]);
      finishTerminalPersistence.resolve();
      await killedRelease;

      expect(ordinaryOutcome).toBe("released");
      expect(reasons).toEqual(["explicit-release", "device-killed"]);
      expect(callbacks).toEqual(["explicit-release", "device-killed"]);
      expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("owned device-loss upgrade after release finalization remains terminal", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession(
        "disconnected-session",
        "emulator-5554",
        "android",
      );
      let disconnectedRelease: Promise<string | null> | undefined;
      manager.onSessionRelease((_sessionId, _deviceId, reason) => {
        if (reason === "explicit-release") {
          disconnectedRelease = manager.releaseSessionIfOwned(
            "disconnected-session",
            session,
            "emulator-5554",
            "device-disconnected:emulator-5554",
          );
        }
      });

      await manager.releaseSession("disconnected-session", "explicit-release");
      await disconnectedRelease;

      expect(manager.getTerminalReleaseSnapshot("disconnected-session")).toMatchObject({
        releaseReason: "device-disconnected:emulator-5554",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("owned device-loss upgrade after an ordinary release remains terminal", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession(
        "disconnected-session",
        "emulator-5554",
        "android",
      );

      await manager.releaseSession("disconnected-session", "explicit-release");
      await manager.releaseSessionIfOwned(
        "disconnected-session",
        session,
        "emulator-5554",
        "device-disconnected:emulator-5554",
      );

      expect(manager.getTerminalReleaseSnapshot("disconnected-session")).toMatchObject({
        releaseReason: "device-disconnected:emulator-5554",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("retries a failed owned terminal upgrade after an ordinary release", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const reasons: string[] = [];
    let failTerminalRelease = true;
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, reason) => {
      reasons.push(reason);
      if (reason === "device-killed" && failTerminalRelease) {
        failTerminalRelease = false;
        throw new Error("terminal write failed");
      }
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession("killed-session", "emulator-5554", "android");
      await manager.releaseSession("killed-session", "explicit-release");

      await expect(
        manager.releaseSessionIfOwned("killed-session", session, "emulator-5554", "device-killed"),
      ).rejects.toThrow("Failed to persist terminal release");
      await expect(
        manager.releaseSessionIfOwned("killed-session", session, "emulator-5554", "device-killed"),
      ).resolves.toBe("emulator-5554");

      expect(reasons).toEqual(["explicit-release", "device-killed", "device-killed"]);
      expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
        releaseReason: "device-killed",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot replace a newer incarnation terminal release", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const reasons: string[] = [];
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, reason) => {
      reasons.push(reason);
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", "explicit-release");
      await manager.createSession("reused-session", "new-device", "android");
      await manager.releaseSession(
        "reused-session",
        "device-disconnected:new-device;incident=new-loss",
      );

      await expect(
        manager.releaseSessionIfOwned("reused-session", oldSession, "old-device", "device-killed"),
      ).resolves.toBeNull();

      expect(reasons).toEqual([
        "explicit-release",
        "device-disconnected:new-device;incident=new-loss",
      ]);
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toMatchObject({
        deviceId: "new-device",
        releaseReason: "device-disconnected:new-device;incident=new-loss",
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot bypass a newer incarnation release in flight", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const newerReleaseStarted = Promise.withResolvers<void>();
    const finishNewerRelease = Promise.withResolvers<void>();
    let releaseCount = 0;
    persistence.markReleased = async () => {
      releaseCount += 1;
      if (releaseCount === 2) {
        newerReleaseStarted.resolve();
        await finishNewerRelease.promise;
      }
    };
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", "explicit-release");
      await manager.createSession("reused-session", "new-device", "android");
      const newerRelease = manager.releaseSession("reused-session", "explicit-release");
      await newerReleaseStarted.promise;

      await expect(
        manager.releaseSessionIfOwned("reused-session", oldSession, "old-device", "device-killed"),
      ).resolves.toBeNull();
      finishNewerRelease.resolve();
      await newerRelease;

      expect(releaseCount).toBe(2);
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      finishNewerRelease.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot replace a newer finalized ordinary release", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      const oldRelease = manager.releaseSession("reused-session", "explicit-release");
      await persistence.releaseStarted.promise;
      const newerCreation = manager.createSession("reused-session", "new-device", "android");
      persistence.finishRelease.resolve();
      await oldRelease;
      await expect(newerCreation).resolves.toMatchObject({ assignedDevice: "new-device" });
      await manager.releaseSession("reused-session", "explicit-release");

      await expect(
        manager.releaseSessionIfOwned("reused-session", oldSession, "old-device", "device-killed"),
      ).resolves.toBeNull();

      expect(persistence.reasons).toEqual(["explicit-release", "explicit-release"]);
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      persistence.finishRelease.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("terminal upgrade blocks replacement publication until its fence is durable", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      await manager.createSession("reused-session", "old-device", "android");
      const ordinaryRelease = manager.releaseSession("reused-session", "explicit-release");
      await persistence.releaseStarted.promise;
      const terminalRelease = manager.releaseSession("reused-session", "device-killed");
      const newerCreation = manager.createSession("reused-session", "new-device", "android");
      persistence.finishRelease.resolve();

      await Promise.all([ordinaryRelease, terminalRelease]);
      await expect(newerCreation).rejects.toThrow("terminal after device-killed");

      expect(persistence.reasons).toEqual(["explicit-release", "device-killed"]);
      expect(manager.getSession("reused-session")).toBeNull();
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toMatchObject({
        deviceId: "old-device",
        releaseReason: "device-killed",
      });
    } finally {
      persistence.finishRelease.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot fence a newer incarnation pending creation", async () => {
    const persistence = new DeferredDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", "explicit-release");
      persistence.deferNextUpsert();
      const newerCreation = manager.createSession("reused-session", "new-device", "android");
      await persistence.waitForUpsert();

      await expect(
        manager.releaseSessionIfOwned("reused-session", oldSession, "old-device", "device-killed"),
      ).resolves.toBeNull();
      persistence.finishUpsert();
      await expect(newerCreation).resolves.toMatchObject({ assignedDevice: "new-device" });

      expect(manager.getSession("reused-session")).toMatchObject({ assignedDevice: "new-device" });
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      persistence.finishUpsert();
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot fence a newer incarnation pending assignment", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    const assignmentStarted = Promise.withResolvers<void>();
    const finishAssignment = Promise.withResolvers<void>();
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", "explicit-release");
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId, platform) {
          assignmentStarted.resolve();
          await finishAssignment.promise;
          await manager.createSession(sessionId, "new-device", platform ?? "android");
          return "new-device";
        },
      };
      const newerAssignment = manager.getOrCreateSession("reused-session", assigner, "android");
      await assignmentStarted.promise;

      await expect(
        manager.releaseSessionIfOwned("reused-session", oldSession, "old-device", "device-killed"),
      ).resolves.toBeNull();
      finishAssignment.resolve();
      await expect(newerAssignment).resolves.toMatchObject({ assignedDevice: "new-device" });

      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      finishAssignment.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("terminal release reservation blocks UUID reuse until shutdown settles", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession("reserved-session", "emulator-5554", "android");
      const releaseReservation = manager.reserveSessionForTerminalRelease(session, "emulator-5554");
      await expect(
        manager.rebindSession("reserved-session", "emulator-5560", "android"),
      ).rejects.toThrow("being terminally released");
      await manager.releaseSession("reserved-session", "explicit-release");

      await expect(
        manager.createSession("reserved-session", "emulator-5560", "android"),
      ).rejects.toThrow("being terminally released");

      releaseReservation();
      await expect(
        manager.createSession("reserved-session", "emulator-5560", "android"),
      ).resolves.toMatchObject({ assignedDevice: "emulator-5560" });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("terminal release reservation rejects while an ordinary rebind is in flight", async () => {
    const persistence = new DeferredDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      const session = await manager.createSession("reserved-session", "emulator-5554", "android");

      persistence.deferNextUpsert();
      const rebind = manager.rebindSession("reserved-session", "emulator-5560", "android");
      await persistence.waitForUpsert();
      expect(() => manager.reserveSessionForTerminalRelease(session, "emulator-5554")).toThrow(
        "rebinding devices",
      );
      persistence.finishUpsert();

      await expect(rebind).resolves.toBe(session);
      expect(session.assignedDevice).toBe("emulator-5560");
      expect(persistence.upsertedDeviceIds).toEqual(["emulator-5554", "emulator-5560"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("terminal release fails closed when durable fencing cannot be persisted", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(fakeTimer, persistence);
    try {
      await manager.createSession("lost-session", "emulator-5554", "android");
      persistence.failure = "release";

      await expect(
        manager.releaseSession(
          "lost-session",
          "device-disconnected:emulator-5554;incident=emulator-loss-1",
        ),
      ).rejects.toThrow("Failed to persist terminal release");
      expect(manager.getSession("lost-session")).toBeNull();
      expect(manager.getSessionForDevice("emulator-5554")).toBe("lost-session");
      expect(manager.getTerminalReleaseSnapshot("lost-session")).toMatchObject({
        deviceId: "emulator-5554",
        releaseReason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
        terminal: true,
      });
      await expect(manager.getOrCreateSession("lost-session")).rejects.toThrow(
        "device-disconnected:emulator-5554",
      );

      persistence.failure = null;
      await expect(
        manager.releaseSession(
          "lost-session",
          "device-disconnected:emulator-5554;incident=emulator-loss-1",
        ),
      ).resolves.toBe("emulator-5554");
      expect(manager.getSession("lost-session")).toBeNull();
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("admits a persisted daemon-restart session for recreation", async () => {
    const persisted: DeviceSession = {
      session_uuid: "restarted-session",
      device_id: "emulator-5554",
      platform: "android",
      status: "expired",
      source: null,
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "old-daemon",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "daemon-restart",
      session_timeout_ms: 10,
      heartbeat_timeout_ms: 5,
      has_received_heartbeat: 1,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    };
    const persistence: DeviceSessionPersistence = {
      async getSession() {
        return persisted;
      },
      async upsertActiveSession() {},
      async recordActivity() {},
      async markReleased() {},
    };
    const restarted = new SessionManager(fakeTimer, persistence);
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId: string): Promise<string> {
        await restarted.createSession(sessionId, "emulator-5560", "android");
        return "emulator-5560";
      },
    };
    try {
      await expect(
        restarted.admitIssuedSessionForAutomation("restarted-session"),
      ).resolves.toBeUndefined();
      await expect(
        restarted.getOrCreateSession("restarted-session", devicePool, "android"),
      ).resolves.toMatchObject({ assignedDevice: "emulator-5560" });
      persisted.status = "released";
      persisted.release_reason = "daemon-shutdown";
      const gracefullyRestarted = new SessionManager(fakeTimer, persistence);
      try {
        await expect(
          gracefullyRestarted.admitIssuedSessionForAutomation("restarted-session"),
        ).resolves.toBeUndefined();
      } finally {
        gracefullyRestarted.stopCleanupTimer();
      }
      persisted.release_reason = "explicit-release";
      const ordinarilyReleased = new SessionManager(fakeTimer, persistence);
      try {
        await expect(
          ordinarilyReleased.admitIssuedSessionForAutomation("restarted-session"),
        ).resolves.toBeUndefined();
      } finally {
        ordinarilyReleased.stopCleanupTimer();
      }
    } finally {
      restarted.stopCleanupTimer();
    }
  });

  test("terminal device-loss UUID remains fenced after manager restart", async () => {
    const persisted: DeviceSession = {
      session_uuid: "lost-session",
      device_id: "emulator-5554",
      platform: "android",
      status: "released",
      source: null,
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "old-daemon",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
      session_timeout_ms: 10,
      heartbeat_timeout_ms: 5,
      has_received_heartbeat: 1,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    };
    let upsertCount = 0;
    const persistence: DeviceSessionPersistence = {
      async getSession() {
        return persisted;
      },
      async upsertActiveSession() {
        upsertCount += 1;
      },
      async recordActivity() {},
      async markReleased() {},
    };
    const restarted = new SessionManager(fakeTimer, persistence);
    const assignedSessionIds: string[] = [];
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId: string): Promise<string> {
        assignedSessionIds.push(sessionId);
        return "emulator-5560";
      },
    };
    try {
      await expect(
        restarted.getOrCreateSession("lost-session", devicePool, "android"),
      ).rejects.toThrow("terminal");
      expect(assignedSessionIds).toEqual([]);
      expect(upsertCount).toBe(0);
    } finally {
      restarted.stopCleanupTimer();
    }
  });

  test("preserves a terminal release discovered while admitting an unissued UUID", async () => {
    const persisted: DeviceSession = {
      session_uuid: "late-terminal-session",
      device_id: "emulator-5554",
      platform: "android",
      status: "released",
      source: null,
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "old-daemon",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "device-killed",
      session_timeout_ms: 10,
      heartbeat_timeout_ms: 5,
      has_received_heartbeat: 1,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    };
    let readCount = 0;
    const persistence: DeviceSessionPersistence = {
      async getSession() {
        readCount += 1;
        return readCount === 1 ? undefined : persisted;
      },
      async upsertActiveSession() {},
      async recordActivity() {},
      async markReleased() {},
    };
    const manager = new SessionManager(fakeTimer, persistence);

    try {
      await expect(
        manager.admitIssuedSessionForAutomation("late-terminal-session"),
      ).rejects.toThrow("terminal");
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
