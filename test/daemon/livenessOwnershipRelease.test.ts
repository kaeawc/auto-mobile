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
    await manager.createSession(SESSION, DEVICE, "android", 60_000, undefined, "Pixel_8_API_35");
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
    expect(await persistence.getSession?.(SESSION)).toMatchObject({
      liveness_owner_token: null,
      liveness_released_by: OWNER,
      liveness_released_heartbeat_ms: before.lastOwnerHeartbeat,
      liveness_released_grace_ms: 0,
    });
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

  test("release requires proof even on a never-owned session", async () => {
    await manager.createSession("never-owned", DEVICE, "android");
    const before = { ...manager.getSession("never-owned")! };
    expect(
      await request("daemon/releaseLivenessOwnership", {
        sessionId: "never-owned",
        livenessOwnerToken: OWNER,
      }),
    ).toMatchObject({ success: false, code: "liveness_owner_superseded" });
    expect(manager.getSession("never-owned")).toEqual(before);
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
      success: false,
      code: "liveness_owner_superseded",
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
      // With no activity, both policies retain the original expiry window.
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

  test("release of a restored awaiting owner retains its deadline without adding grace", async () => {
    const session = manager.getSession(SESSION)!;
    session.ownership = "awaiting-owner";
    session.awaitingOwnerSince = timer.now();
    session.hasReceivedHeartbeat = false;
    await release();
    timer.advanceTime(LEASE + 1);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
  });

  test.each(["heartbeat", "cli"])(
    "release survives rehydration on %s without moving its deadline",
    async (policy) => {
      await claim(OWNER, policy);
      timer.advanceTime(1_000);
      await release();
      const before = { ...manager.getSession(SESSION)! };
      await persistence.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
      manager.stopCleanupTimer();
      manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
      timer.advanceTime(2_000);
      expect(
        await manager.rehydratePersistedSessions({
          assignDeviceToSession: async (id, _platform, target) => {
            await manager.createSession(
              id,
              DEVICE,
              "android",
              target?.liveness?.sessionTimeoutMs,
              target?.liveness?.heartbeatTimeoutMs,
              target?.stableDeviceId,
              target?.liveness,
              target?.initialOwnership,
            );
            return DEVICE;
          },
        }),
      ).toMatchObject({ rehydrated: [SESSION], skipped: [] });
      const restored = manager.getSession(SESSION)!;
      expect(restored).toMatchObject({
        livenessOwnershipReleased: true,
        livenessOwnerToken: undefined,
        lastHeartbeat: before.lastHeartbeat,
        lastOwnerHeartbeat: before.lastOwnerHeartbeat,
        expiresAt: before.expiresAt,
      });
      const unchanged = { ...restored };
      expect((await request("daemon/heartbeat")).success).toBe(true);
      expect(await tick(OWNER)).toMatchObject({
        success: false,
        code: "liveness_owner_superseded",
      });
      expect(restored).toEqual(unchanged);
      expect(await request("daemon/sessionInfo")).toMatchObject({
        result: {
          livenessOwner: "unowned",
          liveness: { state: "unowned", remainingMs: before.heartbeatTimeoutMs - timer.now() },
        },
      });
      const restartedMonitor = new SessionHeartbeatMonitor(
        manager,
        () => false,
        async (id, reason) => {
          reaped.push({ sessionId: id, reason });
          await manager.releaseSession(id, reason);
        },
        timer,
      );
      const deadline = before.heartbeatTimeoutMs + (policy === "heartbeat" ? SUSPECT_GRACE_MS : 0);
      timer.advanceTime(deadline - timer.now());
      await restartedMonitor.tick();
      expect(reaped).toEqual([]);
      timer.advanceTime(1);
      await restartedMonitor.tick();
      expect(reaped).toEqual([
        {
          sessionId: SESSION,
          reason: policy === "heartbeat" ? "heartbeat-timeout" : "cli-idle-timeout",
        },
      ]);
      await restartedMonitor.stop();
    },
  );

  test("an explicit claim adopts a rehydrated released session", async () => {
    await release();
    const row = (await persistence.getSession?.(SESSION))!;
    // Rehydrate through the same persisted-row path used by startup recovery.
    await persistence.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    manager.stopCleanupTimer();
    manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
    await manager.rehydratePersistedSessions({
      assignDeviceToSession: async (id, _platform, target) => {
        await manager.createSession(
          id,
          DEVICE,
          "android",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          row.stable_device_id ?? undefined,
          target?.liveness,
          target?.initialOwnership,
        );
        return DEVICE;
      },
    });
    expect((await claim("next")).success).toBe(true);
    expect(manager.getSession(SESSION)?.livenessOwnershipReleased).toBeUndefined();
    expect((await persistence.getSession?.(SESSION))?.liveness_released_by).toBeNull();
  });

  test("released CLI activity keeps the idle window alive, then a claim restores heartbeat expiry", async () => {
    await claim(OWNER, "cli");
    await release();
    for (let call = 0; call < 4; call++) {
      timer.advanceTime(40_000);
      await manager.getOrCreateSession(SESSION);
      await monitor.tick();
      expect(reaped).toEqual([]);
    }
    timer.advanceTime(60_000);
    await monitor.tick();
    expect(reaped).toEqual([]);
    timer.advanceTime(1);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "cli-idle-timeout" }]);
  });

  test("claim switches a released CLI session from tool idleness to heartbeat policy", async () => {
    await claim(OWNER, "cli");
    await release();
    timer.advanceTime(40_000);
    await manager.getOrCreateSession(SESSION);
    expect((await claim("next")).success).toBe(true);
    expect(manager.getSession(SESSION)?.livenessPolicy).toBe("heartbeat");
    timer.advanceTime(LEASE + SUSPECT_GRACE_MS + 1);
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

  test.each([false, true])("two claims wait at persistence, reverse=%s", async (reverse) => {
    await release();
    const tokens = reverse ? ["b", "a"] : ["a", "b"];
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const write = persistence.recordLivenessOwnership.bind(persistence);
    const spy = spyOn(persistence, "recordLivenessOwnership").mockImplementation(
      async (...args) => {
        if (args[1] === tokens[0]) {
          entered.resolve();
          await resume.promise;
        }
        await write(...args);
      },
    );
    try {
      const first = claim(tokens[0]);
      await entered.promise;
      const second = claim(tokens[1]);
      resume.resolve();
      expect((await first).success).toBe(true);
      expect(await second).toMatchObject({ success: false, code: "liveness_owner_conflict" });
      expect(manager.hasLivenessOwnership(SESSION, tokens[0])).toBe(true);
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
  });

  test.each([
    { releaseFirst: false, lapsed: false },
    { releaseFirst: true, lapsed: false },
    { releaseFirst: false, lapsed: true },
    { releaseFirst: true, lapsed: true },
  ])(
    "release vs foreign claim is gated, releaseFirst=$releaseFirst, lapsed=$lapsed",
    async ({ releaseFirst, lapsed }) => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      expect(await claim("foreign")).toMatchObject({
        success: false,
        code: "liveness_owner_conflict",
      });
      if (lapsed) {
        timer.advanceTime(LEASE + SUSPECT_GRACE_MS + 1);
      }
      const method = releaseFirst ? "releaseLivenessOwnership" : "claimLivenessOwnership";
      const original = manager[method].bind(manager);
      const spy = spyOn(manager, method).mockImplementation(async (...args) => {
        const result = await original(...args);
        entered.resolve();
        await resume.promise;
        return result;
      });
      try {
        const first = releaseFirst ? release() : claim("next");
        await entered.promise;
        const second = releaseFirst ? claim("next") : release();
        // The other operation completes while the first response is suspended.
        expect(await second).toMatchObject(
          !releaseFirst && lapsed
            ? { success: false, code: "liveness_owner_superseded" }
            : { success: true },
        );
        resume.resolve();
        expect(await first).toMatchObject(
          releaseFirst || lapsed
            ? { success: true }
            : { success: false, code: "liveness_owner_conflict" },
        );
        expect(manager.getSession(SESSION)?.livenessOwnerToken).toBe(
          releaseFirst || lapsed ? "next" : undefined,
        );
      } finally {
        resume.resolve();
        spy.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "release vs owner tick is gated, releaseFirst=%s",
    async (releaseFirst) => {
      timer.advanceTime(4_000);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const write = persistence.recordLivenessOwnership.bind(persistence);
      const ownershipSpy = spyOn(persistence, "recordLivenessOwnership").mockImplementation(
        async (...args) => {
          await write(...args);
          if (releaseFirst) {
            entered.resolve();
            await resume.promise;
          }
        },
      );
      const activity = persistence.recordActivity.bind(persistence);
      const activitySpy = spyOn(persistence, "recordActivity").mockImplementation(
        async (...args) => {
          await activity(...args);
          if (!releaseFirst) {
            entered.resolve();
            await resume.promise;
          }
        },
      );
      try {
        const first = releaseFirst ? release() : tick(OWNER);
        await entered.promise;
        const second = releaseFirst ? tick(OWNER) : release();
        expect(await second).toMatchObject(
          releaseFirst ? { success: false, code: "liveness_owner_superseded" } : { success: true },
        );
        resume.resolve();
        expect((await first).success).toBe(true);
        expect(manager.getSession(SESSION)?.lastOwnerHeartbeat).toBe(releaseFirst ? 0 : 4_000);
      } finally {
        resume.resolve();
        ownershipSpy.mockRestore();
        activitySpy.mockRestore();
      }
    },
  );

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
      async (id, token, releaseState) => {
        if (token === null) {
          started.resolve();
          await finish.promise;
        }
        await write(id, token, releaseState);
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
