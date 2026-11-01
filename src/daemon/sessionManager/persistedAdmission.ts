import { type DbWriteBarrier } from "../../db/dbWriteBarrier";
import {
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
  isRecoverableDeviceSession,
  persistedSessionExpiryReason,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { ignoresManagedExecutionIdleDeadline } from "../../models/managedExecutionLiveness";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  isRecoverableDaemonReleaseReason,
  isReissuableByNameReleaseReason,
  isTerminalReleaseReason,
  sessionReleaseReasonTraits,
} from "../releaseReasons";
import { TerminalSessionError } from "../sessionErrors";
import {
  type ActiveSessionExecutionChecker,
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  PLAN_LABEL_SESSION_SOURCE,
  type Session,
  type SessionAccess,
  type SessionReleaseOptions,
  type SessionReleaseSnapshot,
} from "../sessionManager";
import { RecoveredTerminalReleaseIntents } from "../sessionManager/recoveredTerminalReleaseIntents";
import {
  type SessionLifecycleSlots,
  hasLapsedRestartRecoveryWindow,
  isDeviceRestartReleasedRow,
  restartRecoveryDeadlineFromPersisted,
} from "./internalContracts";
import { UnissuedSessionError } from "./UnissuedSessionError";

export interface PersistedSessionAdmissionHost {
  readSessionRow(sessionId: string): Promise<DeviceSession | undefined>;
  readonly deviceSessionRepository: Pick<
    DeviceSessionPersistence,
    "recordRestartRecoveryActivity" | "markReleased"
  >;
  readonly recoveredIntents: RecoveredTerminalReleaseIntents;
  sessionNow(): number;
  readonly getBarrier: () => DbWriteBarrier;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "hasTerminalSnapshot" | "isRowClaimed" | "setTerminalSnapshot"
  >;
  readonly daemonSessionId: string | undefined;
  isRowOwnedByLivePeer(row: DeviceSession): boolean;
  isSessionBeingRecreated(sessionId: string): boolean;
  readonly activeSessionExecutionChecker: ActiveSessionExecutionChecker;
  sessionClockToWall(sessionClockMs: number): number;
  readonly sessions: Pick<Map<string, Session>, "has">;
  rowWriteLivePeerDaemonSessionIds(): string[];
  releaseSnapshotFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
    releaseReason: string,
  ): SessionReleaseSnapshot;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
  notifySessionRelease(snapshot: SessionReleaseSnapshot, options?: SessionReleaseOptions): void;
}

export class PersistedSessionAdmission {
  constructor(private readonly host: PersistedSessionAdmissionHost) {}

  /**
   * Last tool-call activity (a call starting, joining, or ending) against a session that is
   * waiting out a device restart. The released row's `expires_at_ms` froze at the device loss,
   * so without this an agent that keeps calling through a cold boot longer than the idle window
   * would lose its session; it is projected onto the persisted row by
   * {@link readPersistedSession}. In memory only: a daemon restart falls back to the row.
   */
  readonly restartRecoveryActivityAt: Map<string, number> = new Map();

  private readonly restartRecoveryActivityCallbacks: Array<
    (sessionId: string, atMs: number) => void
  > = [];

  /** The persisted row, with tool activity during a device-restart recovery applied to its expiry. */
  async readPersistedSession(sessionId: string): Promise<DeviceSession | undefined> {
    let stored = await this.host.readSessionRow(sessionId);
    if (stored && (await this.host.recoveredIntents.adoptDeadOwnerTerminalReleases(stored))) {
      // The adopted releases were just written; this read predates them.
      stored = await this.host.readSessionRow(sessionId);
    }
    const persisted = stored && this.host.recoveredIntents.withRecoveredTerminalRelease(stored);
    const activityAt = this.restartRecoveryActivityAt.get(sessionId);
    if (!persisted || activityAt === undefined || !isDeviceRestartReleasedRow(persisted)) {
      return persisted;
    }
    return {
      ...persisted,
      expires_at_ms: Math.max(persisted.expires_at_ms, activityAt + persisted.session_timeout_ms),
    };
  }

  /** Allow the pool to re-arm its idle hold when an admitted call records recovery activity. */
  onRestartRecoveryActivity(callback: (sessionId: string, atMs: number) => void): void {
    this.restartRecoveryActivityCallbacks.push(callback);
  }

  /**
   * A control call started, joined or ended against a session waiting out a device restart.
   *
   * The in-memory mark applies at once (see {@link readPersistedSession}); the durable write
   * (#10713) lets the extended expiry survive a daemon restart during the device restart, which
   * would otherwise fall back to the expiry stored at the device loss.
   */
  recordRestartRecoveryActivity(sessionId: string): void {
    const activityAt = Math.max(
      this.restartRecoveryActivityAt.get(sessionId) ?? 0,
      this.host.sessionNow(),
    );
    this.restartRecoveryActivityAt.set(sessionId, activityAt);
    for (const callback of this.restartRecoveryActivityCallbacks) {
      try {
        callback(sessionId, activityAt);
      } catch (error) {
        logger.warn(`[SessionManager] Restart activity callback failed for ${sessionId}: ${error}`);
      }
    }
    void this.host
      .getBarrier()
      .track(async () => {
        await this.host.deviceSessionRepository.recordRestartRecoveryActivity(
          sessionId,
          activityAt,
        );
      })
      .catch((error) => {
        // The in-memory mark still governs this process; only a daemon restart before the next
        // activity write would fall back to the stored expiry.
        logger.warn(
          `[SessionManager] Failed to persist restart-recovery activity for ${sessionId}: ` +
            errorMessage(error),
        );
      });
  }

  /** Read-only admission probe; recovery itself remains owned by getOrCreateSession. */
  async isReleasedSessionInRestartRecoveryWindow(sessionId: string): Promise<boolean> {
    if (this.host.sessionSlots.hasTerminalSnapshot(sessionId)) {
      return false;
    }
    const persisted = await this.readPersistedSession(sessionId);
    if (
      !persisted ||
      this.host.sessionSlots.hasTerminalSnapshot(sessionId) ||
      !this.isReissuablePersistedSession(persisted)
    ) {
      return false;
    }
    const deadline = restartRecoveryDeadlineFromPersisted(persisted);
    return deadline !== undefined && this.host.sessionNow() < deadline;
  }

  /**
   * Recheck a pool hold at its idle deadline. Local recovery calls and live peer claims retain
   * the cold-boot window; foreign-owned rows are never terminalized here. Expiry of our row is
   * guarded against an owner or generation change between this read and its write.
   */
  async expireRestartRecoveryReservation(sessionId: string): Promise<number | undefined> {
    const persisted = await this.readPersistedSession(sessionId);
    if (!persisted || !isDeviceRestartReleasedRow(persisted)) {
      return undefined;
    }
    const hasForeignOwner = (row: DeviceSession) =>
      this.host.daemonSessionId !== undefined &&
      (row.daemon_session_id ?? this.host.daemonSessionId) !== this.host.daemonSessionId;
    const livePeerDeadline = (row: DeviceSession) => {
      const deadline = restartRecoveryDeadlineFromPersisted(row, true)!;
      return this.host.isRowOwnedByLivePeer(row) && this.host.sessionNow() < deadline
        ? deadline
        : undefined;
    };
    if (hasForeignOwner(persisted)) {
      return livePeerDeadline(persisted);
    }
    const callerInFlight =
      this.host.isSessionBeingRecreated(sessionId) ||
      this.host.activeSessionExecutionChecker(sessionId);
    const deadline = restartRecoveryDeadlineFromPersisted(persisted, callerInFlight)!;
    if (this.host.sessionNow() < deadline) {
      return deadline;
    }
    if (!callerInFlight) {
      const current = await this.terminalizeExpiredPersistedSession(
        persisted,
        persisted.daemon_session_id === this.host.daemonSessionId
          ? this.host.daemonSessionId
          : undefined,
      );
      // The conditional expiry write may lose to activity or a peer claiming the row.
      if (current && isDeviceRestartReleasedRow(current)) {
        if (hasForeignOwner(current)) {
          return livePeerDeadline(current);
        }
        const extendedDeadline = restartRecoveryDeadlineFromPersisted(current)!;
        if (this.host.sessionNow() < extendedDeadline) {
          return extendedDeadline;
        }
      }
    }
    return undefined;
  }

  async getPersistedTerminalRelease(
    sessionId: string,
  ): Promise<SessionReleaseSnapshot | undefined> {
    const persisted = await this.readPersistedSession(sessionId);
    return persisted ? this.terminalReleaseFromPersisted(sessionId, persisted) : undefined;
  }

  /**
   * #6069, #11418: True when a call naming this persisted row's UUID may issue
   * the session again with a pooled device: an active row, or one released for a
   * re-issuable-by-name reason (a daemon/device handoff, or a plan's
   * `plan-auto-release`), that has not expired. Terminal reasons and the
   * never-reissuable ones (`superseded`, `allocation-rollback`, ...) are refused,
   * as is a missing row. This is wider than startup rehydration, which only takes
   * the recoverable handoffs. The claim and the claimed-row upsert share it.
   */
  isReissuablePersistedSession(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted &&
      (!persisted.release_reason || isReissuableByNameReleaseReason(persisted.release_reason)) &&
      isRecoverableDeviceSession(persisted, this.host.sessionNow()) &&
      (this.host.sessionSlots.isRowClaimed(persisted) ||
        this.host.isRowOwnedByLivePeer(persisted) ||
        !hasLapsedRestartRecoveryWindow(persisted, this.host.sessionNow())),
    );
  }

  /**
   * The narrower startup-rehydration predicate (#11418): an active row, or one released for a
   * recoverable handoff, that has not expired. A `plan-auto-release` row is re-issuable by name
   * but is never rehydrated, so a finished plan's session does not come back to hold its device.
   * Neither is any row of a plan's derived label session (#11572), live or released for a handoff
   * (`daemon-shutdown`, `device-restart:`): its plan run ended with the daemon that ran it, so
   * nothing would own, heartbeat or release it. Its device is free for the next plan run.
   */
  isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted &&
      persisted.source !== PLAN_LABEL_SESSION_SOURCE &&
      (!persisted.release_reason || isRecoverableDaemonReleaseReason(persisted.release_reason)) &&
      isRecoverableDeviceSession(persisted, this.host.sessionNow()) &&
      !hasLapsedRestartRecoveryWindow(persisted, this.host.sessionNow()),
    );
  }

  /**
   * True for a row that is re-issued rather than recovered (#11418): released for a reason that
   * is re-issuable by name but not recoverable (`plan-auto-release`). Its plan already gave the
   * device up, so the session has no device identity to keep: the re-issue prefers the old device
   * and otherwise takes any device ordinary allocation would, instead of ending the UUID.
   */
  isNameReissueOnlyRow(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted?.release_reason &&
      !isRecoverableDaemonReleaseReason(persisted.release_reason) &&
      this.isReissuablePersistedSession(persisted),
    );
  }

  /**
   * Mark a row found past its deadline `expired`, and resolve with the row as it stands afterwards
   * (the row given when nothing was written). The write is conditioned, in the statement, on the
   * deadline still being at or before the instant it was judged at (#11498): an activity write by
   * the row's owner does not advance the generation, so a lease or a device-restart recovery
   * window it extended after this read would otherwise be released anyway. The caller answers from
   * the returned row, never from the one it read before the write.
   */
  async terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
    onlyIfOwnedByDaemon?: string,
  ): Promise<DeviceSession | undefined> {
    const now = this.host.sessionNow();
    if (!persisted) {
      return persisted;
    }
    if (
      hasLapsedRestartRecoveryWindow(persisted, now) &&
      this.host.isRowOwnedByLivePeer(persisted)
    ) {
      return persisted;
    }
    if (persistedSessionExpiryReason(persisted, now) === "restart-recovery-timeout") {
      return this.terminalizeRestartRecoveryHandoff(persisted, onlyIfOwnedByDaemon);
    }
    if (
      persistedSessionExpiryReason(persisted, now) === undefined ||
      (persisted.release_reason &&
        (isTerminalReleaseReason(persisted.release_reason) ||
          sessionReleaseReasonTraits(persisted.release_reason).releasedBeforeHandout))
    ) {
      return persisted;
    }
    // Only the row judged expired: a peer may re-upsert the UUID after this read (#11129).
    await this.host.deviceSessionRepository.markReleased(persisted.session_uuid, "expired", now, {
      reason: "expired",
      ...(persisted.stable_identity_generation === undefined
        ? {}
        : { expectedRowGeneration: persisted.stable_identity_generation }),
      // The repository compares stored stamps, which are wall ms; the session-clock wrapper
      // converts the release stamp but passes options through as given. A stamp this daemon
      // wrote itself is judged above as the session-clock instant it was written from (#11358),
      // so after a wall step the statement can disagree with that judgement by the step; then
      // nothing is written and the row is still answered as it reads below.
      onlyIfExpiredAtMs: this.host.sessionClockToWall(now),
      onlyIfOwnedByDaemon,
    });
    const current = await this.readPersistedSession(persisted.session_uuid);
    this.confirmPersistedExpiry(persisted, current, "expired");
    if (!this.isReissuablePersistedSession(current)) {
      this.restartRecoveryActivityAt.delete(persisted.session_uuid);
    }
    return current;
  }

  /** Terminalize only this daemon's still-recoverable handoff after a confirmed sessionless stop. */
  async terminalizeDeviceRestartHandoffForStop(sessionId: string): Promise<boolean> {
    const persisted = await this.readPersistedSession(sessionId);
    if (
      !persisted ||
      !isDeviceRestartReleasedRow(persisted) ||
      this.host.sessions.has(sessionId) ||
      this.host.isSessionBeingRecreated(sessionId) ||
      this.host.daemonSessionId === undefined ||
      persisted.daemon_session_id !== this.host.daemonSessionId
    ) {
      logger.warn(
        `[SessionManager] Cannot terminalize stopped restart holder ${sessionId}: row is no longer this daemon's handoff`,
      );
      return false;
    }
    const current = await this.terminalizeRestartRecoveryHandoff(
      { ...persisted },
      this.host.daemonSessionId,
      "device-killed",
    );
    const confirmed =
      current?.release_reason === "device-killed" &&
      current.stable_identity_generation === persisted.stable_identity_generation;
    if (!confirmed) {
      logger.warn(
        `[SessionManager] Stopped restart holder ${sessionId} terminal row write was not confirmed`,
      );
    }
    return confirmed;
  }

  /** A conditional handoff expiry uses the terminal journal, but fences only a confirmed row. */
  private async terminalizeRestartRecoveryHandoff(
    persisted: DeviceSession,
    onlyIfOwnedByDaemon?: string,
    reason: "restart-recovery-timeout" | "device-killed" = "restart-recovery-timeout",
  ): Promise<DeviceSession | undefined> {
    let livePeerDaemonSessionIds: string[];
    try {
      livePeerDaemonSessionIds = this.host.rowWriteLivePeerDaemonSessionIds();
    } catch (error) {
      logger.warn(
        `[SessionManager] Cannot prove ownership to expire restart recovery for ` +
          `${persisted.session_uuid}: ${errorMessage(error)}`,
        error,
      );
      // Refuse from the row as read, without a write, journal intent, fence or release notice.
      return persisted;
    }
    const snapshot = this.host.releaseSnapshotFromPersisted(
      persisted.session_uuid,
      persisted,
      reason,
    );
    snapshot.releasedAtMs = this.host.sessionNow();
    const recoveryWindowMs = reason === "device-killed" ? 0 : DEVICE_RESTART_RECOVERY_WINDOW_MS;
    await this.host.persistSessionRelease(snapshot, false, {
      expectedRowGeneration: persisted.stable_identity_generation ?? 0,
      onlyIfRecoverable: true,
      onlyIfOwnedByDaemon: onlyIfOwnedByDaemon ?? persisted.daemon_session_id ?? undefined,
      unlessTerminalOrOwnedByLivePeer: {
        livePeerDaemonSessionIds,
        reportRefusal: true,
      },
      onlyIfRestartRecoveryHandoff: {
        releasedAtOrBeforeMs: this.host.sessionClockToWall(
          snapshot.releasedAtMs - recoveryWindowMs,
        ),
        recoveryWindowMs,
      },
    });
    const current = await this.readPersistedSession(persisted.session_uuid);
    this.confirmPersistedExpiry(persisted, current, reason);
    return current;
  }

  /** Only the confirmed release of the generation read may end the local reservation. */
  private confirmPersistedExpiry(
    persisted: DeviceSession,
    current: DeviceSession | undefined,
    reason: "expired" | "restart-recovery-timeout" | "device-killed",
  ): void {
    if (
      this.host.sessionSlots.hasTerminalSnapshot(persisted.session_uuid) ||
      current?.release_reason !== reason ||
      current.stable_identity_generation !== persisted.stable_identity_generation
    ) {
      return;
    }
    const snapshot =
      reason === "expired"
        ? this.expiredReleaseFromPersisted(persisted.session_uuid, current)
        : this.terminalReleaseFromPersisted(persisted.session_uuid, current);
    if (snapshot) {
      this.host.sessionSlots.setTerminalSnapshot(persisted.session_uuid, snapshot);
      this.restartRecoveryActivityAt.delete(persisted.session_uuid);
      this.host.notifySessionRelease(snapshot, { upgradeOnly: true });
    }
  }

  terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (!persisted.release_reason || !isTerminalReleaseReason(persisted.release_reason)) {
      return undefined;
    }
    return this.host.releaseSnapshotFromPersisted(sessionId, persisted, persisted.release_reason);
  }

  /**
   * The release a call naming a row past its deadline is refused with (#11361), or undefined when
   * the row is not one: a session that ran out its idle or recovery window while no daemon was
   * there to release it is gone, so a control call naming it gets the typed terminal refusal (with
   * the first deadline's reason) rather than the untyped "not found" of a never-issued id. An
   * idle-first answer keeps the non-terminal `expired` row reason; a window-first answer names
   * the terminal `restart-recovery-timeout`. This read writes neither a row nor a fence.
   */
  expiredReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (
      persisted.release_reason &&
      (isTerminalReleaseReason(persisted.release_reason) ||
        sessionReleaseReasonTraits(persisted.release_reason).releasedBeforeHandout)
    ) {
      return undefined;
    }
    const reason = this.host.isRowOwnedByLivePeer(persisted)
      ? !ignoresManagedExecutionIdleDeadline(persisted.liveness_policy) &&
        persisted.expires_at_ms <= this.host.sessionNow()
        ? "expired"
        : undefined
      : persistedSessionExpiryReason(persisted, this.host.sessionNow());
    if (!reason) {
      return undefined;
    }
    return {
      ...this.host.releaseSnapshotFromPersisted(sessionId, persisted, reason),
      terminal: true,
    };
  }

  /**
   * What a call naming a UUID that cannot be admitted is answered with. A control call naming a
   * row past its deadline gets the typed terminal refusal; a never-issued id gets `neverIssued`.
   * A read is never refused for an expired row: it gets `neverIssued` too, which its caller turns
   * into a sessionless read, exactly as before the expired answer existed (#11361).
   */
  unadmittedSessionError(
    sessionId: string,
    persisted: DeviceSession | undefined,
    neverIssued: UnissuedSessionError,
    access?: SessionAccess,
  ): Error {
    if (access === "read-only") {
      return neverIssued;
    }
    const expired = persisted && this.expiredReleaseFromPersisted(sessionId, persisted);
    return expired ? new TerminalSessionError(sessionId, expired) : neverIssued;
  }
}
