import type { Client } from "@modelcontextprotocol/client";
import type { ForwardMcpClient } from "./forwardSessionKey";
import {
  declaredTasksMeta,
  isTaskRelayMethod,
  parseTaskRelayFrame,
  RELAYED_TASK_RESULT_SCHEMA,
  relayedJsonRpcError,
  restoreCreateTaskResult,
  withCompleteResultType,
} from "../tasks/taskRelay";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { DaemonRequest, DaemonResponse } from "../types";

type CallToolArguments = Parameters<Client["callTool"]>[0]["arguments"];

/**
 * The daemon half of the stdio proxy's MCP Tasks relay (#4668): a control-socket forward replays
 * the declaration the frame carries, and answers exactly what the daemon's MCP server sent.
 */

/**
 * A forwarded `tools/call`. When the stdio proxy relayed the client's Tasks declaration the call
 * carries it, and a task handle the daemon answered with is returned as it was sent.
 */
export async function callForwardedTool(
  mcpClient: ForwardMcpClient,
  request: DaemonRequest,
  args: unknown,
  callOptions: Record<string, unknown>,
): Promise<unknown> {
  const declared = parseTaskRelayFrame(request.tasks)?.declared === true;
  const result = await mcpClient.callTool(
    {
      name: request.params.name,
      // The socket frame's arguments, forwarded as they arrived (the server validates them).
      arguments: args as CallToolArguments,
      ...(declared && { _meta: declaredTasksMeta() }),
    },
    callOptions,
  );
  return declared ? (restoreCreateTaskResult(result) ?? result) : result;
}

/**
 * A relayed `tasks/get`, `tasks/update` or `tasks/cancel`: declared only when the proxy's client
 * declared it, scoped to the frame's task owner (the forward's server), answered unchanged. Any
 * other method is refused.
 */
export async function forwardTaskRequest(
  mcpClient: ForwardMcpClient,
  request: DaemonRequest,
  requestOptions: { timeout: number; signal?: AbortSignal },
): Promise<unknown> {
  if (!isTaskRelayMethod(request.method)) {
    throw new Error(`Unsupported daemon method: ${request.method}`);
  }
  // The declaration comes from the frame alone, never from the caller's own `_meta`.
  const params: Record<string, unknown> = { ...request.params };
  delete params._meta;
  const declared = parseTaskRelayFrame(request.tasks)?.declared === true;
  const result = await mcpClient.request(
    {
      method: request.method,
      params: { ...params, ...(declared && { _meta: declaredTasksMeta() }) },
    },
    RELAYED_TASK_RESULT_SCHEMA,
    requestOptions,
  );
  return withCompleteResultType(result);
}

/**
 * The frame for a relayed `tasks/*` request the daemon's MCP server answered with a JSON-RPC error
 * (an unknown or expired task, a missing declaration): its own answer, relayed rather than a
 * fault, carried unchanged as `jsonRpcError`. `undefined` for any other failure.
 */
export function taskRelayErrorFrame(
  error: unknown,
  request: DaemonRequest,
): DaemonResponse | undefined {
  const jsonRpcError = relayedJsonRpcError(error);
  if (!jsonRpcError) {
    return undefined;
  }
  logger.debug(`[TASKS] ${request.method} answered ${jsonRpcError.code}: ${jsonRpcError.message}`);
  return {
    id: request.id,
    type: "mcp_response",
    success: false,
    error: errorMessage(error),
    code: jsonRpcError.code,
    jsonRpcError,
  };
}
