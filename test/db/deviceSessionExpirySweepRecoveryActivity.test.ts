import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * The recoverable-only expiry sweep of #11427 meets restart-recovery activity (#11281).
 *
 * `listRecoverableSessions` selects recoverable rows past `expires_at_ms`, then releases each as
 * `expired`. A control call waiting on a device restart extends the row's deadline
 * (`recordRestartRecoveryActivity`: `expires_at_ms = max(..., activity + session_timeout_ms)`)
 * without touching the reason or the generation. When that write lands between the sweep's select
 * and its update (another daemon's startup rehydration sweeping the shared store, or the same
 * daemon's own awaits), the row is no longer expired, so the sweep's release must re-check the
 * deadline in the same statement and leave the row recoverable (#11448). Driven the way
 * `test/db/deviceSessionTerminalFence.test.ts` drives the peer-release race.
 */

const SESSION = "restart-recovery-session";
const DEVICE_RESTART = "device-restart:emulator-5554";
const SESSION_TIMEOUT_MS = 60_000;
const DEADLINE_MS = 5_000;
const SWEEP_AT_MS = 6_000;

describe("expired-row sweep vs. restart-recovery activity", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** A sweep whose `expired` release is preceded by the waiting control call's activity write. */
  function sweepRacingRestartRecoveryActivity(): DeviceSessionRepository {
    class RacingRepository extends DeviceSessionRepository {
      override async markReleased(
        ...args: Parameters<DeviceSessionRepository["markReleased"]>
      ): Promise<void> {
        if (args[3] === "expired") {
          await super.recordRestartRecoveryActivity(SESSION, SWEEP_AT_MS);
        }
        return await super.markReleased(...args);
      }
    }
    return new RacingRepository(db, timer);
  }

  test("a row whose deadline was extended after the sweep selected it stays recoverable", async () => {
    const repo = new DeviceSessionRepository(db, timer);
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      daemonSessionId: "daemon-a",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: DEADLINE_MS,
      sessionTimeoutMs: SESSION_TIMEOUT_MS,
      heartbeatTimeoutMs: 4_000,
      hasReceivedHeartbeat: true,
    });
    // The device restarted: the session waits for it under a recoverable handoff reason.
    await repo.markReleased(SESSION, "released", 2_000, DEVICE_RESTART);

    const recoverable =
      await sweepRacingRestartRecoveryActivity().listRecoverableSessions(SWEEP_AT_MS);

    const row = await repo.getSession(SESSION);
    // The control call's activity moved the deadline past the sweep's clock...
    expect(row?.expires_at_ms).toBe(SWEEP_AT_MS + SESSION_TIMEOUT_MS);
    // ...so the row is not expired and the sweep must leave it recoverable.
    expect(row?.release_reason).toBe(DEVICE_RESTART);
    expect(recoverable.map((session) => session.session_uuid)).toEqual([SESSION]);
  });
});
