import { persistedSessionExpiryReason } from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { type Platform } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import { TerminalSessionError } from "../sessionErrors";
import {
  type Session,
  type SessionAccess,
  type SessionDeviceAssigner,
  type SessionExecutionMetadata,
  type SessionReleaseSnapshot,
} from "../sessionManager";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import {
  type GetOrCreateSessionOptions,
  type RecoveryAssignmentWait,
  type ResolvedSessionAcquisition,
  type SessionAcquisitionOptions,
  type SessionLifecycleSlots,
  type PersistedSessionRecovery,
  type SharedSessionAssignment,
  isDeviceRestartReleasedRow,
} from "./internalContracts";
import { UnissuedSessionError } from "./UnissuedSessionError";

export interface SessionAcquisitionHost {
  reclaimAndRefreshExistingSession(existing: Session): Promise<void>;
  readonly sessions: Pick<Map<string, Session>, "has">;
  readonly restartRecoveryActivityAt: Pick<Map<string, number>, "has">;
  recordRestartRecoveryActivity(sessionId: string): void;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    | "getAssignment"
    | "getShared"
    | "getCreation"
    | "deleteAssignment"
    | "deleteShared"
    | "setAssignment"
    | "setShared"
    | "setTerminalSnapshot"
  >;
  getOrCreateSession(
    sessionId: string,
    devicePool?: SessionDeviceAssigner,
    platform?: Platform,
    options?: GetOrCreateSessionOptions,
  ): Promise<Session>;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  readonly timer: Timer;
  wallToSessionClock(wallMs: number): number;
  sessionNow(): number;
  observeSessionForRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): Session | null;
  readPersistedSession(sessionId: string): Promise<DeviceSession | undefined>;
  terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
  isReissuablePersistedSession(persisted: DeviceSession | undefined): boolean;
  unadmittedSessionError(
    sessionId: string,
    persisted: DeviceSession | undefined,
    neverIssued: UnissuedSessionError,
    access?: SessionAccess,
  ): Error;
  isRowOwnedByLivePeer(row: DeviceSession): boolean;
  terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
    onlyIfOwnedByDaemon?: string,
  ): Promise<DeviceSession | undefined>;
  refusePlanLabelSessionOutsideItsRun(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): void;
  recoverPersistedSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    recovery: PersistedSessionRecovery & { listed?: DeviceSession },
  ): Promise<Session>;
}

export class SessionAcquisition {
  constructor(private readonly host: SessionAcquisitionHost) {}

  /**
   * A control call that waited on a device restart and failed is still the client using the
   * session, so the recovery's idle window restarts where the call's admission failed (#11281).
   * It is credited here rather than at the call's end: a call that fails admission ends
   * unadmitted, exactly like a read, and a read must never extend the window.
   */
  private creditControlCallFailedOnRestartRecovery(sessionId: string, access: SessionAccess): void {
    if (
      access === "acquire" &&
      !this.host.sessions.has(sessionId) &&
      this.host.restartRecoveryActivityAt.has(sessionId)
    ) {
      this.host.recordRestartRecoveryActivity(sessionId);
    }
  }

  /** Preserve the existing access-string API while admitting request-local options. */
  resolveSessionAcquisitionOptions(
    options: SessionAccess | SessionAcquisitionOptions,
  ): ResolvedSessionAcquisition {
    return typeof options === "string"
      ? { access: options }
      : { ...options, access: options.access ?? "acquire" };
  }

  /**
   * Join an in-flight assignment/creation for this id, or start a new one via
   * {@link createUnseenSession}. Split out of getOrCreateSession to keep that
   * method's branch count under the complexity ceiling.
   */
  async startOrJoinUnseenAssignment(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    acquisition: ResolvedSessionAcquisition & { requireIssuedSession: boolean },
  ): Promise<Session> {
    try {
      return await this.joinOrStartUnseenAssignment(sessionId, devicePool, platform, acquisition);
    } catch (error) {
      this.creditControlCallFailedOnRestartRecovery(sessionId, acquisition.access);
      throw error;
    }
  }

  private async joinOrStartUnseenAssignment(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    {
      requireIssuedSession,
      access,
      requestDeadlineMs,
      signal,
    }: ResolvedSessionAcquisition & { requireIssuedSession: boolean },
  ): Promise<Session> {
    const pendingAssignment = this.host.sessionSlots.getAssignment(sessionId);
    if (pendingAssignment) {
      // Only a control call joining the recovery is use; a read joins without extending (#11281).
      if (access === "acquire" && this.host.restartRecoveryActivityAt.has(sessionId)) {
        this.host.recordRestartRecoveryActivity(sessionId);
      }
      const shared = this.host.sessionSlots.getShared(sessionId);
      if (shared?.controller.signal.aborted) {
        await this.waitForAbortedAssignment(pendingAssignment, shared, requestDeadlineMs, signal);
        return await this.host.getOrCreateSession(sessionId, devicePool, platform, {
          requireIssuedSession,
          access,
          requestDeadlineMs,
          signal,
        });
      }
      const joined = await this.waitForSharedAssignment(
        sessionId,
        pendingAssignment,
        requestDeadlineMs,
        signal,
      );
      // An acquiring client that joined a startup rehydration is the owner returning.
      if (access === "acquire" && joined.ownership === "awaiting-owner") {
        joined.ownership = "owned";
        joined.awaitingOwnerSince = undefined;
      }
      return joined;
    }

    const pendingCreation = this.host.sessionSlots.getCreation(sessionId);
    if (pendingCreation) {
      return await pendingCreation.promise;
    }

    const shared = this.newSharedAssignment(sessionId);
    const assignment = this.createUnseenSession(sessionId, devicePool, platform, {
      requireIssuedSession,
      shared,
    }).finally(() => {
      shared.recoveryWait.resolve(undefined);
      if (this.host.sessionSlots.getAssignment(sessionId) === assignment) {
        this.host.sessionSlots.deleteAssignment(sessionId);
        this.host.sessionSlots.deleteShared(sessionId);
        this.host.slotShadowProbe.check(sessionId, "assignment-end");
      }
    });
    this.host.sessionSlots.setAssignment(sessionId, assignment);
    this.host.slotShadowProbe.check(sessionId, "assignment-start");
    return await this.waitForSharedAssignment(sessionId, assignment, requestDeadlineMs, signal);
  }

  newSharedAssignment(sessionId: string): SharedSessionAssignment {
    const shared: SharedSessionAssignment = {
      controller: new AbortController(),
      waiters: 0,
      recoveryWait: Promise.withResolvers<RecoveryAssignmentWait | undefined>(),
    };
    this.host.sessionSlots.setShared(sessionId, shared);
    return shared;
  }

  /** Drain the old attempt before its successor can publish or clean up shared state. */
  async waitForAbortedAssignment(
    assignment: Promise<Session>,
    shared: SharedSessionAssignment,
    requestDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const settled = assignment.then(
      () => {},
      (error: unknown) => {
        // No callers remain on this cancelled attempt; its rejection is internal.
        logger.debug("[SessionManager] Aborted session assignment settled", error);
      },
    );
    // A restart waiter learns this configuration before it can abort the assignment.
    const wait = await shared.recoveryWait.promise;
    await raceWithDeadline(settled, {
      timer: this.host.timer,
      timeoutMs:
        requestDeadlineMs !== undefined && Number.isFinite(requestDeadlineMs)
          ? Math.max(
              0,
              // The request deadline is wall time (#11359); judge it on the session clock.
              this.host.wallToSessionClock(requestDeadlineMs) -
                (wait?.responseMarginMs ?? 0) -
                this.host.sessionNow(),
            )
          : undefined,
      signal,
      label: "Session restart recovery",
      timeoutError: wait?.timeoutError,
    });
  }

  async waitForSharedAssignment(
    sessionId: string,
    assignment: Promise<Session>,
    requestDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<Session> {
    const shared = this.host.sessionSlots.getShared(sessionId);
    if (!shared) {
      return await assignment;
    }
    shared.waiters++;
    let waiting = true;
    const leave = () => {
      if (!waiting) {
        return;
      }
      waiting = false;
      shared.waiters--;
      if (shared.waiters === 0) {
        shared.controller.abort(new ActionableError("Session recovery has no remaining callers"));
      }
    };
    try {
      // Keep ordinary unbounded acquisition on its original scheduling path.
      if ((requestDeadlineMs === undefined || !Number.isFinite(requestDeadlineMs)) && !signal) {
        return await assignment;
      }
      const wait = await raceWithDeadline(
        [shared.recoveryWait.promise, assignment.then(() => undefined)],
        { timer: this.host.timer, label: "Session recovery wait configuration" },
      );
      if (!wait) {
        return await assignment;
      }
      const deadline =
        requestDeadlineMs !== undefined && Number.isFinite(requestDeadlineMs)
          ? // The request deadline is wall time (#11359); `restartDeadlineMs` is on the session clock.
            this.host.wallToSessionClock(requestDeadlineMs) - wait.responseMarginMs
          : undefined;
      return await raceWithDeadline(assignment, {
        timer: this.host.timer,
        timeoutMs:
          deadline !== undefined && deadline < (wait.restartDeadlineMs ?? Infinity)
            ? Math.max(0, deadline - this.host.sessionNow())
            : undefined,
        signal,
        label: "Session restart recovery",
        timeoutError: wait.timeoutError,
        // Fence claims in the timeout's own turn, before promise rejection cleanup.
        onTimeout: leave,
      });
    } finally {
      leave();
    }
  }

  /** Admit an identity already issued by this daemon, including a nonterminal persisted one. */
  async admitIssuedSessionForAutomation(
    sessionId: string,
    execution?: SessionExecutionMetadata,
    options: { access?: SessionAccess; signal?: AbortSignal } = {},
  ): Promise<Session | undefined> {
    let unissuedSessionError: UnissuedSessionError | undefined;
    try {
      if (options.access === "read-only") {
        // Inventory reads still validate the forwarded identity, but observing a
        // startup-rehydrated session is not proof that its owner returned. In
        // particular, do not enter reclaimAndRefreshExistingSession(), whose
        // acquisition semantics promote awaiting-owner to owned.
        const observed = this.host.observeSessionForRead(sessionId, execution);
        if (observed) {
          // Answered in every lease phase (#11322): a read is never refused, and never restores
          // or extends the lease it is watching.
          return observed;
        }
        if (this.host.sessions.has(sessionId)) {
          return undefined;
        }
      }
      return await this.host.getOrCreateSession(sessionId, undefined, undefined, {
        ...options,
        execution,
      });
    } catch (error) {
      if (!(error instanceof UnissuedSessionError)) {
        throw error;
      }
      unissuedSessionError = error;
    }

    const persisted = await this.host.readPersistedSession(sessionId);
    const persistedTerminalRelease =
      persisted && this.host.terminalReleaseFromPersisted(sessionId, persisted);
    if (persistedTerminalRelease) {
      this.host.sessionSlots.setTerminalSnapshot(sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(sessionId, persistedTerminalRelease);
    }
    if (persisted && this.host.isReissuablePersistedSession(persisted)) {
      return undefined;
    }
    throw this.host.unadmittedSessionError(
      sessionId,
      persisted,
      unissuedSessionError,
      options.access,
    );
  }

  isLapsedUnownedRestartRecovery(persisted: DeviceSession | undefined): boolean {
    return Boolean(
      persisted &&
      persistedSessionExpiryReason(persisted, this.host.sessionNow()) ===
        "restart-recovery-timeout" &&
      !this.host.isRowOwnedByLivePeer(persisted),
    );
  }

  /** Recheck admission after a conditional expiry write, which may lose to renewed activity. */
  async admitPersistedSession(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): Promise<DeviceSession | undefined> {
    persisted = await this.host.terminalizeExpiredPersistedSession(persisted);
    const terminalRelease =
      persisted && this.host.terminalReleaseFromPersisted(sessionId, persisted);
    if (terminalRelease) {
      this.host.sessionSlots.setTerminalSnapshot(sessionId, terminalRelease);
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (!this.host.isReissuablePersistedSession(persisted)) {
      throw this.host.unadmittedSessionError(
        sessionId,
        persisted,
        new UnissuedSessionError(
          `Session ${sessionId} is not an active daemon session (not found). ` +
            "Acquire a device with getAndroid or getApple before using its sessionUuid.",
        ),
      );
    }
    return persisted;
  }

  private async createUnseenSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
    {
      requireIssuedSession,
      shared,
    }: { requireIssuedSession: boolean; shared: SharedSessionAssignment },
  ): Promise<Session> {
    let persisted = await this.host.readPersistedSession(sessionId);
    this.host.refusePlanLabelSessionOutsideItsRun(sessionId, persisted);
    const persistedTerminalRelease = persisted
      ? this.host.terminalReleaseFromPersisted(sessionId, persisted)
      : undefined;
    if (persistedTerminalRelease) {
      this.host.sessionSlots.setTerminalSnapshot(sessionId, persistedTerminalRelease);
      throw new TerminalSessionError(sessionId, persistedTerminalRelease);
    }

    // #6069: On the device-tool path (requireIssuedSession), admission is decided
    // from the session registry — NOT from whether a device pool happens to be in
    // scope. A live in-memory session is already resolved by getOrCreateSession
    // before reaching here, so the only admissible new-session case is
    // live-during-restart recovery: a persisted, non-terminal row. Without this,
    // the `admittedSession ?? getOrCreateSession(uuid, realPool)` fallback in
    // ToolExecutionContext auto-assigned a pooled device to a fabricated,
    // never-issued sessionUuid (e.g. "kumquat-D") whenever the #6045 admit guard
    // was bypassed by the call path — the ownership bypass this closes. The
    // pool-less `if (!devicePool)` throw below stays as a secondary safety net.
    // Every recovery must enter while its fixed window is open, including plan-label callers
    // that may mint never-issued IDs. Idle-first rows retain that path's ordinary re-issue rules.
    const restartWindowLapsed = devicePool && this.isLapsedUnownedRestartRecovery(persisted);
    if (
      (requireIssuedSession || restartWindowLapsed) &&
      !this.host.isReissuablePersistedSession(persisted)
    ) {
      // Answered from the row as the expiry write left it (#11498): a row whose deadline was
      // extended under this call is still live or recoverable, and is admitted like any other.
      persisted = await this.admitPersistedSession(sessionId, persisted);
    }
    // Need to create new session - assign device from pool
    if (!devicePool) {
      throw new UnissuedSessionError(
        `Session ${sessionId} is not an active daemon session (not found). ` +
          "Acquire a device with getAndroid or getApple before using its sessionUuid.",
      );
    }

    if (persisted && isDeviceRestartReleasedRow(persisted)) {
      this.host.recordRestartRecoveryActivity(sessionId);
    }
    return await this.host.recoverPersistedSession(sessionId, devicePool, platform, {
      listed: persisted,
      initialOwnership: "owned",
      shared,
    });
  }
}
