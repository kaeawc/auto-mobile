import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { makePool } from "../helpers/makePool";

// #11811: a recovered claim the device-claims registry cannot decide yet is rolled back and
// retried. The rollback must leave the persisted row re-issuable at the generation the retry's
// conditional upsert expects, or the retry fails with DeviceSessionRowChangedError.

const SESSION = "restarted-session";
const DEVICE_ID = "emulator-5554";
const AVD = "Original_AVD";
const DAEMON = "daemon-a-after-restart";

describe("deferred recovered-device claim retry through the conditional upsert (#11811)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: DeviceSessionRepository;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    repo = new DeviceSessionRepository({ db, timer });
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
    await db.destroy();
  });

  /** The row a daemon that died holding the device left behind: re-issuable by name. */
  async function seedRestartedRow(): Promise<void> {
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE_ID,
      stableDeviceId: AVD,
      platform: "android",
      daemonSessionId: "daemon-a-before-restart",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: 10_000_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    await repo.markReleased(SESSION, "released", 1_000, { reason: "daemon-restart" });
  }

  /** No foreign owner anywhere; the registry only cannot decide the first claim. */
  function unusableOnce(): ForeignDeviceOwnership & { claims: number } {
    let deferred = false;
    const ownership = {
      claims: 0,
      refresh: async () => {},
      foreignOwnerPid: () => undefined,
      claim: async () => {
        ownership.claims++;
        deferred = ownership.claims === 1;
        return !deferred;
      },
      claimDeferred: () => deferred,
      release: () => {},
    };
    return ownership;
  }

  test("the retry after a deferred claim recovers the session onto its row", async () => {
    await seedRestartedRow();
    const sessions = new SessionManager(timer, repo);
    managers.push(sessions);
    sessions.attachDaemonSessionId(DAEMON);
    sessions.attachLiveDaemonSessionIds(() => new Set([DAEMON]));
    const devices = new FakeDeviceManager();
    const device = { deviceId: DEVICE_ID, name: AVD, platform: "android" as const };
    devices.bootedDevices = [device];
    const ownership = unusableOnce();
    const pool = makePool(sessions, DAEMON, {
      timer,
      deviceManager: devices,
      foreignDeviceOwnership: ownership,
    });
    await pool.initializeWithDevices([device]);

    let settled = false;
    const resumed = sessions
      .getOrCreateSession(SESSION, pool, "android", { requireIssuedSession: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    for (let tick = 0; tick < 50 && !settled; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
      timer.advanceTime(1_000);
    }

    expect(await resumed).toBeUndefined();
    expect(ownership.claims).toBe(2);
    expect(pool.getDevice(DEVICE_ID)?.sessionId).toBe(SESSION);
    expect(sessions.getSession(SESSION)?.assignedDevice).toBe(DEVICE_ID);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      daemon_session_id: DAEMON,
    });
    pool.releaseDeviceClaimsForShutdown();
  });
});
