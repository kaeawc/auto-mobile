import { expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { TASKS_EXTENSION_ID } from "../../../src/daemon/tasks/mcpTasksExtension";
import { deviceChoiceRequest } from "../../../src/server/ambiguousDeviceElicitation";
import {
  createTaskAwareToolCallExecutor,
  taskEligibleByName,
} from "../../../src/server/tasks/toolCallTasks";
import type {
  McpToolCallExtra,
  McpToolCallResult,
  ToolCall,
} from "../../../src/server/toolCallDispatch";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";

const candidates = [
  { deviceId: "device-a", platform: "android" },
  { deviceId: "device-b", platform: "ios" },
];
const refusal: McpToolCallResult = {
  isError: true,
  content: [
    { type: "text", text: JSON.stringify({ code: "ambiguous_device_target", candidates }) },
  ],
};
const success: McpToolCallResult = { content: [{ type: "text", text: "used device-b" }] };
const accepted = { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } };

interface Scenario {
  name: string;
  responses?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  args?: Record<string, unknown>;
  nonAmbiguous?: boolean;
  retry?: boolean;
  noAsk?: boolean;
  cancel?: boolean;
  detach?: boolean;
  retryRefuses?: boolean;
}

const scenarios: Scenario[] = [
  { name: "asks and succeeds", responses: accepted, retry: true },
  { name: "declined", responses: { deviceChoice: { action: "decline" } } },
  { name: "cancelled answer", responses: { deviceChoice: { action: "cancel" } } },
  {
    name: "invalid id",
    responses: { deviceChoice: { action: "accept", content: { deviceId: "other" } } },
  },
  { name: "empty content", responses: { deviceChoice: { action: "accept", content: {} } } },
  { name: "empty answer", responses: { deviceChoice: {} } },
  { name: "null answer", responses: { deviceChoice: null } },
  {
    name: "invalid id type",
    responses: { deviceChoice: { action: "accept", content: { deviceId: 1 } } },
  },
  { name: "no elicitation declared", capabilities: {}, noAsk: true },
  { name: "URL-only elicitation", capabilities: { elicitation: { url: {} } }, noAsk: true },
  { name: "bare elicitation", capabilities: { elicitation: {} }, responses: accepted, retry: true },
  { name: "deviceId given", args: { deviceId: "device-a" }, noAsk: true },
  { name: "non-ambiguous", nonAmbiguous: true, noAsk: true },
  { name: "cancel while waiting", cancel: true },
  { name: "detach cancel while waiting", cancel: true, detach: true },
  { name: "retry refuses without re-asking", responses: accepted, retry: true, retryRefuses: true },
];

function arrange(scenario: Scenario) {
  const manager = new FakeTaskManager();
  const calls: ToolCall<McpToolCallExtra>[] = [];
  const call: ToolCall<McpToolCallExtra> = {
    name: "probe",
    args: scenario.args ?? { value: "preserved" },
    progress: undefined,
    progressToken: undefined,
    extra: {
      signal: new AbortController().signal,
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: {
          ...(scenario.capabilities ?? { elicitation: { form: {} } }),
          extensions: { [TASKS_EXTENSION_ID]: {} },
        },
      },
      sendNotification: async () => {
        throw new Error("Task must not notify its closed request");
      },
    },
  };
  const initialResult = scenario.nonAmbiguous ? success : refusal;
  const retryResult = scenario.retryRefuses ? refusal : success;
  const execute = createTaskAwareToolCallExecutor({
    taskManager: manager,
    ownerKey: "owner",
    eligibleTools: () => ({ onCancel: scenario.detach ? "detach" : "abort" }),
    execute: async (received) => {
      calls.push(received);
      return calls.length === 1 ? initialResult : retryResult;
    },
  });
  return { manager, calls, call, execute, initialResult, retryResult };
}

async function waitForStatus(manager: FakeTaskManager, taskId: string, status: string) {
  for (let turn = 0; turn < 100; turn++) {
    const row = await manager.get("owner", taskId);
    if (row.status === status) {
      return row;
    }
  }
  throw new Error(`Task did not reach ${status}`);
}

for (const scenario of scenarios) {
  test(`task device choice: ${scenario.name}`, async () => {
    const { manager, calls, call, execute, initialResult, retryResult } = arrange(scenario);
    const handle = await execute(call);
    if (!("taskId" in handle) || typeof handle.taskId !== "string") {
      throw new Error("Expected a task handle");
    }
    expect(handle).toMatchObject({ resultType: "task", status: "working" });
    if (!scenario.noAsk) {
      const waiting = await waitForStatus(manager, handle.taskId, "input_required");
      expect(waiting.inputRequests).toEqual({
        deviceChoice: {
          method: "elicitation/create",
          params: deviceChoiceRequest("probe", candidates),
        },
      });
      expect(calls).toHaveLength(1);
      if (scenario.cancel) {
        await manager.cancel("owner", handle.taskId);
      } else {
        await manager.update("owner", handle.taskId, scenario.responses ?? {});
      }
    }
    const done = await waitForStatus(
      manager,
      handle.taskId,
      scenario.cancel ? "cancelled" : "completed",
    );
    expect(done.inputRequests).toBeNull();
    expect(done.error).toBeNull();
    expect(done.result).toEqual(
      scenario.cancel ? null : scenario.retry ? retryResult : initialResult,
    );
    expect(calls).toHaveLength(scenario.retry ? 2 : 1);
    expect(calls[0].extra.envelope).toBeUndefined();
    expect(calls[0].extra.signal).not.toBe(call.extra.signal);
    expect(calls[0].extra.executionScopeId).toBe(`mcp-task:${handle.taskId}`);
    if (scenario.retry) {
      expect(calls[1]).toEqual({ ...calls[0], args: { ...call.args, deviceId: "device-b" } });
    }
    expect(call.args.deviceId).toBe(scenario.args?.deviceId);
  });
}

test("only the creating owner can answer a task device question", async () => {
  const { manager, execute, call, calls } = arrange({ name: "owner" });
  const handle = await execute(call);
  const taskId = String(handle.taskId);
  await waitForStatus(manager, taskId, "input_required");
  await expect(manager.update("foreign-owner", taskId, accepted)).rejects.toThrow("Task not found");
  expect((await manager.get("owner", taskId)).status).toBe("input_required");
  expect(calls).toHaveLength(1);
  await manager.update("owner", taskId, accepted);
  expect((await waitForStatus(manager, taskId, "completed")).result).toEqual(success);
});

test("returns the task handle before executing work that can require a device question", async () => {
  const { manager, call } = arrange({ name: "deferred work" });
  let release!: (result: McpToolCallResult) => void;
  const work = new Promise<McpToolCallResult>((resolve) => {
    release = resolve;
  });
  const execute = createTaskAwareToolCallExecutor({
    taskManager: manager,
    ownerKey: "owner",
    eligibleTools: taskEligibleByName(new Set(["probe"])),
    execute: async () => work,
  });
  const handle = await execute(call);
  const taskId = String(handle.taskId);
  expect(handle).toMatchObject({ resultType: "task", status: "working" });
  expect((await manager.get("owner", taskId)).inputRequests).toBeNull();
  release(refusal);
  await waitForStatus(manager, taskId, "input_required");
  await manager.cancel("owner", taskId);
  await waitForStatus(manager, taskId, "cancelled");
});

test("an unanswered task device question stays input_required; empty updates cannot answer its key", async () => {
  const { manager, execute, call, calls } = arrange({ name: "unattended" });
  const handle = await execute(call);
  const taskId = String(handle.taskId);
  await waitForStatus(manager, taskId, "input_required");
  await manager.update("owner", taskId, {});
  await manager.update("owner", taskId, { unrelated: { action: "accept" } });
  manager.timer.advanceTime(600_000);
  expect((await manager.get("owner", taskId)).status).toBe("input_required");
  expect(calls).toHaveLength(1);
  await manager.cancel("owner", taskId);
  await waitForStatus(manager, taskId, "cancelled");
});

test("synchronous and legacy task calls keep their original refusal", async () => {
  const { manager, call, calls } = arrange({ name: "bypass" });
  const execute = createTaskAwareToolCallExecutor({
    taskManager: manager,
    ownerKey: "owner",
    eligibleTools: taskEligibleByName(new Set(["probe"])),
    execute: async (received) => {
      calls.push(received);
      return refusal;
    },
  });
  const withoutTasks = {
    ...call,
    extra: { ...call.extra, envelope: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } } },
  };
  expect(await execute(withoutTasks)).toBe(refusal);
  expect(await execute({ ...call, name: "ineligible" })).toBe(refusal);
  expect(manager.created).toHaveLength(0);
  const legacyMeta = {
    progressToken: undefined,
    [CLIENT_CAPABILITIES_META_KEY]: {
      extensions: { [TASKS_EXTENSION_ID]: {} },
      elicitation: {},
    },
  };
  const legacy = await execute({
    ...call,
    extra: {
      ...call.extra,
      envelope: undefined,
      _meta: legacyMeta,
    },
  });
  const done = await waitForStatus(manager, String(legacy.taskId), "completed");
  expect(done.result).toEqual(refusal);
  expect(calls).toHaveLength(3);
});
