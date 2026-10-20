import {
  DeviceSessionRowChangedError,
  type MarkReleasedOptions,
  type RecoverableRowIncarnation,
  type UpsertActiveSessionOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import {
  DeviceOwnedByOtherDaemonError,
  SessionCreationTimeoutError,
} from "../../models/deviceAcquisitionRefusals";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import type { ObserverSessionStore } from "../observerSessionRegistry";
import { PlanLabelRegistry } from "../planLabelRegistry";
import { TerminalSessionError } from "../sessionErrors";
import {
  PLAN_LABEL_SESSION_SOURCE,
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  SESSION_CREATION_TIMEOUT_REASON,
  type Session,
  type SessionReleaseSnapshot,
} from "../sessionManager";
import { type SessionRowWriter } from "../sessionRowWriter";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import { type StallForgivingLeases } from "../stallForgiveness";
import {
  type ClaimedCreationRow,
  type PendingSessionCreation,
  type SessionLifecycleSlots,
} from "./internalContracts";

export interface SessionCreationHost {
  readonly timer: Timer;
  persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void>;
  readPersistedSession(sessionId: string): Promise<DeviceSession | undefined>;
  unlessBeingReplaced(
    release: SessionReleaseSnapshot | undefined,
  ): SessionReleaseSnapshot | undefined;
  terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "setTerminalSnapshot" | "getTerminalSnapshot" | "hasTerminalSnapshot"
  >;
  readonly daemonSessionId: string | undefined;
  readonly planLabels: Pick<PlanLabelRegistry, "isMinting" | "markRunning">;
  getPersistedTerminalRelease(sessionId: string): Promise<SessionReleaseSnapshot | undefined>;
  rejectCreationAfterShutdownFence(
    session: Session,
    rowWritten: boolean,
    claimedRow?: ClaimedCreationRow,
    cancellation?: AbortSignal,
  ): Promise<void>;
  assertTerminalReleaseAdmission(sessionId: string, allowedSession?: Session): void;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
  invalidateFinalizedSessionIdentity(sessionId: string): void;
  readonly rowWriter: Pick<SessionRowWriter, "deletePendingNonTerminalRelease" | "noteLive">;
  readonly observerSessions:
    | (Pick<ObserverSessionStore, "release"> &
        Partial<Pick<ObserverSessionStore, "list">> &
        Partial<StallForgivingLeases>)
    | undefined;
  readonly sessions: Pick<Map<string, Session>, "set" | "get">;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  readonly deviceSessionMap: Pick<Map<string, string>, "set">;
  cancelSessionlessUseOnAcquisition(deviceId: string, sessionId: string): void;
  notifyDeviceOwnershipChange(
    deviceId: string,
    frameInvalidation?: "generation-only" | "full",
  ): void;
  notifySessionCreated(session: Session): void;
  readonly persistedRowGenerations: Pick<WeakMap<Session, number>, "get">;
  creationRowRollbackSnapshot(
    session: Session,
    releaseReason: string,
    releasedAtMs?: number,
  ): SessionReleaseSnapshot;
  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void;
  trackReleaseDrainWrite(write: Promise<void>): void;
  retryNonTerminalRowAfterRelease(snapshot: SessionReleaseSnapshot): Promise<void>;
  retireAbandonedCreation(session: Session): Promise<never>;
}

export class SessionCreation {
  constructor(private readonly host: SessionCreationHost) {}

  readonly retiredCreationRows = new WeakSet<Session>();

  /**
   * Race one of a creation's waits against {@link SESSION_CREATE_WAIT_TIMEOUT_MS} (#10963). On
   * timeout the caller gets a typed retryable error and `onTimeout` runs; the wait itself is not
   * cancelled.
   */
  async withinCreateDeadline<T>(
    sessionId: string,
    deviceId: string,
    wait: Promise<T>,
    onTimeout?: () => void,
  ): Promise<T> {
    return await raceWithDeadline(wait, {
      timer: this.host.timer,
      timeoutMs: SESSION_CREATE_WAIT_TIMEOUT_MS,
      unref: true,
      label: "Session creation",
      timeoutError: () =>
        new SessionCreationTimeoutError(sessionId, deviceId, SESSION_CREATE_WAIT_TIMEOUT_MS),
      onTimeout: () => {
        logger.warn(
          `[SessionManager] Creating session ${sessionId} did not finish within ` +
            `${SESSION_CREATE_WAIT_TIMEOUT_MS}ms (reason=${SESSION_CREATION_TIMEOUT_REASON}); ` +
            "refusing it so the device and the assignment mutex are freed",
        );
        onTimeout?.();
      },
    });
  }

  /**
   * Persist a new session; a recovery of a claimed row writes only while the row is still its claim
   * (#11243). The terminal-row check before this write cannot fence a peer's terminal release that
   * lands between them; the conditioned upsert does, and that release ends this recovery as terminal.
   */
  private async persistCreatedSession(
    session: Session,
    claimedRow: RecoverableRowIncarnation | undefined,
  ): Promise<void> {
    try {
      await this.host.persistSession(session, session, claimedRow && { claimedRow });
    } catch (error) {
      if (!(error instanceof DeviceSessionRowChangedError)) {
        throw error;
      }
      const current = await this.host.readPersistedSession(session.sessionId);
      const terminalRelease = this.host.unlessBeingReplaced(
        current && this.host.terminalReleaseFromPersisted(session.sessionId, current),
      );
      if (terminalRelease) {
        this.host.sessionSlots.setTerminalSnapshot(session.sessionId, terminalRelease);
        throw new TerminalSessionError(session.sessionId, terminalRelease);
      }
      const owner = current?.daemon_session_id ?? null;
      if (owner !== null && owner !== this.host.daemonSessionId) {
        logger.info(
          `[SessionManager] Not recovering session ${session.sessionId}: another AutoMobile ` +
            `daemon (${owner}) took its row during the recovery`,
        );
        throw new DeviceOwnedByOtherDaemonError(session.assignedDevice, undefined);
      }
      throw error;
    }
  }

  async persistAndPublishSession(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session> {
    try {
      return await this.publishSessionCreation(session, creation, claimedRow, signal);
    } catch (error) {
      await this.rollBackFailedCreationRow(session, claimedRow);
      throw error;
    }
  }

  private async publishSessionCreation(
    session: Session,
    creation?: PendingSessionCreation,
    claimedRow?: ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session> {
    // A plan run minting its label writes over the row its previous run left, terminal or not.
    const persistedTerminalRelease = this.host.planLabels.isMinting(session.sessionId)
      ? undefined
      : this.host.unlessBeingReplaced(
          await this.host.getPersistedTerminalRelease(session.sessionId),
        );
    if (persistedTerminalRelease) {
      this.host.sessionSlots.setTerminalSnapshot(session.sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(session.sessionId, persistedTerminalRelease);
    }
    this.assertCreationNotAbandoned(session, creation);
    await this.host.rejectCreationAfterShutdownFence(session, false, claimedRow, signal);
    await this.persistCreatedSession(session, claimedRow);
    await this.retireCreationIfAbandoned(session, creation);
    await this.host.rejectCreationAfterShutdownFence(session, true, claimedRow, signal);
    this.host.assertTerminalReleaseAdmission(session.sessionId, session);
    const terminalRelease = this.host.sessionSlots.getTerminalSnapshot(session.sessionId);
    if (terminalRelease) {
      await this.host.persistSessionRelease(terminalRelease);
      throw new TerminalSessionError(session.sessionId, terminalRelease);
    }
    this.host.invalidateFinalizedSessionIdentity(session.sessionId);
    this.host.rowWriter.deletePendingNonTerminalRelease(session.sessionId);
    // A client that registered as an observer before acquiring a device keeps its name (#10671).
    const observerClientName = this.host.observerSessions
      ?.list?.()
      .find((observer) => observer.sessionId === session.sessionId)?.clientName;
    if (observerClientName !== undefined && session.clientName === undefined) {
      session.clientName = observerClientName;
    }
    this.host.observerSessions?.release(session.sessionId, "promotion");
    if (session.persistenceMetadata?.source === PLAN_LABEL_SESSION_SOURCE) {
      this.host.planLabels.markRunning(session.sessionId);
    }
    this.host.sessions.set(session.sessionId, session);
    this.host.rowWriter.noteLive(session.sessionId);
    this.host.slotShadowProbe.check(session.sessionId, "published");
    this.host.deviceSessionMap.set(session.assignedDevice, session.sessionId);
    this.host.cancelSessionlessUseOnAcquisition(session.assignedDevice, session.sessionId);
    // Generation only: publishing an owner changes entitlement, not the screen/connection.
    this.host.notifyDeviceOwnershipChange(session.assignedDevice);
    this.host.notifySessionCreated(session);
    logger.info(`Created session ${session.sessionId} with device ${session.assignedDevice}`);
    return session;
  }

  /** An unpublished creation owns only the generation its upsert wrote, never a successor's row. */
  private async rollBackFailedCreationRow(
    session: Session,
    claimedRow?: ClaimedCreationRow,
  ): Promise<void> {
    const generation = this.host.persistedRowGenerations.get(session);
    if (
      generation === undefined ||
      this.host.sessions.get(session.sessionId) === session ||
      this.retiredCreationRows.has(session) ||
      this.host.sessionSlots.hasTerminalSnapshot(session.sessionId)
    ) {
      return;
    }
    this.retiredCreationRows.add(session);
    const snapshot = this.host.creationRowRollbackSnapshot(
      session,
      claimedRow?.releaseReason ?? "allocation-rollback",
      claimedRow?.releasedAtMs,
    );
    this.host.captureReleaseRowGeneration(snapshot, generation);
    await this.persistCreationRollback(snapshot);
  }

  async persistCreationRollback(snapshot: SessionReleaseSnapshot): Promise<void> {
    try {
      await this.host.persistSessionRelease(snapshot);
    } catch (error) {
      // Persistence already logged the storage failure; rollback remains owed without replacing the caller's error.
      logger.debug(`[SessionManager] Creation rollback remains owed: ${errorMessage(error)}`);
      this.host.trackReleaseDrainWrite(this.host.retryNonTerminalRowAfterRelease(snapshot));
    }
  }

  /**
   * A creation abandoned at its deadline whose write landed afterwards (#10963): its caller was
   * refused and its pool claim rolled back, so it must not publish, and its active row must not
   * let a restart rehydrate it. Unless a retry is re-creating the UUID, record a non-terminal
   * release (the caller may retry with the same UUID), then refuse.
   */
  /** An abandoned creation refused before anything was written has nothing to retire. */
  private assertCreationNotAbandoned(session: Session, creation?: PendingSessionCreation): void {
    if (creation?.abandoned) {
      throw new SessionCreationTimeoutError(
        session.sessionId,
        session.assignedDevice,
        SESSION_CREATE_WAIT_TIMEOUT_MS,
      );
    }
  }

  private async retireCreationIfAbandoned(
    session: Session,
    creation?: PendingSessionCreation,
  ): Promise<void> {
    if (creation?.abandoned) {
      await this.host.retireAbandonedCreation(session);
    }
  }
}
