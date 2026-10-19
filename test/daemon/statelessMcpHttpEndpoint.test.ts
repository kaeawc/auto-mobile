import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { MCP_SESSION_KEY_HEADER } from "../../src/daemon/mcpSessionKey";
import { createSdkMcpServer } from "../../src/server/sdkMcpServer";
import type { ExecutionCancellationReason } from "../../src/daemon/executionTracker";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
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
  status: number | undefined;
  writeHead(status: number): this {
    this.headersSent = true;
    this.status = status;
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

  get runningCount(): number {
    return this.running.size;
  }

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
  /** The daemon-scoped binding store double: `echo` binds under the request's key. */
  readonly store: SessionToolBindingStore;
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
  const store = new SessionToolBindingStore();
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
        // Bind as createMcpServer does: under the session key, else the request scope id.
        store.bind(scope.requestMcpSessionId ?? scope.requestScopeId, "device-session");
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
    forgetScopeBindings: (scope) => store.forget(scope),
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
    store,
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

/** Poll `predicate` until it holds, bounded by a real deadline (the HTTP hop is real I/O). */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => defaultTimer.setTimeout(resolve, 2));
  }
}

/** POST a `block` tools/call under `id`, with the session-key header when `sessionKey` is set. */
function postBlock(url: string, id: number, sessionKey?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      ...POST_HEADERS,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionKey ? { [MCP_SESSION_KEY_HEADER]: sessionKey } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "block", arguments: {} },
    }),
  });
}

/** POST a header-less `notifications/cancelled` for `requestId`. */
async function postHeaderlessCancel(url: string, requestId: number): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...POST_HEADERS, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, reason: "header-less cancel" },
    }),
  });
  await response.text();
}

const POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("StatelessMcpHttpEndpoint (#4678)", () => {
  // The SDK client, the node HTTP transport and the SSE parser build their state on first use.
  // That one-time cost belongs to the process, not to whichever test runs first (or alone, in
  // the budget's isolated re-run), so drive one full exchange before the timed tests.
  beforeAll(async () => {
    const h = await harness();
    const client = await connect(h.url, "warm-up");
    await client.listTools();
    await client.callTool({ name: "echo", arguments: {} }, { onprogress: () => {} });
    await client.close();
    const raw = await fetch(h.url, {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "w", version: "1" },
        },
      }),
    });
    await raw.text();
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
    // An HTTP client is never a trusted forwarder: its in-band id cannot override the header (#13315).
    expect(h.scopes.some((scope) => scope.trustedForwarder === true)).toBeFalse();
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

  test("a keyless request's scope-keyed binding is forgotten when it closes; a keyed one stays", async () => {
    const h = await harness();
    const callEcho = async (headers: Record<string, string>, id: number) => {
      const response = await fetch(h.url, {
        method: "POST",
        headers: { ...POST_HEADERS, ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      // The request closes on the response's finish; let its teardown run.
      for (let turn = 0; turn < 50 && h.endpoint.inFlightCount > 0; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    };
    expect(h.store.keyCount).toBe(0);

    await callEcho({}, 1);
    expect(h.scopes.at(-1)?.requestMcpSessionId).toBeUndefined();
    expect(h.store.keyCount).toBe(0);

    await callEcho({ [MCP_SESSION_KEY_HEADER]: "desktop-session" }, 2);
    expect(h.store.keyCount).toBe(1);
    expect(h.store.boundSessionUuid("desktop-session")).toBe("device-session");
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
    await waitFor(() => h.executions.cancelled.length > 0, "the cancellation");
    expect(h.executions.cancelled).toEqual([{ scope: blockScope, reason: "caller gave up" }]);
    await client.close();
  });

  test("a header-less notifications/cancelled cancels the one in-flight request with its id (#13067)", async () => {
    const h = await harness();
    const call = postBlock(h.url, 42, "socket-session");
    await h.blockStarted;
    const blockScope = h.scopes.at(-1)!.requestScopeId;

    await postHeaderlessCancel(h.url, 42);

    await waitFor(() => h.executions.cancelled.length > 0, "the cancellation");
    expect(h.executions.cancelled).toEqual([{ scope: blockScope, reason: "header-less cancel" }]);
    await (await call).text();
  });

  test("a header-less notifications/cancelled whose id two in-flight requests share cancels neither", async () => {
    const h = await harness();
    const first = postBlock(h.url, 7, "socket-a");
    const second = postBlock(h.url, 7, "socket-b");
    await waitFor(() => h.executions.runningCount === 2, "both calls to start");

    await postHeaderlessCancel(h.url, 7);

    expect(h.executions.cancelled).toEqual([]);
    expect(h.executions.runningCount).toBe(2);
    await Promise.all(h.endpoint.inFlightRequests().map((request) => request.close()));
    await Promise.all([first, second].map(async (response) => (await response).text()));
  });

  test("a header-less notifications/cancelled whose id two keyless requests share cancels neither", async () => {
    const h = await harness();
    const first = postBlock(h.url, 9);
    const second = postBlock(h.url, 9);
    await waitFor(() => h.executions.runningCount === 2, "both calls to start");

    await postHeaderlessCancel(h.url, 9);

    expect(h.executions.cancelled).toEqual([]);
    expect(h.executions.runningCount).toBe(2);
    await Promise.all(h.endpoint.inFlightRequests().map((request) => request.close()));
    await Promise.all([first, second].map(async (response) => (await response).text()));
  });

  test("a keyless request finishing leaves the other keyless request cancellable by id", async () => {
    const h = await harness();
    const first = postBlock(h.url, 9);
    const second = postBlock(h.url, 9);
    await waitFor(() => h.executions.runningCount === 2, "both calls to start");
    const [done, remaining] = h.endpoint.inFlightRequests();
    await done.close();
    expect(h.endpoint.inFlightRequests()).toHaveLength(1);

    await postHeaderlessCancel(h.url, 9);

    await waitFor(() => h.executions.cancelled.length > 1, "the cancellation");
    expect(h.executions.cancelled.map((entry) => entry.scope)).toEqual([
      done.requestScopeId,
      remaining.requestScopeId,
    ]);
    await Promise.all([first, second].map(async (response) => (await response).text()));
  });

  test("a cancellation that resumes after shutdown stopped accepting is refused, not served (#13049)", async () => {
    const transport = new BlockingTransport();
    const cancelGate = Promise.withResolvers<number>();
    let serversBuilt = 0;
    const endpoint = new StatelessMcpHttpEndpoint<FakeRequest, FakeResponse, BlockingTransport>({
      timer: new FakeTimer(),
      idGenerator: new CountingIdGenerator("scope"),
      keepaliveIntervalMs: 30_000,
      createTransport: () => transport,
      createServer: () => {
        serversBuilt += 1;
        return { connect: async () => {}, close: async () => {} };
      },
      cancelScopeExecutions: () => cancelGate.promise,
      forgetScopeBindings: () => {},
      closeReason: () => "streamable_http_onclose",
    });
    const keyed = (): FakeRequest =>
      Object.assign(new FakeRequest(), { headers: { [MCP_SESSION_KEY_HEADER]: "socket-1" } });
    const call = endpoint.handle(
      keyed(),
      new FakeResponse(),
      { jsonrpc: "2.0", id: 5, method: "tools/call" },
      () => {},
    );
    await transport.started;
    const cancelResponse = new FakeResponse();
    const cancellation = endpoint.handle(
      keyed(),
      cancelResponse,
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } },
      () => {},
    );

    // Shutdown stops accepting and drops tracking while the cancellation awaits its close.
    endpoint.stopAccepting();
    endpoint.clear();
    cancelGate.resolve(1);
    await cancellation;
    await call;

    expect(cancelResponse.status).toBe(503);
    expect(serversBuilt).toBe(1);
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
        forgetScopeBindings: () => {},
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
