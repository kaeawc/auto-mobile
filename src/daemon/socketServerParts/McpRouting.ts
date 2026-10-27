import { logger } from "../../utils/logger";

import { errorMessage } from "../../utils/describeUnknownError";

import { DaemonRequest } from "../types";
import { DAEMON_BOUND_SESSION_PARAM, DAEMON_RELEASED_SESSION_PARAM } from "../wire/constants";
import { isHostInventoryCall } from "../socketRequestAdmission";

import { SET_TOOL_ENABLED_TOOL_NAME } from "../../features/toolSelection/toolSelectionControl";

import { resolveToolSelectionBaseSessionUuid } from "../../features/toolSelection/selectionSessionResolver";

import {
  DEVICE_ACQUISITION_TOOL_NAMES,
  MCP_FORWARD_READ_LANE_SUFFIX,
  MCP_FORWARD_DEVICE_KEY_PREFIX,
  McpForwardRoute,
  isNonBlankSessionUuid,
  ProfileReaffirmForwardRouteOptions,
} from "./socketServerContracts";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<SocketServerRuntime, "daemonState" | "deviceReadToolCallClassifier">;
type Callbacks = Pick<
  SocketServerOperations,
  | "getToolsCallForwardRoute"
  | "withDeviceReadLane"
  | "withAdmittedBoundSession"
  | "boundSessionAdmissionArgs"
  | "getAdmittedMcpForwardRoute"
  | "isDeviceReadToolCall"
  | "getDeviceHolderSession"
  | "getSessionUuid"
  | "getDeviceLabelSession"
  | "resolveImplicitAutolockSession"
  | "resolveDeviceLabelSession"
  | "getSessionForDevice"
  | "getBoundMcpClientRoute"
  | "getDiscoveryForwardRoute"
  | "getNavigationGraphForwardRoute"
  | "getResourceReadForwardRoute"
  | "sharedMcpForwardRoute"
  | "getToolSelectionProfileUuid"
  | "sessionScopedForwardRoute"
  | "toolSelectionProfileScopedForwardRoute"
  | "getRequestArgumentScopeKey"
  | "ownedSessionsOwnerToken"
  | "isMcpRequestOwnerCurrent"
  | "getAdmittedToolsCallForwardRoute"
  | "isUnboundDeviceAcquisitionTool"
  | "acquisitionMcpForwardRoute"
  | "hasImplicitDeviceSelector"
  | "selectorMcpForwardRoute"
  | "profileReaffirmForwardRoute"
  | "hostInventoryOrBoundRoute"
  | "getImplicitAutolockScopeKey"
  | "getAcquiredDeviceSessionUuid"
  | "hasActiveDaemonSession"
  | "sessionMcpClientKey"
  | "toolSelectionProfileMcpClientKey"
>;
/** Mcp Routing over shared connection state and explicit callbacks. */
export class McpRouting {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  getMcpForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute | Promise<McpForwardRoute> {
    if (request.method === "tools/call") {
      const route = this.callbacks.getToolsCallForwardRoute(
        request.params?.arguments,
        socketSessionId,
        request.params?.name,
      );
      const toLane = (resolved: McpForwardRoute) =>
        isHostInventoryCall(request.params?.name, request.params?.arguments)
          ? { ...resolved, executionKey: "host:inventory" }
          : this.callbacks.withDeviceReadLane(resolved, request, socketSessionId);
      return route instanceof Promise ? route.then(toLane) : toLane(route);
    }
    return this.callbacks.withAdmittedBoundSession(
      this.callbacks.boundSessionAdmissionArgs(request),
      (recoverableSessionUuid) =>
        this.callbacks.getAdmittedMcpForwardRoute(request, socketSessionId, recoverableSessionUuid),
    );
  }
  /**
   * Move a watcher's read of a held device onto the device's read lane (#10969). Control calls,
   * the holder's own calls (by session, device label, autolock or the acquiring connection) and
   * reads of a free device, which may run readiness, stay on the control lane. Re-resolved before
   * the forward runs, so an acquisition or release while queued moves the call between lanes.
   */
  withDeviceReadLane(
    route: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute {
    const toolName = request.params?.name;
    const args = request.params?.arguments;
    if (
      !route.executionKey.startsWith(MCP_FORWARD_DEVICE_KEY_PREFIX) ||
      typeof toolName !== "string" ||
      !this.callbacks.isDeviceReadToolCall(toolName, args)
    ) {
      return route;
    }
    const deviceId = route.executionKey.slice(MCP_FORWARD_DEVICE_KEY_PREFIX.length);
    const holder = this.callbacks.getDeviceHolderSession(deviceId);
    if (!holder) {
      return route;
    }
    const sessionManager = this.state.daemonState.getSessionManager();
    const base = (sessionUuid: string | undefined) =>
      sessionUuid ? resolveToolSelectionBaseSessionUuid(sessionUuid, sessionManager) : undefined;
    const holderBase = base(holder);
    const callerSessions = [
      route.sessionUuid,
      this.callbacks.getSessionUuid(args),
      this.callbacks.getDeviceLabelSession(args),
      this.callbacks.resolveImplicitAutolockSession(socketSessionId, args),
      this.state.daemonState
        .getDevicePool()
        .resolveOwnedDeviceSessionForMcpSession?.(socketSessionId, deviceId),
    ];
    if (callerSessions.some((sessionUuid) => base(sessionUuid) === holderBase)) {
      return route;
    }
    return { ...route, executionKey: `${route.executionKey}${MCP_FORWARD_READ_LANE_SUFFIX}` };
  }
  getDeviceLabelSession(args: unknown): string | undefined {
    const baseSessionUuid = this.callbacks.getSessionUuid(args);
    const record = args as Record<string, unknown> | undefined;
    return baseSessionUuid && typeof record?.device === "string" && record.device.length > 0
      ? this.callbacks.resolveDeviceLabelSession(baseSessionUuid, record.device)
      : undefined;
  }
  isDeviceReadToolCall(toolName: string, args: unknown): boolean {
    try {
      return this.state.deviceReadToolCallClassifier(toolName, args);
    } catch (error) {
      // An argument set the classifier cannot read is not proven a read: keep the control lane.
      logger.debug(`[McpForward] read classification failed for ${toolName}: ${error}`);
      return false;
    }
  }
  /** The session holding a device: its live owner, or its autolock holder. */
  getDeviceHolderSession(deviceId: string): string | undefined {
    if (!this.state.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return (
        this.callbacks.getSessionForDevice(deviceId) ??
        this.state.daemonState.getDevicePool().getDevice?.(deviceId)?.autolockSessionId ??
        undefined
      );
    } catch (error) {
      // Without a proven holder the call keeps the control lane, as before #10969.
      logger.debug(`[McpForward] holder lookup failed for ${deviceId}: ${error}`);
      return undefined;
    }
  }
  getAdmittedMcpForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    recoverableSessionUuid?: string,
  ): McpForwardRoute {
    const boundRoute = this.callbacks.getBoundMcpClientRoute(
      socketSessionId,
      recoverableSessionUuid,
    );
    if (
      request.method === "tools/list" ||
      request.method === "resources/list" ||
      request.method === "resources/list-templates"
    ) {
      return this.callbacks.getDiscoveryForwardRoute(request, socketSessionId, boundRoute);
    }
    if (request.method === "ide/getNavigationGraph") {
      return this.callbacks.getNavigationGraphForwardRoute(request, socketSessionId, boundRoute);
    }
    if (request.method === "resources/read") {
      return this.callbacks.getResourceReadForwardRoute(request, socketSessionId);
    }
    return this.callbacks.sharedMcpForwardRoute(`method:${request.method}`);
  }
  getDiscoveryForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    if (request.method === "tools/list") {
      // A reconnected restricted discovery re-sends `{sessionUuid}` (see
      // daemonMcpProxy.listTools). A fresh socket has no boundRoute, so without
      // honoring the request's session the shared UNSEEDED client would return the
      // full, unfiltered tool list. Route to the session-scoped client so the
      // seeded loopback transport advertises the session-scoped list, completing
      // the proxy-side reconnect seeding (issue #4610).
      const listSessionUuid = this.callbacks.getSessionUuid(request.params);
      const toolSelectionProfileUuid = this.callbacks.getToolSelectionProfileUuid(request.params);
      if (listSessionUuid) {
        return this.callbacks.sessionScopedForwardRoute(
          socketSessionId,
          listSessionUuid,
          undefined,
          toolSelectionProfileUuid,
        );
      }
      if (toolSelectionProfileUuid) {
        return this.callbacks.toolSelectionProfileScopedForwardRoute(
          socketSessionId,
          toolSelectionProfileUuid,
          undefined,
        );
      }
      return boundRoute ?? this.callbacks.sharedMcpForwardRoute(`method:${request.method}`);
    }
    const sessionUuid = this.callbacks.getSessionUuid(request.params);
    const toolSelectionProfileUuid = this.callbacks.getToolSelectionProfileUuid(request.params);
    if (sessionUuid) {
      return this.callbacks.sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        toolSelectionProfileUuid,
      );
    }
    if (toolSelectionProfileUuid) {
      return this.callbacks.toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        undefined,
      );
    }
    return boundRoute ?? this.callbacks.sharedMcpForwardRoute(`method:${request.method}`);
  }
  getNavigationGraphForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    const sessionUuid = this.callbacks.getSessionUuid(request.params);
    const executionKey = this.callbacks.getRequestArgumentScopeKey(request.params);
    if (sessionUuid) {
      // An explicit read session routes to its OWN session-specific client so a
      // cross-session IDE read never repurposes the socket's bound transport. If
      // it reused the bound client, the loopback SessionToolBinding would be
      // rebound to this UUID while recordBoundMcpClientKey early-returns for
      // non-tools/call methods, leaving the daemon route labeled the bound
      // session and the transport filtering by a different profile (issue #4610).
      return this.callbacks.sessionScopedForwardRoute(socketSessionId, sessionUuid, executionKey);
    }
    if (executionKey) {
      return boundRoute
        ? { ...boundRoute, executionKey }
        : this.callbacks.sharedMcpForwardRoute(executionKey);
    }
    return boundRoute ?? this.callbacks.sharedMcpForwardRoute(`method:${request.method}`);
  }
  getResourceReadForwardRoute(request: DaemonRequest, socketSessionId: string): McpForwardRoute {
    const sessionUuid = this.callbacks.getSessionUuid(request.params);
    if (sessionUuid) {
      const releasedSessionUuid =
        request.params?.[DAEMON_RELEASED_SESSION_PARAM] === sessionUuid ? sessionUuid : undefined;
      return this.callbacks.sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        undefined,
        releasedSessionUuid === sessionUuid ? releasedSessionUuid : undefined,
      );
    }
    const uri = request.params?.uri;
    return this.callbacks.sharedMcpForwardRoute(
      typeof uri === "string" ? `resource:${uri}` : "resource:unknown",
    );
  }
  beginMcpSessionOwnerCall(
    args: unknown,
    socketSessionId: string,
    signal: AbortSignal,
  ): (() => void) | undefined {
    const token = this.callbacks.ownedSessionsOwnerToken(args);
    if (token === undefined || !this.callbacks.isMcpRequestOwnerCurrent(socketSessionId, signal)) {
      return undefined;
    }
    try {
      if (!this.state.daemonState.isInitialized()) {
        return undefined;
      }
      const end = this.state.daemonState
        .getDevicePool()
        .beginMcpSessionOwnerCall?.(socketSessionId, token);
      return () => {
        try {
          end?.();
        } catch (error) {
          // Optional claim bookkeeping must not replace the tool's result or prevent disposal.
          logger.warn(`Unable to end MCP session owner call: ${errorMessage(error)}`, error);
        }
      };
    } catch (error) {
      // Optional claim bookkeeping must not block the tool call.
      logger.warn(`Unable to begin MCP session owner call: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
  getToolsCallForwardRoute(
    args: unknown,
    socketSessionId: string,
    toolName?: unknown,
  ): McpForwardRoute | Promise<McpForwardRoute> {
    return this.callbacks.withAdmittedBoundSession(
      args,
      (recoverableSessionUuid) =>
        this.callbacks.getAdmittedToolsCallForwardRoute(
          args,
          socketSessionId,
          toolName,
          recoverableSessionUuid,
        ),
      socketSessionId,
    );
  }
  getAdmittedToolsCallForwardRoute(
    args: unknown,
    socketSessionId: string,
    toolName?: unknown,
    recoverableSessionUuid?: string,
  ): McpForwardRoute {
    const scopedKey = this.callbacks.getRequestArgumentScopeKey(args);
    const boundRoute = this.callbacks.getBoundMcpClientRoute(
      socketSessionId,
      recoverableSessionUuid,
    );
    const sessionUuid = this.callbacks.getSessionUuid(args);
    const toolSelectionProfileUuid =
      this.callbacks.getToolSelectionProfileUuid(args) ?? boundRoute?.toolSelectionProfileUuid;
    if (this.callbacks.isUnboundDeviceAcquisitionTool(toolName, sessionUuid)) {
      // Acquisition can mint a second device session on an already-bound
      // daemon socket. Keep each platform/tool on its own loopback client without
      // a device-session binding;
      // reusing the first acquired session's bound transport makes the second
      // acquisition and later selector routing disagree about ownership.
      return this.callbacks.acquisitionMcpForwardRoute(
        socketSessionId,
        toolName,
        toolSelectionProfileUuid,
      );
    }
    if (this.callbacks.hasImplicitDeviceSelector(args)) {
      return this.callbacks.selectorMcpForwardRoute(
        socketSessionId,
        args,
        scopedKey,
        toolSelectionProfileUuid,
      );
    }
    if (sessionUuid) {
      return (
        this.callbacks.profileReaffirmForwardRoute({
          args,
          socketSessionId,
          toolName,
          sessionUuid,
          toolSelectionProfileUuid,
          scopedKey,
          boundRoute,
        }) ??
        this.callbacks.sessionScopedForwardRoute(
          socketSessionId,
          sessionUuid,
          scopedKey,
          toolSelectionProfileUuid,
        )
      );
    }
    if (toolSelectionProfileUuid) {
      return this.callbacks.toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        scopedKey,
      );
    }
    if (scopedKey) {
      if (boundRoute) {
        return { ...boundRoute, executionKey: scopedKey };
      }
      return this.callbacks.sharedMcpForwardRoute(scopedKey);
    }
    if (boundRoute) {
      return this.callbacks.hostInventoryOrBoundRoute(boundRoute, toolName, args);
    }
    const implicitAutolockKey = this.callbacks.getImplicitAutolockScopeKey(socketSessionId, args);
    if (implicitAutolockKey) {
      return this.callbacks.sharedMcpForwardRoute(implicitAutolockKey);
    }
    // The daemon injects __mcpSessionId before forwarding. Use the socket session as the
    // pre-forward key so separate daemon clients can autolock and run independently.
    return this.callbacks.sharedMcpForwardRoute(`socket:${socketSessionId}`);
  }
  hostInventoryOrBoundRoute(
    boundRoute: McpForwardRoute,
    toolName: unknown,
    args: unknown,
  ): McpForwardRoute {
    return isHostInventoryCall(toolName, args)
      ? { ...boundRoute, executionKey: "host:inventory" }
      : boundRoute;
  }
  isUnboundDeviceAcquisitionTool(
    toolName: unknown,
    sessionUuid: string | undefined,
  ): toolName is string {
    return (
      typeof toolName === "string" && DEVICE_ACQUISITION_TOOL_NAMES.has(toolName) && !sessionUuid
    );
  }
  /**
   * A `setToolEnabled` reaffirming the connection's own profile names no device
   * route of its own. Seeding a loopback with the profile as its DEVICE binding
   * made the update's label readback enumerate the profile (nothing) instead of
   * the device session this socket acquired, so carry that acquired route
   * through: the one the proxy sent alongside, else the one this socket is
   * already bound to (#7005). Undefined for every other explicit-session call.
   */
  profileReaffirmForwardRoute(
    options: ProfileReaffirmForwardRouteOptions,
  ): McpForwardRoute | undefined {
    const {
      args,
      socketSessionId,
      toolName,
      sessionUuid,
      toolSelectionProfileUuid,
      scopedKey,
      boundRoute,
    } = options;
    if (toolName !== SET_TOOL_ENABLED_TOOL_NAME || sessionUuid !== toolSelectionProfileUuid) {
      return undefined;
    }
    const acquiredDeviceSessionUuid =
      this.callbacks.getAcquiredDeviceSessionUuid(args, sessionUuid) ?? boundRoute?.sessionUuid;
    if (
      !acquiredDeviceSessionUuid ||
      !this.callbacks.hasActiveDaemonSession(acquiredDeviceSessionUuid)
    ) {
      return undefined;
    }
    return this.callbacks.sessionScopedForwardRoute(
      socketSessionId,
      acquiredDeviceSessionUuid,
      scopedKey,
      toolSelectionProfileUuid,
    );
  }
  /**
   * The acquired device session the proxy carries alongside a profile-addressed
   * call (see `DaemonMcpProxy.withAcquiredDeviceRoute`). When the marker merely
   * echoes the explicit session it is the ordinary bound-session replay tag, not
   * a separate route.
   */
  getAcquiredDeviceSessionUuid(args: unknown, sessionUuid: string): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const carried = (args as Record<string, unknown>)[DAEMON_BOUND_SESSION_PARAM];
    return isNonBlankSessionUuid(carried) && carried !== sessionUuid ? carried : undefined;
  }
  selectorMcpForwardRoute(
    socketSessionId: string,
    args: unknown,
    scopedKey: string | undefined,
    profileUuid: string | undefined,
  ): McpForwardRoute {
    const key =
      scopedKey ??
      this.callbacks.getImplicitAutolockScopeKey(socketSessionId, args) ??
      `socket:${socketSessionId}`;
    return profileUuid
      ? this.callbacks.toolSelectionProfileScopedForwardRoute(socketSessionId, profileUuid, key)
      : this.callbacks.sharedMcpForwardRoute(key);
  }
  hasImplicitDeviceSelector(args: unknown): boolean {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return false;
    }
    const record = args as Record<string, unknown>;
    if (record.device) {
      return false;
    }
    const sessionUuid = this.callbacks.getSessionUuid(args);
    if (sessionUuid) {
      return false;
    }
    return (
      record.platform === "android" ||
      record.platform === "ios" ||
      typeof record.deviceId === "string"
    );
  }
  sharedMcpForwardRoute(key: string): McpForwardRoute {
    return { executionKey: key, clientKey: key };
  }
  acquisitionMcpForwardRoute(
    socketSessionId: string,
    toolName: string,
    toolSelectionProfileUuid: string | undefined,
  ): McpForwardRoute {
    const key = `socket:${socketSessionId}:acquisition:${toolName}`;
    return {
      executionKey: key,
      clientKey: toolSelectionProfileUuid
        ? `${key}:tool-selection:${toolSelectionProfileUuid}`
        : key,
      toolSelectionProfileUuid,
    };
  }
  sessionMcpClientKey(
    socketSessionId: string,
    sessionUuid: string,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): string {
    const profileSuffix = toolSelectionProfileUuid
      ? `:tool-selection:${toolSelectionProfileUuid}`
      : "";
    const releaseSuffix = releasedSessionUuid ? ":released-resource" : "";
    return `socket:${socketSessionId}:session:${sessionUuid}${profileSuffix}${releaseSuffix}`;
  }
  toolSelectionProfileMcpClientKey(
    socketSessionId: string,
    toolSelectionProfileUuid: string,
  ): string {
    return `socket:${socketSessionId}:tool-selection:${toolSelectionProfileUuid}`;
  }
  // Route an explicit-session request (tools/call or an IDE read) to its OWN
  // session-specific loopback client so it never repurposes the socket's bound
  // transport to a different session (issue #4610).
  sessionScopedForwardRoute(
    socketSessionId: string,
    sessionUuid: string,
    scopedKey: string | undefined,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): McpForwardRoute {
    return {
      executionKey: scopedKey ?? `session:${sessionUuid}`,
      clientKey: this.callbacks.sessionMcpClientKey(
        socketSessionId,
        sessionUuid,
        toolSelectionProfileUuid,
        releasedSessionUuid,
      ),
      sessionUuid,
      toolSelectionProfileUuid,
      releasedSessionUuid,
    };
  }
  toolSelectionProfileScopedForwardRoute(
    socketSessionId: string,
    toolSelectionProfileUuid: string,
    scopedKey: string | undefined,
  ): McpForwardRoute {
    return {
      executionKey: scopedKey ?? `tool-selection:${toolSelectionProfileUuid}`,
      clientKey: this.callbacks.toolSelectionProfileMcpClientKey(
        socketSessionId,
        toolSelectionProfileUuid,
      ),
      toolSelectionProfileUuid,
    };
  }
}
