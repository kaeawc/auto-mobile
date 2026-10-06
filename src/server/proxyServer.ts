import { errorMessage } from "../utils/describeUnknownError";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListResourceTemplatesRequestSchema,
  type CallToolResult,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";
import {
  DaemonBoundSessionExpiredError,
  DaemonSessionStalledError,
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
  DaemonRestartDeferredError,
  type DaemonMcpProxyConfig,
} from "../daemon/daemonMcpProxy";
import { DaemonShuttingDownError } from "../daemon/client";
import { McpOverloadError, McpTimeoutError } from "../daemon/McpTimeoutError";
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
  DEVICE_SESSION_RECOVERY_TOOLS,
  sessionOwnershipLostPayload,
} from "./deviceSessionResult";
import { ACCEPTANCE_DISCOVERY_CAPABILITY_ENV } from "../daemon/constants";
import { getStartupToolDefaults } from "../features/toolSelection/SessionToolSelectionService";
import { ToolRegistry } from "./toolRegistry";
import { installToolCallDispatcher } from "./toolCallDispatch";
import { shapeToolCallError } from "./shapeToolCallError";
import { livenessHandoverPayload, type LivenessHandover } from "../daemon/proxyLivenessRecovery";

const LIVE_ACCEPTANCE_ENV = "AUTOMOBILE_ACCEPTANCE_LIVE";
const ACCEPTANCE_DISCOVERY_ORDER_ENV = "AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER";

function acceptanceDiscoveryConfiguration():
  | { order: "forward" | "reverse"; capability: string }
  | undefined {
  if (process.env[LIVE_ACCEPTANCE_ENV] !== "1") {
    return undefined;
  }
  const order = process.env[ACCEPTANCE_DISCOVERY_ORDER_ENV];
  const capability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];
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
  /** Session context for tracking */
  sessionContext?: { sessionId?: string };
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

function noActiveDeviceSessionPayload(error: DaemonConnectionSessionReleasedError) {
  return {
    error: {
      code: "no_active_device_session",
      message: error.message,
      reason: error.reason,
      retryable: true,
      recovery: {
        action: "acquire_replacement_session",
        tools: [...DEVICE_SESSION_RECOVERY_TOOLS],
      },
    },
  };
}

function noActiveDeviceSessionMessage(error: DaemonConnectionSessionReleasedError): string {
  return JSON.stringify(noActiveDeviceSessionPayload(error));
}

function noActiveDeviceSessionResult(error: DaemonConnectionSessionReleasedError): CallToolResult {
  return {
    content: [{ type: "text", text: noActiveDeviceSessionMessage(error) }],
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

export function daemonRestartDeferredResult(
  error: DaemonRestartDeferredError,
): CallToolResult & { structuredContent: Record<string, unknown> } {
  const payload = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    },
  };
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
    content: [{ type: "text", text: JSON.stringify(payload) }],
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
    await server.server.sendLoggingMessage({
      level: "error",
      logger: "auto-mobile.liveness",
      data: livenessHandoverPayload(handover),
    });
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

function registerProxyResourceHandlers(server: McpServer, proxy: DaemonMcpProxy): void {
  // Register resources/list handler. Serves a cold (empty/cached) roster without
  // connecting when no connection exists yet, deferring the daemon connect to the
  // first tool call (issue #5879) so a host that enumerates resources on init
  // never blocks on a wedged daemon. Once connected, the live list is served.
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
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
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
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
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = request.params.uri;

    if (!uri) {
      throw new ActionableError("Resource URI is missing in the request");
    }

    logger.info(`[ProxyServer] Forwarding resource read: ${uri}`);

    try {
      const result = await proxy.readResource(uri, { signal: extra.signal });
      return result;
    } catch (error) {
      extra.signal.throwIfAborted();
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      if (error instanceof McpOverloadError) {
        throw mcpOverloadError(error);
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
export function createProxyMcpServer(options: ProxyMcpServerOptions = {}): {
  server: McpServer;
  proxy: DaemonMcpProxy;
} {
  const acceptanceDiscovery = acceptanceDiscoveryConfiguration();
  const proxy = new DaemonMcpProxy({
    ...options.proxyConfig,
    ...(acceptanceDiscovery ? { acceptanceDiscovery } : {}),
  });
  const advertisedToolOutputSchemas = new Map<string, boolean>();
  let toolListEpoch = 0;

  // Create the MCP server
  const server = new McpServer(
    {
      name: "AutoMobile",
      version: getMcpServerVersion(),
    },
    {
      capabilities: {
        // Declare listChanged: this proxy is the boundary external MCP clients
        // connect to, and it emits notifications/{tools,resources}/list_changed —
        // both the daemon-forwarded invalidations (issue #3223) and the
        // post-lazy-connect tools reconciliation (issue #5879). Without the
        // capability a spec-strict client may ignore those notifications and keep
        // a stale (cold, over-broad) tool list for the session.
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
        // Declared so the proxy can tell an idle harness its sessions were lost (#10053).
        logging: {},
        prompts: {},
      },
    },
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

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    try {
      await proxy.subscribeResource(request.params.uri);
      return {};
    } catch (error) {
      throw toActionableError(error, "Failed to subscribe to daemon resource");
    }
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    try {
      await proxy.unsubscribeResource(request.params.uri);
      return {};
    } catch (error) {
      throw toActionableError(error, "Failed to unsubscribe from daemon resource");
    }
  });

  // Register ping handler as per MCP specification
  const PingRequestSchema = require("@modelcontextprotocol/sdk/types.js").PingRequestSchema;
  server.server.setRequestHandler(PingRequestSchema, async () => {
    return {};
  });

  // Register prompts list handler (returns empty list)
  const ListPromptsRequestSchema =
    require("@modelcontextprotocol/sdk/types.js").ListPromptsRequestSchema;
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [],
    };
  });

  // Register tools/list handler. Serves the static tool surface without
  // connecting to the daemon when no connection exists yet, deferring the daemon
  // connect/start to the first actual tool call (issue #5879). Once connected,
  // the accurate session-scoped list is served.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
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
      return { tools };
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
  installToolCallDispatcher(server, {
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
        const result = await proxy.callTool(name, args, progressToken, onProgress, extra.signal);
        return result;
      } catch (error) {
        // The SDK suppresses responses for aborted requests. Do not turn a
        // cancellation into a tool error result while that request unwinds.
        extra.signal.throwIfAborted();
        return resolveCallToolErrorResult(error, name, hasOutputSchema);
      }
    },
  });

  registerProxyResourceHandlers(server, proxy);

  return { server, proxy };
}
