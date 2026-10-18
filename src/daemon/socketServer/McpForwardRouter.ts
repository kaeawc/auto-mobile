import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import type { DaemonRequest } from "../types";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../constants";
import { isHostInventoryCall } from "../socketRequestAdmission";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../features/toolSelection/toolSelectionControl";
import type { McpForwardChainWait } from "./keyedSerialQueue";

/**
 * Execution-key and loopback-client routing for MCP forwards (#11815). Decides which key a
 * `tools/call` or IDE read serializes on and which loopback client carries it, and drives the
 * re-route loop when a queued request's key moves. The server owns the session, device-pool and
 * bound-client state; this module reaches it only through {@link McpForwardRoutePort}.
 */

/**
 * How many times one forward may follow its route to a different execution key before it
 * fails. Each hop releases the previous key first, so this only bounds route churn; it is
 * not what prevents the crossed-route deadlock (issue #6388).
 */
export const MAX_MCP_FORWARD_REROUTES = 3;

/**
 * Suffix of a device's read lane (#10969). A watcher's read of a device another session holds
 * runs on the read path, which has no device side effects there, so it never queues behind the
 * holder's control calls on `device:<id>`. Reads still serialize among themselves.
 */
const MCP_FORWARD_READ_LANE_SUFFIX = ":read";
const MCP_FORWARD_DEVICE_KEY_PREFIX = "device:";

const DEVICE_ACQUISITION_TOOL_NAMES = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
]);

export interface McpForwardRoute {
  /** Serializes work that targets the same physical device or session. */
  executionKey: string;
  /** Owns the loopback MCP transport and its session-local tool-selection profile. */
  clientKey: string;
  /** Replayed when this transport needs to establish a fresh MCP session. */
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  releasedSessionUuid?: string;
}

/** One keyed attempt either ran the forward or found its route moved to another key. */
type McpForwardAttempt<T> =
  | { kind: "done"; value: T }
  | { kind: "reroute"; route: McpForwardRoute };

interface ProfileReaffirmForwardRouteOptions {
  args: unknown;
  socketSessionId: string;
  toolName: unknown;
  sessionUuid: string;
  toolSelectionProfileUuid: string | undefined;
  scopedKey: string | undefined;
  boundRoute: McpForwardRoute | undefined;
}

export const isNonBlankSessionUuid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** The explicit `sessionUuid` an argument set names, if any. */
export function readSessionUuid(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const sessionUuid = (args as Record<string, unknown>).sessionUuid;
  return isNonBlankSessionUuid(sessionUuid) ? sessionUuid : undefined;
}

/** The tool-selection profile an argument set names, if any. */
export function readToolSelectionProfileUuid(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
  return isNonBlankSessionUuid(value) ? value : undefined;
}

export function sharedMcpForwardRoute(key: string): McpForwardRoute {
  return { executionKey: key, clientKey: key };
}

export function acquisitionMcpForwardRoute(
  socketSessionId: string,
  toolName: string,
  toolSelectionProfileUuid: string | undefined,
): McpForwardRoute {
  const key = `socket:${socketSessionId}:acquisition:${toolName}`;
  return {
    executionKey: key,
    clientKey: toolSelectionProfileUuid ? `${key}:tool-selection:${toolSelectionProfileUuid}` : key,
    toolSelectionProfileUuid,
  };
}

function sessionMcpClientKey(
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

function toolSelectionProfileMcpClientKey(
  socketSessionId: string,
  toolSelectionProfileUuid: string,
): string {
  return `socket:${socketSessionId}:tool-selection:${toolSelectionProfileUuid}`;
}

// Route an explicit-session request (tools/call or an IDE read) to its OWN
// session-specific loopback client so it never repurposes the socket's bound
// transport to a different session (issue #4610).
export function sessionScopedForwardRoute(
  socketSessionId: string,
  sessionUuid: string,
  scopedKey: string | undefined,
  toolSelectionProfileUuid?: string,
  releasedSessionUuid?: string,
): McpForwardRoute {
  return {
    executionKey: scopedKey ?? `session:${sessionUuid}`,
    clientKey: sessionMcpClientKey(
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

export function toolSelectionProfileScopedForwardRoute(
  socketSessionId: string,
  toolSelectionProfileUuid: string,
  scopedKey: string | undefined,
): McpForwardRoute {
  return {
    executionKey: scopedKey ?? `tool-selection:${toolSelectionProfileUuid}`,
    clientKey: toolSelectionProfileMcpClientKey(socketSessionId, toolSelectionProfileUuid),
    toolSelectionProfileUuid,
  };
}

function hostInventoryOrBoundRoute(
  boundRoute: McpForwardRoute,
  toolName: unknown,
  args: unknown,
): McpForwardRoute {
  return isHostInventoryCall(toolName, args)
    ? { ...boundRoute, executionKey: "host:inventory" }
    : boundRoute;
}

function isUnboundDeviceAcquisitionTool(
  toolName: unknown,
  sessionUuid: string | undefined,
): toolName is string {
  return (
    typeof toolName === "string" && DEVICE_ACQUISITION_TOOL_NAMES.has(toolName) && !sessionUuid
  );
}

/**
 * The acquired device session the proxy carries alongside a profile-addressed
 * call (see `DaemonMcpProxy.withAcquiredDeviceRoute`). When the marker merely
 * echoes the explicit session it is the ordinary bound-session replay tag, not
 * a separate route.
 */
function getAcquiredDeviceSessionUuid(args: unknown, sessionUuid: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const carried = (args as Record<string, unknown>)[DAEMON_BOUND_SESSION_PARAM];
  return isNonBlankSessionUuid(carried) && carried !== sessionUuid ? carried : undefined;
}

function hasImplicitDeviceSelector(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }
  const record = args as Record<string, unknown>;
  if (record.device) {
    return false;
  }
  if (readSessionUuid(args)) {
    return false;
  }
  return (
    record.platform === "android" ||
    record.platform === "ios" ||
    typeof record.deviceId === "string"
  );
}

/** The daemon state the router reads. Every method is a lookup; none mutates. */
export interface McpForwardRoutePort {
  /**
   * Runs `forward` synchronously when the args' session is live (healthy routing stays
   * synchronous up to the existing I/O); otherwise rejects with the released-session error or
   * runs it after the restart-recovery admission.
   */
  withAdmittedBoundSession<T>(
    args: unknown,
    forward: (recoverableSessionUuid?: string) => T,
    socketSessionId?: string,
  ): T | Promise<T>;
  /** The route this socket is bound to, if its bound session is still usable. */
  boundClientRoute(
    socketSessionId: string,
    recoverableSessionUuid?: string,
  ): McpForwardRoute | undefined;
  /** The `device:`/`session:`/`mcp-session:` key the args serialize on. */
  requestArgumentScopeKey(args: unknown): string | undefined;
  implicitAutolockScopeKey(mcpSessionId: string, args: unknown): string | undefined;
  implicitAutolockSession(mcpSessionId: string, args: unknown): string | undefined;
  resolveDeviceLabelSession(baseSessionUuid: string, deviceLabel: unknown): string;
  hasActiveSession(sessionUuid: string): boolean;
  /** The session holding a device: its live owner, or its autolock holder. */
  deviceHolderSession(deviceId: string): string | undefined;
  /** The session a tool-selection profile resolves to for ownership comparison. */
  toolSelectionBaseSession(sessionUuid: string): string | undefined;
  ownedDeviceSessionForMcpSession(mcpSessionId: string, deviceId: string): string | undefined;
  /** Whether a tools/call argument set is a device read (`deviceReadOnly`). */
  isDeviceReadCall(toolName: string, args: unknown): boolean;
  /** The args a non-tools/call request is admitted against. */
  admissionArgs(request: DaemonRequest): unknown;
  /** Runs `fn` as the sole forward holding `executionKey`. */
  runKeyed<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T>;
}

export class McpForwardRouter {
  constructor(private readonly port: McpForwardRoutePort) {}

  /**
   * Run `fn` holding the execution key of the request's current route. When the route moves
   * to another key while the request waits, the held key is RELEASED before the new one is
   * acquired: holding one key while waiting on another deadlocks two requests whose routes
   * cross, or one request whose route flips back to a key it still holds (issue #6388).
   */
  async runForCurrentRoute<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    const visitedKeys = [initialRoute.executionKey];
    let route = initialRoute;
    for (;;) {
      const admittedRoute = route;
      const attempt = await this.port.runKeyed(
        admittedRoute.executionKey,
        () => this.runAttempt(admittedRoute, request, socketSessionId, fn),
        undefined,
        chainWait,
      );
      if (attempt.kind === "done") {
        return attempt.value;
      }
      route = attempt.route;
      visitedKeys.push(route.executionKey);
      if (visitedKeys.length > MAX_MCP_FORWARD_REROUTES + 1) {
        throw new ActionableError(
          `MCP request ${request.id} was re-routed more than ${MAX_MCP_FORWARD_REROUTES} times while waiting to run ` +
            `(execution keys: ${visitedKeys.join(" -> ")}). The target device or session kept changing; retry once it is stable.`,
        );
      }
      logger.debug(
        `[McpForward] rekey requestId=${request.id} initialExecutionKey=${admittedRoute.executionKey} currentExecutionKey=${route.executionKey}`,
      );
    }
  }

  private async runAttempt<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
  ): Promise<McpForwardAttempt<T>> {
    const routeOrPending = this.resolve(request, socketSessionId);
    const currentRoute = routeOrPending instanceof Promise ? await routeOrPending : routeOrPending;
    if (currentRoute.executionKey !== initialRoute.executionKey) {
      return { kind: "reroute", route: currentRoute };
    }
    // The execution target is unchanged, so this request keeps the client and
    // session it was admitted with. Re-resolving may replace a session-specific
    // clientKey with the shared unbound client (e.g. a mid-flight disconnect
    // cleared the binding before this recompute) under the same executionKey;
    // that would run the admitted tool with no tool-selection profile. Only the
    // execution target may be re-resolved, never the admitted client/session
    // (issue #4610).
    //
    // Exception: when the admitted route was seeded for a specific daemon
    // session and that session was RELEASED while this request waited in the
    // queue, invoking the stale session-scoped client would re-seed the released
    // UUID and RESURRECT the session (getOrCreateSession recreates it and
    // reacquires a device the caller never asked for). A mid-flight socket
    // disconnect, by contrast, leaves the daemon session live — so the daemon
    // session still being active is exactly what distinguishes a disconnect
    // (keep the admitted client, preserving the tool-selection profile above) from a
    // real release (re-resolve to the current, unseeded route). Only re-resolve
    // when the recompute actually points somewhere else (issue #4610).
    if (
      initialRoute.sessionUuid !== undefined &&
      currentRoute.clientKey !== initialRoute.clientKey &&
      !this.port.hasActiveSession(initialRoute.sessionUuid)
    ) {
      logger.debug(
        `[McpForward] released-session re-resolve requestId=${request.id} releasedSession=${initialRoute.sessionUuid} clientKey=${initialRoute.clientKey} -> ${currentRoute.clientKey}`,
      );
      return {
        kind: "done",
        value: await fn(currentRoute),
      };
    }
    return {
      kind: "done",
      value: await fn(initialRoute),
    };
  }

  /** The route for any forwarded request. Synchronous unless its session was released. */
  resolve(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute | Promise<McpForwardRoute> {
    if (request.method === "tools/call") {
      const route = this.resolveToolsCall(
        request.params?.arguments,
        socketSessionId,
        request.params?.name,
      );
      const toLane = (resolved: McpForwardRoute) =>
        this.withDeviceReadLane(resolved, request, socketSessionId);
      return route instanceof Promise ? route.then(toLane) : toLane(route);
    }

    return this.port.withAdmittedBoundSession(
      this.port.admissionArgs(request),
      (recoverableSessionUuid) =>
        this.resolveAdmitted(request, socketSessionId, recoverableSessionUuid),
    );
  }

  /**
   * Move a watcher's read of a held device onto the device's read lane (#10969). Control calls,
   * the holder's own calls (by session, device label, autolock or the acquiring connection) and
   * reads of a free device, which may run readiness, stay on the control lane. Re-resolved before
   * the forward runs, so an acquisition or release while queued moves the call between lanes.
   */
  private withDeviceReadLane(
    route: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute {
    const toolName = request.params?.name;
    const args = request.params?.arguments;
    if (
      !route.executionKey.startsWith(MCP_FORWARD_DEVICE_KEY_PREFIX) ||
      typeof toolName !== "string" ||
      !this.isDeviceReadToolCall(toolName, args)
    ) {
      return route;
    }
    const deviceId = route.executionKey.slice(MCP_FORWARD_DEVICE_KEY_PREFIX.length);
    const holder = this.port.deviceHolderSession(deviceId);
    if (!holder) {
      return route;
    }
    const base = (sessionUuid: string | undefined) =>
      sessionUuid ? this.port.toolSelectionBaseSession(sessionUuid) : undefined;
    const holderBase = base(holder);
    const callerSessions = [
      route.sessionUuid,
      readSessionUuid(args),
      this.getDeviceLabelSession(args),
      this.port.implicitAutolockSession(socketSessionId, args),
      this.port.ownedDeviceSessionForMcpSession(socketSessionId, deviceId),
    ];
    if (callerSessions.some((sessionUuid) => base(sessionUuid) === holderBase)) {
      return route;
    }
    return { ...route, executionKey: `${route.executionKey}${MCP_FORWARD_READ_LANE_SUFFIX}` };
  }

  private getDeviceLabelSession(args: unknown): string | undefined {
    const baseSessionUuid = readSessionUuid(args);
    const record = args as Record<string, unknown> | undefined;
    return baseSessionUuid && typeof record?.device === "string" && record.device.length > 0
      ? this.port.resolveDeviceLabelSession(baseSessionUuid, record.device)
      : undefined;
  }

  private isDeviceReadToolCall(toolName: string, args: unknown): boolean {
    try {
      return this.port.isDeviceReadCall(toolName, args);
    } catch (error) {
      // An argument set the classifier cannot read is not proven a read: keep the control lane.
      logger.debug(`[McpForward] read classification failed for ${toolName}: ${error}`);
      return false;
    }
  }

  private resolveAdmitted(
    request: DaemonRequest,
    socketSessionId: string,
    recoverableSessionUuid?: string,
  ): McpForwardRoute {
    const boundRoute = this.port.boundClientRoute(socketSessionId, recoverableSessionUuid);
    if (
      request.method === "tools/list" ||
      request.method === "resources/list" ||
      request.method === "resources/list-templates"
    ) {
      return this.getDiscoveryForwardRoute(request, socketSessionId, boundRoute);
    }

    if (request.method === "ide/getNavigationGraph") {
      return this.getNavigationGraphForwardRoute(request, socketSessionId, boundRoute);
    }

    if (request.method === "resources/read") {
      return this.getResourceReadForwardRoute(request, socketSessionId);
    }

    return sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getDiscoveryForwardRoute(
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
      const listSessionUuid = readSessionUuid(request.params);
      const toolSelectionProfileUuid = readToolSelectionProfileUuid(request.params);
      if (listSessionUuid) {
        return sessionScopedForwardRoute(
          socketSessionId,
          listSessionUuid,
          undefined,
          toolSelectionProfileUuid,
        );
      }
      if (toolSelectionProfileUuid) {
        return toolSelectionProfileScopedForwardRoute(
          socketSessionId,
          toolSelectionProfileUuid,
          undefined,
        );
      }
      return boundRoute ?? sharedMcpForwardRoute(`method:${request.method}`);
    }

    const sessionUuid = readSessionUuid(request.params);
    const toolSelectionProfileUuid = readToolSelectionProfileUuid(request.params);
    if (sessionUuid) {
      return sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        toolSelectionProfileUuid,
      );
    }
    if (toolSelectionProfileUuid) {
      return toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        undefined,
      );
    }
    return boundRoute ?? sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getNavigationGraphForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    const sessionUuid = readSessionUuid(request.params);
    const executionKey = this.port.requestArgumentScopeKey(request.params);
    if (sessionUuid) {
      // An explicit read session routes to its OWN session-specific client so a
      // cross-session IDE read never repurposes the socket's bound transport. If
      // it reused the bound client, the loopback SessionToolBinding would be
      // rebound to this UUID while recordBoundMcpClientKey early-returns for
      // non-tools/call methods, leaving the daemon route labeled the bound
      // session and the transport filtering by a different profile (issue #4610).
      return sessionScopedForwardRoute(socketSessionId, sessionUuid, executionKey);
    }
    if (executionKey) {
      return boundRoute ? { ...boundRoute, executionKey } : sharedMcpForwardRoute(executionKey);
    }
    return boundRoute ?? sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getResourceReadForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute {
    const sessionUuid = readSessionUuid(request.params);
    if (sessionUuid) {
      const releasedSessionUuid =
        request.params?.[DAEMON_RELEASED_SESSION_PARAM] === sessionUuid ? sessionUuid : undefined;
      return sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        undefined,
        releasedSessionUuid === sessionUuid ? releasedSessionUuid : undefined,
      );
    }
    const uri = request.params?.uri;
    return sharedMcpForwardRoute(typeof uri === "string" ? `resource:${uri}` : "resource:unknown");
  }

  resolveToolsCall(
    args: unknown,
    socketSessionId: string,
    toolName?: unknown,
  ): McpForwardRoute | Promise<McpForwardRoute> {
    return this.port.withAdmittedBoundSession(
      args,
      (recoverableSessionUuid) =>
        this.resolveAdmittedToolsCall(args, socketSessionId, toolName, recoverableSessionUuid),
      socketSessionId,
    );
  }

  private resolveAdmittedToolsCall(
    args: unknown,
    socketSessionId: string,
    toolName?: unknown,
    recoverableSessionUuid?: string,
  ): McpForwardRoute {
    const scopedKey = this.port.requestArgumentScopeKey(args);
    const boundRoute = this.port.boundClientRoute(socketSessionId, recoverableSessionUuid);
    const sessionUuid = readSessionUuid(args);
    const toolSelectionProfileUuid =
      readToolSelectionProfileUuid(args) ?? boundRoute?.toolSelectionProfileUuid;
    if (isUnboundDeviceAcquisitionTool(toolName, sessionUuid)) {
      // Acquisition can mint a second device session on an already-bound
      // daemon socket. Keep each platform/tool on its own loopback client without
      // a device-session binding;
      // reusing the first acquired session's bound transport makes the second
      // acquisition and later selector routing disagree about ownership.
      return acquisitionMcpForwardRoute(socketSessionId, toolName, toolSelectionProfileUuid);
    }
    if (hasImplicitDeviceSelector(args)) {
      return this.selectorMcpForwardRoute(
        socketSessionId,
        args,
        scopedKey,
        toolSelectionProfileUuid,
      );
    }

    if (sessionUuid) {
      return (
        this.profileReaffirmForwardRoute({
          args,
          socketSessionId,
          toolName,
          sessionUuid,
          toolSelectionProfileUuid,
          scopedKey,
          boundRoute,
        }) ??
        sessionScopedForwardRoute(socketSessionId, sessionUuid, scopedKey, toolSelectionProfileUuid)
      );
    }
    if (toolSelectionProfileUuid) {
      return toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        scopedKey,
      );
    }

    if (scopedKey) {
      if (boundRoute) {
        return { ...boundRoute, executionKey: scopedKey };
      }
      return sharedMcpForwardRoute(scopedKey);
    }

    if (boundRoute) {
      return hostInventoryOrBoundRoute(boundRoute, toolName, args);
    }

    const implicitAutolockKey = this.port.implicitAutolockScopeKey(socketSessionId, args);
    if (implicitAutolockKey) {
      return sharedMcpForwardRoute(implicitAutolockKey);
    }

    // The daemon injects __mcpSessionId before forwarding. Use the socket session as the
    // pre-forward key so separate daemon clients can autolock and run independently.
    return sharedMcpForwardRoute(`socket:${socketSessionId}`);
  }

  /**
   * A `setToolEnabled` reaffirming the connection's own profile names no device
   * route of its own. Seeding a loopback with the profile as its DEVICE binding
   * made the update's label readback enumerate the profile (nothing) instead of
   * the device session this socket acquired, so carry that acquired route
   * through: the one the proxy sent alongside, else the one this socket is
   * already bound to (#7005). Undefined for every other explicit-session call.
   */
  private profileReaffirmForwardRoute(
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
      getAcquiredDeviceSessionUuid(args, sessionUuid) ?? boundRoute?.sessionUuid;
    if (!acquiredDeviceSessionUuid || !this.port.hasActiveSession(acquiredDeviceSessionUuid)) {
      return undefined;
    }
    return sessionScopedForwardRoute(
      socketSessionId,
      acquiredDeviceSessionUuid,
      scopedKey,
      toolSelectionProfileUuid,
    );
  }

  private selectorMcpForwardRoute(
    socketSessionId: string,
    args: unknown,
    scopedKey: string | undefined,
    profileUuid: string | undefined,
  ): McpForwardRoute {
    const key =
      scopedKey ??
      this.port.implicitAutolockScopeKey(socketSessionId, args) ??
      `socket:${socketSessionId}`;
    return profileUuid
      ? toolSelectionProfileScopedForwardRoute(socketSessionId, profileUuid, key)
      : sharedMcpForwardRoute(key);
  }
}
