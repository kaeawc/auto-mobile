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
import { DevicePool } from "../../src/daemon/devicePool";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

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

  // The real DevicePool refuses a recovery whose device another session holds (or that is gone)
  // as identity loss, which ends the UUID. A re-issued plan session has no identity to lose.
  describe("on the real device pool", () => {
    const SIM_A = "SIM-PLAN-A";
    const SIM_B = "SIM-PLAN-B";
    const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });
    let manager: SessionManager;
    let pool: DevicePool;

    async function setUp(devices: BootedDevice[]): Promise<void> {
      manager = new SessionManager(timer, repo);
      manager.stopCleanupTimer();
      manager.attachDaemonSessionId("daemon-new");
      manager.attachLiveDaemonSessionIds(() => new Set(["daemon-new"]));
      const deviceManager = new FakeDeviceManager();
      deviceManager.bootedDevices = devices;
      pool = new DevicePool(
        createDevicePoolDependencies(manager, "plan-reissue", {
          timer,
          deviceManager,
          retryExecutor: new DefaultRetryExecutor(timer),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        }),
      );
      await pool.initializeWithDevices(devices);
    }

    /** A session that ran a plan on SIM_A and was released by the plan's cleanup. */
    async function runPlanOnSimA(reason: string = PLAN_AUTO_RELEASE_REASON): Promise<void> {
      await pool.bindOrReuseDeviceSession(SESSION, SIM_A, "ios", undefined, undefined, ios(SIM_A));
      await manager.releaseSession(SESSION, reason);
      await pool.releaseDevice(SIM_A, SESSION);
      expect(await repo.getSession(SESSION)).toMatchObject({ release_reason: reason });
      expect(pool.getDevice(SIM_A)?.sessionId).toBeNull();
    }

    test("re-issues on the same device when it is free", async () => {
      await setUp([ios(SIM_B), ios(SIM_A)]);
      await runPlanOnSimA();

      const session = await manager.getOrCreateSession(SESSION, pool, "ios", undefined, true);

      expect(session.assignedDevice).toBe(SIM_A);
    });

    test("re-issues on another device when a session took the old one", async () => {
      await setUp([ios(SIM_A), ios(SIM_B)]);
      await runPlanOnSimA();
      await pool.bindOrReuseDeviceSession("other", SIM_A, "ios", undefined, undefined, ios(SIM_A));

      const session = await manager.getOrCreateSession(SESSION, pool, "ios", undefined, true);

      expect(session.assignedDevice).toBe(SIM_B);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      expect(pool.getDevice(SIM_A)?.sessionId).toBe("other");
      expect(await repo.getSession(SESSION)).toMatchObject({
        status: "active",
        release_reason: null,
        device_id: SIM_B,
        daemon_session_id: "daemon-new",
      });
    });

    test("re-issues on another device when the old one is gone", async () => {
      await setUp([ios(SIM_A), ios(SIM_B)]);
      await runPlanOnSimA();
      // A daemon that no longer has the plan's device.
      await setUp([ios(SIM_B)]);

      const session = await manager.getOrCreateSession(SESSION, pool, "ios", undefined, true);

      expect(session.assignedDevice).toBe(SIM_B);
      expect(await repo.getSession(SESSION)).toMatchObject({ status: "active", device_id: SIM_B });
    });

    test("a recoverable row whose device was taken still ends as identity loss", async () => {
      await setUp([ios(SIM_A), ios(SIM_B)]);
      await runPlanOnSimA("daemon-restart");
      await pool.bindOrReuseDeviceSession("other", SIM_A, "ios", undefined, undefined, ios(SIM_A));

      await expect(
        manager.getOrCreateSession(SESSION, pool, "ios", undefined, true),
      ).rejects.toThrow("target-busy");

      expect(pool.getDevice(SIM_B)?.sessionId).toBeNull();
      expect((await repo.getSession(SESSION))?.release_reason).toBe(
        "identity-recovery-target-busy",
      );
    });
  });
});
