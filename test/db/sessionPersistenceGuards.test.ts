import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import {
  DeviceSessionRepository,
  deviceRestartReleaseReason,
} from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

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

// #11498: a write decided from a row read earlier must carry its condition in the statement.
describe("session persistence guards live in the statement, not in a prior read", () => {
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

    const outcome = await nameSessionOnDaemonB();

    // The scenario was driven: daemon B judged the row expired from its read.
    expect(racing.expiredReleases).toBe(1);
    const row = await peer.getSession(SESSION);
    expect(row?.expires_at_ms).toBe(4_900 + IDLE_WINDOW_MS);
    // The lease runs to 64 900 and it is 6 000: daemon A's live session keeps its active row.
    expect(row).toMatchObject({ status: "active", release_reason: null, released_at_ms: null });
    // Answered from the row as it now is: a live peer's session, not an expired or terminal one.
    expect(outcome).toContain("device_owned_by_other_daemon");
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

    const outcome = await nameSessionOnDaemonB();

    expect(racing.expiredReleases).toBe(1);
    const row = await peer.getSession(SESSION);
    // Still recoverable: the row keeps its device-restart handoff, and the call is answered from
    // the row as it now is. It is daemon A's to recover, so daemon B is refused without a terminal
    // answer; its own control call counts as restart-recovery activity like any other.
    expect(row).toMatchObject({
      status: "released",
      release_reason: reason,
      daemon_session_id: "daemon-a",
    });
    expect(row?.expires_at_ms).toBeGreaterThanOrEqual(4_900 + IDLE_WINDOW_MS);
    expect(outcome).toContain("device_owned_by_other_daemon");
  });

  test("a peer naming a row that really is past its deadline still marks it expired and answers the typed refusal", async () => {
    await seedDaemonARow();
    timer.setCurrentTime(6_000);

    const outcome = await nameSessionOnDaemonB();

    expect(racing.expiredReleases).toBe(1);
    expect(await peer.getSession(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "expired",
      released_at_ms: 6_000,
    });
    expect(outcome).toContain("is terminal after expired");
  });

  test("the expiry write compares the deadline in the stored wall frame when the session clock has parted from the wall clock", async () => {
    const HOUR_MS = 3_600_000;
    timer.setCurrentTime(10 * HOUR_MS);
    const { manager, pool } = daemon("daemon-b");
    manager.sessionNow(); // daemon B's session clock starts here
    // A backward wall step daemon B lived through: its session clock now reads an hour ahead of
    // the wall clock the stored stamps are on.
    timer.stepWallClock(-HOUR_MS);
    const wallNow = timer.now();
    await peer.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE,
      stableDeviceId: STABLE_DEVICE,
      platform: "android",
      daemonSessionId: "daemon-a",
      createdAtMs: wallNow - 10_000,
      lastUsedAtMs: wallNow - 10_000,
      expiresAtMs: wallNow - 1_000,
      sessionTimeoutMs: IDLE_WINDOW_MS,
      heartbeatTimeoutMs: IDLE_WINDOW_MS,
      hasReceivedHeartbeat: true,
    });
    // Extended to half an hour from now: lapsed only if compared with the session-clock instant.
    const extendedTo = wallNow + HOUR_MS / 2;
    racing.beforeExpiredRelease = async () => {
      await peer.recordActivity(SESSION, {
        lastUsedAtMs: wallNow - 500,
        expiresAtMs: extendedTo,
        sessionTimeoutMs: IDLE_WINDOW_MS,
        heartbeatTimeoutMs: IDLE_WINDOW_MS,
        hasReceivedHeartbeat: true,
      });
    };

    await manager
      .getOrCreateSession(SESSION, pool, "android", undefined, true)
      .catch(() => undefined);

    expect(racing.expiredReleases).toBe(1);
    expect(await peer.getSession(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      expires_at_ms: extendedTo,
    });
  });
});
