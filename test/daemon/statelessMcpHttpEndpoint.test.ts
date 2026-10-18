import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  StatelessMcpHttpEndpoint,
  readInBandMcpSessionId,
  type StatelessMcpRequestScope,
} from "../../src/daemon/statelessMcpHttpEndpoint";
import { MCP_SESSION_KEY_HEADER } from "../../src/server/mcpSessionKey";
import { createSdkMcpServer } from "../../src/server/sdkMcpServer";
import type { ExecutionCancellationReason } from "../../src/server/executionTracker";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

const PATH = "/auto-mobile/streamable";

class FakeSocket extends EventEmitter {}

class FakeRequest {
  readonly method = "POST";
  readonly headers = {};
  readonly socket = new FakeSocket();
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(): this {
    this.headersSent = true;
    return this;
  }
  write(): boolean {
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
}

/** A transport whose one request stays open until the transport closes. */
class BlockingTransport {
  private markStarted!: () => void;
  private markClosed!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  readonly closed = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  async handleRequest(): Promise<void> {
    this.markStarted();
    await this.closed;
  }

  async close(): Promise<void> {
    this.markClosed();
  }
}

/** Records request-scope cancellations and aborts the work each scope registered. */
class FakeScopeExecutions {
  readonly cancelled: Array<{ scope: string; reason: ExecutionCancellationReason }> = [];
  private readonly running = new Map<string, AbortController>();

  start(scope: string): AbortSignal {
    const controller = new AbortController();
    this.running.set(scope, controller);
    return controller.signal;
  }

  async cancel(scope: string, reason: ExecutionCancellationReason): Promise<number> {
    const controller = this.running.get(scope);
    this.running.delete(scope);
    if (!controller) {
      return 0;
    }
    this.cancelled.push({ scope, reason });
    controller.abort(reason);
    return 1;
  }
}

interface Harness {
  readonly url: string;
  readonly endpoint: StatelessMcpHttpEndpoint;
  readonly executions: FakeScopeExecutions;
  readonly scopes: StatelessMcpRequestScope[];
  readonly serversClosed: () => number;
  readonly blockStarted: Promise<void>;
  closeReason: ExecutionCancellationReason;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A real node:http listener in front of the endpoint, with a small SDK server per
 * request: `echo` answers (with a progress notification first), `block` holds until
 * its request scope is cancelled.
 */
async function harness(): Promise<Harness> {
  const executions = new FakeScopeExecutions();
  const scopes: StatelessMcpRequestScope[] = [];
  let closed = 0;
  let markBlockStarted!: () => void;
  const blockStarted = new Promise<void>((resolve) => {
    markBlockStarted = resolve;
  });
  const state = { closeReason: "streamable_http_onclose" as ExecutionCancellationReason };
  const endpoint = new StatelessMcpHttpEndpoint<
    IncomingMessage,
    ServerResponse,
    NodeStreamableHTTPServerTransport
  >({
    timer: new FakeTimer(),
    idGenerator: new CountingIdGenerator("scope"),
    keepaliveIntervalMs: 30_000,
    createTransport: () => new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
    createServer: (_req, scope) => {
      scopes.push(scope);
      const server = createSdkMcpServer({ name: "test", version: "1.0.0" }, { tools: {} });
      server.server.setRequestHandler("tools/list", async () => ({ tools: [] }));
      server.server.setRequestHandler("tools/call", async (request, ctx) => {
        const progressToken = request.params._meta?.progressToken;
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken, progress: 1, total: 2 },
          });
        }
        if (request.params.name === "block") {
          const signal = executions.start(scope.requestScopeId);
          markBlockStarted();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          return { content: [{ type: "text", text: "cancelled" }] };
        }
        return { content: [{ type: "text", text: `echo ${scope.requestMcpSessionId ?? "-"}` }] };
      });
      const close = server.close.bind(server);
      server.close = async () => {
        closed += 1;
        await close();
      };
      return server;
    },
    cancelScopeExecutions: (scope, reason) => executions.cancel(scope, reason),
    closeReason: () => state.closeReason,
  });
  const httpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      void endpoint.handle(req, res, text ? JSON.parse(text) : undefined, () => {});
    });
  });
  servers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${PATH}`,
    endpoint,
    executions,
    scopes,
    serversClosed: () => closed,
    blockStarted,
    get closeReason() {
      return state.closeReason;
    },
    set closeReason(reason) {
      state.closeReason = reason;
    },
  };
}

async function connect(url: string, sessionKey?: string): Promise<Client> {
  const client = new Client({ name: "stateless-test", version: "1.0.0" });
  const headers: Record<string, string> = sessionKey
    ? { [MCP_SESSION_KEY_HEADER]: sessionKey }
    : {};
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  return client;
}

const POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("StatelessMcpHttpEndpoint (#4678)", () => {
  test("a legacy initialize then tools/call works with no session header, and no response carries mcp-session-id", async () => {
    const h = await harness();
    const initialize = await fetch(h.url, {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "desktop", version: "1" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    expect(await initialize.text()).toContain('"protocolVersion":"2025-06-18"');

    const initialized = await fetch(h.url, {
      method: "POST",
      headers: { ...POST_HEADERS, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();

    // A fresh server that never saw initialize answers the call.
    const call = await fetch(h.url, {
      method: "POST",
      headers: { ...POST_HEADERS, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { __mcpSessionId: "in-band-key" } },
      }),
    });
    expect(call.status).toBe(200);
    expect(call.headers.get("mcp-session-id")).toBeNull();
    expect(await call.text()).toContain("echo in-band-key");
    expect(h.scopes.map((scope) => scope.requestScopeId)).toEqual([
      "scope-1",
      "scope-2",
      "scope-3",
    ]);
    expect(h.endpoint.inFlightCount).toBe(0);
    expect(h.serversClosed()).toBe(3);
  });

  test("the SDK client connects, lists and calls; the header key wins over the in-band key", async () => {
    const h = await harness();
    const client = await connect(h.url, "socket-session");
    expect(await client.listTools()).toEqual({ tools: [] });
    const result = await client.callTool({
      name: "echo",
      arguments: { __mcpSessionId: "in-band-key" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo socket-session" }]);
    await client.close();
    expect(h.scopes.every((scope) => scope.requestMcpSessionId === "socket-session")).toBeTrue();
  });

  test("progress notifications arrive on the POST's own SSE stream", async () => {
    const h = await harness();
    const client = await connect(h.url);
    const progress: number[] = [];
    await client.callTool(
      { name: "echo", arguments: {} },
      { onprogress: (update) => progress.push(update.progress) },
    );
    await client.close();
    expect(progress).toEqual([1]);
  });

  test("GET and DELETE answer 405: there is no session stream", async () => {
    const h = await harness();
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(h.url, { method, headers: { accept: "text/event-stream" } });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }
    expect(h.scopes).toEqual([]);
  });

  test("notifications/cancelled on a later POST cancels the in-flight request in process", async () => {
    const h = await harness();
    const client = await connect(h.url, "socket-session");
    const controller = new AbortController();
    const call = client
      .callTool({ name: "block", arguments: {} }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await h.blockStarted;
    const blockScope = h.scopes.at(-1)!.requestScopeId;
    controller.abort("caller gave up");
    expect(await call).toBeDefined();
    // The cancellation POST resolves the request by session key + JSON-RPC id.
    for (let turn = 0; turn < 50 && h.executions.cancelled.length === 0; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(h.executions.cancelled).toEqual([{ scope: blockScope, reason: "caller gave up" }]);
    await client.close();
  });

  test.each(["response", "socket"] as const)(
    "a %s close before the answer cancels the request with the close reason",
    async (source) => {
      // Fakes: Bun's node:http never reports a POST client's disconnect, so the
      // close events are driven directly here.
      const executions = new FakeScopeExecutions();
      const transport = new BlockingTransport();
      const endpoint = new StatelessMcpHttpEndpoint<FakeRequest, FakeResponse, BlockingTransport>({
        timer: new FakeTimer(),
        idGenerator: new CountingIdGenerator("scope"),
        keepaliveIntervalMs: 30_000,
        createTransport: () => transport,
        createServer: (_req, scope) => {
          executions.start(scope.requestScopeId);
          return { connect: async () => {}, close: async () => {} };
        },
        cancelScopeExecutions: (scope, reason) => executions.cancel(scope, reason),
        closeReason: () => "streamable_http_onclose",
      });
      const req = new FakeRequest();
      const res = new FakeResponse();
      const handled = endpoint.handle(
        req,
        res,
        { jsonrpc: "2.0", id: 1, method: "tools/call" },
        () => {},
      );
      await transport.started;
      expect(endpoint.inFlightCount).toBe(1);
      (source === "response" ? res : req.socket).emit("close");
      await transport.closed;
      await handled;
      expect(executions.cancelled).toEqual([
        { scope: "scope-1", reason: "streamable_http_onclose" },
      ]);
      expect(endpoint.inFlightCount).toBe(0);
      expect(req.socket.listenerCount("close")).toBe(0);
    },
  );

  test("shutdown drains in-flight requests with the shutdown reason", async () => {
    const h = await harness();
    const pending = fetch(h.url, {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "block", arguments: {} },
      }),
    }).then((response) => response.text());
    await h.blockStarted;
    const shutdownReason = new Error("daemon handoff");
    h.closeReason = shutdownReason;
    const inFlight = h.endpoint.inFlightRequests();
    expect(inFlight.map((request) => request.requestScopeId)).toEqual(["scope-1"]);
    await Promise.all(inFlight.map((request) => request.close()));
    expect(h.executions.cancelled).toEqual([{ scope: "scope-1", reason: shutdownReason }]);
    expect(h.endpoint.inFlightCount).toBe(0);
    // The closed transport ends the response stream instead of leaving it open.
    expect(typeof (await pending)).toBe("string");
  });
});

describe("readInBandMcpSessionId", () => {
  test("reads the first tools/call __mcpSessionId and ignores everything else", () => {
    expect(
      readInBandMcpSessionId({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "x", arguments: { __mcpSessionId: "key" } },
      }),
    ).toBe("key");
    expect(
      readInBandMcpSessionId([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { arguments: { __mcpSessionId: "b" } },
        },
      ]),
    ).toBe("b");
    expect(
      readInBandMcpSessionId({ params: { arguments: { __mcpSessionId: "" } } }),
    ).toBeUndefined();
    expect(
      readInBandMcpSessionId({ params: { arguments: { __mcpSessionId: 3 } } }),
    ).toBeUndefined();
    expect(readInBandMcpSessionId(undefined)).toBeUndefined();
  });
});
