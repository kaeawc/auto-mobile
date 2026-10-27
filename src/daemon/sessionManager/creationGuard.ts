import { type MarkReleasedOptions } from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { type Platform } from "../../models";
import { SessionCreationTimeoutError } from "../../models/deviceAcquisitionRefusals";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { requestAcquisitionReceipt } from "../acquisitionReceipt";
import {} from "../deviceStateRestoreQueue";
import {
  isRecoverableDaemonReleaseReason,
  isReissuableByNameReleaseReason,
} from "../releaseReasons";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import { DaemonSessionCreationRejectedError, TerminalSessionError } from "../sessionErrors";
import {
  CreateSessionOptions,
  Session,
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  SESSION_CREATION_TIMEOUT_REASON,
  SessionReleaseOptions,
  SessionReleaseSnapshot,
} from "../sessionManager";
import {
  type ClaimedCreationRow,
  type PendingSessionCreation,
} from "../sessionManager/internalContracts";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import { type TerminalReleaseJournal } from "../terminalReleaseJournal";
import {
  sessionCreationLiveness,
  withCreateSessionDefaults,
  type SessionLifecycleSlots,
} from "./internalContracts";

export interface SessionCreationGuardHost {
  readonly acceptingSessionCreations: boolean;
  assertTerminalReleaseAdmission(sessionId: string, allowedSession?: Session): void;
  readonly sessions: Map<string, Session>;
  liftPlanLabelFenceForMint(sessionId: string): void;
  readonly sessionSlots: SessionLifecycleSlots;
  refuseLabelMintOutsidePlanAllocation(sessionId: string, deviceId: string): void;
  withinCreateDeadline<T>(
    sessionId: string,
    deviceId: string,
    wait: Promise<T>,
    onTimeout?: () => void,
  ): Promise<T>;
  readonly stateRestore: SessionDeviceStateRestore;
  sessionNow(): number;
  creatorSourceForCreation(
    sessionId: string,
    persistenceSource: string | undefined,
  ): string | undefined;
  readonly SESSION_TIMEOUT_MS: number;
  recoverySessionFields(
    persisted: DeviceSession | undefined,
  ): Pick<
    Session,
    "persistenceMetadata" | "livenessOwnerToken" | "livenessOwnershipClaims" | "lastOwnerHeartbeat"
  >;
  notifyManagedExecutionRecovery(
    session: Session,
    persistedRecovery: DeviceSession | undefined,
  ): (creation: Promise<Session>) => void;
  persistAndPublishSession(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session>;
  claimedIncarnation(row: DeviceSession | undefined): ClaimedCreationRow | undefined;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  readonly retiredCreationRows: WeakSet<Session>;
  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void;
  readonly persistedRowGenerations: WeakMap<Session, number>;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
  rollBackCancelledClientChosenCreation(
    session: Session,
    rowWritten: boolean,
    cancellation: AbortSignal,
  ): Promise<void>;
  persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void>;
  persistRejectedCreationRow(
    session: Session,
    fence: SessionReleaseSnapshot,
    rowWritten: boolean,
    claimedRow?: ClaimedCreationRow,
  ): Promise<void>;
  notifySessionRelease(snapshot: SessionReleaseSnapshot, options?: SessionReleaseOptions): void;
  readonly restartRecoveryActivityAt: Map<string, number>;
  readonly terminalReleaseJournal: TerminalReleaseJournal;
  sessionClockToWall(sessionClockMs: number): number;
  liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence?: boolean,
    afterDelete?: () => void,
  ): void;
  creationRowRollbackSnapshot(
    session: Session,
    releaseReason: string,
    releasedAtMs?: number,
  ): SessionReleaseSnapshot;
  persistCreationRollback(snapshot: SessionReleaseSnapshot): Promise<void>;
}

export class SessionCreationGuard {
  constructor(private readonly host: SessionCreationGuardHost) {}

  /**
   * Create a new session with an assigned device
   *
   * This is called by the daemon when a session UUID is first used.
   * The DevicePool will assign an available device to this session.
   */

  async createSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: CreateSessionOptions = {},
  ): Promise<Session> {
    const {
      timeoutMs,
      heartbeatTimeoutMs,
      stableDeviceId,
      recoveredLiveness,
      initialOwnership,
      persistenceSource,
      signal,
    } = withCreateSessionDefaults(options);
    signal?.throwIfAborted();
    if (!this.host.acceptingSessionCreations) {
      throw new DaemonSessionCreationRejectedError(sessionId);
    }
    this.host.assertTerminalReleaseAdmission(sessionId, this.host.sessions.get(sessionId));
    this.host.liftPlanLabelFenceForMint(sessionId);
    let terminalRelease = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (terminalRelease) {
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (this.host.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists, returning existing session`);
      return this.host.sessions.get(sessionId)!;
    }
    this.host.refuseLabelMintOutsidePlanAllocation(sessionId, assignedDevice);
    const activeReleases = Array.from(this.host.sessionSlots.activeReleases)
      .filter((release) => release.session.sessionId === sessionId)
      .map((release) => release.promise);
    if (activeReleases.length > 0) {
      await this.host.withinCreateDeadline(sessionId, assignedDevice, Promise.all(activeReleases));
      this.host.assertTerminalReleaseAdmission(sessionId, this.host.sessions.get(sessionId));
      // The release just awaited ended the label's previous run, not this one.
      this.host.liftPlanLabelFenceForMint(sessionId);
      terminalRelease = this.host.sessionSlots.getTerminalSnapshot(sessionId);
      if (terminalRelease) {
        throw new TerminalSessionError(sessionId, terminalRelease);
      }
    }

    const pendingCreation = this.host.sessionSlots.getCreation(sessionId);
    if (pendingCreation) {
      return await this.host.withinCreateDeadline(
        sessionId,
        assignedDevice,
        pendingCreation.promise,
      );
    }

    this.host.stateRestore.forgetKeepAwakeRestoreReport(sessionId);
    const now = this.host.sessionNow();
    const persistedRecovery = this.host.sessionSlots.getRecovery(sessionId);
    const creatorSource = this.host.creatorSourceForCreation(sessionId, persistenceSource);
    const liveness = sessionCreationLiveness(
      timeoutMs,
      heartbeatTimeoutMs,
      recoveredLiveness,
      this.host.SESSION_TIMEOUT_MS,
    );
    const session: Session = {
      sessionId,
      assignedDevice,
      stableDeviceId,
      platform,
      createdAt: now,
      lastUsedAt: now,
      activityGeneration: 0,
      expiresAt: now + liveness.sessionTimeoutMs,
      cacheData: {},
      lastHeartbeat: now,
      ...liveness,
      ownership: initialOwnership,
      ...(creatorSource
        ? {
            persistenceMetadata: {
              source: creatorSource,
              autolockEnabled: false,
              mcpSessionId: null,
              daemonSessionId: null,
            },
          }
        : {}),
      ...this.host.recoverySessionFields(persistedRecovery),
      ...(initialOwnership === "awaiting-owner"
        ? { awaitingOwnerSince: now, hasReceivedHeartbeat: false }
        : {}),
    };

    const creation: PendingSessionCreation = { promise: Promise.resolve(session) };
    const settleRecovery = this.host.notifyManagedExecutionRecovery(session, persistedRecovery);
    creation.promise = this.host.persistAndPublishSession(
      session,
      creation,
      this.host.claimedIncarnation(persistedRecovery),
      signal,
    );
    settleRecovery(creation.promise);
    this.host.sessionSlots.setCreation(sessionId, creation);
    this.host.slotShadowProbe.check(sessionId, "creation-start");
    try {
      const created = await this.host.withinCreateDeadline(
        sessionId,
        assignedDevice,
        creation.promise,
        () => {
          creation.abandoned = true;
        },
      );
      // Natural point to retry a rotation or screen reader an earlier release could not restore.
      await this.host.stateRestore.retryAbandonedRotationRestore(created.assignedDevice);
      await this.host.stateRestore.retryAbandonedScreenReaderRestore(created.assignedDevice);
      return created;
    } finally {
      if (this.host.sessionSlots.getCreation(sessionId) === creation) {
        this.host.sessionSlots.deleteCreation(sessionId);
        this.host.slotShadowProbe.check(sessionId, "creation-end");
      }
    }
  }

  /** The claimed incarnation a recovery's upsert is conditioned on, when `row` is a claim. */

  claimedIncarnation(row: DeviceSession | undefined): ClaimedCreationRow | undefined {
    if (!row || !this.host.sessionSlots.isRowClaimed(row)) {
      return undefined;
    }
    return {
      rowGeneration: row.stable_identity_generation ?? 0,
      daemonSessionId: row.daemon_session_id ?? null,
      releaseReason: row.release_reason ?? undefined,
      releasedAtMs: row.released_at_ms ?? undefined,
    };
  }

  creationRowRollbackSnapshot(
    session: Session,
    releaseReason: string,
    releasedAtMs: number = this.host.sessionNow(),
  ): SessionReleaseSnapshot {
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason,
      releasedAtMs,
      terminal: false,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
  }

  async retireAbandonedCreation(session: Session): Promise<never> {
    this.host.retiredCreationRows.add(session);
    const releasedAtMs = this.host.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason: SESSION_CREATION_TIMEOUT_REASON,
      releasedAtMs,
      terminal: false,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    this.host.captureReleaseRowGeneration(snapshot, this.host.persistedRowGenerations.get(session));
    await this.host.persistSessionRelease(snapshot, true).catch((error: unknown) => {
      logger.warn(
        `[SessionManager] Failed to release abandoned creation of ${session.sessionId}: ` +
          errorMessage(error),
      );
    });
    throw new SessionCreationTimeoutError(
      session.sessionId,
      session.assignedDevice,
      SESSION_CREATE_WAIT_TIMEOUT_MS,
    );
  }

  async rejectCreationAfterShutdownFence(
    session: Session,
    rowWritten: boolean,
    claimedRow?: ClaimedCreationRow,
    cancellation?: AbortSignal,
  ): Promise<void> {
    if (this.host.acceptingSessionCreations && !cancellation?.aborted) {
      return;
    }
    // Still accepting creations past the return above: the request itself was cancelled.
    if (cancellation && this.host.acceptingSessionCreations) {
      await this.host.rollBackCancelledClientChosenCreation(session, rowWritten, cancellation);
    }
    const releasedAtMs = this.host.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason: cancellation?.aborted ? "session-creation-cancelled" : "daemon-shutdown",
      releasedAtMs,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    if (snapshot.releaseReason === "session-creation-cancelled") {
      await this.host.persistTerminalReleaseIfNeeded(snapshot);
    } else {
      await this.host.persistRejectedCreationRow(session, snapshot, rowWritten, claimedRow);
    }
    this.host.notifySessionRelease(snapshot);
    if (cancellation?.aborted) {
      cancellation.throwIfAborted();
    }
    throw new DaemonSessionCreationRejectedError(session.sessionId, snapshot);
  }

  /** Keep the shutdown fence, but only retire the row this unpublished creation wrote. */

  async persistRejectedCreationRow(
    session: Session,
    fence: SessionReleaseSnapshot,
    rowWritten: boolean,
    claimedRow?: ClaimedCreationRow,
  ): Promise<void> {
    this.host.retiredCreationRows.add(session);
    this.host.sessionSlots.setTerminalSnapshot(session.sessionId, fence);
    this.host.restartRecoveryActivityAt.delete(session.sessionId);
    if (!rowWritten) {
      this.host.terminalReleaseJournal.record({
        sessionId: fence.sessionId,
        reason: fence.releaseReason,
        at: this.host.sessionClockToWall(fence.releasedAtMs),
      });
      this.host.liftTerminalFence(fence.sessionId, fence, true);
      return;
    }
    const claimedReleaseReason = claimedRow?.releaseReason;
    const rowReason =
      claimedReleaseReason &&
      isReissuableByNameReleaseReason(claimedReleaseReason) &&
      !isRecoverableDaemonReleaseReason(claimedReleaseReason)
        ? claimedReleaseReason
        : fence.releaseReason;
    const rollback =
      rowReason === fence.releaseReason
        ? fence
        : this.host.creationRowRollbackSnapshot(session, rowReason, claimedRow?.releasedAtMs);
    this.host.captureReleaseRowGeneration(rollback, this.host.persistedRowGenerations.get(session));
    await this.host.persistCreationRollback(rollback);
  }

  /**
   * A mint cancelled under an id its client chose (#11593). The client knows the id although the
   * call never answered and names it again on its retry, so the id is not retired: nothing is
   * fenced, and the active row this mint already wrote is released as a plain allocation
   * rollback, which a later creation replaces. A release write that fails stays pending and is
   * retried; the retry creation's own upsert supersedes it. Rethrows the cancellation; returns
   * only for a session whose id this request's client did not choose.
   */

  async rollBackCancelledClientChosenCreation(
    session: Session,
    rowWritten: boolean,
    cancellation: AbortSignal,
  ): Promise<void> {
    if (requestAcquisitionReceipt()?.clientChosenSessionId !== session.sessionId) {
      return;
    }
    if (!rowWritten) {
      cancellation.throwIfAborted();
      return;
    }
    this.host.retiredCreationRows.add(session);
    const releasedAtMs = this.host.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      releaseReason: "allocation-rollback",
      releasedAtMs,
      terminal: false,
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    this.host.captureReleaseRowGeneration(snapshot, this.host.persistedRowGenerations.get(session));
    await this.host.persistSessionRelease(snapshot);
    cancellation.throwIfAborted();
  }
}
