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
  await server.handle(
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
  );
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
});

test("real handler serves the shared tools/list", async () => {
  const frame = await exchange("tools/list");
  expect(frame.error).toBeUndefined();
  expect(Array.isArray(frame.result.tools)).toBe(true);
  expect(frame.result.tools.length).toBeGreaterThan(0);
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
