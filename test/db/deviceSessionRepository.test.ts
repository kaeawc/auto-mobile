import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
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

  beforeEach(async () => {
    clearAutolockEnv();
    db = await createTestDatabase();
    repo = new DeviceSessionRepository(db);
  });

  afterEach(async () => {
    clearAutolockEnv();
    await db.destroy();
  });

  test("upserts and updates a device session lifecycle", async () => {
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

    await repo.markAutolockSession("session-1", {
      mcpSessionId: "mcp-session-1",
      daemonSessionId: "daemon-session-1",
      lastUsedAtMs: 2000,
      expiresAtMs: 62_000,
    });
    await repo.recordActivity("session-1", {
      lastUsedAtMs: 3000,
      expiresAtMs: 63_000,
      hasReceivedHeartbeat: true,
    });
    await repo.markReleased("session-1", "released", 4000, "explicit-release");

    const row = await repo.getSession("session-1");
    expect(row).toBeDefined();
    expect(row!.device_id).toBe("emulator-5554");
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

    await repo.markStaleActiveSessionsExpired("current-daemon", 5000, "daemon-restart");

    const oldRow = await repo.getSession("old-daemon-session");
    const missingRow = await repo.getSession("missing-daemon-session");
    const currentRow = await repo.getSession("current-daemon-session");

    expect(oldRow!.status).toBe("expired");
    expect(oldRow!.released_at_ms).toBe(5000);
    expect(oldRow!.release_reason).toBe("daemon-restart");
    expect(missingRow!.status).toBe("expired");
    expect(missingRow!.released_at_ms).toBe(5000);
    expect(missingRow!.release_reason).toBe("daemon-restart");
    expect(currentRow!.status).toBe("active");
    expect(currentRow!.released_at_ms).toBeNull();
  });

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
