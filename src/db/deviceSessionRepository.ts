import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, DeviceSession, DeviceSessionStatus, NewDeviceSession } from "./types";
import { logger } from "../utils/logger";
import type { Platform } from "../models";

// Terminal-state (`released`/`expired`) rows accumulate for the life of the
// on-disk DB with no delete path (#6464). Bound their retention window rather
// than adding a new column: `released_at_ms` is already set at the same time a
// row transitions terminal (by both `markReleased` and
// `markStaleActiveSessionsExpired`), so it is a reliable "became terminal" age
// marker without a migration.
const DEVICE_SESSION_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeviceSessionRecord {
  sessionUuid: string;
  deviceId: string;
  platform: Platform;
  status?: DeviceSessionStatus;
  source?: string | null;
  autolockEnabled?: boolean;
  mcpSessionId?: string | null;
  daemonSessionId?: string | null;
  createdAtMs: number;
  lastUsedAtMs: number;
  expiresAtMs: number;
  sessionTimeoutMs: number;
  heartbeatTimeoutMs: number;
  hasReceivedHeartbeat: boolean;
}

export interface DeviceSessionActivityUpdate {
  lastUsedAtMs: number;
  expiresAtMs: number;
  hasReceivedHeartbeat: boolean;
}

export interface DeviceSessionPersistence {
  upsertActiveSession(record: DeviceSessionRecord): Promise<void>;
  getSession?(sessionUuid: string): Promise<DeviceSession | undefined>;
  recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void>;
  markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void>;
}

export class DeviceSessionRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
  }

  // Migration gating is owned by startup (ensureMigrations) plus the app dialect
  // first-query gate (waitForMigrationsBeforeQuery, #6703); a repository helper
  // must NOT await ensureMigrations itself. Resolve the injected executor, else
  // the singleton, synchronously.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    // Mirrors `DeviceTeardownOperationRepository.begin()`'s
    // `expires_at_ms <= now` pattern: a cheap, unconditional, indexed range
    // delete run before the write rather than gated behind amortization —
    // session starts are far less frequent than the amortized-per-insert
    // tables (#6464). Self-contained: a prune failure must never block a new
    // session from being persisted, so it swallows its own errors.
    await this.pruneExpiredSessions(record.createdAtMs);
    try {
      const db = await this.getDb();
      const now = new Date().toISOString();
      const row: NewDeviceSession = {
        session_uuid: record.sessionUuid,
        device_id: record.deviceId,
        platform: record.platform,
        status: record.status ?? "active",
        source: record.source ?? null,
        autolock_enabled: record.autolockEnabled ? 1 : 0,
        mcp_session_id: record.mcpSessionId ?? null,
        daemon_session_id: record.daemonSessionId ?? null,
        created_at_ms: record.createdAtMs,
        last_used_at_ms: record.lastUsedAtMs,
        expires_at_ms: record.expiresAtMs,
        released_at_ms: null,
        release_reason: null,
        session_timeout_ms: record.sessionTimeoutMs,
        heartbeat_timeout_ms: record.heartbeatTimeoutMs,
        has_received_heartbeat: record.hasReceivedHeartbeat ? 1 : 0,
        updated_at: now,
      };

      await db
        .insertInto("device_sessions")
        .values(row)
        .onConflict((oc) =>
          oc.column("session_uuid").doUpdateSet({
            device_id: row.device_id,
            platform: row.platform,
            status: row.status,
            source: row.source,
            autolock_enabled: row.autolock_enabled,
            mcp_session_id: row.mcp_session_id,
            daemon_session_id: row.daemon_session_id,
            last_used_at_ms: row.last_used_at_ms,
            expires_at_ms: row.expires_at_ms,
            released_at_ms: null,
            release_reason: null,
            session_timeout_ms: row.session_timeout_ms,
            heartbeat_timeout_ms: row.heartbeat_timeout_ms,
            has_received_heartbeat: row.has_received_heartbeat,
            updated_at: now,
          }),
        )
        .execute();
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to upsert device session ${record.sessionUuid}: ${error}`,
      );
      throw error;
    }
  }

  async recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    try {
      const db = await this.getDb();
      await db
        .updateTable("device_sessions")
        .set({
          last_used_at_ms: update.lastUsedAtMs,
          expires_at_ms: update.expiresAtMs,
          has_received_heartbeat: update.hasReceivedHeartbeat ? 1 : 0,
          updated_at: new Date().toISOString(),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "=", "active")
        .execute();
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to record activity for ${sessionUuid}: ${error}`,
      );
    }
  }

  async markAutolockSession(
    sessionUuid: string,
    input: {
      mcpSessionId?: string | null;
      daemonSessionId?: string | null;
      lastUsedAtMs: number;
      expiresAtMs: number;
    },
  ): Promise<void> {
    try {
      const db = await this.getDb();
      await db
        .updateTable("device_sessions")
        .set({
          status: "active",
          source: "autolock",
          autolock_enabled: 1,
          mcp_session_id: input.mcpSessionId ?? null,
          daemon_session_id: input.daemonSessionId ?? null,
          last_used_at_ms: input.lastUsedAtMs,
          expires_at_ms: input.expiresAtMs,
          released_at_ms: null,
          release_reason: null,
          updated_at: new Date().toISOString(),
        })
        .where("session_uuid", "=", sessionUuid)
        .execute();
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to mark autolock session ${sessionUuid}: ${error}`,
      );
    }
  }

  async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    try {
      const db = await this.getDb();
      await db
        .updateTable("device_sessions")
        .set({
          status,
          released_at_ms: releasedAtMs,
          release_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .where("session_uuid", "=", sessionUuid)
        .execute();
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to mark session ${sessionUuid} ${status}: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Expire stale active sessions left by previous daemon runs. Called once during
   * daemon startup (`Daemon.initializeDatabase()`). Errors PROPAGATE rather than
   * being swallowed: a failure here means the `device_sessions` table is
   * missing/malformed (a broken DB), which the startup circuit breaker must treat
   * as fatal so the daemon exits/backs off instead of starting with broken
   * session state (issue #2784). Do not add a local catch — the caller owns the
   * fatal/backoff decision.
   */
  async markStaleActiveSessionsExpired(
    currentDaemonSessionId: string,
    releasedAtMs: number,
    reason: string = "daemon-restart",
  ): Promise<void> {
    const db = await this.getDb();
    await db
      .updateTable("device_sessions")
      .set({
        status: "expired",
        released_at_ms: releasedAtMs,
        release_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .where("status", "=", "active")
      .where((eb) =>
        eb.or([
          eb("daemon_session_id", "is", null),
          eb("daemon_session_id", "!=", currentDaemonSessionId),
        ]),
      )
      .execute();
  }

  async getSession(sessionUuid: string): Promise<DeviceSession | undefined> {
    const db = await this.getDb();
    return await db
      .selectFrom("device_sessions")
      .selectAll()
      .where("session_uuid", "=", sessionUuid)
      .executeTakeFirst();
  }

  /**
   * Delete terminal-state (`released`/`expired`) rows past the retention
   * window (#6464). `nowMs` is caller-supplied rather than an injected Timer
   * — this repository has no clock of its own, and every other timestamp on
   * this class is likewise supplied by the caller (`SessionManager`'s
   * `Timer`/`FakeTimer`) so the comparison stays consistent with the rest of
   * a session's lifecycle timestamps in tests. Best-effort: a failure here
   * must not block a new session from persisting.
   */
  private async pruneExpiredSessions(nowMs: number): Promise<void> {
    try {
      const db = await this.getDb();
      const cutoffMs = nowMs - DEVICE_SESSION_RETENTION_MAX_AGE_MS;
      await db
        .deleteFrom("device_sessions")
        .where("released_at_ms", "is not", null)
        .where("released_at_ms", "<", cutoffMs)
        .execute();
    } catch (error) {
      logger.warn(`[DeviceSessionRepository] Failed to prune expired sessions: ${error}`, error);
    }
  }
}
