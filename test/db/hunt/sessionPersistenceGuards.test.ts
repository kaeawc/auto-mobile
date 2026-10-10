import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import {
  DeviceSessionRepository,
  deviceRestartReleaseReason,
} from "../../../src/db/deviceSessionRepository";
import type { Database } from "../../../src/db/types";
import { createTestDatabase } from "../testDbHelper";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";
const STABLE_DEVICE = "Pixel_8_API_35";
const IDLE_WINDOW_MS = 60_000;

/**
 * Two daemons share one `device_sessions` table. `peer` is the other daemon's repository; the
 * racing repository lets a peer write land between this daemon's read of a row and the statement
 * it issues from that read — the window a guard enforced by a prior read leaves open.
 */
class RacingRepository extends DeviceSessionRepository {
  beforeExpiredRelease: (() => Promise<void>) | undefined;
  beforeUpsert: (() => Promise<void>) | undefined;
  expiredReleases = 0;

  override async markReleased(
    ...args: Parameters<DeviceSessionRepository["markReleased"]>
  ): Promise<void> {
    if (args[3] === "expired") {
      this.expiredReleases++;
      const peerWrite = this.beforeExpiredRelease;
      this.beforeExpiredRelease = undefined;
      await peerWrite?.();
    }
    return await super.markReleased(...args);
  }

  override async upsertActiveSession(
    ...args: Parameters<DeviceSessionRepository["upsertActiveSession"]>
  ): Promise<number> {
    const peerWrite = this.beforeUpsert;
    this.beforeUpsert = undefined;
    await peerWrite?.();
    return await super.upsertActiveSession(...args);
  }
}

describe("session persistence hunt: guards enforced by a prior read", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let peer: DeviceSessionRepository;
  let racing: RacingRepository;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    peer = new DeviceSessionRepository(db, timer);
    racing = new RacingRepository(db, timer);
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
    await db.destroy();
  });

  function daemon(daemonSessionId: string): {
    manager: SessionManager;
    pool: SessionDeviceAssigner;
  } {
    const manager = new SessionManager(timer, racing, () => new FakeDbWriteBarrier());
    managers.push(manager);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId(daemonSessionId);
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-a", "daemon-b"]));
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

  /** Daemon A's row: last used at 1 000, so its stored idle deadline is 5 000. */
  async function seedDaemonARow(): Promise<void> {
    await peer.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE,
      stableDeviceId: STABLE_DEVICE,
      platform: "android",
      daemonSessionId: "daemon-a",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: 5_000,
      sessionTimeoutMs: IDLE_WINDOW_MS,
      heartbeatTimeoutMs: IDLE_WINDOW_MS,
      hasReceivedHeartbeat: true,
    });
  }

  async function nameSessionOnDaemonB(): Promise<string> {
    const { manager, pool } = daemon("daemon-b");
    return await manager.getOrCreateSession(SESSION, pool, "android", undefined, true).then(
      () => "issued",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  // sessionManager.ts terminalizeExpiredPersistedSession: reads the row, judges
  // `expires_at_ms <= now`, then writes `expired` conditioned only on the row generation. Neither
  // `recordActivity` nor `recordRestartRecoveryActivity` advances the generation, so a deadline
  // extended after the read is not seen by the statement (the sweep got `onlyIfExpiredAtMs` for
  // exactly this in #11448; this call site did not).
  test("a peer naming a lapsed-looking active row does not expire it once its owner's activity write has extended the lease", async () => {
    await seedDaemonARow();
    timer.setCurrentTime(6_000);
    // Daemon A's tool call at 4 900 (inside its idle window) is persisted late: after daemon B
    // read the row, before B's release statement runs.
    racing.beforeExpiredRelease = async () => {
      await peer.recordActivity(SESSION, {
        lastUsedAtMs: 4_900,
        expiresAtMs: 4_900 + IDLE_WINDOW_MS,
        sessionTimeoutMs: IDLE_WINDOW_MS,
        heartbeatTimeoutMs: IDLE_WINDOW_MS,
        hasReceivedHeartbeat: true,
      });
    };

    await nameSessionOnDaemonB();

    // The scenario was driven: daemon B judged the row expired from its read.
    expect(racing.expiredReleases).toBe(1);
    const row = await peer.getSession(SESSION);
    expect(row?.expires_at_ms).toBe(4_900 + IDLE_WINDOW_MS);
    // The lease runs to 64 900 and it is 6 000: daemon A's live session keeps its active row.
    expect(row).toMatchObject({ status: "active", release_reason: null, released_at_ms: null });
  });

  test("a peer naming a lapsed-looking device-restart row does not expire it once restart-recovery activity has extended it", async () => {
    await seedDaemonARow();
    const reason = deviceRestartReleaseReason(STABLE_DEVICE);
    await peer.markReleased(SESSION, "released", 2_000, reason);
    timer.setCurrentTime(6_000);
    // Daemon A credited a control call at 4 900 to the restart recovery (#10713/#11281); its
    // fire-and-forget row write lands after daemon B's read.
    racing.beforeExpiredRelease = async () => {
      await peer.recordRestartRecoveryActivity(SESSION, 4_900);
    };

    await nameSessionOnDaemonB();

    expect(racing.expiredReleases).toBe(1);
    const row = await peer.getSession(SESSION);
    expect(row?.expires_at_ms).toBe(4_900 + IDLE_WINDOW_MS);
    // Still recoverable until 64 900: the row must keep its device-restart handoff.
    expect(row).toMatchObject({ status: "released", release_reason: reason });
  });

  // sessionManager.ts persistSessionActivity: when the activity write matches no active row it
  // reads the row ("A terminal row is final, whoever wrote it: never revive it") and then
  // re-persists with an unconditional upsert. The upsert's conflict path has no terminal guard, so
  // a terminal release that lands after the read is erased and the UUID is active again.
  test("re-persisting a live session whose row a peer retired does not revive a terminal release that lands after the terminal check", async () => {
    const { manager } = daemon("daemon-a");
    await manager.createSession(
      SESSION,
      DEVICE,
      "android",
      IDLE_WINDOW_MS,
      undefined,
      STABLE_DEVICE,
    );
    expect(await peer.getSession(SESSION)).toMatchObject({ status: "active" });
    // A starting peer judged daemon A dead and handed its row off.
    await peer.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    timer.advanceTime(1_000);
    const terminalReason = "identity-recovery-identity-continuity-lost";
    // The peer's recovery of that row then fails for good, after daemon A's terminal check.
    racing.beforeUpsert = async () => {
      await peer.markReleased(SESSION, "released", timer.now(), terminalReason);
    };

    // Daemon A's next tool call refreshes the session, which writes its activity row.
    const outcome = await manager.getOrCreateSession(SESSION).then(
      () => "refreshed",
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    );

    // The scenario was driven: the re-persist ran (and consumed the peer write).
    expect(racing.beforeUpsert).toBeUndefined();
    const row = await peer.getSession(SESSION);
    // The terminal fence stands; the row is not active again.
    expect(row).toMatchObject({ status: "released", release_reason: terminalReason });
    expect(outcome).not.toBe("refreshed");
  });
});
