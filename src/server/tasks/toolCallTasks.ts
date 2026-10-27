import type { McpToolCallExtra, McpToolCallResult, ToolCall } from "../toolCallDispatch";
import { requestDeclaresTasks, type CreateTaskResult } from "../../daemon/tasks/mcpTasksExtension";
import { runAsTask, type TaskPolicy, type TaskWorkRun } from "./runAsTask";
import type { TaskManager } from "../../daemon/tasks/TaskManager";
import type { TaskLeaseKeepalive } from "../../daemon/tasks/taskLeaseKeepalive";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { declaresFormElicitation } from "../ambiguousDeviceElicitation";
import { executeWithDeviceChoice } from "../ambiguousDeviceChoice";
import { classifyElicitationDeclaration, defaultElicitationRecorder } from "../elicitationOutcome";

/**
 * Eligibility and cancellation policy for THIS call, including its arguments (#13090).
 */
export type TaskEligibility = (call: {
  readonly name: string;
  readonly args: Record<string, unknown>;
}) => TaskPolicy | undefined;

/** Adapt a name allowlist to the existing cooperative-abort behavior. */
export function taskEligibleByName(names: ReadonlySet<string>): TaskEligibility {
  return ({ name }) => (names.has(name) ? { onCancel: "abort" } : undefined);
}

const abortEligible = taskEligibleByName(new Set(["startDevice", "executePlan", "installApp"]));

/** Recording stop must finish finalization even after the client stops polling (#13090). */
export const TASK_ELIGIBILITY: TaskEligibility = (call) =>
  call.name === "videoRecording" && call.args.action === "stop"
    ? { onCancel: "detach" }
    : abortEligible(call);

/** The execution scope a task's call registers under instead of its request's scope. */
export const TASK_EXECUTION_SCOPE_PREFIX = "mcp-task:";

type ToolCallExecutor = (call: ToolCall<McpToolCallExtra>) => Promise<McpToolCallResult>;

export interface TaskAwareToolCallDeps {
  readonly execute: ToolCallExecutor;
  readonly taskManager: TaskManager | undefined;
  readonly ownerKey: string | undefined;
  readonly eligibleTools: TaskEligibility;
  readonly keepalive?: TaskLeaseKeepalive;
}

/**
 * The call as the task runs it: the work's signal replaces the request's (which ends once the
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
    const policy = deps.eligibleTools(call);
    if (!policy) {
      return deps.execute(call);
    }
    // asTaskCall removes the request envelope: retain its declaration before entering work.
    const canAsk =
      call.args.deviceId === undefined &&
      declaresFormElicitation(call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY]);
    return runAsTask(
      {
        declared: requestDeclaresTasks({ envelope: call.extra.envelope, meta: call.extra._meta }),
        ownerKey: deps.ownerKey,
        taskManager: deps.taskManager,
        toolName: call.name,
        onCancel: policy.onCancel,
        ...(deps.keepalive && { keepalive: deps.keepalive }),
      },
      async (run) => {
        const taskCall = asTaskCall(call, run);
        const task = run.task;
        if (!task || !canAsk) {
          return deps.execute(taskCall);
        }
        return executeWithDeviceChoice(
          taskCall,
          (retry) => deps.execute(retry),
          async ({ inputRequests }) => ({ responses: await task.requestInput(inputRequests) }),
          {
            recorder: defaultElicitationRecorder,
            declared: classifyElicitationDeclaration(
              call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY],
            ),
          },
        );
      },
    );
  };
}
