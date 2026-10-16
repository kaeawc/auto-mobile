import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  daemonStallLeaseExtension,
  OwnerConnectionIntervals,
} from "../../src/daemon/connectedOwnerStallExcuse";
import { judgedLeaseHeartbeat } from "../../src/daemon/livenessOwnerLease";
import { MAX_CREDIBLE_DAEMON_STALL_MS } from "../../src/daemon/timerLateness";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS as SCAN_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const ID = "connected-stall-session";
let rig: Awaited<ReturnType<typeof setUp>> | undefined;
// As in the neighbouring scenario suites, pay module/first-scan initialization outside tests.
beforeAll(async () => {
  const warm = await setUp();
  await silentScans(warm);
  await lateScan(warm, 12_000);
  await warm.monitor.stop();
  warm.manager.stopCleanupTimer();
  rig = undefined;
});
afterEach(async () => {
  await rig?.monitor.stop();
  rig?.manager.stopCleanupTimer();
  rig = undefined;
});

async function setUp(connected: boolean | undefined = true) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager.setOwnerConnectedAtReader(connected === undefined ? undefined : () => connected);
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  const heartbeat = async () => {
    expect(
      (
        await handleDaemonRequest(
          {
            id: "beat",
            type: "daemon_request",
            method: "daemon/heartbeat",
            params: { sessionId: ID, livenessOwnerToken: "owner" },
          },
          state,
        )
      ).success,
    ).toBe(true);
  };
  await manager.createSession(ID, "emulator-5554", "android", { timeoutMs: 120_000 });
  await heartbeat();
  const session = manager.getSession(ID)!;
  const reaped: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (id, reason) => {
      reaped.push(reason);
      await manager.releaseSession(id, reason);
    },
    timer,
  );
  rig = { timer, manager, session, monitor, heartbeat, reaped };
  return rig;
}

async function silentScans(r: NonNullable<typeof rig>) {
  r.monitor.start();
  for (let i = 0; i < 3; i++) {
    r.timer.setCurrentTime(r.timer.now() + SCAN_MS);
    await r.monitor.tick();
  }
}

async function lateScan(r: NonNullable<typeof rig>, lostMs: number) {
  r.timer.setCurrentTime(r.timer.now() + SCAN_MS + lostMs);
  await r.monitor.tick();
}

function forgive(
  r: NonNullable<typeof rig>,
  lostMs: number,
  sleptMs = 0,
  gapBeganAt = r.manager.sessionNow(),
) {
  r.timer.setCurrentTime(r.timer.now() + lostMs + sleptMs);
  const before = judgedLeaseHeartbeat(r.session);
  r.manager.forgiveDaemonStall(r.manager.sessionNow(), lostMs, sleptMs, gapBeganAt);
  return judgedLeaseHeartbeat(r.session) - before;
}

describe("connected-owner stall excuse (#11992)", () => {
  test("a connected silent owner receives 12 s and survives the late scan", async () => {
    const r = await setUp();
    await silentScans(r);
    await lateScan(r, 12_000);
    expect(r.session.stallForgivenAt).toBe(r.session.lastOwnerHeartbeat! + 12_000);
    expect(r.reaped).toEqual([]);
    expect(r.manager.getSession(ID)).toBe(r.session);
  });

  test("a connected silent owner survives the issue's 35 s awake stall", async () => {
    const r = await setUp();
    await silentScans(r);
    await lateScan(r, 35_000);
    expect(r.reaped).toEqual([]);
    expect(r.session.stallForgivenAt).toBe(r.session.lastOwnerHeartbeat! + 35_000);
    expect(r.manager.getSession(ID)).toBe(r.session);
  });

  test("a 5 min awake stall is credited fully while the owner remains connected", async () => {
    const r = await setUp();
    await silentScans(r);
    await lateScan(r, 300_000);
    expect(r.session.stallForgivenAt).toBe(r.session.lastOwnerHeartbeat! + 300_000);
    expect(r.reaped).toEqual([]);
    expect(r.manager.getSession(ID)).toBe(r.session);
  });

  test("a 900 s awake stall credits exactly 600 s and is reaped", async () => {
    const r = await setUp();
    await silentScans(r);
    await lateScan(r, 900_000);
    expect(r.session.stallForgivenAt).toBe(r.session.lastOwnerHeartbeat! + 600_000);
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  for (const connected of [false, undefined]) {
    test(`a ${connected === false ? "closed owner" : "missing reader"} receives nothing and is reaped`, async () => {
      const r = await setUp(connected);
      // Undefined explicitly removes the rig's default reader.
      if (connected === undefined) {
        r.manager.setOwnerConnectedAtReader(undefined);
      }
      await silentScans(r);
      await lateScan(r, 12_000);
      expect(r.session.stallForgivenAt).toBeUndefined();
      expect(r.reaped).toEqual(["heartbeat-timeout"]);
    });
  }

  test("an owner that closes during a 78 s stall credits exactly 30 s and is reaped", async () => {
    const r = await setUp();
    await silentScans(r);
    const closedAt = r.manager.sessionNow() + 1;
    r.manager.setOwnerConnectedAtReader((_session, at) => at < closedAt);
    await lateScan(r, 78_000);
    expect(r.session.stallForgivenAt).toBe(
      r.session.lastOwnerHeartbeat! + MAX_CREDIBLE_DAEMON_STALL_MS,
    );
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  test("successive stalls with owners closing at resume spend 12 + 15 + 3 + 0 s", async () => {
    const r = await setUp();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    // Each gap starts connected, but its owner socket closes before that gap resumes.
    r.manager.setOwnerConnectedAtReader((_session, at) => at < r.manager.sessionNow());
    expect([12_000, 15_000, 18_000, 12_000].map((lost) => forgive(r, lost))).toEqual([
      12_000, 15_000, 3_000, 0,
    ]);
  });

  test("twenty-one 29 s stalls exhaust the still-connected owner's 600 s cumulative cap", async () => {
    const r = await setUp();
    const heartbeatAt = r.session.lastOwnerHeartbeat!;
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    // Direct gap delivery avoids scan-time debt reaping the owner before the budget is spent.
    for (let tick = 0; tick < 20; tick++) {
      expect(forgive(r, 29_000)).toBe(29_000);
    }
    expect(forgive(r, 29_000)).toBe(20_000);
    expect(forgive(r, 12_000)).toBe(0);
    expect(r.session.stallForgivenAt).toBe(heartbeatAt + 600_000);
    r.monitor.start();
    await lateScan(r, 0);
    expect(r.manager.sessionNow() - heartbeatAt).toBe(629_000);
    expect(r.manager.sessionNow() - heartbeatAt).toBeLessThanOrEqual(
      r.session.heartbeatTimeoutMs + SUSPECT_GRACE_MS + 600_000 + SCAN_MS + 29_000,
    );
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  test("ordinary scan-time debt still releases a silent connected owner after two 29 s late ticks", async () => {
    const r = await setUp();
    await silentScans(r);
    await lateScan(r, 29_000);
    expect(r.reaped).toEqual([]);
    await lateScan(r, 29_000);
    expect(r.session.stallForgivenAt).toBe(r.session.lastOwnerHeartbeat! + 58_000);
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  test("closing during a later gap adds no credit once more than 30 s was spent", async () => {
    const r = await setUp();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 300_000)).toBe(300_000);
    const closedAt = r.manager.sessionNow() + 1;
    r.manager.setOwnerConnectedAtReader((_session, at) => at < closedAt);
    expect(forgive(r, 12_000)).toBe(0);
    expect(r.session.stallForgivenAt).toBe(r.session.lastOwnerHeartbeat! + 300_000);
    // Reopening does not refund previously spent credit.
    r.manager.setOwnerConnectedAtReader(() => true);
    expect(forgive(r, 300_000)).toBe(300_000);
    expect(forgive(r, 12_000)).toBe(0);
  });

  test("without a late tick the connected silent owner is released at 10 s", async () => {
    const r = await setUp();
    const start = r.manager.sessionNow();
    r.monitor.start();
    for (let i = 0; i < 5; i++) {
      r.timer.setCurrentTime(r.timer.now() + SCAN_MS);
      await r.monitor.tick();
    }
    expect(r.manager.sessionNow() - start).toBe(10_000);
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  test("a new owner heartbeat resets the connected credit budget", async () => {
    const r = await setUp();
    r.manager.setOwnerConnectedAtReader((_session, at) => at < r.manager.sessionNow());
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 30_000)).toBe(30_000);
    await r.heartbeat();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 30_000)).toBe(30_000);
  });

  test("a new owner heartbeat resets an exhausted 600 s connected credit budget", async () => {
    const r = await setUp();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 600_000)).toBe(600_000);
    expect(forgive(r, 12_000)).toBe(0);
    await r.heartbeat();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 600_000)).toBe(600_000);
  });

  test("a live owner's 40 s stall is forgiven fully without spending connected credit", async () => {
    const r = await setUp();
    expect(forgive(r, 40_000)).toBe(40_000);
    r.manager.setOwnerConnectedAtReader((_session, at) => at < r.manager.sessionNow());
    expect(forgive(r, 30_000)).toBe(30_000);
    expect(forgive(r, 12_000)).toBe(0);
  });

  test("sleep alone gives a connected silent owner no credit", async () => {
    const r = await setUp();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 0, 12_000)).toBe(0);
    expect(r.session.stallForgivenAt).toBeUndefined();
  });

  test("missing gap, CLI and awaiting-owner sessions never spend connected credit", async () => {
    const r = await setUp();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    const reads = spyOn({ read: () => true }, "read");
    r.manager.setOwnerConnectedAtReader(reads);
    r.manager.forgiveDaemonStall(r.manager.sessionNow() + 12_000, 12_000);
    expect(reads).not.toHaveBeenCalled();
    r.session.livenessPolicy = "cli-idle";
    forgive(r, 12_000);
    r.session.livenessPolicy = "heartbeat";
    r.session.ownership = "awaiting-owner";
    forgive(r, 12_000);
    expect(reads).not.toHaveBeenCalled();
  });

  test("the log distinguishes connected credit from ordinary lease forgiveness", async () => {
    const r = await setUp();
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    const closedAt = r.manager.sessionNow() + 1;
    r.manager.setOwnerConnectedAtReader((_session, at) => at < closedAt);
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      forgive(r, 78_000);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining(
          "0 session lease(s) extended by 78000ms, 1 connected-owner lease(s) extended by 30000ms",
        ),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe("owner connection interval history on the session clock", () => {
  test("an open interval includes its start and excludes times before attachment", async () => {
    const { session } = await setUp();
    const history = new OwnerConnectionIntervals();
    expect(history.connectedAt(session, 10)).toBe(false);
    history.connected(session, 10);
    expect(history.connectedAt(session, 9)).toBe(false);
    expect(history.connectedAt(session, 10)).toBe(true);
    expect(history.connectedAt(session, 99)).toBe(true);
  });

  test("a closed socket excludes the closing instant and everything later", async () => {
    const { session } = await setUp();
    const history = new OwnerConnectionIntervals();
    history.connected(session, 10);
    history.disconnected(session, 20);
    expect(history.connectedAt(session, 19)).toBe(true);
    expect(history.connectedAt(session, 20)).toBe(false);
    expect(history.connectedAt(session, 21)).toBe(false);
    history.disconnected(session, 25);
    expect(history.connectedAt(session, 21)).toBe(false);
  });

  test("a replacement preserves the last closed interval covering the gap start", async () => {
    const { session } = await setUp();
    const history = new OwnerConnectionIntervals();
    history.connected(session, 10);
    history.disconnected(session, 30);
    history.connected(session, 40);
    expect(history.connectedAt(session, 20)).toBe(true);
    expect(history.connectedAt(session, 35)).toBe(false);
    expect(history.connectedAt(session, 40)).toBe(true);
    history.disconnected(session, 50);
    // Only the most recent closed interval is retained.
    expect(history.connectedAt(session, 20)).toBe(false);
    expect(history.connectedAt(session, 45)).toBe(true);
  });

  test("ownership handover without an ownerless instant is continuous", async () => {
    const { session } = await setUp();
    const history = new OwnerConnectionIntervals();
    history.connected(session, 10);
    history.connected(session, 30);
    expect(history.connectedAt(session, 20)).toBe(true);
    history.disconnected(session, 40);
    expect(history.connectedAt(session, 10)).toBe(true);
    expect(history.connectedAt(session, 40)).toBe(false);
  });

  test("attachment after the gap start supplies no earlier connection proof", async () => {
    const { session } = await setUp();
    const history = new OwnerConnectionIntervals();
    history.connected(session, 30);
    expect(history.connectedAt(session, 20)).toBe(false);
  });

  test("a recreated session id inherits neither connection history nor credit budget", async () => {
    const r = await setUp();
    r.manager.setOwnerConnectedAtReader((_session, at) => at < r.manager.sessionNow());
    const history = new OwnerConnectionIntervals();
    history.connected(r.session, r.manager.sessionNow());
    r.timer.setCurrentTime(r.timer.now() + 6_000);
    expect(forgive(r, 30_000)).toBe(30_000);
    // A distinct incarnation with the SAME id and raw heartbeat stamp must still get a fresh
    // budget. A changed stamp alone would reset even an incorrectly id-keyed budget.
    const replacement = { ...r.session, stallForgivenAt: undefined };
    expect(replacement).not.toBe(r.session);
    expect(history.connectedAt(replacement, r.manager.sessionNow())).toBe(false);
    const extension = daemonStallLeaseExtension(
      replacement,
      r.manager.sessionNow(),
      { lostMs: 30_000, sleptMs: 0, gapBeganAt: r.manager.sessionNow() - 30_000 },
      (_session, at) => at < r.manager.sessionNow(),
    );
    expect(extension.connectedCreditMs).toBe(30_000);
    expect(extension.leaseStart).toBe(replacement.lastOwnerHeartbeat! + 30_000);
  });
});
