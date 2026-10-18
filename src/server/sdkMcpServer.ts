import {
  type Implementation,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  type Server,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { ErrorCode, McpError } from "./mcpError";

type WrapHandler = Server["_wrapHandler"];
type RequestHandler = Parameters<WrapHandler>[1];
type HandlerContext = Parameters<RequestHandler>[1];

const INVALID_TOOLS_CALL_REQUEST = "Invalid tools/call request: ";
const INVALID_TOOLS_CALL_RESULT = "Invalid tools/call result: ";

/**
 * Builds an SDK v2 `McpServer` whose wire behaviour matches the v1 SDK (issue #4678).
 *
 * - Capabilities: given `prompts` at construction, the v2 `McpServer` installs its own
 *   prompts handlers and advertises `prompts.listChanged: true`; the v1 server did
 *   neither. Our servers answer `prompts/list` themselves, so `prompts` is registered
 *   after construction instead, keeping the `initialize` result identical. `tools` and
 *   `resources` advertise `listChanged: true` under both SDKs (v1's `registerTool` merged
 *   it in too), so they pass through unchanged.
 * - `tools/call` errors the SDK itself raises: v2 validates the request before our
 *   handler runs and the result after it, answering `-32602 "Invalid tools/call
 *   request: …"` and an unprefixed `"Invalid tools/call result: …"`. v1 answered a
 *   malformed request with `-32603` and the bare validation message, and a malformed
 *   result with the prefixed `"MCP error -32602: …"`. {@link v1ToolsCallError} maps them
 *   back; errors our own handlers throw pass through untouched.
 * - Abort reason: when the transport closes, v2 aborts in-flight handlers with an
 *   `SdkError(ConnectionClosed)`; v1 aborted with no reason, i.e. a DOMException named
 *   `AbortError`, which the `error.name === "AbortError"` checks across `src/` rely on.
 *   Every handler sees a signal whose close-abort reason is that `AbortError` again. A
 *   `notifications/cancelled` reason is forwarded unchanged, as under v1. v1 aborted
 *   before running `onclose`; the normalized signal fires after it (the v2 order).
 *
 * Both adjustments hook `Server._wrapHandler`, which `setRequestHandler` applies to every
 * handler registered after construction. All of our handlers are registered after this
 * returns, and they replace the SDK handlers the constructor installed.
 */
export function createSdkMcpServer(
  info: Implementation,
  capabilities: ServerCapabilities,
): McpServer {
  const server = new McpServer(info, { capabilities: { ...capabilities, prompts: undefined } });
  if (capabilities.prompts) {
    server.server.registerCapabilities({ prompts: capabilities.prompts });
  }
  installV1HandlerWrapper(server.server);
  return server;
}

function installV1HandlerWrapper(inner: Server): void {
  const wrap: WrapHandler = inner["_wrapHandler"].bind(inner);
  inner["_wrapHandler"] = (method, handler) => {
    const wrapped = wrap(method, (request, ctx) => handler(request, withV1AbortSignal(ctx)));
    if (method !== "tools/call") {
      return wrapped;
    }
    return async (request, ctx) => {
      try {
        return await wrapped(request, ctx);
      } catch (error) {
        throw v1ToolsCallError(error);
      }
    };
  };
}

/** Maps the SDK's own `tools/call` validation errors back to their v1 code and message. */
export function v1ToolsCallError(error: unknown): unknown {
  if (
    !(error instanceof ProtocolError) ||
    error instanceof McpError ||
    error.code !== ProtocolErrorCode.InvalidParams
  ) {
    return error;
  }
  if (error.message.startsWith(INVALID_TOOLS_CALL_REQUEST)) {
    return new ProtocolError(
      ErrorCode.InternalError,
      error.message.slice(INVALID_TOOLS_CALL_REQUEST.length),
      error.data,
    );
  }
  if (error.message.startsWith(INVALID_TOOLS_CALL_RESULT)) {
    return new McpError(ErrorCode.InvalidParams, error.message, error.data);
  }
  return error;
}

function withV1AbortSignal(ctx: HandlerContext): HandlerContext {
  return { ...ctx, mcpReq: { ...ctx.mcpReq, signal: v1AbortSignal(ctx.mcpReq.signal) } };
}

/** A signal that follows `signal`, replacing a connection-closed abort reason with `AbortError`. */
export function v1AbortSignal(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const follow = (): void => {
    controller.abort(isConnectionClosed(signal.reason) ? undefined : signal.reason);
  };
  if (signal.aborted) {
    follow();
  } else {
    signal.addEventListener("abort", follow, { once: true });
  }
  return controller.signal;
}

function isConnectionClosed(reason: unknown): boolean {
  return reason instanceof SdkError && reason.code === SdkErrorCode.ConnectionClosed;
}
