import type { DeviceSession } from "../../db/types";
import { type Platform } from "../../models";
import { SessionNoLongerOwnsDeviceError } from "../../models/sessionNoLongerOwnsDevice";
import { isDeviceLossCancellationReason } from "../../utils/deviceLossCancellationReason";
import { logger } from "../../utils/logger";
import {} from "../deviceStateRestoreQueue";
import { type EndedLabelBase, endedLabelBase, PlanLabelRegistry } from "../planLabelRegistry";
import {
  isIdleReleaseReason,
  isTerminalReleaseReason,
  type SessionReleaseReason,
} from "../releaseReasons";
import {
  SessionRebindingError,
  SessionTerminalReleaseInProgressError,
  TERMINAL_RELEASE_IN_PROGRESS_DETAIL,
  TerminalSessionError,
} from "../sessionErrors";
import {
  PLAN_AUTO_RELEASE_REASON,
  PLAN_LABEL_SESSION_SOURCE,
  Session,
  SessionAccess,
  SessionDeviceAssigner,
  SessionExecutionMetadata,
  SessionManager,
  SessionReleaseOperation,
  SessionReleaseSnapshot,
} from "../sessionManager";
import { ForcedStuckRelease } from "../sessionManager/forcedStuckRelease";
import {
  cliIdleWindowMarker,
  cliIdleWindowMs,
  cliIdleWindowReleaseMarker,
  persistedCliIdleWindowMs,
  type GetOrCreateSessionOptions,
  type ResolvedSessionAcquisition,
  type SessionAcquisitionOptions,
  type TerminalReleaseReservation,
} from "../sessionManager/internalContracts";
import { SessionLeaseExpiry } from "../sessionManager/leaseExpiry";
import { type SessionLifecycleSlots } from "./internalContracts";

export interface SessionAdmissionHost {
  readonly stallProbe: (() => void) | undefined;
  readonly sessionSlots: SessionLifecycleSlots;
  readonly sessions: Map<string, Session>;
  isSessionExpired(session: Session): boolean;
  unlessBaseEnded(session: Session | null): Session | null;
  expireIfDue(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
    releaseExpired?: boolean,
  ): Session | null;
  sessionNow(): number;
  recordSessionActivity(session: Session): Promise<void>;
  reclaimAndRefreshExistingSession(existing: Session): Promise<void>;
  resolveSessionAcquisitionOptions(
    options: SessionAccess | SessionAcquisitionOptions,
  ): ResolvedSessionAcquisition;
  getOrCreateSession(
    sessionId: string,
    devicePool?: SessionDeviceAssigner,
    platform?: Platform,
    options?: GetOrCreateSessionOptions,
  ): Promise<Session>;
  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null;
  assertSessionNotSuspect(session: Session, access: SessionAccess): void;
  refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void>;
  refuseLabelCallOnLapsedBaseLease(
    label: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void>;
  refreshExistingSessionForAccess(existing: Session, access: SessionAccess): Promise<void>;
  refuseLabelOfEndedBase(
    sessionId: string,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    callerExecutionId: string | undefined,
  ): void;
  assertTerminalReleaseAdmission(sessionId: string, allowedSession?: Session): void;
  readonly forcedStuckRelease: ForcedStuckRelease;
  startOrJoinUnseenAssignment(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    acquisition: ResolvedSessionAcquisition & { requireIssuedSession: boolean },
  ): Promise<Session>;
  preFenceIdleReleaseReason(
    sessionId: string,
    current: SessionReleaseOperation | undefined,
  ): string | undefined;
  endedBaseOfLabel(label: Session): EndedLabelBase | undefined;
  readPersistedSession(sessionId: string): Promise<DeviceSession | undefined>;
  expiredReleaseOfUnheldRow(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
  peekTerminalAnswerForEndedSession(sessionId: string): TerminalSessionError | undefined;
  expiredReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
  readonly planLabels: PlanLabelRegistry;
  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined;
  sessionEndReason(sessionId: string): string | undefined;
  expiredSessionReleaseReason(session: Session): SessionReleaseReason;
  releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void;
  terminalReleaseAsOfNow(
    session: Session,
    releaseReason: string,
    endedBase?: EndedLabelBase,
  ): SessionReleaseSnapshot;
  readonly leaseExpiry: SessionLeaseExpiry;
  liveBaseOfDerivedId(sessionId: string): string | undefined;
}

export class SessionAdmission {
  constructor(private readonly host: SessionAdmissionHost) {}

  /** Pure lookup with getSession's default expiry judgement, apart from the stall probe. */

  findSession(sessionId: string): Session | null {
    this.host.stallProbe?.();
    if (this.host.sessionSlots.hasTerminalSnapshot(sessionId)) {
      return null;
    }
    const session = this.host.sessions.get(sessionId);
    return session && !this.host.isSessionExpired(session) ? session : null;
  }

  /**
   * Resolve a session before a new tool execution is accepted. A timely control call still in
   * flight keeps the session in use, so another control call may join it after the idle deadline.
   * Only live timely control work admits it: late or non-live calls end the idle session at once.
   * Recovery alone preserves the hold and refuses the late call with a typed retryable answer.
   */

  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    return this.host.unlessBaseEnded(this.host.expireIfDue(sessionId, true, execution));
  }

  /**
   * Get or create session with device assignment
   *
   * Automatically creates a session if it doesn't exist.
   * Called when --session-uuid is provided to a CLI command.
   *
   * @param sessionId - The session UUID
   * @param devicePool - DevicePool instance for automatic device assignment
   */
  /**
   * Resolving a session for a tool call is activity: extend both the idle
   * timeout (expiresAt) and the heartbeat clock (lastHeartbeat). Without the
   * latter, the daemon heartbeat watchdog would reap an actively-used session
   * whose tools never write session cache (e.g. autolock CLI/agent clients
   * that do not send explicit heartbeats). An awaiting-owner session is
   * reclaimed by the call.
   */

  async reclaimAndRefreshExistingSession(existing: Session): Promise<void> {
    const now = this.host.sessionNow();
    const previousActivity = {
      lastUsedAt: existing.lastUsedAt,
      lastHeartbeat: existing.lastHeartbeat,
      expiresAt: existing.expiresAt,
      ownership: existing.ownership,
      awaitingOwnerSince: existing.awaitingOwnerSince,
    };
    if (existing.ownership === "awaiting-owner") {
      existing.ownership = "owned";
      existing.awaitingOwnerSince = undefined;
    }
    existing.lastUsedAt = now;
    existing.lastHeartbeat = now;
    existing.expiresAt = now + existing.sessionTimeoutMs;
    existing.activityGeneration++;
    const capturedGeneration = existing.activityGeneration;
    try {
      await this.host.recordSessionActivity(existing);
    } catch (error) {
      // An awaited activity refresh cannot advertise fresh in-memory liveness
      // after its durable write failed; callers receive the typed failure.
      // Only the latest refresh may roll back, so an older failure cannot clobber newer liveness.
      if (existing.activityGeneration === capturedGeneration) {
        Object.assign(existing, previousActivity);
      }
      throw error;
    }
  }

  async refreshExistingSessionForAccess(existing: Session, access: SessionAccess): Promise<void> {
    // Only the client's own control call reclaims and refreshes: a read is not use, and a
    // non-owner control call must not stand in for the owner or its activity (#11417).
    if (access !== "acquire") {
      return;
    }
    await this.host.reclaimAndRefreshExistingSession(existing);
  }

  async getOrCreateSession(
    sessionId: string,
    devicePool?: SessionDeviceAssigner,
    platform?: Platform,
    options: GetOrCreateSessionOptions = {},
  ): Promise<Session> {
    const { execution, requireIssuedSession = false, ...accessOptions } = options;
    const { access, requestDeadlineMs, callerExecutionId, signal } =
      this.host.resolveSessionAcquisitionOptions(accessOptions);
    const pendingRebind = this.host.sessionSlots.getRebind(sessionId);
    if (pendingRebind) {
      await pendingRebind.promise;
      return await this.host.getOrCreateSession(sessionId, devicePool, platform, options);
    }

    const existing = this.host.getSessionForNewExecution(sessionId, execution);
    if (existing) {
      const inFlightRelease = this.host.sessionSlots.getReleaseOp(sessionId);
      if (this.host.sessionSlots.isReleasing(existing) && inFlightRelease?.session === existing) {
        await inFlightRelease.promise;
        return await this.host.getOrCreateSession(sessionId, devicePool, platform, {
          ...accessOptions,
          requireIssuedSession,
        });
      }
      logger.info(
        `[SessionManager] Found existing session ${sessionId} with device ${existing.assignedDevice}`,
      );
      this.host.assertSessionNotSuspect(existing, access);
      await this.host.refuseControlCallOnLapsedOwnerLease(
        existing,
        access,
        execution,
        callerExecutionId,
      );
      await this.host.refuseLabelCallOnLapsedBaseLease(
        existing,
        access,
        execution,
        callerExecutionId,
      );
      await this.host.refreshExistingSessionForAccess(existing, access);
      return existing;
    }

    this.host.refuseLabelOfEndedBase(sessionId, access, execution, callerExecutionId);
    this.host.assertTerminalReleaseAdmission(sessionId);

    const terminalRelease = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }

    const inFlightRelease = this.host.forcedStuckRelease.inFlightReleaseStillOwning(sessionId);
    const currentSession = this.host.sessions.get(sessionId);
    if (
      inFlightRelease &&
      (currentSession === undefined || inFlightRelease.session === currentSession)
    ) {
      await inFlightRelease.promise;
      return await this.host.getOrCreateSession(sessionId, devicePool, platform, {
        ...accessOptions,
        requireIssuedSession,
      });
    }

    return await this.host.startOrJoinUnseenAssignment(sessionId, devicePool, platform, {
      requireIssuedSession,
      access,
      requestDeadlineMs,
      signal,
    });
  }

  /**
   * The known end of a UUID (#10730), from the ended-session answer, in-memory terminal snapshot
   * or persisted `release_reason`. Undefined for a live session or an unknown UUID. A row released
   * before its latest handout keeps its stored reason regardless of its creation deadline.
   *
   * Idle ends are named from the start of teardown via registration's read-only ended-session
   * predicate. Other releases stay unanswered before the fence. Commit-fenced operations can
   * leave the session live, and non-terminal handoffs preserve it for reissue, so neither is
   * named early even if its idle deadline has passed. After the fence, a terminal non-device-loss
   * release uses the operation's live reason so a join is visible before its snapshot upgrades
   * (#11646); commit-fenced operations and device-loss cancellations stay unanswered.
   * The read-only answer also names an unheld idle deadline without starting release; a timely
   * control call's execution hold still keeps it live. A plan label whose base has ended is
   * otherwise answered with the base's reason.
   */

  async getReleasedSessionReason(sessionId: string): Promise<string | undefined> {
    const published = this.host.sessions.get(sessionId);
    const inMemory = this.host.sessionSlots.getTerminalSnapshot(sessionId)?.releaseReason;
    if (published) {
      const inFlightReason = (): string | undefined => {
        const operation = this.host.sessionSlots.getReleaseOp(sessionId);
        const current = operation?.session === published ? operation : undefined;
        if (inMemory === undefined) {
          return this.host.preFenceIdleReleaseReason(sessionId, current);
        }
        const reason = current?.reason.value ?? inMemory;
        return !current?.commitFenced &&
          reason !== undefined &&
          isTerminalReleaseReason(reason) &&
          !isDeviceLossCancellationReason(reason)
          ? reason
          : undefined;
      };
      // A label whose base has ended is answered with the base's end (#11640), before the
      // release that follows has recorded it on the label's own row.
      return inFlightReason() ?? this.host.endedBaseOfLabel(published)?.releaseReason;
    }
    if (inMemory) {
      return inMemory;
    }
    // Through the recovered-intent overlay so a pending intent reads as released (#11077).
    const persisted = await this.host.readPersistedSession(sessionId);
    if (!persisted) {
      return undefined;
    }
    // A row past its first deadline is answered as admission answers it (#11361), so a
    // heartbeat or session-info client is not told
    // a session is resumable when a call naming it is refused for good.
    return (
      this.host.expiredReleaseOfUnheldRow(sessionId, persisted)?.releaseReason ??
      persisted.release_reason ??
      undefined
    );
  }

  /**
   * The CLI idle window a released UUID had (#16937), for a session-not-found answer naming a
   * `cli-idle-timeout` release: from its terminal snapshot, its still-published session, or its
   * persisted row (so a restarted daemon still knows it). Undefined unless that session was itself
   * on the `cli-idle` policy (#16940), or is a plan label that inherited its base's
   * `cli-idle-timeout`: the label reports the base's window, which is the one that expired (#16971).
   */

  async getReleasedSessionIdleTimeoutMs(sessionId: string): Promise<number | undefined> {
    const fenced = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (fenced) {
      return fenced.cliIdleTimeoutMs;
    }
    const published = this.host.sessions.get(sessionId);
    if (published) {
      return cliIdleWindowMs(published) ?? this.host.endedBaseOfLabel(published)?.cliIdleTimeoutMs;
    }
    const persisted = await this.host.readPersistedSession(sessionId);
    if (!persisted) {
      return undefined;
    }
    return (
      persistedCliIdleWindowMs(persisted) ??
      (await this.persistedInheritedCliIdleWindowMs(sessionId, persisted))
    );
  }

  /**
   * The window a plan label's row inherited from its base's `cli-idle-timeout` (#16971), read from
   * the base's row: the label's row records only the reason. The nearest `${base}` prefix whose
   * row ended with `cli-idle-timeout` on the `cli-idle` policy is the base that expired; an
   * intermediate label inherited the same end and has no window of its own.
   */
  private async persistedInheritedCliIdleWindowMs(
    sessionId: string,
    persisted: DeviceSession,
  ): Promise<number | undefined> {
    if (
      persisted.source !== PLAN_LABEL_SESSION_SOURCE ||
      persisted.release_reason !== "cli-idle-timeout"
    ) {
      return undefined;
    }
    for (
      let separator = sessionId.lastIndexOf(":");
      separator > 0;
      separator = sessionId.lastIndexOf(":", separator - 1)
    ) {
      const base = await this.host.readPersistedSession(sessionId.slice(0, separator));
      const window =
        base?.release_reason === "cli-idle-timeout" ? persistedCliIdleWindowMs(base) : undefined;
      if (window !== undefined) {
        return window;
      }
    }
    return undefined;
  }

  preFenceIdleReleaseReason(
    sessionId: string,
    current: SessionReleaseOperation | undefined,
  ): string | undefined {
    if (current?.commitFenced || (current && !isTerminalReleaseReason(current.reason.value))) {
      return undefined;
    }
    const reason = this.host.peekTerminalAnswerForEndedSession(sessionId)?.release.releaseReason;
    return reason !== undefined && isIdleReleaseReason(reason) ? reason : undefined;
  }

  /**
   * {@link expiredReleaseFromPersisted} for a wire that answers outside admission: undefined while
   * this daemon is still creating, recovering or releasing the UUID. A caller in flight keeps a
   * device-restart recovery past the row's idle deadline, and a release in teardown has not
   * written its reason yet, so the row's deadline alone does not say the session has ended.
   */

  expiredReleaseOfUnheldRow(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined {
    if (
      this.host.sessions.has(sessionId) ||
      this.host.sessionSlots.hasAssignment(sessionId) ||
      this.host.sessionSlots.hasCreation(sessionId) ||
      this.host.sessionSlots.hasRecovery(sessionId) ||
      this.host.sessionSlots.hasReleaseOp(sessionId)
    ) {
      return undefined;
    }
    return this.host.expiredReleaseFromPersisted(sessionId, persisted);
  }

  /**
   * The release of a session whose row ran out its idle or recovery window with no daemon holding
   * it (#11361), for a wire that answers from a snapshot; undefined for a live, terminally
   * released, still-recoverable, in-recovery or never-issued UUID. Reads only: the row is left as
   * it is.
   */

  async getExpiredReleaseSnapshot(sessionId: string): Promise<SessionReleaseSnapshot | undefined> {
    if (
      this.host.sessions.has(sessionId) ||
      this.host.sessionSlots.hasTerminalSnapshot(sessionId)
    ) {
      return undefined;
    }
    const persisted = await this.host.readPersistedSession(sessionId);
    return persisted && this.host.expiredReleaseOfUnheldRow(sessionId, persisted);
  }

  /** Prevent this exact session UUID from being rebound while its device shutdown is in flight. */

  reserveSessionForTerminalRelease(session: Session, expectedDeviceId: string): () => void {
    if (session.assignedDevice !== expectedDeviceId) {
      throw new SessionNoLongerOwnsDeviceError(session.sessionId, expectedDeviceId);
    }
    if (this.host.sessionSlots.hasRebind(session.sessionId)) {
      throw new SessionRebindingError(session.sessionId);
    }
    const existing = this.host.sessionSlots.getTerminalReservation(session.sessionId);
    if (existing) {
      throw new SessionTerminalReleaseInProgressError(
        session.sessionId,
        expectedDeviceId,
        "is already reserved for terminal release",
      );
    }
    const reservation: TerminalReleaseReservation = {
      session,
      deviceId: expectedDeviceId,
      owner: Symbol(session.sessionId),
    };
    this.host.sessionSlots.setTerminalReservation(session.sessionId, reservation);
    return () => {
      if (
        this.host.sessionSlots.getTerminalReservation(session.sessionId)?.owner ===
        reservation.owner
      ) {
        this.host.sessionSlots.deleteTerminalReservation(session.sessionId);
      }
    };
  }

  assertTerminalReleaseAdmission(sessionId: string, allowedSession?: Session): void {
    const reservation = this.host.sessionSlots.getTerminalReservation(sessionId);
    if (reservation && reservation.session !== allowedSession) {
      throw new SessionTerminalReleaseInProgressError(
        sessionId,
        reservation.deviceId,
        TERMINAL_RELEASE_IN_PROGRESS_DETAIL,
      );
    }
  }

  assertTerminalRebindAdmission(sessionId: string, reservationOwner: symbol | undefined): void {
    const reservation = this.host.sessionSlots.getTerminalReservation(sessionId);
    if (reservation && reservation.owner !== reservationOwner) {
      throw new SessionTerminalReleaseInProgressError(
        sessionId,
        reservation.deviceId,
        TERMINAL_RELEASE_IN_PROGRESS_DETAIL,
      );
    }
  }

  /**
   * How the base of the plan label session `label` has ended, when it has (#11640): the base's
   * end ends its labels, so a label whose base is released, being released for a terminal reason,
   * or past its idle deadline and not yet scanned is no longer a live session to anyone. The
   * reason is the base's recorded one, or the one its expiry would record; a `cli-idle-timeout`
   * end carries the base's window (#16971). A read of state: it
   * releases, stamps and fences nothing. Undefined for a session no plan run minted, and once the
   * label itself has been removed, including while the release cascade runs.
   */

  endedBaseOfLabel(label: Session): EndedLabelBase | undefined {
    if (label.persistenceMetadata?.source !== PLAN_LABEL_SESSION_SOURCE) {
      return undefined;
    }
    const retained = this.host.planLabels.retainedEndedBase(label.sessionId);
    if (retained) {
      return retained;
    }
    // Each hop is a strict prefix of the last, so this ends at the outermost base.
    for (
      let baseSessionId = this.host.getBaseSessionOfDerivedLabel(label.sessionId);
      baseSessionId !== undefined;
      baseSessionId = this.host.getBaseSessionOfDerivedLabel(baseSessionId)
    ) {
      const releaseReason = this.host.sessionEndReason(baseSessionId);
      if (releaseReason !== undefined) {
        return endedLabelBase(
          baseSessionId,
          releaseReason,
          this.sessionEndCliIdleWindowMs(baseSessionId),
        );
      }
    }
    return undefined;
  }

  /** The terminal reason `sessionId` ended with, or would be released with by a lookup now. */

  sessionEndReason(sessionId: string): string | undefined {
    const fenced = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (fenced) {
      return fenced.releaseReason;
    }
    const session = this.host.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const inFlight = this.host.sessionSlots.getReleaseOp(sessionId);
    if (inFlight?.session === session && isTerminalReleaseReason(inFlight.reason.value)) {
      return inFlight.reason.value;
    }
    return this.host.isSessionExpired(session)
      ? this.host.expiredSessionReleaseReason(session)
      : undefined;
  }

  /**
   * The CLI idle window `sessionId` ended with, or would end with by a lookup now: its terminal
   * snapshot's, else the published session's own when it is on the `cli-idle` policy.
   */

  private sessionEndCliIdleWindowMs(sessionId: string): number | undefined {
    const fenced = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (fenced) {
      return fenced.cliIdleTimeoutMs;
    }
    const session = this.host.sessions.get(sessionId);
    return session && cliIdleWindowMs(session);
  }

  /** A looked-up session, unless it is a plan label whose base has ended (#11640). */

  unlessBaseEnded(session: Session | null): Session | null {
    return session && this.host.endedBaseOfLabel(session) ? null : session;
  }

  /**
   * The terminal release `session` is answered with before its own release has recorded one. A
   * plan label answered with its ended base's reason reports the base's CLI idle window, not its
   * own heartbeat lease (#16940, #16971).
   */

  terminalReleaseAsOfNow(
    session: Session,
    releaseReason: string,
    endedBase?: EndedLabelBase,
  ): SessionReleaseSnapshot {
    const now = this.host.sessionNow();
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason,
      releasedAtMs: now,
      terminal: true,
      ...(endedBase
        ? cliIdleWindowMarker(endedBase.cliIdleTimeoutMs)
        : cliIdleWindowReleaseMarker(session)),
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, now - session.lastHeartbeat),
      },
    };
  }

  /**
   * Refuse a call naming a plan label whose base has ended (#11640) with the terminal answer the
   * base's own end gives, under the label's id and for the owner and anyone else alike. Judging
   * is a read; a refused control call then ends the base as a call naming the base would, through
   * the base's lazy expiry, and the base's release takes its labels with it. A read is not use
   * and releases nothing.
   */

  refuseLabelOfEndedBase(
    sessionId: string,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    callerExecutionId: string | undefined,
  ): void {
    const label = this.host.sessions.get(sessionId);
    const ended = label && this.host.endedBaseOfLabel(label);
    if (!label || !ended) {
      return;
    }
    if (access !== "read-only") {
      this.host.releaseSessionPastIdleDeadline(
        ended.baseSessionId,
        execution?.executionId ?? callerExecutionId,
      );
    }
    throw new TerminalSessionError(
      sessionId,
      this.host.terminalReleaseAsOfNow(label, ended.releaseReason, ended),
    );
  }

  /**
   * The terminal answer for a call that needs `sessionId` live when it has ended or is past its
   * idle deadline (#11640), or undefined while it is live. A plan step routed by a `device` label
   * asks this about its base once the base publishes no labels, so the plan fails with the base's
   * release reason rather than "label is not allocated". The step names the base, so a base past
   * its deadline is released here through its lazy expiry, like any call naming it.
   */

  terminalAnswerForEndedSession(
    sessionId: string,
    callerExecutionId?: string,
  ): TerminalSessionError | undefined {
    const answer = this.host.peekTerminalAnswerForEndedSession(sessionId);
    if (answer) {
      this.host.releaseSessionPastIdleDeadline(sessionId, callerExecutionId);
    }
    return answer;
  }

  /** The same terminal answer, judged without releasing or stamping anything (#11640). */

  peekTerminalAnswerForEndedSession(sessionId: string): TerminalSessionError | undefined {
    const session = this.host.sessions.get(sessionId);
    const ownReason = this.host.sessionEndReason(sessionId);
    const endedBase =
      ownReason === undefined && session ? this.host.endedBaseOfLabel(session) : undefined;
    const releaseReason = ownReason ?? endedBase?.releaseReason;
    if (releaseReason === undefined) {
      return undefined;
    }
    const fenced = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (fenced || !session) {
      return fenced && new TerminalSessionError(sessionId, fenced);
    }
    return new TerminalSessionError(
      sessionId,
      this.host.terminalReleaseAsOfNow(session, releaseReason, endedBase),
    );
  }

  refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.host.leaseExpiry.refuseControlCallOnLapsedOwnerLease(
      session,
      access,
      execution,
      unnamedCallerExecutionId,
    );
  }

  refuseLabelCallOnLapsedBaseLease(
    label: Session,
    access: SessionAccess,
    execution: SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.host.leaseExpiry.refuseLabelCallOnLapsedBaseLease(
      label,
      access,
      execution,
      unnamedCallerExecutionId,
    );
  }

  refuseLabelMintOutsidePlanAllocation(sessionId: string, deviceId: string): void {
    if (
      this.host.planLabels.isMinting(sessionId) ||
      this.host.sessionSlots.hasRecovery(sessionId)
    ) {
      return;
    }
    const baseSessionId = this.host.liveBaseOfDerivedId(sessionId);
    if (baseSessionId === undefined) {
      return;
    }
    logger.warn(
      `Refused to create session ${sessionId} outside a plan allocation of its base ${baseSessionId}`,
    );
    const now = this.host.sessionNow();
    throw new TerminalSessionError(sessionId, {
      sessionId,
      deviceId,
      releaseReason: PLAN_AUTO_RELEASE_REASON,
      releasedAtMs: now,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: now,
        hasReceivedHeartbeat: false,
        timeoutMs: SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS,
        ageMs: 0,
      },
    });
  }
}
