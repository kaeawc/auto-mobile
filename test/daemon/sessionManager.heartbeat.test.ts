import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { describe, expect, test, spyOn } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import {
  SessionManager,
  getDefaultSessionHeartbeatTimeoutMs,
  SessionActivityPersistenceError,
} from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { DeviceSessionNotActiveError } from "../../src/db/deviceSessionRepository";
import {
  createAwaitingOwnerSession,
  installSessionManagerFixture,
  makeReapingMonitor,
  makeSessionManager,
  stubbedPersistence,
} from "../helpers/sessionManagerSuite";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    sessionManager = fixture.manager;
    fakeTimer = fixture.timer;
  });

  describe("recordHeartbeat", () => {
    test("releases a heartbeating session exactly at its idle deadline, with no suspect grace (#11107)", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android", 5000);
      fakeTimer.advanceTime(4000);

      // A heartbeat does not extend the idle deadline (#10656), and the suspect grace (#10051)
      // belongs to the heartbeat lease only: idleness releases exactly at the deadline.
      sessionManager.recordHeartbeat("session-1");
      fakeTimer.advanceTime(1000);
      expect(sessionManager.getSession("session-1")).not.toBeNull();

      fakeTimer.advanceTime(1);
      expect(sessionManager.getSession("session-1")).toBeNull();
    });
  });

  describe("durable heartbeat ownership rollback", () => {
    test("a heartbeat after the first one writes nothing and renews the lease (#11079)", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      const write = spyOn(persistence, "recordActivity");
      try {
        const session = await manager.createSession(
          "received-heartbeat",
          "emulator-5554",
          "android",
        );
        fakeTimer.advanceTime(10);
        manager.recordHeartbeat(session.sessionId);
        await drainMicrotasks(10);
        const before = {
          lastUsedAt: session.lastUsedAt,
          lastHeartbeat: session.lastHeartbeat,
          expiresAt: session.expiresAt,
          hasReceivedHeartbeat: true,
          ownership: "owned",
        };
        const stored = { ...(await persistence.getSession!(session.sessionId)) };
        write.mockImplementationOnce(async () => {
          throw new Error("one activity write failed");
        });
        fakeTimer.advanceTime(10);
        manager.recordHeartbeat(session.sessionId);
        await drainMicrotasks(10);
        // No persisted field changed, so the failing write is never reached.
        expect(write).toHaveBeenCalledTimes(1);
        expect(session).toMatchObject({ ...before, lastHeartbeat: before.lastHeartbeat + 10 });
        expect(await persistence.getSession!(session.sessionId)).toEqual(stored);
      } finally {
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });

    test("a failed heartbeat write keeps the acknowledged liveness and the next heartbeat stores it (#11079)", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      const write = spyOn(persistence, "recordActivity");
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      try {
        const session = await createAwaitingOwnerSession(manager, "kept-owner");
        const storedBefore = { ...(await persistence.getSession!(session.sessionId)) };
        write.mockImplementationOnce(async () => {
          throw new Error("one activity write failed");
        });
        fakeTimer.advanceTime(10);
        manager.recordHeartbeat(session.sessionId);
        await drainMicrotasks(10);
        expect(write).toHaveBeenCalledTimes(1);
        expect(await persistence.getSession!(session.sessionId)).toEqual(storedBefore);
        const acknowledged = {
          lastUsedAt: 0,
          expiresAt: 60_000,
          lastHeartbeat: 10,
          hasReceivedHeartbeat: true,
          ownership: "owned",
          awaitingOwnerSince: undefined,
        };
        expect(session).toMatchObject(acknowledged);

        fakeTimer.advanceTime(10);
        manager.recordHeartbeat(session.sessionId);
        await drainMicrotasks(10);
        expect(write).toHaveBeenCalledTimes(2);
        expect(session).toMatchObject({ ...acknowledged, lastHeartbeat: 20 });
        expect(await persistence.getSession!(session.sessionId)).toMatchObject({
          last_used_at_ms: 0,
          expires_at_ms: 60_000,
          has_received_heartbeat: 1,
        });
      } finally {
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });

    test("reclaim restores all liveness fields after one failed write and allows a successful retry", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      const write = spyOn(persistence, "recordActivity");
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      try {
        const session = await createAwaitingOwnerSession(manager, "rollback-owner");
        const before = {
          lastUsedAt: session.lastUsedAt,
          lastHeartbeat: session.lastHeartbeat,
          expiresAt: session.expiresAt,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          ownership: session.ownership,
          awaitingOwnerSince: session.awaitingOwnerSince,
        };
        const storedBefore = { ...(await persistence.getSession!(session.sessionId)) };
        write.mockImplementationOnce(async () => {
          throw new Error("one activity write failed");
        });
        fakeTimer.advanceTime(10);
        await expect(manager.getOrCreateSession(session.sessionId)).rejects.toBeInstanceOf(
          SessionActivityPersistenceError,
        );
        expect(write).toHaveBeenCalledTimes(1);
        expect(await persistence.getSession!(session.sessionId)).toEqual(storedBefore);
        expect(session).toMatchObject(before);
        expect(session.activityGeneration).toBe(1);

        fakeTimer.advanceTime(10);
        await expect(manager.getOrCreateSession(session.sessionId)).resolves.toBe(session);
        expect(write).toHaveBeenCalledTimes(2);
        // A reclaim is tool activity (#10656).
        const activity = { lastUsedAt: 20, expiresAt: 60_020 };
        expect(session).toMatchObject({
          ...activity,
          lastHeartbeat: 20,
          hasReceivedHeartbeat: false,
          ownership: "owned",
          awaitingOwnerSince: undefined,
          activityGeneration: 2,
        });
        expect(await persistence.getSession!(session.sessionId)).toMatchObject({
          last_used_at_ms: activity.lastUsedAt,
          expires_at_ms: activity.expiresAt,
          has_received_heartbeat: 0,
        });
      } finally {
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });

    test("a failed first-heartbeat write does not expire under missing-first-heartbeat grace (#11079)", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      const write = spyOn(persistence, "recordActivity");
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      try {
        const session = await manager.createSession(
          "first-heartbeat",
          "emulator-5554",
          "android",
          60_000,
        );
        write.mockImplementationOnce(async () => {
          throw new Error("one activity write failed");
        });
        fakeTimer.advanceTime(10);
        manager.recordHeartbeat(session.sessionId);
        await drainMicrotasks(10);
        const { monitor, reaped } = makeReapingMonitor(manager, fakeTimer, 500);
        fakeTimer.advanceTime(491);
        await monitor.tick();
        // The heartbeat arrived and was acknowledged; only its row is unstored.
        expect(reaped).toEqual([]);
        expect(session).toMatchObject({
          lastHeartbeat: 10,
          hasReceivedHeartbeat: true,
          ownership: "owned",
        });
        expect(session.awaitingOwnerSince).toBeUndefined();
        expect(await persistence.getSession!(session.sessionId)).toMatchObject({
          has_received_heartbeat: 0,
        });
      } finally {
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });

    test("failed reclaim still expires under awaiting-owner timeout", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      const write = spyOn(persistence, "recordActivity");
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      try {
        const session = await createAwaitingOwnerSession(manager, "awaiting-heartbeat");
        write.mockImplementationOnce(async () => {
          throw new Error("one activity write failed");
        });
        fakeTimer.advanceTime(10);
        await expect(manager.getOrCreateSession(session.sessionId)).rejects.toBeInstanceOf(
          SessionActivityPersistenceError,
        );
        const reaped: string[] = [];
        const monitor = new SessionHeartbeatMonitor(
          manager,
          () => false,
          async (_id, reason) => {
            reaped.push(reason);
          },
          fakeTimer,
          { graceMs: 20_000 },
        );
        fakeTimer.advanceTime(991 + SUSPECT_GRACE_MS);
        await monitor.tick();
        expect(reaped).toEqual(["rehydration-owner-timeout"]);
      } finally {
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });

    test.each(["heartbeat", "reclaim"] as const)(
      "successful %s preserves the current ownership and persistence contract",
      async (operation) => {
        const persistence = new FakeDeviceSessionPersistence();
        const write = spyOn(persistence, "recordActivity");
        const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
        try {
          const session = await createAwaitingOwnerSession(manager, "success-owner");
          fakeTimer.advanceTime(10);
          if (operation === "heartbeat") {
            manager.recordHeartbeat(session.sessionId);
            await drainMicrotasks(10);
          } else {
            await manager.getOrCreateSession(session.sessionId);
          }
          // A heartbeat proves liveness only; a reclaim is tool activity (#10656).
          const activity =
            operation === "heartbeat"
              ? { lastUsedAt: 0, expiresAt: 60_000 }
              : { lastUsedAt: 10, expiresAt: 60_010 };
          expect(session).toMatchObject({
            ...activity,
            lastHeartbeat: 10,
            hasReceivedHeartbeat: operation === "heartbeat",
            ownership: "owned",
            awaitingOwnerSince: undefined,
            activityGeneration: 1,
          });
          expect(await persistence.getSession!(session.sessionId)).toMatchObject({
            last_used_at_ms: activity.lastUsedAt,
            expires_at_ms: activity.expiresAt,
            has_received_heartbeat: operation === "heartbeat" ? 1 : 0,
          });
        } finally {
          write.mockRestore();
          manager.stopCleanupTimer();
        }
      },
    );

    test("older failed reclaim cannot revert a newer heartbeat still in flight", async () => {
      const firstStarted = Promise.withResolvers<void>();
      const failFirst = Promise.withResolvers<void>();
      const secondStarted = Promise.withResolvers<void>();
      const finishSecond = Promise.withResolvers<void>();
      const persistence = new FakeDeviceSessionPersistence();
      const recordActivity = persistence.recordActivity.bind(persistence);
      const write = spyOn(persistence, "recordActivity");
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      try {
        const session = await createAwaitingOwnerSession(manager, "pending-owner");
        write
          .mockImplementationOnce(async () => {
            firstStarted.resolve();
            await failFirst.promise;
            throw new Error("older activity write failed");
          })
          .mockImplementationOnce(async (sessionId, update) => {
            secondStarted.resolve();
            await finishSecond.promise;
            await recordActivity(sessionId, update);
          });
        fakeTimer.advanceTime(10);
        const firstRefresh = manager.getOrCreateSession(session.sessionId);
        await firstStarted.promise;
        fakeTimer.advanceTime(10);
        manager.recordHeartbeat(session.sessionId);
        await secondStarted.promise;
        failFirst.resolve();
        await expect(firstRefresh).rejects.toBeInstanceOf(SessionActivityPersistenceError);
        await drainMicrotasks(10);
        // The older reclaim was tool activity; its in-memory refresh is not reverted because a
        // newer write superseded it. Heartbeats never move the idle clocks (#10656).
        const activity = { lastUsedAt: 10, expiresAt: 60_010 };
        const latest = {
          ...activity,
          lastHeartbeat: 20,
          hasReceivedHeartbeat: true,
          ownership: "owned",
          awaitingOwnerSince: undefined,
          activityGeneration: 2,
        };
        expect(session).toMatchObject(latest);
        expect(await persistence.getSession!(session.sessionId)).toMatchObject({
          last_used_at_ms: 0,
          has_received_heartbeat: 0,
        });
        finishSecond.resolve();
        await drainMicrotasks(10);
        expect(session).toMatchObject(latest);
        expect(await persistence.getSession!(session.sessionId)).toMatchObject({
          last_used_at_ms: activity.lastUsedAt,
          has_received_heartbeat: 1,
        });
      } finally {
        failFirst.resolve();
        finishSecond.resolve();
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });

    test.each([
      ["heartbeat", "heartbeat"],
      ["reclaim", "reclaim"],
      ["heartbeat", "reclaim"],
      ["reclaim", "heartbeat"],
    ] as const)("older failed %s cannot revert a newer successful %s", async (older, newer) => {
      const firstStarted = Promise.withResolvers<void>();
      const failFirst = Promise.withResolvers<void>();
      const persistence = new FakeDeviceSessionPersistence();
      const write = spyOn(persistence, "recordActivity");
      const manager = makeSessionManager({ timer: fakeTimer, persistence, fakeBarrier: true });
      try {
        const session = await createAwaitingOwnerSession(manager, "overlapping-owner");
        write.mockImplementationOnce(async () => {
          firstStarted.resolve();
          await failFirst.promise;
          throw new Error("older activity write failed");
        });
        fakeTimer.advanceTime(10);
        let firstRefresh: ReturnType<SessionManager["getOrCreateSession"]> | undefined;
        if (older === "heartbeat") {
          manager.recordHeartbeat(session.sessionId);
        } else {
          firstRefresh = manager.getOrCreateSession(session.sessionId);
        }
        await firstStarted.promise;
        fakeTimer.advanceTime(10);
        if (newer === "heartbeat") {
          manager.recordHeartbeat(session.sessionId);
          await drainMicrotasks(10);
        } else {
          await manager.getOrCreateSession(session.sessionId);
        }
        // The idle clocks follow the latest tool activity (a reclaim); heartbeats never move
        // them (#10656). A superseded older reclaim keeps its in-memory refresh.
        const activity =
          newer === "reclaim"
            ? { lastUsedAt: 20, expiresAt: 60_020 }
            : older === "reclaim"
              ? { lastUsedAt: 10, expiresAt: 60_010 }
              : { lastUsedAt: 0, expiresAt: 60_000 };
        const latest = {
          ...activity,
          lastHeartbeat: 20,
          hasReceivedHeartbeat: older === "heartbeat" || newer === "heartbeat",
          ownership: "owned",
          awaitingOwnerSince: undefined,
          activityGeneration: 2,
        };
        expect(session).toMatchObject(latest);
        const stored = { ...(await persistence.getSession!(session.sessionId)) };
        failFirst.resolve();
        if (firstRefresh) {
          await expect(firstRefresh).rejects.toBeInstanceOf(SessionActivityPersistenceError);
        }
        await drainMicrotasks(10);
        expect(session).toMatchObject(latest);
        expect(await persistence.getSession!(session.sessionId)).toEqual(stored);
      } finally {
        failFirst.resolve();
        write.mockRestore();
        manager.stopCleanupTimer();
      }
    });
  });

  // Cache updates and reads record no activity (#10703), so only the heartbeat write remains.
  test.each(["heartbeat"] as const)(
    "keeps the acknowledged lease when a fire-and-forget %s write fails (#11079)",
    async (operation) => {
      const timer = new FakeTimer();
      const writeStarted = Promise.withResolvers<void>();
      const persistence: DeviceSessionPersistence = stubbedPersistence({
        async upsertActiveSession() {},
        async recordActivity() {
          writeStarted.resolve();
          throw new Error("activity write failed");
        },
        async markReleased() {},
      });
      const manager = makeSessionManager({ timer, persistence, fakeBarrier: true });

      const session = await manager.createSession("activity-session", "emulator-5554", "android");
      const before = {
        lastUsedAt: session.lastUsedAt,
        lastHeartbeat: session.lastHeartbeat,
        expiresAt: session.expiresAt,
      };
      if (operation === "heartbeat") {
        session.ownership = "awaiting-owner";
      }
      timer.advanceTime(10);
      if (operation === "heartbeat") {
        manager.recordHeartbeat("activity-session");
      }
      await writeStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Liveness only: the idle clocks are untouched and the lease keeps the heartbeat.
      expect(session).toMatchObject({ ...before, lastHeartbeat: before.lastHeartbeat + 10 });
      if (operation === "heartbeat") {
        expect(session.hasReceivedHeartbeat).toBe(true);
        expect(session.ownership).toBe("owned");
      }
    },
  );

  test("acknowledges a liveness ownership claim only after durable persistence", async () => {
    const persistenceStarted = Promise.withResolvers<void>();
    const finishPersistence = Promise.withResolvers<void>();
    const manager = makeSessionManager({
      timer: fakeTimer,
      persistence: stubbedPersistence({
        async upsertActiveSession() {},
        async recordActivity() {},
        async recordLivenessOwnership() {
          persistenceStarted.resolve();
          await finishPersistence.promise;
        },
        async markReleased() {},
      }),
    });
    try {
      await manager.createSession("session-1", "emulator-5554", "android");
      let acknowledged = false;
      const claim = manager.claimLivenessOwnership("session-1", "owner-token").then((result) => {
        acknowledged = true;
        return result;
      });
      await persistenceStarted.promise;

      expect(acknowledged).toBe(false);
      finishPersistence.resolve();

      await expect(claim).resolves.toBe("claimed");
      expect(manager.hasLivenessOwnership("session-1", "owner-token")).toBe(true);
    } finally {
      finishPersistence.resolve();
      manager.stopCleanupTimer();
    }
  });

  // A claim heartbeat racing the session's own release: the release terminalizes the row while
  // the claim's ownership write is in flight, so the write matches no active row. The claim
  // reports the session as gone instead of surfacing the row write's failure.
  test("a claim whose ownership write loses to the session's release reports not-found", async () => {
    let release: Promise<unknown> | undefined;
    const manager: SessionManager = makeSessionManager({
      timer: fakeTimer,
      persistence: stubbedPersistence({
        async upsertActiveSession() {},
        async recordActivity() {},
        async recordLivenessOwnership(sessionUuid) {
          release = manager.releaseSession(sessionUuid, "explicit-release");
          throw new DeviceSessionNotActiveError(sessionUuid);
        },
        async markReleased() {},
      }),
    });

    await manager.createSession("session-1", "emulator-5554", "android");

    await expect(manager.claimLivenessOwnership("session-1", "owner-token")).resolves.toBe(
      "not-found",
    );
    await release;
    expect(manager.getSession("session-1")).toBeNull();
  });

  test("rejects a foreign claim on a live owner without persisting or touching deadlines", async () => {
    const persistedTokens: Array<string | null> = [];
    const manager = makeSessionManager({
      timer: fakeTimer,
      persistence: stubbedPersistence({
        async upsertActiveSession() {},
        async recordActivity() {},
        async recordLivenessOwnership(_sessionUuid, ownerToken) {
          persistedTokens.push(ownerToken);
        },
        async markReleased() {},
      }),
    });

    await manager.createSession("session-1", "emulator-5554", "android");
    await expect(manager.claimLivenessOwnership("session-1", "owner-a")).resolves.toBe("claimed");
    manager.recordHeartbeat("session-1");
    const owned = manager.getSession("session-1")!;
    const before = {
      lastUsedAt: owned.lastUsedAt,
      lastHeartbeat: owned.lastHeartbeat,
      expiresAt: owned.expiresAt,
      heartbeatTimeoutMs: owned.heartbeatTimeoutMs,
      livenessPolicy: owned.livenessPolicy,
    };
    fakeTimer.advanceTime(owned.heartbeatTimeoutMs);

    await expect(manager.claimLivenessOwnership("session-1", "owner-b")).resolves.toBe("conflict");

    expect(manager.hasLivenessOwnership("session-1", "owner-a")).toBe(true);
    expect(manager.hasLivenessOwnership("session-1", "owner-b")).toBe(false);
    expect(manager.getSession("session-1")).toMatchObject(before);
    expect(persistedTokens).toEqual(["owner-a"]);

    // The suspect grace window (#10051) still holds the session for owner-a.
    fakeTimer.advanceTime(1);
    await expect(manager.claimLivenessOwnership("session-1", "owner-b")).resolves.toBe("conflict");
    expect(persistedTokens).toEqual(["owner-a"]);

    // The rejection is not remembered: owner-b can claim once the grace window ends.
    fakeTimer.advanceTime(SUSPECT_GRACE_MS);
    await expect(manager.claimLivenessOwnership("session-1", "owner-b")).resolves.toBe("claimed");
    expect(persistedTokens).toEqual(["owner-a", "owner-b"]);
    await expect(manager.claimLivenessOwnership("session-1", "owner-a")).resolves.toBe(
      "superseded",
    );
    expect(persistedTokens).toEqual(["owner-a", "owner-b"]);
  });

  test("serializes concurrent ownership claims so a failed older write cannot roll back its successor", async () => {
    const firstPersistenceStarted = Promise.withResolvers<void>();
    const finishFirstPersistence = Promise.withResolvers<void>();
    const persistedTokens: string[] = [];
    const manager = makeSessionManager({
      timer: fakeTimer,
      persistence: stubbedPersistence({
        async upsertActiveSession() {},
        async recordActivity() {},
        async recordLivenessOwnership(_sessionUuid, ownerToken) {
          if (ownerToken === "owner-a") {
            firstPersistenceStarted.resolve();
            await finishFirstPersistence.promise;
            throw new Error("owner-a persistence failed");
          }
          if (ownerToken) {
            persistedTokens.push(ownerToken);
          }
        },
        async markReleased() {},
      }),
    });
    try {
      const session = await manager.createSession("session-1", "emulator-5554", "android");
      session.livenessOwnerToken = "original-owner";
      // The original owner's lease must lapse or owner-a's claim is rejected (#10050).
      fakeTimer.advanceTime(getDefaultSessionHeartbeatTimeoutMs() + 1);
      const firstClaim = manager.claimLivenessOwnership("session-1", "owner-a");
      await firstPersistenceStarted.promise;
      let secondSettled = false;
      const secondClaim = manager.claimLivenessOwnership("session-1", "owner-b").finally(() => {
        secondSettled = true;
      });
      await Promise.resolve();

      expect(secondSettled).toBe(false);
      finishFirstPersistence.resolve();

      await expect(firstClaim).rejects.toThrow("owner-a persistence failed");
      await expect(secondClaim).resolves.toBe("claimed");
      expect(manager.hasLivenessOwnership("session-1", "owner-b")).toBe(true);
      expect(persistedTokens).toEqual(["owner-b"]);
    } finally {
      finishFirstPersistence.resolve();
      manager.stopCleanupTimer();
    }
  });
});
