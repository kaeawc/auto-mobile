import { CLIENT_CAPABILITIES_META_KEY, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { TASKS_EXTENSION_ID, type CreateTaskResult } from "./mcpTasksExtension";

/**
 * How the stdio proxy relays the MCP Tasks extension (#4668) to the daemon over the control
 * socket: the client's per-request declaration and a task owner key travel on the socket frame,
 * the daemon replays the declaration on its in-process forward, and `tasks/*` answers come back
 * unchanged. The SDK client on the in-process hop lifts `resultType` off every result it
 * decodes, so the daemon side restores it (see {@link withCompleteResultType} and
 * {@link restoreCreateTaskResult}).
 */

/** The `tasks/*` methods a proxy relays to the daemon. */
export const TASK_RELAY_METHODS = ["tasks/get", "tasks/update", "tasks/cancel"] as const;

export type TaskRelayMethod = (typeof TASK_RELAY_METHODS)[number];

export function isTaskRelayMethod(method: string): method is TaskRelayMethod {
  return (TASK_RELAY_METHODS as readonly string[]).includes(method);
}

/**
 * The Tasks part of one control-socket frame. `ownerKey` names the proxy that owns the task: it
 * is stable across the proxy's reconnects (a restarted daemon still finds the task), unlike the
 * socket's own session id. `declared` is whether THIS client request declared the extension.
 */
export interface TaskRelayFrame {
  readonly ownerKey: string;
  readonly declared: boolean;
}

/** A socket frame's `tasks` field, when well-formed (the frame comes from any socket client). */
export function parseTaskRelayFrame(value: unknown): TaskRelayFrame | undefined {
  if (
    !isRecord(value) ||
    typeof value.ownerKey !== "string" ||
    value.ownerKey.trim().length === 0 ||
    typeof value.declared !== "boolean"
  ) {
    return undefined;
  }
  return { ownerKey: value.ownerKey, declared: value.declared };
}

/** The per-request `_meta` that declares the extension, as a client sends it. */
export function declaredTasksMeta(): Record<string, unknown> {
  return { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A relayed `tasks/*` result is passed through as the daemon's MCP server answered it. */
export const RELAYED_TASK_RESULT_SCHEMA = z.looseObject({});

/** `tasks/get`, `tasks/update` and `tasks/cancel` always answer `resultType: "complete"`. */
export function withCompleteResultType(result: unknown): Record<string, unknown> {
  return { resultType: "complete", ...(isRecord(result) ? result : {}) };
}

/**
 * The `CreateTaskResult` a declaring `tools/call` answered, as the SDK client decoded it: no
 * `resultType`, and the `content: []` its `CallToolResult` parsing adds. Returns the wire shape
 * the daemon sent, or `undefined` for an ordinary tool result. A tool result never carries a
 * top-level `taskId`, so only a task handle matches.
 */
export function restoreCreateTaskResult(result: unknown): CreateTaskResult | undefined {
  if (
    !isRecord(result) ||
    typeof result.taskId !== "string" ||
    typeof result.status !== "string" ||
    typeof result.createdAt !== "string" ||
    "isError" in result ||
    "structuredContent" in result ||
    (result.content !== undefined &&
      !(Array.isArray(result.content) && result.content.length === 0))
  ) {
    return undefined;
  }
  const task: Record<string, unknown> = { resultType: "task", ...result };
  delete task.content;
  return task as CreateTaskResult;
}

/** A JSON-RPC error the daemon answered a relayed `tasks/*` request with, carried unchanged. */
export interface RelayedJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * The daemon's JSON-RPC error for a relayed request, without the `MCP error <code>: ` prefix the
 * loopback client's v1 error contract added, so the proxy can answer with exactly what the
 * daemon sent.
 */
export function relayedJsonRpcError(error: unknown): RelayedJsonRpcError | undefined {
  if (!(error instanceof ProtocolError) || typeof error.code !== "number") {
    return undefined;
  }
  const prefix = `MCP error ${error.code}: `;
  const message = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return {
    code: error.code,
    message,
    ...(error.data !== undefined && { data: error.data }),
  };
}

export function isRelayedJsonRpcError(value: unknown): value is RelayedJsonRpcError {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}

/** The error a relayed `tasks/*` answer is re-raised as: the daemon's code, message and data. */
export function toRelayedProtocolError(error: RelayedJsonRpcError): ProtocolError {
  return new ProtocolError(error.code, error.message, error.data);
}
