import { idleReleaseField } from "../releaseReasons";

import type { SessionRecoveryAssignmentDetails } from "../../models/SessionRecoveryAssignmentError";
import { readToolEnvelopePayload } from "../../utils/toolEnvelopePayload";
import { Socket } from "node:net";

import { logger } from "../../utils/logger";
import type { RefusedOwnedSessionRestore } from "../devicePool";

import { errorMessage } from "../../utils/describeUnknownError";

import { BOUND_SESSION_LOSS_CODE, DaemonRequest, type BoundSessionLoss } from "../types";
import {
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
} from "../wire/constants";

import {
  toolSelectionProfileUuidFromResponse,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../../features/toolSelection/toolSelectionControl";

import { isDeviceInventoryTool } from "../daemonMcpProxy";
import { DaemonStateAccess } from "../daemonRequestHandlers";

import { deviceAlreadyAssignedToAnotherSessionError } from "../inputDeviceOwnership";

import { McpForwardRoute, isNonBlankSessionUuid } from "./socketServerContracts";

import { ReleasedBoundSessionError } from "./ReleasedBoundSessionError";
import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<
  SocketServerRuntime,
  "clientSockets" | "daemonState" | "boundMcpClientKeysBySocketSession" | "clearConnectionDevicePin"
>;
type Callbacks = Pick<
  SocketServerOperations,
  | "ownedSessionsOwnerToken"
  | "selectorSessionIds"
  | "releaseBindingsIfSocketDisconnected"
  | "failIfCallTargetsRefusedRestore"
  | "getSessionUuid"
  | "recordGeneratedToolSelectionProfile"
  | "isReleasedBoundSession"
  | "isRetryableSessionRecoveryResult"
  | "recordSessionBoundMcpClientKey"
  | "isSessionOwnedByOtherConnection"
  | "clearBoundMcpClientKey"
  | "targetsOneCallOnly"
  | "hasActiveDaemonSession"
  | "getGeneratedToolSelectionProfileUuid"
  | "honoursBoundSessionMarker"
  | "admitReleasedBoundSession"
  | "expiredBoundSessionRelease"
  | "getObjectRequestArgumentScopeKey"
  | "sessionToScopeKey"
  | "resolveDeviceLabelSession"
  | "getImplicitAutolockScopeKey"
  | "getAssignedDeviceForSession"
  | "resolveImplicitAutolockSession"
  | "getRequestPlatform"
>;
/** Mcp Bindings over shared connection state and explicit callbacks. */
export class McpBindings {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  async restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void> {
    const token = this.callbacks.ownedSessionsOwnerToken(args);
    // A queued call must not recreate its closed connection's identity (#11999).
    if (token !== undefined && this.state.clientSockets.has(socketSessionId)) {
      try {
        if (this.state.daemonState.isInitialized()) {
          this.state.daemonState
            .getDevicePool()
            .declareMcpSessionLivenessOwnerToken?.(socketSessionId, token);
        }
      } catch (error) {
        // Declaring an optional connection identity must not block the tool call or restore.
        logger.warn(`Unable to declare MCP session owner token: ${errorMessage(error)}`, error);
      }
    }
    const ids = this.callbacks.selectorSessionIds(args);
    if (!ids) {
      return;
    }
    const pool = this.state.daemonState.getDevicePool();
    const ownerSocket = this.state.clientSockets.get(socketSessionId);
    // Restoration attaches only live sessions. It restores both explicit
    // acquisition ownership and autolock routing without reallocating a
    // released UUID.
    const refused =
      (await pool.restoreOwnedDeviceSessionsForMcpSession?.(ids, socketSessionId, token)) ?? [];
    if (this.callbacks.releaseBindingsIfSocketDisconnected(socketSessionId, ownerSocket, pool)) {
      return;
    }
    // A session another connection owns must not be restored as this connection's autolock
    // route either: that would rewrite its persisted owner and make it this client's default.
    const refusedIds = new Set(refused.map((refusal) => refusal.sessionId));
    await pool.restoreAutolockSessionsForMcpSession?.(
      ids.filter((id) => !refusedIds.has(id)),
      socketSessionId,
    );
    this.callbacks.releaseBindingsIfSocketDisconnected(socketSessionId, ownerSocket, pool);
    this.callbacks.failIfCallTargetsRefusedRestore(args, refused);
  }
  /**
   * A refused owned-session restore skips that session rather than failing an unrelated call
   * (#11107): the call fails only when it targets the refused session or its device.
   */
  failIfCallTargetsRefusedRestore(
    args: unknown,
    refused: readonly RefusedOwnedSessionRestore[],
  ): void {
    const record =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    for (const { sessionId, deviceId, reason } of refused) {
      logger.warn(
        `[McpForward] skipped restoring owned session ${sessionId} on ${deviceId}: ${reason}`,
      );
      if (record.sessionUuid === sessionId || record.deviceId === deviceId) {
        throw deviceAlreadyAssignedToAnotherSessionError(deviceId);
      }
    }
  }
  /** The proxy's acquisition/restore identity, independent of whether it retained sessions. */
  ownedSessionsOwnerToken(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const token = (args as Record<string, unknown>)[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    return typeof token === "string" && token.trim() !== "" ? token : undefined;
  }
  selectorSessionIds(args: unknown): string[] | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const ids = (args as Record<string, unknown>)[DAEMON_OWNED_SESSIONS_PARAM];
    return Array.isArray(ids) && ids.every(isNonBlankSessionUuid)
      ? [...new Set<string>(ids)]
      : undefined;
  }
  releaseBindingsIfSocketDisconnected(
    socketSessionId: string,
    ownerSocket: Socket | undefined,
    pool: ReturnType<DaemonStateAccess["getDevicePool"]>,
  ): boolean {
    if (!ownerSocket || this.state.clientSockets.get(socketSessionId) === ownerSocket) {
      return false;
    }
    pool.releaseMcpSessionBindings?.(socketSessionId);
    return true;
  }
  releaseDevicePoolMcpSessionBindings(socketSessionId: string): void {
    if (this.state.daemonState.isInitialized()) {
      this.state.daemonState.getDevicePool().releaseMcpSessionBindings?.(socketSessionId);
    }
  }
  clearConnectionDevicePin(socketSessionId: string): void {
    this.state.clearConnectionDevicePin?.(socketSessionId);
  }
  recordBoundMcpClientKey(
    request: DaemonRequest,
    socketSessionId: string,
    route: McpForwardRoute,
    sessionWasActiveBeforeForward: boolean,
    response: unknown,
  ): void {
    if (request.method !== "tools/call") {
      return;
    }
    if (isDeviceInventoryTool(request.params?.name)) {
      return;
    }
    const sessionUuid = this.callbacks.getSessionUuid(request.params?.arguments);
    if (!sessionUuid) {
      this.callbacks.recordGeneratedToolSelectionProfile(request, response, socketSessionId, route);
      return;
    }
    if (
      this.callbacks.isReleasedBoundSession(request.params?.arguments, socketSessionId) &&
      this.callbacks.isRetryableSessionRecoveryResult(response, sessionUuid)
    ) {
      // Recovery is still using the admitted identity; keep its transport binding.
      return;
    }
    // A profile reaffirm routed onto the acquired device session binds the
    // socket to THAT session's client (#7005); every other explicit-session
    // route carries the request's own session.
    this.callbacks.recordSessionBoundMcpClientKey(
      socketSessionId,
      route,
      route.sessionUuid ?? sessionUuid,
      sessionWasActiveBeforeForward,
      request.params?.name,
      request.params?.arguments,
    );
  }
  isSessionOwnedByOtherConnection(sessionUuid: string, socketSessionId: string): boolean {
    return (
      this.state.daemonState.isInitialized() &&
      this.state.daemonState
        .getDevicePool()
        .isSessionOwnedByOtherConnection?.(sessionUuid, socketSessionId) === true
    );
  }
  /** A foreign connected owner's binding requires its recorded token (#11555 item 3). */
  honoursBoundSessionMarker(args: Record<string, unknown>, socketSessionId?: string): boolean {
    const sessionUuid = this.callbacks.getSessionUuid(args);
    if (args[DAEMON_BOUND_SESSION_PARAM] !== sessionUuid) {
      return false;
    }
    if (sessionUuid === undefined || !socketSessionId || !this.state.daemonState.isInitialized()) {
      return true;
    }
    // The token read is a peek. Only a recorded token can reach the connection fence's
    // ownership question below, which may lazily expire the session.
    // Older socket-state fakes lack these readers and retain the tokenless marker behaviour.
    const sessions = this.state.daemonState.getSessionManager();
    const ownershipSessionUuid = sessions.ownershipSessionUuid?.(sessionUuid) ?? sessionUuid;
    const ownerToken = sessions.peekSession?.(ownershipSessionUuid)?.livenessOwnerToken;
    return (
      !ownerToken ||
      this.callbacks.ownedSessionsOwnerToken(args) === ownerToken ||
      !this.callbacks.isSessionOwnedByOtherConnection(sessionUuid, socketSessionId)
    );
  }
  isRetryableSessionRecoveryResult(response: unknown, sessionUuid: string): boolean {
    if (
      !response ||
      typeof response !== "object" ||
      !("isError" in response) ||
      response.isError !== true
    ) {
      return false;
    }
    const error = readToolEnvelopePayload(response)?.payload.error as
      | Partial<SessionRecoveryAssignmentDetails>
      | undefined;
    return (
      error?.code === "session_recovery_pending" &&
      error.retryable === true &&
      error.sessionUuid === sessionUuid
    );
  }
  recordSessionBoundMcpClientKey(
    socketSessionId: string,
    route: McpForwardRoute,
    sessionUuid: string,
    sessionWasActiveBeforeForward: boolean,
    toolName: unknown,
    args: unknown,
  ): void {
    if (this.callbacks.isReleasedBoundSession(args, socketSessionId)) {
      this.callbacks.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    if (this.callbacks.isSessionOwnedByOtherConnection(sessionUuid, socketSessionId)) {
      // Naming a session another connected client owns is not ownership (#11235, #11344): this
      // socket keeps its own route so its sessionless calls never follow it.
      return;
    }
    if (this.callbacks.targetsOneCallOnly(args, sessionUuid)) {
      // The proxy named its own binding beside an explicit session: the call targeted that
      // session only, and the connection's default route does not move (#11347).
      return;
    }
    const sessionIsActiveAfterForward = this.callbacks.hasActiveDaemonSession(sessionUuid);
    if (
      (sessionWasActiveBeforeForward || toolName === "executePlan") &&
      !sessionIsActiveAfterForward
    ) {
      this.callbacks.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    this.state.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      sessionUuid,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid,
      requiresLiveDaemonSession: sessionWasActiveBeforeForward || sessionIsActiveAfterForward,
    });
  }
  /**
   * Whether the call carried the connection's bound session ({@link DAEMON_BOUND_SESSION_PARAM})
   * beside a different session it routed to. Only setActiveDevice or an acquisition moves a
   * connection's default (#11347); an explicit `sessionUuid` targets its own call.
   */
  targetsOneCallOnly(args: unknown, routedSessionUuid: string): boolean {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return false;
    }
    const bound = (args as Record<string, unknown>)[DAEMON_BOUND_SESSION_PARAM];
    return isNonBlankSessionUuid(bound) && bound !== routedSessionUuid;
  }
  recordGeneratedToolSelectionProfile(
    request: DaemonRequest,
    response: unknown,
    socketSessionId: string,
    route: McpForwardRoute,
  ): boolean {
    const toolSelectionProfileUuid = this.callbacks.getGeneratedToolSelectionProfileUuid(
      request,
      response,
    );
    if (!toolSelectionProfileUuid) {
      return false;
    }
    this.state.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      toolSelectionProfileUuid,
      requiresLiveDaemonSession: false,
    });
    return true;
  }
  getBoundMcpClientRoute(
    socketSessionId: string,
    recoverableSessionUuid?: string,
  ): McpForwardRoute | undefined {
    const boundClient = this.state.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return undefined;
    }
    if (
      !boundClient.requiresLiveDaemonSession ||
      !this.state.daemonState.isInitialized() ||
      (recoverableSessionUuid !== undefined && boundClient.sessionUuid === recoverableSessionUuid)
    ) {
      return {
        clientKey: boundClient.clientKey,
        executionKey: boundClient.executionKey,
        sessionUuid: boundClient.sessionUuid,
        toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
      };
    }
    if (boundClient.sessionUuid && this.callbacks.hasActiveDaemonSession(boundClient.sessionUuid)) {
      return {
        clientKey: boundClient.clientKey,
        executionKey: boundClient.executionKey,
        sessionUuid: boundClient.sessionUuid,
        toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
      };
    }
    this.callbacks.clearBoundMcpClientKey(socketSessionId);
    return undefined;
  }
  getToolSelectionProfileUuid(params: unknown): string | undefined {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return undefined;
    }
    const value = (params as Record<string, unknown>)[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    return isNonBlankSessionUuid(value) ? value : undefined;
  }
  getGeneratedToolSelectionProfileUuid(
    request: DaemonRequest,
    response: unknown,
  ): string | undefined {
    if (request.params?.name !== SET_TOOL_ENABLED_TOOL_NAME) {
      return undefined;
    }
    return toolSelectionProfileUuidFromResponse(response);
  }
  clearBoundMcpClientKey(socketSessionId: string): void {
    const boundClient = this.state.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return;
    }
    this.state.boundMcpClientKeysBySocketSession.delete(socketSessionId);
  }
  clearBoundMcpClientsForReleasedSession(sessionUuid: string): void {
    for (const [socketSessionId, boundClient] of this.state.boundMcpClientKeysBySocketSession) {
      if (boundClient.sessionUuid === sessionUuid) {
        this.callbacks.clearBoundMcpClientKey(socketSessionId);
      }
    }
  }
  isMcpClientKeyBound(key: string): boolean {
    for (const boundClient of this.state.boundMcpClientKeysBySocketSession.values()) {
      if (boundClient.clientKey === key) {
        return true;
      }
    }
    return false;
  }
  getSessionForDevice(deviceId: string): string | undefined {
    if (!this.state.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return (
        this.state.daemonState.getSessionManager().getSessionForDevice?.(deviceId) ?? undefined
      );
    } catch (error) {
      // Without a proven device→session mapping the caller must fall back to no
      // session identity rather than guess an owner, so fail closed to undefined.
      logger.debug(`Unable to resolve session for device ${deviceId}: ${error}`);
      return undefined;
    }
  }
  /** The session object itself: identity-compared to tell a recreated session from the original. */
  getSessionIncarnation(sessionUuid: string | undefined): object | undefined {
    if (!sessionUuid || !this.state.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.state.daemonState.getSessionManager().getSession(sessionUuid) ?? undefined;
    } catch (error) {
      // A missing incarnation snapshot is safe: downstream owner validation treats
      // an absent incarnation as unverifiable and fails the ownership check closed.
      logger.debug(`Unable to capture session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }
  // Keep MCP route bindings through teardown; downstream tool admission waits for
  // release to finish so bound-session loss retains the terminal release reason.
  hasActiveDaemonSession(sessionUuid: string): boolean {
    if (!this.state.daemonState.isInitialized()) {
      return false;
    }
    try {
      return this.state.daemonState.getSessionManager().getSession(sessionUuid) !== null;
    } catch (error) {
      logger.warn(`Unable to resolve bound session ${sessionUuid}: ${errorMessage(error)}`, error);
      throw new ReleasedBoundSessionError({
        code: BOUND_SESSION_LOSS_CODE,
        sessionUuid,
        reason: "session-not-found",
      });
    }
  }
  getSessionUuid(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const sessionUuid = (args as Record<string, unknown>).sessionUuid;
    return isNonBlankSessionUuid(sessionUuid) ? sessionUuid : undefined;
  }
  isReleasedBoundSession(args: unknown, socketSessionId?: string): boolean {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !this.state.daemonState.isInitialized()
    ) {
      return false;
    }
    const record = args as Record<string, unknown>;
    const sessionUuid = this.callbacks.getSessionUuid(record);
    return (
      sessionUuid !== undefined &&
      this.callbacks.honoursBoundSessionMarker(record, socketSessionId) &&
      !this.callbacks.hasActiveDaemonSession(sessionUuid)
    );
  }
  boundSessionAdmissionArgs(request: DaemonRequest): unknown {
    const sessionUuid = this.callbacks.getSessionUuid(request.params);
    return request.method === "resources/read" &&
      sessionUuid !== undefined &&
      request.params?.[DAEMON_RELEASED_SESSION_PARAM] === sessionUuid &&
      request.params?.uri === `automobile:device-session/${sessionUuid}/screenshot`
      ? undefined
      : request.params;
  }
  withAdmittedBoundSession<T>(
    args: unknown,
    forward: (recoverableSessionUuid?: string) => T,
    socketSessionId?: string,
  ): T | Promise<T> {
    if (!this.callbacks.isReleasedBoundSession(args, socketSessionId)) {
      // Keep healthy routing and forwarding synchronous up to the existing I/O.
      return forward();
    }
    const sessionUuid = this.callbacks.getSessionUuid(args)!;
    return this.callbacks.admitReleasedBoundSession(sessionUuid).then(() => forward(sessionUuid));
  }
  async admitReleasedBoundSession(sessionUuid: string): Promise<void> {
    try {
      if (
        await this.state.daemonState
          .getSessionManager()
          .isReleasedSessionInRestartRecoveryWindow?.(sessionUuid)
      ) {
        return;
      }
    } catch (error) {
      logger.warn(
        `Unable to read restart recovery window for bound session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
    }
    const release =
      this.state.daemonState.getSessionManager().getTerminalReleaseSnapshot?.(sessionUuid) ??
      (await this.callbacks.expiredBoundSessionRelease(sessionUuid));
    throw new ReleasedBoundSessionError({
      code: BOUND_SESSION_LOSS_CODE,
      sessionUuid,
      reason: release?.releaseReason ?? "session-not-found",
      ...idleReleaseField(release?.releaseReason),
      ...(release ? { release } : {}),
    });
  }
  /**
   * The release of a bound session whose row ran out its window with no daemon holding it
   * (#11361), so its owner is told `expired` rather than `session-not-found`. Best-effort: a
   * failed read keeps the fail-closed not-found answer.
   */
  async expiredBoundSessionRelease(sessionUuid: string): Promise<BoundSessionLoss["release"]> {
    try {
      return await this.state.daemonState
        .getSessionManager()
        .getExpiredReleaseSnapshot?.(sessionUuid);
    } catch (error) {
      logger.warn(
        `Unable to read the expired release of bound session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }
  getRequestArgumentScopeKey(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    return this.callbacks.getObjectRequestArgumentScopeKey(args as Record<string, unknown>, args);
  }
  getObjectRequestArgumentScopeKey(
    record: Record<string, unknown>,
    args: object,
  ): string | undefined {
    const hasSessionUuid = isNonBlankSessionUuid(record.sessionUuid);
    const hasDeviceLabel = typeof record.device === "string" && record.device.length > 0;
    // Precedence (pinned by #2565 review): a device label resolves the mapped session before
    // an explicit deviceId, which in turn beats a raw session, which beats implicit autolock.
    if (hasSessionUuid && hasDeviceLabel) {
      return this.callbacks.sessionToScopeKey(
        this.callbacks.resolveDeviceLabelSession(record.sessionUuid as string, record.device),
      );
    }
    // An explicit target device must serialize by physical device even when a session is present.
    if (typeof record.deviceId === "string" && record.deviceId.length > 0) {
      return `device:${record.deviceId}`;
    }
    if (hasSessionUuid) {
      return this.callbacks.sessionToScopeKey(record.sessionUuid as string);
    }
    if (typeof record.__mcpSessionId === "string" && record.__mcpSessionId.length > 0) {
      return (
        this.callbacks.getImplicitAutolockScopeKey(record.__mcpSessionId, args) ??
        `mcp-session:${record.__mcpSessionId}`
      );
    }
    return undefined;
  }
  /**
   * Resolve a session UUID to its forwarding scope key: the bound physical device when one is
   * assigned (so independent devices serialize together), otherwise the raw session. This is the
   * single resolver every session-keyed branch feeds, including implicit autolock resolution.
   */
  sessionToScopeKey(sessionUuid: string): string {
    const assignedDevice = this.callbacks.getAssignedDeviceForSession(sessionUuid);
    return assignedDevice ? `device:${assignedDevice}` : `session:${sessionUuid}`;
  }
  getImplicitAutolockScopeKey(mcpSessionId: string, args: unknown): string | undefined {
    const autolockSession = this.callbacks.resolveImplicitAutolockSession(mcpSessionId, args);
    return autolockSession ? this.callbacks.sessionToScopeKey(autolockSession) : undefined;
  }
  resolveImplicitAutolockSession(mcpSessionId: string, args: unknown): string | undefined {
    if (!this.state.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      const platform = this.callbacks.getRequestPlatform(args);
      const autolockSession = this.state.daemonState
        .getDevicePool()
        .resolveAutolockSessionForMcpSession?.(mcpSessionId, platform);
      if (!autolockSession) {
        return undefined;
      }
      return autolockSession;
    } catch (error) {
      logger.debug(`Unable to resolve autolock session for MCP session ${mcpSessionId}: ${error}`);
      return undefined;
    }
  }
  getRequestPlatform(args: unknown): "android" | "ios" | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const platform = (args as Record<string, unknown>).platform;
    return platform === "android" || platform === "ios" ? platform : undefined;
  }
  resolveDeviceLabelSession(baseSessionUuid: string, deviceLabel: unknown): string {
    if (
      typeof deviceLabel !== "string" ||
      deviceLabel.length === 0 ||
      !this.state.daemonState.isInitialized()
    ) {
      return baseSessionUuid;
    }
    try {
      const labelMap = this.state.daemonState.getSessionManager().getDeviceLabels(baseSessionUuid);
      if (!labelMap) {
        return baseSessionUuid;
      }
      const mappedSession = labelMap[deviceLabel];
      return typeof mappedSession === "string" && mappedSession.length > 0
        ? mappedSession
        : baseSessionUuid;
    } catch (error) {
      logger.debug(
        `Unable to resolve device label ${deviceLabel} for session ${baseSessionUuid}: ${error}`,
      );
      return baseSessionUuid;
    }
  }
  getAssignedDeviceForSession(sessionUuid: string): string | undefined {
    if (!this.state.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.state.daemonState.getSessionManager().getSession(sessionUuid)?.assignedDevice;
    } catch (error) {
      logger.debug(`Unable to resolve device for session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }
}
