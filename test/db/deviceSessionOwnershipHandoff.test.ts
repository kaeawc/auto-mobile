import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { SessionManager } from "../../src/daemon/sessionManager";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

describe("liveness handoff through the real repository without a schema change", () => {
  let db: Kysely<Database>;
  let repo: DeviceSessionRepository;
  let timer: FakeTimer;
  let manager: SessionManager;

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
        const state = {
          isInitialized: () => true,
          getSessionManager: () => manager,
          getDevicePool: () => ({
            refreshDevices: async () => 0,
            getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
            releaseDevice: async () => {},
          }),
          getDeviceSessionRegistry: () => ({ list: () => [] }),
        };
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
            state,
          ),
        ).toMatchObject({ success: true });
        expect(manager.getSession("handoff")?.livenessOwnerToken).toBeUndefined();
        expect((await repo.getSession("handoff"))?.liveness_owner_token).toBeNull();
      }
      expect(await manager.claimLivenessOwnership("handoff", "new-proxy")).toBe("claimed");
      expect((await repo.getSession("handoff"))?.liveness_owner_token).toBe("new-proxy");
    },
  );

  test("foreign release changes neither the real row nor in-memory session", async () => {
    const row = await repo.getSession("handoff");
    const session = { ...manager.getSession("handoff")! };
    expect(await manager.releaseLivenessOwnership("handoff", "foreign")).toBe("not-owner");
    expect(await repo.getSession("handoff")).toEqual(row);
    expect(manager.getSession("handoff")).toEqual(session);
  });
});
