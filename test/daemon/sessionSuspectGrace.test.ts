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
        /being restored; its device stays reserved for 10s\. Retry this call now/,
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
      // Each scan settles before the clock moves on, as on a daemon that is keeping its schedule.
      for (let elapsed = 0; elapsed < LEASE_MS + SUSPECT_GRACE_MS; elapsed += 10_000) {
        await timer.advanceTimeAsync(10_000);
      }
      expect(reaped).toEqual([]);

      await timer.advanceTimeAsync(10_000);

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
      // Exactly the lost interval is forgiven (#10051 review F7): 60s of silence, 10s scheduled,
      // so the lease is judged as if only the scheduled 10s had passed.
      expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
        phase: "live",
        remainingMs: 0,
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

    test("an owner that never returns is reaped once its lease plus grace, minus the lost interval, is spent", async () => {
      monitor.start();
      timer.setCurrentTime(timer.now() + 60_000);
      await monitor.tick();
      const resumedAt = timer.now();

      // 60s silent against a 10s schedule: 50s forgiven, so only the scheduled 10s was counted
      // and 10s of lease plus grace remain.
      timer.advanceTime(LEASE_MS);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();
      expect(timer.now() - resumedAt).toBe(LEASE_MS + 1);
      expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    });

    test("a stall that alone outlasts the idle window is host sleep and counts as idle (#10661)", async () => {
      monitor.start();
      timer.setCurrentTime(timer.now() + 120_000);

      await monitor.tick();

      expect(sessionManager.getSession(SESSION)).toBeNull();
    });

    test("an owner heartbeat that wins the race after a sleep gets the same verdict as the monitor (#10661)", async () => {
      monitor.start();
      timer.setCurrentTime(timer.now() + 120_000);

      const result = await heartbeat(OWNER);

      expect(result.success).toBe(false);
      await monitor.tick();
      expect(sessionManager.getSession(SESSION)).toBeNull();
    });

    test("a stall shorter than the idle window is forgiven whichever timer fires first (#10661)", async () => {
      const original = sessionManager.getSession(SESSION);
      monitor.start();
      // 75s of silence: past expiresAt (60s) plus grace (10s), so an unforgiven lazy lookup
      // would release the session, but only 65s of it was lost to the stall.
      timer.setCurrentTime(timer.now() + 75_000);

      expect((await heartbeat(OWNER)).success).toBe(true);
      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(SESSION)).toBe(original);
    });

    test("stall forgiveness is applied once when a lookup and the tick both notice it (#10661)", async () => {
      monitor.start();
      timer.setCurrentTime(timer.now() + 75_000);
      sessionManager.getSession(SESSION);
      const forgivenAt = sessionManager.getSession(SESSION)?.stallForgivenAt;
      const expiresAt = sessionManager.getSession(SESSION)?.expiresAt;

      await monitor.tick();

      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBe(forgivenAt);
      expect(sessionManager.getSession(SESSION)?.expiresAt).toBe(expiresAt);
    });

    test("a tick only slightly late is not a stall and forgives nothing", async () => {
      monitor.start();
      // 1s late against a 2s margin: ordinary timer jitter, heartbeats were being received.
      timer.setCurrentTime(timer.now() + 10_000 + 1_000);
      await monitor.tick();
      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBeUndefined();
    });

    test("a manually driven tick has no schedule to be late against", async () => {
      timer.setCurrentTime(timer.now() + 60_000);

      await monitor.tick();

      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBeUndefined();
      expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    });

    test("a 16s stall that is only 7s late is forgiven instead of reaping a heartbeating owner (review F7)", async () => {
      // The review's example: lease 10s, grace 10s, scans every 10s. The owner's last heartbeat
      // is 4.5s before a 16s stall that starts 1s after a scan, so the scan that wakes first
      // fires 7s late and sees a session aged 20.5s.
      const original = sessionManager.getSession(SESSION);
      monitor.start();
      timer.setCurrentTime(6_500);
      expect((await heartbeat(OWNER)).success).toBe(true);
      timer.setCurrentTime(10_000);
      await monitor.tick();
      timer.setCurrentTime(10_000 + 1_000 + 16_000);

      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(SESSION)).toBe(original);
      // The 7s the daemon was late are not counted: the session ages from 6.5s + 7s.
      expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
        phase: "suspect",
        remainingMs: 6_500,
      });
      // Its owner's buffered heartbeat then restores it.
      expect((await heartbeat(OWNER)).success).toBe(true);
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    });

    test("the same stall reaps the owner when the stall threshold is the lease (old blind spot)", async () => {
      const strictMonitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
          await sessionManager.releaseSession(sessionId, reason);
        },
        timer,
        { stallThresholdMs: LEASE_MS },
      );
      try {
        strictMonitor.start();
        timer.setCurrentTime(6_500);
        await heartbeat(OWNER);
        timer.setCurrentTime(10_000);
        await strictMonitor.tick();
        timer.setCurrentTime(27_000);

        await strictMonitor.tick();

        expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
      } finally {
        await strictMonitor.stop();
      }
    });

    test("forgiveness never moves a lease past the resume point", () => {
      const session = sessionManager.getSession(SESSION);
      const heartbeatAt = session?.lastHeartbeat ?? 0;
      timer.setCurrentTime(heartbeatAt + 5_000);

      sessionManager.forgiveDaemonStall(timer.now(), 60_000);

      expect(session?.stallForgivenAt).toBe(heartbeatAt + 5_000);
    });

    test("forgiveness shifts the idle deadline by the lost interval, not to a full window (#10662)", () => {
      const session = sessionManager.getSession(SESSION)!;
      const expiresAt = session.expiresAt;
      timer.setCurrentTime(timer.now() + 20_000);

      sessionManager.forgiveDaemonStall(timer.now(), 3_000);

      // Resetting to resume + timeout would grant 20s the stall never took.
      expect(session.expiresAt).toBe(expiresAt + 3_000);
    });

    test("a one-shot CLI session keeps its own idle policy through a stall", async () => {
      sessionManager.adoptCliLivenessPolicy(SESSION);

      expect(sessionManager.forgiveDaemonStall(timer.now() + 60_000, 60_000)).toBe(0);
      expect(sessionManager.getSession(SESSION)?.stallForgivenAt).toBeUndefined();
      expect(sessionManager.getSessionLeaseState(SESSION)).toBeUndefined();
    });
  });

  describe("across a daemon restart", () => {
    /** A daemon restarted at t=40 over a persisted, owned session; rehydration not yet run. */
    async function restartedDaemon(): Promise<{
      restarted: SessionManager;
      restartedMonitor: SessionHeartbeatMonitor;
      devicePool: SessionDeviceAssigner;
    }> {
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
      return { restarted, restartedMonitor, devicePool };
    }

    test("a rehydrated session gets fresh deadlines and the suspect window once its owner returns", async () => {
      const { restarted, restartedMonitor, devicePool } = await restartedDaemon();
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

    test("an abandoned rehydrated session is reaped even while every tick fires late (#10662)", async () => {
      const { restarted, restartedMonitor, devicePool } = await restartedDaemon();
      try {
        await restarted.rehydratePersistedSessions(devicePool);
        restartedMonitor.start();
        // A host in dark-wake cycles: every tick is 3s late, past the 2s stall margin, and the
        // owner never returns. Each late tick may forgive only its own 3s, so the on-time age
        // still grows by the scheduled 10s per tick and passes the 10s rehydration window.
        for (let tick = 0; tick < 5 && reaped.length === 0; tick++) {
          timer.setCurrentTime(timer.now() + 10_000 + 3_000);
          await restartedMonitor.tick();
        }

        expect(reaped).toEqual([{ sessionId: SESSION, reason: "rehydration-owner-timeout" }]);
      } finally {
        await restartedMonitor.stop();
        restarted.stopCleanupTimer();
      }
    });
  });

  describe("one owner at a time (#10050 review)", () => {
    const THIRD = "harness-c";

    test("two foreign tokens claiming a lapsed, unreaped session together: exactly one wins (F2)", async () => {
      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");

      const [first, second] = await Promise.all([heartbeat(FOREIGN, true), heartbeat(THIRD, true)]);

      expect([first.success, second.success].sort()).toEqual([false, true]);
      const loser = first.success ? second : first;
      expect(loser.code).toBe("liveness_owner_conflict");
      const winnerToken = first.success ? FOREIGN : THIRD;
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(winnerToken);
      expect(sessionManager.hasLivenessOwnership(SESSION, winnerToken)).toBe(true);
    });

    test("the claim's own lease stamp makes a second claimant conflict before any heartbeat is recorded (F2)", async () => {
      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);

      expect(await sessionManager.claimLivenessOwnership(SESSION, FOREIGN)).toBe("claimed");

      // No recordHeartbeat has run yet; the daemon must already see FOREIGN's lease as live.
      expect(await sessionManager.claimLivenessOwnership(SESSION, THIRD)).toBe("conflict");
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(FOREIGN);
    });

    test("a rejected claim does not stamp the owner's lease (F2 pin)", async () => {
      timer.advanceTime(LEASE_MS - 1_000);
      const before = sessionManager.getSession(SESSION)?.lastOwnerHeartbeat;

      expect(await sessionManager.claimLivenessOwnership(SESSION, FOREIGN)).toBe("conflict");

      expect(sessionManager.getSession(SESSION)?.lastOwnerHeartbeat).toBe(before);
    });

    test("a non-owner's tool calls do not keep the owner's lease alive, so a restarted proxy wins after lease plus grace (F1a)", async () => {
      // OWNER stops heartbeating at t=0 (a dead proxy). The restarted proxy, with a new token,
      // keeps working: every call names the session and refreshes its activity.
      for (let elapsed = 0; elapsed < LEASE_MS + SUSPECT_GRACE_MS; elapsed += 5_000) {
        timer.advanceTime(5_000);
        await sessionManager.getOrCreateSession(SESSION);
        await monitor.tick();
        expect((await heartbeat(FOREIGN, true)).code).toBe("liveness_owner_conflict");
      }
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await sessionManager.getOrCreateSession(SESSION);
      const claim = await heartbeat(FOREIGN, true);

      expect(claim.success).toBe(true);
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(FOREIGN);
    });

    test("cache updates by a non-owner do not extend the owner's lease either (F1a)", async () => {
      timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS);
      sessionManager.updateSessionCache(SESSION, {});
      sessionManager.getSessionCache(SESSION);
      timer.advanceTime(1);

      expect((await heartbeat(FOREIGN, true)).success).toBe(true);
    });

    test("an owner that heartbeats keeps foreign claims out however busy the session is (F1a pin)", async () => {
      for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
        timer.advanceTime(5_000);
        expect((await heartbeat(OWNER)).success).toBe(true);
        await sessionManager.getOrCreateSession(SESSION);
        expect((await heartbeat(FOREIGN, true)).code).toBe("liveness_owner_conflict");
      }
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(OWNER);
    });

    test("a single proxy's tool calls and heartbeats behave as before (F1a pin)", async () => {
      timer.advanceTime(4_000);
      await sessionManager.getOrCreateSession(SESSION);
      expect((await heartbeat(OWNER)).success).toBe(true);
      expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
        phase: "live",
        remainingMs: LEASE_MS,
      });
    });
  });
});
