import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { z } from "zod/v4";
import {
  classifyInboundRequest,
  createMcpHandler,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  StatelessMcpHttpEndpoint,
  type McpHttpRequestLike,
  type StatelessMcpTransport,
} from "../../src/daemon/statelessMcpHttpEndpoint";
import {
  createStatelessMcpServer,
  buildMcpRequestContext,
} from "../../src/daemon/statelessMcpServerFactory";
import { MCP_SESSION_KEY_HEADER } from "../../src/daemon/mcpSessionKey";
import { ListChangedBroadcaster } from "../../src/daemon/listChangedBroadcast";
import { ResourceUpdatedBroadcaster } from "../../src/daemon/ResourceUpdatedBroadcasterClass";
import { installToolCallDispatcher } from "../../src/server/toolCallDispatch";
import {
  TASKS_EXTENSION_ID,
  type CreateTaskResult,
} from "../../src/daemon/tasks/mcpTasksExtension";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import * as database from "../../src/db/database";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createDeviceChoiceRequestStateCodec } from "../../src/server/deviceChoiceRequestState";
import { createMcpServer } from "../../src/server";
import { taskEligibleByName } from "../../src/server/tasks/toolCallTasks";
import { FakeTaskManager } from "../fakes/FakeTaskManager";

const requestStateTimer = new FakeTimer();
const requestStateCodec = createDeviceChoiceRequestStateCodec({
  timer: requestStateTimer,
  secretProvider: { createSecret: () => new Uint8Array(32).fill(7) },
});

class CapturedResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }
  write(chunk: string): void {
    this.body += chunk;
    this.emit("chunk", chunk);
  }
  nextChunk(): Promise<string> {
    return new Promise((resolve) => this.once("chunk", resolve));
  }
  end(body = ""): void {
    this.body += body;
    this.writableEnded = true;
    this.emit("finish");
  }
}

let restore: () => void;
let previousFlags: FeatureFlagService | null;
let databaseSpy: ReturnType<typeof spyOn<typeof database, "getDatabase">>;
beforeAll(async () => {
  restore = installHermeticServerFixture();
  previousFlags = FeatureFlagService.peekInstanceForTesting();
  const flags = new FeatureFlagService(
    new FakeFeatureFlagRepository(),
    new FakeFeatureFlagApplier(),
  );
  FeatureFlagService.setInstanceForTesting(flags);
  await flags.initialize();
  databaseSpy = spyOn(database, "getDatabase").mockImplementation(() => {
    throw new Error("Modern HTTP integration must not resolve a file-backed database");
  });
});
afterAll(() => {
  try {
    expect(databaseSpy).not.toHaveBeenCalled();
  } finally {
    databaseSpy.mockRestore();
    FeatureFlagService.setInstanceForTesting(previousFlags);
    restore();
  }
});

const TASK = {
  resultType: "task",
  taskId: "fake-task",
  status: "working",
  createdAt: "2026-10-26T00:00:00Z",
  lastUpdatedAt: "2026-10-26T00:00:00Z",
  ttlMs: null,
  pollIntervalMs: 1000,
} satisfies CreateTaskResult;

const TASK_DEVICE_PROBE = "modernTaskDeviceChoiceProbe";

function endpoint(deviceChoice = false, taskManager?: FakeTaskManager) {
  return new StatelessMcpHttpEndpoint<
    McpHttpRequestLike,
    CapturedResponse,
    StatelessMcpTransport<McpHttpRequestLike, CapturedResponse> & Transport
  >({
    timer: new FakeTimer(),
    idGenerator: new CountingIdGenerator("modern"),
    keepaliveIntervalMs: 1000,
    modern: {
      enabled: () => true,
      classify: classifyInboundRequest,
      createHandler: createMcpHandler,
    },
    createTransport: () => {
      throw new Error("Modern request reached legacy transport");
    },
    createServer: (req: McpHttpRequestLike, scope) => {
      const server = taskManager
        ? createMcpServer({
            era: "modern",
            stateless: true,
            taskOwnerKey: scope.taskOwnerKey,
            requestMcpSessionId: scope.requestMcpSessionId,
            sessionContext: { sessionId: scope.requestScopeId },
            taskManager,
            taskEligibleTools: taskEligibleByName(new Set([TASK_DEVICE_PROBE])),
            deviceChoiceRequestState: requestStateCodec,
          })
        : createStatelessMcpServer(
            { deviceChoiceRequestState: requestStateCodec },
            buildMcpRequestContext({ headers: req.headers }),
            scope,
          );
      // Fake feature execution, keeping the production SDK result wrapper and factory intact.
      if (!deviceChoice) {
        installToolCallDispatcher(server, {
          progressFailureMessage: "fake progress failed",
          execute: async () => TASK,
        });
      }
      return server;
    },
    cancelScopeExecutions: async () => 0,
    forgetScopeBindings: () => {},
    closeReason: () => "test-end",
  });
}

async function exchange(
  method: string,
  params: Record<string, unknown> = {},
  deviceChoice = false,
  sessionKey = "modern-client",
  taskManager?: FakeTaskManager,
) {
  const server = endpoint(deviceChoice, taskManager);
  const res = new CapturedResponse();
  await server
    .handle(
      {
        method: "POST",
        headers: {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.name === "string" && { "mcp-name": params.name }),
          ...(typeof params.taskId === "string" && { "mcp-name": params.taskId }),
          accept: "text/event-stream, application/json",
          "content-type": "application/json",
          [MCP_SESSION_KEY_HEADER]: sessionKey,
        },
      },
      res,
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [TASKS_EXTENSION_ID]: {} },
              ...(deviceChoice && { elicitation: { form: {} } }),
            },
          },
        },
      },
      (message, error) => {
        throw new Error(message, { cause: error });
      },
    )
    .finally(() => server.clear());
  expect({ status: res.status, body: res.body }).toMatchObject({ status: 200 });
  expect(res.headers["content-type"]).toContain("text/event-stream");
  expect(server.inFlightCount).toBe(0);
  // Parse SSE framing only; JSON itself is parsed structurally.
  const data = res.body.split("\n").find((line) => line.startsWith("data: "));
  expect(data).toBeDefined();
  return JSON.parse(data!.slice("data: ".length));
}

test("real handler discovers Tasks from the shared modern server factory", async () => {
  const frame = await exchange("server/discover");
  expect(frame.error).toBeUndefined();
  expect(frame.result.capabilities.extensions[TASKS_EXTENSION_ID]).toEqual({});
  expect(frame.result.capabilities.tools).toEqual({ listChanged: true });
  expect(frame.result.capabilities.resources).toEqual({ subscribe: true, listChanged: true });
});

test("legacy server capabilities retain their original JSON bytes", async () => {
  const server = createStatelessMcpServer({}, buildMcpRequestContext({ headers: {} }), {
    era: "legacy",
    requestScopeId: "legacy-capabilities",
    requestMcpSessionId: "legacy-client",
  });
  try {
    expect(JSON.stringify(server.server.getCapabilities())).toBe(
      '{"resources":{"subscribe":true,"listChanged":true},"tools":{"listChanged":true},"prompts":{}}',
    );
  } finally {
    await server.close();
  }
});

test("real listen handler acknowledges a tools filter and receives a bridged list change", async () => {
  const server = endpoint();
  const res = new CapturedResponse();
  const ackChunk = res.nextChunk();
  const pending = server.handle(
    {
      method: "POST",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
        accept: "text/event-stream, application/json",
        "content-type": "application/json",
      },
    },
    res,
    {
      jsonrpc: "2.0",
      id: "listen-tools",
      method: "subscriptions/listen",
      params: {
        notifications: { toolsListChanged: true },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "listen-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    (message, error) => {
      throw new Error(message, { cause: error });
    },
  );
  try {
    const ack = JSON.parse((await ackChunk).split("data: ")[1]);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(ack).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { toolsListChanged: true },
        _meta: { "io.modelcontextprotocol/subscriptionId": "listen-tools" },
      },
    });
    expect(server.inFlightCount).toBe(1);
    const changeChunk = res.nextChunk();
    ListChangedBroadcaster.emit("resources");
    ListChangedBroadcaster.emit("tools");
    const change = JSON.parse((await changeChunk).split("data: ")[1]);
    expect(change).toMatchObject({
      method: "notifications/tools/list_changed",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": "listen-tools" } },
    });
  } finally {
    server.stopAccepting();
    await Promise.all(server.inFlightRequests().map((request) => request.close()));
    await pending;
    server.clear();
  }
  expect(server.inFlightCount).toBe(0);
  expect(res.writableEnded).toBe(true);
});

test("real handler serves the shared tools/list", async () => {
  const frame = await exchange("tools/list");
  expect(frame.error).toBeUndefined();
  expect(Array.isArray(frame.result.tools)).toBe(true);
  expect(frame.result.tools.length).toBeGreaterThan(0);
  // Private: the catalog is filtered per session key, so it must never be cacheable across callers.
  expect(frame.result).toMatchObject({ ttlMs: 5_000, cacheScope: "private" });
});

test("real handler gives server/discover a private cache hint", async () => {
  const frame = await exchange("server/discover");
  expect(frame.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
});

test("real modern tools/call preserves resultType task without content coercion", async () => {
  const frame = await exchange("tools/call", { name: "fake-task", arguments: {} });
  expect(frame.error).toBeUndefined();
  expect(frame.result).toMatchObject(TASK);
  expect(frame.result.content).toBeUndefined();
});

test("real modern handler asks for a device via MRTR and retries on the accepted device", async () => {
  const calls: Array<string | undefined> = [];
  const candidates = [
    { deviceId: "device-a", platform: "android" },
    { deviceId: "device-b", platform: "ios" },
  ];
  ToolRegistry.register(
    "modernDeviceChoiceProbe",
    "Hermetic device-choice probe",
    z.object({ deviceId: z.string().optional() }),
    async ({ deviceId }) => {
      calls.push(deviceId);
      return deviceId
        ? { content: [{ type: "text", text: `used ${deviceId}` }] }
        : {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ code: "ambiguous_device_target", candidates }),
              },
            ],
          };
    },
  );
  try {
    const params = { name: "modernDeviceChoiceProbe", arguments: {} };
    const question = await exchange("tools/call", params, true);
    expect(question.error).toBeUndefined();
    expect(question.result).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        deviceChoice: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "modernDeviceChoiceProbe matched 2 devices. Which device should it use?",
            requestedSchema: {
              required: ["deviceId"],
              properties: {
                deviceId: {
                  oneOf: candidates.map(({ deviceId, platform }) => ({
                    const: deviceId,
                    title: `${deviceId} (${platform})`,
                  })),
                },
              },
            },
          },
        },
      },
    });
    expect(question.result.requestState).toBeString();
    expect(question.result.content).toBeUndefined();

    const result = await exchange(
      "tools/call",
      {
        ...params,
        requestState: question.result.requestState,
        inputResponses: { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } },
      },
      true,
    );
    expect(result.error).toBeUndefined();
    expect(result.result.content).toEqual([{ type: "text", text: "used device-b" }]);
    expect(result.result.isError).toBeFalsy();
    expect(calls).toEqual([undefined, undefined, "device-b"]);
  } finally {
    ToolRegistry.unregister("modernDeviceChoiceProbe");
  }
});

test("real modern task asks through tasks/get and only its owner can answer through tasks/update", async () => {
  const manager = new FakeTaskManager();
  const calls: Array<string | undefined> = [];
  const candidates = [
    { deviceId: "device-a", platform: "android" },
    { deviceId: "device-b", platform: "ios" },
  ];
  ToolRegistry.register(
    TASK_DEVICE_PROBE,
    "Hermetic task device-choice probe",
    z.object({ deviceId: z.string().optional() }),
    async ({ deviceId }) => {
      calls.push(deviceId);
      return deviceId
        ? { content: [{ type: "text", text: `used ${deviceId}` }] }
        : {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ code: "ambiguous_device_target", candidates }),
              },
            ],
          };
    },
  );
  const post = (method: string, params: Record<string, unknown>, owner = "modern-client") =>
    exchange(method, params, true, owner, manager);
  try {
    const created = await post("tools/call", { name: TASK_DEVICE_PROBE, arguments: {} });
    expect(created.error).toBeUndefined();
    expect(created.result).toMatchObject({ resultType: "task", status: "working" });
    expect(created.result.inputRequests).toBeUndefined();
    const taskId: string = created.result.taskId;
    let waiting = await post("tasks/get", { taskId });
    for (let turn = 0; turn < 20 && waiting.result.status === "working"; turn++) {
      waiting = await post("tasks/get", { taskId });
    }
    expect(waiting.result).toMatchObject({
      resultType: "complete",
      status: "input_required",
      inputRequests: {
        deviceChoice: {
          method: "elicitation/create",
          params: {
            mode: "form",
            requestedSchema: {
              required: ["deviceId"],
              properties: {
                deviceId: {
                  oneOf: candidates.map(({ deviceId, platform }) => ({
                    const: deviceId,
                    title: `${deviceId} (${platform})`,
                  })),
                },
              },
            },
          },
        },
      },
    });
    expect(waiting.result.requestState).toBeUndefined();
    expect(calls).toEqual([undefined]);
    const answer = {
      taskId,
      inputResponses: { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } },
    };
    const foreign = await post("tasks/update", answer, "foreign-owner");
    expect(foreign.error).toEqual({
      code: -32602,
      message: "Failed to retrieve task: Task not found",
    });
    expect((await post("tasks/get", { taskId })).result.status).toBe("input_required");
    expect((await post("tasks/update", answer)).result).toMatchObject({ resultType: "complete" });
    let done = await post("tasks/get", { taskId });
    for (let turn = 0; turn < 20 && done.result.status === "working"; turn++) {
      done = await post("tasks/get", { taskId });
    }
    expect(done.result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "used device-b" }] },
    });
    expect(done.result.inputRequests).toBeUndefined();
    expect(calls).toEqual([undefined, "device-b"]);
  } finally {
    for (const task of manager.created) {
      await manager.cancel("modern-client", task.taskId);
    }
    ToolRegistry.unregister(TASK_DEVICE_PROBE);
  }
});

for (const reason of ["tampered", "expired", "different session", "malformed"] as const) {
  test(`real modern handler rejects ${reason} request state before tool execution`, async () => {
    const calls: Array<string | undefined> = [];
    const toolName = "modernInvalidStateProbe";
    ToolRegistry.register(
      toolName,
      "Hermetic invalid-state probe",
      z.object({ deviceId: z.string().optional() }),
      async ({ deviceId }) => {
        calls.push(deviceId);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "ambiguous_device_target",
                candidates: [
                  { deviceId: "device-a", platform: "android" },
                  { deviceId: "device-b", platform: "ios" },
                ],
              }),
            },
          ],
        };
      },
    );
    try {
      const params = { name: toolName, arguments: {} };
      const question = await exchange("tools/call", params, true);
      const state: string = question.result.requestState;
      expect(state).toBeString();
      if (reason === "expired") {
        requestStateTimer.advanceTime(600_000);
      }
      const result = await exchange(
        "tools/call",
        {
          ...params,
          requestState:
            reason === "malformed" ? "invalid" : reason === "tampered" ? `${state}tampered` : state,
          inputResponses: { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } },
        },
        true,
        reason === "different session" ? "other-client" : "modern-client",
      );
      expect(result.error).toEqual({
        code: -32602,
        message: "Invalid or expired requestState",
        data: { reason: "invalid_request_state" },
      });
      expect(result.result).toBeUndefined();
      expect(calls).toEqual([undefined]);
    } finally {
      ToolRegistry.unregister(toolName);
    }
  });
}

test("preparsed modern bodies above the SDK default body limit remain admitted", async () => {
  const frame = await exchange("tools/call", {
    name: "fake-task",
    arguments: { payload: "x".repeat(4 * 1024 * 1024 + 1) },
  });
  expect(frame.result.resultType).toBe("task");
});

function listenToResource(server: ReturnType<typeof endpoint>, uri: string, id: string) {
  const res = new CapturedResponse();
  const ack = res.nextChunk();
  const pending = server.handle(
    {
      method: "POST",
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
        accept: "text/event-stream, application/json",
        "content-type": "application/json",
      },
    },
    res,
    {
      jsonrpc: "2.0",
      id,
      method: "subscriptions/listen",
      params: {
        notifications: { resourceSubscriptions: [uri] },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "resource-listen-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    (message, error) => {
      throw new Error(message, { cause: error });
    },
  );
  return { res, ack, pending };
}

test("real listen streams receive bridged resource updates only for their filtered URI", async () => {
  const server = endpoint();
  const uri = "resource://table?offset=10";
  const unrelated = "resource://other";
  const first = listenToResource(server, uri, "listen-resource");
  const second = listenToResource(server, unrelated, "listen-other");
  try {
    const ack = JSON.parse((await first.ack).split("data: ")[1]);
    await second.ack;
    expect(ack).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { resourceSubscriptions: [uri] },
        _meta: { "io.modelcontextprotocol/subscriptionId": "listen-resource" },
      },
    });
    const initialBody = first.res.body;
    const otherChunk = second.res.nextChunk();
    ResourceUpdatedBroadcaster.emit((subscriptions) =>
      subscriptions.has(unrelated) ? [unrelated] : [],
    );
    const otherChange = JSON.parse((await otherChunk).split("data: ")[1]);
    expect(otherChange.method).toBe("notifications/resources/updated");
    expect(otherChange.params.uri).toBe(unrelated);
    expect(first.res.body).toBe(initialBody);
    const changeChunk = first.res.nextChunk();
    ResourceUpdatedBroadcaster.emit((subscriptions) =>
      [...subscriptions].filter((subscribed) => subscribed.startsWith("resource://table?")),
    );
    expect(JSON.parse((await changeChunk).split("data: ")[1])).toMatchObject({
      method: "notifications/resources/updated",
      params: { uri, _meta: { "io.modelcontextprotocol/subscriptionId": "listen-resource" } },
    });
    expect(second.res.body.match(/notifications\/resources\/updated/g)?.length).toBe(1);
  } finally {
    server.stopAccepting();
    await Promise.all(server.inFlightRequests().map((request) => request.close()));
    await Promise.all([first.pending, second.pending]);
    server.clear();
  }
});
