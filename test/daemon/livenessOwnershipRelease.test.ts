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
  const tick = (token: string, sessionId = SESSION) =>
    request("daemon/heartbeat", { sessionId, livenessOwnerToken: token });
  const release = (token = OWNER, sessionId = SESSION) =>
    request("daemon/releaseLivenessOwnership", { sessionId, livenessOwnerToken: token });

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

  test("a tick-adopted owner cannot re-adopt after release, and a proxy can claim", async () => {
    const id = "tick-adopted";
    await manager.createSession(id, DEVICE, "android");
    expect((await tick(OWNER, id)).success).toBe(true);
    expect(manager.hasLivenessOwnership(id, OWNER)).toBe(true);
    expect(manager.getSession(id)?.livenessOwnershipClaims?.size ?? 0).toBe(0);
    expect((await release(OWNER, id)).success).toBe(true);
    timer.advanceTime(2_000);
    const before = { ...manager.getSession(id)! };
    expect(await tick(OWNER, id)).toMatchObject({
      success: false,
      code: "liveness_owner_unowned",
    });
    expect(await request("daemon/heartbeat", { sessionId: id })).toMatchObject({ success: true });
    expect(manager.getSession(id)).toEqual(before);
    expect(
      await request("daemon/heartbeat", {
        sessionId: id,
        livenessOwnerToken: "next-proxy",
        claimLivenessOwnership: true,
      }),
    ).toMatchObject({ success: true });
    expect(manager.hasLivenessOwnership(id, "next-proxy")).toBe(true);
    expect(await persistence.getSession(id)).toMatchObject({ liveness_owner_token: "next-proxy" });
  });

  test.each([false, true])(
    "tick-adopted owner tick and release writes agree, releaseFirst=%s",
    async (releaseFirst) => {
      const id = "tick-adopted";
      await manager.createSession(id, DEVICE, "android");
      expect((await tick(OWNER, id)).success).toBe(true);
      timer.advanceTime(4_000);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const activityDone = Promise.withResolvers<void>();
      const write = persistence.recordLivenessOwnership.bind(persistence);
      const ownershipSpy = spyOn(persistence, "recordLivenessOwnership").mockImplementation(
        async (...args) => {
          if (releaseFirst && args[1] === null) {
            entered.resolve();
            await resume.promise;
          }
          await write(...args);
        },
      );
      const activity = persistence.recordActivity.bind(persistence);
      const activitySpy = spyOn(persistence, "recordActivity").mockImplementation(
        async (...args) => {
          if (!releaseFirst) {
            entered.resolve();
            await resume.promise;
          }
          await activity(...args);
          activityDone.resolve();
        },
      );
      try {
        const first = releaseFirst ? release(OWNER, id) : tick(OWNER, id);
        await entered.promise;
        const second = releaseFirst ? tick(OWNER, id) : release(OWNER, id);
        expect(await second).toMatchObject(
          releaseFirst ? { success: false, code: "liveness_owner_unowned" } : { success: true },
        );
        resume.resolve();
        expect((await first).success).toBe(true);
        if (!releaseFirst) {
          await activityDone.promise;
        }
        expect(manager.getSession(id)?.livenessOwnerToken).toBeUndefined();
        expect(await persistence.getSession(id)).toMatchObject({ liveness_owner_token: null });
        expect(manager.getSession(id)?.lastOwnerHeartbeat).toBe(releaseFirst ? 0 : 4_000);
      } finally {
        resume.resolve();
        ownershipSpy.mockRestore();
        activitySpy.mockRestore();
      }
    },
  );

  test("ownership release refuses a session while its end waits for setup", async () => {
    const resume = Promise.withResolvers<void>();
    const session = manager.getSession(SESSION)!;
    const setup = manager.trackSessionSetup(session, () => resume.promise);
    const write = spyOn(persistence, "recordLivenessOwnership");
    const ending = manager.releaseSession(SESSION, "explicit-release");
    try {
      expect(manager.isAdmittedForAutomation(session)).toBe(false);
      expect(await release()).toMatchObject({ success: false, code: "daemon_session_not_found" });
      expect(write).not.toHaveBeenCalled();
      expect(session.livenessOwnerToken).toBe(OWNER);
    } finally {
      resume.resolve();
      await setup;
      await ending;
      write.mockRestore();
    }
    expect(await release()).toMatchObject({ success: false, code: "daemon_session_not_found" });
  });

  test("session-info reports lapsed after the lease and suspect grace expire", async () => {
    timer.advanceTime(LEASE + SUSPECT_GRACE_MS + 1);
    expect(await request("daemon/sessionInfo")).toMatchObject({
      success: true,
      result: { liveness: { state: "lapsed", remainingMs: 0 } },
    });
  });

  test("explicit release preserves policy, device and deadline, then another proxy claims", async () => {
    const session = manager.getSession(SESSION)!;
    timer.advanceTime(2_000);
    // Tool activity is later than the owner's heartbeat. Release must preserve this clock too.
    await manager.getOrCreateSession(SESSION);
    const before = { ...session };
    expect(await release()).toEqual({
      success: true,
      result: { sessionId: SESSION, alreadyUnowned: false },
    });
    expect(session).toEqual({
      ...before,
      livenessOwnerToken: undefined,
      activityGeneration: before.activityGeneration + 1,
    });
    expect(await persistence.getSession(SESSION)).toMatchObject({ liveness_owner_token: null });
    expect(await request("daemon/sessionInfo")).toMatchObject({
      result: { liveness: { state: "live", remainingMs: LEASE } },
    });
    expect((await claim("proxy-a")).success).toBe(true);
    expect(await claim("proxy-b")).toMatchObject({
      success: false,
      code: "liveness_owner_conflict",
    });
    expect(manager.hasLivenessOwnership(SESSION, "proxy-a")).toBe(true);
    expect(await release()).toMatchObject({ success: false, code: "liveness_owner_not_owner" });
  });

  test("already-unowned release is a successful no-op for any valid token", async () => {
    await manager.createSession("never-owned", DEVICE, "android");
    const before = { ...manager.getSession("never-owned")! };
    expect(
      await request("daemon/releaseLivenessOwnership", {
        sessionId: "never-owned",
        livenessOwnerToken: "any-token",
      }),
    ).toEqual({ success: true, result: { sessionId: "never-owned", alreadyUnowned: true } });
    expect(manager.getSession("never-owned")).toEqual(before);
  });

  test("foreign release is a typed no-op; unknown and malformed calls fail", async () => {
    const before = { ...manager.getSession(SESSION)! };
    const row = await persistence.getSession(SESSION);
    expect(await release("foreign")).toMatchObject({
      success: false,
      code: "liveness_owner_not_owner",
    });
    expect(manager.getSession(SESSION)).toEqual(before);
    expect(await persistence.getSession(SESSION)).toEqual(row);
    expect(
      await request("daemon/releaseLivenessOwnership", {
        sessionId: "unknown",
        livenessOwnerToken: OWNER,
      }),
    ).toMatchObject({ success: false, code: "daemon_session_not_found" });
    for (const token of [undefined, "", "   ", 42]) {
      expect(
        await request("daemon/releaseLivenessOwnership", { livenessOwnerToken: token }),
      ).toMatchObject({
        success: false,
        error: expect.stringContaining("Invalid releaseLivenessOwnership"),
      });
    }
    expect(
      await request("daemon/releaseLivenessOwnership", {
        sessionId: "",
        livenessOwnerToken: OWNER,
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid releaseLivenessOwnership"),
    });
  });

  test("release retries and stale or tokenless ticks cannot change the released session", async () => {
    await release();
    timer.advanceTime(2_000);
    const before = { ...manager.getSession(SESSION)! };
    for (const token of [OWNER, "foreign"]) {
      expect(await release(token)).toEqual({
        success: true,
        result: { sessionId: SESSION, alreadyUnowned: true },
      });
      expect(await tick(token)).toMatchObject({
        success: false,
        code: "liveness_owner_unowned",
        error: expect.stringContaining("is unowned"),
      });
    }
    expect(await request("daemon/heartbeat")).toMatchObject({ success: true });
    expect(manager.getSession(SESSION)).toEqual(before);
    expect((await claim(OWNER)).success).toBe(true);
    expect(manager.hasLivenessOwnership(SESSION, OWNER)).toBe(true);
  });

  test.each(["heartbeat", "cli"])(
    "unclaimed %s session retains its existing expiry window",
    async (policy) => {
      await claim(OWNER, policy);
      const session = manager.getSession(SESSION)!;
      const window = session.heartbeatTimeoutMs + (policy === "heartbeat" ? SUSPECT_GRACE_MS : 0);
      timer.advanceTime(1_000);
      await release();
      timer.advanceTime(window - 1_000);
      await monitor.tick();
      expect(reaped).toEqual([]);
      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([
        { sessionId: SESSION, reason: policy === "cli" ? "cli-idle-timeout" : "heartbeat-timeout" },
      ]);
    },
  );

  test("release retains the later activity-based heartbeat deadline and its suspect grace", async () => {
    // A tool call inside the owner's lease moves the activity heartbeat past the claim.
    timer.advanceTime(LEASE - 2_000);
    await manager.getOrCreateSession(SESSION);
    await release();
    timer.advanceTime(LEASE + SUSPECT_GRACE_MS);
    await monitor.tick();
    expect(reaped).toEqual([]);
    timer.advanceTime(1);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
  });

  test("release retains an awaiting-owner deadline through main's existing path", async () => {
    const session = manager.getSession(SESSION)!;
    session.ownership = "awaiting-owner";
    session.awaitingOwnerSince = timer.now();
    session.hasReceivedHeartbeat = false;
    await release();
    timer.advanceTime(LEASE + SUSPECT_GRACE_MS);
    await monitor.tick();
    expect(reaped).toEqual([]);
    timer.advanceTime(1);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "rehydration-owner-timeout" }]);
  });

  test("a claim restores a released CLI session to heartbeat policy", async () => {
    await claim(OWNER, "cli");
    await release();
    expect((await claim("next")).success).toBe(true);
    expect(manager.getSession(SESSION)?.livenessPolicy).toBe("heartbeat");
    timer.advanceTime(LEASE + SUSPECT_GRACE_MS + 1);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
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
            ? { success: false, code: "liveness_owner_not_owner" }
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
          releaseFirst ? { success: false, code: "liveness_owner_unowned" } : { success: true },
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
      expect(await heartbeat).toMatchObject({ success: false, code: "liveness_owner_unowned" });
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
    spy.mockRestore();
    expect((await release()).success).toBe(true);
  });

  test("a queued release refuses a session removed while waiting for the claim mutex", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const write = persistence.recordLivenessOwnership.bind(persistence);
    const spy = spyOn(persistence, "recordLivenessOwnership").mockImplementation(
      async (...args) => {
        await write(...args);
        entered.resolve();
        await resume.promise;
      },
    );
    try {
      const first = manager.releaseLivenessOwnership(SESSION, OWNER);
      await entered.promise;
      const queued = manager.releaseLivenessOwnership(SESSION, OWNER);
      await manager.releaseSession(SESSION, "explicit-release");
      resume.resolve();
      expect(await first).toBe("released");
      expect(await queued).toBe("not-found");
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
  });

  test("a failed reclaim retains claim history so stale ticks remain refused", async () => {
    await release();
    const spy = spyOn(persistence, "recordLivenessOwnership").mockRejectedValueOnce(
      new Error("claim write failed"),
    );
    try {
      await expect(claim(OWNER)).rejects.toThrow("claim write failed");
      expect(await tick(OWNER)).toMatchObject({ success: false, code: "liveness_owner_unowned" });
      expect(manager.getSession(SESSION)?.livenessOwnerToken).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("an older failed heartbeat cannot roll back activity across release", async () => {
    const entered = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const logged = Promise.withResolvers<void>();
    const activitySpy = spyOn(persistence, "recordActivity").mockImplementation(async () => {
      entered.resolve();
      await failed.promise;
      throw new Error("heartbeat write failed");
    });
    const { logger } = await import("../../src/utils/logger");
    const warning = spyOn(logger, "warn").mockImplementation(() => {
      logged.resolve();
    });
    try {
      timer.advanceTime(4_000);
      await tick(OWNER);
      await entered.promise;
      await release();
      const before = { ...manager.getSession(SESSION)! };
      failed.resolve();
      await logged.promise;
      expect(manager.getSession(SESSION)).toEqual(before);
    } finally {
      failed.resolve();
      activitySpy.mockRestore();
      warning.mockRestore();
    }
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
        code: "liveness_owner_unowned",
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
