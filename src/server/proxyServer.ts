import { errorMessage } from "../utils/describeUnknownError";
import { DaemonShuttingDownError } from "../daemon/DaemonShuttingDownError";
import type {
  CallToolResult,
  ListToolsResult,
  McpServer,
  ServerCapabilities,
  ServerContext,
} from "@modelcontextprotocol/server";
import { createSdkMcpServer } from "./sdkMcpServer";
import { McpError } from "../daemon/mcpError";
import { logger } from "../utils/logger";
import {
  DaemonBoundSessionExpiredError,
  DaemonSessionStalledError,
  DaemonConnectionSessionReleasedError,
  DaemonAmbiguousSessionSelectorError,
  DaemonMcpProxy,
  DaemonRestartDeferredError,
  type DaemonMcpProxyConfig,
} from "../daemon/daemonMcpProxy";
import { daemonRestartDeferredPayload } from "../daemon/daemonRestartAdmission";
import { McpOverloadError, McpTimeoutError } from "../daemon/wire/McpTimeoutError";
import { DaemonDisconnectError } from "../daemon/DaemonDisconnectError";
import { ActionableError, toActionableError } from "../models";
import { daemonShuttingDownMcpOutcome } from "../daemon/daemonShutdownOutcome";
import { getMcpServerVersion } from "../utils/mcpVersion";
import {
  stripToolResultStructuredContent,
  structuredContentOmissionReason,
} from "./stripToolResultStructuredContent";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "../daemon/deviceControlTransportFailure";
import {
  DEVICE_SESSION_RECOVERY_PROMPT,
  noActiveDeviceSessionPayload,
  readTerminalSessionRefusal,
  sessionOwnershipLostPayload,
} from "../daemon/deviceSessionResult";
import { getStartupToolDefaults } from "../features/toolSelection/SessionToolSelectionService";
import { ToolRegistry } from "./toolRegistry";
import {
  installToolCallDispatcher,
  type McpToolCallExtra,
  type McpToolCallResult,
  type ToolCall,
} from "./toolCallDispatch";
import { shapeToolCallError } from "../daemon/shapeToolCallError";
import type { AmbiguousDeviceElicitationOptions } from "./ambiguousDeviceElicitation";
import {
  DAEMON_STALLED_CODE,
  livenessHandoverPayload,
  type LivenessHandover,
} from "../daemon/proxyLivenessRecovery";
import { SESSION_EXPERIMENTAL_CAPABILITY } from "../devices/sessionConfig";
import type { SessionBrokerResult } from "../devices/sessionBrokerResult";
import { idleReleaseField } from "../daemon/releaseReasons";
import { z } from "zod/v4";
import { advertiseTasksOnDeclaringInitialize } from "./tasks/installTasksProtocol";
import {
  type CreateTaskResult,
  isCreateTaskResult,
  missingTasksCapabilityError,
  requestDeclaresTasks,
} from "../daemon/tasks/mcpTasksExtension";
import { toRelayedProtocolError, isRelayedJsonRpcError } from "../daemon/tasks/taskRelay";
import { ENV, readEnvRaw } from "../config/env";

function acceptanceDiscoveryConfiguration():
  | { order: "forward" | "reverse"; capability: string }
  | undefined {
  if (readEnvRaw(ENV.ACCEPTANCE_LIVE) !== "1") {
    return undefined;
  }
  const order = readEnvRaw(ENV.ACCEPTANCE_DISCOVERY_ORDER);
  const capability = readEnvRaw(ENV.ACCEPTANCE_DISCOVERY_CAPABILITY);
  return (order === "forward" || order === "reverse") && capability
    ? { order, capability }
    : undefined;
}

/**
 * Options for creating a proxy MCP server
 */
export interface ProxyMcpServerOptions {
  /** Configuration for the daemon proxy */
  proxyConfig?: DaemonMcpProxyConfig;
  /** An already-created proxy (broker bindings acquire on it before the server exists). */
  proxy?: DaemonMcpProxy;
  /** Flat durable broker result exposed only through initialize capabilities. */
  session?: SessionBrokerResult;
  /** Session context for tracking */
  sessionContext?: { sessionId?: string };
  /** Overrides the timer and bound of the device question asked of an eliciting client (#13945). */
  ambiguousDeviceElicitation?: AmbiguousDeviceElicitationOptions;
}

export function brokerSessionEndedPayload(
  session: SessionBrokerResult,
  sessionUuid: string | undefined,
  reason: string,
) {
  if (
    session.outcome !== "ready" ||
    (sessionUuid !== undefined && sessionUuid !== session.sessionUuid)
  ) {
    return undefined;
  }
  return {
    success: false,
    error: {
      code: "broker_session_ended",
      message:
        `Broker session ${session.sessionUuid} for request ${session.requestId} ended ` +
        `(${reason}). Device tools cannot acquire a generic replacement on this connection; ` +
        "the launcher must start a new broker request.",
      requestId: session.requestId,
      sessionUuid: session.sessionUuid,
      reason,
      ...idleReleaseField(reason),
      retryable: false,
      nextAction: "relaunch_session_request",
    },
  };
}

function brokerEndedRelayedResult<T>(
  result: T,
  session: SessionBrokerResult | undefined,
): T | CallToolResult {
  const refusal = readTerminalSessionRefusal(result);
  const payload =
    session &&
    refusal &&
    brokerSessionEndedPayload(session, refusal.sessionUuid, refusal.reason ?? "unknown");
  return payload
    ? { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true }
    : result;
}

function brokerSessionEndedToolResult(
  session: SessionBrokerResult,
  error: DaemonBoundSessionExpiredError,
): CallToolResult | undefined {
  const payload = brokerSessionEndedPayload(session, error.sessionUuid, error.reason);
  return payload
    ? { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true }
    : undefined;
}

function localBrokerSessionEndedResult(
  error: unknown,
  session: SessionBrokerResult | undefined,
): CallToolResult | undefined {
  if (error instanceof DaemonSessionStalledError && error.handover.code === DAEMON_STALLED_CODE) {
    // StallProbe can resume this session; preserve the retryable handover instead of relaunching.
    return undefined;
  }
  return error instanceof DaemonBoundSessionExpiredError && session
    ? brokerSessionEndedToolResult(session, error)
    : undefined;
}

function brokerSessionHasEnded(
  proxy: DaemonMcpProxy,
  session: SessionBrokerResult | undefined,
): boolean {
  return (
    session !== undefined && proxy.getTerminalSessionRelease()?.sessionUuid === session.sessionUuid
  );
}

/**
 * The logging notifications for one liveness handover. A managed connection reports each binding
 * session a `proxy_stalled` handover lost as `managed_execution_ended`; whatever is left keeps
 * the handover payload. Managed `daemon_stalled` sessions receive automatic reclaim advice;
 * non-binding sessions and generic connections keep the generic handover.
 */
export function livenessHandoverNotificationPayloads(handover: LivenessHandover): unknown[] {
  return handover.sessions.length > 0 ? [livenessHandoverPayload(handover)] : [];
}

function boundSessionOwnershipLostPayload(error: DaemonBoundSessionExpiredError) {
  if (error instanceof DaemonSessionStalledError) {
    // `daemon_stalled` / `proxy_stalled` (#10053): the harness is told which sessions and devices
    // are affected and what to do, rather than the generic "acquire a replacement session".
    return error.toPayload();
  }
  return sessionOwnershipLostPayload({
    message:
      `Session ownership lost for ${error.sessionUuid}: ${error.reason}. ` +
      DEVICE_SESSION_RECOVERY_PROMPT,
    sessionUuid: error.sessionUuid,
    reason: error.reason,
    release: error.release,
  });
}

function sessionOwnershipLostMessage(error: DaemonBoundSessionExpiredError): string {
  return JSON.stringify(boundSessionOwnershipLostPayload(error));
}

function sessionOwnershipLostResult(error: DaemonBoundSessionExpiredError): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: sessionOwnershipLostMessage(error),
      },
    ],
    isError: true,
  };
}

function sessionOwnershipLostError(error: DaemonBoundSessionExpiredError): McpError {
  const payload = boundSessionOwnershipLostPayload(error);
  return new McpError(-32603, sessionOwnershipLostMessage(error), payload);
}

function noActiveDeviceSessionMessage(error: DaemonConnectionSessionReleasedError): string {
  return JSON.stringify(noActiveDeviceSessionPayload(error));
}

export function noActiveDeviceSessionResult(
  error: DaemonConnectionSessionReleasedError,
): CallToolResult {
  return {
    content: [{ type: "text", text: noActiveDeviceSessionMessage(error) }],
    isError: true,
  };
}

export function ambiguousSessionSelectorResult(
  error: DaemonAmbiguousSessionSelectorError,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "ambiguous_session_selector",
            message: error.message,
            platform: error.platform,
            candidates: error.candidates,
            retryable: false,
          },
        }),
      },
    ],
    isError: true,
  };
}

function noActiveDeviceSessionError(error: DaemonConnectionSessionReleasedError): McpError {
  return new McpError(
    -32603,
    noActiveDeviceSessionMessage(error),
    noActiveDeviceSessionPayload(error),
  );
}

function daemonShuttingDownResult(hasOutputSchema: boolean, requestMayHaveDispatched = false) {
  const shutdown = daemonShuttingDownMcpOutcome(requestMayHaveDispatched);
  const result = {
    content: [{ type: "text" as const, text: JSON.stringify(shutdown) }],
    structuredContent: shutdown,
    isError: true,
  };
  // The daemon's live advertised schema already accounts for its own
  // tool-results-no-structured-content setting. Do not consult this frontend
  // process's ServerConfig, which can be stale after a runtime flag change.
  return stripToolResultStructuredContent(
    result,
    structuredContentOmissionReason(hasOutputSchema, false),
  );
}

/**
 * A `resources/read` the daemon could not serve because it is shutting down or its restart was
 * deferred. Reads are never refused, but these may fail; the error says so typed and retryable
 * (the envelope of the matching tool result) rather than passing for a missing resource.
 */
function retryableResourceReadError(error: unknown): McpError | undefined {
  if (error instanceof DaemonShuttingDownError) {
    const payload = daemonShuttingDownMcpOutcome(error.requestMayHaveDispatched);
    return new McpError(-32603, JSON.stringify(payload), payload);
  }
  if (error instanceof DaemonRestartDeferredError) {
    const payload = daemonRestartDeferredPayload(error);
    return new McpError(-32603, JSON.stringify(payload), payload);
  }
  return undefined;
}

export function daemonRestartDeferredResult(
  error: DaemonRestartDeferredError,
): CallToolResult & { structuredContent: Record<string, unknown> } {
  const payload = daemonRestartDeferredPayload(error);
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function mcpOverloadPayload(error: McpOverloadError) {
  return {
    error: {
      code: error.failure.code,
      message: error.message,
      retryable: error.failure.retryable,
      retryAfterMs: error.failure.retryAfterMs,
      queueWaitMs: error.failure.queueWaitMs,
      remainingTimeoutMs: error.failure.remainingTimeoutMs,
    },
  };
}

export function mcpOverloadResult(
  error: McpOverloadError,
): CallToolResult & { structuredContent: Record<string, unknown> };
export function mcpOverloadResult(
  error: McpOverloadError,
  hasOutputSchema: boolean,
): CallToolResult;
export function mcpOverloadResult(error: McpOverloadError, hasOutputSchema = true): CallToolResult {
  const payload = mcpOverloadPayload(error);
  const result = {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
  return stripToolResultStructuredContent(
    result,
    // This must mirror daemonShuttingDownResult: the live daemon's advertised
    // schema accounts for its runtime result-shaping flag.
    structuredContentOmissionReason(hasOutputSchema, false),
  );
}

export function mcpOverloadError(error: McpOverloadError): McpError {
  const payload = mcpOverloadPayload(error);
  return new McpError(-32603, JSON.stringify(payload), payload);
}

/**
 * Safely preserve the request-level disconnect, timeout, or abort context when a
 * daemon socket disappears. Arbitrary nested error messages can contain daemon
 * internals, so only expose the known request-control causes.
 */
const JSONRPC_INVALID_PARAMS = -32602;

/**
 * The daemon's invalid-params verdict (a malformed resource URI, #10117), kept as
 * -32602 instead of being re-wrapped as an internal error. The daemon message
 * already carries the SDK's `MCP error -32602: ` prefix, so it is stripped
 * before McpError adds it again.
 */
function forwardedInvalidParamsError(error: unknown): McpError | undefined {
  if (
    error === null ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== JSONRPC_INVALID_PARAMS
  ) {
    return undefined;
  }
  const message = errorMessage(error).replace(`MCP error ${JSONRPC_INVALID_PARAMS}: `, "");
  return new McpError(JSONRPC_INVALID_PARAMS, message);
}

function safeForwardedRequestErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof DaemonDisconnectError) {
    return `${message} (daemon connection closed before the response arrived while handling ${cause.toolName})`;
  }
  if (cause instanceof McpTimeoutError) {
    return `${message} (request timed out after ${cause.timeoutMs}ms while handling ${cause.toolName})`;
  }
  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
    return `${message} (request ${cause.name === "TimeoutError" ? "timed out" : "was aborted"})`;
  }
  return message;
}

export function deviceControlTransportFailureResult(
  error: DeviceControlTransportError,
): CallToolResult {
  const failure = sanitizeDeviceControlTransportFailure(error.failure);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            message: error.message,
            ...failure,
          },
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Tell the harness now, as an MCP logging notification, that automatic liveness recovery was
 * exhausted (#10053). A harness idle between tool calls would otherwise learn only on its next
 * call. The payload is the same structured error that call returns.
 */
async function forwardLivenessHandover(
  server: McpServer,
  handover: LivenessHandover,
): Promise<void> {
  try {
    // sendLoggingMessage honours a level the client set with logging/setLevel; a client that
    // asked for fewer messages than `error` is not sent the notification and still learns from
    // the structured error on its next tool call.
    for (const data of livenessHandoverNotificationPayloads(handover)) {
      await server.server.sendLoggingMessage({
        level: "error",
        logger: "auto-mobile.liveness",
        data,
      });
    }
  } catch (error) {
    // Best-effort: the next tool call for an affected session returns the same error.
    logger.warn("[ProxyServer] Failed to forward liveness handover notification", error);
  }
}

async function forwardResourceUpdate(server: McpServer, uri: string): Promise<void> {
  try {
    await server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  } catch (error) {
    logger.warn("[ProxyServer] Failed to forward resource update notification", error);
  }
}

// Maps a caught daemon error to its structured tool result. Extracted so the
// tools/call handler stays under the complexity ceiling as branches accrue.
function resolveCallToolErrorResult(
  error: unknown,
  name: string,
  hasOutputSchema: boolean,
): CallToolResult {
  if (error instanceof DaemonBoundSessionExpiredError) {
    logger.warn(`[ProxyServer] Session ownership lost for ${error.sessionUuid}: ${error.reason}`);
    return sessionOwnershipLostResult(error);
  }
  if (error instanceof DaemonConnectionSessionReleasedError) {
    logger.warn(`[ProxyServer] No active device session (released: ${error.reason})`);
    return noActiveDeviceSessionResult(error);
  }
  if (error instanceof DaemonAmbiguousSessionSelectorError) {
    logger.warn(`[ProxyServer] Ambiguous session selector: ${error.message}`);
    return ambiguousSessionSelectorResult(error);
  }
  if (error instanceof DaemonShuttingDownError) {
    return daemonShuttingDownResult(hasOutputSchema, error.requestMayHaveDispatched);
  }
  if (error instanceof DaemonRestartDeferredError) {
    return daemonRestartDeferredResult(error);
  }
  if (error instanceof McpOverloadError) {
    return mcpOverloadResult(error, hasOutputSchema);
  }
  if (error instanceof DeviceControlTransportError) {
    logger.warn(
      `[ProxyServer] Device-control transport failure for ${error.failure.toolName} during ${error.failure.phase}`,
    );
    return deviceControlTransportFailureResult(error);
  }
  return shapeToolCallError(error, { toolName: name, source: "ProxyServer" });
}

/** Broker session outcome advertised during initialize. */
function acquisitionCapabilities(session: SessionBrokerResult | undefined) {
  const experimental = {
    ...(session ? { [SESSION_EXPERIMENTAL_CAPABILITY]: { ...session } } : {}),
  };
  return Object.keys(experimental).length > 0 ? { experimental } : {};
}

function proxyServerCapabilities(options: ProxyMcpServerOptions) {
  return {
    // This proxy forwards both daemon invalidations and post-connect reconciliation.
    resources: { subscribe: true, listChanged: true },
    tools: { listChanged: true },
    logging: {},
    prompts: {},
    ...acquisitionCapabilities(options.session),
  };
}

export function unavailableBrokerSessionToolResult(result: SessionBrokerResult, name: string) {
  const payload = {
    success: false,
    error: {
      code: "session_unavailable",
      message:
        `Tool ${name} is unavailable because session request ${result.requestId} is ` +
        `${result.outcome}. Use the exact bound sessionUuid only after initialize reports ready.`,
      requestId: result.requestId,
      outcome: result.outcome,
      cleanupPending: result.cleanupPending,
      failure: result.failure ?? null,
    },
  };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Pending, failed and released broker requests expose no path to generic device acquisition. */
function refuseToolsWithoutReadyBrokerSession(
  server: McpServer,
  result: SessionBrokerResult,
): void {
  server.server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  server.server.setRequestHandler("tools/call", async (request) =>
    unavailableBrokerSessionToolResult(result, request.params.name),
  );
}

function installAcquisitionToolRefusal(
  server: McpServer,
  session: SessionBrokerResult | undefined,
): void {
  if (session && session.outcome !== "ready") {
    refuseToolsWithoutReadyBrokerSession(server, session);
  }
}

/**
 * Forward one `tools/call` to the daemon. The client's own per-request Tasks declaration (#4668)
 * travels with it, and the daemon alone decides whether the call becomes a task; a task handle is
 * returned unchanged.
 */
async function callProxyTool(
  proxy: DaemonMcpProxy,
  call: Pick<ToolCall<McpToolCallExtra>, "name" | "args" | "progressToken" | "extra">,
  onProgress: ((tick: number, total?: number, message?: string) => void) | undefined,
  options: ProxyMcpServerOptions,
): Promise<McpToolCallResult | CreateTaskResult> {
  const { name, args, progressToken, extra } = call;
  const declaresTasks = requestDeclaresTasks({ envelope: extra.envelope, meta: extra._meta });
  if (!declaresTasks) {
    // An undeclared call is forwarded exactly as before the extension existed.
    const result = await proxy.callTool(name, args, progressToken, onProgress, extra.signal);
    return brokerEndedRelayedResult(result, options.session);
  }
  const result = await proxy.callTool(name, args, progressToken, onProgress, extra.signal, {
    declaresTasks,
  });
  return isCreateTaskResult(result) ? result : brokerEndedRelayedResult(result, options.session);
}

const relayedTaskIdParams = z.looseObject({ taskId: z.string() });
const relayedTaskUpdateParams = z.looseObject({
  taskId: z.string(),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
});

/** The daemon's JSON-RPC answer to a relayed `tasks/*` request, re-raised unchanged (#4668). */
function relayedTaskError(error: unknown): unknown {
  const relayed: unknown =
    error !== null && typeof error === "object" ? Reflect.get(error, "jsonRpcError") : undefined;
  return isRelayedJsonRpcError(relayed) ? toRelayedProtocolError(relayed) : error;
}

/**
 * Relays the MCP Tasks extension (#4668) to the daemon, which owns the tasks: the proxy advertises
 * the extension only to a client whose `initialize` declared it, refuses an undeclared `tasks/*`
 * request exactly as the daemon would (`-32021`), and otherwise forwards `tasks/get`,
 * `tasks/update` (with the input responses the SDK lifts to `ctx.mcpReq.inputResponses`) and
 * `tasks/cancel`, answering with the daemon's result or JSON-RPC error unchanged. A daemon
 * connection failure is the proxy's own error: it never invents a task status.
 */
function installTasksRelay(server: McpServer, proxy: DaemonMcpProxy): void {
  const inner = server.server;
  advertiseTasksOnDeclaringInitialize(inner);
  const relay = async (
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    params: Record<string, unknown>,
    ctx: ServerContext,
  ) => {
    if (!requestDeclaresTasks({ envelope: ctx.mcpReq.envelope, meta: ctx.mcpReq._meta })) {
      throw missingTasksCapabilityError();
    }
    try {
      return await proxy.relayTaskMethod(method, params, true, ctx.mcpReq.signal);
    } catch (error) {
      ctx.mcpReq.signal.throwIfAborted();
      throw relayedTaskError(error);
    }
  };
  inner.setRequestHandler("tasks/get", { params: relayedTaskIdParams }, async (params, ctx) =>
    relay("tasks/get", { taskId: params.taskId }, ctx),
  );
  inner.setRequestHandler(
    "tasks/update",
    { params: relayedTaskUpdateParams },
    async (params, ctx) => {
      const inputResponses = ctx.mcpReq.inputResponses ?? params.inputResponses;
      return relay(
        "tasks/update",
        { taskId: params.taskId, ...(inputResponses !== undefined && { inputResponses }) },
        ctx,
      );
    },
  );
  inner.setRequestHandler("tasks/cancel", { params: relayedTaskIdParams }, async (params, ctx) =>
    relay("tasks/cancel", { taskId: params.taskId }, ctx),
  );
}

function registerProxyResourceHandlers(server: McpServer, proxy: DaemonMcpProxy): void {
  // Register resources/list handler. Serves a cold (empty/cached) roster without
  // connecting when no connection exists yet, deferring the daemon connect to the
  // first tool call (issue #5879) so a host that enumerates resources on init
  // never blocks on a wedged daemon. Once connected, the live list is served.
  server.server.setRequestHandler("resources/list", async () => {
    try {
      const resources = await proxy.listAdvertisedResources();
      return { resources };
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      if (error instanceof McpOverloadError) {
        throw mcpOverloadError(error);
      }
      logger.error(`[ProxyServer] Failed to list resources: ${error}`);
      throw new ActionableError(
        `Failed to list resources from daemon: ${safeForwardedRequestErrorMessage(error)}`,
        { cause: error },
      );
    }
  });

  // Register resources/templates/list handler. Cold-serves without connecting
  // (see resources/list above); defers the daemon connect to the first tool call.
  server.server.setRequestHandler("resources/templates/list", async () => {
    try {
      const resourceTemplates = await proxy.listAdvertisedResourceTemplates();
      return { resourceTemplates };
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      if (error instanceof McpOverloadError) {
        throw mcpOverloadError(error);
      }
      logger.error(`[ProxyServer] Failed to list resource templates: ${error}`);
      throw new ActionableError(
        `Failed to list resource templates from daemon: ${safeForwardedRequestErrorMessage(error)}`,
        { cause: error },
      );
    }
  });

  // Register resources/read handler - forward to daemon
  server.server.setRequestHandler("resources/read", async (request, ctx) => {
    const uri = request.params.uri;

    if (!uri) {
      throw new ActionableError("Resource URI is missing in the request");
    }

    logger.info(`[ProxyServer] Forwarding resource read: ${uri}`);

    try {
      const result = await proxy.readResource(uri, { signal: ctx.mcpReq.signal });
      return result;
    } catch (error) {
      ctx.mcpReq.signal.throwIfAborted();
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      if (error instanceof McpOverloadError) {
        throw mcpOverloadError(error);
      }
      const retryable = retryableResourceReadError(error);
      if (retryable) {
        logger.warn(`[ProxyServer] Resource read refused, retryable: ${uri} - ${error}`);
        throw retryable;
      }
      const invalidParams = forwardedInvalidParamsError(error);
      if (invalidParams) {
        logger.warn(`[ProxyServer] Resource read rejected as invalid params: ${uri}`);
        throw invalidParams;
      }
      logger.error(`[ProxyServer] Resource read failed: ${uri} - ${error}`);
      throw new ActionableError(
        `Failed to read resource from daemon: ${safeForwardedRequestErrorMessage(error)}`,
        { cause: error },
      );
    }
  });
}

/**
 * Create an MCP server that proxies all requests through the daemon
 *
 * This server acts as a thin proxy layer that:
 * - Forwards tool calls to the daemon
 * - Forwards resource requests to the daemon
 * - Maintains the same MCP interface expected by clients
 *
 * Benefits:
 * - IDE plugins get a stable stdio/SSE connection
 * - All actual work happens in the daemon
 * - Device state is managed centrally by daemon
 * - Less process churn (daemon stays running)
 */
/** The daemon proxy {@link createProxyMcpServer} serves through. */
export function createDaemonMcpProxy(proxyConfig?: DaemonMcpProxyConfig): DaemonMcpProxy {
  const acceptanceDiscovery = acceptanceDiscoveryConfiguration();
  return new DaemonMcpProxy({
    ...proxyConfig,
    ...(acceptanceDiscovery ? { acceptanceDiscovery } : {}),
  });
}

export function createProxyMcpServer(options: ProxyMcpServerOptions = {}): {
  server: McpServer;
  proxy: DaemonMcpProxy;
} {
  const proxy = options.proxy ?? createDaemonMcpProxy(options.proxyConfig);
  const advertisedToolOutputSchemas = new Map<string, boolean>();
  let toolListEpoch = 0;

  // Create the MCP server
  const server = createSdkMcpServer(
    {
      name: "AutoMobile",
      version: getMcpServerVersion(),
    },
    proxyServerCapabilities(options) as ServerCapabilities,
  );

  // Forward daemon-emitted list-changed notifications to the external client
  // (issue #3223): the proxy has already invalidated its matching cache, so a
  // client re-fetch after this notification returns fresh definitions. The
  // McpServer send helpers are no-ops until a transport connects, and the
  // try/catch keeps a mid-teardown transport from breaking the forward path.
  proxy.onListChanged((kind) => {
    try {
      if (kind === "tools") {
        // Until the client re-fetches, fail closed rather than retain a schema
        // advertised before the daemon changed its tool-result policy.
        toolListEpoch += 1;
        advertisedToolOutputSchemas.clear();
        server.sendToolListChanged();
      } else {
        server.sendResourceListChanged();
      }
    } catch (error) {
      // Best-effort: a failed client notification must never break the proxy
      // connection; the client just keeps its stale list until the next fetch.
      logger.warn(`[ProxyServer] Failed to forward ${kind} list_changed notification: ${error}`);
    }
  });

  const stopResourceUpdates = proxy.onResourceUpdated((uri) => {
    void forwardResourceUpdate(server, uri);
  });
  const stopLivenessHandovers = proxy.onLivenessHandover((handover) => {
    void forwardLivenessHandover(server, handover);
  });
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    stopResourceUpdates();
    stopLivenessHandovers();
    previousOnClose?.();
    void proxy.close().catch((error) => {
      logger.warn("[ProxyServer] Failed to close daemon proxy", error);
    });
  };

  server.server.setRequestHandler("resources/subscribe", async (request) => {
    try {
      await proxy.subscribeResource(request.params.uri);
      return {};
    } catch (error) {
      throw toActionableError(error, "Failed to subscribe to daemon resource");
    }
  });
  server.server.setRequestHandler("resources/unsubscribe", async (request) => {
    try {
      await proxy.unsubscribeResource(request.params.uri);
      return {};
    } catch (error) {
      throw toActionableError(error, "Failed to unsubscribe from daemon resource");
    }
  });

  // Register ping handler as per MCP specification
  server.server.setRequestHandler("ping", async () => {
    return {};
  });

  // Register prompts list handler (returns empty list)
  server.server.setRequestHandler("prompts/list", async () => {
    return {
      prompts: [],
    };
  });

  // Register tools/list handler. Serves the static tool surface without
  // connecting to the daemon when no connection exists yet, deferring the daemon
  // connect/start to the first actual tool call (issue #5879). Once connected,
  // the accurate session-scoped list is served.
  server.server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => {
    try {
      if (brokerSessionHasEnded(proxy, options.session)) {
        return { tools: [] }; // Broker connections cannot discover generic acquisition tools.
      }
      const requestEpoch = toolListEpoch;
      const advertised = await proxy.listAdvertisedTools();
      // Before connection the daemon cannot provide this connection's live profile.
      // Use the registered built-in defaults plus this frontend's startup choices;
      // after connection the daemon's session-scoped list remains authoritative.
      const tools = proxy.isConnected()
        ? advertised
        : (() => {
            const registered = ToolRegistry.getAllTools({ includeUnavailable: true });
            const defaults = getStartupToolDefaults(
              process.env,
              new Set(ToolRegistry.getConfigurableToolNames()),
              options.proxyConfig?.daemonOptions?.enabledTools,
              options.proxyConfig?.daemonOptions?.disabledTools,
            );
            const declaredDefaults = new Map(
              registered.map((tool) => [tool.name, tool.defaultEnabled]),
            );
            return advertised.filter(
              (tool) => defaults.get(tool.name) ?? declaredDefaults.get(tool.name) ?? true,
            );
          })();
      if (requestEpoch === toolListEpoch) {
        advertisedToolOutputSchemas.clear();
        for (const tool of tools) {
          advertisedToolOutputSchemas.set(tool.name, tool.outputSchema !== undefined);
        }
      }
      // Daemon definitions are forwarded verbatim; the SDK types their schemas
      // more narrowly than the proxy's `Record<string, unknown>`.
      return { tools } as ListToolsResult;
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      if (error instanceof McpOverloadError) {
        throw mcpOverloadError(error);
      }
      logger.error(`[ProxyServer] Failed to list tools: ${error}`);
      throw new ActionableError(
        `Failed to list tools from daemon: ${safeForwardedRequestErrorMessage(error)}`,
        { cause: error },
      );
    }
  });

  // Register tools/call handler - forward to daemon through the shared
  // dispatch envelope (#6545).
  installToolCallDispatcher(
    server,
    {
      progressFailureMessage: "[ProxyServer] Failed to relay progress notification",
      execute: async ({ name, args, progressToken, progress, extra }) => {
        const hasOutputSchema = advertisedToolOutputSchemas.get(name) ?? false;

        logger.info(`[ProxyServer] Forwarding tool call: ${name}`);

        // Echo the CLIENT's own progress token through the daemon round trip
        // (issue #6205) — the direct server (#6118) already refuses to fabricate
        // one, and the proxy must not either: relay a tick only when the client
        // asked, tagged with that SAME token. The relay is fire-and-forget; the
        // shared echo logs a failed send instead of rejecting.
        const onProgress = progress
          ? (tick: number, total?: number, message?: string): void => {
              void progress(tick, total, message);
            }
          : undefined;

        try {
          return await callProxyTool(
            proxy,
            { name, args, progressToken, extra },
            onProgress,
            options,
          );
        } catch (error) {
          // The SDK suppresses responses for aborted requests. Do not turn a
          // cancellation into a tool error result while that request unwinds.
          extra.signal.throwIfAborted();
          const brokerEnded = localBrokerSessionEndedResult(error, options.session);
          if (brokerEnded) {
            return brokerEnded;
          }
          return resolveCallToolErrorResult(error, name, hasOutputSchema);
        }
      },
    },
    { ambiguousDeviceElicitation: options.ambiguousDeviceElicitation ?? {} },
  );

  registerProxyResourceHandlers(server, proxy);
  installTasksRelay(server, proxy);
  installAcquisitionToolRefusal(server, options.session);

  return { server, proxy };
}
