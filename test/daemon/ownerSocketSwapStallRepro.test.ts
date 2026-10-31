import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { OwnerDisconnectExecutionVeto } from "../../src/daemon/OwnerDisconnectExecutionVeto";
import { ExecutionTracker } from "../../src/daemon/executionTracker";
import { judgedLeaseHeartbeat } from "../../src/daemon/livenessOwnerLease";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { handleHeartbeat } from "../../src/daemon/daemonRequestHandlersParts/heartbeat";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { makePool } from "../helpers/makePool";

const ID = "socket-swap-owner";
const TOKEN = "same-liveness-owner";
const OLD = "old-socket";
const NEW = "replacement-socket";
const DEVICE = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" } as const;
// Pinned, not read from AUTOMOBILE_SESSION_HEARTBEAT_* in the runner's env (#14511): every
// phase and timestamp below assumes the 4 s lease and the 2 s scan.
const LEASE = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS;
const SCAN = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const STALL = 120_000;

// Investigation only: use the real close, restore, ownership and heartbeat paths. Never detach
// the stall probe, edit connection intervals, backdate a close, or invoke a private method.
// The pool's injected disconnect port mirrors DaemonSessions.createDevicePool, including its
// control-execution veto. Device I/O and persistence are fake; no Daemon or socket is started.
async function setUp(activeControl = false) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["control-call"]));
  const executions = {
    hasActiveExecutions: (id: string) => tracker.hasActiveSessionUuidExecutions(id),
    latestExecutionDeadlineMs: (id: string) => tracker.getLatestSessionExecutionDeadlineMs(id),
  };
  manager.setActiveSessionExecutionChecker(executions.hasActiveExecutions);
  const veto = new OwnerDisconnectExecutionVeto(executions, timer, undefined, () =>
    manager.sessionNow(),
  );
  const releases: Array<{ at: number; reason: string }> = [];
  manager.onSessionRelease((_id, _device, reason) =>
    releases.push({ at: manager.sessionNow(), reason }),
  );
  const release = async (session: Session, reason: SessionReleaseReason) => {
    await releaseSessionAndDevice({ manager, pool }, session.assignedDevice, ID, {
      reason,
      release: () =>
        manager.releaseSession(ID, reason, {
          expectedOwner: { session: session, deviceId: session.assignedDevice },
        }),
    });
  };
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [DEVICE];
  const pool = makePool(manager, "repro-daemon", {
    timer,
    deviceManager,
    ownerDisconnect: {
      release: async (session, reason) => {
        const deferral = veto.keeps(session);
        if (deferral) {
          return deferral;
        }
        await release(session, reason);
      },
    },
  });
  const unsubscribe = tracker.onSessionExecutionEnded((ids) => pool.sessionExecutionsEnded(ids));
  await pool.initializeWithDevices([DEVICE]);
  // Long idle window isolates owner liveness from idle expiry, including the cap control.
  // An explicit lease marks the session "custom", which only changes the pre-first-heartbeat
  // grace; setup heartbeats before the monitor starts, so the lease judgement is the default one.
  await manager.createSession(ID, DEVICE.deviceId, DEVICE.platform, {
    timeoutMs: 1_200_000,
    heartbeatTimeoutMs: LEASE,
  });
  pool.declareMcpSessionLivenessOwnerToken(OLD, TOKEN);
  await pool.bindOrReuseDeviceSession({
    sessionId: ID,
    deviceId: DEVICE.deviceId,
    platform: DEVICE.platform,
    allowSessionRebind: false,
    mcpSessionId: OLD,
  });
  const state = {
    ...createFakeDaemonState(),
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => pool,
  };
  const heartbeat = () =>
    handleHeartbeat(
      {
        id: "reclaim-heartbeat",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: { sessionId: ID, livenessOwnerToken: TOKEN, claimLivenessOwnership: true },
      },
      state,
    );
  expect((await heartbeat()).success).toBe(true);
  const session = manager.getSession(ID)!;
  const heartbeatAt = session.lastOwnerHeartbeat!;
  const monitor = new SessionHeartbeatMonitor(
    manager,
    executions,
    async (id, reason) => {
      const current = manager.peekSession(id);
      if (current) {
        await release(current, reason);
      }
    },
    timer,
    { checkIntervalMs: SCAN, heartbeatTimeoutMs: LEASE },
  );
  const control = activeControl ? tracker.startExecution("tapOn", undefined, ID) : undefined;
  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
  const jump = (ms: number) => timer.setCurrentTime(timer.getCurrentTime() + ms);
  const close = () => pool.releaseMcpSessionBindings(OLD);
  // ProxyLiveness.runRecoveryAttempt sends daemon/heartbeat first, and SocketAdmission answers
  // daemon/* before the tools/call-only selector restoration (#14510): the heartbeat neither
  // makes NEW a connection owner nor cancels the pending OwnerDisconnectRelease.
  const reclaim = () => heartbeat();
  // McpBindings.restoreSelectorSessions, as the next tools/call on the replacement socket runs it.
  const restore = async () => {
    pool.declareMcpSessionLivenessOwnerToken(NEW, TOKEN);
    return await pool.restoreOwnedDeviceSessionsForMcpSession([ID], NEW, TOKEN);
  };
  const r = {
    timer,
    manager,
    pool,
    tracker,
    monitor,
    session,
    releases,
    heartbeatAt,
    control,
    settle,
    jump,
    close,
    reclaim,
    restore,
    stop: async () => {
      await monitor.stop();
      manager.stopCleanupTimer();
      unsubscribe();
    },
  };
  rig = r;
  monitor.start();
  await settle(6_000);
  expect(manager.getSessionLeaseState(ID)?.phase).toBe("suspect");
  return r;
}

type Rig = Awaited<ReturnType<typeof setUp>>;
let rig: Rig | undefined;
beforeAll(async () => {
  const warm = await setUp();
  warm.jump(SCAN + STALL);
  warm.close();
  await warm.settle(10_000);
  await warm.stop();
  rig = undefined;
});
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

function stalledClose(r: Rig) {
  r.jump(SCAN + STALL);
  r.close();
  // This is observed IMMEDIATELY after the real close, before any scan or reclaim.
  expect(r.session.stallForgivenAt).toBe(r.heartbeatAt + STALL);
  expect(r.releases).toEqual([]);
  expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(true);
  return r.manager.sessionNow();
}

async function expectGone(r: Rig, reason: string) {
  const response = await r.reclaim();
  expect(response.success).toBe(false);
  expect(response.code).toBe(DAEMON_SESSION_NOT_FOUND_CODE);
  expect(response.releaseReason).toBe(reason);
  expect(r.pool.isSessionOwnedByConnection(ID, NEW)).toBe(false);
}

describe("unmodified main: production-order socket swap starvation (#11992)", () => {
  test("A: reclaim 1 s after the close survives; close already credited the whole 120 s", async () => {
    const r = await setUp();
    stalledClose(r);
    await r.settle(1_000);
    expect((await r.reclaim()).success).toBe(true);
    // The recovery heartbeat alone leaves the old close's release armed and NEW unowned.
    expect(r.pool.isSessionOwnedByConnection(ID, NEW)).toBe(false);
    expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(true);
    // The next tools/call on the replacement socket restores the selector session.
    expect(await r.restore()).toEqual([]);
    expect(r.pool.isSessionOwnedByConnection(ID, NEW)).toBe(true);
    expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(false);
    await r.settle(8_000);
    // No subsequent heartbeat: a fresh lease's inclusive grace lasts exactly 8 s.
    expect(r.releases).toEqual([]);
  });

  test("A: with no tool call after the reclaim, the armed release lapses at close + 8 s unreleased", async () => {
    const r = await setUp();
    const closedAt = stalledClose(r);
    await r.settle(1_000);
    expect((await r.reclaim()).success).toBe(true);
    await r.settle(closedAt + 8_000 - 1 - r.manager.sessionNow());
    expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(true);
    await r.settle(1);
    expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(false);
    expect(r.pool.isSessionOwnedByConnection(ID, NEW)).toBe(false);
    expect(r.releases).toEqual([]);
  });

  test("A: reclaim at 7 s is within disconnect grace but loses to a normal scan at 2 s", async () => {
    const r = await setUp();
    const closedAt = stalledClose(r);
    await r.settle(7_000);
    expect(r.releases).toEqual([{ at: closedAt + SCAN, reason: "heartbeat-timeout" }]);
    await expectGone(r, "heartbeat-timeout");
  });

  for (const delay of [9_000, 15_000, 30_000]) {
    for (const active of [false, true]) {
      test(`B: reclaim at ${delay / 1000} s, active control=${active}`, async () => {
        const r = await setUp(active);
        const closedAt = stalledClose(r);
        await r.settle(delay);
        if (active) {
          expect(r.releases).toEqual([]);
          expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(true);
          expect((await r.reclaim()).success).toBe(true);
          r.tracker.endExecution(r.control!.id);
          await r.settle(0);
          expect(r.releases).toEqual([]);
          expect(r.pool.testHooks.ownerDisconnectRelease.isPending(ID)).toBe(false);
        } else {
          expect(r.releases).toEqual([{ at: closedAt + SCAN, reason: "heartbeat-timeout" }]);
          await expectGone(r, "heartbeat-timeout");
        }
      });
    }
  }

  test("B: an execution ending after 8 s re-arms owner-disconnected before the late reclaim", async () => {
    const r = await setUp(true);
    const closedAt = stalledClose(r);
    await r.settle(8_500);
    expect(r.releases).toEqual([]);
    r.tracker.endExecution(r.control!.id);
    await r.settle(0);
    expect(r.releases).toEqual([{ at: closedAt + 8_500, reason: "owner-disconnected" }]);
    await expectGone(r, "owner-disconnected");
  });

  for (const firstLost of [12_000, 60_000]) {
    for (const scanBeforeReclaim of [false, true]) {
      test(`C: close after ${firstLost / 1000} s; scan before reclaim=${scanBeforeReclaim}`, async () => {
        const r = await setUp();
        r.jump(SCAN + firstLost);
        r.close();
        const closedAt = r.manager.sessionNow();
        expect(r.session.stallForgivenAt).toBe(r.heartbeatAt + firstLost);
        const secondLost = STALL - firstLost;
        r.jump(secondLost);
        // The close is stamped when actually processed. The remaining silent period is a
        // SECOND gap. The closed-owner cumulative 30 s cap permits only 18 s after a first
        // 12 s credit, or nothing after a first 60 s credit. Prior credit is never revoked.
        if (scanBeforeReclaim) {
          await r.monitor.tick();
          expect(r.session.stallForgivenAt).toBe(r.heartbeatAt + Math.max(30_000, firstLost));
          expect(r.releases).toEqual([{ at: closedAt + secondLost, reason: "heartbeat-timeout" }]);
          await expectGone(r, "heartbeat-timeout");
        } else {
          expect((await r.reclaim()).success).toBe(true);
          expect(r.session.lastOwnerHeartbeat).toBe(closedAt + secondLost);
          // Lookup probes do not themselves reap a stale heartbeat lease. The heartbeat
          // following restoration can renew it before any scan or disconnect timer runs.
          await r.settle(0);
          expect(r.releases).toEqual([]);
        }
      });
    }
  }

  test("C: reclaim's restore probe alone cannot replenish credit; scan before heartbeat loses", async () => {
    const r = await setUp();
    r.jump(SCAN + 60_000);
    r.close();
    expect(r.session.stallForgivenAt).toBe(r.heartbeatAt + 60_000);
    r.jump(60_000);
    await r.restore();
    expect(r.pool.isSessionOwnedByConnection(ID, NEW)).toBe(true);
    expect(r.session.stallForgivenAt).toBe(r.heartbeatAt + 60_000);
    await r.monitor.tick();
    expect(r.releases.map(({ reason }) => reason)).toEqual(["heartbeat-timeout"]);
    await expectGone(r, "heartbeat-timeout");
  });

  for (const lost of [STALL, 600_000, 601_000]) {
    test(`D: no socket swap, ${lost / 1000} s stall, 600 s cumulative cap`, async () => {
      const r = await setUp();
      r.jump(SCAN + lost);
      await r.monitor.tick();
      expect(judgedLeaseHeartbeat(r.session)).toBe(r.heartbeatAt + Math.min(lost, 600_000));
      if (lost <= 600_000) {
        expect(r.releases).toEqual([]);
        expect(r.manager.getSession(ID)).toBe(r.session);
      } else {
        expect(r.releases).toEqual([
          { at: r.heartbeatAt + 6_000 + SCAN + lost, reason: "heartbeat-timeout" },
        ]);
      }
    });
  }

  test("D: no swap also releases 2 s after the fully forgiven stall without a new heartbeat", async () => {
    const r = await setUp();
    r.jump(SCAN + STALL);
    const resumedAt = r.manager.sessionNow();
    await r.settle(0);
    expect(r.releases).toEqual([]);
    expect(r.session.stallForgivenAt).toBe(r.heartbeatAt + STALL);
    await r.settle(SCAN);
    expect(r.releases).toEqual([{ at: resumedAt + SCAN, reason: "heartbeat-timeout" }]);
  });
});
