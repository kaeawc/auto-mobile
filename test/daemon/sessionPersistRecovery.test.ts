import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  PLAN_AUTO_RELEASE_REASON,
  SessionManager,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { DeviceSessionRowChangedError } from "../../src/db/deviceSessionRepository";
import { ActionableError } from "../../src/models/ActionableError";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// A call naming a UUID may issue it again for the recoverable handoffs and for `plan-auto-release`
// (#11418): the list, startup rehydration and the claim's category are separate, and the claim,
// its hand-back, the claimed-row upsert and the admission all use the re-issuable one.

const SESSION = "s1";
const DEVICE = "emulator-5554";

describe("session persistence: by-name re-issue of released rows (#11418)", () => {
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

  function daemon(assign?: () => Promise<void>): {
    manager: SessionManager;
    pool: SessionDeviceAssigner;
  } {
    const manager = new SessionManager(timer, repo);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-new");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-new"]));
    const pool: SessionDeviceAssigner = {
      async assignDeviceToSession(id, _platform, target): Promise<string> {
        await assign?.();
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

  for (const reason of ["superseded", "allocation-rollback"] as const) {
    test(`a ${reason} row is refused up front and left untouched`, async () => {
      await seedRow();
      await repo.markReleased(SESSION, "released", 2_000, reason);
      const before = await repo.getSession(SESSION);
      const { manager, pool } = daemon();

      const outcome = await manager
        .getOrCreateSession(SESSION, pool, "android", undefined, true)
        .then(
          () => "recovered",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );

      expect(outcome).toContain("not an active daemon session");
      expect(manager.getSession(SESSION)).toBeNull();
      expect(await repo.getSession(SESSION)).toEqual(before!);
    });
  }

  test("naming a plan-auto-release UUID issues the session again on the real repository", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 2_000, PLAN_AUTO_RELEASE_REASON);
    const { manager, pool } = daemon();

    const session = await manager.getOrCreateSession(SESSION, pool, "android", undefined, true);

    expect(session.assignedDevice).toBe(DEVICE);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      daemon_session_id: "daemon-new",
    });
  });

  test("two plans back to back under one UUID both run", async () => {
    const { manager, pool } = daemon();
    await manager.createSession(SESSION, DEVICE, "android", undefined, undefined, "Pixel_8_API_35");

    for (let plan = 0; plan < 3; plan++) {
      await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
      expect(await repo.getSession(SESSION)).toMatchObject({
        release_reason: PLAN_AUTO_RELEASE_REASON,
      });

      await manager.getOrCreateSession(SESSION, pool, "android", undefined, true);
      expect(await repo.getSession(SESSION)).toMatchObject({ status: "active" });
    }
  });

  test("a device taken between the plans surfaces the pool's typed refusal and hands the claim back", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 2_000, PLAN_AUTO_RELEASE_REASON);
    const busy = new ActionableError("Device emulator-5554 is in use by another session.");
    const { manager, pool } = daemon(async () => {
      throw busy;
    });
    const before = await repo.getSession(SESSION);

    const error = await manager.getOrCreateSession(SESSION, pool, "android", undefined, true).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBe(busy);
    expect(error).not.toBeInstanceOf(DeviceSessionRowChangedError);
    const after = await repo.getSession(SESSION);
    expect(after).toMatchObject({
      release_reason: PLAN_AUTO_RELEASE_REASON,
      status: before?.status,
      daemon_session_id: before?.daemon_session_id,
    });
  });

  test("a restart between the plans does not rehydrate the plan-auto-release row", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 2_000, PLAN_AUTO_RELEASE_REASON);
    const { manager, pool } = daemon();

    const summary = await manager.rehydratePersistedSessions(pool);

    expect(summary.rehydrated).toEqual([]);
    expect(manager.getSession(SESSION)).toBeNull();
    expect((await repo.listRecoverableSessions(2_000)).map((row) => row.session_uuid)).toEqual([]);
    // The UUID is still issuable by name afterwards.
    await manager.getOrCreateSession(SESSION, pool, "android", undefined, true);
    expect(manager.getSession(SESSION)).not.toBeNull();
  });

  test("re-issuing does not let a weaker reason replace a terminal release", async () => {
    const { manager } = daemon();
    await manager.createSession(SESSION, DEVICE, "android", undefined, undefined, "Pixel_8_API_35");
    await manager.releaseSession(SESSION, "explicit-release");

    await repo.markReleased(SESSION, "released", 3_000, PLAN_AUTO_RELEASE_REASON);

    expect((await repo.getSession(SESSION))?.release_reason).toBe("explicit-release");
  });
});
