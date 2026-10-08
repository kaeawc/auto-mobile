import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

describe("liveness handoff through the real repository without a schema change", () => {
  let db: Kysely<Database>;
  let repo: DeviceSessionRepository;
  let timer: FakeTimer;
  let manager: SessionManager;

  function state(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
  }

  async function rehydrate() {
    await repo.markReleased("handoff", "expired", timer.now(), "daemon-restart");
    manager.stopCleanupTimer();
    timer.advanceTime(1_000);
    manager = new SessionManager(timer, repo, () => new FakeDbWriteBarrier());
    expect(
      await manager.rehydratePersistedSessions({
        assignDeviceToSession: async (id, _platform, target) => {
          await manager.createSession(
            id,
            "emulator-5554",
            "android",
            target?.liveness?.sessionTimeoutMs,
            target?.liveness?.heartbeatTimeoutMs,
            target?.stableDeviceId,
            target?.liveness,
            target?.initialOwnership,
          );
          return "emulator-5554";
        },
      }),
    ).toMatchObject({ rehydrated: ["handoff"], skipped: [] });
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    db = await createTestDatabase();
    repo = new DeviceSessionRepository(db, timer);
    manager = new SessionManager(timer, repo, () => new FakeDbWriteBarrier());
    await manager.createSession("handoff", "emulator-5554", "android", 60_000, undefined, "Pixel");
    await manager.claimLivenessOwnership("handoff", "owner");
  });
  afterEach(async () => {
    manager.stopCleanupTimer();
    await db.destroy();
  });

  test.each(["heartbeat", "cli"])(
    "released %s row remains unowned across two rehydrations",
    async (policy) => {
      if (policy === "cli") {
        manager.adoptCliLivenessPolicy("handoff", 60_000);
      }
      expect(await manager.releaseLivenessOwnership("handoff", "owner")).toBe("released");
      expect(await repo.getSession("handoff")).toMatchObject({ liveness_owner_token: null });
      for (let restart = 0; restart < 2; restart++) {
        await rehydrate();
        timer.advanceTime(500);
        const beforeHeartbeat = manager.getSession("handoff")!.lastHeartbeat;
        const lastToolActivity = manager.getSession("handoff")!.lastUsedAt;
        expect(
          await handleDaemonRequest(
            {
              id: "tick",
              type: "daemon_request",
              method: "daemon/heartbeat",
              params: {
                sessionId: "handoff",
                livenessOwnerKind: "cli-keeper",
                livenessPolicy: policy,
              },
            },
            state(),
          ),
        ).toMatchObject({ success: true });
        // A tokenless legacy heartbeat still refreshes the liveness clocks after
        // restart, but never the tool-activity clock (#10656).
        expect(timer.now()).toBeGreaterThan(beforeHeartbeat);
        expect(manager.getSession("handoff")).toMatchObject({
          lastHeartbeat: timer.now(),
          lastOwnerHeartbeat: timer.now(),
          hasReceivedHeartbeat: true,
        });
        expect(manager.getSession("handoff")?.livenessOwnerToken).toBeUndefined();
        expect(manager.getSession("handoff")?.lastUsedAt).toBe(lastToolActivity);
        expect(await repo.getSession("handoff")).toMatchObject({
          last_used_at_ms: lastToolActivity,
          has_received_heartbeat: 1,
          liveness_owner_token: null,
        });
      }
      expect(await manager.claimLivenessOwnership("handoff", "new-proxy")).toBe("claimed");
      expect((await repo.getSession("handoff"))?.liveness_owner_token).toBe("new-proxy");
    },
  );

  test.each(["heartbeat", "cli"])(
    "a former-owner keeper tick re-adopts a released %s row after restart",
    async (policy) => {
      if (policy === "cli") {
        manager.adoptCliLivenessPolicy("handoff", 60_000);
      }
      expect(await manager.releaseLivenessOwnership("handoff", "owner")).toBe("released");
      await rehydrate();
      expect(manager.getSession("handoff")?.livenessOwnerToken).toBeUndefined();
      expect(manager.getSession("handoff")?.livenessOwnershipClaims?.size ?? 0).toBe(0);
      expect(await repo.getSession("handoff")).toMatchObject({ liveness_owner_token: null });
      timer.advanceTime(500);
      expect(
        await handleDaemonRequest(
          {
            id: "former-owner-tick",
            type: "daemon_request",
            method: "daemon/heartbeat",
            params: {
              sessionId: "handoff",
              livenessOwnerToken: "owner",
              livenessOwnerKind: "cli-keeper",
              livenessPolicy: policy,
            },
          },
          state(),
        ),
      ).toMatchObject({ success: true });
      expect(manager.hasLivenessOwnership("handoff", "owner")).toBe(true);
      expect(manager.getSession("handoff")).toMatchObject({
        lastHeartbeat: timer.now(),
        lastOwnerHeartbeat: timer.now(),
        ownership: "owned",
      });
    },
  );

  test("foreign release changes neither the real row nor in-memory session", async () => {
    const row = await repo.getSession("handoff");
    const session = { ...manager.getSession("handoff")! };
    expect(await manager.releaseLivenessOwnership("handoff", "foreign")).toBe("not-owner");
    expect(await repo.getSession("handoff")).toEqual(row);
    expect(manager.getSession("handoff")).toEqual(session);
  });

  test("ownership release returns not-found when the real row ends during its write", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const write = repo.recordLivenessOwnership.bind(repo);
    const spy = spyOn(repo, "recordLivenessOwnership").mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      await write(...args);
    });
    try {
      const releasing = handleDaemonRequest(
        {
          id: "release",
          type: "daemon_request",
          method: "daemon/releaseLivenessOwnership",
          params: { sessionId: "handoff", livenessOwnerToken: "owner" },
        },
        state(),
      );
      const result = releasing.then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      expect(await manager.releaseSession("handoff", "explicit-release")).toBe("emulator-5554");
      expect(await repo.getSession("handoff")).toMatchObject({ status: "released" });
      resume.resolve();
      expect(await result).toMatchObject({
        response: { success: false, code: "daemon_session_not_found" },
      });
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
  });
});
