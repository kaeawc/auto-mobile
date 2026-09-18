import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type Kysely, sql } from "kysely";
import type { Database } from "../../src/db/types";
import {
  DeviceSessionRepository,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import { logger } from "../../src/utils/logger";
import { createTestDatabase } from "./testDbHelper";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
] as const;

function clearAutolockEnv(): void {
  for (const key of AUTOLOCK_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("DeviceSessionRepository", () => {
  let db: Kysely<Database>;
  let repo: DeviceSessionRepository;
  let timer: FakeTimer;

  beforeEach(async () => {
    clearAutolockEnv();
    db = await createTestDatabase();
    timer = new FakeTimer();
    repo = new DeviceSessionRepository(db, timer);
  });

  afterEach(async () => {
    clearAutolockEnv();
    await db.destroy();
  });

  test("upserts and updates a device session lifecycle", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "session-1",
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      source: "session-manager",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });

    await repo.markAutolockSession("session-1", {
      mcpSessionId: "mcp-session-1",
      daemonSessionId: "daemon-session-1",
      lastUsedAtMs: 2000,
      expiresAtMs: 62_000,
    });
    await repo.recordActivity("session-1", {
      lastUsedAtMs: 3000,
      expiresAtMs: 63_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    await repo.recordLivenessOwnership("session-1", "owner-token");
    await repo.markReleased("session-1", "released", 4000, "explicit-release");

    const row = await repo.getSession("session-1");
    expect(row).toBeDefined();
    expect(row!.device_id).toBe("emulator-5554");
    expect(row!.stable_device_id).toBe("Pixel_8_API_35");
    expect(row!.platform).toBe("android");
    expect(row!.status).toBe("released");
    expect(row!.source).toBe("autolock");
    expect(row!.autolock_enabled).toBe(1);
    expect(row!.mcp_session_id).toBe("mcp-session-1");
    expect(row!.daemon_session_id).toBe("daemon-session-1");
    expect(row!.last_used_at_ms).toBe(3000);
    expect(row!.expires_at_ms).toBe(63_000);
    expect(row!.released_at_ms).toBe(4000);
    expect(row!.release_reason).toBe("explicit-release");
    expect(row!.has_received_heartbeat).toBe(1);
    expect(row!.liveness_owner_token).toBeNull();
  });

  test("retains liveness ownership across recoverable daemon shutdown", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "recoverable-session",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 1000,
      lastUsedAtMs: 2000,
      expiresAtMs: 63_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    await repo.recordLivenessOwnership("recoverable-session", "current-owner");

    await repo.markReleased("recoverable-session", "released", 4000, "daemon-shutdown");

    expect(await repo.getSession("recoverable-session")).toMatchObject({
      release_reason: "daemon-shutdown",
      liveness_owner_token: "current-owner",
    });
  });

  test("lists recoverable daemon releases newest first", async () => {
    for (const [sessionUuid, lastUsedAtMs, reason] of [
      ["older", 1000, "daemon-restart"],
      ["newer", 2000, "daemon-shutdown"],
      ["terminal", 3000, "device-killed"],
    ] as const) {
      await repo.upsertActiveSession({
        sessionUuid,
        deviceId: `${sessionUuid}-device`,
        platform: "android",
        createdAtMs: 1,
        lastUsedAtMs,
        expiresAtMs: 60_000,
        sessionTimeoutMs: 60_000,
        heartbeatTimeoutMs: 10_000,
        hasReceivedHeartbeat: false,
      });
      await repo.markReleased(sessionUuid, "expired", 4000, reason);
    }
    await repo.upsertActiveSession({
      sessionUuid: "active-without-release",
      deviceId: "emulator-5560",
      platform: "android",
      createdAtMs: 1,
      lastUsedAtMs: 4000,
      expiresAtMs: 60_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: false,
    });

    expect((await repo.listRecoverableSessions()).map((row) => row.session_uuid)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("does not recover rows past retention or their persisted expiry", async () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    await repo.upsertActiveSession({
      sessionUuid: "past-retention",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: sevenDaysMs * 2,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: false,
    });
    await repo.markReleased("past-retention", "released", 0, "daemon-restart");
    await repo.upsertActiveSession({
      sessionUuid: "spent-session",
      deviceId: "emulator-5556",
      platform: "android",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 1_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: false,
    });
    await repo.markReleased("spent-session", "released", 1, "daemon-shutdown");

    await timer.advanceTimeAsync(sevenDaysMs + 1_000);

    expect(await repo.listRecoverableSessions()).toEqual([]);
    // Thread 3: past-retention rows are pruned before expiry marking, so their
    // released_at_ms is never reset to extend DEVICE_SESSION_RETENTION_MAX_AGE_MS.
    expect(await repo.getSession("spent-session")).toBeUndefined();
  });

  test("does not reset an expired row already past retention", async () => {
    const nowMs = 10 * 24 * 60 * 60 * 1000;
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    await timer.advanceTimeAsync(nowMs);
    await repo.upsertActiveSession({
      sessionUuid: "past-retention-expired",
      deviceId: "emulator-5558",
      platform: "android",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 1,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: false,
    });
    await repo.markReleased(
      "past-retention-expired",
      "released",
      nowMs - eightDaysMs,
      "daemon-restart",
    );

    await repo.listRecoverableSessions();

    expect(await repo.getSession("past-retention-expired")).toBeUndefined();
  });

  test("marks an expired row within retention at the current time", async () => {
    const nowMs = 10 * 24 * 60 * 60 * 1000;
    const yesterdayMs = 24 * 60 * 60 * 1000;
    await timer.advanceTimeAsync(nowMs);
    await repo.upsertActiveSession({
      sessionUuid: "in-retention-expired",
      deviceId: "emulator-5560",
      platform: "android",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 1,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: false,
    });
    await repo.markReleased(
      "in-retention-expired",
      "released",
      nowMs - yesterdayMs,
      "daemon-restart",
    );

    await repo.listRecoverableSessions();

    expect(await repo.getSession("in-retention-expired")).toMatchObject({
      status: "expired",
      release_reason: "expired",
      released_at_ms: nowMs,
    });
  });

  test("persists the liveness contract used to recover daemon sessions", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "liveness-session",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 1000,
      lastUsedAtMs: 2000,
      expiresAtMs: 62_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 15_000,
      heartbeatTimeoutSource: "custom",
      hasReceivedHeartbeat: true,
      livenessPolicy: "cli-idle",
      preCliHeartbeatTimeoutMs: 15_000,
      preCliHeartbeatTimeoutSource: "custom",
      preCliSessionTimeoutMs: 60_000,
    });

    await repo.recordActivity("liveness-session", {
      lastUsedAtMs: 3000,
      expiresAtMs: 303_000,
      sessionTimeoutMs: 300_000,
      heartbeatTimeoutMs: 300_000,
      hasReceivedHeartbeat: true,
      heartbeatTimeoutSource: "custom",
      livenessPolicy: "cli-idle",
      preCliHeartbeatTimeoutMs: 15_000,
      preCliHeartbeatTimeoutSource: "custom",
      preCliSessionTimeoutMs: 60_000,
    });

    expect(await repo.getSession("liveness-session")).toMatchObject({
      session_timeout_ms: 300_000,
      heartbeat_timeout_ms: 300_000,
      heartbeat_timeout_source: "custom",
      has_received_heartbeat: 1,
      liveness_policy: "cli-idle",
      pre_cli_heartbeat_timeout_ms: 15_000,
      pre_cli_heartbeat_timeout_source: "custom",
      pre_cli_session_timeout_ms: 60_000,
    });
  });

  test("clears stale CLI metadata when a legacy writer changes liveness columns", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "legacy-liveness-session",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 1000,
      lastUsedAtMs: 2000,
      expiresAtMs: 302_000,
      sessionTimeoutMs: 300_000,
      heartbeatTimeoutMs: 300_000,
      heartbeatTimeoutSource: "custom",
      hasReceivedHeartbeat: true,
      livenessPolicy: "cli-idle",
      preCliHeartbeatTimeoutMs: 15_000,
      preCliHeartbeatTimeoutSource: "custom",
      preCliSessionTimeoutMs: 60_000,
    });

    // Mirrors an older binary's upsert: it updates only the columns it knew
    // before the liveness contract existed, preserving unknown columns unless
    // the writer fence erases them.
    await db
      .updateTable("device_sessions")
      .set({
        session_timeout_ms: 60_000,
        heartbeat_timeout_ms: 15_000,
        has_received_heartbeat: 1,
      })
      .where("session_uuid", "=", "legacy-liveness-session")
      .execute();

    expect(await repo.getSession("legacy-liveness-session")).toMatchObject({
      session_timeout_ms: 60_000,
      heartbeat_timeout_ms: 15_000,
      heartbeat_timeout_source: null,
      liveness_policy: null,
      pre_cli_heartbeat_timeout_ms: null,
      pre_cli_heartbeat_timeout_source: null,
      pre_cli_session_timeout_ms: null,
    });
  });

  test("clears a stable identity when a legacy writer reuses an emulator serial", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "session-1",
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });

    await db
      .updateTable("device_sessions")
      // A legacy upsert keeps both known identity fields in its SET clause even
      // when a new AVD has reused this serial, but cannot advance the generation.
      .set({ device_id: "emulator-5554", stable_device_id: "Pixel_8_API_35" })
      .where("session_uuid", "=", "session-1")
      .execute();

    const row = await repo.getSession("session-1");
    expect(row).toMatchObject({
      device_id: "emulator-5554",
      stable_device_id: null,
    });
  });

  test("clears a prior incarnation's liveness owner when recreating the same session UUID", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "reused-session",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    await repo.recordLivenessOwnership("reused-session", "prior-owner");
    const manager = new SessionManager(timer, repo);
    try {
      await manager.createSession("reused-session", "emulator-5556", "android");

      expect(await repo.getSession("reused-session")).toMatchObject({
        device_id: "emulator-5556",
        liveness_owner_token: null,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("preserves a stable identity when the current writer rebinds its transport", async () => {
    const record = {
      sessionUuid: "session-1",
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      platform: "android" as const,
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    };
    await repo.upsertActiveSession(record);
    await repo.upsertActiveSession({ ...record, deviceId: "emulator-5556" });

    const row = await repo.getSession("session-1");
    expect(row).toMatchObject({
      device_id: "emulator-5556",
      stable_device_id: "Pixel_8_API_35",
    });
  });

  test("marks stale active sessions from previous daemon starts expired", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "old-daemon-session",
      deviceId: "emulator-5554",
      platform: "android",
      source: "autolock",
      autolockEnabled: true,
      mcpSessionId: "mcp-old",
      daemonSessionId: "old-daemon",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });
    await repo.upsertActiveSession({
      sessionUuid: "missing-daemon-session",
      deviceId: "emulator-5556",
      platform: "android",
      source: "session-manager",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });
    await repo.upsertActiveSession({
      sessionUuid: "current-daemon-session",
      deviceId: "emulator-5558",
      platform: "android",
      source: "autolock",
      autolockEnabled: true,
      daemonSessionId: "current-daemon",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });
    await repo.recordLivenessOwnership("old-daemon-session", "old-owner");
    await repo.recordLivenessOwnership("missing-daemon-session", "missing-owner");
    await repo.recordLivenessOwnership("current-daemon-session", "current-owner");

    await repo.markStaleActiveSessionsExpired("current-daemon", 5000, "daemon-restart");

    const oldRow = await repo.getSession("old-daemon-session");
    const missingRow = await repo.getSession("missing-daemon-session");
    const currentRow = await repo.getSession("current-daemon-session");

    expect(oldRow!.status).toBe("expired");
    expect(oldRow!.released_at_ms).toBe(5000);
    expect(oldRow!.release_reason).toBe("daemon-restart");
    expect(oldRow!.liveness_owner_token).toBe("old-owner");
    expect(missingRow!.status).toBe("expired");
    expect(missingRow!.released_at_ms).toBe(5000);
    expect(missingRow!.release_reason).toBe("daemon-restart");
    expect(missingRow!.liveness_owner_token).toBe("missing-owner");
    expect(currentRow!.status).toBe("active");
    expect(currentRow!.released_at_ms).toBeNull();
    expect(currentRow!.liveness_owner_token).toBe("current-owner");
  });

  test.each(["released", "expired"] as const)(
    "delayed autolock metadata cannot reactivate a %s session",
    async (status) => {
      await repo.upsertActiveSession({
        sessionUuid: "cancelled-autolock",
        deviceId: "emulator-5554",
        platform: "android",
        source: "session-manager",
        createdAtMs: 1000,
        lastUsedAtMs: 1000,
        expiresAtMs: 61_000,
        sessionTimeoutMs: 60_000,
        heartbeatTimeoutMs: 60_000,
        hasReceivedHeartbeat: false,
      });
      const pendingMetadata = Promise.withResolvers<void>();
      const lateWrite = pendingMetadata.promise.then(() =>
        repo.markAutolockSession("cancelled-autolock", {
          mcpSessionId: "late-mcp",
          daemonSessionId: "daemon-1",
          lastUsedAtMs: 3000,
          expiresAtMs: 63_000,
        }),
      );
      await repo.markReleased("cancelled-autolock", status, 2000, "session-creation-cancelled");
      const released = await repo.getSession("cancelled-autolock");
      pendingMetadata.resolve();
      await lateWrite;
      expect(await repo.getSession("cancelled-autolock")).toEqual(released);
      expect(released?.status).toBe(status);
      expect(released?.release_reason).toBe("session-creation-cancelled");
    },
  );

  test("late activity does not reactivate released sessions", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "session-1",
      deviceId: "emulator-5554",
      platform: "android",
      source: "session-manager",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });
    await repo.markReleased("session-1", "released", 2000, "explicit-release");

    await repo.recordActivity("session-1", {
      lastUsedAtMs: 3000,
      expiresAtMs: 63_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });

    const row = await repo.getSession("session-1");
    expect(row!.status).toBe("released");
    expect(row!.released_at_ms).toBe(2000);
    expect(row!.release_reason).toBe("explicit-release");
    expect(row!.last_used_at_ms).toBe(1000);
    expect(row!.expires_at_ms).toBe(61_000);
  });

  test("SessionManager persists create, activity, and release", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, repo);

    try {
      await sessionManager.createSession("session-1", "emulator-5554", "android", 60_000, 60_000);
      timer.advanceTime(1000);
      await sessionManager.getOrCreateSession("session-1");
      await sessionManager.releaseSession("session-1");

      const row = await repo.getSession("session-1");
      expect(row).toBeDefined();
      expect(row!.device_id).toBe("emulator-5554");
      expect(row!.status).toBe("released");
      expect(row!.last_used_at_ms).toBe(1000);
      expect(row!.released_at_ms).toBe(1000);
      expect(row!.release_reason).toBe("explicit-release");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("SessionManager persists custom infrastructure release reasons", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, repo);

    try {
      await sessionManager.createSession("session-1", "emulator-5554", "android", 60_000, 60_000);
      await sessionManager.releaseSession("session-1", "device-disconnected:emulator-5554");

      const row = await repo.getSession("session-1");
      expect(row!.release_reason).toBe("device-disconnected:emulator-5554");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("SessionManager persists heartbeat expiry reasons as expired sessions", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, repo);

    try {
      await sessionManager.createSession(
        "missing-heartbeat",
        "emulator-5554",
        "android",
        60_000,
        60_000,
      );
      await sessionManager.createSession(
        "stale-heartbeat",
        "emulator-5556",
        "android",
        60_000,
        60_000,
      );

      await sessionManager.releaseSession("missing-heartbeat", "missing-first-heartbeat");
      await sessionManager.releaseSession("stale-heartbeat", "heartbeat-timeout");

      const missingHeartbeat = await repo.getSession("missing-heartbeat");
      const staleHeartbeat = await repo.getSession("stale-heartbeat");
      expect(missingHeartbeat!.status).toBe("expired");
      expect(missingHeartbeat!.release_reason).toBe("missing-first-heartbeat");
      expect(staleHeartbeat!.status).toBe("expired");
      expect(staleHeartbeat!.release_reason).toBe("heartbeat-timeout");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("DevicePool stale emulator eviction persists device-disconnected release reason", async () => {
    const timer = new FakeTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    const androidDevice = {
      name: "Pixel 7",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    const sessionManager = new SessionManager(timer, repo);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session-1",
      timer,
      undefined,
      fakeDeviceUtils,
      undefined,
      repo,
    );

    try {
      await pool.initializeWithDevices([androidDevice]);
      await pool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android");
      fakeDeviceUtils.setBootedDevices("android", []);
      fakeDeviceUtils.markDeviceAsStopped("Pixel 7");
      fakeDeviceUtils.markDeviceAsStopped("emulator-5554");

      await expect(
        pool.bindOrReuseDeviceSession("session-2", "emulator-5554", "android"),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      const row = await repo.getSession("session-1");
      expect(row!.release_reason).toMatch(
        /^device-disconnected:emulator-5554;incident=emulator-loss-/,
      );
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("DevicePool autolock persists MCP and daemon session ownership", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    const androidDevice = {
      name: "Pixel 7",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    const sessionManager = new SessionManager(timer, repo);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session-1",
      timer,
      undefined,
      fakeDeviceUtils,
      undefined,
      repo,
    );

    try {
      await pool.initializeWithDevices([androidDevice]);

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      const row = await repo.getSession(sessionId!);

      expect(row).toBeDefined();
      expect(row!.status).toBe("active");
      expect(row!.source).toBe("autolock");
      expect(row!.autolock_enabled).toBe(1);
      expect(row!.mcp_session_id).toBe("mcp-session-1");
      expect(row!.daemon_session_id).toBe("daemon-session-1");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("markStaleActiveSessionsExpired propagates DB errors (startup fatal, not swallowed)", async () => {
    // A missing/malformed device_sessions table means a broken DB; the startup
    // path relies on this rejecting so the circuit breaker can go fatal + back
    // off (issue #2784) rather than starting with broken session state.
    await db.schema.dropTable("device_sessions").execute();

    await expect(
      repo.markStaleActiveSessionsExpired("current-daemon", 5000, "daemon-restart"),
    ).rejects.toThrow(/no such table/);
  });

  test("upsertActiveSession defaults status to active when the record omits it", async () => {
    await repo.upsertActiveSession({
      sessionUuid: "session-default",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 1000,
      lastUsedAtMs: 1000,
      expiresAtMs: 61_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    });

    const row = await repo.getSession("session-default");
    expect(row).toBeDefined();
    expect(row!.status).toBe("active");
  });

  // Regression for #6464: `device_sessions` accumulates one row per device
  // session for the life of the on-disk DB, with only status transitions
  // (never a delete) applied to old rows. These tests prove the TTL-based
  // prune wired into the real production write path (`upsertActiveSession`,
  // called from `SessionManager.persistSession`) actually bounds the table.
  describe("device_sessions retention (#6464)", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;

    function makeRecord(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
      return {
        sessionUuid: "placeholder",
        deviceId: "emulator-5554",
        platform: "android" as const,
        createdAtMs: 0,
        lastUsedAtMs: 0,
        expiresAtMs: 60_000,
        sessionTimeoutMs: 60_000,
        heartbeatTimeoutMs: 60_000,
        hasReceivedHeartbeat: false,
        ...overrides,
      };
    }

    test("uses current time when rebinding a session created before the retention window", async () => {
      await repo.upsertActiveSession(makeRecord({ sessionUuid: "old" }));
      await repo.markReleased("old", "released", oneDayMs, "explicit-release");
      timer.advanceTime(10 * oneDayMs);
      await repo.upsertActiveSession(makeRecord({ sessionUuid: "rebound", createdAtMs: 0 }));
      expect(await repo.getSession("old")).toBeUndefined();
      expect(await repo.getSession("rebound")).toBeDefined();
    });

    test("migrates an index on the session retention cutoff", async () => {
      const columns = await sql<{ name: string }>`SELECT name
        FROM pragma_index_info('idx_device_sessions_released_at_ms')`.execute(db);
      expect(columns.rows).toEqual([{ name: "released_at_ms" }]);
    });

    test("upsertActiveSession prunes terminal-state rows past the retention window", async () => {
      await repo.upsertActiveSession(makeRecord({ sessionUuid: "old-released" }));
      await repo.markReleased("old-released", "released", 1 * oneDayMs, "explicit-release");

      await repo.upsertActiveSession(makeRecord({ sessionUuid: "recent-released" }));
      await repo.markReleased("recent-released", "released", 9 * oneDayMs, "explicit-release");

      // A new session starting at day 10 triggers the prune — mirrors
      // `DeviceTeardownOperationRepository.begin()`'s unconditional
      // delete-before-write pattern. Cutoff = day 10 - 7 days = day 3, so the
      // day-1 release is pruned and the day-9 release survives.
      timer.advanceTime(10 * oneDayMs);
      await repo.upsertActiveSession(
        makeRecord({
          sessionUuid: "new-session",
          createdAtMs: 10 * oneDayMs,
          lastUsedAtMs: 10 * oneDayMs,
          expiresAtMs: 10 * oneDayMs + 60_000,
        }),
      );

      expect(await repo.getSession("old-released")).toBeUndefined();
      expect(await repo.getSession("recent-released")).toBeDefined();
      expect(await repo.getSession("new-session")).toBeDefined();
    });

    test("keeps terminal-state rows when none are old enough", async () => {
      await repo.upsertActiveSession(makeRecord({ sessionUuid: "session-1" }));
      await repo.markReleased("session-1", "released", 2 * oneDayMs, "explicit-release");

      // Cutoff = day 3 - 7 days = negative: nothing is old enough to prune.
      timer.advanceTime(3 * oneDayMs);
      await repo.upsertActiveSession(
        makeRecord({
          sessionUuid: "session-2",
          createdAtMs: 3 * oneDayMs,
          lastUsedAtMs: 3 * oneDayMs,
          expiresAtMs: 3 * oneDayMs + 60_000,
        }),
      );

      expect(await repo.getSession("session-1")).toBeDefined();
    });

    test("never prunes active (non-terminal) sessions regardless of age", async () => {
      await repo.upsertActiveSession(makeRecord({ sessionUuid: "still-active" }));

      // A far-future session start would prune any terminal row past the TTL,
      // but "still-active" has `released_at_ms = null` and must survive.
      timer.advanceTime(365 * oneDayMs);
      await repo.upsertActiveSession(
        makeRecord({
          sessionUuid: "new-session",
          createdAtMs: 365 * oneDayMs,
          lastUsedAtMs: 365 * oneDayMs,
          expiresAtMs: 365 * oneDayMs + 60_000,
        }),
      );

      const stillActive = await repo.getSession("still-active");
      expect(stillActive).toBeDefined();
      expect(stillActive!.status).toBe("active");
      expect(stillActive!.released_at_ms).toBeNull();
    });
  });

  test("upsertActiveSession logs and propagates a write failure for session rollback", async () => {
    // SessionManager owns the in-memory rollback after this awaited write fails.
    // Destroy the table so the insert rejects, then preserve the diagnostic log
    // while asserting the failure reaches that rollback path.
    const warnSpy = spyOn(logger, "warn");
    try {
      await db.schema.dropTable("device_sessions").execute(); // force the insert to throw
      await expect(
        repo.upsertActiveSession({
          sessionUuid: "session-fail",
          deviceId: "emulator-5554",
          platform: "android",
          createdAtMs: 1000,
          lastUsedAtMs: 1000,
          expiresAtMs: 61_000,
          sessionTimeoutMs: 60_000,
          heartbeatTimeoutMs: 60_000,
          hasReceivedHeartbeat: false,
        }),
      ).rejects.toThrow(/no such table/);
      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("session-fail");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
