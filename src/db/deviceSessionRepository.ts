import type { Kysely } from "kysely";
import { ensureMigrations, getDatabase } from "./database";
import type { Database, DeviceSession, DeviceSessionStatus, NewDeviceSession } from "./types";
import { logger } from "../utils/logger";
import type { Platform } from "../models";

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

  private async getDb(): Promise<Kysely<Database>> {
    if (this.db) {
      return this.db;
    }
    await ensureMigrations();
    return getDatabase();
  }

  async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
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
        .onConflict(oc =>
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
          })
        )
        .execute();
    } catch (error) {
      logger.warn(`[DeviceSessionRepository] Failed to upsert device session ${record.sessionUuid}: ${error}`);
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
      logger.warn(`[DeviceSessionRepository] Failed to record activity for ${sessionUuid}: ${error}`);
    }
  }

  async markAutolockSession(
    sessionUuid: string,
    input: {
      mcpSessionId?: string | null;
      daemonSessionId?: string | null;
      lastUsedAtMs: number;
      expiresAtMs: number;
    }
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
      logger.warn(`[DeviceSessionRepository] Failed to mark autolock session ${sessionUuid}: ${error}`);
    }
  }

  async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string
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
      logger.warn(`[DeviceSessionRepository] Failed to mark session ${sessionUuid} ${status}: ${error}`);
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
    reason: string = "daemon-restart"
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
      .where(eb =>
        eb.or([
          eb("daemon_session_id", "is", null),
          eb("daemon_session_id", "!=", currentDaemonSessionId),
        ])
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
}
