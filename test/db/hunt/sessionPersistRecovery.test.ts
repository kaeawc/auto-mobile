import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../../src/db/deviceSessionRepository";
import type { Database } from "../../../src/db/types";
import { createTestDatabase } from "../testDbHelper";
import { FakeTimer } from "../../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";

describe("session persistence hunt: recovery vs release reasons", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: DeviceSessionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    repo = new DeviceSessionRepository(db, timer);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedRow(): Promise<void> {
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      daemonSessionId: "dead-daemon",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: 10_000_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
  }

  function daemon(): { manager: SessionManager; pool: SessionDeviceAssigner } {
    const manager = new SessionManager(timer, repo);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-new");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-new"]));
    const pool: SessionDeviceAssigner = {
      async assignDeviceToSession(id, _platform, target): Promise<string> {
        const session = await manager.createSession(
          id,
          DEVICE,
          "android",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          target?.stableDeviceId,
          target?.liveness,
          target?.initialOwnership,
        );
        return session.assignedDevice;
      },
    };
    return { manager, pool };
  }

  // The recoverable SQL filter (listRecoverableSessions) excludes non-recoverable reasons, but the
  // on-demand admission (`isRecoverablePersistedSession`) only excludes terminal ones, so the two
  // surfaces disagree about the same row.
  for (const reason of ["plan-auto-release", "superseded", "allocation-rollback"] as const) {
    test(`a ${reason} row is not revived by naming its UUID, as startup rehydration would not`, async () => {
      await seedRow();
      await repo.markReleased(SESSION, "released", 2_000, reason);
      const { manager, pool } = daemon();

      const listed = await repo.listRecoverableSessions(2_000);
      expect(listed.map((row) => row.session_uuid)).toEqual([]);

      const outcome = await manager
        .getOrCreateSession(SESSION, pool, "android", undefined, true)
        .then(
          () => "recovered",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );

      // Naming a never-recoverable row is "not an issued session", not a recovery that "changed".
      expect(outcome).toContain("not an active daemon session");
      expect(manager.getSession(SESSION)).toBeNull();
      // And the refusal must not have claimed the row for this daemon.
      expect((await repo.getSession(SESSION))?.daemon_session_id).toBe("dead-daemon");
    });
  }

  test("the expired-row sweep does not overwrite a terminal release that lands after its select", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 1_500, "daemon-shutdown");
    // The row is past its lease; a peer's explicit release lands between the sweep's select and
    // its markReleased. A release does not advance the row generation, so the sweep's precondition
    // still matches.
    class RacingRepository extends DeviceSessionRepository {
      override async markReleased(
        ...args: Parameters<DeviceSessionRepository["markReleased"]>
      ): Promise<void> {
        if (args[3] === "expired") {
          await super.markReleased(SESSION, "released", 2_000, "explicit-release");
        }
        return await super.markReleased(...args);
      }
    }
    const racing = new RacingRepository(db, timer);

    await racing.listRecoverableSessions(20_000_000);

    expect(await repo.getSession(SESSION)).toMatchObject({
      release_reason: "explicit-release",
    });
  });
});
