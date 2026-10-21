import type {
  InitializeRequest,
  InitializeResult,
  McpServer,
  Server,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { JsonObject } from "../../db/mcpTaskRepository";
import {
  TASK_ACK,
  TASKS_EXTENSION_ID,
  capabilitiesDeclareTasks,
  missingTasksCapabilityError,
  requestDeclaresTasks,
  taskLookupError,
  toGetTaskResult,
} from "../../daemon/tasks/mcpTasksExtension";
import type { TaskManager } from "../../daemon/tasks/TaskManager";

export interface TasksProtocolDeps {
  readonly taskManager: TaskManager;
  /** The session key this request's tasks belong to; keyless requests own no tasks. */
  readonly ownerKey: string | undefined;
}

const taskIdParams = z.looseObject({ taskId: z.string() });
// The SDK lifts a request's top-level `inputResponses` to `ctx.mcpReq.inputResponses`
// before the handler runs (multi round-trip material), so it is optional here.
const updateParams = z.looseObject({
  taskId: z.string(),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
});

type InitializeHandler = (request: InitializeRequest) => Promise<InitializeResult>;

/**
 * Our servers speak the 2025-era wire (`initialize`), where `server/discover` does not exist,
 * so the extension is advertised on the `initialize` result, and only to a client whose
 * `initialize` declared it (in `capabilities.extensions` or the per-request `_meta`
 * capabilities). A client that does not declare it sees the `initialize` result unchanged. The
 * stdio proxy installs it too, because it relays the extension to the daemon.
 *
 * The advertisement is deliberately not gated on the client's `protocolVersion`. SEP-2663
 * leaves the extension undefined on `2025-11-25`, but with no 2026-era `server/discover` path a
 * version gate would leave no client able to negotiate Tasks. Serving it on the 2025-era
 * `initialize` is a documented AutoMobile extension of the spec (owner decision, #13143; see
 * docs/design-docs/mcp/sdk-v2-stateless-migration.md).
 */
export function advertiseTasksOnDeclaringInitialize(inner: Server): void {
  const initialize: InitializeHandler = inner["_oninitialize"].bind(inner);
  inner.setRequestHandler("initialize", async (request, ctx) => {
    const result = await initialize(request);
    const declared = capabilitiesDeclareTasks(request.params.capabilities) || declaredBy(ctx);
    if (!declared) {
      return result;
    }
    return {
      ...result,
      capabilities: {
        ...result.capabilities,
        extensions: { ...result.capabilities.extensions, [TASKS_EXTENSION_ID]: {} },
      },
    };
  });
}

function declaredBy(ctx: ServerContext): boolean {
  return requestDeclaresTasks({ envelope: ctx.mcpReq.envelope, meta: ctx.mcpReq._meta });
}

/** `-32021` unless THIS request declared the extension (spec: required on every tasks/* call). */
function requireDeclared(ctx: ServerContext): void {
  if (!declaredBy(ctx)) {
    throw missingTasksCapabilityError();
  }
}

function ownerKeyOf(deps: TasksProtocolDeps): string {
  if (!deps.ownerKey) {
    throw taskLookupError("not_found");
  }
  return deps.ownerKey;
}

/**
 * Serves the Tasks extension (#4668) on one server: `tasks/get`, `tasks/update` and
 * `tasks/cancel`, scoped to the request's session key, plus the `initialize` advertisement.
 */
export function installTasksProtocol(server: McpServer, deps: TasksProtocolDeps): void {
  const inner = server.server;
  advertiseTasksOnDeclaringInitialize(inner);
  inner.setRequestHandler("tasks/get", { params: taskIdParams }, async (params, ctx) => {
    requireDeclared(ctx);
    const record = await deps.taskManager.get(ownerKeyOf(deps), params.taskId);
    return toGetTaskResult(record);
  });
  inner.setRequestHandler("tasks/update", { params: updateParams }, async (params, ctx) => {
    requireDeclared(ctx);
    const inputResponses: JsonObject = ctx.mcpReq.inputResponses ?? params.inputResponses ?? {};
    await deps.taskManager.update(ownerKeyOf(deps), params.taskId, inputResponses);
    return TASK_ACK;
  });
  inner.setRequestHandler("tasks/cancel", { params: taskIdParams }, async (params, ctx) => {
    requireDeclared(ctx);
    await deps.taskManager.cancel(ownerKeyOf(deps), params.taskId);
    return TASK_ACK;
  });
}
