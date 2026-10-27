import { type DbWriteBarrier } from "../../db/dbWriteBarrier";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  daemonStallLeaseExtension,
  type OwnerConnectedAtReader,
} from "../connectedOwnerStallExcuse";
import {} from "../deviceStateRestoreQueue";
import { hasMintBoundClaimLease } from "../livenessOwnerLease";
import type { ObserverSessionStore } from "../observerSessionRegistry";
import { PlanLabelRegistry } from "../planLabelRegistry";
import { type SessionReleaseReason } from "../releaseReasons";
import type { ReleaseSessionRequest } from "../releaseSessionRequest";
import { effectiveLastToolActivity } from "../sessionClocks";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import { ActiveSessionExecutionChecker, Session } from "../sessionManager";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import { type StallForgivingLeases } from "../stallForgiveness";
import type { SupersededRowReasserts } from "../supersededRowReasserts";
import { type SessionLifecycleSlots } from "./internalContracts";

export interface SessionActivityClocksHost {
  sessionNow(): number;
  readonly sessions: Map<string, Session>;
  readonly restartRecoveryActivityAt: Map<string, number>;
  recordRestartRecoveryActivity(sessionId: string): void;
  readonly sessionSlots: SessionLifecycleSlots;
  readonly getBarrier: () => DbWriteBarrier;
  recordSessionActivity(session: Session): Promise<void>;
  readonly observerSessions:
    | (Pick<ObserverSessionStore, "release"> &
        Partial<Pick<ObserverSessionStore, "list">> &
        Partial<StallForgivingLeases>)
    | undefined;
  forgiveMintBoundClaimLease(
    session: Session,
    resumedAt: number,
    leaseLostMs: number,
    gapBeganAt?: number,
  ): void;
  readonly ownerConnectedAtReader: OwnerConnectedAtReader | undefined;
  readonly stallProbe: (() => void) | undefined;
  isSessionExpired(session: Session): boolean;
  expiredSessionReleaseReason(session: Session): SessionReleaseReason;
  readonly activeSessionExecutionChecker: ActiveSessionExecutionChecker;
  cancelExecutionsOverriddenByExpiry(
    session: Session,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean;
  releaseSession(
    sessionId: string,
    releaseReason?: SessionReleaseReason,
    request?: ReleaseSessionRequest,
  ): Promise<string | null>;
  readonly deviceSessionMap: Map<string, string>;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  readonly planLabels: PlanLabelRegistry;
  readonly superseded: SupersededRowReasserts<Session>;
  readonly stateRestore: SessionDeviceStateRestore;
  notifyDeviceOwnershipChange(
    deviceId: string,
    frameInvalidation?: "generation-only" | "full",
  ): void;
}

export class SessionActivityClocks {
  constructor(private readonly host: SessionActivityClocksHost) {}

  /** An owner's completed call restarts only its still-mint-bound claim leases. */

  restartMintBoundClaimLeases(ownerToken: string): void {
    const now = this.host.sessionNow();
    for (const session of this.host.sessions.values()) {
      if (session.livenessOwnerToken === ownerToken && hasMintBoundClaimLease(session)) {
        session.livenessOwnerBoundAt = Math.max(session.livenessOwnerBoundAt, now);
      }
    }
  }

  /**
   * A tool call on the session finished: restart the idle window from now (owner decision
   * 2026-10-08). The call stamped `lastUsedAt` when it started and held the session while it ran
   * (`activeSessionExecutionChecker`), so without this a call that outlasted the idle window would
   * release its session the moment it ended. The end of a call is tool usage, so it also refreshes
   * the session's activity heartbeat, exactly as the start did (`reclaimAndRefreshExistingSession`).
   */

  recordToolCallEnded(sessionId: string, end: { admitted: boolean } = { admitted: true }): void {
    // A call refused at admission (suspect, expired, not the holder) never used the session, so
    // its end must not restore a suspect lease or push an expired deadline out (#10824). A read
    // ends unadmitted too, and never extends the idle window, restart recovery included (#11281).
    if (!end.admitted) {
      return;
    }
    const session = this.host.sessions.get(sessionId);
    if (!session && this.host.restartRecoveryActivityAt.has(sessionId)) {
      // An admitted control call that waited on, or failed because of, a device restart is still
      // the client using the session: restart its idle window so recovery is only lost after real
      // quiet. One that failed at admission was credited there
      // ({@link creditControlCallFailedOnRestartRecovery}).
      this.host.recordRestartRecoveryActivity(sessionId);
      return;
    }
    if (!session || this.host.sessionSlots.isReleasing(session)) {
      return;
    }
    const now = this.host.sessionNow();
    session.lastUsedAt = Math.max(session.lastUsedAt, now);
    session.lastHeartbeat = Math.max(session.lastHeartbeat, now);
    session.expiresAt = Math.max(session.expiresAt, now + session.sessionTimeoutMs);
    session.activityGeneration++;
    void this.host
      .getBarrier()
      .track(() => this.host.recordSessionActivity(session))
      .catch((error) => {
        // Unlike a call's start, nobody awaits this write, so the in-memory refresh stands: the
        // call really did just end, and rolling back to its start would release a session that
        // outlived the idle window the moment it finished. The next activity write persists it.
        logger.warn(
          `[SessionManager] Failed to record tool-call end activity: ${errorMessage(error)}`,
        );
      });
  }

  /**
   * Start every rehydrated session's owner-reconnect window now (#10051 follow-up). Rehydration
   * runs early in daemon startup, before iOS services, the control socket and the heartbeat
   * monitor, and no owner can reconnect until the socket accepts connections, so the window is
   * measured from when the daemon is ready to hear from owners rather than from rehydration.
   * Returns how many sessions were restarted.
   */

  startRehydratedOwnerWindows(): number {
    const now = this.host.sessionNow();
    let restarted = 0;
    for (const session of this.host.sessions.values()) {
      if (session.ownership === "awaiting-owner" && session.awaitingOwnerSince !== undefined) {
        session.awaitingOwnerSince = Math.max(session.awaitingOwnerSince, now);
        // The idle window starts when the session is usable, like the owner window (#11388).
        // Rehydration stamped both at its own time, which startup may have outlasted.
        session.lastUsedAt = Math.max(session.lastUsedAt, now);
        session.expiresAt = Math.max(session.expiresAt, now + session.sessionTimeoutMs);
        restarted++;
      }
    }
    return restarted;
  }

  /**
   * Do not hold the daemon's own stall, or the host's sleep, against an owner's lease (#10051,
   * #10699).
   *
   * Called by the heartbeat monitor, which tells the two apart by the wall clock running ahead of
   * the monotonic one rather than by length:
   *
   * - `lostMs`: the daemon's event loop stalled while the host was awake. Owners kept
   *   heartbeating and calling, but the daemon could not hear them, so the lease AND the idle
   *   deadline move forward by exactly that interval, whatever its length.
   * - `sleptMs`: the host was suspended. Nothing ran, owners included, so the lease moves forward
   *   by it, but the idle deadline does not: host sleep counts toward the idle window (owner
   *   policy, #10661).
   *
   * Nothing moves past `resumedAt`, so time an owner genuinely missed before the gap still counts.
   * A `cli-idle` session has no lease; its wall-clock idle window moves forward by the same
   * `lostMs` (and never by `sleptMs`) through `idleStallForgivenAt`, so whether it survives a stall
   * no longer depends on which timer fires first afterwards (#10835).
   *
   * `gapBeganAt`, when given, narrows full lease forgiveness (#11080) to owners live at the
   * gap's start (`ownerLeaseLiveAt`). A live owner is forgiven in full however long the gap.
   * An owned session whose socket was connected at that instant also receives awake-stall credit
   * (#11992), capped in total between raw owner heartbeats at 600 s if still connected at resume,
   * otherwise MAX_CREDIBLE_DAEMON_STALL_MS (30 s).
   * Sleep contributes no credit to this extra rule. Without another owner heartbeat, even an
   * always-open socket is released once its raw heartbeat age exceeds heartbeatTimeoutMs +
   * SUSPECT_GRACE_MS + that cap, plus one scan. With no late tick, the existing
   * lease + grace + one scan bound is unchanged (10 s at defaults). Returns sessions considered.
   *
   * Observer registrations are excused the same gap under the same rule (#11554): it is handed
   * on as durations, because the observer registry keeps its own clock.
   */

  forgiveDaemonStall(resumedAt: number, lostMs: number, sleptMs = 0, gapBeganAt?: number): number {
    const leaseLostMs = lostMs + sleptMs;
    this.host.observerSessions?.forgiveStall?.({
      lostMs,
      sleptMs,
      gapAgeMs: gapBeganAt === undefined ? undefined : resumedAt - gapBeganAt,
    });
    let forgiven = 0;
    let leaseExtended = 0;
    let connectedExtended = 0;
    let connectedCreditMs = 0;
    let idleExtended = 0;
    for (const session of this.host.sessions.values()) {
      if (session.livenessPolicy === "cli-idle") {
        // Shift, never reset (#10662), and never past the resume point.
        const idleStart = effectiveLastToolActivity(session);
        session.idleStallForgivenAt = Math.max(idleStart, Math.min(resumedAt, idleStart + lostMs));
        idleExtended += Number(session.idleStallForgivenAt > idleStart);
        // A rehydrated one is judged on its owner-reconnect window alone, so that window moves
        // with the idle anchor (#11481): by the daemon's stall, never by host sleep, which counts
        // toward a CLI session's idle window.
        if (session.awaitingOwnerSince !== undefined) {
          session.awaitingOwnerSince = Math.max(
            session.awaitingOwnerSince,
            Math.min(session.awaitingOwnerSince + lostMs, resumedAt),
          );
        }
        forgiven++;
        continue;
      }
      this.host.forgiveMintBoundClaimLease(session, resumedAt, leaseLostMs, gapBeganAt);
      const extension = daemonStallLeaseExtension(
        session,
        resumedAt,
        { lostMs, sleptMs, gapBeganAt },
        this.host.ownerConnectedAtReader,
      );
      if (extension.leaseStart !== undefined) {
        session.stallForgivenAt = extension.leaseStart;
      }
      leaseExtended += extension.leaseExtended;
      connectedExtended += extension.connectedExtended;
      connectedCreditMs += extension.connectedCreditMs;
      // Shift, never reset (#10662): a full window per late tick would let a session whose
      // owner is gone outlive its lease for as long as the ticks keep arriving late.
      const previousExpiry = session.expiresAt;
      session.expiresAt = Math.max(
        session.expiresAt,
        Math.min(session.expiresAt + lostMs, resumedAt + session.sessionTimeoutMs),
      );
      idleExtended += Number(session.expiresAt > previousExpiry);
      if (session.awaitingOwnerSince !== undefined) {
        session.awaitingOwnerSince = Math.max(
          session.awaitingOwnerSince,
          Math.min(session.awaitingOwnerSince + leaseLostMs, resumedAt),
        );
      }
      forgiven++;
    }
    if (forgiven > 0) {
      logger.info(
        `Stall forgiveness: ${leaseExtended} session lease(s) extended by ${leaseLostMs}ms, ` +
          `${connectedExtended} connected-owner lease(s) extended by ${connectedCreditMs}ms, ` +
          `${idleExtended} idle deadline(s) extended by ${lostMs}ms, of ${forgiven} session(s)`,
      );
    }
    return forgiven;
  }

  /**
   * Remove all expired sessions and fire release callbacks for them.
   *
   * Runs on the periodic cleanup timer, but is also invoked by the heartbeat
   * monitor on its (much shorter) interval so that idle sessions — including
   * autolocked devices past their 60 s idle window — are released promptly
   * instead of waiting for the next 5-minute sweep.
   */

  cleanupExpiredSessions(): void {
    this.host.stallProbe?.();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.host.sessions) {
      if (this.host.isSessionExpired(session) && !this.host.sessionSlots.isReleasing(session)) {
        expiredSessions.push(sessionId);
      }
    }

    if (expiredSessions.length === 0) {
      return;
    }

    logger.info(
      `Cleaning up ${expiredSessions.length} expired sessions found by sweep: ` +
        expiredSessions.join(", "),
    );

    for (const sessionId of expiredSessions) {
      const session = this.host.sessions.get(sessionId);
      if (!session) {
        continue;
      }
      const releaseReason = this.host.expiredSessionReleaseReason(session);
      const overridesControl = this.host.activeSessionExecutionChecker(sessionId, {
        excludeReads: true,
      });
      if (this.host.cancelExecutionsOverriddenByExpiry(session, releaseReason)) {
        if (overridesControl) {
          logger.warn(
            `Session ${sessionId} was kept past its idle deadline by control calls that never ` +
              `settled; cancelling them and releasing it past their request deadline plus grace, ` +
              `or the unsettled-execution ceiling when a control call has no deadline`,
          );
        } else {
          logger.info(`Session ${sessionId} idle release cut in-flight reads`);
        }
      }
      const release = this.host.releaseSession(sessionId, releaseReason, {
        allowExpired: true,
        expiryOrigin: "cleanup-expired",
      });
      void this.host
        .getBarrier()
        .trackExisting(release)
        .catch((error) =>
          logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`),
        );
    }
  }

  /**
   * Remove session from all maps
   */

  removeSession(sessionId: string, expectedSession?: Session): boolean {
    const session = this.host.sessions.get(sessionId);
    if (!session || (expectedSession && session !== expectedSession)) {
      return false;
    }
    const ownedDevice = this.host.deviceSessionMap.get(session.assignedDevice) === sessionId;
    if (ownedDevice) {
      this.host.deviceSessionMap.delete(session.assignedDevice);
    }
    this.host.sessions.delete(sessionId);
    this.host.slotShadowProbe.check(sessionId, "unpublished");
    this.host.planLabels.clearEndedBase(sessionId);
    // The session ended: its row is no longer rewritten live, and no retry timer outlives it.
    this.host.superseded.settle(session);
    this.host.stateRestore.forgetSession(sessionId);
    if (ownedDevice) {
      // Generation only: removing an owner leaves this device's screen/connection intact.
      // Any restore, removal or disconnect separately publishes its full boundary.
      this.host.notifyDeviceOwnershipChange(session.assignedDevice);
    }
    return true;
  }
}
