import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// A recoverable row's claim (#11200) after #11243: a recovery that fails without terminalizing
// the row hands the claim back.

const SESSION = "s1";
const DEVICE = "emulator-5554";

describe("recoverable-row claim lifecycle (#11243)", () => {
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

  /** A row a dead daemon released as daemon-shutdown: recoverable by any daemon. */
  async function seedRecoverableRow(): Promise<void> {
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
    await repo.markReleased(SESSION, "released", 1_000, "daemon-shutdown");
  }

  function daemon(
    id: string,
    live: () => Set<string>,
    persistence: DeviceSessionRepository = repo,
  ): SessionManager {
    const manager = new SessionManager(timer, persistence);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId(id);
    manager.attachLiveDaemonSessionIds(live);
    return manager;
  }

  function poolFor(manager: SessionManager): SessionDeviceAssigner {
    return {
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
  }

  const failingPool: SessionDeviceAssigner = {
    async assignDeviceToSession(): Promise<string> {
      throw new Error("request cancelled");
    },
  };

  test("a recovery that fails after its claim hands the row back so a live peer recovers it", async () => {
    await seedRecoverableRow();
    const live = () => new Set(["daemon-a", "daemon-b"]);
    const a = daemon("daemon-a", live);
    const b = daemon("daemon-b", live);

    await expect(a.getOrCreateSession(SESSION, failingPool, "android")).rejects.toThrow(
      "request cancelled",
    );
    const afterFailure = await repo.getSession(SESSION);
    expect(afterFailure).toMatchObject({
      status: "released",
      release_reason: "daemon-shutdown",
      daemon_session_id: "dead-daemon",
    });

    const recovered = await b.getOrCreateSession(SESSION, poolFor(b), "android");
    expect(recovered.assignedDevice).toBe(DEVICE);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "active",
      daemon_session_id: "daemon-b",
    });
  });

  test("a platform-mismatch refusal after the claim hands the row back", async () => {
    await seedRecoverableRow();
    const live = () => new Set(["daemon-a", "daemon-b"]);
    const a = daemon("daemon-a", live);
    const b = daemon("daemon-b", live);

    await expect(a.getOrCreateSession(SESSION, poolFor(a), "ios")).rejects.toThrow(
      "does not match persisted platform",
    );

    const summary = await b.rehydratePersistedSessions(poolFor(b));
    expect(summary.rehydrated).toEqual([SESSION]);
  });

  test("a peer that took the row first is still refused", async () => {
    await seedRecoverableRow();
    const live = () => new Set(["daemon-a", "daemon-b"]);
    const row = (await repo.getSession(SESSION))!;
    await repo.claimRecoverableSession(
      SESSION,
      { rowGeneration: row.stable_identity_generation ?? 0, daemonSessionId: "dead-daemon" },
      "daemon-b",
    );
    const a = daemon("daemon-a", live);

    await expect(a.getOrCreateSession(SESSION, poolFor(a), "android")).rejects.toBeInstanceOf(
      DeviceOwnedByOtherDaemonError,
    );
    expect((await repo.getSession(SESSION))?.daemon_session_id).toBe("daemon-b");
  });
});
