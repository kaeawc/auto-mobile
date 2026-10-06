import {
  isRecoverableDaemonReleaseReason,
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession, DeviceSessionStatus } from "../../src/db/types";

export class FakeDeviceSessionPersistence implements DeviceSessionPersistence {
  failure: "create" | "release" | null = null;
  createFailureOnAttempt: number | null = null;
  private createAttempts = 0;
  private readonly rows = new Map<string, DeviceSession>();
  getSession?: (sessionUuid: string) => Promise<DeviceSession | undefined>;

  async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    this.createAttempts++;
    if (this.failure === "create" || this.createFailureOnAttempt === this.createAttempts) {
      throw new Error("persist create failed");
    }
    const existing = this.rows.get(record.sessionUuid);
    this.rows.set(record.sessionUuid, {
      session_uuid: record.sessionUuid,
      device_id: record.deviceId,
      stable_device_id: record.stableDeviceId ?? null,
      stable_identity_generation: (existing?.stable_identity_generation ?? 0) + 1,
      platform: record.platform,
      status: record.status ?? "active",
      source: record.source ?? null,
      autolock_enabled: record.autolockEnabled ? 1 : 0,
      mcp_session_id: record.mcpSessionId ?? null,
      daemon_session_id: record.daemonSessionId ?? null,
      created_at_ms: existing?.created_at_ms ?? record.createdAtMs,
      last_used_at_ms: record.lastUsedAtMs,
      expires_at_ms: record.expiresAtMs,
      released_at_ms: null,
      release_reason: null,
      session_timeout_ms: record.sessionTimeoutMs,
      heartbeat_timeout_ms: record.heartbeatTimeoutMs,
      heartbeat_timeout_source: record.heartbeatTimeoutSource ?? null,
      has_received_heartbeat: record.hasReceivedHeartbeat ? 1 : 0,
      liveness_policy: record.livenessPolicy ?? null,
      pre_cli_heartbeat_timeout_ms: record.preCliHeartbeatTimeoutMs ?? null,
      pre_cli_heartbeat_timeout_source: record.preCliHeartbeatTimeoutSource ?? null,
      pre_cli_session_timeout_ms: record.preCliSessionTimeoutMs ?? null,
      liveness_owner_token: existing?.liveness_owner_token ?? null,
      created_at: existing?.created_at ?? new Date(record.createdAtMs).toISOString(),
      updated_at: new Date(record.lastUsedAtMs).toISOString(),
    });
    this.enableSessionLookup();
  }

  private enableSessionLookup(): void {
    this.getSession = (sessionUuid) => Promise.resolve(this.rows.get(sessionUuid));
  }

  async listRecoverableSessions(): Promise<DeviceSession[]> {
    return Array.from(this.rows.values())
      .filter((row) => row.release_reason && isRecoverableDaemonReleaseReason(row.release_reason))
      .sort((a, b) => b.last_used_at_ms - a.last_used_at_ms);
  }

  async recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (!row || row.status !== "active") {
      return;
    }
    Object.assign(row, {
      last_used_at_ms: update.lastUsedAtMs,
      expires_at_ms: update.expiresAtMs,
      session_timeout_ms: update.sessionTimeoutMs,
      heartbeat_timeout_ms: update.heartbeatTimeoutMs,
      heartbeat_timeout_source: update.heartbeatTimeoutSource ?? null,
      has_received_heartbeat: update.hasReceivedHeartbeat ? 1 : 0,
      liveness_policy: update.livenessPolicy ?? null,
      pre_cli_heartbeat_timeout_ms: update.preCliHeartbeatTimeoutMs ?? null,
      pre_cli_heartbeat_timeout_source: update.preCliHeartbeatTimeoutSource ?? null,
      pre_cli_session_timeout_ms: update.preCliSessionTimeoutMs ?? null,
    });
  }

  async recordLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    await this.replaceLivenessOwnership(sessionUuid, ownerToken);
  }

  async replaceLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (!row || row.status !== "active") {
      return;
    }
    row.liveness_owner_token = ownerToken;
  }

  async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    if (this.failure === "release") {
      throw new Error("persist release failed");
    }
    const row = this.rows.get(sessionUuid);
    if (!row) {
      return;
    }
    row.status = status;
    row.released_at_ms = releasedAtMs;
    row.release_reason = reason;
    if (!isRecoverableDaemonReleaseReason(reason)) {
      row.liveness_owner_token = null;
    }
  }

  seed(row: DeviceSession): void {
    this.rows.set(row.session_uuid, row);
    this.enableSessionLookup();
  }
}
