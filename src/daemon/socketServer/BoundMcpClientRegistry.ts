import type { DaemonRequest } from "../types";
import { DAEMON_BOUND_SESSION_PARAM } from "../constants";
import {
  SET_TOOL_ENABLED_TOOL_NAME,
  toolSelectionProfileUuidFromResponse,
} from "../../features/toolSelection/toolSelectionControl";
import { isDeviceInventoryTool } from "../daemonMcpProxy";
import { isRetryableSessionRecoveryResult } from "./DeviceControlTransportRecovery";
import { isNonBlankSessionUuid, readSessionUuid, type McpForwardRoute } from "./McpForwardRouter";

/**
 * Per-socket-session record of the MCP client a connection's later, session-less calls follow
 * (#11815). Follow-up requests can omit their session UUID, so the route that last bound the
 * connection is reused to preserve the selected device session and tool-selection profile.
 */
export interface BoundMcpClient {
  clientKey: string;
  executionKey: string;
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  requiresLiveDaemonSession: boolean;
}

/** The server-owned lookups the registry consults; each is resolved on every call. */
export interface BoundMcpClientRegistryPort {
  /** Whether the args name a bound session that was already released. */
  isReleasedBoundSession(args: unknown, socketSessionId?: string): boolean;
  /** Whether another connected client owns the session. */
  isSessionOwnedByOtherConnection(sessionUuid: string, socketSessionId: string): boolean;
  /** Whether the session is live in the daemon (may throw a released-session error). */
  hasActiveSession(sessionUuid: string): boolean;
  /** Whether the daemon state is initialized, so session liveness can be consulted. */
  isDaemonStateInitialized(): boolean;
}

export class BoundMcpClientRegistry {
  /** Exposed so the owning server keeps one map identity; mutate through this class only. */
  readonly entries: Map<string, BoundMcpClient> = new Map();

  constructor(private readonly port: BoundMcpClientRegistryPort) {}

  record(
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
    const sessionUuid = readSessionUuid(request.params?.arguments);
    if (!sessionUuid) {
      this.recordGeneratedToolSelectionProfile(request, response, socketSessionId, route);
      return;
    }
    if (
      this.port.isReleasedBoundSession(request.params?.arguments, socketSessionId) &&
      isRetryableSessionRecoveryResult(response, sessionUuid)
    ) {
      // Recovery is still using the admitted identity; keep its transport binding.
      return;
    }
    // A profile reaffirm routed onto the acquired device session binds the
    // socket to THAT session's client (#7005); every other explicit-session
    // route carries the request's own session.
    this.recordSessionBound(
      socketSessionId,
      route,
      route.sessionUuid ?? sessionUuid,
      sessionWasActiveBeforeForward,
      request.params?.name,
      request.params?.arguments,
    );
  }

  /** The route the connection's bound client follows, or undefined once it no longer applies. */
  routeFor(socketSessionId: string, recoverableSessionUuid?: string): McpForwardRoute | undefined {
    const boundClient = this.entries.get(socketSessionId);
    if (!boundClient) {
      return undefined;
    }
    if (
      !boundClient.requiresLiveDaemonSession ||
      !this.port.isDaemonStateInitialized() ||
      (recoverableSessionUuid !== undefined && boundClient.sessionUuid === recoverableSessionUuid)
    ) {
      return routeOf(boundClient);
    }
    if (boundClient.sessionUuid && this.port.hasActiveSession(boundClient.sessionUuid)) {
      return routeOf(boundClient);
    }
    this.clear(socketSessionId);
    return undefined;
  }

  clear(socketSessionId: string): void {
    this.entries.delete(socketSessionId);
  }

  clearAll(): void {
    this.entries.clear();
  }

  clearForReleasedSession(sessionUuid: string): void {
    for (const [socketSessionId, boundClient] of this.entries) {
      if (boundClient.sessionUuid === sessionUuid) {
        this.clear(socketSessionId);
      }
    }
  }

  isClientKeyBound(key: string): boolean {
    for (const boundClient of this.entries.values()) {
      if (boundClient.clientKey === key) {
        return true;
      }
    }
    return false;
  }

  private recordSessionBound(
    socketSessionId: string,
    route: McpForwardRoute,
    sessionUuid: string,
    sessionWasActiveBeforeForward: boolean,
    toolName: unknown,
    args: unknown,
  ): void {
    if (this.port.isReleasedBoundSession(args, socketSessionId)) {
      this.clear(socketSessionId);
      return;
    }
    if (this.port.isSessionOwnedByOtherConnection(sessionUuid, socketSessionId)) {
      // Naming a session another connected client owns is not ownership (#11235, #11344): this
      // socket keeps its own route so its sessionless calls never follow it.
      return;
    }
    if (targetsOneCallOnly(args, sessionUuid)) {
      // The proxy named its own binding beside an explicit session: the call targeted that
      // session only, and the connection's default route does not move (#11347).
      return;
    }
    const sessionIsActiveAfterForward = this.port.hasActiveSession(sessionUuid);
    if (
      (sessionWasActiveBeforeForward || toolName === "executePlan") &&
      !sessionIsActiveAfterForward
    ) {
      this.clear(socketSessionId);
      return;
    }
    this.entries.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      sessionUuid,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid,
      requiresLiveDaemonSession: sessionWasActiveBeforeForward || sessionIsActiveAfterForward,
    });
  }

  private recordGeneratedToolSelectionProfile(
    request: DaemonRequest,
    response: unknown,
    socketSessionId: string,
    route: McpForwardRoute,
  ): boolean {
    const toolSelectionProfileUuid = generatedToolSelectionProfileUuid(request, response);
    if (!toolSelectionProfileUuid) {
      return false;
    }
    this.entries.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      toolSelectionProfileUuid,
      requiresLiveDaemonSession: false,
    });
    return true;
  }
}

function routeOf(boundClient: BoundMcpClient): McpForwardRoute {
  return {
    clientKey: boundClient.clientKey,
    executionKey: boundClient.executionKey,
    sessionUuid: boundClient.sessionUuid,
    toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
  };
}

/**
 * Whether the call carried the connection's bound session ({@link DAEMON_BOUND_SESSION_PARAM})
 * beside a different session it routed to. Only setActiveDevice or an acquisition moves a
 * connection's default (#11347); an explicit `sessionUuid` targets its own call.
 */
function targetsOneCallOnly(args: unknown, routedSessionUuid: string): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }
  const bound = (args as Record<string, unknown>)[DAEMON_BOUND_SESSION_PARAM];
  return isNonBlankSessionUuid(bound) && bound !== routedSessionUuid;
}

function generatedToolSelectionProfileUuid(
  request: DaemonRequest,
  response: unknown,
): string | undefined {
  if (request.params?.name !== SET_TOOL_ENABLED_TOOL_NAME) {
    return undefined;
  }
  return toolSelectionProfileUuidFromResponse(response);
}
