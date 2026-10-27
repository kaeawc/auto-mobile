import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import {
  classifyInboundRequest,
  McpServer,
  type McpServerFactory,
  type McpHandlerRequestOptions,
  type CreateMcpHandlerOptions,
  type ServerEvent,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
import { ENV, readEnvBool } from "../../src/config/env";
import {
  StatelessMcpHttpEndpoint,
  type McpHttpRequestLike,
  type StatelessMcpRequestScope,
} from "../../src/daemon/statelessMcpHttpEndpoint";
import { MCP_SESSION_KEY_HEADER } from "../../src/daemon/mcpSessionKey";
import { ListChangedBroadcaster } from "../../src/daemon/listChangedBroadcast";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

/** The SDK factory requires an McpServer; transport behavior stays entirely fake. */
class FakeServer extends McpServer {
  constructor() {
    super({ name: "fake-factory", version: "1" });
  }
  override async connect(): Promise<void> {}
  override async close(): Promise<void> {}
}

class FakeResponse extends EventEmitter {
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

const modernBody = {
  jsonrpc: "2.0",
  id: 7,
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

const listenBody = {
  ...modernBody,
  method: "subscriptions/listen",
  params: { ...modernBody.params, notifications: { toolsListChanged: true } },
};

const endpoints: Array<{ clear(): void }> = [];
afterEach(() => {
  for (const endpoint of endpoints.splice(0)) {
    endpoint.clear();
  }
});

function claimedInput(body: unknown) {
  return { httpMethod: "POST", body } as Parameters<typeof classifyInboundRequest>[0];
}

function harness(flag?: string, block = false) {
  const env = flag === undefined ? {} : { [ENV.MCP_MODERN_ERA.name]: flag };
  const timer = new FakeTimer();
  const scopes: StatelessMcpRequestScope[] = [];
  const inherited = new AsyncLocalStorage<string>();
  const seenContexts: Array<string | undefined> = [];
  const sdk = new FakeServer();
  const createServer = mock((_req: McpHttpRequestLike, scope: StatelessMcpRequestScope) => {
    scopes.push(scope);
    seenContexts.push(inherited.getStore());
    return sdk;
  });
  const legacyHandle = mock(async () => {});
  const createTransport = mock(() => ({ handleRequest: legacyHandle, close: async () => {} }));
  const classify = mock(classifyInboundRequest);
  const bus = {
    publish: mock((_event: ServerEvent) => {}),
    subscribe: mock((_listener: (event: ServerEvent) => void) => () => {}),
  } satisfies ServerEventBus;
  const createEventBus = mock(() => bus);
  const forget = mock((_scope: string) => {});
  const cancel = mock(async (_scope: string, _reason: unknown) => 1);
  const closed = mock(async () => {});
  const requests: Request[] = [];
  const bodies: unknown[] = [];
  let started!: () => void;
  const fetched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch = mock(
    async (factory: McpServerFactory, req: Request, options?: McpHandlerRequestOptions) => {
      // Cross an async boundary to prove the factory still sees its own request scope.
      await Promise.resolve();
      await factory({ era: "modern", requestInfo: req });
      requests.push(req);
      bodies.push(options?.parsedBody);
      started();
      if (!block) {
        return new Response("data: result €\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      );
    },
  );
  const createHandler = mock((factory: McpServerFactory, _options: CreateMcpHandlerOptions) => ({
    fetch: (req: Request, options?: McpHandlerRequestOptions) => fetch(factory, req, options),
    close: async () => {
      await closed();
      stream?.close();
    },
  }));
  const endpoint = new StatelessMcpHttpEndpoint<
    McpHttpRequestLike,
    FakeResponse,
    ReturnType<typeof createTransport>
  >({
    timer,
    idGenerator: new CountingIdGenerator("scope"),
    keepaliveIntervalMs: 1000,
    createServer,
    createTransport,
    modern: {
      enabled: () => readEnvBool(ENV.MCP_MODERN_ERA, env),
      classify,
      createHandler,
      createEventBus,
      maxListenStreams: 1,
    },
    cancelScopeExecutions: cancel,
    forgetScopeBindings: forget,
    closeReason: () => "shutdown-test",
  });
  endpoints.push(endpoint);
  const error = mock(() => {});
  const request = (key?: string): McpHttpRequestLike => ({
    method: "POST",
    headers: key ? { [MCP_SESSION_KEY_HEADER]: key } : {},
    socket: new EventEmitter(),
  });
  return {
    endpoint,
    timer,
    scopes,
    seenContexts,
    inherited,
    createServer,
    createTransport,
    legacyHandle,
    classify,
    createHandler,
    bus,
    createEventBus,
    forget,
    cancel,
    closed,
    fetched,
    fetch,
    requests,
    bodies,
    request,
    error,
  };
}

beforeAll(() => {
  new FakeServer();
});

describe("opt-in modern HTTP routing", () => {
  test.each([undefined, "", "0", "false", "no", "off"])(
    "flag %s never enters either SDK routing primitive",
    async (flag) => {
      const h = harness(flag);
      const subscribe = spyOn(ListChangedBroadcaster, "subscribe");
      try {
        await h.endpoint.handle(h.request(), new FakeResponse(), listenBody, h.error);
        ListChangedBroadcaster.emit("tools");
        expect(subscribe).not.toHaveBeenCalled();
        expect(h.createEventBus).not.toHaveBeenCalled();
        expect(h.bus.publish).not.toHaveBeenCalled();
        expect(h.classify).not.toHaveBeenCalled();
        expect(h.createHandler).not.toHaveBeenCalled();
        expect(h.legacyHandle).toHaveBeenCalledTimes(1);
        await Promise.all(h.endpoint.inFlightRequests().map((r) => r.close()));
      } finally {
        subscribe.mockRestore();
      }
    },
  );

  test.each(["1", "true", " yes ", "ON"])(
    "flag %s serves SSE with the parsed body and isolated scope",
    async (flag) => {
      const h = harness(flag);
      const res = new FakeResponse();
      await h.inherited.run("caller-context", () =>
        h.endpoint.handle(h.request("client-key"), res, modernBody, h.error),
      );
      expect(h.createHandler).toHaveBeenCalledWith(expect.any(Function), {
        legacy: "reject",
        responseMode: "sse",
        keepAliveMs: 0,
        bus: h.bus,
      });
      expect(h.createTransport).not.toHaveBeenCalled();
      expect(h.bodies[0]).toBe(modernBody);
      expect(h.requests[0].headers.get(MCP_SESSION_KEY_HEADER)).toBe("client-key");
      expect(h.scopes).toEqual([
        { requestScopeId: "scope-1", requestMcpSessionId: "client-key", era: "modern" },
      ]);
      expect(h.seenContexts).toEqual([undefined]);
      expect(res.status).toBe(200);
      expect(res.body).toBe("data: result €\n\n");
      expect(h.endpoint.inFlightCount).toBe(0);
      expect(h.closed).toHaveBeenCalledTimes(1);
      expect(h.forget).not.toHaveBeenCalled();
      expect(h.error).not.toHaveBeenCalled();
    },
  );

  test("one lazy endpoint bus bridges both list changes across per-request handlers", async () => {
    const h = harness("1");
    const subscribe = spyOn(ListChangedBroadcaster, "subscribe");
    try {
      expect(h.createEventBus).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      for (let i = 0; i < 2; i++) {
        await h.endpoint.handle(h.request(), new FakeResponse(), modernBody, h.error);
        expect(h.createHandler.mock.calls[i][1].bus).toBe(h.bus);
      }
      expect(h.createEventBus).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      ListChangedBroadcaster.emit("tools");
      ListChangedBroadcaster.emit("resources");
      expect(h.bus.publish.mock.calls).toEqual([
        [{ kind: "tools_list_changed" }],
        [{ kind: "resources_list_changed" }],
      ]);
      h.endpoint.stopAccepting();
      ListChangedBroadcaster.emit("tools");
      expect(h.bus.publish).toHaveBeenCalledTimes(2);
    } finally {
      subscribe.mockRestore();
    }
  });

  test("disposing an idle endpoint detaches its bridge idempotently", async () => {
    const h = harness("1");
    await h.endpoint.handle(h.request(), new FakeResponse(), modernBody, h.error);
    h.endpoint.clear();
    h.endpoint.clear();
    ListChangedBroadcaster.emit("resources");
    expect(h.bus.publish).not.toHaveBeenCalled();
  });

  test("overlapping fetches keep each factory's session key and request scope", async () => {
    const h = harness("1");
    await Promise.all(
      ["first", "second"].map((key) =>
        h.endpoint.handle(h.request(key), new FakeResponse(), modernBody, h.error),
      ),
    );
    expect(h.scopes.map((scope) => [scope.requestScopeId, scope.requestMcpSessionId])).toEqual([
      ["scope-1", "first"],
      ["scope-2", "second"],
    ]);
    expect(h.endpoint.inFlightCount).toBe(0);
    expect(h.error).not.toHaveBeenCalled();
  });

  test("a failed handler fetch cleans tracking, bindings and the keepalive", async () => {
    const h = harness("1");
    const error = new Error("fake fetch failure");
    h.fetch.mockImplementationOnce(async () => {
      throw error;
    });
    await h.endpoint.handle(h.request(), new FakeResponse(), modernBody, h.error);
    expect(h.error).toHaveBeenCalledWith("Server error", error);
    expect(h.endpoint.inFlightCount).toBe(0);
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.forget).toHaveBeenCalledWith("scope-1");
    expect(h.timer.getMsUntilNextDueEvent()).toBeUndefined();
  });

  test("enabled legacy and rejected classifications retain the legacy path", async () => {
    const h = harness("1");
    for (const body of [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { broken: true }]) {
      await h.endpoint.handle(h.request(), new FakeResponse(), body, h.error);
    }
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.createHandler).not.toHaveBeenCalled();
    expect(h.legacyHandle).toHaveBeenCalledTimes(2);
    await Promise.all(h.endpoint.inFlightRequests().map((r) => r.close()));
  });

  test("a rejected request that claims the modern era is answered by the modern handler", async () => {
    const h = harness("1");
    const claimed = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    };
    expect(h.classify(claimedInput(claimed)).kind).toBe("reject");
    h.classify.mockClear();
    await h.endpoint.handle(h.request(), new FakeResponse(), claimed, h.error);
    expect(h.createHandler).toHaveBeenCalledTimes(1);
    expect(h.legacyHandle).not.toHaveBeenCalled();
    await Promise.all(h.endpoint.inFlightRequests().map((r) => r.close()));
  });

  test("shutdown closes a listen stream and detaches the bridge only when idle", async () => {
    const h = harness("1", true);
    const res = new FakeResponse();
    const pending = h.endpoint.handle(h.request(), res, listenBody, h.error);
    await h.fetched;
    h.endpoint.stopAccepting();
    ListChangedBroadcaster.emit("tools");
    expect(h.bus.publish).toHaveBeenCalledTimes(1);
    const [tracked] = h.endpoint.inFlightRequests();
    expect(tracked.requestScopeId).toBe("scope-1");
    await tracked.close();
    await pending;
    expect(h.cancel).toHaveBeenCalledWith("scope-1", "shutdown-test");
    expect(h.forget).toHaveBeenCalledWith("scope-1");
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.endpoint.inFlightCount).toBe(0);
    expect(res.writableEnded).toBe(true);
    expect(h.timer.getMsUntilNextDueEvent()).toBeUndefined();
    ListChangedBroadcaster.emit("tools");
    expect(h.bus.publish).toHaveBeenCalledTimes(1);
    const later = new FakeResponse();
    await h.endpoint.handle(h.request(), later, modernBody, h.error);
    expect(later.status).toBe(503);
    expect(h.createHandler).toHaveBeenCalledTimes(1);
  });

  test("listen streams past the endpoint cap are refused, and the slot frees on close", async () => {
    const h = harness("1", true);
    const first = h.endpoint.handle(h.request(), new FakeResponse(), listenBody, h.error);
    await h.fetched;
    const refused = new FakeResponse();
    await h.endpoint.handle(h.request(), refused, listenBody, h.error);
    expect(refused.status).toBe(429);
    expect(h.createHandler).toHaveBeenCalledTimes(1);
    await Promise.all(h.endpoint.inFlightRequests().map((r) => r.close()));
    await first;
    const again = h.endpoint.handle(h.request(), new FakeResponse(), listenBody, h.error);
    await Promise.all(Array.from({ length: 10 }, () => Promise.resolve()));
    expect(h.createHandler).toHaveBeenCalledTimes(2);
    await Promise.all(h.endpoint.inFlightRequests().map((r) => r.close()));
    await again;
  });

  test("a separate keyed cancellation POST reaches the modern in-flight index", async () => {
    const h = harness("true", true);
    const pending = h.endpoint.handle(h.request("key"), new FakeResponse(), listenBody, h.error);
    await h.fetched;
    await h.endpoint.handle(
      h.request("key"),
      new FakeResponse(),
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "user cancelled" },
      },
      h.error,
    );
    await pending;
    expect(h.cancel).toHaveBeenCalledWith("scope-1", "user cancelled");
    expect(h.forget).not.toHaveBeenCalled();
    await Promise.all(h.endpoint.inFlightRequests().map((r) => r.close()));
  });

  test.each(["socket", "response"])(
    "%s close aborts a listen stream and its keepalive",
    async (source) => {
      const h = harness("true", true);
      const req = h.request();
      const res = new FakeResponse();
      const pending = h.endpoint.handle(req, res, listenBody, h.error);
      await h.fetched;
      // Let fetch return its response headers before advancing the injected timer.
      await Promise.resolve();
      await Promise.resolve();
      h.timer.advanceTime(1000);
      expect(res.body).toContain(":keepalive");
      // Repeated keepalives leave the long-lived request open.
      h.timer.advanceTime(10_000);
      expect(h.endpoint.inFlightCount).toBe(1);
      expect(h.requests[0].signal.aborted).toBe(false);
      res.destroyed = true;
      if (source === "response") {
        res.emit("close");
      } else if (req.socket instanceof EventEmitter) {
        req.socket.emit("close");
      }
      await pending;
      expect(h.closed).toHaveBeenCalledTimes(1);
      expect(h.requests[0].signal.aborted).toBe(true);
      const body = res.body;
      h.timer.advanceTime(1000);
      expect(res.body).toBe(body);
      expect(h.forget).toHaveBeenCalledTimes(1);
    },
  );
});
