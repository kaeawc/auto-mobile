import { holderOf } from "../deviceBinding";
import { logger } from "../../utils/logger";
import { type Session } from "../sessionManager";
import { DeviceAutolockManager } from "../deviceAutolockManager";
import type { RefusedOwnedSessionRestore } from "../devicePoolTypes";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface ConnectionSessionsOperations {
  autolockDevice(
    ...args: Parameters<DeviceAutolockManager["autolockDevice"]>
  ): Promise<string | undefined>;
  captureAutolockSessionForMcpSession(mcpSessionId: string | undefined): string | undefined;
  adoptResumedAutolockSession(
    ...args: Parameters<DeviceAutolockManager["adoptResumedAutolockSession"]>
  ): Promise<void>;
  resolveAutolockSessionForMcpSession(
    ...args: Parameters<DeviceAutolockManager["resolveAutolockSessionForMcpSession"]>
  ): string | undefined;
  /**
   * The live device session that holds `deviceId` and that the MCP connection `mcpSessionId`
   * acquired (or restored as its own), or undefined (#10994). A deviceId-only call from the
   * holder's own connection is that session's use; any other caller is not the holder.
   */
  resolveOwnedDeviceSessionForMcpSession(
    mcpSessionId: string | undefined,
    deviceId: string,
  ): string | undefined;
  // The attach paths are tracked like a bind (#11192): a connection closing while one waits for
  // the assignment lock or its persistence must not be adopted as the owner afterwards.
  restoreAutolockSessionsForMcpSession(
    ...args: Parameters<DeviceAutolockManager["restoreAutolockSessionsForMcpSession"]>
  ): Promise<void>;
  attachExplicitSessionUuidCall(
    ...args: Parameters<DeviceAutolockManager["attachExplicitSessionUuidCall"]>
  ): ReturnType<DeviceAutolockManager["attachExplicitSessionUuidCall"]>;
  attachAutolockSessionToMcpSession(
    ...args: Parameters<DeviceAutolockManager["attachAutolockSessionToMcpSession"]>
  ): ReturnType<DeviceAutolockManager["attachAutolockSessionToMcpSession"]>;
  assertAutolockAccess(...args: Parameters<DeviceAutolockManager["assertAutolockAccess"]>): void;
  restoreOwnedDeviceSessionsForMcpSession(
    sessionIds: readonly string[],
    mcpSessionId: string,
    livenessOwnerToken?: string,
  ): Promise<readonly RefusedOwnedSessionRestore[]>;
  restoreOwnedDeviceSessionsUnderBindClaim(
    sessionIds: readonly string[],
    mcpSessionId: string,
    livenessOwnerToken: string | undefined,
  ): Promise<readonly RefusedOwnedSessionRestore[]>;
  restartReservationOwnerToken(session: Session): string | undefined;
  restoreRestartReservationConnectionOwner(
    sessionId: string,
    mcpSessionId: string,
    livenessOwnerToken: string | undefined,
  ): void;
  liveOwnershipSession(session: Session): Session | undefined;
  mayRestoreMcpSessionOwnership(
    session: Session,
    mcpSessionId: string,
    livenessOwnerToken: string | undefined,
  ): boolean;
  /**
   * Tool executions under these session ids ended: retry any owner-disconnect release they
   * deferred now rather than at the veto's bound (#10712).
   */
  sessionExecutionsEnded(sessionIds: Iterable<string>): void;
  /** Drop every socket-scoped route and ownership marker for a disconnected MCP client. */
  releaseMcpSessionBindings(mcpSessionId: string): void;
  /**
   * Whether a still-connected MCP client other than `mcpSessionId` owns the live session
   * `sessionId` (#11344): it acquired or restored it, or routes to it by autolock. The general
   * rule {@link mayRestoreMcpSessionOwnership} applies, with autolock on or off. A derived
   * `${base}:${label}` session records no owner of its own, so it counts as its base (#11542):
   * every branch below judges {@link ownershipSessionId}.
   */
  isSessionOwnedByOtherConnection(sessionId: string, mcpSessionId?: string): boolean;
  /** Whether this connection acquired/restored the session or holds its autolock route. */
  isSessionOwnedByConnection(sessionId: string, mcpSessionId: string | undefined): boolean;
  hasConnectedMcpSessionOwner(namedSessionId: string, exceptMcpSessionId?: string): boolean;
  releaseExpiredSessionDevice(sessionId: string, deviceId: string): void;
  clearMcpSessionOwnership(sessionId: string): void;
}
type ConnectionSessionsState = Pick<
  DevicePoolState,
  | "autolockManager"
  | "mcpSessionAcquiredDeviceSessions"
  | "devices"
  | "sessionManager"
  | "assignmentMutex"
  | "mcpBindsInFlight"
  | "rehydrationReservations"
  | "ownerDisconnectRelease"
  | "mcpSessionOwnerCallsInFlight"
  | "mcpSessionUndeliveredMints"
  | "mcpSessionLivenessOwnerTokens"
  | "mcpSessionRecoveryDevices"
  | "ownerConnectionIntervals"
>;
export type ConnectionSessionsCallbacks = Pick<
  DevicePoolOperations,
  | "beginMcpBind"
  | "hasAcquiredDeviceSession"
  | "isSessionAssignmentCurrent"
  | "recordBindOwnership"
  | "ownershipSessionId"
  | "hasConnectedMcpSessionOwner"
  | "releaseCapturedDevice"
>;

/** Connection Sessions responsibilities of DevicePool. */
export class DevicePoolConnectionSessions {
  constructor(
    private readonly state: ConnectionSessionsState,
    private readonly callbacks: ConnectionSessionsCallbacks,
  ) {}
  autolockDevice(
    ...args: Parameters<DeviceAutolockManager["autolockDevice"]>
  ): Promise<string | undefined> {
    // Tracked like an explicit bind: a connection closing mid-acquire must not stay an owner (#11166).
    const endBind = this.callbacks.beginMcpBind(args[2]);
    // The caller's policy carries its cancel signal (#15671); no ambient request signal is read.
    return this.state.autolockManager.autolockDevice(...args).finally(endBind);
  }

  captureAutolockSessionForMcpSession(mcpSessionId: string | undefined): string | undefined {
    return this.state.autolockManager.captureAutolockSessionForMcpSession(mcpSessionId);
  }

  adoptResumedAutolockSession(
    ...args: Parameters<DeviceAutolockManager["adoptResumedAutolockSession"]>
  ): Promise<void> {
    const endBind = this.callbacks.beginMcpBind(args[2]);
    return this.state.autolockManager.adoptResumedAutolockSession(...args).finally(endBind);
  }

  resolveAutolockSessionForMcpSession(
    ...args: Parameters<DeviceAutolockManager["resolveAutolockSessionForMcpSession"]>
  ): string | undefined {
    return this.state.autolockManager.resolveAutolockSessionForMcpSession(...args);
  }

  /**
   * The live device session that holds `deviceId` and that the MCP connection `mcpSessionId`
   * acquired (or restored as its own), or undefined (#10994). A deviceId-only call from the
   * holder's own connection is that session's use; any other caller is not the holder.
   */
  resolveOwnedDeviceSessionForMcpSession(
    mcpSessionId: string | undefined,
    deviceId: string,
  ): string | undefined {
    const device =
      mcpSessionId && this.state.mcpSessionAcquiredDeviceSessions.has(mcpSessionId)
        ? this.state.devices.get(deviceId)
        : undefined;
    const session = holderOf(device)
      ? this.state.sessionManager.getSession(holderOf(device)!)
      : null;
    if (
      !mcpSessionId ||
      !device ||
      !session ||
      !this.callbacks.hasAcquiredDeviceSession(mcpSessionId, session.sessionId) ||
      !this.callbacks.isSessionAssignmentCurrent(device, session) ||
      !this.state.sessionManager.isAdmittedForAutomation(session)
    ) {
      return undefined;
    }
    return session.sessionId;
  }

  // The attach paths are tracked like a bind (#11192): a connection closing while one waits for
  // the assignment lock or its persistence must not be adopted as the owner afterwards.
  restoreAutolockSessionsForMcpSession(
    ...args: Parameters<DeviceAutolockManager["restoreAutolockSessionsForMcpSession"]>
  ): Promise<void> {
    const endBind = this.callbacks.beginMcpBind(args[1]);
    return this.state.autolockManager
      .restoreAutolockSessionsForMcpSession(...args)
      .finally(endBind);
  }

  attachExplicitSessionUuidCall(
    ...args: Parameters<DeviceAutolockManager["attachExplicitSessionUuidCall"]>
  ): ReturnType<DeviceAutolockManager["attachExplicitSessionUuidCall"]> {
    const endBind = this.callbacks.beginMcpBind(args[1]);
    return this.state.autolockManager.attachExplicitSessionUuidCall(...args).finally(endBind);
  }

  attachAutolockSessionToMcpSession(
    ...args: Parameters<DeviceAutolockManager["attachAutolockSessionToMcpSession"]>
  ): ReturnType<DeviceAutolockManager["attachAutolockSessionToMcpSession"]> {
    const endBind = this.callbacks.beginMcpBind(args[1]);
    return this.state.autolockManager.attachAutolockSessionToMcpSession(...args).finally(endBind);
  }

  assertAutolockAccess(...args: Parameters<DeviceAutolockManager["assertAutolockAccess"]>): void {
    this.state.autolockManager.assertAutolockAccess(...args);
  }

  /**
   * Restore ownership of live result-minted sessions after a daemon socket
   * reconnect. Sessions another connection still owns are not restored and are returned as
   * refusals instead of failing the whole restore. Unlike autolock restoration, this
   * intentionally does not select an implicit routing default or mutate persisted autolock
   * metadata.
   */
  async restoreOwnedDeviceSessionsForMcpSession(
    sessionIds: readonly string[],
    mcpSessionId: string,
    livenessOwnerToken?: string,
  ): Promise<readonly RefusedOwnedSessionRestore[]> {
    // Tracked like a bind (#11192): the connection may close while this waits for the mutex.
    const endBind = this.callbacks.beginMcpBind(mcpSessionId);
    try {
      return await this.restoreOwnedDeviceSessionsUnderBindClaim(
        sessionIds,
        mcpSessionId,
        livenessOwnerToken,
      );
    } finally {
      endBind();
    }
  }

  async restoreOwnedDeviceSessionsUnderBindClaim(
    sessionIds: readonly string[],
    mcpSessionId: string,
    livenessOwnerToken: string | undefined,
  ): Promise<readonly RefusedOwnedSessionRestore[]> {
    return await this.state.assignmentMutex.runExclusive(() => {
      const refused: RefusedOwnedSessionRestore[] = [];
      for (const sessionId of sessionIds) {
        // Released label holds count as their base even when the base itself is live or refused.
        this.restoreRestartReservationConnectionOwner(sessionId, mcpSessionId, livenessOwnerToken);
        const session = this.state.sessionManager.getSession(sessionId);
        const device = session ? this.state.devices.get(session.assignedDevice) : undefined;
        if (
          session &&
          device &&
          this.callbacks.isSessionAssignmentCurrent(device, session) &&
          this.state.sessionManager.isAdmittedForAutomation(session)
        ) {
          // A derived label session is restored as its base (#11586): the base's owner and
          // liveness token decide, and the base is what the connection comes to own.
          const ownerSession = this.liveOwnershipSession(session);
          if (!ownerSession) {
            continue;
          }
          if (!this.mayRestoreMcpSessionOwnership(ownerSession, mcpSessionId, livenessOwnerToken)) {
            // One refused session must not stop the rest from restoring: the caller decides
            // whether the refusal matters to the call it is routing.
            refused.push({ sessionId, deviceId: device.id, reason: "owned-by-other-connection" });
            continue;
          }
          // A connection that closed while this restore waited is not recorded (#11192).
          this.callbacks.recordBindOwnership(mcpSessionId, sessionId);
        }
      }
      return refused;
    });
  }

  /** Capture from the held session, looking up a base only for derived connection ownership. */
  restartReservationOwnerToken(session: Session): string | undefined {
    const ownerSessionId = this.callbacks.ownershipSessionId(session.sessionId);
    return ownerSessionId === session.sessionId
      ? session.livenessOwnerToken
      : this.state.sessionManager.getSession(ownerSessionId)?.livenessOwnerToken;
  }

  /** Apply token-proved reconnect ownership to a released handoff, under assignmentMutex. */
  restoreRestartReservationConnectionOwner(
    sessionId: string,
    mcpSessionId: string,
    livenessOwnerToken: string | undefined,
  ): void {
    if (livenessOwnerToken === undefined || this.state.mcpBindsInFlight.get(mcpSessionId)?.closed) {
      return;
    }
    for (const [reservationSessionId, target] of this.state.rehydrationReservations) {
      if (
        target.restartHandoff !== true ||
        target.ownerLivenessToken !== livenessOwnerToken ||
        (reservationSessionId !== sessionId &&
          this.state.sessionManager.ownershipSessionUuid(reservationSessionId) !== sessionId)
      ) {
        continue;
      }
      // The token proves the released holder without reviving it or renewing its hold.
      target.ownerMcpSessionIds = new Set([...(target.ownerMcpSessionIds ?? []), mcpSessionId]);
    }
  }

  /**
   * The live session that carries the connection ownership of `session`: itself, or for a derived
   * label session its base when that is live under the same rule the restore applies to a named
   * session. Undefined when the base is not, so naming a label restores nothing its base would not.
   */
  liveOwnershipSession(session: Session): Session | undefined {
    const ownerSessionId = this.callbacks.ownershipSessionId(session.sessionId);
    if (ownerSessionId === session.sessionId) {
      return session;
    }
    const ownerSession = this.state.sessionManager.getSession(ownerSessionId);
    const ownerDevice = ownerSession
      ? this.state.devices.get(ownerSession.assignedDevice)
      : undefined;
    return ownerSession &&
      ownerDevice &&
      this.callbacks.isSessionAssignmentCurrent(ownerDevice, ownerSession) &&
      this.state.sessionManager.isAdmittedForAutomation(ownerSession)
      ? ownerSession
      : undefined;
  }

  /**
   * Whether a reconnecting client may restore ownership of a live session (#11107): it proves the
   * session's liveness owner token, or no other connected MCP client owns the session. Naming a
   * session UUID is not proof of ownership. Callers pass the session that carries the ownership
   * ({@link liveOwnershipSession}), never a derived label session.
   */
  mayRestoreMcpSessionOwnership(
    session: Session,
    mcpSessionId: string,
    livenessOwnerToken: string | undefined,
  ): boolean {
    if (livenessOwnerToken !== undefined && session.livenessOwnerToken === livenessOwnerToken) {
      return true;
    }
    return !this.callbacks.hasConnectedMcpSessionOwner(session.sessionId, mcpSessionId);
  }

  /**
   * Tool executions under these session ids ended: retry any owner-disconnect release they
   * deferred now rather than at the veto's bound (#10712).
   */
  sessionExecutionsEnded(sessionIds: Iterable<string>): void {
    this.state.ownerDisconnectRelease.executionsEnded(sessionIds);
  }

  /** Drop every socket-scoped route and ownership marker for a disconnected MCP client. */
  releaseMcpSessionBindings(mcpSessionId: string): void {
    this.state.mcpSessionOwnerCallsInFlight.delete(mcpSessionId);
    const bindInFlight = this.state.mcpBindsInFlight.get(mcpSessionId);
    if (bindInFlight) {
      bindInFlight.closed = true;
    }
    const acquired = this.state.mcpSessionAcquiredDeviceSessions.get(mcpSessionId);
    const undelivered = this.state.mcpSessionUndeliveredMints.get(mcpSessionId);
    this.state.mcpSessionUndeliveredMints.delete(mcpSessionId);
    this.state.mcpSessionAcquiredDeviceSessions.delete(mcpSessionId);
    this.state.mcpSessionLivenessOwnerTokens.delete(mcpSessionId);
    this.state.autolockManager.releaseMcpSessionBindings(mcpSessionId);
    this.state.mcpSessionRecoveryDevices.delete(mcpSessionId);
    for (const sessionId of acquired ?? []) {
      if (!this.callbacks.hasConnectedMcpSessionOwner(sessionId)) {
        const session = this.state.sessionManager.peekSession(sessionId);
        if (session) {
          this.state.ownerConnectionIntervals.disconnected(
            session,
            this.state.sessionManager.sessionNow(),
          );
        }
        this.state.ownerDisconnectRelease.ownerDisconnected(
          sessionId,
          mcpSessionId,
          undelivered?.has(sessionId) ? 0 : undefined,
        );
      }
    }
  }

  /**
   * Whether a still-connected MCP client other than `mcpSessionId` owns the live session
   * `sessionId` (#11344): it acquired or restored it, or routes to it by autolock. The general
   * rule {@link mayRestoreMcpSessionOwnership} applies, with autolock on or off. A derived
   * `${base}:${label}` session records no owner of its own, so it counts as its base (#11542):
   * every branch below judges {@link ownershipSessionId}.
   */
  isSessionOwnedByOtherConnection(sessionId: string, mcpSessionId?: string): boolean {
    if (mcpSessionId !== undefined) {
      if (this.state.sessionManager.getSession(sessionId) === null) {
        return false;
      }
      return this.callbacks.hasConnectedMcpSessionOwner(sessionId, mcpSessionId);
    }
    // A caller with no connection identity cannot be told apart from the owner of an ordinary
    // session, so only a live autolock, which is owned by connection, is foreign to it (#11235).
    const ownerSessionId = this.callbacks.ownershipSessionId(sessionId);
    if (!this.state.autolockManager.hasMcpSessionOwner(ownerSessionId)) {
      return false;
    }
    const session = this.state.sessionManager.getSession(ownerSessionId);
    const device = session ? this.state.devices.get(session.assignedDevice) : undefined;
    return device?.autolockSessionId === ownerSessionId;
  }

  /** Whether this connection acquired/restored the session or holds its autolock route. */
  isSessionOwnedByConnection(sessionId: string, mcpSessionId: string | undefined): boolean {
    return (
      mcpSessionId !== undefined &&
      (this.callbacks.hasAcquiredDeviceSession(mcpSessionId, sessionId) ||
        this.state.autolockManager.captureAutolockSessionForMcpSession(mcpSessionId) ===
          this.callbacks.ownershipSessionId(sessionId))
    );
  }

  /** Whether a connected MCP client other than `exceptMcpSessionId` owns `namedSessionId`. */
  hasConnectedMcpSessionOwner(namedSessionId: string, exceptMcpSessionId?: string): boolean {
    const sessionId = this.callbacks.ownershipSessionId(namedSessionId);
    for (const [mcpSessionId, acquired] of this.state.mcpSessionAcquiredDeviceSessions) {
      if (mcpSessionId !== exceptMcpSessionId && acquired.has(sessionId)) {
        return true;
      }
    }
    return this.state.autolockManager.hasMcpSessionOwner(sessionId, exceptMcpSessionId);
  }

  /**
   * Free a device whose autolock session has been released or has expired.
   *
   * Invoked via the SessionManager expiry callback. Only acts when the device
   * is still owned by the released session, so a stale callback cannot free a
   * replacement owner. Autolock-specific state is cleared when the device is
   * actually returned to idle.
   */
  releaseExpiredSessionDevice(sessionId: string, deviceId: string): void {
    const device = this.state.devices.get(deviceId);
    if (!device || holderOf(device) !== sessionId) {
      return;
    }
    const assignmentCount = device.assignmentCount;
    // The autolock clear happens inside releaseCapturedDevice when the device is
    // actually returned to idle, including after a late chained cleanup.
    void this.callbacks
      .releaseCapturedDevice(device, sessionId, assignmentCount)
      .then(() => {
        logger.info(`Released device ${deviceId} from session ${sessionId}`);
      })
      .catch((error) => {
        logger.warn(`Failed to release expired-session device ${deviceId}: ${error}`, error);
      });
  }

  /**
   * Forget the owner of a released session. Exact id on purpose: releasing a derived label session
   * must not clear the ownership its base carries for it (#11586).
   */
  clearMcpSessionOwnership(sessionId: string): void {
    this.state.ownerDisconnectRelease.cancel(sessionId);
    for (const [mcpSessionId, undelivered] of this.state.mcpSessionUndeliveredMints) {
      undelivered.delete(sessionId);
      if (undelivered.size === 0) {
        this.state.mcpSessionUndeliveredMints.delete(mcpSessionId);
      }
    }
    for (const [mcpSessionId, acquired] of this.state.mcpSessionAcquiredDeviceSessions) {
      acquired.delete(sessionId);
      if (acquired.size === 0) {
        this.state.mcpSessionAcquiredDeviceSessions.delete(mcpSessionId);
      }
    }
  }
}

export function connectConnectionSessions(
  part: () => DevicePoolConnectionSessions,
  seams: Pick<
    DevicePoolOperations,
    | "autolockDevice"
    | "captureAutolockSessionForMcpSession"
    | "adoptResumedAutolockSession"
    | "resolveAutolockSessionForMcpSession"
    | "resolveOwnedDeviceSessionForMcpSession"
    | "restoreAutolockSessionsForMcpSession"
    | "attachExplicitSessionUuidCall"
    | "attachAutolockSessionToMcpSession"
    | "assertAutolockAccess"
    | "restoreOwnedDeviceSessionsForMcpSession"
    | "sessionExecutionsEnded"
    | "releaseMcpSessionBindings"
    | "isSessionOwnedByOtherConnection"
    | "isSessionOwnedByConnection"
    | "hasConnectedMcpSessionOwner"
  >,
): ConnectionSessionsOperations {
  return {
    autolockDevice: (...args) => seams.autolockDevice(...args),
    captureAutolockSessionForMcpSession: (...args) =>
      seams.captureAutolockSessionForMcpSession(...args),
    adoptResumedAutolockSession: (...args) => seams.adoptResumedAutolockSession(...args),
    resolveAutolockSessionForMcpSession: (...args) =>
      seams.resolveAutolockSessionForMcpSession(...args),
    resolveOwnedDeviceSessionForMcpSession: (...args) =>
      seams.resolveOwnedDeviceSessionForMcpSession(...args),
    restoreAutolockSessionsForMcpSession: (...args) =>
      seams.restoreAutolockSessionsForMcpSession(...args),
    attachExplicitSessionUuidCall: (...args) => seams.attachExplicitSessionUuidCall(...args),
    attachAutolockSessionToMcpSession: (...args) =>
      seams.attachAutolockSessionToMcpSession(...args),
    assertAutolockAccess: (...args) => seams.assertAutolockAccess(...args),
    restoreOwnedDeviceSessionsForMcpSession: (...args) =>
      seams.restoreOwnedDeviceSessionsForMcpSession(...args),
    restoreOwnedDeviceSessionsUnderBindClaim: (...args) =>
      part().restoreOwnedDeviceSessionsUnderBindClaim(...args),
    restartReservationOwnerToken: (...args) => part().restartReservationOwnerToken(...args),
    restoreRestartReservationConnectionOwner: (...args) =>
      part().restoreRestartReservationConnectionOwner(...args),
    liveOwnershipSession: (...args) => part().liveOwnershipSession(...args),
    mayRestoreMcpSessionOwnership: (...args) => part().mayRestoreMcpSessionOwnership(...args),
    sessionExecutionsEnded: (...args) => seams.sessionExecutionsEnded(...args),
    releaseMcpSessionBindings: (...args) => seams.releaseMcpSessionBindings(...args),
    isSessionOwnedByOtherConnection: (...args) => seams.isSessionOwnedByOtherConnection(...args),
    isSessionOwnedByConnection: (...args) => seams.isSessionOwnedByConnection(...args),
    hasConnectedMcpSessionOwner: (...args) => seams.hasConnectedMcpSessionOwner(...args),
    releaseExpiredSessionDevice: (...args) => part().releaseExpiredSessionDevice(...args),
    clearMcpSessionOwnership: (...args) => part().clearMcpSessionOwnership(...args),
  };
}
