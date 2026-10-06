import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  SessionManager,
  SessionSuspectError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10051: after lease expiry a session is held as suspect for a 10 s grace window
// with its device reserved for the owner token, and the daemon never reaps on the
// strength of its own stall. Everything runs on a fake timer against the real
// heartbeat handler, session manager and heartbeat monitor.

const SESSION = "suspect-session";
const DEVICE = "emulator-5554";
const OWNER = "harness-a";
const FOREIGN = "harness-b";
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

interface Reaped {
  sessionId: string;
  reason: string;
}

describe("suspect grace window and daemon stall (#10051)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let reaped: Reaped[];
  let monitor: SessionHeartbeatMonitor;

  function state(manager: SessionManager = sessionManager): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => DEVICE_POOL,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  function heartbeat(token: string, claim = false, manager: SessionManager = sessionManager) {
    return handleDaemonRequest(
      {
        id: "heartbeat",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessOwnerToken: token,
          ...(claim ? { claimLivenessOwnership: true } : {}),
        },
      },
      state(manager),
    );
  }

  async function sessionInfo() {
    return handleDaemonRequest(
      {
        id: "info",
        type: "daemon_request",
        method: "daemon/sessionInfo",
        params: { sessionId: SESSION },
      },
      state(),
    );
  }

  function monitorFor(manager: SessionManager): SessionHeartbeatMonitor {
    return new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaped = [];
    monitor = monitorFor(sessionManager);
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
    const claim = await heartbeat(OWNER, true);
    expect(claim.success).toBe(true);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
  });

  describe("expiry, suspect and restore", () => {
    test("a missed lease makes the session suspect instead of releasing it", async () => {
      timer.advanceTime(LEASE_MS + 1);
      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
        phase: "suspect",
        remainingMs: SUSPECT_GRACE_MS - 1,
      });
      expect(sessionManager.getSession(SESSION)).not.toBeNull();
    });

    test("the owner's heartbeat inside the window restores the same session and device", async () => {
      const original = sessionManager.getSession(SESSION);
      timer.advanceTime(LEASE_MS + 5_000);
      await monitor.tick();
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");

      const restored = await heartbeat(OWNER);

      expect(restored.success).toBe(true);
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
      expect(sessionManager.getSession(SESSION)).toBe(original);
      expect(sessionManager.getSession(SESSION)?.assignedDevice).toBe(DEVICE);

      // The restored lease runs its full length again, then suspect again.
      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS);
      await monitor.tick();
      expect(reaped).toEqual([]);
    });

    test("session-info reports live, then suspect with the time left in the window", async () => {
      expect((await sessionInfo()).result).toMatchObject({
        liveness: { state: "live", remainingMs: LEASE_MS },
      });

      timer.advanceTime(LEASE_MS + 3_000);

      expect((await sessionInfo()).result).toMatchObject({
        sessionId: SESSION,
        assignedDevice: DEVICE,
        liveness: { state: "suspect", remainingMs: SUSPECT_GRACE_MS - 3_000 },
      });
    });
  });

  describe("while suspect", () => {
    beforeEach(() => {
      timer.advanceTime(LEASE_MS + 1);
    });

    test("a claim from a different token is rejected and changes nothing", async () => {
      const before = sessionManager.getSession(SESSION)?.lastHeartbeat;

      const claim = await heartbeat(FOREIGN, true);

      expect(claim).toMatchObject({ success: false, code: "liveness_owner_conflict" });
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(OWNER);
      expect(sessionManager.getSession(SESSION)?.lastHeartbeat).toBe(before);
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    });

    test("a plain heartbeat from another token cannot restore the session", async () => {
      const heartbeatFromForeign = await heartbeat(FOREIGN);

      expect(heartbeatFromForeign.success).toBe(false);
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    });

    test("its device stays reserved for the owner", () => {
      expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
      expect(sessionManager.getAssignedDevices().has(DEVICE)).toBe(true);
    });

    test("no tool call runs against it until the owner restores it", async () => {
      await expect(sessionManager.getOrCreateSession(SESSION)).rejects.toBeInstanceOf(
        SessionSuspectError,
      );
      await expect(
        sessionManager.admitIssuedSessionForAutomation(SESSION, undefined, {
          access: "read-only",
        }),
      ).rejects.toBeInstanceOf(SessionSuspectError);

      await heartbeat(OWNER);

      await expect(sessionManager.getOrCreateSession(SESSION)).resolves.toMatchObject({
        sessionId: SESSION,
      });
    });

    test("the rejection names the time left in the window", async () => {
      await expect(sessionManager.getOrCreateSession(SESSION)).rejects.toThrow(
        /suspect.*10s more.*device reserved/,
      );
    });
  });

  describe("after the window", () => {
    test("the session is released as heartbeat-timeout and the device is free", async () => {
      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();

      expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
      expect(sessionManager.getSession(SESSION)).toBeNull();
      expect(sessionManager.getSessionForDevice(DEVICE)).toBeNull();
      expect(sessionManager.getAssignedDevices().has(DEVICE)).toBe(false);
    });

    test("another token can then claim a session that still exists", async () => {
      // A session the monitor has not swept yet: the owner no longer blocks.
      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);

      const claim = await heartbeat(FOREIGN, true);

      expect(claim.success).toBe(true);
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(FOREIGN);
    });

    test("a silent owner is still reaped by on-schedule ticks after lease plus grace", async () => {
      monitor.start();
      for (let elapsed = 0; elapsed < LEASE_MS + SUSPECT_GRACE_MS; elapsed += 10_000) {
        timer.advanceTime(10_000);
        await Promise.resolve();
      }
      expect(reaped).toEqual([]);

      timer.advanceTime(10_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    });
  });

  describe("the daemon's own stall", () => {
    test("a tick that fires later than the lease reaps nothing", async () => {
      monitor.start();
      // The daemon's event loop stalls: no tick runs, no heartbeat is received.
      timer.setCurrentTime(timer.now() + 60_000);

      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(SESSION)).not.toBeNull();
      expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
        phase: "live",
        remainingMs: LEASE_MS,
      });
    });

    test("an owner that heartbeats after the daemon wakes keeps its session", async () => {
      const original = sessionManager.getSession(SESSION);
      monitor.start();
      timer.setCurrentTime(timer.now() + 60_000);
      await monitor.tick();

      expect((await heartbeat(OWNER)).success).toBe(true);
      timer.advanceTime(LEASE_MS);
      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(SESSION)).toBe(original);
    });

    test("an owner that never returns gets a fresh lease plus grace from the resumed tick", async () => {
      monitor.start();
      timer.setCurrentTime(timer.now() + 60_000);
      await monitor.tick();
      const resumedAt = timer.now();

      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();
      expect(timer.now() - resumedAt).toBe(LEASE_MS + SUSPECT_GRACE_MS + 1);
      expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    });

    test("a stall far longer than the session idle timeout does not expire it either", async () => {
      monitor.start();
      timer.setCurrentTime(timer.now() + 120_000);

      await monitor.tick();

      expect(sessionManager.getSession(SESSION)).not.toBeNull();
      expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
    });

    test("a tick only slightly late is not a stall and forgives nothing", async () => {
      monitor.start();
      // 5s late against a 10s threshold: heartbeats were being received.
      timer.setCurrentTime(timer.now() + 10_000 + 5_000);
      await monitor.tick();
      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBeUndefined();
    });

    test("a manually driven tick has no schedule to be late against", async () => {
      timer.setCurrentTime(timer.now() + 60_000);

      await monitor.tick();

      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBeUndefined();
      expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    });

    test("a one-shot CLI session keeps its own idle policy through a stall", async () => {
      sessionManager.adoptCliLivenessPolicy(SESSION);

      expect(sessionManager.forgiveDaemonStall(timer.now() + 60_000)).toBe(0);
      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBeUndefined();
      expect(sessionManager.getSessionLeaseState(SESSION)).toBeUndefined();
    });
  });

  describe("across a daemon restart", () => {
    test("a rehydrated session gets fresh deadlines and the suspect window once its owner returns", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      await persistence.upsertActiveSession({
        sessionUuid: SESSION,
        deviceId: DEVICE,
        stableDeviceId: "Pixel_8_API_35",
        platform: "android",
        createdAtMs: 1,
        lastUsedAtMs: 20,
        expiresAtMs: 60_020,
        sessionTimeoutMs: 60_000,
        heartbeatTimeoutMs: LEASE_MS,
        heartbeatTimeoutSource: "default",
        hasReceivedHeartbeat: true,
      });
      await persistence.recordLivenessOwnership(SESSION, OWNER);
      await persistence.markReleased(SESSION, "expired", 30, "daemon-restart");
      // The restarted daemon comes up long after the persisted heartbeat.
      timer.setCurrentTime(40);
      const restarted = new SessionManager(timer, persistence);
      const restartedMonitor = monitorFor(restarted);
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
          const session = await restarted.createSession(
            sessionId,
            DEVICE,
            "android",
            target?.liveness?.sessionTimeoutMs,
            target?.liveness?.heartbeatTimeoutMs,
            target?.stableDeviceId,
            target?.liveness,
            target?.initialOwnership,
          );
          return session.assignedDevice;
        },
      };
      try {
        await restarted.rehydratePersistedSessions(devicePool);
        const rehydrated = restarted.getSession(SESSION);
        // The downtime is not counted against the session.
        expect(rehydrated).toMatchObject({
          ownership: "awaiting-owner",
          awaitingOwnerSince: 40,
          lastHeartbeat: 40,
          livenessOwnerToken: OWNER,
        });
        timer.advanceTime(5_000);
        await restartedMonitor.tick();
        expect(reaped).toEqual([]);

        // The owner returns with its stable token and is live; a foreign claim is refused.
        expect((await heartbeat(OWNER, false, restarted)).success).toBe(true);
        expect(restarted.getSession(SESSION)).toMatchObject({ ownership: "owned" });
        expect((await heartbeat(FOREIGN, true, restarted)).code).toBe("liveness_owner_conflict");

        // When it later misses its lease it is suspect, then restorable by the same token.
        timer.advanceTime(LEASE_MS + 1);
        await restartedMonitor.tick();
        expect(reaped).toEqual([]);
        expect(restarted.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
        expect((await heartbeat(FOREIGN, true, restarted)).code).toBe("liveness_owner_conflict");
        expect((await heartbeat(OWNER, false, restarted)).success).toBe(true);
        expect(restarted.getSession(SESSION)).toBe(rehydrated);
      } finally {
        await restartedMonitor.stop();
        restarted.stopCleanupTimer();
      }
    });
  });
});
