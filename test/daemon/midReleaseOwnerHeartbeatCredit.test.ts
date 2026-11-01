import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { getSessionHeartbeatCheckIntervalMs } from "../../src/daemon/wire/sessionLivenessWindows";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import * as ownerLease from "../../src/daemon/livenessOwnerLease";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { sessionIdleDeadline } from "../../src/daemon/sessionClocks";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

const SESSION = "mid-release-owner";
const DEVICE = "fake-mid-release-device";
const OWNER = "owner-token";
type ReleaseReason = "device-restart:Pixel_A" | "plan-auto-release";
const REASONS: ReleaseReason[] = ["device-restart:Pixel_A", "plan-auto-release"];

class ParkablePersistence extends FakeDeviceSessionPersistence {
  upsertGate?: Promise<void>;

  override async upsertActiveSession(
    ...args: Parameters<FakeDeviceSessionPersistence["upsertActiveSession"]>
  ) {
    await this.upsertGate;
    return await super.upsertActiveSession(...args);
  }
}

describe("owner heartbeats refused during a non-terminal release (#11691)", () => {
  let timer: FakeTimer;
  let persistence: ParkablePersistence;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let session: Session;
  let state: DaemonStateAccess;
  let restoreMs: number;
  let callInFlight: boolean;
  let reaped: string[];

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    restoreMs = 5_000;
    callInFlight = true;
    reaped = [];
    persistence = new ParkablePersistence();
    manager = new SessionManager(timer, persistence, {
      barrier: () => new FakeDbWriteBarrier(),
      restorers: {
        networkCondition: () => ({ restore: async () => {} }),
        clock: () => ({
          restore: () => (restoreMs === 0 ? Promise.resolve() : timer.sleep(restoreMs)),
        }),
      },
    });
    manager.stopCleanupTimer();
    session = await manager.createSession(SESSION, DEVICE, "android");
    manager.setClock(session, {
      initialAutomaticTime: 1,
      clockChangedByUs: true,
      rootedByUs: true,
    });
    expect(await manager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    await deliverDaemonHeartbeat(manager, SESSION, { livenessOwnerToken: OWNER });
    await drainMicrotasks(50);
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => callInFlight,
      async (id, reason) => {
        reaped.push(reason);
        await manager.releaseSession(id, reason);
      },
      { timer },
    );
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(timer),
    };
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  function heartbeat(ownerToken: string | null = OWNER, method = "daemon/heartbeat") {
    return handleDaemonRequest(
      {
        id: "heartbeat",
        type: "daemon_request",
        method,
        params: {
          sessionId: SESSION,
          ...(ownerToken === null ? {} : { livenessOwnerToken: ownerToken }),
        },
      },
      state,
    );
  }

  async function advance(ms: number) {
    await timer.advanceTimeAsync(ms, () => drainMicrotasks(50));
  }

  async function begin(reason: ReleaseReason, silenceMs = 4_001) {
    monitor.start();
    await advance(silenceMs);
    expect(reaped).toEqual([]);
    const release = manager.releaseSession(SESSION, reason);
    callInFlight = false;
    await drainMicrotasks(100);
    expect(manager.getReleasingSession(SESSION)).toBe(session);
    return { release };
  }

  async function assertReleased(reason: string) {
    expect(await persistence.getSession!(SESSION)).toMatchObject({
      status: reason === "heartbeat-timeout" ? "expired" : "released",
      release_reason: reason,
    });
    expect(await manager.getReleasedSessionReason(SESSION)).toBe(reason);
    expect(manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe(
      reason === "heartbeat-timeout" ? reason : undefined,
    );
    expect(reaped).toEqual([]);
  }

  test.each(REASONS)(
    "%s credits the genuine owner's t=5001 and t=7001 heartbeats without changing replies",
    async (reason) => {
      const { release } = await begin(reason);
      expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
      const judgement = spyOn(ownerLease, "livenessLeaseState");
      try {
        const refusal = await heartbeat("");
        expect(refusal).toEqual({
          success: false,
          code: "daemon_session_not_found",
          error: `Session not found: ${SESSION}`,
        });
        await advance(1_000);
        expect(await heartbeat()).toEqual(refusal);
        await advance(2_000);
        expect(await heartbeat()).toEqual(refusal);
        await advance(2_000);
        expect(timer.now()).toBe(9_001);
        expect(await release).toBe(DEVICE);
        await assertReleased(reason);
        const commit = judgement.mock.calls.findIndex(
          ([snapshot]) => snapshot.now === 9_001 && snapshot.lastHeartbeat === 7_001,
        );
        expect(commit).toBeGreaterThanOrEqual(0);
        expect(judgement.mock.results[commit]).toMatchObject({
          type: "return",
          value: { phase: "live", remainingMs: 2_000 },
        });
        // Public lease clocks and session-info are deliberately unchanged by release-local credit.
        expect(session.lastOwnerHeartbeat).toBe(0);
        expect(session.lastHeartbeat).toBe(0);
      } finally {
        judgement.mockRestore();
      }
    },
  );

  test("without a release the same t=5001 heartbeat restores the suspect owner to live", async () => {
    monitor.start();
    await advance(5_001);
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    expect((await heartbeat()).success).toBe(true);
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(session.lastOwnerHeartbeat).toBe(5_001);
  });

  test.each(REASONS)(
    "%s without mid-release heartbeats records genuine terminal silence",
    async (reason) => {
      const { release } = await begin(reason);
      await advance(5_000);
      expect(await release).toBe(DEVICE);
      await assertReleased("heartbeat-timeout");
    },
  );

  test.each(REASONS)(
    "%s credits neither a foreign token nor a tokenless heartbeat",
    async (reason) => {
      const { release } = await begin(reason);
      await advance(1_000);
      expect((await heartbeat("foreign-owner")).code).toBe("daemon_session_not_found");
      await advance(2_000);
      expect((await heartbeat(null)).code).toBe("daemon_session_not_found");
      expect((await heartbeat("")).code).toBe("daemon_session_not_found");
      manager.creditOwnerHeartbeatDuringRelease(SESSION, "foreign-owner");
      await advance(2_000);
      expect(await release).toBe(DEVICE);
      await assertReleased("heartbeat-timeout");
    },
  );

  test.each(REASONS)(
    "%s cannot credit a first release-time heartbeat after grace expired",
    async (reason) => {
      const { release } = await begin(reason);
      await advance(4_000);
      manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
      await advance(1_000);
      expect(await release).toBe(DEVICE);
      await assertReleased("heartbeat-timeout");
    },
  );

  test.each(REASONS)(
    "%s already lapsed at start remains terminal despite a late owner heartbeat",
    async (reason) => {
      const { release } = await begin(reason, 8_001);
      expect(manager.getNonTerminalReleasesInProgress()).toEqual([]);
      await advance(1_000);
      expect(await heartbeat()).toEqual({
        success: false,
        code: "daemon_session_not_found",
        error: `Session not found: ${SESSION}`,
      });
      manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
      await advance(4_000);
      expect(await release).toBe(DEVICE);
      expect(await persistence.getSession!(SESSION)).toMatchObject({
        status: "expired",
        release_reason: "heartbeat-timeout",
      });
    },
  );

  test.each(REASONS)(
    "%s live at start is never judged again even with no release-time heartbeats",
    async (reason) => {
      restoreMs = 11_000;
      const { release } = await begin(reason, 0);
      await advance(11_000);
      expect(await release).toBe(DEVICE);
      await assertReleased(reason);
      expect(session.lastOwnerHeartbeat).toBe(0);
    },
  );

  test("credit changes no session clocks, idle deadline, database row or session-info reply", async () => {
    const { release } = await begin(REASONS[0]);
    const before = {
      lastHeartbeat: session.lastHeartbeat,
      lastOwnerHeartbeat: session.lastOwnerHeartbeat,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      activityGeneration: session.activityGeneration,
      idleDeadline: sessionIdleDeadline(session),
    };
    const row = structuredClone(await persistence.getSession!(SESSION));
    const writes = [
      spyOn(persistence, "recordActivity"),
      spyOn(persistence, "recordLivenessOwnership"),
      spyOn(persistence, "upsertActiveSession"),
      spyOn(persistence, "markReleased"),
    ];
    try {
      await advance(1_000);
      manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
      await advance(2_000);
      const info = await heartbeat(OWNER, "daemon/sessionInfo");
      expect(info).toMatchObject({
        success: true,
        result: { releasing: true, lastOwnerHeartbeatAt: 0, liveness: { state: "suspect" } },
      });
      expect(await heartbeat()).toEqual({
        success: false,
        code: "daemon_session_not_found",
        error: `Session not found: ${SESSION}`,
      });
      expect(await heartbeat(OWNER, "daemon/sessionInfo")).toEqual(info);
      expect({
        lastHeartbeat: session.lastHeartbeat,
        lastOwnerHeartbeat: session.lastOwnerHeartbeat,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        activityGeneration: session.activityGeneration,
        idleDeadline: sessionIdleDeadline(session),
      }).toEqual(before);
      expect(await persistence.getSession!(SESSION)).toEqual(row);
      for (const write of writes) {
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      for (const write of writes) {
        write.mockRestore();
      }
    }
    await advance(2_000);
    expect(await release).toBe(DEVICE);
    await assertReleased(REASONS[0]);
  });

  test("credit at the exact grace boundary counts", async () => {
    const { release } = await begin(REASONS[0]);
    await advance(3_999);
    manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
    await advance(1_001);
    expect(await release).toBe(DEVICE);
    await assertReleased(REASONS[0]);
  });

  test.each(REASONS)(
    "%s stays recoverable through a 40-second clock teardown with the owner heartbeating",
    async (reason) => {
      restoreMs = 40_000;
      const { release } = await begin(reason);
      for (let elapsed = 0; elapsed < 40_000; elapsed += 2_000) {
        expect((await heartbeat()).code).toBe("daemon_session_not_found");
        await advance(2_000);
        if (elapsed === 16_000) {
          // The clock's 15-second budget hands its unfinished restore to device cleanup. The
          // release has committed, but the physical teardown still runs to its own completion.
          expect(manager.getSessionForDevice(DEVICE)).toBeNull();
          expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(true);
        }
      }
      expect(timer.now()).toBe(44_001);
      expect(await release).toBe(DEVICE);
      await assertReleased(reason);
      expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
      expect(session.lastHeartbeat).toBe(0);
      expect(session.lastOwnerHeartbeat).toBe(0);
    },
  );

  test.each(REASONS)(
    "%s chains timely credits across a release waiting 40 seconds on rebind",
    async (reason) => {
      monitor.start();
      await advance(4_001);
      restoreMs = 0;
      const gate = Promise.withResolvers<void>();
      persistence.upsertGate = gate.promise;
      const rebind = manager.rebindSession(SESSION, DEVICE, "android", { force: true });
      const release = manager.releaseSession(SESSION, reason);
      callInFlight = false;
      await drainMicrotasks(100);
      for (let elapsed = 0; elapsed < 40_000; elapsed += 2_000) {
        await advance(2_000);
        expect(manager.getReleasingSession(SESSION)).toBe(session);
        manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
      }
      expect(timer.now()).toBe(44_001);
      persistence.upsertGate = undefined;
      gate.resolve();
      await drainMicrotasks(100);
      await advance(0);
      await rebind;
      expect(await release).toBe(DEVICE);
      await assertReleased(reason);
      expect(session.lastOwnerHeartbeat).toBe(0);
    },
  );

  test("a heartbeat after a previously credited lease and grace expired cannot revive a wedged release", async () => {
    await advance(4_001);
    restoreMs = 0;
    const gate = Promise.withResolvers<void>();
    persistence.upsertGate = gate.promise;
    const rebind = manager.rebindSession(SESSION, DEVICE, "android", { force: true });
    const release = manager.releaseSession(SESSION, REASONS[0]);
    await advance(1_000);
    manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
    await advance(8_001);
    manager.creditOwnerHeartbeatDuringRelease(SESSION, OWNER);
    persistence.upsertGate = undefined;
    gate.resolve();
    await drainMicrotasks(100);
    await rebind;
    expect(await release).toBe(DEVICE);
    await assertReleased("heartbeat-timeout");
  });

  test.each(REASONS)(
    "a live owner's wedged %s release is forced at its recorded deadline with its reason intact",
    async (reason) => {
      restoreMs = 0;
      const gate = Promise.withResolvers<void>();
      persistence.upsertGate = gate.promise;
      const rebind = manager.rebindSession(SESSION, DEVICE, "android", { force: true });
      const release = manager.releaseSession(SESSION, reason);
      const forcedAt: number[] = [];
      monitor = new SessionHeartbeatMonitor(
        manager,
        () => false,
        async (id, reapReason) => {
          reaped.push(reapReason);
          await manager.releaseSession(id, reapReason);
        },
        {
          timer,
          forceStuckRelease: async (id) => {
            forcedAt.push(timer.now());
            manager.forceStuckRelease(id);
          },
        },
      );
      monitor.start();
      const stuckAt = manager.getReleaseStuckAtMs(SESSION)!;
      const scanMs = getSessionHeartbeatCheckIntervalMs();
      const expectedForceAt = Math.ceil(stuckAt / scanMs) * scanMs;
      for (let elapsed = 0; elapsed < expectedForceAt; elapsed += scanMs) {
        expect(forcedAt).toEqual([]);
        expect((await heartbeat()).code).toBe("daemon_session_not_found");
        await advance(scanMs);
      }
      expect(forcedAt).toEqual([expectedForceAt]);
      expect(manager.getSession(SESSION)).toBeNull();
      await assertReleased(reason);
      persistence.upsertGate = undefined;
      gate.resolve();
      await drainMicrotasks(100);
      await advance(0);
      await rebind;
      await release;
    },
  );

  test("a stale label keeps plan auto-release recoverable while its same-token base owner is live", async () => {
    const labelId = `${SESSION}:B`;
    const label = await asPlanAllocation(manager, SESSION, [labelId], () =>
      manager.createSession(labelId, "fake-label-device", "android"),
    );
    manager.setDeviceLabels(SESSION, buildDeviceLabelMap(["A", "B"], SESSION));
    expect(await manager.claimLivenessOwnership(labelId, OWNER)).toBe("claimed");
    for (let elapsed = 0; elapsed < 12_000; elapsed += 2_000) {
      await advance(2_000);
      expect((await heartbeat()).success).toBe(true);
    }
    expect(timer.now()).toBe(12_000);
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(manager.getSessionLeaseState(labelId)?.phase).toBe("lapsed");
    expect(label.lastOwnerHeartbeat).toBe(0);
    const lastHeartbeat = label.lastHeartbeat;
    const row = structuredClone(await persistence.getSession!(labelId));
    if (!row) {
      throw new Error("Expected a persisted label session row");
    }
    expect(await manager.releaseSession(labelId, "plan-auto-release")).toBe(label.assignedDevice);
    expect(await persistence.getSession!(labelId)).toEqual({
      ...row,
      status: "released",
      released_at_ms: 12_000,
      release_reason: "plan-auto-release",
      liveness_owner_token: null,
    });
    expect(await manager.getReleasedSessionReason(labelId)).toBe("plan-auto-release");
    expect(manager.getTerminalReleaseSnapshot(labelId)).toBeUndefined();
    expect(label.lastOwnerHeartbeat).toBe(0);
    expect(label.lastHeartbeat).toBe(lastHeartbeat);
  });

  test("a stale label expires when its same-token base owner is silent too", async () => {
    const labelId = `${SESSION}:B`;
    const label = await asPlanAllocation(manager, SESSION, [labelId], () =>
      manager.createSession(labelId, "fake-label-device", "android"),
    );
    manager.setDeviceLabels(SESSION, buildDeviceLabelMap(["A", "B"], SESSION));
    expect(await manager.claimLivenessOwnership(labelId, OWNER)).toBe("claimed");
    await advance(12_000);
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");
    expect(manager.getSessionLeaseState(labelId)?.phase).toBe("lapsed");
    expect(await manager.releaseSession(labelId, "plan-auto-release")).toBe(label.assignedDevice);
    expect(await persistence.getSession!(labelId)).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
    expect(await manager.getReleasedSessionReason(labelId)).toBe("heartbeat-timeout");
    expect(manager.getTerminalReleaseSnapshot(labelId)?.releaseReason).toBe("heartbeat-timeout");
  });

  test("a live base with another owner token cannot rescue a stale label", async () => {
    const labelId = `${SESSION}:B`;
    const label = await asPlanAllocation(manager, SESSION, [labelId], () =>
      manager.createSession(labelId, "fake-label-device", "android"),
    );
    manager.setDeviceLabels(SESSION, buildDeviceLabelMap(["A", "B"], SESSION));
    expect(await manager.claimLivenessOwnership(labelId, "foreign-owner")).toBe("conflict");
    // Once the base's lease lapses, a different token may legitimately claim the label.
    await advance(9_000);
    expect(await manager.claimLivenessOwnership(labelId, "foreign-owner")).toBe("claimed");
    expect((await heartbeat()).success).toBe(true);
    for (let elapsed = 0; elapsed < 12_000; elapsed += 2_000) {
      await advance(2_000);
      expect((await heartbeat()).success).toBe(true);
    }
    expect(session.livenessOwnerToken).toBe(OWNER);
    expect(label.livenessOwnerToken).toBe("foreign-owner");
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(manager.getSessionLeaseState(labelId)?.phase).toBe("lapsed");
    expect(await manager.releaseSession(labelId, "plan-auto-release")).toBe(label.assignedDevice);
    expect(await persistence.getSession!(labelId)).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
    expect(await manager.getReleasedSessionReason(labelId)).toBe("heartbeat-timeout");
    expect(manager.getTerminalReleaseSnapshot(labelId)?.releaseReason).toBe("heartbeat-timeout");
  });

  test("a live label keeps plan auto-release recoverable while its base's restart freezes the base lease", async () => {
    const labelId = `${SESSION}:B`;
    const label = await asPlanAllocation(manager, SESSION, [labelId], () =>
      manager.createSession(labelId, "fake-label-device", "android"),
    );
    manager.setDeviceLabels(SESSION, buildDeviceLabelMap(["A", "B"], SESSION));
    expect(await manager.claimLivenessOwnership(labelId, OWNER)).toBe("claimed");
    await deliverDaemonHeartbeat(manager, labelId, { livenessOwnerToken: OWNER });
    await advance(2_000);
    expect((await heartbeat()).success).toBe(true);
    await deliverDaemonHeartbeat(manager, labelId, { livenessOwnerToken: OWNER });
    restoreMs = 14_000;
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    const baseRelease = manager.releaseSession(SESSION, REASONS[0]);
    await drainUntil(() => timer.wasSleepCalled(14_000), { description: "base clock teardown" });
    try {
      for (let elapsed = 0; elapsed < 10_000; elapsed += 2_000) {
        await advance(2_000);
        expect((await heartbeat()).code).toBe("daemon_session_not_found");
        expect(
          await handleDaemonRequest(
            {
              id: "label-heartbeat",
              type: "daemon_request",
              method: "daemon/heartbeat",
              params: { sessionId: labelId, livenessOwnerToken: OWNER },
            },
            state,
          ),
        ).toMatchObject({ success: true });
      }
      expect(timer.now()).toBe(12_000);
      expect(manager.getReleasingSession(SESSION)).toBe(session);
      expect(session.lastOwnerHeartbeat).toBe(2_000);
      expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");
      expect(label.lastOwnerHeartbeat).toBe(12_000);
      expect(manager.getSessionLeaseState(labelId)?.phase).toBe("live");
      expect(await manager.releaseSession(labelId, "plan-auto-release")).toBe(label.assignedDevice);
      expect(await persistence.getSession!(labelId)).toMatchObject({
        status: "released",
        release_reason: "plan-auto-release",
      });
      expect(await manager.getReleasedSessionReason(labelId)).toBe("plan-auto-release");
      expect(manager.getTerminalReleaseSnapshot(labelId)).toBeUndefined();
    } finally {
      await advance(4_000);
      expect(await baseRelease).toBe(DEVICE);
    }
  });
});
