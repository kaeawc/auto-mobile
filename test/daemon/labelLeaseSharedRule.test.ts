import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

const BASE = "shared-label-owner";
const LABEL = `${BASE}:B`;
const OWNER = "owner-token";

describe("shared label owner lease (#11722)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let persistence: FakeDeviceSessionPersistence;
  let base: Session;
  let label: Session;
  let reaped: { id: string; reason: string; at: number }[];
  let restoreMs: number;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    persistence = new FakeDeviceSessionPersistence();
    restoreMs = 0;
    manager = new SessionManager(timer, persistence, {
      barrier: () => new FakeDbWriteBarrier(),
      restorers: {
        networkCondition: () => ({ restore: async () => {} }),
        clock: () => ({ restore: () => (restoreMs ? timer.sleep(restoreMs) : Promise.resolve()) }),
      },
    });
    manager.stopCleanupTimer();
    base = await manager.createSession(BASE, "fake-base-device", "android");
    expect(await manager.claimLivenessOwnership(BASE, OWNER)).toBe("claimed");
    await deliverDaemonHeartbeat(manager, BASE, { livenessOwnerToken: OWNER });
    label = await asPlanAllocation(manager, BASE, [LABEL], () =>
      manager.createSession(LABEL, "fake-label-device", "android"),
    );
    manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
    expect(await manager.claimLivenessOwnership(LABEL, OWNER)).toBe("claimed");
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (id, reason) => {
        reaped.push({ id, reason, at: timer.now() });
        await manager.releaseSession(id, reason);
      },
      { timer },
    );
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        releaseDevice: async () => {},
        getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(timer),
    };
    await drainMicrotasks(20);
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  async function advance(ms: number) {
    await timer.advanceTimeAsync(ms, () => drainMicrotasks(30));
  }

  async function keepBaseAlive(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 2_000) {
      await advance(2_000);
      await deliverDaemonHeartbeat(manager, BASE, { livenessOwnerToken: OWNER });
    }
  }

  test("monitor keeps a never-heartbeated same-token label while its base owner is live", async () => {
    monitor.start();
    await keepBaseAlive(14_000);
    expect(reaped).toEqual([]);
    expect(manager.getSession(LABEL)).toBe(label);
    expect(label.lastOwnerHeartbeat).toBe(0);
    expect(manager.getSessionLeaseState(LABEL)?.phase).toBe("lapsed");
  });

  test("real control admission accepts the stale label of a live same-token base", async () => {
    await keepBaseAlive(12_000);
    expect(manager.getSessionLeaseState(LABEL)?.phase).toBe("lapsed");
    expect(await manager.getOrCreateSession(LABEL)).toBe(label);
    expect(manager.getTerminalReleaseSnapshot(LABEL)).toBeUndefined();
    expect((await persistence.getSession!(LABEL))?.status).toBe("active");
  });

  test("base owner proof also bypasses missing-first-heartbeat for an unheard label", async () => {
    // Cover an unheard label's first-heartbeat branch independently of claim's heartbeat flag.
    label.hasReceivedHeartbeat = false;
    monitor.start();
    await keepBaseAlive(14_000);
    expect(reaped).toEqual([]);
    expect(manager.getSession(LABEL)).toBe(label);
    expect(label.hasReceivedHeartbeat).toBe(false);
  });

  test("a base not judged on owner heartbeats cannot rescue the label", async () => {
    base.hasReceivedHeartbeat = false;
    monitor.start();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 2_000) {
      await advance(2_000);
      await manager.getOrCreateSession(BASE);
    }
    expect(reaped).toEqual([{ id: LABEL, reason: "heartbeat-timeout", at: 10_000 }]);
  });

  async function beginCreditedRestart(scan = true) {
    manager.setClock(base, {
      initialAutomaticTime: 1,
      clockChangedByUs: true,
      rootedByUs: true,
    });
    if (scan) {
      monitor.start();
    }
    await advance(4_001);
    expect(manager.getSessionLeaseState(BASE)?.phase).toBe("suspect");
    restoreMs = 14_000;
    const release = manager.releaseSession(BASE, "device-restart:Pixel_A");
    await drainUntil(() => timer.wasSleepCalled(14_000), { description: "base clock teardown" });
    expect(timer.wasSleepCalled(14_000)).toBe(true);
    expect(manager.getReleasingSession(BASE)).toBe(base);
    // A non-terminal release still publishes the base while its teardown is parked.
    expect(manager.peekSession(BASE)).toBe(base);
    for (let i = 0; i < 2; i++) {
      await advance(i === 0 ? 1_000 : 2_000);
      expect(
        await handleDaemonRequest(
          {
            id: "release-heartbeat",
            type: "daemon_request",
            method: "daemon/heartbeat",
            params: { sessionId: BASE, livenessOwnerToken: OWNER },
          },
          state,
        ),
      ).toMatchObject({ success: false, code: "daemon_session_not_found" });
    }
    expect(timer.now()).toBe(7_001);
    return { release };
  }

  test("monitor and plan release count the base's release-local owner heartbeat", async () => {
    const { release: restart } = await beginCreditedRestart();
    try {
      await advance(2_999);
      expect(timer.now()).toBe(10_000);
      expect(reaped).toEqual([]);
      expect(manager.getSessionLeaseState(BASE)?.phase).toBe("lapsed");
      expect(manager.getSessionLeaseState(LABEL)?.phase).toBe("lapsed");
      const clocks = [base.lastOwnerHeartbeat, label.lastOwnerHeartbeat];
      expect(await manager.releaseSession(LABEL, "plan-auto-release")).toBe(label.assignedDevice);
      expect(await persistence.getSession!(LABEL)).toMatchObject({
        status: "released",
        release_reason: "plan-auto-release",
      });
      expect(manager.getTerminalReleaseSnapshot(LABEL)).toBeUndefined();
      expect([base.lastOwnerHeartbeat, label.lastOwnerHeartbeat]).toEqual(clocks);
    } finally {
      await advance(18_001 - timer.now());
      await restart;
    }
  });

  test("plan release alone preserves its reason using the base's release-local credit", async () => {
    const { release: restart } = await beginCreditedRestart(false);
    try {
      await advance(2_999);
      expect(await manager.releaseSession(LABEL, "plan-auto-release")).toBe(label.assignedDevice);
      expect(await persistence.getSession!(LABEL)).toMatchObject({
        status: "released",
        release_reason: "plan-auto-release",
      });
    } finally {
      await advance(18_001 - timer.now());
      await restart;
    }
  });

  test("silent base and label are reaped on the existing 10000ms scan", async () => {
    monitor.start();
    await advance(10_000);
    expect(reaped).toContainEqual({ id: LABEL, reason: "heartbeat-timeout", at: 10_000 });
  });

  test("real control admission refuses the label when its base owner is silent too", async () => {
    await advance(12_000);
    await expect(manager.getOrCreateSession(LABEL)).rejects.toMatchObject({
      release: { releaseReason: "heartbeat-timeout" },
    });
    expect(manager.getSession(LABEL)).toBeNull();
  });

  test("a live foreign-token base cannot rescue a label's own expired lease", async () => {
    expect(await manager.claimLivenessOwnership(LABEL, "foreign-owner")).toBe("conflict");
    await advance(9_000);
    expect(await manager.claimLivenessOwnership(LABEL, "foreign-owner")).toBe("claimed");
    await deliverDaemonHeartbeat(manager, BASE, { livenessOwnerToken: OWNER });
    monitor.start();
    await keepBaseAlive(10_000);
    expect(reaped).toEqual([{ id: LABEL, reason: "heartbeat-timeout", at: 19_000 }]);
    expect(base.livenessOwnerToken).toBe(OWNER);
    expect(label.livenessOwnerToken).toBe("foreign-owner");
  });

  test("the label expires when the base's release-local credit itself lapses", async () => {
    const { release: restart } = await beginCreditedRestart();
    try {
      await advance(6_999);
      expect(timer.now()).toBe(14_000);
      expect(reaped).toEqual([]);
      await advance(2_000);
      expect(reaped).toEqual([{ id: LABEL, reason: "heartbeat-timeout", at: 16_000 }]);
    } finally {
      await advance(18_001 - timer.now());
      await restart;
    }
  });
});
