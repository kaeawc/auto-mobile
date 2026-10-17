import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "../../src/daemon/sessionLivenessWindows";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { describe, expect, test } from "bun:test";
import { SessionManager, PLAN_AUTO_RELEASE_REASON } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import {
  DeferredDeviceSessionPersistence,
  installSessionManagerFixture,
  makeSessionManager,
  stubbedPersistence,
} from "../helpers/sessionManagerSuite";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    sessionManager = fixture.manager;
    fakeTimer = fixture.timer;
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
      const expectedExpiry = beforeCreate + DEFAULT_SESSION_IDLE_TIMEOUT_MS; // 2 minutes
      expect(session.expiresAt).toBe(expectedExpiry);
    });

    test("should persist custom timeout on the session", async () => {
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 5000,
      });
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
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 30_000,
        heartbeatTimeoutMs: 15_000,
      });

      expect(session.heartbeatTimeoutMs).toBe(15_000);
      expect(session.heartbeatTimeoutSource).toBe("custom");
    });

    test("removes every ownership mapping when persistence rejects", async () => {
      const repository = new FakeDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });
      repository.failure = "create";

      await expect(
        manager.createSession("session-failure", "emulator-5554", "android"),
      ).rejects.toThrow("persist create failed");

      expect(manager.getSession("session-failure")).toBeNull();
      expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    test("releases a session after its pending creation finishes", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      repository.deferNextUpsert();
      const creation = manager.createSession("session-pending-release", "emulator-5554", "android");
      await repository.waitForUpsert();
      const release = manager.releaseSession("session-pending-release");

      repository.finishUpsert();

      await expect(creation).resolves.toMatchObject({ sessionId: "session-pending-release" });
      await expect(release).resolves.toBe("emulator-5554");
      expect(manager.getSession("session-pending-release")).toBeNull();
      expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
    });

    test("includes a pending creation in the shutdown session snapshot", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      repository.deferNextUpsert();
      const creating = manager.createSession("pending-shutdown", "emulator-5554", "android");
      await repository.waitForUpsert();

      expect(manager.getAllSessionIds()).toEqual([]);
      expect(manager.getAllKnownSessionIds()).toEqual(["pending-shutdown"]);

      repository.finishUpsert();
      await creating;
    });

    test("fences session publication when persistence outlives acquisition cancellation", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });
      const controller = new AbortController();
      try {
        repository.deferNextUpsert();
        const creating = runWithAbortSignal(controller.signal, () =>
          manager.createSession("expired-acquisition", "emulator-5554", "android"),
        );
        await repository.waitForUpsert();
        controller.abort(new Error("provision deadline exhausted"));
        repository.finishUpsert();
        await expect(creating).rejects.toThrow("provision deadline exhausted");
        expect(manager.getSession("expired-acquisition")).toBeNull();
        expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
        expect(manager.getTerminalReleaseSnapshot("expired-acquisition")).toMatchObject({
          releaseReason: "session-creation-cancelled",
          terminal: true,
        });
      } finally {
        repository.finishUpsert();
        manager.stopCleanupTimer();
      }
    });

    test("terminally rejects a creation whose persistence outlives the shutdown fence", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });
      const releaseReasons: string[] = [];
      manager.onSessionRelease((_sessionId, _deviceId, reason) => {
        releaseReasons.push(reason);
      });

      try {
        repository.deferNextUpsert();
        const creating = manager.createSession(
          "persisting-during-shutdown",
          "emulator-5554",
          "android",
        );
        await repository.waitForUpsert();

        manager.stopAcceptingSessionCreations();
        repository.finishUpsert();

        await expect(creating).rejects.toMatchObject({
          sessionUuid: "persisting-during-shutdown",
          release: expect.objectContaining({ releaseReason: "daemon-shutdown" }),
        });
        expect(manager.getSession("persisting-during-shutdown")).toBeNull();
        expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
        expect(manager.getTerminalReleaseSnapshot("persisting-during-shutdown")).toMatchObject({
          releaseReason: "daemon-shutdown",
          terminal: true,
        });
        expect(releaseReasons).toEqual(["daemon-shutdown"]);
      } finally {
        repository.finishUpsert();
        manager.stopCleanupTimer();
      }
    });

    test("keeps ownership unpublished while a creation write is pending", async () => {
      let rejectFirstWrite!: (error: Error) => void;
      const firstWrite = new Promise<void>((_resolve, reject) => {
        rejectFirstWrite = reject;
      });
      let firstWritePending = true;
      const repository: DeviceSessionPersistence = stubbedPersistence({
        upsertActiveSession: async () => {
          if (firstWritePending) {
            firstWritePending = false;
            await firstWrite;
          }
        },
        recordActivity: async () => {},
        markReleased: async () => {},
      });
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

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
    });

    test("does not report a finalized identity as latest while its replacement is being created", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      const original = await manager.createSession("reused", "emulator-old", "android");
      await manager.releaseSession("reused", PLAN_AUTO_RELEASE_REASON);
      expect(manager.isLatestSessionIdentity(original)).toBe(true);

      repository.deferNextUpsert();
      const replacementCreation = manager.createSession("reused", "emulator-new", "android");
      await repository.waitForUpsert();
      expect(manager.isLatestSessionIdentity(original)).toBe(false);

      repository.finishUpsert();
      const replacement = await replacementCreation;
      expect(manager.isLatestSessionIdentity(original)).toBe(false);
      expect(manager.isLatestSessionIdentity(replacement)).toBe(true);
    });
  });
});
