import type { DaemonDeviceSessionStore } from "../../src/daemon/daemonDependencies";
import type { FaultPlan } from "./FaultPlan";
import { ignoresManagedExecutionIdleDeadline } from "../../src/models/managedExecutionLiveness";
import {
  isReissuableByNameReleaseReason,
  isTerminalReleaseReason,
  releaseReasonMayReplace,
} from "../../src/daemon/releaseReasons";
import {
  DeviceSessionNotActiveError,
  DeviceSessionRowChangedError,
  DeviceSessionRowNotRewritableError,
  DeviceSessionRowNotReleasableError,
  DeviceSessionTerminallyReleasedError,
  isDeviceRestartReleaseReason,
  isRecoverableDaemonReleaseReason,
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  persistedSessionExpiryReason,
  isRecoverableDeviceSession,
  type RecoverableRowIncarnation,
  type UpsertActiveSessionOptions,
} from "../../src/db/deviceSessionRepository";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import type { DeviceSession, DeviceSessionStatus } from "../../src/db/types";

export class FakeDeviceSessionPersistence implements DaemonDeviceSessionStore {
  faultPlan?: FaultPlan;
  failure: "create" | "release" | null = null;
  createFailureOnAttempt: number | null = null;
  private createAttempts = 0;
  private readonly rows = new Map<string, DeviceSession>();
  async getSession(sessionUuid: string): Promise<DeviceSession | undefined> {
    const fault = this.faultPlan?.enter("getSession");
    if (fault?.pause) {
      await fault.pause;
    }
    const row = this.rows.get(sessionUuid);
    this.faultPlan?.finish(fault);
    return row;
  }

  /** Mirrors the repository's claimed-row precondition: the incarnation and a re-issuable reason. */
  private matchesIncarnation(row: DeviceSession | undefined, expected: RecoverableRowIncarnation) {
    return (
      row !== undefined &&
      row.status !== "active" &&
      (row.stable_identity_generation ?? 0) === expected.rowGeneration &&
      (row.daemon_session_id ?? null) === expected.daemonSessionId &&
      row.release_reason !== null &&
      isReissuableByNameReleaseReason(row.release_reason)
    );
  }

  async claimRecoverableSession(
    sessionUuid: string,
    expected: RecoverableRowIncarnation,
    daemonSessionId: string,
  ): Promise<number | undefined> {
    const row = this.rows.get(sessionUuid);
    if (!row || !this.matchesIncarnation(row, expected)) {
      return undefined;
    }
    row.daemon_session_id = daemonSessionId;
    row.stable_identity_generation = (row.stable_identity_generation ?? 0) + 1;
    return row.stable_identity_generation;
  }

  async releaseRecoverableSessionClaim(
    sessionUuid: string,
    claimed: RecoverableRowIncarnation,
    previousOwner: string | null,
  ): Promise<boolean> {
    const row = this.rows.get(sessionUuid);
    if (!row || !this.matchesIncarnation(row, claimed)) {
      return false;
    }
    row.daemon_session_id = previousOwner;
    row.stable_identity_generation = (row.stable_identity_generation ?? 0) + 1;
    return true;
  }

  async upsertActiveSession(
    record: DeviceSessionRecord,
    _nowMs?: number,
    options: UpsertActiveSessionOptions = {},
  ): Promise<number> {
    const fault = this.faultPlan?.enter("upsertActiveSession");
    if (fault?.pause) {
      await fault.pause;
    }
    this.createAttempts++;
    if (this.failure === "create" || this.createFailureOnAttempt === this.createAttempts) {
      throw new Error("persist create failed");
    }
    const existing = this.rows.get(record.sessionUuid);
    if (options.claimedRow && !this.matchesIncarnation(existing, options.claimedRow)) {
      throw new DeviceSessionRowChangedError(record.sessionUuid);
    }
    const rewrite = options.rewriteOverSupersededRelease;
    if (rewrite && !options.claimedRow && existing) {
      const terminal =
        existing.release_reason !== null && isTerminalReleaseReason(existing.release_reason);
      const peerOwned =
        existing.daemon_session_id !== null &&
        rewrite.livePeerDaemonSessionIds.includes(existing.daemon_session_id);
      const otherOwned =
        rewrite.ownDaemonSessionId !== undefined &&
        existing.daemon_session_id !== null &&
        existing.daemon_session_id !== rewrite.ownDaemonSessionId;
      const changed =
        rewrite.expectedRowGeneration !== undefined &&
        existing.stable_identity_generation !== rewrite.expectedRowGeneration;
      const released = rewrite.unlessReleased && existing.status === "released";
      if (terminal || peerOwned || otherOwned || changed || released) {
        throw new DeviceSessionRowNotRewritableError(record.sessionUuid);
      }
    }
    // Like the repository's conflict guard: a terminally released row is never made active again.
    if (
      options.unlessTerminal &&
      !rewrite &&
      !options.claimedRow &&
      existing?.release_reason &&
      isTerminalReleaseReason(existing.release_reason)
    ) {
      throw new DeviceSessionTerminallyReleasedError(record.sessionUuid);
    }
    this.rows.set(record.sessionUuid, {
      session_uuid: record.sessionUuid,
      device_id: record.deviceId,
      stable_device_id: record.stableDeviceId ?? null,
      // Like the repository: a fresh insert starts at generation 0, a conflict update advances it.
      stable_identity_generation: existing ? (existing.stable_identity_generation ?? 0) + 1 : 0,
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
      heartbeat_timeout_source: record.heartbeatTimeoutSource ?? null,
      has_received_heartbeat: record.hasReceivedHeartbeat ? 1 : 0,
      liveness_policy: record.livenessPolicy ?? null,
      pre_cli_heartbeat_timeout_ms: record.preCliHeartbeatTimeoutMs ?? null,
      pre_cli_heartbeat_timeout_source: record.preCliHeartbeatTimeoutSource ?? null,
      pre_cli_session_timeout_ms: record.preCliSessionTimeoutMs ?? null,
      liveness_owner_token: existing?.liveness_owner_token ?? null,
      // Like the repository's conflict update: every upsert marks a current liveness write.
      liveness_contract_generation: existing ? (existing.liveness_contract_generation ?? 0) + 1 : 0,
      created_at: existing?.created_at ?? new Date(record.createdAtMs).toISOString(),
      updated_at: new Date(record.lastUsedAtMs).toISOString(),
    });
    this.faultPlan?.finish(fault);
    return this.rows.get(record.sessionUuid)!.stable_identity_generation ?? 0;
  }

  async listRecoverableSessions(
    nowMs?: number,
    livePeerDaemonSessionIds: () => readonly string[] = () => [],
  ): Promise<DeviceSession[]> {
    const rows = Array.from(this.rows.values()).filter(
      (row) => row.release_reason && isRecoverableDaemonReleaseReason(row.release_reason),
    );
    if (nowMs !== undefined) {
      for (const row of rows) {
        const reason = persistedSessionExpiryReason(row, nowMs);
        const peers =
          reason &&
          isDeviceRestartReleaseReason(row.release_reason!) &&
          row.released_at_ms !== null &&
          nowMs >= row.released_at_ms + DEFAULT_DEVICE_READY_TIMEOUT_MS
            ? livePeerDaemonSessionIds()
            : [];
        if (reason && !peers.includes(row.daemon_session_id ?? "")) {
          await this.markReleased(row.session_uuid, "expired", nowMs, reason, {
            expectedRowGeneration: row.stable_identity_generation ?? 0,
            onlyIfRecoverable: true,
            ...(reason === "restart-recovery-timeout"
              ? {
                  onlyIfRestartRecoveryHandoff: {
                    releasedAtOrBeforeMs: nowMs - DEFAULT_DEVICE_READY_TIMEOUT_MS,
                    recoveryWindowMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
                  },
                }
              : { onlyIfExpiredAtMs: nowMs }),
            unlessTerminalOrOwnedByLivePeer: { livePeerDaemonSessionIds: peers },
          });
        }
      }
    }
    return rows
      .filter(
        (row) =>
          row.release_reason &&
          isRecoverableDaemonReleaseReason(row.release_reason) &&
          (nowMs === undefined ||
            (isRecoverableDeviceSession(row, nowMs) && !persistedSessionExpiryReason(row, nowMs))),
      )
      .sort((a, b) => b.last_used_at_ms - a.last_used_at_ms);
  }

  async recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    const fault = this.faultPlan?.enter("recordActivity");
    if (fault?.pause) {
      await fault.pause;
    }
    const row = this.rows.get(sessionUuid);
    if (!row || row.status !== "active") {
      // Mirrors DeviceSessionRepository: zero matched rows is a failure (#11129).
      throw new DeviceSessionNotActiveError(sessionUuid);
    }
    const seq = update.activitySeq ?? update.lastUsedAtMs;
    // Like the repository: every accepted write advances the liveness contract generation, even
    // when a newer activity_seq keeps the stored deadlines.
    row.liveness_contract_generation = (row.liveness_contract_generation ?? 0) + 1;
    if ((row.activity_seq ?? 0) > seq) {
      this.faultPlan?.finish(fault);
      return;
    }
    Object.assign(row, {
      activity_seq: Math.max(row.activity_seq ?? 0, seq),
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
    this.faultPlan?.finish(fault);
  }

  async recordRestartRecoveryActivity(sessionUuid: string, activityAtMs: number): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (
      !row?.release_reason ||
      !isDeviceRestartReleaseReason(row.release_reason) ||
      row.released_at_ms === null
    ) {
      return;
    }
    row.expires_at_ms = Math.max(row.expires_at_ms, activityAtMs + row.session_timeout_ms);
  }

  async recordLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    await this.replaceLivenessOwnership(sessionUuid, ownerToken);
  }

  async replaceLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (!row || row.status !== "active") {
      throw new DeviceSessionNotActiveError(sessionUuid);
    }
    row.liveness_owner_token = ownerToken;
  }

  async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options: MarkReleasedOptions = {},
  ): Promise<void> {
    const fault = this.faultPlan?.enter("markReleased");
    if (fault?.pause) {
      await fault.pause;
    }
    try {
      if (this.failure === "release") {
        throw new Error("persist release failed");
      }
      const row = this.rows.get(sessionUuid);
      if (options.unlessDaemonShutdown && (!row || row.release_reason === "daemon-shutdown")) {
        throw new DeviceSessionRowNotReleasableError(sessionUuid);
      }
      const guarded = options.unlessTerminalOrOwnedByLivePeer;
      if (
        guarded &&
        (!row ||
          (row.release_reason !== null &&
            isTerminalReleaseReason(row.release_reason) &&
            !guarded.supersededReasons?.includes(row.release_reason)) ||
          (row.daemon_session_id !== null &&
            (guarded.livePeerDaemonSessionIds.includes(row.daemon_session_id) ||
              (guarded.ownDaemonSessionId !== undefined &&
                row.daemon_session_id !== guarded.ownDaemonSessionId))))
      ) {
        if (
          options.unlessDaemonShutdown ||
          options.expectedRowGeneration === undefined ||
          guarded.reportRefusal ||
          guarded.ownDaemonSessionId !== undefined
        ) {
          throw new DeviceSessionRowNotReleasableError(sessionUuid);
        }
        return;
      }
      if (!row) {
        return;
      }
      if (
        (options.expectedRowGeneration !== undefined &&
          (row.stable_identity_generation ?? 0) !== options.expectedRowGeneration) ||
        // A terminal reason is never replaced by a weaker one.
        !releaseReasonMayReplace(reason, row.release_reason) ||
        (options.onlyIfRecoverable &&
          !(row.release_reason && isRecoverableDaemonReleaseReason(row.release_reason))) ||
        // Like the repository's statement: a deadline extended past the instant is not released.
        (options.onlyIfRestartRecoveryHandoff !== undefined &&
          (!row.release_reason ||
            !isDeviceRestartReleaseReason(row.release_reason) ||
            row.released_at_ms === null ||
            row.released_at_ms > options.onlyIfRestartRecoveryHandoff.releasedAtOrBeforeMs ||
            (!ignoresManagedExecutionIdleDeadline(row.liveness_policy) &&
              row.expires_at_ms <=
                row.released_at_ms + options.onlyIfRestartRecoveryHandoff.recoveryWindowMs))) ||
        (options.onlyIfExpiredAtMs !== undefined &&
          (ignoresManagedExecutionIdleDeadline(row.liveness_policy) ||
            row.expires_at_ms > options.onlyIfExpiredAtMs)) ||
        (options.onlyIfOwnedByDaemon !== undefined &&
          row.daemon_session_id !== options.onlyIfOwnedByDaemon)
      ) {
        if (options.unlessDaemonShutdown) {
          throw new DeviceSessionRowNotReleasableError(sessionUuid);
        }
        if (
          guarded &&
          (options.expectedRowGeneration === undefined ||
            guarded.reportRefusal ||
            guarded.ownDaemonSessionId !== undefined)
        ) {
          throw new DeviceSessionRowNotReleasableError(sessionUuid);
        }
        return;
      }
      row.status = status;
      row.released_at_ms = releasedAtMs;
      row.release_reason = reason;
      if (!isRecoverableDaemonReleaseReason(reason)) {
        row.liveness_owner_token = null;
      }
    } finally {
      this.faultPlan?.finish(fault);
    }
  }

  /** Mirrors the repository: only a live row is updated, and a newer activity snapshot wins. */
  async markAutolockSession(
    sessionUuid: string,
    input: {
      mcpSessionId?: string | null;
      daemonSessionId?: string | null;
      lastUsedAtMs: number;
      activitySeq?: number;
      expiresAtMs: number;
    },
  ): Promise<void> {
    const row = this.rows.get(sessionUuid);
    if (!row || row.status !== "active") {
      return;
    }
    const seq = input.activitySeq ?? input.lastUsedAtMs;
    const stale = (row.activity_seq ?? 0) > seq;
    Object.assign(row, {
      source: "autolock",
      autolock_enabled: 1,
      mcp_session_id: input.mcpSessionId ?? null,
      daemon_session_id: input.daemonSessionId ?? null,
      activity_seq: Math.max(row.activity_seq ?? 0, seq),
      last_used_at_ms: stale ? row.last_used_at_ms : input.lastUsedAtMs,
      expires_at_ms: stale ? row.expires_at_ms : input.expiresAtMs,
      released_at_ms: null,
      release_reason: null,
    });
  }

  /**
   * Mirrors the repository's expiry of active rows a daemon no longer owns: rows of a different,
   * dead daemon, and ownerless legacy rows (spared while a peer is live and their lease is
   * unexpired, or they hold a managed-execution policy).
   */
  async markStaleActiveSessionsExpired(
    currentDaemonSessionId: string,
    releasedAtMs: number,
    reason: string = "daemon-restart",
    liveDaemonSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const hasLivePeer = [...liveDaemonSessionIds].some((id) => id !== currentDaemonSessionId);
    for (const row of this.rows.values()) {
      const owner = row.daemon_session_id ?? null;
      const deadOwner =
        owner !== null &&
        owner !== currentDaemonSessionId &&
        (liveDaemonSessionIds.size === 0 || !liveDaemonSessionIds.has(owner));
      const reclaimableNullOwner =
        owner === null &&
        (!hasLivePeer ||
          (!ignoresManagedExecutionIdleDeadline(row.liveness_policy) &&
            row.expires_at_ms <= releasedAtMs));
      if (row.status !== "active" || !(deadOwner || reclaimableNullOwner)) {
        continue;
      }
      row.status = "expired";
      row.released_at_ms = releasedAtMs;
      row.release_reason = reason;
      if (!isRecoverableDaemonReleaseReason(reason)) {
        row.liveness_owner_token = null;
      }
    }
  }

  seed(row: DeviceSession): void {
    this.rows.set(row.session_uuid, row);
  }
}
