import { type DbWriteBarrier } from "../../db/dbWriteBarrier";
import { resolveOwnershipSessionUuid } from "../../features/toolSelection/selectionSessionResolver";
import { ignoresManagedExecutionIdleDeadline } from "../../models/managedExecutionLiveness";
import { logger } from "../../utils/logger";
import { refusedClaimHoldSource, type LivenessOwnerView } from "../livenessClaimDecision";
import {
  hasMintBoundClaimLease,
  heartbeatLeasePastGrace,
  judgedLeaseHeartbeat,
  judgesOwnerHeartbeats,
  livenessLeaseState,
  livenessOwnerHold,
  sessionJudgedLeaseSnapshot,
  sessionOwnerLeaseSnapshot,
  suspectGraceMsFor,
  type LivenessLeaseState,
  type LivenessOwnerHold,
  type LivenessOwnerLeaseSnapshot,
} from "../livenessOwnerLease";
import {
  IDLE_WINDOW_RELEASE_REASON,
  shouldJudgeOwnerLeaseForRelease,
  type SessionReleaseReason,
} from "../releaseReasons";
import type { ReleaseSessionRequest } from "../releaseSessionRequest";
import { holdsOwnerHeartbeatLease } from "../sessionBroker/provisioning/executionLiveness";
import { sessionIdleDeadline } from "../sessionClocks";
import {
  SessionHeldByRecoveryError,
  SessionSuspectError,
  TerminalSessionError,
} from "../sessionErrors";
import { SessionLivenessController } from "../sessionLivenessLease";
import {
  PLAN_LABEL_SESSION_SOURCE,
  type ActiveSessionExecutionChecker,
  type ActiveSessionExecutionQuery,
  type ExpiryReleaseExecutionCanceller,
  type Session,
  type SessionAccess,
  type SessionExecutionDeadlineLookup,
  type SessionExecutionMetadata,
  type SessionReleaseOperation,
  type SessionReleaseSnapshot,
} from "../sessionManager";
import { SessionReleasedDuringCallError } from "../sessionReleasedDuringCall";
import { forgivenLeaseStart, leaseRunningAt } from "../stallForgiveness";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  isReleaseVetoedByExecutions,
} from "../unsettledExecutionVeto";
import {
  type ReleaseReasonState,
  type SessionClockExecution,
  type SessionLifecycleSlots,
} from "./internalContracts";

export interface SessionLeaseExpiryHost {
  readonly stallProbe: (() => void) | undefined;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "hasTerminalSnapshot" | "isReleasing" | "getReleaseOp" | "getTerminalSnapshot"
  >;
  readonly sessions: Pick<Map<string, Session>, "get">;
  releaseSession(
    sessionId: string,
    releaseReason?: SessionReleaseReason,
    request?: ReleaseSessionRequest,
  ): Promise<string | null>;
  readonly getBarrier: () => DbWriteBarrier;
  deviceHeldForLateRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined;
  unlessBaseEnded(session: Session | null): Session | null;
  wallToSessionClock(wallMs: number): number;
  peekSession(sessionId: string): Session | null;
  sessionNow(): number;
  readonly livenessOwnerCallInFlightReader: ((ownerToken: string) => boolean) | undefined;
  readonly liveness: SessionLivenessController;
  judgedLeaseHeartbeat(session: Session): number;
  readonly activeSessionExecutionChecker: ActiveSessionExecutionChecker;
  ownershipSessionUuid(sessionId: string): string;
  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined;
  getReleasingSession(sessionId: string): Session | null;
  upgradeReleaseReason(reason: ReleaseReasonState, candidate: string): void;
  cancelExecutionsCutByRelease(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean;
  getPersistedTerminalRelease(sessionId: string): Promise<SessionReleaseSnapshot | undefined>;
  terminalReleaseAsOfNow(session: Session, releaseReason: string): SessionReleaseSnapshot;
  readonly sessionExecutionDeadlineLookup: SessionExecutionDeadlineLookup;
  readonly expiryReleaseExecutionCanceller: ExpiryReleaseExecutionCanceller;
}

export class SessionLeaseExpiry {
  constructor(private readonly host: SessionLeaseExpiryHost) {}

  expireIfDue(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
    releaseExpired = true,
  ): Session | null {
    this.host.stallProbe?.();
    if (this.host.sessionSlots.hasTerminalSnapshot(sessionId)) {
      return null;
    }
    const session = this.host.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const startedExecution = execution && this.executionOnSessionClock(execution);
    if (expireDespiteActiveExecution) {
      if (
        this.isLateExecutionWhileEarlierWorkIsActive(session, startedExecution, "timely-control")
      ) {
        return session;
      }
      if (this.isLateExecutionWhileEarlierWorkIsActive(session, startedExecution, "recovery")) {
        throw new SessionHeldByRecoveryError(sessionId, session.assignedDevice);
      }
    }
    if (this.shouldExpireSession(session, expireDespiteActiveExecution, startedExecution)) {
      if (!releaseExpired) {
        return null;
      }
      // Release owns this exact session object until it has restored device state
      // and removed its assignment. Keep expiry cleanup from creating a second
      // incarnation with the same UUID before teardown completes, without
      // exposing the expired session to callers during that teardown.
      this.releaseExpiredSessionLazily(session, execution?.executionId);
      return null;
    }
    return session;
  }

  /** The lazy-expiry release of a session a lookup found past its idle deadline. */
  releaseExpiredSessionLazily(session: Session, callerExecutionId?: string): void {
    if (this.host.sessionSlots.isReleasing(session)) {
      return;
    }
    const sessionId = session.sessionId;
    logger.info(`Session ${sessionId} has expired, found by lookup, releasing`);
    const releaseReason = this.expiredSessionReleaseReason(session);
    this.cancelExecutionsOverriddenByExpiry(session, releaseReason, callerExecutionId);
    const release = this.host.releaseSession(sessionId, releaseReason, {
      allowExpired: true,
      expiryOrigin: "lazy-expiry",
    });
    void this.host
      .getBarrier()
      .trackExisting(release)
      .catch((error) =>
        logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`),
      );
  }

  /**
   * Release `sessionId` if it is past its idle deadline, exactly as a lookup naming it does
   * ({@link getSession}); a live, fenced or already releasing session is left as it is.
   */
  releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void {
    const session = this.host.sessions.get(sessionId);
    if (
      session &&
      !this.host.sessionSlots.hasTerminalSnapshot(sessionId) &&
      this.isSessionExpired(session)
    ) {
      this.releaseExpiredSessionLazily(session, callerExecutionId);
    }
  }

  /**
   * The live session a read is admitted under, releasing nothing. A read that arrives after the
   * idle deadline while any control call or recovery still holds the session (#11361) is not
   * admitted under it: this returns null, read-only admission resolves undefined, and the caller
   * runs the read without a session on the device {@link deviceHeldForLateRead} names. Any other
   * read past the deadline also gets null here.
   */
  observeSessionForRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): Session | null {
    if (this.host.deviceHeldForLateRead(sessionId, execution) !== undefined) {
      return null;
    }
    return this.host.unlessBaseEnded(this.expireIfDue(sessionId, true, execution, false));
  }

  /**
   * The device of the live session a read named but arrived too late to be admitted under: past
   * the idle deadline, with any control call or recovery still holding the session (#11361).
   * The read runs sessionless against this device, the one it asked about, rather than whatever device a
   * sessionless call would otherwise select. Undefined in every other case. Reads no device and
   * changes nothing: no release, no refresh, no idle credit.
   */
  deviceHeldForLateRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined {
    const session = this.host.sessions.get(sessionId);
    if (!session || this.host.sessionSlots.hasTerminalSnapshot(sessionId)) {
      return undefined;
    }
    const started = execution && this.executionOnSessionClock(execution);
    return this.isLateExecutionWhileEarlierWorkIsActive(session, started)
      ? session.assignedDevice
      : undefined;
  }

  /**
   * A call's start on the clock `expiresAt` is stamped with (#11290): its wall-clock `startTime`
   * is not comparable with a session stamp once the wall clock has stepped.
   */
  private executionOnSessionClock(execution: SessionExecutionMetadata): SessionClockExecution {
    return {
      ...execution,
      sessionClockStartTime:
        execution.sessionClockStartTime ?? this.host.wallToSessionClock(execution.startTime),
    };
  }

  private shouldExpireSession(
    session: Session,
    expireDespiteActiveExecution: boolean,
    execution?: SessionClockExecution,
  ): boolean {
    return expireDespiteActiveExecution
      ? this.isSessionExpiredForNewExecution(session, execution)
      : this.isSessionExpired(session);
  }

  /**
   * The session that speaks for `sessionId` wherever ownership is judged or recorded
   * ({@link resolveOwnershipSessionUuid}), resolved without releasing anything: an expired base
   * publishes no labels, and its release is left to the scan and the lazy-expiry paths.
   */
  ownershipSessionUuid(sessionId: string): string {
    return resolveOwnershipSessionUuid(sessionId, {
      getDeviceLabels: (id) => this.host.peekSession(id)?.cacheData.deviceLabels,
    });
  }

  /** A session's liveness owner as a claim judges it: on the owner's own heartbeats. */
  livenessOwnerView(session: Session): LivenessOwnerView {
    const ownerToken = session.livenessOwnerToken;
    // A `cli-idle` session never holds a lease against a claim (#6870).
    const hold =
      ownerToken === undefined || session.livenessPolicy === "cli-idle"
        ? "none"
        : livenessLeaseState(
            sessionOwnerLeaseSnapshot(
              session,
              this.host.sessionNow(),
              hasMintBoundClaimLease(session) &&
                (this.host.livenessOwnerCallInFlightReader?.(ownerToken) ?? false),
            ),
          ).phase;
    return { ownerToken, hold };
  }

  /**
   * The current owner's hold on the session, judged as a claim is (on the owner's own
   * heartbeats), for a refused claim to report (#10701). For a derived label session it is the
   * hold the claim was refused for, the base owner's when the label's own owner holds nothing
   * (#11602). Undefined for an unknown session and for a `cli-idle` session, which has no lease.
   */
  getOwnerLeaseHold(sessionId: string): LivenessOwnerHold | undefined {
    const named = this.host.sessions.get(sessionId);
    const base = named ? this.host.liveness.livenessBaseSession(named) : undefined;
    const session =
      named &&
      base &&
      refusedClaimHoldSource(this.livenessOwnerView(named), this.livenessOwnerView(base)) === "base"
        ? base
        : named;
    if (!session || session.livenessPolicy === "cli-idle") {
      return undefined;
    }
    return livenessOwnerHold(
      sessionOwnerLeaseSnapshot(
        session,
        this.host.sessionNow(),
        hasMintBoundClaimLease(session) &&
          (this.host.livenessOwnerCallInFlightReader?.(session.livenessOwnerToken!) ?? false),
      ),
    );
  }

  /**
   * Whether the session's owner lease is live or inside its suspect window, and
   * how long until that phase ends. Undefined for an unknown session and for a
   * `cli-idle` session, which has no lease.
   */
  getSessionLeaseState(sessionId: string): LivenessLeaseState | undefined {
    const session = this.host.sessions.get(sessionId);
    if (!session || session.livenessPolicy === "cli-idle") {
      return undefined;
    }
    return livenessLeaseState(sessionJudgedLeaseSnapshot(session, this.host.sessionNow()));
  }

  /** Whether the session is inside its suspect window (lease expired, grace running). */
  private isSessionSuspect(session: Session): boolean {
    return (
      holdsOwnerHeartbeatLease(session.livenessPolicy) &&
      livenessLeaseState(sessionJudgedLeaseSnapshot(session, this.host.sessionNow())).phase ===
        "suspect"
    );
  }

  /**
   * Reject a control call against a suspect session; only its owner's heartbeat restores it.
   * Reads are never refused (#11322): they are answered in every lease phase, restore nothing,
   * and never count as the owner's liveness.
   */
  assertSessionNotSuspect(session: Session, access: SessionAccess): void {
    if (access !== "read-only" && this.isSessionSuspect(session)) {
      const { remainingMs } = livenessLeaseState(
        sessionJudgedLeaseSnapshot(session, this.host.sessionNow()),
      );
      throw new SessionSuspectError(session.sessionId, remainingMs);
    }
  }

  /**
   * Whether the owner's lease and suspect grace have both run out, so the heartbeat monitor's
   * next scan releases the session (#11285). Only a session judged on its owner's own heartbeats
   * qualifies: one no proxy owns is kept alive by its tool calls, which are its only liveness.
   */
  private isOwnerLeaseLapsed(session: Session): boolean {
    return (
      judgesOwnerHeartbeats(session) &&
      suspectGraceMsFor(session) > 0 &&
      heartbeatLeasePastGrace(
        this.host.sessionNow(),
        this.host.judgedLeaseHeartbeat(session),
        session.heartbeatTimeoutMs,
        suspectGraceMsFor(session),
      )
    );
  }

  /** A live owner's lapsed lease awaits the next scan, unless a control call keeps it. */
  ownerLeaseAwaitsReap(sessionId: string): boolean {
    const session = this.host.peekSession(sessionId);
    return (
      session !== null &&
      this.isOwnerLeaseLapsed(session) &&
      !this.host.activeSessionExecutionChecker(sessionId, { excludeReads: true })
    );
  }

  /** Later owner proof from a same-token base, including its release-local credit (#11722). */
  judgedLeaseHeartbeat(session: Session): number {
    const ownHeartbeat = judgedLeaseHeartbeat(session);
    const baseId = this.host.ownershipSessionUuid(session.sessionId);
    const releasingBaseId =
      baseId === session.sessionId
        ? this.host.getBaseSessionOfDerivedLabel(session.sessionId)
        : baseId;
    const base =
      this.host.liveness.livenessBaseSession(session) ??
      (releasingBaseId === undefined ? undefined : this.host.getReleasingSession(releasingBaseId));
    if (
      !base ||
      !judgesOwnerHeartbeats(base) ||
      base.livenessOwnerToken === undefined ||
      base.livenessOwnerToken !== session.livenessOwnerToken
    ) {
      return ownHeartbeat;
    }
    const operation = this.host.sessionSlots.getReleaseOp(base.sessionId);
    return Math.max(
      ownHeartbeat,
      judgedLeaseHeartbeat(base),
      operation?.session === base
        ? (operation.ownerHeartbeatDuringRelease ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY,
    );
  }

  /**
   * Credit only the releasing session's owner, within its still-running lease and grace. Socket
   * heartbeats remain refused; this proof is to the suspect handoff's commit judgement.
   */
  creditOwnerHeartbeatDuringRelease(sessionId: string, ownerToken: string): void {
    const session = this.host.getReleasingSession(sessionId);
    const operation = this.host.sessionSlots.getReleaseOp(sessionId);
    if (
      !session ||
      operation?.session !== session ||
      operation.forced ||
      operation.judgeSuspectOwnerAtCommit !== true ||
      !shouldJudgeOwnerLeaseForRelease(operation.reason.value) ||
      ownerToken.length === 0 ||
      session.livenessOwnerToken !== ownerToken
    ) {
      return;
    }
    const snapshot = this.releaseOwnerLeaseSnapshot(session, operation);
    if (snapshot && livenessLeaseState(snapshot).phase !== "lapsed") {
      operation.ownerHeartbeatDuringRelease = snapshot.now;
    }
  }

  /**
   * Judge on the later of the session's own lease, a heartbeated same-token base's lease, and
   * release-local owner proof; keep the session's policy and clocks unchanged (#11707).
   */
  private releaseOwnerLeaseSnapshot(
    session: Session,
    operation?: SessionReleaseOperation,
  ): LivenessOwnerLeaseSnapshot | undefined {
    if (!judgesOwnerHeartbeats(session) || suspectGraceMsFor(session) === 0) {
      return undefined;
    }
    const snapshot = sessionJudgedLeaseSnapshot(session, this.host.sessionNow());
    snapshot.lastHeartbeat = Math.max(
      this.host.judgedLeaseHeartbeat(session),
      operation?.ownerHeartbeatDuringRelease ?? Number.NEGATIVE_INFINITY,
    );
    return snapshot;
  }

  /** Judge pre-handoff silence for plan cleanup and device restart only. */
  judgeOwnerLeaseForRelease(
    session: Session,
    reason: ReleaseReasonState,
    stage: "start" | "commit",
    operation?: SessionReleaseOperation,
  ): boolean {
    if (
      (stage === "commit" && operation?.judgeSuspectOwnerAtCommit !== true) ||
      !shouldJudgeOwnerLeaseForRelease(reason.value)
    ) {
      return false;
    }
    const snapshot = this.releaseOwnerLeaseSnapshot(session, operation);
    if (!snapshot) {
      return false;
    }
    const { phase } = livenessLeaseState(snapshot);
    if (phase === "lapsed") {
      this.host.upgradeReleaseReason(reason, "heartbeat-timeout");
    }
    return phase === "suspect";
  }

  /**
   * Refuse a control call that reached a session whose owner is gone but which the heartbeat
   * monitor has not scanned yet (#11285). Admitting it would refresh the session and let the call
   * veto the scan's release, holding the dead owner's device past `NO_HEARTBEAT_RELEASE_BUDGET_MS`.
   * The session is released now exactly as the scan would release it, and the caller gets the
   * terminal refusal. A call already in flight keeps the session (#5343), bounded by the monitor's
   * unsettled-execution veto; the new call is still refused, as it is in the suspect window.
   * Reads are never refused here.
   */
  async refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    if (access === "read-only" || !this.isOwnerLeaseLapsed(session)) {
      return;
    }
    const callerExecutionId = execution?.executionId ?? unnamedCallerExecutionId;
    // Only a control call in flight keeps the session (#5343). A read admitted since the owner
    // went quiet is watching, not use: it must not turn this refusal retryable (#11322). Nor must
    // the refused call itself, which is tracked under the session when it arrived through
    // autolock (#11400).
    const query: ActiveSessionExecutionQuery = {
      excludeReads: true,
      ...(callerExecutionId === undefined ? {} : { excludeExecutionId: callerExecutionId }),
    };
    if (this.host.activeSessionExecutionChecker(session.sessionId, query)) {
      throw new SessionSuspectError(session.sessionId, 0);
    }
    logger.info(
      `Session ${session.sessionId} lost its owner's heartbeat lease before this call; releasing`,
    );
    // Cut what the scan's reap would cut, through the routine it uses: a read still in flight is
    // answered with the typed release instead of being left running on a freed device (#11400).
    this.host.cancelExecutionsCutByRelease(
      session.sessionId,
      "heartbeat-timeout",
      callerExecutionId,
    );
    await this.host.releaseSession(session.sessionId, "heartbeat-timeout", {
      allowExpired: true,
      expiryOrigin: "lazy-expiry",
    });
    const terminalRelease =
      this.host.sessionSlots.getTerminalSnapshot(session.sessionId) ??
      (await this.host.getPersistedTerminalRelease(session.sessionId));
    if (terminalRelease) {
      throw new TerminalSessionError(session.sessionId, terminalRelease);
    }
    // The release did not finish terminally; never admit the call on the strength of that.
    throw new SessionSuspectError(session.sessionId, 0);
  }

  /**
   * A control call naming a plan label whose base lost its owner's heartbeat lease, before the
   * monitor's scan (#11640): the base's end ends its labels, so the call is answered as a call
   * naming the base is ({@link refuseControlCallOnLapsedOwnerLease}), which releases the base
   * unless a control call in flight still keeps it. The terminal answer is given under the
   * label's id with the base's reason; the retryable one names the base, whose lease it is about.
   */
  async refuseLabelCallOnLapsedBaseLease(
    label: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    if (access === "read-only" || label.persistenceMetadata?.source !== PLAN_LABEL_SESSION_SOURCE) {
      return;
    }
    const baseSessionId = this.host.getBaseSessionOfDerivedLabel(label.sessionId);
    const base = baseSessionId === undefined ? undefined : this.host.sessions.get(baseSessionId);
    if (!base || !this.isOwnerLeaseLapsed(base)) {
      return;
    }
    try {
      await this.refuseControlCallOnLapsedOwnerLease(
        base,
        access,
        execution,
        unnamedCallerExecutionId,
      );
    } catch (error) {
      if (error instanceof TerminalSessionError) {
        throw new TerminalSessionError(
          label.sessionId,
          this.host.terminalReleaseAsOfNow(label, error.release.releaseReason),
        );
      }
      throw error;
    }
  }

  /** Compensate the claim-only mint lease independently of the activity-derived stall floor. */
  forgiveMintBoundClaimLease(
    session: Session,
    resumedAt: number,
    leaseLostMs: number,
    gapBeganAt?: number,
  ): void {
    if (
      hasMintBoundClaimLease(session) &&
      (gapBeganAt === undefined ||
        leaseRunningAt(session.livenessOwnerBoundAt, session.heartbeatTimeoutMs, gapBeganAt))
    ) {
      session.livenessOwnerBoundAt = forgivenLeaseStart(
        session.livenessOwnerBoundAt,
        resumedAt,
        leaseLostMs,
      );
    }
  }

  /**
   * Check if session is expired
   */
  isSessionExpired(session: Session): boolean {
    // Owner loss, including a lapsed lease, belongs to the heartbeat monitor.
    if (ignoresManagedExecutionIdleDeadline(session.livenessPolicy)) {
      return false;
    }
    // A CLI-owned session (#6870) is governed solely by the wall-clock idle
    // policy `SessionHeartbeatMonitor` applies, which releases it as
    // `cli-idle-timeout`. The ordinary expiry deadline must not release it
    // first: autolock mints sessions with a 60 s `sessionTimeoutMs`, and both
    // deadlines would otherwise land on the same millisecond once adoption
    // widens `expiresAt`, letting the generic sweep win the tie.
    if (session.livenessPolicy === "cli-idle") {
      return false;
    }
    // The idle deadline is exactly the idle window after the last control call: the suspect
    // grace (#10051) belongs to the heartbeat lease only, never to idleness (#11107).
    if (this.host.sessionNow() <= sessionIdleDeadline(session)) {
      return false;
    }
    return !isReleaseVetoedByExecutions({
      hasActiveExecutions: this.host.activeSessionExecutionChecker(session.sessionId, {
        excludeReads: true,
      }),
      now: this.host.sessionNow(),
      ...this.idleExecutionVetoBoundInput(session),
    });
  }

  /**
   * The facts the shared unsettled-execution policy (#10712) bounds an idle-release veto by
   * (#10713). Only control calls refresh `expiresAt`, so the veto has held since the idle deadline
   * passed: it lasts until the control calls' request deadline plus grace, or, when some control
   * call has no deadline, the ceiling after the idle deadline — the same bound the heartbeat and
   * owner-disconnect paths apply (#10663).
   */
  private idleExecutionVetoBoundInput(session: Session): {
    vetoedSince: number;
    latestDeadlineMs: number | undefined;
  } {
    return {
      vetoedSince: sessionIdleDeadline(session),
      latestDeadlineMs: this.host.sessionExecutionDeadlineLookup(session.sessionId, {
        excludeReads: true,
      }),
    };
  }

  /**
   * What bounds an in-flight control call's idle-release veto for `sessionId`, or undefined when
   * nothing that vetoes the release is in flight. Hold diagnostics derive `idleReleaseAt` from it
   * with the same shared policy the idle sweep applies (#10671, #10712, #10713).
   */
  getIdleReleaseExecutionVeto(sessionId: string): { latestDeadlineMs?: number } | undefined {
    const session = this.host.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    // Report the deadline the releaser applies (#11393): the heartbeat monitor and idle sweep
    // both count only control calls, for every liveness policy (#11381).
    const query: Pick<ActiveSessionExecutionQuery, "excludeReads"> = { excludeReads: true };
    if (!this.host.activeSessionExecutionChecker(sessionId, query)) {
      return undefined;
    }
    return { latestDeadlineMs: this.host.sessionExecutionDeadlineLookup(sessionId, query) };
  }

  /**
   * An idle-expiry release overrides in-flight work only once that work's veto has run out
   * (#10713). Abort it before the release starts so a call that never settles cannot keep driving
   * the device after its next owner binds it (#10820). Every expiry path consults the veto before
   * releasing (#10956), so by the time this runs any execution still in flight is one the release
   * overrides: cancel it unconditionally rather than free the device under a running call. The
   * execution whose own lookup expired the session is spared. Returns whether it cancelled.
   */
  cancelExecutionsOverriddenByExpiry(
    session: Session,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.host.cancelExecutionsCutByRelease(
      session.sessionId,
      releaseReason,
      excludeExecutionId,
    );
  }

  /**
   * Abort every call still running under a session that is about to be released for a reason of
   * its own, with the typed release, so each cut caller gets the terminal refusal. The one routine
   * for every such release: idle sweep, lazy expiry, the lapsed-lease admission, and the daemon's
   * heartbeat reap and owner-disconnect release (#11400). It covers the released session's
   * implicit (autolock) calls too, and a base session's calls that drive a derived label session's
   * device, so a veto can never count a call the release then leaves running on a freed device.
   * A base session's call on any other device is counted by the veto but not cut: its session and
   * its device are both still held. Returns whether anything was in flight.
   */
  cancelExecutionsCutByRelease(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    const query: ActiveSessionExecutionQuery =
      excludeExecutionId === undefined ? {} : { excludeExecutionId };
    if (!this.host.activeSessionExecutionChecker(sessionId, query)) {
      return false;
    }
    this.host.expiryReleaseExecutionCanceller(
      sessionId,
      new SessionReleasedDuringCallError(sessionId, releaseReason),
      query,
      (this.host.sessions.get(sessionId) ?? this.host.getReleasingSession(sessionId))
        ?.assignedDevice,
    );
    return true;
  }

  /** Keep the heartbeat diagnostic when idle expiry wins the scan or lookup race (#10051). */
  expiredSessionReleaseReason(session: Session): SessionReleaseReason {
    if (
      suspectGraceMsFor(session) > 0 &&
      livenessLeaseState(sessionJudgedLeaseSnapshot(session, this.host.sessionNow())).phase ===
        "lapsed"
    ) {
      return "heartbeat-timeout";
    }
    return session.livenessPolicy === "cli-idle" ? "cli-idle-timeout" : IDLE_WINDOW_RELEASE_REASON;
  }

  isSessionExpiredForNewExecution(session: Session, execution?: SessionClockExecution): boolean {
    if (ignoresManagedExecutionIdleDeadline(session.livenessPolicy)) {
      return false;
    }
    // A lookup that carries no execution (routing resolution: autolock, setActiveDevice, the
    // lifecycle ownership check) is not a call that arrived after the deadline; it only asks who
    // holds the device. It must respect the unsettled-execution veto exactly as the idle sweep
    // does, or it releases a session whose long call is still driving the device (#10956).
    if (execution === undefined) {
      return this.isSessionExpired(session);
    }
    // The deadline the scan releases on and the client is told (#11558): a `cli-idle` session's
    // moves with the daemon's own stall, which its `expiresAt` does not record.
    const idleDeadline = sessionIdleDeadline(session);
    if (this.host.sessionNow() <= idleDeadline) {
      return false;
    }
    return execution.sessionClockStartTime > idleDeadline;
  }

  /**
   * A late call while control work or recovery holds the session. Only live timely control
   * work admits it; recovery alone refuses control with a retryable answer. The unbounded view
   * lets late reads use the held device sessionlessly without releasing any hold.
   */
  isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: SessionClockExecution | undefined,
    hold: "any" | "timely-control" | "recovery" = "any",
  ): boolean {
    if (ignoresManagedExecutionIdleDeadline(session.livenessPolicy)) {
      return false;
    }
    const idleDeadline = sessionIdleDeadline(session);
    return (
      execution !== undefined &&
      this.host.sessionNow() > idleDeadline &&
      execution.sessionClockStartTime > idleDeadline &&
      this.host.activeSessionExecutionChecker(session.sessionId, {
        ...(hold === "timely-control"
          ? {
              sessionClockStartedAtOrBefore: idleDeadline,
              liveOnSessionClock: {
                at: this.host.sessionNow(),
                undatedForMs: UNSETTLED_EXECUTION_VETO_CEILING_MS,
              },
            }
          : {}),
        ...(hold === "recovery" ? { recoveryOnly: true } : {}),
        excludeExecutionId: execution.executionId,
        excludeReads: true,
      })
    );
  }
}
