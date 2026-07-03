import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

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
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: "test-hierarchy",
        lastScreenshot: "base64-data",
      });
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache?.lastHierarchy).toBe("test-hierarchy");
      expect(cache?.lastScreenshot).toBe("base64-data");
    });

    test("should get session cache without modifying other fields", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        customData: { key: "value" },
      });
      const session1 = sessionManager.getSession("session-1");
      const initialLastUsed = session1?.lastUsedAt ?? 0;
      fakeTimer.advanceTime(10);
      const cache = sessionManager.getSessionCache("session-1");
      const session2 = sessionManager.getSession("session-1");
      expect(cache?.customData).toEqual({ key: "value" });
      expect((session2?.lastUsedAt ?? 0)).toBe(initialLastUsed + 10);
    });

    test("should clear specific cache key", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: "test-hierarchy",
        lastScreenshot: "base64-data",
      });
      sessionManager.clearSessionCache("session-1", "lastHierarchy");
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache?.lastHierarchy).toBeUndefined();
      expect(cache?.lastScreenshot).toBe("base64-data");
    });

    test("should clear all cache when no key specified", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: "test-hierarchy",
        lastScreenshot: "base64-data",
        customData: { key: "value" },
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
        expect(barrier.ran.length).toBeGreaterThan(0);
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
        expect(barrier.ran.length).toBeGreaterThan(0);
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
});
