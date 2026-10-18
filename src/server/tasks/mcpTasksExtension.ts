import { CLIENT_CAPABILITIES_META_KEY, ProtocolError } from "@modelcontextprotocol/server";
import type { JsonObject, McpTaskRecord, McpTaskStatus } from "../../db/mcpTaskRepository";

/**
 * Wire vocabulary of the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663,
 * specification revision 2026-07-28 of modelcontextprotocol/ext-tasks), issue #4668.
 *
 * The installed SDK (`@modelcontextprotocol/server` 2.3.1) ships only the 2025-11-25 core
 * task vocabulary (`ttl`, `pollInterval`, `tasks/result`, `tasks/list`) as deprecated,
 * runtime-less types, so the extension's shapes (`ttlMs`, `pollIntervalMs`, `resultType:
 * "task"`, `tasks/update`) are defined here and served by our own request handlers.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** `-32021` Missing Required Client Capability. */
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
const INVALID_PARAMS = -32602;

export type WireTask = {
  readonly taskId: string;
  readonly status: McpTaskStatus;
  readonly statusMessage?: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601. */
  readonly lastUpdatedAt: string;
  /** From creation; null (unlimited) while the task runs. */
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
};

/** `tools/call` answered with a task handle instead of the tool result. */
export type CreateTaskResult = WireTask & { readonly resultType: "task" };

/** `tasks/get`: the task with its status-specific payload inlined. */
export type GetTaskResult = WireTask & {
  readonly resultType: "complete";
  readonly inputRequests?: JsonObject;
  readonly result?: JsonObject;
  readonly error?: JsonObject;
};

/** `tasks/update` and `tasks/cancel` acknowledge with an empty complete result. */
export type TaskAckResult = {
  readonly resultType: "complete";
};

export const TASK_ACK: TaskAckResult = { resultType: "complete" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a request's per-request capabilities can arrive. */
export interface RequestCapabilitySource {
  /** `ctx.mcpReq.envelope`: the SDK lifts the reserved `_meta` envelope keys here. */
  readonly envelope?: unknown;
  /** `ctx.mcpReq._meta`, for a transport that did not lift them. */
  readonly meta?: unknown;
}

function declaredIn(container: unknown): boolean {
  return isRecord(container) && capabilitiesDeclareTasks(container[CLIENT_CAPABILITIES_META_KEY]);
}

/**
 * Whether THIS request declared the extension in its per-request capabilities
 * (`_meta["io.modelcontextprotocol/clientCapabilities"].extensions`). Declarations are
 * never remembered across requests: a server MUST NOT return a task to a request that
 * did not carry it.
 */
export function requestDeclaresTasks(source: RequestCapabilitySource): boolean {
  return declaredIn(source.envelope) || declaredIn(source.meta);
}

/** Whether a client capabilities object lists the extension under `extensions`. */
export function capabilitiesDeclareTasks(capabilities: unknown): boolean {
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) {
    return false;
  }
  return isRecord(capabilities.extensions[TASKS_EXTENSION_ID]);
}

export function isCreateTaskResult(value: unknown): value is CreateTaskResult {
  return isRecord(value) && value.resultType === "task" && typeof value.taskId === "string";
}

export function missingTasksCapabilityError(): ProtocolError {
  return new ProtocolError(
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    "Missing required client capability",
    {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
    },
  );
}

export type TaskLookupFailure = "not_found" | "expired";

export function taskLookupError(failure: TaskLookupFailure): ProtocolError {
  return new ProtocolError(
    INVALID_PARAMS,
    failure === "expired"
      ? "Failed to retrieve task: Task has expired"
      : "Failed to retrieve task: Task not found",
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The wire `Task` for a stored record: `ttlMs` is null until the task is terminal. */
export function toWireTask(record: McpTaskRecord): WireTask {
  return {
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage !== null && { statusMessage: record.statusMessage }),
    createdAt: iso(record.createdAtMs),
    lastUpdatedAt: iso(record.lastUpdatedAtMs),
    ttlMs: record.expiresAtMs === null ? null : record.expiresAtMs - record.createdAtMs,
    pollIntervalMs: record.pollIntervalMs,
  };
}

export function toCreateTaskResult(record: McpTaskRecord): CreateTaskResult {
  return { resultType: "task", ...toWireTask(record) };
}

export function toGetTaskResult(record: McpTaskRecord): GetTaskResult {
  const task = toWireTask(record);
  switch (record.status) {
    case "input_required":
      return { resultType: "complete", ...task, inputRequests: record.inputRequests ?? {} };
    case "completed":
      return { resultType: "complete", ...task, result: record.result ?? { content: [] } };
    case "failed":
      return {
        resultType: "complete",
        ...task,
        error: record.error ?? { code: -32603, message: "Internal error" },
      };
    default:
      return { resultType: "complete", ...task };
  }
}
