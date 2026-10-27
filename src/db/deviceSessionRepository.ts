import { sql, type ExpressionBuilder, type Kysely } from "kysely";
import { toActionableError } from "../models/ActionableError";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  ignoresManagedExecutionIdleDeadline,
} from "../models/managedExecutionLiveness";
import {
  isRecoverableDaemonReleaseReason,
  literalReleaseReasonsStrongerThan,
  literalReleaseReasonsWhere,
  releaseReasonFamiliesStrongerThan,
  releaseReasonFamiliesWhere,
  releaseReasonStrength,
  sessionReleaseReasonFamily,
  type SessionReleaseReasonFamily,
} from "../models/releaseReasons";
import { errorMessage } from "../utils/describeUnknownError";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getDatabase } from "./database";
import { DeviceSessionNotActiveError } from "./DeviceSessionNotActiveError";
import {
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  type RecoverableRowIncarnation,
  type UpsertActiveSessionOptions,
} from "./deviceSessionPersistence";
import { DeviceSessionRowChangedError } from "./DeviceSessionRowChangedError";
import { DeviceSessionRowNotReleasableError } from "./DeviceSessionRowNotReleasableError";
import { DeviceSessionRowNotRewritableError } from "./DeviceSessionRowNotRewritableError";
import { DeviceSessionTerminallyReleasedError } from "./DeviceSessionTerminallyReleasedError";
import { nowIso } from "./nowIso";
import type { Database, DeviceSession, DeviceSessionStatus, NewDeviceSession } from "./types";
export { DeviceSessionNotActiveError } from "./DeviceSessionNotActiveError";
export {
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  type RecoverableRowIncarnation,
  type UpsertActiveSessionOptions,
} from "./deviceSessionPersistence";
export { DeviceSessionRowChangedError } from "./DeviceSessionRowChangedError";
export { DeviceSessionRowNotReleasableError } from "./DeviceSessionRowNotReleasableError";
export { DeviceSessionRowNotRewritableError } from "./DeviceSessionRowNotRewritableError";
export { DeviceSessionTerminallyReleasedError } from "./DeviceSessionTerminallyReleasedError";

// Terminal-state (`released`/`expired`) rows accumulate for the life of the
// on-disk DB with no delete path (#6464). Bound their retention window rather
// than adding a new column: `released_at_ms` is already set at the same time a
// row transitions terminal (by both `markReleased` and
// `markStaleActiveSessionsExpired`), so it is a reliable "became terminal" age
// marker without a migration.
export const DEVICE_SESSION_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The literal recoverable release reasons, from the release-reason table (#11258). */
export const RECOVERABLE_DAEMON_RELEASE_REASONS: ReadonlySet<string> = new Set(
  literalReleaseReasonsWhere("recoverable"),
);
export const DEVICE_RESTART_RELEASE_REASON_PREFIX =
  "device-restart:" satisfies SessionReleaseReasonFamily;

export function deviceRestartReleaseReason(stableDeviceId: string): `device-restart:${string}` {
  return `${DEVICE_RESTART_RELEASE_REASON_PREFIX}${stableDeviceId}`;
}

export function isDeviceRestartReleaseReason(reason: string): boolean {
  return sessionReleaseReasonFamily(reason) === DEVICE_RESTART_RELEASE_REASON_PREFIX;
}

export { isRecoverableDaemonReleaseReason };

export function isRecoverableDeviceSession(session: DeviceSession, nowMs: number): boolean {
  const retentionCutoffMs = nowMs - DEVICE_SESSION_RETENTION_MAX_AGE_MS;
  return (
    (ignoresManagedExecutionIdleDeadline(session.liveness_policy) ||
      session.expires_at_ms > nowMs) &&
    (session.released_at_ms === null || session.released_at_ms >= retentionCutoffMs)
  );
}

/** The first deadline that ended an unresumed handoff, independent of when it is read. */
export function persistedSessionExpiryReason(
  session: DeviceSession,
  nowMs: number,
): "expired" | "restart-recovery-timeout" | undefined {
  if (
    session.release_reason &&
    isDeviceRestartReleaseReason(session.release_reason) &&
    session.released_at_ms !== null
  ) {
    const windowEnd = session.released_at_ms + DEFAULT_DEVICE_READY_TIMEOUT_MS;
    if (
      (ignoresManagedExecutionIdleDeadline(session.liveness_policy) ||
        windowEnd < session.expires_at_ms) &&
      nowMs >= windowEnd
    ) {
      return "restart-recovery-timeout";
    }
  }
  return (!ignoresManagedExecutionIdleDeadline(session.liveness_policy) &&
    session.expires_at_ms <= nowMs) ||
    session.release_reason === "expired"
    ? "expired"
    : undefined;
}

/** SQL form of the shared managed-execution idle-deadline exception (legacy null is plain). */
function hasApplicableIdleDeadline(eb: ExpressionBuilder<Database, "device_sessions">) {
  return eb.or([
    eb("liveness_policy", "is", null),
    eb("liveness_policy", "!=", MANAGED_EXECUTION_LIVENESS_POLICY),
  ]);
}

/** SQL form of {@link isRecoverableDaemonReleaseReason} on `device_sessions.release_reason`. */
function hasRecoverableReleaseReason(eb: ExpressionBuilder<Database, "device_sessions">) {
  return eb.or([
    eb("release_reason", "in", Array.from(RECOVERABLE_DAEMON_RELEASE_REASONS)),
    ...releaseReasonFamiliesWhere("recoverable").map((family) =>
      eb("release_reason", "like", `${family}_%`),
    ),
  ]);
}

/**
 * SQL form of "the stored reason is stronger than `candidate`" (see `releaseReasonMayReplace`): a
 * release with `candidate` must not be applied to such a row.
 */
function holdsStrongerReleaseReason(
  eb: ExpressionBuilder<Database, "device_sessions">,
  candidate: string,
) {
  const strength = releaseReasonStrength(candidate);
  const literals = literalReleaseReasonsStrongerThan(strength);
  return eb.or([
    ...(literals.length > 0 ? [eb("release_reason", "in", literals)] : []),
    ...releaseReasonFamiliesStrongerThan(strength).map((family) =>
      eb("release_reason", "like", `${family}_%`),
    ),
  ]);
}

/**
 * SQL form of {@link isReissuableByNameReleaseReason}: the rows a call naming the UUID may claim
 * and re-issue. Used by the claim, its hand-back and the claimed-row upsert fence, so all three
 * accept the same set.
 */
function hasReissuableByNameReleaseReason(eb: ExpressionBuilder<Database, "device_sessions">) {
  return eb.or([
    eb("release_reason", "in", literalReleaseReasonsWhere("reissuableByName")),
    ...releaseReasonFamiliesWhere("reissuableByName").map((family) =>
      eb("release_reason", "like", `${family}_%`),
    ),
  ]);
}

/**
 * SQL form of {@link isTerminalReleaseReason} on `device_sessions.release_reason`: the rows whose
 * UUID has ended. A row with no reason, or released for any non-terminal one (a recoverable
 * handoff, `plan-auto-release`, `expired`, a reason this build does not know), does not match.
 */
function hasTerminalReleaseReason(eb: ExpressionBuilder<Database, "device_sessions">) {
  return eb.or([
    eb("release_reason", "in", literalReleaseReasonsWhere("terminal")),
    ...releaseReasonFamiliesWhere("terminal").map((family) =>
      eb("release_reason", "like", `${family}_%`),
    ),
  ]);
}

/** The shared statement predicate: null/dead owners are writable, live peers are not. */
function livePeerOwnerGuard(
  eb: ExpressionBuilder<Database, "device_sessions">,
  livePeerDaemonSessionIds: readonly string[],
) {
  return livePeerDaemonSessionIds.length > 0
    ? [
        eb.or([
          eb("device_sessions.daemon_session_id", "is", null),
          eb("device_sessions.daemon_session_id", "not in", livePeerDaemonSessionIds),
        ]),
      ]
    : [];
}

/** The release and live-row rewrite share the terminal-reason and live-peer predicates. */
function rowRewriteGuard(
  eb: ExpressionBuilder<Database, "device_sessions">,
  supersededReasons: readonly string[],
  livePeerDaemonSessionIds: readonly string[],
  ownDaemonSessionId?: string,
) {
  return eb.and([
    eb.or([
      eb("device_sessions.release_reason", "is", null),
      eb.not(hasTerminalReleaseReason(eb)),
      ...(supersededReasons.length > 0
        ? [eb("device_sessions.release_reason", "in", supersededReasons)]
        : []),
    ]),
    ...livePeerOwnerGuard(eb, livePeerDaemonSessionIds),
    ...(ownDaemonSessionId === undefined
      ? []
      : [
          eb.or([
            eb("device_sessions.daemon_session_id", "is", null),
            eb("device_sessions.daemon_session_id", "=", ownDaemonSessionId),
          ]),
        ]),
  ]);
}

function shouldRetainLivenessOwner(reason: string): boolean {
  return isRecoverableDaemonReleaseReason(reason);
}

type LivenessPersistenceInput = Pick<
  DeviceSessionRecord,
  | "heartbeatTimeoutSource"
  | "hasReceivedHeartbeat"
  | "livenessPolicy"
  | "preCliHeartbeatTimeoutMs"
  | "preCliHeartbeatTimeoutSource"
  | "preCliSessionTimeoutMs"
>;

function livenessColumns(
  input: LivenessPersistenceInput,
): Pick<
  NewDeviceSession,
  | "heartbeat_timeout_source"
  | "has_received_heartbeat"
  | "liveness_policy"
  | "pre_cli_heartbeat_timeout_ms"
  | "pre_cli_heartbeat_timeout_source"
  | "pre_cli_session_timeout_ms"
> {
  return {
    heartbeat_timeout_source: input.heartbeatTimeoutSource ?? null,
    has_received_heartbeat: input.hasReceivedHeartbeat ? 1 : 0,
    liveness_policy: input.livenessPolicy ?? null,
    pre_cli_heartbeat_timeout_ms: input.preCliHeartbeatTimeoutMs ?? null,
    pre_cli_heartbeat_timeout_source: input.preCliHeartbeatTimeoutSource ?? null,
    pre_cli_session_timeout_ms: input.preCliSessionTimeoutMs ?? null,
  };
}

function livenessColumnsFromRow(
  row: Pick<
    NewDeviceSession,
    | "heartbeat_timeout_source"
    | "has_received_heartbeat"
    | "liveness_policy"
    | "pre_cli_heartbeat_timeout_ms"
    | "pre_cli_heartbeat_timeout_source"
    | "pre_cli_session_timeout_ms"
  >,
): Pick<
  NewDeviceSession,
  | "heartbeat_timeout_source"
  | "has_received_heartbeat"
  | "liveness_policy"
  | "pre_cli_heartbeat_timeout_ms"
  | "pre_cli_heartbeat_timeout_source"
  | "pre_cli_session_timeout_ms"
> {
  return {
    heartbeat_timeout_source: row.heartbeat_timeout_source,
    has_received_heartbeat: row.has_received_heartbeat,
    liveness_policy: row.liveness_policy,
    pre_cli_heartbeat_timeout_ms: row.pre_cli_heartbeat_timeout_ms,
    pre_cli_heartbeat_timeout_source: row.pre_cli_heartbeat_timeout_source,
    pre_cli_session_timeout_ms: row.pre_cli_session_timeout_ms,
  };
}

/**
 * SET value for an activity column that only an activity at least as recent as the row's may
 * overwrite (#11129). A BUSY-retried write can land after a later one; the process-local
 * activity sequence orders writes even across wall-clock steps (#11497). The older write leaves
 * the newer lease alone while still matching the row, so it is not mistaken for a missing row.
 * SQLite evaluates every SET expression against the pre-update row.
 */
function activityColumnsUnlessStale(update: DeviceSessionActivityUpdate) {
  const at = update.activitySeq ?? update.lastUsedAtMs;
  const liveness = livenessColumns(update);
  return {
    activity_seq: sql<number>`max(activity_seq, ${at})`,
    last_used_at_ms: unlessStale("last_used_at_ms", at, update.lastUsedAtMs),
    expires_at_ms: unlessStale("expires_at_ms", at, update.expiresAtMs),
    session_timeout_ms: unlessStale("session_timeout_ms", at, update.sessionTimeoutMs),
    heartbeat_timeout_ms: unlessStale("heartbeat_timeout_ms", at, update.heartbeatTimeoutMs),
    heartbeat_timeout_source: unlessStale(
      "heartbeat_timeout_source",
      at,
      liveness.heartbeat_timeout_source,
    ),
    has_received_heartbeat: unlessStale(
      "has_received_heartbeat",
      at,
      liveness.has_received_heartbeat,
    ),
    liveness_policy: unlessStale("liveness_policy", at, liveness.liveness_policy),
    pre_cli_heartbeat_timeout_ms: unlessStale(
      "pre_cli_heartbeat_timeout_ms",
      at,
      liveness.pre_cli_heartbeat_timeout_ms,
    ),
    pre_cli_heartbeat_timeout_source: unlessStale(
      "pre_cli_heartbeat_timeout_source",
      at,
      liveness.pre_cli_heartbeat_timeout_source,
    ),
    pre_cli_session_timeout_ms: unlessStale(
      "pre_cli_session_timeout_ms",
      at,
      liveness.pre_cli_session_timeout_ms,
    ),
  };
}

function unlessStale<T>(column: string, activitySeq: number, value: T) {
  return sql<T>`CASE WHEN activity_seq > ${activitySeq} THEN ${sql.ref(column)} ELSE ${value} END`;
}

/** The row an upsert of `record` inserts; `nowIso` stamps its audit columns. */
function newActiveSessionRow(record: DeviceSessionRecord, nowIso: string): NewDeviceSession {
  return {
    session_uuid: record.sessionUuid,
    device_id: record.deviceId,
    stable_device_id: record.stableDeviceId ?? null,
    stable_identity_generation: 0,
    platform: record.platform,
    status: record.status ?? "active",
    source: record.source ?? null,
    autolock_enabled: record.autolockEnabled ? 1 : 0,
    mcp_session_id: record.mcpSessionId ?? null,
    daemon_session_id: record.daemonSessionId ?? null,
    created_at_ms: record.createdAtMs,
    last_used_at_ms: record.lastUsedAtMs,
    activity_seq: record.activitySeq ?? record.lastUsedAtMs,
    expires_at_ms: record.expiresAtMs,
    released_at_ms: null,
    release_reason: null,
    session_timeout_ms: record.sessionTimeoutMs,
    heartbeat_timeout_ms: record.heartbeatTimeoutMs,
    ...livenessColumns(record),
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export class DeviceSessionRepository implements DeviceSessionPersistence {
  private db: Kysely<Database> | null;

  constructor(
    db?: Kysely<Database>,
    private readonly timer: Timer = defaultTimer,
  ) {
    this.db = db ?? null;
  }

  // Migration gating is owned by startup (ensureMigrations) plus the app dialect
  // first-query gate (waitForMigrationsBeforeQuery, #6703); a repository helper
  // must NOT await ensureMigrations itself. Resolve the injected executor, else
  // the singleton, synchronously.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs: number = this.timer.now(),
    options: UpsertActiveSessionOptions = {},
  ): Promise<number> {
    const { claimedRow, unlessTerminal, rewriteOverSupersededRelease } = options;
    // A cheap, unconditional, indexed range
    // delete run before the write rather than gated behind amortization —
    // session starts are far less frequent than the amortized-per-insert
    // tables (#6464). Self-contained: a prune failure must never block a new
    // session from being persisted, so it swallows its own errors.
    await this.pruneExpiredSessions(nowMs);
    let written: { stable_identity_generation?: number } | undefined;
    try {
      const db = await this.getDb();
      const now = nowIso(this.timer);
      const row = newActiveSessionRow(record, now);

      written = await db
        .insertInto("device_sessions")
        .values(row)
        .onConflict((oc) => {
          const update = oc.column("session_uuid").doUpdateSet({
            device_id: row.device_id,
            stable_device_id: row.stable_device_id,
            // Distinguishes this writer from a forward-compatible older binary
            // that preserves columns it does not know. The migration trigger
            // clears stale stable_device_id evidence after such a rebind.
            stable_identity_generation: sql`stable_identity_generation + 1`,
            platform: row.platform,
            status: row.status,
            source: row.source,
            autolock_enabled: row.autolock_enabled,
            mcp_session_id: row.mcp_session_id,
            daemon_session_id: row.daemon_session_id,
            last_used_at_ms: row.last_used_at_ms,
            activity_seq: row.activity_seq,
            expires_at_ms: row.expires_at_ms,
            released_at_ms: null,
            release_reason: null,
            session_timeout_ms: row.session_timeout_ms,
            heartbeat_timeout_ms: row.heartbeat_timeout_ms,
            ...livenessColumnsFromRow(row),
            liveness_contract_generation: sql`liveness_contract_generation + 1`,
            updated_at: now,
          });
          if (!claimedRow) {
            if (rewriteOverSupersededRelease) {
              const { livePeerDaemonSessionIds, expectedRowGeneration } =
                rewriteOverSupersededRelease;
              return update.where((eb) =>
                eb.and([
                  rowRewriteGuard(
                    eb,
                    [],
                    livePeerDaemonSessionIds,
                    rewriteOverSupersededRelease.ownDaemonSessionId,
                  ),
                  ...(rewriteOverSupersededRelease.unlessReleased
                    ? [eb("device_sessions.status", "!=", "released")]
                    : []),
                  ...(expectedRowGeneration === undefined
                    ? []
                    : [
                        eb(
                          "device_sessions.stable_identity_generation",
                          "=",
                          expectedRowGeneration,
                        ),
                      ]),
                ]),
              );
            }
            return unlessTerminal
              ? update.where((eb) =>
                  eb.or([
                    eb("device_sessions.release_reason", "is", null),
                    eb.not(hasTerminalReleaseReason(eb)),
                  ]),
                )
              : update;
          }
          // A claimed row is re-issuable by name, which no terminal reason is.
          return update
            .where("device_sessions.status", "!=", "active")
            .where("device_sessions.stable_identity_generation", "=", claimedRow.rowGeneration)
            .where((eb) =>
              claimedRow.daemonSessionId === null
                ? eb("device_sessions.daemon_session_id", "is", null)
                : eb("device_sessions.daemon_session_id", "=", claimedRow.daemonSessionId),
            )
            .where((eb) => hasReissuableByNameReleaseReason(eb));
        })
        .returning("stable_identity_generation")
        .executeTakeFirst();
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to upsert device session ${record.sessionUuid}: ${error}`,
      );
      throw error;
    }
    if (!written) {
      // The row's precondition failed: an expected race outcome, not a storage failure.
      if (claimedRow) {
        throw new DeviceSessionRowChangedError(record.sessionUuid);
      }
      throw rewriteOverSupersededRelease
        ? new DeviceSessionRowNotRewritableError(record.sessionUuid)
        : new DeviceSessionTerminallyReleasedError(record.sessionUuid);
    }
    return written.stable_identity_generation ?? 0;
  }

  async recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    let updatedRows: number;
    try {
      const db = await this.getDb();
      const result = await db
        .updateTable("device_sessions")
        .set({
          ...activityColumnsUnlessStale(update),
          // Mark every current liveness write. The forward-compatibility trigger
          // clears this contract only when an older binary updates legacy
          // liveness columns without advancing this generation.
          liveness_contract_generation: sql`liveness_contract_generation + 1`,
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "=", "active")
        .executeTakeFirst();
      updatedRows = Number(result.numUpdatedRows);
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to record activity for ${sessionUuid}: ${error}`,
      );
      throw toActionableError(error, `Failed to record activity for session ${sessionUuid}`);
    }
    if (updatedRows === 0) {
      throw new DeviceSessionNotActiveError(sessionUuid);
    }
  }

  async recordRestartRecoveryActivity(sessionUuid: string, activityAtMs: number): Promise<void> {
    try {
      const db = await this.getDb();
      await db
        .updateTable("device_sessions")
        .set({
          expires_at_ms: sql<number>`max(expires_at_ms, ${activityAtMs} + session_timeout_ms)`,
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("release_reason", "like", `${DEVICE_RESTART_RELEASE_REASON_PREFIX}%`)
        .where("released_at_ms", "is not", null)
        .execute();
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to record restart-recovery activity for session ${sessionUuid}`,
      );
    }
  }

  async claimRecoverableSession(
    sessionUuid: string,
    expected: RecoverableRowIncarnation,
    daemonSessionId: string,
  ): Promise<number | undefined> {
    try {
      const claimed = await this.getDb()
        .updateTable("device_sessions")
        .set({
          daemon_session_id: daemonSessionId,
          stable_identity_generation: sql`stable_identity_generation + 1`,
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "!=", "active")
        .where("stable_identity_generation", "=", expected.rowGeneration)
        .where((eb) =>
          expected.daemonSessionId === null
            ? eb("daemon_session_id", "is", null)
            : eb("daemon_session_id", "=", expected.daemonSessionId),
        )
        // Only a row a call naming the UUID may issue again; any other row is left untouched.
        .where((eb) => hasReissuableByNameReleaseReason(eb))
        .returning("stable_identity_generation")
        .executeTakeFirst();
      return claimed?.stable_identity_generation ?? undefined;
    } catch (error) {
      throw toActionableError(error, `Failed to claim recoverable session ${sessionUuid}`);
    }
  }

  async releaseRecoverableSessionClaim(
    sessionUuid: string,
    claimed: RecoverableRowIncarnation,
    previousOwner: string | null,
  ): Promise<boolean> {
    try {
      const released = await this.getDb()
        .updateTable("device_sessions")
        .set({
          daemon_session_id: previousOwner,
          stable_identity_generation: sql`stable_identity_generation + 1`,
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "!=", "active")
        .where("stable_identity_generation", "=", claimed.rowGeneration)
        .where((eb) =>
          claimed.daemonSessionId === null
            ? eb("daemon_session_id", "is", null)
            : eb("daemon_session_id", "=", claimed.daemonSessionId),
        )
        .where((eb) => hasReissuableByNameReleaseReason(eb))
        .executeTakeFirst();
      return Number(released.numUpdatedRows) === 1;
    } catch (error) {
      throw toActionableError(error, `Failed to release the claim on session ${sessionUuid}`);
    }
  }

  async recordLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    await this.replaceLivenessOwnership(sessionUuid, ownerToken);
  }

  async replaceLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    try {
      const result = await this.getDb()
        .updateTable("device_sessions")
        .set({
          liveness_owner_token: ownerToken,
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new DeviceSessionNotActiveError(sessionUuid);
      }
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to persist liveness ownership for ${sessionUuid}: ${error}`,
      );
      throw error;
    }
  }

  async markAutolockSession(
    sessionUuid: string,
    input: {
      mcpSessionId?: string | null;
      daemonSessionId?: string | null;
      lastUsedAtMs: number;
      /** Monotonic activity order within this daemon/session; defaults to lastUsedAtMs. */
      activitySeq?: number;
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
          // A newer activity snapshot may have landed while this write was queued (#11129).
          // Order by the session clock, not by wall stamps that can step backward (#11497).
          activity_seq: sql<number>`max(activity_seq, ${input.activitySeq ?? input.lastUsedAtMs})`,
          last_used_at_ms: unlessStale(
            "last_used_at_ms",
            input.activitySeq ?? input.lastUsedAtMs,
            input.lastUsedAtMs,
          ),
          expires_at_ms: unlessStale(
            "expires_at_ms",
            input.activitySeq ?? input.lastUsedAtMs,
            input.expiresAtMs,
          ),
          released_at_ms: null,
          release_reason: null,
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        // Like activity refresh, delayed autolock metadata may only update a
        // live row. Cancellation can durably retire it while this write waits.
        .where("status", "=", "active")
        .execute();
    } catch (error) {
      logger.warn(
        `[DeviceSessionRepository] Failed to mark autolock session ${sessionUuid}: ${error}`,
      );
      // The autolock -> MCP mapping is what a restart restores; callers must know it is missing.
      throw toActionableError(error, `Failed to persist autolock session ${sessionUuid}`);
    }
  }

  async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options: MarkReleasedOptions = {},
  ): Promise<void> {
    const { expectedRowGeneration, onlyIfRecoverable, onlyIfExpiredAtMs, onlyIfOwnedByDaemon } =
      options;
    try {
      const db = await this.getDb();
      let update = db
        .updateTable("device_sessions")
        .set({
          status,
          released_at_ms: releasedAtMs,
          release_reason: reason,
          ...(shouldRetainLivenessOwner(reason) ? {} : { liveness_owner_token: null }),
          updated_at: nowIso(this.timer),
        })
        .where("session_uuid", "=", sessionUuid)
        // A terminal reason is never replaced by a weaker one (a stronger or equal one may).
        .where((eb) =>
          // Nothing is stronger than the strongest reason, so it replaces any row.
          releaseReasonStrength(reason) === 2
            ? eb.val(true)
            : eb.or([
                eb("release_reason", "is", null),
                eb.not(holdsStrongerReleaseReason(eb, reason)),
              ]),
        )
        .where((eb) =>
          options.unlessDaemonShutdown
            ? eb.or([
                eb("release_reason", "is", null),
                eb("release_reason", "!=", "daemon-shutdown"),
              ])
            : eb.val(true),
        );
      if (expectedRowGeneration !== undefined) {
        update = update.where("stable_identity_generation", "=", expectedRowGeneration);
      }
      if (onlyIfRecoverable) {
        update = update.where((eb) => hasRecoverableReleaseReason(eb));
      }
      const handoff = options.onlyIfRestartRecoveryHandoff;
      if (handoff) {
        update = update
          .where("release_reason", "like", `${DEVICE_RESTART_RELEASE_REASON_PREFIX}_%`)
          .where("released_at_ms", "<=", handoff.releasedAtOrBeforeMs)
          .where((eb) =>
            eb.or([
              eb("liveness_policy", "=", MANAGED_EXECUTION_LIVENESS_POLICY),
              eb("expires_at_ms", ">", sql<number>`released_at_ms + ${handoff.recoveryWindowMs}`),
            ]),
          );
      }
      if (onlyIfExpiredAtMs !== undefined) {
        update = update
          .where((eb) => hasApplicableIdleDeadline(eb))
          .where("expires_at_ms", "<=", onlyIfExpiredAtMs);
      }
      if (onlyIfOwnedByDaemon !== undefined) {
        update = update.where("daemon_session_id", "=", onlyIfOwnedByDaemon);
      }
      const guarded = options.unlessTerminalOrOwnedByLivePeer;
      if (guarded) {
        update = update.where((eb) =>
          rowRewriteGuard(
            eb,
            guarded.supersededReasons ?? [],
            guarded.livePeerDaemonSessionIds,
            guarded.ownDaemonSessionId,
          ),
        );
      }
      const result = await update.executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        this.reportReleaseStatementMiss(sessionUuid, reason, options);
      }
    } catch (error) {
      if (error instanceof DeviceSessionRowNotReleasableError) {
        // A statement refusal is an expected ownership/generation race, not a storage failure.
        logger.debug(`[DeviceSessionRepository] Release row refused for ${sessionUuid}`);
        throw error;
      }
      logger.warn(
        `[DeviceSessionRepository] Failed to mark session ${sessionUuid} ${status}: ${error}`,
      );
      throw error;
    }
  }

  private reportReleaseStatementMiss(
    sessionUuid: string,
    reason: string,
    options: MarkReleasedOptions,
  ): void {
    const guarded = options.unlessTerminalOrOwnedByLivePeer;
    if (options.unlessDaemonShutdown) {
      throw new DeviceSessionRowNotReleasableError(sessionUuid);
    }
    if (guarded && (guarded.reportRefusal || guarded.ownDaemonSessionId !== undefined)) {
      throw new DeviceSessionRowNotReleasableError(sessionUuid);
    }
    if (options.expectedRowGeneration !== undefined) {
      // Legacy generation-only callers expect a silent skip; two-step writers request refusal.
      logger.info(
        `[DeviceSessionRepository] Skipped ${reason} release of ${sessionUuid}: the row is no ` +
          `longer generation ${options.expectedRowGeneration}`,
      );
    } else if (guarded) {
      throw new DeviceSessionRowNotReleasableError(sessionUuid);
    }
  }

  /**
   * Expire stale active sessions left by previous daemon runs. Called once during
   * daemon startup (`Daemon.initializeDatabase()`). Errors PROPAGATE rather than
   * being swallowed: a failure here means the `device_sessions` table is
   * missing/malformed (a broken DB), which the startup circuit breaker must treat
   * as fatal so the daemon exits/backs off instead of starting with broken
   * session state (issue #2784). Do not add a local catch — the caller owns the
   * fatal/backoff decision. Active sessions owned by a daemon in
   * `liveDaemonSessionIds` are peer-owned and must remain untouched, as are legacy
   * NULL-owner rows while any peer is live and their lease has not lapsed.
   */
  async markStaleActiveSessionsExpired(
    currentDaemonSessionId: string,
    releasedAtMs: number,
    reason: string = "daemon-restart",
    liveDaemonSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const db = await this.getDb();
    const liveDaemonSessionIdList = Array.from(liveDaemonSessionIds);
    const hasLivePeer = liveDaemonSessionIdList.some((id) => id !== currentDaemonSessionId);
    await db
      .updateTable("device_sessions")
      .set({
        status: "expired",
        released_at_ms: releasedAtMs,
        release_reason: reason,
        ...(shouldRetainLivenessOwner(reason) ? {} : { liveness_owner_token: null }),
        updated_at: nowIso(this.timer),
      })
      .where("status", "=", "active")
      .where((eb) => {
        const nonCurrentOwner = eb("daemon_session_id", "!=", currentDaemonSessionId);
        const deadOwner =
          liveDaemonSessionIdList.length === 0
            ? nonCurrentOwner
            : eb.and([nonCurrentOwner, eb("daemon_session_id", "not in", liveDaemonSessionIdList)]);
        // A NULL owner is a legacy row written before every upsert stamped its daemon (#11114):
        // it may belong to a live peer, so while a peer is live it is spared only when its lease
        // (`expires_at_ms`, extended by every activity) is still unexpired; a lapsed one can no
        // longer be an active peer's session and is expired so recovery/prune can handle it
        // (#11132). With no live peer it is always reclaimed.
        const nullOwner = eb("daemon_session_id", "is", null);
        const reclaimableNullOwner = hasLivePeer
          ? eb.and([
              nullOwner,
              hasApplicableIdleDeadline(eb),
              eb("expires_at_ms", "<=", releasedAtMs),
            ])
          : nullOwner;
        return eb.or([reclaimableNullOwner, deadOwner]);
      })
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
   * Terminalizes expired recoverable rows before reading and returning sessions. `nowMs` must be
   * on the clock the stamps were written with: wall-clock epoch ms (#11162), which the session
   * manager converts its session clock to; the timer is only a fallback for callers without one.
   */
  async listRecoverableSessions(
    nowMs: number = this.timer.now(),
    livePeerDaemonSessionIds: () => readonly string[] = () => [],
  ): Promise<DeviceSession[]> {
    const db = await this.getDb();
    await this.pruneExpiredSessions(nowMs);
    const expired = await db
      .selectFrom("device_sessions")
      .selectAll()
      .where((eb) => hasRecoverableReleaseReason(eb))
      .where((eb) =>
        eb.or([
          eb.and([hasApplicableIdleDeadline(eb), eb("expires_at_ms", "<=", nowMs)]),
          eb.and([
            eb("release_reason", "like", `${DEVICE_RESTART_RELEASE_REASON_PREFIX}_%`),
            eb("released_at_ms", "<=", nowMs - DEFAULT_DEVICE_READY_TIMEOUT_MS),
          ]),
        ]),
      )
      .execute();
    for (const row of expired) {
      try {
        const reason = persistedSessionExpiryReason(row, nowMs)!;
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
          unlessTerminalOrOwnedByLivePeer: {
            livePeerDaemonSessionIds:
              isDeviceRestartReleaseReason(row.release_reason!) &&
              row.released_at_ms !== null &&
              nowMs >= row.released_at_ms + DEFAULT_DEVICE_READY_TIMEOUT_MS
                ? livePeerDaemonSessionIds()
                : [],
          },
        });
      } catch (error) {
        logger.warn(
          `[DeviceSessionRepository] Failed to terminalize expired recoverable session ${row.session_uuid}: ${errorMessage(error)}`,
          error,
        );
        continue;
      }
    }
    return await db
      .selectFrom("device_sessions")
      .selectAll()
      .where((eb) => hasRecoverableReleaseReason(eb))
      .where((eb) =>
        eb.or([
          eb("released_at_ms", "is", null),
          eb("released_at_ms", ">=", nowMs - DEVICE_SESSION_RETENTION_MAX_AGE_MS),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb("liveness_policy", "=", MANAGED_EXECUTION_LIVENESS_POLICY),
          eb("expires_at_ms", ">", nowMs),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb("release_reason", "not like", `${DEVICE_RESTART_RELEASE_REASON_PREFIX}_%`),
          eb("released_at_ms", "is", null),
          eb("released_at_ms", ">", nowMs - DEFAULT_DEVICE_READY_TIMEOUT_MS),
        ]),
      )
      .orderBy("last_used_at_ms", "desc")
      .execute();
  }

  /**
   * Delete terminal-state (`released`/`expired`) rows past the retention
   * window (#6464), using the current clock independently of a rebound
   * session's original creation time. Best-effort: a failure here
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
