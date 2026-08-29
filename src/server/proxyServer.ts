import { errorMessage } from "../utils/describeUnknownError";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  type CallToolResult,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
  type DaemonMcpProxyConfig,
} from "../daemon/daemonMcpProxy";
import { ActionableError } from "../models";
import { getMcpServerVersion } from "../utils/mcpVersion";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "../daemon/deviceControlTransportFailure";

/**
 * Options for creating a proxy MCP server
 */
export interface ProxyMcpServerOptions {
  /** Configuration for the daemon proxy */
  proxyConfig?: DaemonMcpProxyConfig;
  /** Session context for tracking */
  sessionContext?: { sessionId?: string };
}

function sessionOwnershipLostPayload(error: DaemonBoundSessionExpiredError) {
  return {
    error: {
      code: "session_ownership_lost",
      message: `Session ownership lost for ${error.sessionUuid}: ${error.reason}`,
      sessionUuid: error.sessionUuid,
      reason: error.reason,
      ...(error.release ? { release: error.release } : {}),
    },
  };
}

function sessionOwnershipLostMessage(error: DaemonBoundSessionExpiredError): string {
  return JSON.stringify(sessionOwnershipLostPayload(error));
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
  const payload = sessionOwnershipLostPayload(error);
  return new McpError(-32603, sessionOwnershipLostMessage(error), payload);
}

function noActiveDeviceSessionPayload(error: DaemonConnectionSessionReleasedError) {
  return {
    error: {
      code: "no_active_device_session",
      message: error.message,
      reason: error.reason,
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

function deviceControlTransportFailureResult(error: DeviceControlTransportError): CallToolResult {
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
  const proxy = new DaemonMcpProxy(options.proxyConfig);

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
        resources: { listChanged: true },
        tools: { listChanged: true },
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
      const tools = await proxy.listAdvertisedTools();
      return { tools };
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      logger.error(`[ProxyServer] Failed to list tools: ${error}`);
      throw new ActionableError(`Failed to list tools from daemon: ${errorMessage(error)}`);
    }
  });

  // Register tools/call handler - forward to daemon
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;

    if (!name) {
      throw new ActionableError("Tool name is missing in the request");
    }

    logger.info(`[ProxyServer] Forwarding tool call: ${name}`);

    try {
      const result = await proxy.callTool(name, args);
      return result;
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        logger.warn(
          `[ProxyServer] Session ownership lost for ${error.sessionUuid}: ${error.reason}`,
        );
        return sessionOwnershipLostResult(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        logger.warn(`[ProxyServer] No active device session (released: ${error.reason})`);
        return noActiveDeviceSessionResult(error);
      }
      if (error instanceof DeviceControlTransportError) {
        logger.warn(
          `[ProxyServer] Device-control transport failure for ${error.failure.toolName} during ${error.failure.phase}`,
        );
        return deviceControlTransportFailureResult(error);
      }
      logger.error(`[ProxyServer] Tool call failed: ${name} - ${error}`);
      // Return error as tool result (not throwing) to match expected MCP behavior
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Register resources/list handler - forward to daemon
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const resources = await proxy.listResources();
      return { resources };
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      logger.error(`[ProxyServer] Failed to list resources: ${error}`);
      throw new ActionableError(`Failed to list resources from daemon: ${errorMessage(error)}`);
    }
  });

  // Register resources/templates/list handler - forward to daemon
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    try {
      const resourceTemplates = await proxy.listResourceTemplates();
      return { resourceTemplates };
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      logger.error(`[ProxyServer] Failed to list resource templates: ${error}`);
      throw new ActionableError(
        `Failed to list resource templates from daemon: ${errorMessage(error)}`,
      );
    }
  });

  // Register resources/read handler - forward to daemon
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (!uri) {
      throw new ActionableError("Resource URI is missing in the request");
    }

    logger.info(`[ProxyServer] Forwarding resource read: ${uri}`);

    try {
      const result = await proxy.readResource(uri);
      return result;
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        throw sessionOwnershipLostError(error);
      }
      if (error instanceof DaemonConnectionSessionReleasedError) {
        throw noActiveDeviceSessionError(error);
      }
      logger.error(`[ProxyServer] Resource read failed: ${uri} - ${error}`);
      throw new ActionableError(`Failed to read resource from daemon: ${errorMessage(error)}`);
    }
  });

  return { server, proxy };
}
