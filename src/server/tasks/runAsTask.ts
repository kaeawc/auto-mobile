import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { JsonObject } from "../../db/mcpTaskRepository";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { ToolCallProgress } from "../toolCallDispatch";
import { toCreateTaskResult, type CreateTaskResult } from "../../daemon/tasks/mcpTasksExtension";
import type { RunningTask, TaskManager } from "../../daemon/tasks/TaskManager";
import {
  noopTaskLeaseKeepalive,
  type TaskLeaseKeepalive,
} from "../../daemon/tasks/taskLeaseKeepalive";

const INTERNAL_ERROR = -32603;

/** What work running as a task can reach, directly or through {@link currentTaskContext}. */
export interface TaskWorkContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  /**
   * Keep this device session's lease alive until its work ends (#4668 decision 2).
   * Idempotent per session: a session already held by this task is not held twice.
   */
  holdDeviceLease(sessionUuid: string): void;
  /** Pause in `input_required` until `tasks/update` answers every request key. */
  requestInput(requests: JsonObject): Promise<JsonObject>;
  setStatusMessage(message: string): Promise<void>;
}

const taskContextStorage = new AsyncLocalStorage<TaskWorkContext>();

/** The task the current async context runs under, if any. */
export function currentTaskContext(): TaskWorkContext | undefined {
  return taskContextStorage.getStore();
}

/**
 * Hold each named device session's lease for the task the current async context runs under;
 * nothing outside a task. Blank entries are skipped.
 */
export function holdTaskDeviceLeases(sessionUuids: Iterable<string | undefined>): void {
  const task = currentTaskContext();
  for (const sessionUuid of task ? sessionUuids : []) {
    if (sessionUuid) {
      task?.holdDeviceLease(sessionUuid);
    }
  }
}

/**
 * As an MCP task the client does not heartbeat for the call: keep the device session it runs on
 * alive until its work ends (#4668). A no-op outside a task or without a session.
 */
export function holdSessionForCurrentTask(sessionUuid: string | undefined): void {
  if (sessionUuid) {
    currentTaskContext()?.holdDeviceLease(sessionUuid);
  }
}

export interface TaskPolicy {
  readonly onCancel: "abort" | "detach";
}

export interface TaskRunOptions {
  /** Whether THIS request declared `io.modelcontextprotocol/tasks` in its `_meta` capabilities. */
  readonly declared: boolean;
  /** The request's session key; a keyless request never gets a task. */
  readonly ownerKey: string | undefined;
  /** Absent where tasks are not served (direct stdio, the proxy). */
  readonly taskManager: TaskManager | undefined;
  readonly toolName: string;
  /** Defaults to cooperative abort. Detached work continues after the task is cancelled. */
  readonly onCancel?: TaskPolicy["onCancel"];
  readonly keepalive?: TaskLeaseKeepalive;
  readonly pollIntervalMs?: number;
}

/**
 * How the work runs. Synchronously: nothing is overridden, the request's own signal and
 * progress echo apply. As a task: the work's signal replaces the request's, which ends when
 * the `CreateTaskResult` is sent. Detached work gets a signal unaffected by `tasks/cancel` (session release or shutdown can still abort it before the handler starts);
 * other work gets the task's signal. Progress ticks become the
 * task's `statusMessage` (the extension carries no `notifications/progress`).
 */
export interface TaskWorkRun {
  readonly signal?: AbortSignal;
  readonly progress?: ToolCallProgress;
  readonly task?: TaskWorkContext;
}

/** The JSON-RPC error a failed task reports: what the synchronous call would have answered. */
export function toJsonRpcError(error: unknown): JsonObject {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code =
    typeof record.code === "number" && Number.isSafeInteger(record.code)
      ? record.code
      : INTERNAL_ERROR;
  const message = error instanceof Error && error.message ? error.message : "Internal error";
  return { code, message, ...(record.data !== undefined && { data: record.data }) };
}

function progressMessage(progress: number, total?: number, message?: string): string {
  const fraction = total === undefined ? `${progress}` : `${progress}/${total}`;
  return message ? `${message} (${fraction})` : `Progress ${fraction}`;
}

function taskWorkContext(
  task: RunningTask,
  holds: Array<() => void>,
  options: TaskRunOptions,
  signal: AbortSignal,
) {
  const keepalive = options.keepalive ?? noopTaskLeaseKeepalive;
  const held = new Set<string>();
  const context: TaskWorkContext = {
    taskId: task.taskId,
    signal,
    holdDeviceLease(sessionUuid) {
      if (held.has(sessionUuid)) {
        return;
      }
      held.add(sessionUuid);
      holds.push(keepalive.hold({ taskId: task.taskId, ownerKey: task.ownerKey, sessionUuid }));
    },
    requestInput: (requests) => task.requestInput(requests),
    setStatusMessage: (message) => task.setStatusMessage(message),
  };
  return context;
}

async function settleTask(
  task: RunningTask,
  work: Promise<CallToolResult>,
  holds: Array<() => void>,
  onCancel: TaskPolicy["onCancel"],
): Promise<void> {
  try {
    const result = await work;
    // A tool usually reports its own abort as an `isError` result; after `tasks/cancel` that
    // is the cancellation landing, not a tool error.
    if (task.cancelRequested && onCancel === "detach" && result.isError === true) {
      logger.warn(`[TASKS] Task ${task.taskId} work failed after cancellation`, result);
    }
    if (task.cancelRequested && (onCancel === "detach" || result.isError === true)) {
      await task.markCancelled();
    } else {
      await task.complete(result as JsonObject);
    }
  } catch (error) {
    if (task.cancelRequested) {
      if (onCancel === "detach") {
        logger.warn(
          `[TASKS] Task ${task.taskId} work failed after cancellation: ${errorMessage(error)}`,
          error,
        );
      }
      await task.markCancelled();
    } else {
      const rpcError = toJsonRpcError(error);
      await task.fail(rpcError, `Tool execution failed: ${String(rpcError.message)}`);
    }
  } finally {
    for (const release of holds.splice(0)) {
      release();
    }
  }
}

/**
 * The generic seam a tool call opts into to run as an MCP task (#4668). When this request
 * declared the extension, carries a session key, and tasks are served here, the task is
 * created durably, the work starts in the background and a `CreateTaskResult` is returned;
 * otherwise the work runs synchronously and its result is returned unchanged. A task's
 * terminal state is what the synchronous call would have produced: the result (including an
 * `isError` result) completes it and a thrown error fails it with that JSON-RPC error. After
 * `tasks/cancel`, a throw or an `isError` result cancels it; a result that still succeeded
 * completes it (cancellation is cooperative). With `onCancel: "detach"`, cancellation marks
 * the task terminal immediately while work continues with an independent signal. Its lease
 * holds last until the work ends, and any later failure is logged.
 */
export async function runAsTask(
  options: TaskRunOptions,
  work: (run: TaskWorkRun) => Promise<CallToolResult>,
): Promise<CallToolResult | CreateTaskResult> {
  const { taskManager, ownerKey } = options;
  if (!options.declared || !taskManager || !ownerKey) {
    return work({});
  }
  const task = await taskManager.create({
    ownerKey,
    toolName: options.toolName,
    ...(options.pollIntervalMs !== undefined && { pollIntervalMs: options.pollIntervalMs }),
  });
  const holds: Array<() => void> = [];
  const onCancel = options.onCancel ?? "abort";
  const signal = onCancel === "detach" ? new AbortController().signal : task.signal;
  const context = taskWorkContext(task, holds, options, signal);
  const detach = () => {
    void task
      .markCancelled(`Task cancelled; ${options.toolName} work continues to completion.`)
      .catch((error) => {
        logger.warn(
          `[TASKS] Task ${task.taskId} cancellation could not be stored: ${errorMessage(error)}`,
          error,
        );
      });
  };
  if (onCancel === "detach") {
    task.signal.addEventListener("abort", detach, { once: true });
  }
  const progress: ToolCallProgress = async (value, total, message) => {
    try {
      await task.setStatusMessage(progressMessage(value, total, message));
    } catch (error) {
      // Best-effort, like a dropped progress notification: it must not fail the task.
      logger.warn(`[TASKS] Task ${task.taskId} progress update failed: ${errorMessage(error)}`);
    }
  };
  const running = taskContextStorage.run(context, () =>
    Promise.resolve().then(() => work({ signal, progress, task: context })),
  );
  void settleTask(task, running, holds, onCancel)
    .catch((error) => {
      logger.warn(
        `[TASKS] Task ${task.taskId} could not be settled: ${errorMessage(error)}`,
        error,
      );
    })
    .finally(() => {
      task.signal.removeEventListener("abort", detach);
    });
  return toCreateTaskResult(task.created);
}
