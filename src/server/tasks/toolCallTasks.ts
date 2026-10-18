import type { McpToolCallExtra, McpToolCallResult, ToolCall } from "../toolCallDispatch";
import { requestDeclaresTasks, type CreateTaskResult } from "./mcpTasksExtension";
import { runAsTask, type TaskWorkRun } from "./runAsTask";
import type { TaskManager } from "./TaskManager";
import type { TaskLeaseKeepalive } from "./taskLeaseKeepalive";

/**
 * Tools whose `tools/call` may run as an MCP task (#4668). Empty until a tool opts in:
 * `startDevice` is the first (owner decision 2026-10-18), then `executePlan`, `installApp`
 * and recording start/stop. Short interaction tools stay synchronous.
 */
export const TASK_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set<string>();

/** The execution scope a task's call registers under instead of its request's scope. */
export const TASK_EXECUTION_SCOPE_PREFIX = "mcp-task:";

type ToolCallExecutor = (call: ToolCall<McpToolCallExtra>) => Promise<McpToolCallResult>;

export interface TaskAwareToolCallDeps {
  readonly execute: ToolCallExecutor;
  readonly taskManager: TaskManager | undefined;
  readonly ownerKey: string | undefined;
  readonly eligibleTools: ReadonlySet<string>;
  readonly keepalive?: TaskLeaseKeepalive;
}

/**
 * The call as the task runs it: the task's signal replaces the request's (which ends once the
 * `CreateTaskResult` is sent), its execution registers under the task's own scope (the
 * endpoint cancels the request scope's executions on close), progress goes to the task's
 * status message, and nothing is sent on the closed request's notification channel.
 */
function asTaskCall(
  call: ToolCall<McpToolCallExtra>,
  run: TaskWorkRun,
): ToolCall<McpToolCallExtra> {
  if (!run.signal || !run.task) {
    return call;
  }
  return {
    ...call,
    progressToken: undefined,
    progress: run.progress,
    extra: {
      ...call.extra,
      signal: run.signal,
      _meta: undefined,
      envelope: undefined,
      executionScopeId: `${TASK_EXECUTION_SCOPE_PREFIX}${run.task.taskId}`,
      sendNotification: async () => {},
    },
  };
}

/** Wraps the `tools/call` executor so an eligible tool runs through {@link runAsTask}. */
export function createTaskAwareToolCallExecutor(
  deps: TaskAwareToolCallDeps,
): (call: ToolCall<McpToolCallExtra>) => Promise<McpToolCallResult | CreateTaskResult> {
  return (call) => {
    if (!deps.eligibleTools.has(call.name)) {
      return deps.execute(call);
    }
    return runAsTask(
      {
        declared: requestDeclaresTasks({ envelope: call.extra.envelope, meta: call.extra._meta }),
        ownerKey: deps.ownerKey,
        taskManager: deps.taskManager,
        toolName: call.name,
        ...(deps.keepalive && { keepalive: deps.keepalive }),
      },
      (run) => deps.execute(asTaskCall(call, run)),
    );
  };
}
