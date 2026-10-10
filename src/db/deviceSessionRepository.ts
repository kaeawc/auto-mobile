import { sql, type ExpressionBuilder, type Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, DeviceSession, DeviceSessionStatus, NewDeviceSession } from "./types";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { Platform } from "../models";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  isRecoverableDaemonReleaseReason,
  literalReleaseReasonsStrongerThan,
  literalReleaseReasonsWhere,
  releaseReasonFamiliesStrongerThan,
  releaseReasonFamiliesWhere,
  releaseReasonStrength,
  sessionReleaseReasonFamily,
  type SessionReleaseReasonFamily,
} from "../daemon/releaseReasons";

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
    session.expires_at_ms > nowMs &&
    (session.released_at_ms === null || session.released_at_ms >= retentionCutoffMs)
  );
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

function shouldRetainLivenessOwner(reason: string): boolean {
  return isRecoverableDaemonReleaseReason(reason);
}

/**
 * An activity write matched no active row (#11129): a peer expired it, or it was released. The
 * write did not persist, so callers must not treat it as stored.
 */
export class DeviceSessionNotActiveError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(`Device session ${sessionUuid} has no active row to record activity or ownership on.`);
    this.name = "DeviceSessionNotActiveError";
  }
}

/**
 * A recovery's upsert of a claimed recoverable row (#11243) found the row no longer the incarnation
 * it claimed: a terminal release, a peer, or the claim's own hand-back changed it first. Nothing
 * was written.
 */
export class DeviceSessionRowChangedError extends ActionableError {
  constructor(readonly sessionUuid: string) {
    super(
      `Device session ${sessionUuid} changed while it was being recovered; the recovery did not ` +
        "persist it.",
    );
    this.name = "DeviceSessionRowChangedError";
  }
}

/** Options for {@link DeviceSessionPersistence.upsertActiveSession}. */
export interface UpsertActiveSessionOptions {
  /**
   * The recoverable row incarnation a recovery claimed (#11243): the write replaces the row only
   * while it is still that incarnation (same generation and owner, still released for a
   * recoverable reason), so a terminal release landing after the claim is not revived. A mismatch
   * rejects with {@link DeviceSessionRowChangedError}.
   */
  claimedRow?: RecoverableRowIncarnation;
}

export interface DeviceSessionRecord {
  sessionUuid: string;
  deviceId: string;
  stableDeviceId?: string;
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
  heartbeatTimeoutSource?: "default" | "custom";
  hasReceivedHeartbeat: boolean;
  livenessPolicy?: "heartbeat" | "cli-idle" | "managed-execution";
  preCliHeartbeatTimeoutMs?: number;
  preCliHeartbeatTimeoutSource?: "default" | "custom";
  preCliSessionTimeoutMs?: number;
}

export interface DeviceSessionActivityUpdate {
  lastUsedAtMs: number;
  expiresAtMs: number;
  sessionTimeoutMs: number;
  heartbeatTimeoutMs: number;
  hasReceivedHeartbeat: boolean;
  heartbeatTimeoutSource?: "default" | "custom";
  livenessPolicy?: "heartbeat" | "cli-idle" | "managed-execution";
  preCliHeartbeatTimeoutMs?: number;
  preCliHeartbeatTimeoutSource?: "default" | "custom";
  preCliSessionTimeoutMs?: number;
}

/**
 * Optional precondition for {@link DeviceSessionPersistence.markReleased} (#11129): apply the
 * release only to the row incarnation it was captured from. `stable_identity_generation` advances
 * on every upsert of the UUID (create, rebind, resume, rehydrate) and on a recovery's claim of a
 * recoverable row or its hand-back (#11200, #11243), and on nothing else (a release does not
 * advance it), so a delayed or retried release of an earlier incarnation cannot clobber a
 * re-acquired row.
 */
export interface MarkReleasedOptions {
  expectedRowGeneration?: number;
  /**
   * Apply the release only while the row still holds a recoverable reason (single statement): a
   * sweep that terminalizes an expired recoverable row must not overwrite a release that landed
   * after it selected the row.
   */
  onlyIfRecoverable?: boolean;
}

/** The row incarnation a recovery read, which its ownership claim must still match (#11200). */
export interface RecoverableRowIncarnation {
  rowGeneration: number;
  daemonSessionId: string | null;
}

export interface DeviceSessionPersistence {
  /**
   * Resolves with the row's `stable_identity_generation` after the write when the implementation
   * reports it; that is the value a later release of this incarnation passes as
   * {@link MarkReleasedOptions.expectedRowGeneration}. `nowMs` is on the clock the row's stamps
   * are written with, used for the retention prune; it defaults to the timer. Stored stamps are
   * wall-clock epoch ms (#11162): the session manager converts its session-clock instants,
   * `nowMs` included, on the way in (`sessionClockPersistence.ts`).
   */
  upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs?: number,
    options?: UpsertActiveSessionOptions,
  ): Promise<number | void>;
  getSession?(sessionUuid: string): Promise<DeviceSession | undefined>;
  /**
   * `nowMs` is on the clock the persisted stamps were written with: wall-clock epoch ms (#11162),
   * converted from the session clock by the session manager's `sessionClockPersistence.ts`.
   */
  listRecoverableSessions?(nowMs?: number): Promise<DeviceSession[]>;
  recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void>;
  /**
   * Extend a device-restart-released row's expiry to `activityAtMs + session_timeout_ms` when that
   * is later (#10713), so tool activity during a device-restart recovery survives a daemon restart.
   * A row that is no longer device-restart-released (recovered, terminalized) is left untouched.
   */
  recordRestartRecoveryActivity?(sessionUuid: string, activityAtMs: number): Promise<void>;
  /**
   * Take ownership of a recoverable row before recovering it (#11200): stamp `daemonSessionId` as
   * its owner and advance its `stable_identity_generation`, only while the row is still the
   * incarnation `expected` describes. Resolves with the new generation, or undefined when another
   * writer (a peer daemon recovering the same row) changed it first; the caller must then leave
   * the row alone. Status and release reason are untouched, so the row stays recoverable.
   */
  claimRecoverableSession?(
    sessionUuid: string,
    expected: RecoverableRowIncarnation,
    daemonSessionId: string,
  ): Promise<number | undefined>;
  /**
   * Hand back a claim {@link claimRecoverableSession} took, after the recovery failed without
   * recovering or terminalizing the row (#11243): restore `previousOwner` and advance the
   * generation, only while the row is still the recoverable incarnation `claimed` describes.
   * Advancing (rather than restoring the pre-claim generation) keeps any late write of the failed
   * recovery, conditioned on the claimed generation, from landing. Resolves with whether the
   * claim was handed back; false when another writer (the recovery's own upsert, a terminal
   * release, a peer) changed the row first.
   */
  releaseRecoverableSessionClaim?(
    sessionUuid: string,
    claimed: RecoverableRowIncarnation,
    previousOwner: string | null,
  ): Promise<boolean>;
  recordLivenessOwnership?(sessionUuid: string, ownerToken: string | null): Promise<void>;
  replaceLivenessOwnership?(sessionUuid: string, ownerToken: string | null): Promise<void>;
  markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options?: MarkReleasedOptions,
  ): Promise<void>;
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
 * overwrite (#11129). A BUSY-retried write can land after a later one; keying on
 * `last_used_at_ms` (which only tool activity advances) lets the older write leave the newer
 * lease alone while still matching the row, so a stale write is not mistaken for a missing row.
 * SQLite evaluates every SET expression against the pre-update row.
 */
function activityColumnsUnlessStale(update: DeviceSessionActivityUpdate) {
  const at = update.lastUsedAtMs;
  const liveness = livenessColumns(update);
  return {
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

function unlessStale<T>(column: string, lastUsedAtMs: number, value: T) {
  return sql<T>`CASE WHEN last_used_at_ms > ${lastUsedAtMs} THEN ${sql.ref(column)} ELSE ${value} END`;
}

export class DeviceSessionRepository {
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

  private nowIso(): string {
    return new Date(this.timer.now()).toISOString();
  }

  async upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs: number = this.timer.now(),
    options: UpsertActiveSessionOptions = {},
  ): Promise<number> {
    const { claimedRow } = options;
    // A cheap, unconditional, indexed range
    // delete run before the write rather than gated behind amortization —
    // session starts are far less frequent than the amortized-per-insert
    // tables (#6464). Self-contained: a prune failure must never block a new
    // session from being persisted, so it swallows its own errors.
    await this.pruneExpiredSessions(nowMs);
    let written: { stable_identity_generation?: number } | undefined;
    try {
      const db = await this.getDb();
      const now = this.nowIso();
      const row: NewDeviceSession = {
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
        expires_at_ms: record.expiresAtMs,
        released_at_ms: null,
        release_reason: null,
        session_timeout_ms: record.sessionTimeoutMs,
        heartbeat_timeout_ms: record.heartbeatTimeoutMs,
        ...livenessColumns(record),
        created_at: now,
        updated_at: now,
      };

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
            return update;
          }
          return update
            .where("device_sessions.status", "!=", "active")
            .where("device_sessions.stable_identity_generation", "=", claimedRow.rowGeneration)
            .where((eb) =>
              claimedRow.daemonSessionId === null
                ? eb("device_sessions.daemon_session_id", "is", null)
                : eb("device_sessions.daemon_session_id", "=", claimedRow.daemonSessionId),
            )
            .where((eb) =>
              eb.or([
                eb(
                  "device_sessions.release_reason",
                  "in",
                  Array.from(RECOVERABLE_DAEMON_RELEASE_REASONS),
                ),
                eb(
                  "device_sessions.release_reason",
                  "like",
                  `${DEVICE_RESTART_RELEASE_REASON_PREFIX}_%`,
                ),
              ]),
            );
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
      // The claimed row's precondition failed: an expected race outcome, not a storage failure.
      throw new DeviceSessionRowChangedError(record.sessionUuid);
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
          last_used_at_ms: sql<number>`max(last_used_at_ms, ${update.lastUsedAtMs})`,
          ...activityColumnsUnlessStale(update),
          // Mark every current liveness write. The forward-compatibility trigger
          // clears this contract only when an older binary updates legacy
          // liveness columns without advancing this generation.
          liveness_contract_generation: sql`liveness_contract_generation + 1`,
          updated_at: this.nowIso(),
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
          updated_at: this.nowIso(),
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
          updated_at: this.nowIso(),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "!=", "active")
        .where("stable_identity_generation", "=", expected.rowGeneration)
        .where((eb) =>
          expected.daemonSessionId === null
            ? eb("daemon_session_id", "is", null)
            : eb("daemon_session_id", "=", expected.daemonSessionId),
        )
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
          updated_at: this.nowIso(),
        })
        .where("session_uuid", "=", sessionUuid)
        .where("status", "!=", "active")
        .where("stable_identity_generation", "=", claimed.rowGeneration)
        .where((eb) =>
          claimed.daemonSessionId === null
            ? eb("daemon_session_id", "is", null)
            : eb("daemon_session_id", "=", claimed.daemonSessionId),
        )
        .where((eb) => hasRecoverableReleaseReason(eb))
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
          updated_at: this.nowIso(),
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
          // Monotonic (#11129): the stamps come from a snapshot taken before this write was
          // queued, so a newer activity write may already have landed.
          last_used_at_ms: sql<number>`max(last_used_at_ms, ${input.lastUsedAtMs})`,
          expires_at_ms: unlessStale("expires_at_ms", input.lastUsedAtMs, input.expiresAtMs),
          released_at_ms: null,
          release_reason: null,
          updated_at: this.nowIso(),
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
    const { expectedRowGeneration, onlyIfRecoverable } = options;
    try {
      const db = await this.getDb();
      let update = db
        .updateTable("device_sessions")
        .set({
          status,
          released_at_ms: releasedAtMs,
          release_reason: reason,
          ...(shouldRetainLivenessOwner(reason) ? {} : { liveness_owner_token: null }),
          updated_at: this.nowIso(),
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
        );
      if (expectedRowGeneration !== undefined) {
        update = update.where("stable_identity_generation", "=", expectedRowGeneration);
      }
      if (onlyIfRecoverable) {
        update = update.where((eb) => hasRecoverableReleaseReason(eb));
      }
      const result = await update.executeTakeFirst();
      if (expectedRowGeneration !== undefined && Number(result.numUpdatedRows) === 0) {
        // Expected outcome of the precondition: the UUID was re-upserted (or removed) after this
        // release was captured, so the row is not this release's to change.
        logger.info(
          `[DeviceSessionRepository] Skipped ${reason} release of ${sessionUuid}: the row is no ` +
            `longer generation ${expectedRowGeneration}`,
        );
      }
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
        updated_at: this.nowIso(),
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
          ? eb.and([nullOwner, eb("expires_at_ms", "<=", releasedAtMs)])
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
  async listRecoverableSessions(nowMs: number = this.timer.now()): Promise<DeviceSession[]> {
    const db = await this.getDb();
    await this.pruneExpiredSessions(nowMs);
    const expired = await db
      .selectFrom("device_sessions")
      .select(["session_uuid", "stable_identity_generation"])
      .where((eb) => hasRecoverableReleaseReason(eb))
      .where("expires_at_ms", "<=", nowMs)
      .execute();
    for (const row of expired) {
      try {
        await this.markReleased(row.session_uuid, "expired", nowMs, "expired", {
          expectedRowGeneration: row.stable_identity_generation ?? 0,
          onlyIfRecoverable: true,
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
      .where("expires_at_ms", ">", nowMs)
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
