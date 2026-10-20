import type { Platform } from "../models";
import type { DeviceSession, DeviceSessionStatus } from "./types";

/** Options for {@link DeviceSessionPersistence.upsertActiveSession}. */
export interface UpsertActiveSessionOptions {
  /**
   * The recoverable row incarnation a recovery claimed (#11243): the write replaces the row only
   * while it is still that incarnation (same generation and owner, still released for a
   * recoverable reason), so a terminal release landing after the claim is not revived. A mismatch
   * rejects with {@link DeviceSessionRowChangedError}.
   */
  claimedRow?: RecoverableRowIncarnation;
  /**
   * Replace an existing row only while its release is not terminal (#11498), decided in the
   * statement: a terminal release that lands after any earlier read of the row, or while this
   * call awaits its retention prune, is not erased. A missing row, an active row and a row
   * released for a non-terminal reason (a recoverable handoff, `plan-auto-release`, `expired`)
   * are written as usual. A refusal rejects with {@link DeviceSessionTerminallyReleasedError}.
   */
  unlessTerminal?: boolean;
  /**
   * Rewrite only a non-terminal row or this superseded release's row, and never a live peer's
   * row (#11557). Both guards run in the conflict-update statement; a missing row is inserted.
   * Empty reasons behave like `unlessTerminal`; empty peers add no owner guard. Not combined
   * with `claimedRow`. A refusal rejects with {@link DeviceSessionRowNotRewritableError}.
   */
  rewriteOverSupersededRelease?: {
    supersededReasons: readonly string[];
    livePeerDaemonSessionIds: readonly string[];
    /** First attempt needs no discovery: only an unowned row or this daemon's row is writable. */
    ownDaemonSessionId?: string;
    /** Activity re-persistence may replace only the generation its incarnation last wrote. */
    expectedRowGeneration?: number;
    /** Activity repair may revive a swept row, but never a row a release statement wrote. */
    unlessReleased?: boolean;
  };
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
  /** Monotonic activity order within this daemon/session; defaults to lastUsedAtMs. */
  activitySeq?: number;
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
  /** Monotonic activity order within this daemon/session; defaults to lastUsedAtMs. */
  activitySeq?: number;
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
   * Preserve a daemon-shutdown handoff in the release statement: a parked non-terminal write
   * must not overwrite its release's shutdown upgrade. A miss rejects with
   * DeviceSessionRowNotReleasableError; terminal and shutdown writers leave this unset.
   */
  unlessDaemonShutdown?: boolean;
  /**
   * Apply the release only while the row still holds a recoverable reason (single statement): a
   * sweep that terminalizes an expired recoverable row must not overwrite a release that landed
   * after it selected the row.
   */
  onlyIfRecoverable?: boolean;
  /**
   * Apply only to a device-restart handoff at or before the wall-ms threshold, whose idle
   * deadline is later than its stored handoff time plus the window duration. A resume or a
   * newer, unexpired handoff loses the statement; activity cannot extend the window.
   */
  onlyIfRestartRecoveryHandoff?: { releasedAtOrBeforeMs: number; recoveryWindowMs: number };
  /**
   * Apply the release only while the row's `expires_at_ms` is at or before this instant (single
   * statement): the expiry sweep must not terminalize a row whose deadline was extended (restart-
   * recovery activity, #11281) after it selected the row (#11448).
   */
  onlyIfExpiredAtMs?: number;
  /**
   * Apply the release only while the row is still owned by this daemon (single statement): a
   * release adopted from a dead daemon's journal (#11355) must not land on a row another daemon
   * took over after the adopter read it.
   */
  onlyIfOwnedByDaemon?: string;
  /** Preserve any terminal reason and any live peer's row, in the release statement (#11557).
   * A refusal rejects with DeviceSessionRowNotReleasableError; existing options keep their behavior.
   */
  unlessTerminalOrOwnedByLivePeer?: {
    livePeerDaemonSessionIds: readonly string[];
    /** First attempt needs no discovery: only an unowned row or this daemon's row is writable. */
    ownDaemonSessionId?: string;
    /** Report every statement miss, including a generation mismatch, for two-step writers. */
    reportRefusal?: boolean;
    supersededReasons?: readonly string[];
  };
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
  getSession(sessionUuid: string): Promise<DeviceSession | undefined>;
  /**
   * `nowMs` is on the clock the persisted stamps were written with: wall-clock epoch ms (#11162),
   * converted from the session clock by the session manager's `sessionClockPersistence.ts`.
   * Discover peers only when a window-first row needs terminalizing; ordinary listing stays local.
   */
  listRecoverableSessions(
    nowMs?: number,
    livePeerDaemonSessionIds?: () => readonly string[],
  ): Promise<DeviceSession[]>;
  recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void>;
  /**
   * Extend a device-restart-released row's expiry to `activityAtMs + session_timeout_ms` when that
   * is later (#10713), so tool activity during a device-restart recovery survives a daemon restart.
   * A row that is no longer device-restart-released (recovered, terminalized) is left untouched.
   */
  recordRestartRecoveryActivity(sessionUuid: string, activityAtMs: number): Promise<void>;
  /**
   * Take ownership of a recoverable row before recovering it (#11200): stamp `daemonSessionId` as
   * its owner and advance its `stable_identity_generation`, only while the row is still the
   * incarnation `expected` describes. Resolves with the new generation, or undefined when another
   * writer (a peer daemon recovering the same row) changed it first; the caller must then leave
   * the row alone. Status and release reason are untouched, so the row stays recoverable.
   */
  claimRecoverableSession(
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
  releaseRecoverableSessionClaim(
    sessionUuid: string,
    claimed: RecoverableRowIncarnation,
    previousOwner: string | null,
  ): Promise<boolean>;
  recordLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void>;
  replaceLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void>;
  markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options?: MarkReleasedOptions,
  ): Promise<void>;
}
