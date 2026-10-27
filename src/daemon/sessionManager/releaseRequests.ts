import {
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import {
  type SessionReleaseReason,
  isExpiryReleaseReason,
  isTerminalReleaseReason,
  releasedRowStatus,
} from "../releaseReasons";
import type { ReleaseSessionRequest } from "../releaseSessionRequest";
import {
  type ConditionalSessionRelease,
  type RecoveryExpiryReleaseHandler,
  type ReleaseCommitFence,
  type ReleaseDeviceHold,
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  type Session,
  type SessionExecutionMetadata,
  type SessionReleaseOperation,
  type SessionReleaseOptions,
  type SessionReleaseSnapshot,
  getSessionReleaseStuckDeadlineMs,
} from "../sessionManager";
import { ForcedStuckRelease } from "../sessionManager/forcedStuckRelease";
import { type SessionRowWriter } from "../sessionRowWriter";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import {
  type PendingSessionRebind,
  type PendingSessionRelease,
  type ReleaseReasonState,
  type SessionLifecycleSlots,
  restartRecoveryDeadlineFromPersisted,
} from "./internalContracts";
import type { ReleaseSessionInternalRequest } from "./releaseCommit";
import { classifyOwnedRelease, classifyUnpublishedRelease } from "./releaseTarget";

export interface SessionReleaseRequestsHost {
  readonly recoveryExpiryReleaseHandler: RecoveryExpiryReleaseHandler | undefined;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    | "hasTerminalSnapshot"
    | "getReleaseOp"
    | "markReleasing"
    | "getRebind"
    | "setReleaseOp"
    | "addActiveRelease"
    | "deleteActiveRelease"
    | "deleteReleaseOp"
    | "hasAssignment"
    | "hasCreation"
    | "getTerminalSnapshot"
    | "getTerminalReasonState"
    | "getAssignment"
    | "getCreation"
    | "setTerminalSnapshot"
    | "getReleaseRequest"
    | "setReleaseRequest"
    | "deleteReleaseRequest"
  >;
  readonly sessions: Pick<Map<string, Session>, "get" | "has">;
  expireIfDue(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
    releaseExpired?: boolean,
  ): Session | null;
  upgradeReleaseReason(reason: ReleaseReasonState, candidate: string): void;
  markIdentityReplacedRelease(
    release: SessionReleaseOperation,
    options?: SessionReleaseOptions,
    shouldCommit?: ReleaseCommitFence,
  ): void;
  readonly releaseDeviceHold: ((sessionId: string) => ReleaseDeviceHold | undefined) | undefined;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  createReleaseReasonState(sessionId: string, releaseReason: string): ReleaseReasonState;
  judgeOwnerLeaseForRelease(
    session: Session,
    reason: ReleaseReasonState,
    stage: "start" | "commit",
    operation?: SessionReleaseOperation,
  ): boolean;
  sessionNow(): number;
  flushDeferredRebindCleanups(filter?: { sessionId?: string; deviceId?: string }): void;
  finishReleaseForcedBeforeStart(session: Session): Promise<null>;
  releaseSessionInternal(request: ReleaseSessionInternalRequest): Promise<string | null>;
  finishIdentityReplacedRelease(release: SessionReleaseOperation): void;
  releaseSession(
    sessionId: string,
    releaseReason?: SessionReleaseReason,
    request?: ReleaseSessionRequest,
  ): Promise<string | null>;
  readonly finalizedSessionReleases: Pick<WeakMap<Session, ReleaseReasonState>, "get">;
  releaseFinalizedSession(
    reason: ReleaseReasonState,
    releaseReason: string,
  ): Promise<string | null>;
  readonly forcedStuckRelease: ForcedStuckRelease;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
  readonly rowWriter: Pick<SessionRowWriter, "pendingNonTerminalReleases">;
  readPersistedSession(sessionId: string): Promise<DeviceSession | undefined>;
  isReissuablePersistedSession(persisted: DeviceSession | undefined): boolean;
  terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
  persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void>;
  notifySessionRelease(snapshot: SessionReleaseSnapshot, options?: SessionReleaseOptions): void;
  isSessionBeingRecreated(sessionId: string): boolean;
  readonly deviceSessionRepository: Pick<DeviceSessionPersistence, "markReleased">;
  readonly daemonSessionId: string | undefined;
  isLiveDaemonSession(daemonSessionId: string): boolean;
  readonly restartRecoveryActivityAt: Pick<Map<string, number>, "delete">;
  readonly timer: Timer;
}

/** Drop the request-only `expectedOwner` control so release listeners never see it. */
function omitExpectedOwner(
  request: Omit<ReleaseSessionRequest, "allowExpired" | "commitFence">,
): SessionReleaseOptions {
  const options: Omit<typeof request, "expectedOwner"> & { expectedOwner?: unknown } = {
    ...request,
  };
  delete options.expectedOwner;
  return options;
}

export class SessionReleaseRequests {
  constructor(private readonly host: SessionReleaseRequestsHost) {}

  /**
   * Release a session and free its device
   *
   * Called when a test completes or times out.
   * Returns the device ID so DevicePool can mark it as available.
   */
  releaseSession(
    sessionId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    // Not async: a pass-through, so it adds no microtask to the release's settled budget.
    if (request.expectedOwner) {
      const { expectedOwner, ...rest } = request;
      return this.releaseIfOwned(
        sessionId,
        expectedOwner.session,
        expectedOwner.deviceId,
        releaseReason,
        rest,
      );
    }
    return this.releaseSessionForReason(sessionId, releaseReason, request);
  }

  /**
   * {@link releaseSession} for a reason already recorded on a release in flight. New releases go
   * through `releaseSession`, whose typed reason must be tagged in the release-reason table.
   */
  async releaseSessionForReason(
    sessionId: string,
    releaseReason: string,
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    const { allowExpired = false, commitFence, ...withOwner } = request;
    const releaseOptions = omitExpectedOwner(withOwner);
    const attempt = () =>
      this.releaseSessionAttempt(
        sessionId,
        releaseReason,
        allowExpired,
        commitFence,
        releaseOptions,
      );
    if (isExpiryReleaseReason(releaseReason)) {
      const recoveryRelease = this.host.recoveryExpiryReleaseHandler?.release(
        sessionId,
        releaseReason,
        attempt,
        releaseOptions,
      );
      if (recoveryRelease) {
        return await recoveryRelease;
      }
    }
    return await attempt();
  }

  private async releaseSessionAttempt(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
    shouldCommit?: ReleaseCommitFence,
    options: SessionReleaseOptions = {},
  ): Promise<string | null> {
    const session =
      allowExpired || this.host.sessionSlots.hasTerminalSnapshot(sessionId)
        ? (this.host.sessions.get(sessionId) ?? null)
        : // Not `getSession`: a label whose base has ended is still there to release (#11640).
          this.host.expireIfDue(sessionId, false);
    if (!session) {
      return await this.releaseUnpublishedSession(sessionId, releaseReason, allowExpired);
    }

    const inFlightRelease = this.host.sessionSlots.getReleaseOp(sessionId);
    if (inFlightRelease?.session === session) {
      this.host.upgradeReleaseReason(inFlightRelease.reason, releaseReason);
      this.host.markIdentityReplacedRelease(inFlightRelease, options, shouldCommit);
      return await inFlightRelease.promise;
    }

    const hold = this.host.releaseDeviceHold?.(sessionId);
    this.host.sessionSlots.markReleasing(session);
    this.host.slotShadowProbe.check(sessionId, "release-start");
    const pendingRebind = this.host.sessionSlots.getRebind(sessionId);
    const reason = this.host.createReleaseReasonState(sessionId, releaseReason);
    const judgeSuspectOwnerAtCommit = this.host.judgeOwnerLeaseForRelease(session, reason, "start");
    const release: SessionReleaseOperation = {
      session,
      options: { ...options },
      commitFenced: shouldCommit !== undefined,
      promise: Promise.resolve(null),
      reason,
      judgeSuspectOwnerAtCommit,
      startedAtMs: this.host.sessionNow(),
      stuckDeadlineMs: getSessionReleaseStuckDeadlineMs(session.cacheData),
      expiryOrigin: options.expiryOrigin,
      forcedAbort: new AbortController(),
    };
    const run = () => {
      this.host.flushDeferredRebindCleanups({ sessionId });
      return release.forced
        ? this.host.finishReleaseForcedBeforeStart(session)
        : this.host.releaseSessionInternal({
            sessionId,
            session,
            reason,
            shouldCommit,
            options: release.options,
            operation: release,
          });
    };
    try {
      release.promise = this.startReleaseWithDeviceHold(release, hold, pendingRebind, run);
      this.host.sessionSlots.setReleaseOp(sessionId, release);
      this.host.sessionSlots.addActiveRelease(release);
      return await release.promise;
    } finally {
      this.host.finishIdentityReplacedRelease(release);
      this.host.sessionSlots.deleteActiveRelease(release);
      if (this.host.sessionSlots.getReleaseOp(sessionId) === release) {
        this.host.sessionSlots.deleteReleaseOp(sessionId);
        this.host.slotShadowProbe.check(sessionId, "release-end");
      }
    }
  }

  /** Resolve the optional device hold without changing an ordinary release's promise turns. */
  private startReleaseWithDeviceHold(
    release: SessionReleaseOperation,
    hold: ReleaseDeviceHold | undefined,
    pendingRebind: PendingSessionRebind | undefined,
    run: () => Promise<string | null>,
  ): Promise<string | null> {
    if (hold && "skipDeviceWrites" in hold) {
      release.options.deviceIdentityReplaced = true;
    }
    this.host.markIdentityReplacedRelease(release);
    if (hold && "settled" in hold) {
      return this.startReleaseAwaitingOwnership(release, hold, pendingRebind, run);
    }
    if (pendingRebind?.session === release.session) {
      release.stage = "awaiting-rebind";
      return pendingRebind.promise.then(run, run);
    }
    return run();
  }

  /** Only held releases wait; the ordinary release path keeps its synchronous start. */
  private startReleaseAwaitingOwnership(
    release: SessionReleaseOperation,
    hold: Extract<ReleaseDeviceHold, { settled: Promise<unknown> }>,
    pendingRebind: PendingSessionRebind | undefined,
    run: () => Promise<string | null>,
  ): Promise<string | null> {
    const { session } = release;
    const sessionId = session.sessionId;
    release.stage = "awaiting-ownership";
    release.teardownStartsByMs = this.host.sessionNow() + hold.capMs;
    const apply = (outcome: unknown) => {
      release.teardownStartsByMs = this.host.sessionNow();
      if (outcome !== "teardown") {
        release.options.deviceIdentityReplaced = true;
        this.host.markIdentityReplacedRelease(release);
      }
    };
    return hold.settled
      .then(apply, (error: unknown) => {
        logger.warn(`[SessionManager] Release ownership hold failed for ${sessionId}`, error);
        apply("skip-device-writes");
      })
      .then(() => {
        if (pendingRebind?.session === session) {
          release.stage = "awaiting-rebind";
          return pendingRebind.promise.then(run, run);
        }
        return run();
      });
  }

  /**
   * Release a session unless `shouldCommit` declines at the commit point.
   *
   * A device-loss eviction races discovery: a newer observation can confirm the
   * same serial still hosts the live runtime while release is awaiting tracked
   * setup or restoration work. The predicate is re-evaluated synchronously
   * immediately before the session is removed (after every await), so such a
   * confirmation stops the stale eviction instead of being outrun by it
   * (#7031). `superseded: true` means nothing was released.
   */
  async releaseSessionUnlessSuperseded(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    request: ReleaseSessionRequest = {},
  ): Promise<ConditionalSessionRelease> {
    const { commitFence: shouldCommit, ...rest } = request;
    let superseded = false;
    const fence: ReleaseCommitFence | undefined =
      shouldCommit === undefined
        ? undefined
        : () => {
            if (superseded || shouldCommit() === false) {
              superseded = true;
              return false;
            }
            return true;
          };
    const deviceId = await this.host.releaseSession(sessionId, releaseReason, {
      ...rest,
      commitFence: fence,
    });
    return superseded ? { superseded: true } : { superseded: false, deviceId };
  }

  /** Release only the recorded session incarnation while it still owns the device. */
  private async releaseIfOwned(
    sessionId: string,
    expectedSession: Session,
    expectedDeviceId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    const target = classifyOwnedRelease(this.host, sessionId, expectedSession, expectedDeviceId);
    switch (target) {
      case "release":
        return await this.host.releaseSession(sessionId, releaseReason, request);
      case "decline":
        return null;
      case "finalized":
        return await this.releaseFinalizedSessionIfOwned(
          sessionId,
          expectedSession,
          expectedDeviceId,
          releaseReason,
        );
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  }

  private async releaseFinalizedSessionIfOwned(
    sessionId: string,
    expectedSession: Session,
    expectedDeviceId: string,
    releaseReason: string,
  ): Promise<string | null> {
    const finalizedRelease = this.host.finalizedSessionReleases.get(expectedSession);
    if (
      finalizedRelease?.finalizedSnapshot?.sessionId === sessionId &&
      finalizedRelease.finalizedSnapshot.deviceId === expectedDeviceId &&
      isTerminalReleaseReason(releaseReason)
    ) {
      return await this.host.releaseFinalizedSession(finalizedRelease, releaseReason);
    }
    return null;
  }

  private async releaseUnpublishedSession(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
  ): Promise<string | null> {
    const target = classifyUnpublishedRelease(this.host, sessionId, releaseReason);
    switch (target.kind) {
      case "forced-in-flight": {
        const { release } = target;
        if (release.reason.finalizedSnapshot && isTerminalReleaseReason(releaseReason)) {
          return await this.host.releaseFinalizedSession(release.reason, releaseReason);
        }
        this.host.upgradeReleaseReason(release.reason, releaseReason);
        return await release.promise;
      }
      case "terminal-fenced": {
        const { snapshot, reasonState } = target;
        if (reasonState) {
          return await this.host.releaseFinalizedSession(reasonState, releaseReason);
        }
        await this.host.persistSessionRelease(snapshot);
        return snapshot.deviceId;
      }
      case "row-pending":
        return (await this.host.persistSessionRelease(target.snapshot, true))
          ? target.snapshot.deviceId
          : null;
      case "pending-work":
        return await this.releasePendingSessionWork(
          sessionId,
          releaseReason,
          allowExpired,
          target.pendingSession,
        );
      case "persisted-only":
        return await this.releasePersistedRestartRecovery(sessionId, releaseReason);
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  }

  /** Replace a removed session's restart permission only while its window is open. */
  async releasePersistedRestartRecovery(
    sessionId: string,
    releaseReason: string,
  ): Promise<string | null> {
    if (isTerminalReleaseReason(releaseReason) || releaseReason === "superseded") {
      const persisted = await this.host.readPersistedSession(sessionId);
      const deadline = persisted && restartRecoveryDeadlineFromPersisted(persisted);
      if (
        persisted &&
        this.host.isReissuablePersistedSession(persisted) &&
        deadline !== undefined &&
        this.host.sessionNow() < deadline
      ) {
        const snapshot = this.host.terminalReleaseFromPersisted(sessionId, {
          ...persisted,
          // Use the existing terminal recovery namespace without making
          // ordinary superseded releases terminal outside restart recovery.
          release_reason:
            releaseReason === "superseded" ? "identity-recovery-superseded" : releaseReason,
          released_at_ms: this.host.sessionNow(),
        })!;
        await this.host.persistTerminalReleaseIfNeeded(snapshot);
        // The device-restart release already ran this session's device cleanup; the row's device
        // may belong to another session by now, so announce only the terminal reason (#11206).
        this.host.notifySessionRelease(snapshot, { upgradeOnly: true });
        return snapshot.deviceId;
      }
    }
    if (releaseReason === "explicit-release") {
      const released = await this.releaseUnrecoveredReissuableRow(sessionId);
      if (released !== undefined) {
        return released;
      }
    }
    logger.warn(`Cannot release session ${sessionId}: not found`);
    return null;
  }

  /**
   * An explicit release of a session this daemon does not hold, whose row a call naming the UUID
   * could still issue again (#11461): a restart handoff the startup deadline left to the follow-up
   * sweep, one whose recovery failed without terminalizing it, or a `plan-auto-release`. An
   * explicit release is terminal and never rehydrated, so the row is terminalized rather than
   * answered "already released" and brought back. One statement, conditioned on the incarnation
   * read: a recovery's claim (this daemon's or a peer's) advances the generation, so a row someone
   * took in between is left alone, as is a row another live daemon owns. An active row is never
   * touched: it is not in this daemon's map, so it is not this daemon's session.
   *
   * Resolves the row's device once terminalized, or undefined when there was nothing to release.
   */
  private async releaseUnrecoveredReissuableRow(sessionId: string): Promise<string | undefined> {
    // A recovery's claim can land between the read and the conditional write. The release is
    // not dropped for that: the row is released at its new generation, or, once the recovery
    // has started publishing the session, through the path that releases a session being created.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.host.sessions.has(sessionId)) {
        break;
      }
      if (this.host.isSessionBeingRecreated(sessionId)) {
        return (await this.host.releaseSession(sessionId, "explicit-release")) ?? undefined;
      }
      const released = await this.tryReleaseUnrecoveredReissuableRow(sessionId);
      if (released !== "row-changed") {
        return released;
      }
    }
    // Published by the recovery that won: the caller releases the live session (the daemon
    // request handler does, cutting its calls like any explicit release).
    return undefined;
  }

  /** One conditional release of the row as read; `row-changed` when another writer got there first. */
  private async tryReleaseUnrecoveredReissuableRow(
    sessionId: string,
  ): Promise<string | undefined | "row-changed"> {
    const persisted = await this.host.readPersistedSession(sessionId);
    if (!persisted?.release_reason || !this.host.isReissuablePersistedSession(persisted)) {
      return undefined;
    }
    if (this.isRowOwnedByLivePeer(persisted)) {
      logger.info(
        `[SessionManager] Not releasing session ${sessionId}: another AutoMobile daemon ` +
          `(${persisted.daemon_session_id}) owns its row`,
      );
      return undefined;
    }
    await this.host.deviceSessionRepository.markReleased(
      sessionId,
      releasedRowStatus("explicit-release"),
      this.host.sessionNow(),
      "explicit-release",
      persisted.stable_identity_generation === undefined
        ? {}
        : { expectedRowGeneration: persisted.stable_identity_generation },
    );
    return (await this.fenceExplicitlyReleasedRow(sessionId)) ?? "row-changed";
  }

  /** Whether another live daemon owns `row`: such a row is that daemon's to recover or end. */
  isRowOwnedByLivePeer(row: DeviceSession): boolean {
    const owner = row.daemon_session_id ?? null;
    return (
      owner !== null && owner !== this.host.daemonSessionId && this.host.isLiveDaemonSession(owner)
    );
  }

  /**
   * Fence a UUID whose row now reads `explicit-release`, and announce it. Resolves the row's
   * device, or undefined when the conditional release did not apply (the row changed first).
   */
  private async fenceExplicitlyReleasedRow(sessionId: string): Promise<string | undefined> {
    const current = await this.host.readPersistedSession(sessionId);
    const snapshot = current && this.host.terminalReleaseFromPersisted(sessionId, current);
    if (snapshot?.releaseReason !== "explicit-release") {
      logger.info(
        `[SessionManager] Session ${sessionId} was not released: its row changed first ` +
          `(now ${current?.status ?? "missing"}, ${current?.release_reason ?? "no release reason"})`,
      );
      return undefined;
    }
    this.host.sessionSlots.setTerminalSnapshot(sessionId, snapshot);
    this.host.restartRecoveryActivityAt.delete(sessionId);
    // The handoff release already ran this session's device cleanup, and the row's device may
    // belong to another session by now: announce only the terminal reason (#11206).
    this.host.notifySessionRelease(snapshot, { upgradeOnly: true });
    logger.info(`[SessionManager] Released unrecovered session ${sessionId} (explicit-release)`);
    return snapshot.deviceId;
  }

  private async releasePendingSessionWork(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
    pendingSession: Promise<Session>,
  ): Promise<string | null> {
    const existingRelease = this.host.sessionSlots.getReleaseRequest(sessionId);
    if (existingRelease) {
      this.host.upgradeReleaseReason(existingRelease.reason, releaseReason);
      return await existingRelease.promise;
    }

    const reason: ReleaseReasonState = { value: releaseReason };
    const release: PendingSessionRelease = {
      promise: this.releaseAfterPendingSessionWork(sessionId, reason, allowExpired, pendingSession),
      reason,
    };
    this.host.sessionSlots.setReleaseRequest(sessionId, release);
    try {
      return await release.promise;
    } finally {
      if (this.host.sessionSlots.getReleaseRequest(sessionId) === release) {
        this.host.sessionSlots.deleteReleaseRequest(sessionId);
      }
    }
  }

  private async releaseAfterPendingSessionWork(
    sessionId: string,
    reason: ReleaseReasonState,
    allowExpired: boolean,
    pendingSession: Promise<Session>,
  ): Promise<string | null> {
    try {
      // Bounded like the creation itself (#10963): a creation that outlives this is abandoned and
      // never publishes, so there is nothing left to release.
      await raceWithDeadline(pendingSession, {
        timer: this.host.timer,
        timeoutMs: SESSION_CREATE_WAIT_TIMEOUT_MS,
        unref: true,
        label: "Release of a session still being created",
      });
      return await this.releaseSessionForReason(sessionId, reason.value, { allowExpired });
    } catch (error) {
      logger.warn(`Session ${sessionId} assignment failed before release: ${error}`);
      return null;
    }
  }
}
