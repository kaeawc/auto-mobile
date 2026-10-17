import {
  DeviceSessionNotActiveError,
  DeviceSessionRepository,
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  isDeviceRestartReleaseReason,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession, DeviceSessionStatus } from "../../src/db/types";

/**
 * In-memory session persistence for daemon tests, held to the same behavioural contract as the
 * SQLite repository for create, read, release, restart-handoff release and activity
 * (test/contracts/DeviceSessionPersistenceContract.ts). Release-reason strength, claims and
 * ownership guards are not modelled; the remaining methods are inert.
 */
export class FakeDeviceSessionRepository
  extends DeviceSessionRepository
  implements DeviceSessionRepository
{
  private readonly rows = new Map<string, DeviceSession>();
  readonly released: string[] = [];
  readonly events: string[] = [];
  readonly sessions = new Map<
    string,
    { status: DeviceSessionStatus; releasedAtMs: number | null; reason: string | null }
  >();

  override async getSession(sessionUuid: string): Promise<DeviceSession | undefined> {
    const row = this.rows.get(sessionUuid);
    return row ? { ...row } : undefined;
  }

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<number> {
    const existing = this.rows.get(record.sessionUuid);
    const generation = existing ? (existing.stable_identity_generation ?? 0) + 1 : 0;
    const now = new Date(record.lastUsedAtMs).toISOString();
    this.rows.set(record.sessionUuid, {
      session_uuid: record.sessionUuid,
      device_id: record.deviceId,
      stable_device_id: record.stableDeviceId ?? null,
      stable_identity_generation: generation,
      platform: record.platform,
      status: record.status ?? "active",
      source: record.source ?? null,
      autolock_enabled: record.autolockEnabled ? 1 : 0,
      mcp_session_id: record.mcpSessionId ?? null,
      daemon_session_id: record.daemonSessionId ?? null,
      created_at_ms: existing?.created_at_ms ?? record.createdAtMs,
      last_used_at_ms: record.lastUsedAtMs,
      activity_seq: record.activitySeq ?? record.lastUsedAtMs,
      expires_at_ms: record.expiresAtMs,
      released_at_ms: null,
      release_reason: null,
      session_timeout_ms: record.sessionTimeoutMs,
      heartbeat_timeout_ms: record.heartbeatTimeoutMs,
      liveness_contract_generation: (existing?.liveness_contract_generation ?? 0) + 1,
      heartbeat_timeout_source: record.heartbeatTimeoutSource ?? null,
      has_received_heartbeat: record.hasReceivedHeartbeat ? 1 : 0,
      liveness_policy: record.livenessPolicy ?? null,
      pre_cli_heartbeat_timeout_ms: record.preCliHeartbeatTimeoutMs ?? null,
      pre_cli_heartbeat_timeout_source: record.preCliHeartbeatTimeoutSource ?? null,
      pre_cli_session_timeout_ms: record.preCliSessionTimeoutMs ?? null,
      liveness_owner_token: null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    this.sessions.set(record.sessionUuid, { status: "active", releasedAtMs: null, reason: null });
    return generation;
  }

  override async replaceLivenessOwnership(): Promise<void> {}

  override async markAutolockSession(): Promise<void> {}

  override async recordActivity(
    sessionUuid: string,
    update: DeviceSessionActivityUpdate,
  ): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (!row || row.status !== "active") {
      throw new DeviceSessionNotActiveError(sessionUuid);
    }
    row.last_used_at_ms = update.lastUsedAtMs;
    row.activity_seq = Math.max(row.activity_seq, update.activitySeq ?? update.lastUsedAtMs);
    row.expires_at_ms = update.expiresAtMs;
    row.session_timeout_ms = update.sessionTimeoutMs;
    row.heartbeat_timeout_ms = update.heartbeatTimeoutMs;
    row.has_received_heartbeat = update.hasReceivedHeartbeat ? 1 : 0;
  }

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options: MarkReleasedOptions = {},
  ): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (!row) {
      return;
    }
    const handoff = options.onlyIfRestartRecoveryHandoff;
    if (
      handoff &&
      (!row.release_reason ||
        !isDeviceRestartReleaseReason(row.release_reason) ||
        row.released_at_ms === null ||
        row.released_at_ms > handoff.releasedAtOrBeforeMs ||
        (row.liveness_policy !== "managed-execution" &&
          row.expires_at_ms <= row.released_at_ms + handoff.recoveryWindowMs))
    ) {
      return;
    }
    row.status = status;
    row.released_at_ms = releasedAtMs;
    row.release_reason = reason;
    this.released.push(sessionUuid);
    this.events.push("markReleased");
    this.sessions.set(sessionUuid, { status, releasedAtMs, reason });
  }

  override async markStaleActiveSessionsExpired(): Promise<void> {}
}
