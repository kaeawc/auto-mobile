import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ActionableError } from "../models";
import { logger } from "../utils/logger";

/**
 * The single MCP `tools/call` dispatch envelope (issue #6545).
 *
 * Both live topologies — the direct/daemon-loopback server (`index.ts`) and the
 * stdio proxy (`proxyServer.ts`) — install their `tools/call` handler through
 * {@link installToolCallDispatcher}, so request parsing, the missing-name guard
 * and the client progress-token echo (#6118/#6205) live in exactly one place.
 * Each topology supplies only what genuinely differs: a {@link ToolCallBackend}
 * that runs the call locally or forwards it to the daemon.
 *
 * `ToolRegistry.registerWithServer` registers tools with the SDK for capability
 * advertisement only; its per-tool SDK callback is shadowed by this handler and
 * carries no dispatch logic.
 */

export type ToolCallProgress = (
  progress: number,
  total?: number,
  message?: string,
) => Promise<void>;

export interface ToolCallProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

/** The slice of the SDK's request-handler `extra` the envelope reads. */
export interface ToolCallExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  sendNotification(notification: ToolCallProgressNotification): Promise<void>;
}

/** The slice of a `tools/call` request the envelope reads. */
export interface ToolCallRequest {
  readonly params: { readonly name?: string; arguments?: Record<string, unknown> };
}

export interface ToolCall<Extra> {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** The client's own `_meta.progressToken`, if it asked for progress. */
  readonly progressToken: string | number | undefined;
  /** Echoes progress under the client's token; undefined when none was sent. */
  readonly progress: ToolCallProgress | undefined;
  readonly extra: Extra;
}

export interface ToolCallBackend<Req extends ToolCallRequest, Extra extends ToolCallExtra, Result> {
  /** Logged (with the error) when a progress notification fails to send. */
  readonly progressFailureMessage: string;
  /** Runs before the name is read, e.g. to revive transport-encoded arguments. */
  prepare?(request: Req): void;
  execute(call: ToolCall<Extra>): Promise<Result>;
}

/**
 * Builds the progress callback for one call. Per the MCP spec a notification
 * must echo the token the client supplied — a server-fabricated token has no
 * handler on the client (issue #6118) — so none is built without one. A failed
 * send is logged and never fails the tool call.
 */
export function createProgressEcho(
  extra: ToolCallExtra,
  progressFailureMessage: string,
): ToolCallProgress | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total,
          ...(message && { message }),
        },
      });
    } catch (error) {
      // Best-effort: a dropped progress tick must not fail the tool execution.
      logger.warn(`${progressFailureMessage}: ${error}`);
    }
  };
}

export async function dispatchToolCall<
  Req extends ToolCallRequest,
  Extra extends ToolCallExtra,
  Result,
>(request: Req, extra: Extra, backend: ToolCallBackend<Req, Extra, Result>): Promise<Result> {
  backend.prepare?.(request);
  const name = request.params.name;
  const args = request.params.arguments || {};
  if (!name) {
    throw new ActionableError("Tool name is missing in the request");
  }
  return backend.execute({
    name,
    args,
    progressToken: extra._meta?.progressToken,
    progress: createProgressEcho(extra, backend.progressFailureMessage),
    extra,
  });
}

type McpRequestHandler = Parameters<McpServer["server"]["setRequestHandler"]>[1];
/** The SDK's request-handler `extra` for a server-side `tools/call`. */
export type McpToolCallExtra = Parameters<McpRequestHandler>[1];
/** What the SDK accepts back from a server-side request handler. */
export type McpToolCallResult = Awaited<ReturnType<McpRequestHandler>>;

/** Installs {@link dispatchToolCall} as the server's one `tools/call` handler. */
export function installToolCallDispatcher(
  server: McpServer,
  backend: ToolCallBackend<ToolCallRequest, McpToolCallExtra, McpToolCallResult>,
): void {
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    dispatchToolCall(request, extra, backend),
  );
}
