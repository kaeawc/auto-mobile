import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "handoff-session";
const DEVICE = "emulator-5554";
const OWNER = "original-owner";
const LEASE = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;

describe("deliberate liveness ownership release", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let state: DaemonStateAccess;
  let monitor: SessionHeartbeatMonitor;
  let reaped: Array<{ sessionId: string; reason: string }>;

  function request(method: string, params: Record<string, unknown> = {}) {
    return handleDaemonRequest(
      { id: "unit", type: "daemon_request", method, params: { sessionId: SESSION, ...params } },
      state,
    );
  }
  const claim = (token: string, policy = "heartbeat") =>
    request("daemon/heartbeat", {
      livenessOwnerToken: token,
      claimLivenessOwnership: true,
      livenessPolicy: policy,
      idleTimeoutMs: 60_000,
    });
  const tick = (token: string) => request("daemon/heartbeat", { livenessOwnerToken: token });
  const release = (token = OWNER) =>
    request("daemon/releaseLivenessOwnership", { livenessOwnerToken: token });

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        releaseDevice: async () => {
          throw new Error("Ownership release must not free a device");
        },
      }),
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await manager.createSession(SESSION, DEVICE, "android", 60_000);
    expect((await claim(OWNER)).success).toBe(true);
  });
  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test("CLI then proxy claims immediately, restores policy, and excludes other proxies/keepers", async () => {
    await claim(OWNER, "cli");
    const session = manager.getSession(SESSION)!;
    const before = { ...session };
    expect(await release()).toEqual({
      success: true,
      result: { sessionId: SESSION, alreadyUnowned: false },
    });
    expect(session).toMatchObject({
      assignedDevice: DEVICE,
      livenessPolicy: "cli-idle",
      livenessOwnerToken: undefined,
      lastHeartbeat: before.lastHeartbeat,
      lastOwnerHeartbeat: before.lastOwnerHeartbeat,
      expiresAt: before.expiresAt,
      heartbeatTimeoutMs: before.heartbeatTimeoutMs,
    });
    expect((await persistence.getSession?.(SESSION))?.liveness_owner_token).toBeNull();
    expect(await request("daemon/sessionInfo")).toMatchObject({
      result: {
        livenessOwner: "unowned",
        liveness: { state: "unowned", leasePhase: "live", remainingMs: 60_000 },
      },
    });
    expect((await claim("proxy-a")).success).toBe(true);
    expect(session).toMatchObject({
      livenessOwnerToken: "proxy-a",
      livenessPolicy: "heartbeat",
      heartbeatTimeoutMs: LEASE,
    });
    expect(await claim("proxy-b")).toMatchObject({
      success: false,
      code: "liveness_owner_conflict",
    });
    expect(
      await request("daemon/heartbeat", {
        livenessOwnerKind: "cli-keeper",
        livenessOwnerToken: "proxy-a",
        claimLivenessOwnership: true,
      }),
    ).toMatchObject({ success: false, code: "liveness_owner_is_proxy" });
  });

  test("foreign release is a typed no-op; unknown and malformed calls fail", async () => {
    const before = { ...manager.getSession(SESSION)! };
    expect(await release("foreign")).toMatchObject({
      success: false,
      code: "liveness_owner_superseded",
    });
    expect(manager.getSession(SESSION)).toEqual(before);
    expect(
      await request("daemon/releaseLivenessOwnership", {
        sessionId: "unknown",
        livenessOwnerToken: OWNER,
      }),
    ).toMatchObject({ success: false, code: "daemon_session_not_found" });
    for (const token of [undefined, "", "   ", 42]) {
      expect(
        (await request("daemon/releaseLivenessOwnership", { livenessOwnerToken: token })).success,
      ).toBe(false);
    }
  });

  test("release retries are no-ops; stale and tokenless ticks cannot revive ownership", async () => {
    await release();
    timer.advanceTime(2_000);
    const before = { ...manager.getSession(SESSION)! };
    expect(await release()).toEqual({
      success: true,
      result: { sessionId: SESSION, alreadyUnowned: true },
    });
    expect(await release("foreign")).toMatchObject({
      success: true,
      result: { alreadyUnowned: true },
    });
    expect(await tick(OWNER)).toMatchObject({ success: false, code: "liveness_owner_superseded" });
    expect(await request("daemon/heartbeat")).toMatchObject({ success: true });
    expect(manager.getSession(SESSION)).toEqual(before);
    // The explicit unowned rule admits even a previously used token, but only by a claim.
    expect((await claim(OWNER)).success).toBe(true);
    expect(manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);
  });

  test.each(["heartbeat", "cli"])(
    "unclaimed %s session expires with its truthful existing reason",
    async (policy) => {
      await claim(OWNER, policy);
      const session = manager.getSession(SESSION)!;
      const window = session.heartbeatTimeoutMs + (policy === "heartbeat" ? SUSPECT_GRACE_MS : 0);
      timer.advanceTime(1_000);
      await release();
      timer.advanceTime(window - 1_000);
      // Tool activity may update the activity clock, but cannot postpone unowned expiry.
      manager.getSessionCache(SESSION);
      await monitor.tick();
      expect(reaped).toEqual([]);
      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([
        { sessionId: SESSION, reason: policy === "cli" ? "cli-idle-timeout" : "heartbeat-timeout" },
      ]);
      expect(manager.getSession(SESSION)).toBeNull();
    },
  );

  test("release of a restored owner uses lease plus grace, never the reconnect expiry reason", async () => {
    const session = manager.getSession(SESSION)!;
    session.ownership = "awaiting-owner";
    session.awaitingOwnerSince = timer.now();
    session.hasReceivedHeartbeat = false;
    await release();
    timer.advanceTime(LEASE + 1);
    await monitor.tick();
    expect(reaped).toEqual([]);
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    timer.advanceTime(SUSPECT_GRACE_MS);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
  });

  test("daemon stall forgiveness advances the unowned owner clock only by the lost interval", async () => {
    await release();
    timer.advanceTime(8_000);
    manager.getSessionCache(SESSION);
    timer.advanceTime(4_000);
    manager.forgiveDaemonStall(timer.now(), 4_000);
    expect(manager.getSessionLeaseState(SESSION)).toEqual({ phase: "live", remainingMs: 2_000 });
  });

  test.each([false, true])("two proxies contend after release, reverse=%s", async (reverse) => {
    await release();
    const tokens = reverse ? ["proxy-b", "proxy-a"] : ["proxy-a", "proxy-b"];
    const outcomes = await Promise.all(tokens.map((token) => claim(token)));
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[1]).toMatchObject({ success: false, code: "liveness_owner_conflict" });
    expect(manager.hasLivenessOwnership(SESSION, tokens[0])).toBe(true);
  });

  test.each([false, true])(
    "release races a foreign claim, releaseFirst=%s",
    async (releaseFirst) => {
      timer.advanceTime(3_000);
      if (releaseFirst) {
        const [released, claimed] = await Promise.all([release(), claim("next")]);
        expect(released.success).toBe(true);
        expect(claimed.success).toBe(true);
        expect(manager.hasLivenessOwnership(SESSION, "next")).toBe(true);
      } else {
        const [claimed, released] = await Promise.all([claim("next"), release()]);
        expect(claimed).toMatchObject({ success: false, code: "liveness_owner_conflict" });
        expect(released.success).toBe(true);
        expect(manager.getSession(SESSION)?.livenessOwnerToken).toBeUndefined();
      }
    },
  );

  test("heartbeat wins before a concurrent release and leaves its lease as the unowned deadline", async () => {
    timer.advanceTime(4_000);
    const record = manager.recordHeartbeat.bind(manager);
    let releasing: ReturnType<typeof release> | undefined;
    const spy = spyOn(manager, "recordHeartbeat").mockImplementation((id) => {
      record(id);
      releasing = release();
    });
    try {
      expect((await tick(OWNER)).success).toBe(true);
      expect(releasing).toBeDefined();
      expect((await releasing)?.success).toBe(true);
      timer.advanceTime(1_000);
      expect(manager.getSession(SESSION)?.lastOwnerHeartbeat).toBe(4_000);
      expect(manager.getSessionLeaseState(SESSION)?.remainingMs).toBe(LEASE - 1_000);
    } finally {
      spy.mockRestore();
    }
  });

  test("release wins against a concurrent recurring heartbeat", async () => {
    timer.advanceTime(4_000);
    const [released, heartbeat] = await Promise.all([release(), tick(OWNER)]);
    expect(released.success).toBe(true);
    expect(heartbeat).toMatchObject({ success: false, code: "liveness_owner_superseded" });
    expect(manager.getSession(SESSION)?.lastOwnerHeartbeat).toBe(0);
  });

  test("a successful foreign claim wins before an old owner's concurrent release", async () => {
    timer.advanceTime(LEASE + SUSPECT_GRACE_MS + 1);
    const [claimed, released] = await Promise.all([claim("next"), release()]);
    expect(claimed.success).toBe(true);
    expect(released).toMatchObject({ success: false, code: "liveness_owner_superseded" });
    expect(manager.hasLivenessOwnership(SESSION, "next")).toBe(true);
  });

  test("release wins against a heartbeat whose ownership check is in flight", async () => {
    timer.advanceTime(4_000);
    const original = manager.claimLivenessOwnership.bind(manager);
    const checked = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const spy = spyOn(manager, "claimLivenessOwnership").mockImplementation(async (...args) => {
      const outcome = await original(...args);
      checked.resolve();
      await resume.promise;
      return outcome;
    });
    try {
      const heartbeat = claim(OWNER);
      await checked.promise;
      await release();
      const before = { ...manager.getSession(SESSION)! };
      resume.resolve();
      expect(await heartbeat).toMatchObject({ success: false, code: "liveness_owner_superseded" });
      expect(manager.getSession(SESSION)).toEqual(before);
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
  });

  test("failed release persistence restores ownership and a retry can succeed", async () => {
    const spy = spyOn(persistence, "recordLivenessOwnership").mockRejectedValueOnce(
      new Error("write failed"),
    );
    await expect(release()).rejects.toThrow("write failed");
    expect(manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);
    expect(manager.getSession(SESSION)?.livenessOwnershipReleased).toBeUndefined();
    spy.mockRestore();
    expect((await release()).success).toBe(true);
  });

  test("a claim waits for release persistence before acknowledging its takeover", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const write = persistence.recordLivenessOwnership.bind(persistence);
    const spy = spyOn(persistence, "recordLivenessOwnership").mockImplementation(
      async (id, token) => {
        if (token === null) {
          started.resolve();
          await finish.promise;
        }
        await write(id, token);
      },
    );
    try {
      const released = release();
      await started.promise;
      let settled = false;
      const claimed = claim("next").then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(await tick(OWNER)).toMatchObject({
        success: false,
        code: "liveness_owner_superseded",
      });
      finish.resolve();
      expect((await released).success).toBe(true);
      expect((await claimed).success).toBe(true);
      expect((await persistence.getSession?.(SESSION))?.liveness_owner_token).toBe("next");
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });
});
