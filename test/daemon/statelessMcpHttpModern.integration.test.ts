import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
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

function endpoint() {
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
      const server = createStatelessMcpServer(
        {},
        buildMcpRequestContext({ headers: req.headers }),
        scope,
      );
      // Fake feature execution, keeping the production SDK result wrapper and factory intact.
      installToolCallDispatcher(server, {
        progressFailureMessage: "fake progress failed",
        execute: async () => TASK,
      });
      return server;
    },
    cancelScopeExecutions: async () => 0,
    forgetScopeBindings: () => {},
    closeReason: () => "test-end",
  });
}

async function exchange(method: string, params: Record<string, unknown> = {}) {
  const server = endpoint();
  const res = new CapturedResponse();
  await server
    .handle(
      {
        method: "POST",
        headers: {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.name === "string" && { "mcp-name": params.name }),
          accept: "text/event-stream, application/json",
          "content-type": "application/json",
          [MCP_SESSION_KEY_HEADER]: "modern-client",
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
  expect(frame.result.capabilities.resources).toEqual({ listChanged: true });
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

test("preparsed modern bodies above the SDK default body limit remain admitted", async () => {
  const frame = await exchange("tools/call", {
    name: "fake-task",
    arguments: { payload: "x".repeat(4 * 1024 * 1024 + 1) },
  });
  expect(frame.result.resultType).toBe("task");
});
