import { afterEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonMethodResult,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// Contract: a live owner heartbeating on time is never released, and a contended database stays
// off the heartbeat path (#11079, #11321, #11646).
//
// The stdio proxy's FIRST heartbeat for a session carries `claimLivenessOwnership: true`. The
// daemon accepts the claim synchronously and then writes the ownership row. While that write
// waits (the daemon's single writer is busy, or a peer daemon holds the write lock), the monitor
// must judge the session as one whose owner has heartbeated, not reap it as
// `missing-first-heartbeat` at the 5 s grace. The fact is in-memory only: a claim whose write
// fails, and a claim that is refused, leave the session as it was, and an owner that stops
// heartbeating is still released within 10 s.
//
// The real SessionManager, SessionHeartbeatMonitor and daemon request handlers run over an
// in-memory persistence fake and a FakeTimer. Nothing here starts a process or touches a device.

const SESSION = "first-claim-session";
const DEVICE = "emulator-5554";
const OWNER = "first-claim-owner";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

interface Rig {
  persistence: FakeDeviceSessionPersistence;
  manager: SessionManager;
  /** The reasons the monitor reaped with, in order. */
  reaped: string[];
  request(method: string, params: Record<string, unknown>): Promise<DaemonMethodResult>;
  /** Move the clock forward by `ms` without running a scan. */
  advance(ms: number): void;
  /** One monitor scan `afterMs` later (on time by default); does not wait for its releases. */
  scanOnTime(afterMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

/** Let every already-resolvable continuation run; no timer is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    await Promise.resolve();
  }
}

/** Hold the ownership row write until the test opens (or fails) it. */
function gateOwnershipWrite(persistence: FakeDeviceSessionPersistence): {
  open(): void;
  fail(error: Error): void;
} {
  let gated = true;
  let open!: () => void;
  let fail!: (error: Error) => void;
  const wait = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  const write = persistence.recordLivenessOwnership.bind(persistence);
  persistence.recordLivenessOwnership = async (sessionUuid, ownerToken) => {
    // Only writes started while the gate is closed wait on it; a retry after it goes straight in.
    if (gated) {
      await wait;
    }
    await write(sessionUuid, ownerToken);
  };
  const settleWith = <A extends unknown[]>(settle: (...args: A) => void) => {
    return (...args: A) => {
      gated = false;
      settle(...args);
    };
  };
  return { open: settleWith(open), fail: settleWith(fail) };
}

async function setUpRig(ownership?: "awaiting-owner"): Promise<Rig> {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  const reaped: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (sessionId, reason) => {
      reaped.push(reason);
      await manager.releaseSession(sessionId, reason);
    },
    timer,
  );
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  await manager.createSession(
    SESSION,
    DEVICE,
    "android",
    120_000,
    undefined,
    undefined,
    undefined,
    ownership,
  );
  monitor.start();
  const advance = (ms: number) => timer.setCurrentTime(timer.getCurrentTime() + ms);
  return {
    persistence,
    manager,
    reaped,
    request: (method, params) =>
      handleDaemonRequest({ id: method, type: "daemon_request", method, params }, state),
    advance,
    scanOnTime: async (afterMs = SCAN_MS) => {
      advance(afterMs);
      void monitor.tick().catch(() => undefined);
      await settle();
    },
    dispose: async () => {
      await monitor.stop();
      manager.stopCleanupTimer();
    },
  };
}

function claimingHeartbeat(r: Rig, token = OWNER): Promise<DaemonMethodResult> {
  return r.request("daemon/heartbeat", {
    sessionId: SESSION,
    livenessOwnerToken: token,
    claimLivenessOwnership: true,
  });
}

function keeperTick(r: Rig, token = OWNER): Promise<DaemonMethodResult> {
  return r.request("daemon/heartbeat", { sessionId: SESSION, livenessOwnerToken: token });
}

async function scans(r: Rig, count: number): Promise<void> {
  for (let scan = 0; scan < count; scan++) {
    await r.scanOnTime();
  }
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

describe("the first (claiming) heartbeat while its ownership write is still pending", () => {
  test("a session whose first heartbeat arrived on time is not reaped as missing-first-heartbeat", async () => {
    const r = (rig = await setUpRig());
    const gate = gateOwnershipWrite(r.persistence);

    // The owner's first heartbeat reaches the daemon 1 s after the session was created.
    r.advance(1_000);
    const firstHeartbeat = claimingHeartbeat(r);
    await settle();
    // Premise: the claim was taken on arrival; only its row write is outstanding.
    expect(r.manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);

    // On-time scans 3 s, 5 s and 7 s after creation: 6 s after the heartbeat arrived.
    await scans(r, 3);

    expect(r.reaped).toEqual([]);
    expect(r.manager.getSession(SESSION)).not.toBeNull();

    gate.open();
    expect((await firstHeartbeat).success).toBe(true);
  });

  test("the owner's keeper ticks keep the session for as long as the write stays pending", async () => {
    const r = (rig = await setUpRig());
    gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    void claimingHeartbeat(r);
    await settle();

    for (let tick = 0; tick < 10; tick++) {
      await r.scanOnTime();
      expect((await keeperTick(r)).success).toBe(true);
    }

    expect(r.reaped).toEqual([]);
  });

  test("an owner that stops heartbeating is released on its lease although the write never lands", async () => {
    const r = (rig = await setUpRig());
    gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    void claimingHeartbeat(r);
    await settle();

    // 9 s after creation is 8 s after the only heartbeat: the end of lease plus suspect grace.
    await scans(r, 4);
    expect(r.reaped).toEqual([]);
    // The next scan is within 10 s of the heartbeat that was never followed by another.
    await r.scanOnTime();
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  test("a claim whose write fails leaves a session that never heartbeated, reaped at the first-heartbeat grace", async () => {
    const r = (rig = await setUpRig());
    const gate = gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    const firstHeartbeat = claimingHeartbeat(r);
    await settle();
    await scans(r, 3);
    expect(r.reaped).toEqual([]);

    gate.fail(new Error("database is locked"));
    expect((await firstHeartbeat.catch(() => ({ success: false }))).success).toBe(false);

    const session = r.manager.getSession(SESSION);
    expect(session?.livenessOwnerToken).toBeUndefined();
    expect(session?.hasReceivedHeartbeat).toBe(false);
    // Nobody owns it and nobody heartbeated: the very next scan is past the 5 s grace.
    await r.scanOnTime();
    expect(r.reaped).toEqual(["missing-first-heartbeat"]);
  });

  test("a failed claim write does not erase a heartbeat the session had before the claim", async () => {
    const r = (rig = await setUpRig());
    // A tokenless client heartbeats first; the session has heartbeated and nobody owns it.
    expect((await r.request("daemon/heartbeat", { sessionId: SESSION })).success).toBe(true);
    const gate = gateOwnershipWrite(r.persistence);
    const claim = claimingHeartbeat(r);
    await settle();

    gate.fail(new Error("database is locked"));
    expect((await claim.catch(() => ({ success: false }))).success).toBe(false);

    expect(r.manager.getSession(SESSION)?.hasReceivedHeartbeat).toBe(true);
  });

  test("a refused claim does not count as a heartbeat", async () => {
    const r = (rig = await setUpRig());
    // Another token owns the session with a live lease but the session has not heartbeated.
    expect(r.manager.claimUnownedLivenessOwnership(SESSION, "other-owner")).toBe(true);

    r.advance(1_000);
    const refused = await claimingHeartbeat(r);

    expect(refused.success).toBe(false);
    expect(r.manager.hasLivenessOwnership(SESSION, "other-owner")).toBe(true);
    expect(r.manager.getSession(SESSION)?.hasReceivedHeartbeat).toBe(false);
    // 7 s after creation with no heartbeat from anyone: past the 5 s grace.
    await scans(r, 3);
    expect(r.reaped).toEqual(["missing-first-heartbeat"]);
  });

  test("a non-claiming first heartbeat is recorded on arrival and waits for no write", async () => {
    const r = (rig = await setUpRig());
    gateOwnershipWrite(r.persistence);
    const recordActivity = r.persistence.recordActivity.bind(r.persistence);
    let releaseActivityWrites!: () => void;
    const activityGate = new Promise<void>((resolve) => {
      releaseActivityWrites = resolve;
    });
    r.persistence.recordActivity = async (sessionUuid, update) => {
      await activityGate;
      await recordActivity(sessionUuid, update);
    };

    r.advance(1_000);
    expect((await keeperTick(r)).success).toBe(true);
    await scans(r, 3);

    expect(r.reaped).toEqual([]);
    expect(r.manager.getSession(SESSION)?.hasReceivedHeartbeat).toBe(true);
    releaseActivityWrites();
  });
});

describe("a second heartbeat for the session while the first claim's write is pending (#11646)", () => {
  // The proxy has not seen its claim acknowledged, so a heartbeat it sends meanwhile may carry
  // the claim again. Either form renews the lease when it arrives; neither starts a second write.
  test("a repeated claim from the same owner renews the lease on arrival and waits for the one write", async () => {
    const r = (rig = await setUpRig());
    let ownershipWrites = 0;
    const write = r.persistence.recordLivenessOwnership.bind(r.persistence);
    r.persistence.recordLivenessOwnership = async (sessionUuid, ownerToken) => {
      ownershipWrites++;
      await write(sessionUuid, ownerToken);
    };
    const gate = gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    const first = claimingHeartbeat(r);
    await settle();
    const claimedAt = r.manager.getSession(SESSION)?.lastOwnerHeartbeat ?? Number.NaN;

    r.advance(3_000);
    let secondSettled = false;
    const second = claimingHeartbeat(r).finally(() => {
      secondSettled = true;
    });
    await settle();

    // Stamped on arrival, 3 s after the claim; the reply waits behind the first claim's write.
    expect(r.manager.getSession(SESSION)?.lastOwnerHeartbeat).toBe(claimedAt + 3_000);
    expect(r.manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(secondSettled).toBe(false);

    gate.open();
    expect([(await first).success, (await second).success]).toEqual([true, true]);
    expect(ownershipWrites).toBe(1);
    expect(r.manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);
  });

  test("another token's claim is refused and leaves the pending claimant's lease alone", async () => {
    const r = (rig = await setUpRig());
    const gate = gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    const first = claimingHeartbeat(r);
    await settle();
    const claimedAt = r.manager.getSession(SESSION)?.lastOwnerHeartbeat;

    r.advance(3_000);
    const foreign = claimingHeartbeat(r, "other-owner");
    await settle();
    expect(r.manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);
    expect(r.manager.getSession(SESSION)?.lastOwnerHeartbeat).toBe(claimedAt);

    gate.open();
    expect((await first).success).toBe(true);
    expect((await foreign).success).toBe(false);
    expect(r.manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);
  });
});

describe("a claim the daemon makes for its owner (binding hand-off)", () => {
  // `ManagedSlotAcquisition.handOff` claims for the proxy's token and adopts the managed policy
  // before the acquisition reply reaches the proxy; the proxy's first heartbeat follows the reply.
  async function handOff(r: Rig): Promise<void> {
    expect(await r.manager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    await r.manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 600_000 });
  }

  test("the owner's first heartbeat inside lease plus grace keeps the session", async () => {
    const r = (rig = await setUpRig());
    await handOff(r);

    // 6 s after the hand-off the lease has lapsed and the session is suspect, not released.
    await scans(r, 3);
    expect(r.manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    expect((await claimingHeartbeat(r)).success).toBe(true);

    expect(r.manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(r.reaped).toEqual([]);
  });

  test("a hand-off no owner ever heartbeats is released within 10 s", async () => {
    const r = (rig = await setUpRig());
    await handOff(r);

    await scans(r, 4);
    expect(r.reaped).toEqual([]);
    await r.scanOnTime();
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });
});

describe("a returning owner's re-claim of a rehydrated session while its write is pending", () => {
  test("the session is not reaped as rehydration-owner-timeout once the claim was accepted", async () => {
    const r = (rig = await setUpRig("awaiting-owner"));
    const gate = gateOwnershipWrite(r.persistence);

    r.advance(1_000);
    const reclaim = claimingHeartbeat(r);
    await settle();
    expect(r.manager.getSession(SESSION)?.ownership).toBe("owned");

    // The owner keeps ticking; scans run to 11 s after rehydration, past the 8 s owner window.
    for (let tick = 0; tick < 5; tick++) {
      await r.scanOnTime();
      expect((await keeperTick(r)).success).toBe(true);
    }
    expect(r.reaped).toEqual([]);

    gate.open();
    expect((await reclaim).success).toBe(true);
    expect(r.manager.getSession(SESSION)?.awaitingOwnerSince).toBeUndefined();
  });

  test("a re-claim whose write fails leaves the session awaiting its owner on the original window", async () => {
    const r = (rig = await setUpRig("awaiting-owner"));
    const awaitingSince = r.manager.getSession(SESSION)?.awaitingOwnerSince;
    const gate = gateOwnershipWrite(r.persistence);

    r.advance(1_000);
    const reclaim = claimingHeartbeat(r);
    await settle();
    await scans(r, 2);

    gate.fail(new Error("database is locked"));
    expect((await reclaim.catch(() => ({ success: false }))).success).toBe(false);

    const session = r.manager.getSession(SESSION);
    expect(session?.ownership).toBe("awaiting-owner");
    expect(session?.awaitingOwnerSince).toBe(awaitingSince);
    expect(session?.livenessOwnerToken).toBeUndefined();
    // 9 s after rehydration with no owner: past the 8 s owner window.
    await scans(r, 2);
    expect(r.reaped).toEqual(["rehydration-owner-timeout"]);
  });

  test("a live owner whose re-claim write fails late is judged on its own ticks, not the old window", async () => {
    const r = (rig = await setUpRig("awaiting-owner"));
    const gate = gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    const reclaim = claimingHeartbeat(r);
    await settle();
    // The owner ticks to 9 s after rehydration, past the 8 s owner window, with the write pending.
    for (let tick = 0; tick < 4; tick++) {
      await r.scanOnTime();
      expect((await keeperTick(r)).success).toBe(true);
    }

    gate.fail(new Error("database is locked"));
    expect((await reclaim.catch(() => ({ success: false }))).success).toBe(false);
    // The ticks were heartbeats in their own right: the failed claim does not hand the session
    // back to a window that ended while its owner was heartbeating.
    await r.scanOnTime();
    expect(r.reaped).toEqual([]);
    expect((await keeperTick(r)).success).toBe(true);

    // The lease still applies: with no further tick the owner is released within 10 s.
    await scans(r, 4);
    expect(r.reaped).toEqual([]);
    await r.scanOnTime();
    expect(r.reaped).toEqual(["heartbeat-timeout"]);
  });

  test("a daemon stall while the re-claim write is pending is still forgiven when the write fails", async () => {
    const r = (rig = await setUpRig("awaiting-owner"));
    const gate = gateOwnershipWrite(r.persistence);
    r.advance(1_000);
    const reclaim = claimingHeartbeat(r);
    await settle();
    await r.scanOnTime();
    // The daemon stalls for 20 s; the late scan forgives the stall on the owner window too.
    await r.scanOnTime(20_000);

    gate.fail(new Error("database is locked"));
    expect((await reclaim.catch(() => ({ success: false }))).success).toBe(false);
    expect(r.manager.getSession(SESSION)?.ownership).toBe("awaiting-owner");

    // The undone claim returns to the forgiven window, so the owner's retry still finds it.
    await r.scanOnTime();
    expect(r.reaped).toEqual([]);
    expect((await claimingHeartbeat(r)).success).toBe(true);
  });
});
