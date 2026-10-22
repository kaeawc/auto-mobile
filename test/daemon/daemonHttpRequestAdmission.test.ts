import { SessionManager } from "../../src/daemon/sessionManager";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { releasingSessionHarness, releasingSessionId } from "../helpers/releasingSessionHarness";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { logger } from "../../src/utils/logger";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { Daemon } from "../../src/daemon/daemon";
import { FakeDaemonHttpTokenStore } from "../../src/daemon/daemonHttpToken";
import { MCP_STREAMABLE_PATH } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import type {
  HttpBodyRequest,
  HttpListener,
  McpIngressRequest,
  McpIngressTransport,
} from "../../src/daemon/daemonHttpIngress";
import type {
  McpHttpResponseLike,
  StatelessMcpServer,
} from "../../src/daemon/statelessMcpHttpEndpoint";

const port = 41321;
const HTTP_TOKEN = "test-http-token";

class FakeRequest extends EventEmitter implements McpIngressRequest, HttpBodyRequest {
  rawHeaders = ["Authorization", `Bearer ${HTTP_TOKEN}`];
  method = "GET";
  url = MCP_STREAMABLE_PATH;

  constructor(readonly headers: IncomingHttpHeaders) {
    super();
  }

  destroy(): this {
    return this;
  }
}

class FakeResponse extends EventEmitter implements McpHttpResponseLike {
  body = "";
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly headers = new Map<string, string>();
  readonly finished: Promise<void>;
  private finishResponse!: () => void;

  constructor() {
    super();
    this.finished = new Promise((resolve) => {
      this.finishResponse = resolve;
    });
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
    return this;
  }

  write(): boolean {
    return true;
  }

  end(body?: string): this {
    this.body = body ?? "";
    this.writableEnded = true;
    this.emit("finish");
    this.finishResponse();
    return this;
  }
}

class FakeHttpServer extends EventEmitter implements HttpListener {
  readonly listening = false;
  requestTimeout = 0;
  headersTimeout = 0;
  timeout = 0;
  closed = false;
  lastRequest: FakeRequest | undefined;
  private readonly inFlight = new Set<Promise<FakeResponse>>();

  /** Like node:http/Bun: close completes only after in-flight requests finish. */
  close(callback: (error?: Error) => void): this {
    this.closed = true;
    void Promise.all(this.inFlight).then(() => callback());
    return this;
  }

  listen(_port: number, _host: string, callback: () => void): this {
    queueMicrotask(callback);
    return this;
  }

  dispatch(
    headers: IncomingHttpHeaders,
    method = "GET",
    path = MCP_STREAMABLE_PATH,
    body?: string,
  ): Promise<FakeResponse> {
    const request = new FakeRequest({ authorization: `Bearer ${HTTP_TOKEN}`, ...headers });
    this.lastRequest = request;
    request.method = method;
    request.url = path;
    const response = new FakeResponse();
    if (body !== undefined) {
      // Like a socket that buffers the upload: deliver it once the daemon reads the
      // body, which a request held on startup admission does only later.
      const deliver = (event: string | symbol) => {
        if (event !== "end") {
          return;
        }
        request.off("newListener", deliver);
        queueMicrotask(() => {
          request.emit("data", Buffer.from(body));
          request.emit("end");
        });
      };
      request.on("newListener", deliver);
    }
    this.emit("request", request, response);
    const finished = response.finished.then(() => response);
    this.inFlight.add(finished);
    void finished.then(() => this.inFlight.delete(finished));
    return finished;
  }
}

/** Stands in for every request's transport: one fake shared across the stateless requests. */
class FakeTransport implements McpIngressTransport {
  handled = 0;
  closed = 0;
  parsedBodies: unknown[] = [];

  async start(): Promise<void> {}

  async send(): Promise<void> {}

  async handleRequest(
    _req: McpIngressRequest,
    res: McpHttpResponseLike,
    parsedBody?: unknown,
  ): Promise<void> {
    this.handled += 1;
    this.parsedBodies.push(parsedBody);
    res.writeHead(200);
    res.end();
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeMcpServer implements StatelessMcpServer<McpIngressTransport> {
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
}

async function harness(
  sessionManager?: SessionManager,
  observers?: ObserverSessionRegistry,
  { startupComplete = true, timer = new FakeTimer() } = {},
): Promise<{ server: FakeHttpServer; transport: FakeTransport; daemon: Daemon }> {
  const server = new FakeHttpServer();
  const daemon = new Daemon(
    { port, host: "127.0.0.1" },
    {
      timer,
      httpToken: HTTP_TOKEN,
      httpTokenStore: new FakeDaemonHttpTokenStore(),
      httpServerFactory: () => server,
    },
  );
  const transport = new FakeTransport();
  const hooks = daemon.testHooks;
  hooks.publishHttpToken();
  if (sessionManager) {
    hooks.replaceSessionManager(sessionManager);
  }
  if (observers) {
    hooks.replaceObserverSessionRegistry(observers);
  }
  hooks.httpIngress.setMcpTransportFactory(() => transport);
  hooks.httpIngress.setMcpRequestServerFactory(() => new FakeMcpServer());
  await hooks.httpIngress.start();
  if (startupComplete) {
    hooks.resolveStartupCompletion();
    // Let the daemon observe completion so admitted requests take the fast path.
    await Promise.resolve();
  }
  return { server, transport, daemon };
}

const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

/** POST one MCP request, the way every stateless MCP exchange arrives. */
function dispatchMcp(server: FakeHttpServer, headers: IncomingHttpHeaders): Promise<FakeResponse> {
  return server.dispatch(headers, "POST", MCP_STREAMABLE_PATH, TOOLS_LIST);
}

// harness() constructs a Daemon, which initializes the process-wide DaemonState.
afterEach(() => {
  DaemonState.getInstance().reset();
});

describe("Daemon HTTP request admission", () => {
  test.each(["evil.com:41321", "127.0.0.1:41322", undefined])(
    "rejects a non-loopback or mismatched Host header %s before MCP transport",
    async (host) => {
      const { server, transport } = await harness();
      const response = await dispatchMcp(server, { host });
      expect(response.statusCode).toBe(403);
      expect(transport.handled).toBe(0);
    },
  );

  test("rejects a non-empty Origin header before MCP transport", async () => {
    const { server, transport } = await harness();
    const response = await dispatchMcp(server, {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.com",
    });
    expect(response.statusCode).toBe(403);
    expect(transport.handled).toBe(0);
  });

  test.each([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])(
    "forwards loopback Host %s without Origin to a per-request MCP transport",
    async (host) => {
      const { server, transport } = await harness();
      const response = await dispatchMcp(server, { host });
      expect(response.statusCode).toBe(200);
      expect(transport.handled).toBe(1);
      // Stateless (#4678): the request's transport closes with its response.
      for (let turn = 0; turn < 20 && transport.closed === 0; turn++) {
        await Promise.resolve();
      }
      expect(transport.closed).toBe(1);
      expect(response.headers.has("access-control-allow-origin")).toBeFalse();
    },
  );

  test("forwards a loopback MCP POST without Origin and preserves its body", async () => {
    const { server, transport } = await harness();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const response = await server.dispatch(
      { host: `127.0.0.1:${port}` },
      "POST",
      MCP_STREAMABLE_PATH,
      JSON.stringify(body),
    );
    expect(response.statusCode).toBe(200);
    expect(transport.handled).toBe(1);
    expect(transport.parsedBodies).toEqual([body]);
  });

  test("an unknown mcp-session-id is not a 404: no session table exists to miss (#4678)", async () => {
    const { server, transport } = await harness();
    const response = await dispatchMcp(server, {
      host: `127.0.0.1:${port}`,
      "mcp-session-id": "expired-before-a-restart",
    });
    expect(response.statusCode).toBe(200);
    expect(transport.handled).toBe(1);
  });

  test.each(["GET", "DELETE"])(
    "%s answers 405: there is no session stream (#4678)",
    async (method) => {
      const { server, transport } = await harness();
      const response = await server.dispatch({ host: `127.0.0.1:${port}` }, method);
      expect(response.statusCode).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(transport.handled).toBe(0);
    },
  );

  test("preflight does not expose wildcard CORS", async () => {
    const { server } = await harness();
    const response = await server.dispatch({ host: `127.0.0.1:${port}` }, "OPTIONS");
    expect(response.statusCode).toBe(200);
    expect(response.headers.has("access-control-allow-origin")).toBeFalse();
  });

  test("rejects a non-loopback Host on the heartbeat path", async () => {
    const { server } = await harness();
    const response = await server.dispatch({ host: "evil.com:41321" }, "OPTIONS", "/heartbeat");
    expect(response.statusCode).toBe(403);
  });
});

describe("Daemon HTTP MCP admission during startup (#11156)", () => {
  const headers = { host: `127.0.0.1:${port}` };

  test("holds an MCP request until startup and rehydration complete", async () => {
    const { server, transport, daemon } = await harness(undefined, undefined, {
      startupComplete: false,
    });
    let answered = false;
    const response = dispatchMcp(server, headers).then((result) => {
      answered = true;
      return result;
    });
    await Bun.sleep(0);
    expect(answered).toBeFalse();
    expect(transport.handled).toBe(0);

    daemon.testHooks.resolveStartupCompletion();
    expect((await response).statusCode).toBe(200);
    expect(transport.handled).toBe(1);
  });

  test("answers 503 with Retry-After when startup outlives the admission bound", async () => {
    const timer = new FakeTimer();
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { server, transport } = await harness(undefined, undefined, {
        startupComplete: false,
        timer,
      });
      const response = dispatchMcp(server, headers);
      for (let turn = 0; turn < 20 && timer.getPendingTimeoutCount() === 0; turn++) {
        await Promise.resolve();
      }
      expect(timer.getPendingTimeoutCount()).toBeGreaterThan(0);
      timer.advanceTime(30_000);
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(result.headers.get("retry-after")).toBe("1");
      expect(JSON.parse(result.body)).toEqual({ error: "Daemon is still starting" });
      expect(transport.handled).toBe(0);
    } finally {
      warnings.mockRestore();
    }
  });

  test("answers 503 when startup fails", async () => {
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { server, transport, daemon } = await harness(undefined, undefined, {
        startupComplete: false,
      });
      const response = dispatchMcp(server, headers);
      daemon.testHooks.rejectStartupCompletion(new Error("rehydration exploded"));
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body)).toEqual({ error: "Daemon startup failed" });
      expect(transport.handled).toBe(0);
    } finally {
      warnings.mockRestore();
    }
  });
});

describe("Daemon HTTP MCP admission during shutdown (#11189)", () => {
  const headers = { host: `127.0.0.1:${port}` };

  test("shutdown answers a request held on startup with 503 so the HTTP server can close", async () => {
    const infos = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const { server, transport, daemon } = await harness(undefined, undefined, {
        startupComplete: false,
      });
      let answered = false;
      const response = dispatchMcp(server, headers).then((result) => {
        answered = true;
        return result;
      });
      await Bun.sleep(0);
      expect(answered).toBeFalse();

      await daemon.testHooks.quiesceProvisioningIngress();
      let closed = false;
      void daemon.testHooks.httpIngress.closeListener().then(() => {
        closed = true;
      });
      for (let turn = 0; turn < 20 && !closed; turn++) {
        await Promise.resolve();
      }
      // Startup never completed: before #11189 the held request kept the close pending.
      expect(closed).toBeTrue();
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body)).toEqual({ error: "Daemon is shutting down" });
      expect(transport.handled).toBe(0);
    } finally {
      infos.mockRestore();
    }
  });

  test("a post-bind startup failure answers held requests before awaiting the stop", async () => {
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const { server, transport, daemon } = await harness(undefined, undefined, {
        startupComplete: false,
      });
      const response = dispatchMcp(server, headers);
      await Bun.sleep(0);
      const failure = new Error("rehydration exploded");
      let stopEntered = false;
      // The real stop awaits the HTTP server close, which waits for the held request.
      daemon.testHooks.overrideStartupStages({
        startThroughSocketBind: async () => {},
        startAfterSocketBind: async () => {
          throw failure;
        },
        stopAfterFailedStartup: async () => {
          stopEntered = true;
          await daemon.testHooks.httpIngress.closeListener();
        },
      });
      let startError: unknown;
      await daemon.testHooks.startUntilReady().catch((error: unknown) => {
        startError = error;
      });
      expect(stopEntered).toBeTrue();
      expect(startError).toBe(failure);
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body)).toEqual({ error: "Daemon startup failed" });
      expect(transport.handled).toBe(0);
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("HTTP heartbeat during release", () => {
  for (const phase of ["A", "B"] as const) {
    test(`heartbeat refuses Phase ${phase}, drains release, then 404s the released session`, async () => {
      const h = releasingSessionHarness();
      const heartbeat = spyOn(h.manager, "recordHeartbeat");
      try {
        const session = await h.create();
        const { server } = await harness(h.manager);
        const send = () =>
          server.dispatch(
            { host: `127.0.0.1:${port}` },
            "POST",
            "/heartbeat",
            JSON.stringify({ sessionId: releasingSessionId }),
          );
        const healthy = await send();
        expect(healthy.statusCode).toBe(200);
        expect(healthy.body).toBe('{"status":"ok"}');
        expect(heartbeat).toHaveBeenCalledTimes(1);
        heartbeat.mockClear();
        const finish = await h.beginRelease(phase);
        const writes = h.persistence.activityWrites;
        const lastHeartbeat = session.lastHeartbeat;
        const response = await send();
        const called = heartbeat.mock.calls.length;
        await finish();
        expect(response.statusCode).toBe(404);
        expect(response.body).toBe(
          JSON.stringify({
            error: `Session not found: ${releasingSessionId}`,
            ...(phase === "B" ? { releaseReason: "explicit-release" } : {}),
          }),
        );
        expect(called).toBe(0);
        const after = await send();
        // A released session is gone: the client must learn that, like the socket route.
        expect(after.statusCode).toBe(404);
        expect(after.body).toBe(
          JSON.stringify({
            error: `Session not found: ${releasingSessionId}`,
            releaseReason: "explicit-release",
          }),
        );
        expect(heartbeat).toHaveBeenCalledTimes(0);
        // The unknown-session refusal is a liveness no-op, including when the
        // missing UUID has an explicit terminal snapshot.
        expect(h.persistence.activityWrites).toBe(writes);
        expect(session.lastHeartbeat).toBe(lastHeartbeat);
        expect(h.manager.getSession(releasingSessionId)).toBeNull();
        expect(h.manager.isAdmittedForAutomation(session)).toBe(false);
      } finally {
        heartbeat.mockRestore();
        h.dispose();
      }
    });
  }

  test("HTTP heartbeat keeps observer and rebind behavior", async () => {
    const h = releasingSessionHarness();
    try {
      const { server } = await harness(h.manager, h.observers);
      const send = () =>
        server.dispatch(
          { host: `127.0.0.1:${port}` },
          "POST",
          "/heartbeat",
          JSON.stringify({ sessionId: releasingSessionId }),
        );
      h.observers.register(releasingSessionId, "desktop");
      expect((await send()).statusCode).toBe(200);
      await h.create();
      h.persistence.deferUpsert = true;
      const rebind = h.manager.rebindSession(releasingSessionId, "emulator-5556", "android");
      await h.persistence.upsertStarted.promise;
      expect((await send()).statusCode).toBe(200);
      h.persistence.finishUpsert.resolve();
      await rebind;
    } finally {
      h.dispose();
    }
  });
});

test("HTTP heartbeat 404s a session id the daemon never knew, like the socket route", async () => {
  const h = releasingSessionHarness();
  const heartbeat = spyOn(h.manager, "recordHeartbeat");
  try {
    const { server } = await harness(h.manager, h.observers);
    const send = () =>
      server.dispatch(
        { host: `127.0.0.1:${port}` },
        "POST",
        "/heartbeat",
        JSON.stringify({ sessionId: "never-created" }),
      );
    const response = await send();
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(JSON.stringify({ error: "Session not found: never-created" }));
    expect(heartbeat).not.toHaveBeenCalled();
    const socket = await handleDaemonRequest(
      {
        id: "unknown",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: { sessionId: "never-created" },
      },
      h.state,
    );
    expect(socket).toMatchObject({ success: false, error: "Session not found: never-created" });
    // A live observer session with that id still heartbeats.
    h.observers.register("never-created", "desktop");
    expect((await send()).statusCode).toBe(200);
  } finally {
    heartbeat.mockRestore();
    h.dispose();
  }
});

test("HTTP heartbeat accepts an unregistered non-releasing object", async () => {
  const h = releasingSessionHarness();
  const heartbeat = spyOn(h.manager, "recordHeartbeat");
  try {
    await h.createUnregisteredSession();
    const { server } = await harness(h.manager);
    const response = await server.dispatch(
      { host: `127.0.0.1:${port}` },
      "POST",
      "/heartbeat",
      JSON.stringify({ sessionId: releasingSessionId }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
    expect(heartbeat).toHaveBeenCalledWith(releasingSessionId);
  } finally {
    heartbeat.mockRestore();
    h.dispose();
  }
});

describe("HTTP heartbeat on a proxy-owned session", () => {
  test.each([
    ["owner", "owner", true],
    // Pins: rejected proofs stay no-ops, including missing, blank and non-string tokens.
    ["owner", "rival", false],
    ["owner", undefined, false],
    ["owner", "   ", false],
    ["owner", 42, false],
    [undefined, "junit-owner", true],
    // Pin: a tokenless session still accepts its legacy tokenless heartbeat.
    [undefined, undefined, true],
  ] as const)("HTTP owner %p with token %p records=%p", async (owner, token, records) => {
    const h = releasingSessionHarness();
    try {
      const session = await h.create();
      session.livenessOwnerToken = owner;
      const before = session.lastHeartbeat;
      h.timer.advanceTime(100);
      const { server } = await harness(h.manager);
      const response = await server.dispatch(
        { host: `127.0.0.1:${port}` },
        "POST",
        "/heartbeat",
        JSON.stringify({ sessionId: releasingSessionId, livenessOwnerToken: token }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"status":"ok"}');
      expect(session.lastHeartbeat).toBe(records ? h.timer.now() : before);
      expect(session.hasReceivedHeartbeat).toBe(records);
      expect(session.livenessOwnerToken).toBe<unknown>(owner ?? token);
      expect(session.livenessOwnershipClaims?.size ?? 0).toBe(0);
    } finally {
      h.dispose();
    }
  });

  for (const kind of ["token-owned", "claim-pending"] as const) {
    test(`tokenless HTTP heartbeat is a 200 no-op on a ${kind} session`, async () => {
      const h = releasingSessionHarness();
      const heartbeat = spyOn(h.manager, "recordHeartbeat");
      try {
        const session = await h.createUnregisteredSession();
        if (kind === "token-owned") {
          session.livenessOwnerToken = "proxy-token";
        } else {
          session.livenessOwnershipClaims = new Set(["proxy-token"]);
        }
        const ownerHeartbeat = session.lastOwnerHeartbeat;
        const lastHeartbeat = session.lastHeartbeat;
        const { server } = await harness(h.manager);
        const response = await server.dispatch(
          { host: `127.0.0.1:${port}` },
          "POST",
          "/heartbeat",
          JSON.stringify({ sessionId: releasingSessionId }),
        );
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe('{"status":"ok"}');
        expect(heartbeat).not.toHaveBeenCalled();
        expect(session.lastOwnerHeartbeat).toBe(ownerHeartbeat);
        expect(session.lastHeartbeat).toBe(lastHeartbeat);
      } finally {
        heartbeat.mockRestore();
        h.dispose();
      }
    });
  }
});

test("HTTP request callback handles unexpected rejection before transport dispatch", async () => {
  const warnings = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const { server, transport } = await harness();
    const response = await server.dispatch({ host: `127.0.0.1:${port}` }, "GET", "http://[");
    expect(response.statusCode).toBe(500);
    expect(response.writableEnded).toBeTrue();
    expect(transport.handled).toBe(0);
    expect(
      warnings.mock.calls.some(
        ([message, error]) =>
          String(message).startsWith("HTTP request callback failed:") && error instanceof Error,
      ),
    ).toBeTrue();
  } finally {
    warnings.mockRestore();
  }
});

describe("daemon HTTP bearer authentication", () => {
  /** A daemon whose listener is up but whose token is not published yet. */
  async function unpublishedHarness(timer = new FakeTimer()) {
    const server = new FakeHttpServer();
    const store = new FakeDaemonHttpTokenStore();
    const daemon = new Daemon(
      { port, host: "127.0.0.1" },
      {
        timer,
        httpToken: HTTP_TOKEN,
        httpTokenStore: store,
        httpServerFactory: () => server,
      },
    );
    await daemon.testHooks.httpIngress.start();
    return { server, store, daemon, timer };
  }

  test("holds every path and method until publication without evaluating credentials (#14424)", async () => {
    const { server, store, daemon } = await unpublishedHarness();
    const held: Array<Promise<FakeResponse>> = [];
    const requests: FakeRequest[] = [];
    for (const method of ["GET", "POST", "OPTIONS", "DELETE"]) {
      for (const path of ["/heartbeat", "/unknown", MCP_STREAMABLE_PATH]) {
        held.push(
          server.dispatch({ host: `localhost:${port}`, authorization: "invalid" }, method, path),
        );
        requests.push(server.lastRequest!);
      }
    }
    let answered = 0;
    for (const response of held) {
      void response.then(() => answered++);
    }
    expect((await server.dispatch({ host: "untrusted" })).statusCode).toBe(403);
    expect(
      (await server.dispatch({ host: `localhost:${port}`, origin: "http://untrusted" })).statusCode,
    ).toBe(403);
    await Bun.sleep(0);
    expect(answered).toBe(0);
    expect(requests.every((request) => request.headers.authorization === "invalid")).toBeTrue();
    expect(store.read()).toBeUndefined();

    daemon.testHooks.publishHttpToken();
    daemon.testHooks.resolveStartupCompletion();
    for (const response of await Promise.all(held)) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe('{"error":"Unauthorized"}');
    }
    expect((await server.dispatch({ host: `localhost:${port}` }, "OPTIONS")).statusCode).toBe(200);
  });

  test("a held request with the published token is admitted once startup completes", async () => {
    const { server, daemon } = await unpublishedHarness();
    const response = server.dispatch({ host: `localhost:${port}` }, "OPTIONS");
    await Bun.sleep(0);
    daemon.testHooks.publishHttpToken();
    daemon.testHooks.resolveStartupCompletion();
    expect((await response).statusCode).toBe(200);
  });

  test("answers 503 with Retry-After when publication outlives the startup bound", async () => {
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { server, timer } = await unpublishedHarness();
      const response = server.dispatch({ host: `localhost:${port}` }, "OPTIONS", "/heartbeat");
      for (let turn = 0; turn < 20 && timer.getPendingTimeoutCount() === 0; turn++) {
        await Promise.resolve();
      }
      timer.advanceTime(30_000);
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(result.headers.get("retry-after")).toBe("1");
      expect(JSON.parse(result.body)).toEqual({ error: "Daemon is still starting" });
    } finally {
      warnings.mockRestore();
    }
  });

  test("answers 503 Service unavailable without waiting once the daemon stops accepting", async () => {
    const { server, daemon } = await unpublishedHarness();
    daemon.testHooks.httpIngress.setAcceptingHttpSessions(false);
    const response = await server.dispatch({ host: `localhost:${port}` }, "OPTIONS");
    expect(response.statusCode).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.body).toBe('{"error":"Service unavailable"}');
  });

  test.each(["Bearer", "bearer", "BEARER", "bEaReR"])(
    "accepts the case-insensitive %s scheme",
    async (scheme) => {
      const { server, transport } = await harness();
      const response = await dispatchMcp(server, {
        host: `localhost:${port}`,
        authorization: `${scheme} ${HTTP_TOKEN}`,
      });
      expect(response.statusCode).toBe(200);
      expect(transport.handled).toBe(1);
    },
  );
  test.each([
    undefined,
    "Bearer wrong",
    "Basic test-http-token",
    "Bearer ",
    "Bearer x",
    "Bearer " + "x".repeat(200),
  ])(
    "refuses invalid credentials %s without disclosing the configured token",
    async (authorization) => {
      const logs: unknown[] = [];
      const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
        spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          logs.push(args);
        }),
      );
      try {
        const { server, transport } = await harness();
        const response = await dispatchMcp(server, { host: `localhost:${port}`, authorization });
        expect(response.statusCode).toBe(401);
        expect(response.body).toBe('{"error":"Unauthorized"}');
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        expect(transport.handled).toBe(0);
        expect(JSON.stringify([logs, response.body, [...response.headers]])).not.toContain(
          HTTP_TOKEN,
        );
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    },
  );

  test.each([
    ["OPTIONS", MCP_STREAMABLE_PATH],
    ["POST", "/heartbeat"],
    ["GET", "/unknown"],
  ])("authenticates %s %s before routing", async (method, path) => {
    const { server } = await harness();
    const response = await server.dispatch(
      { host: `localhost:${port}`, authorization: undefined },
      method,
      path,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('{"error":"Unauthorized"}');
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("Host and Origin rejection precedes authentication", async () => {
    const { server } = await harness();
    for (const headers of [
      { host: "example.com", authorization: undefined },
      { host: `localhost:${port}`, origin: "https://example.com", authorization: undefined },
    ]) {
      expect((await server.dispatch(headers)).statusCode).toBe(403);
    }
  });

  test("correct credentials preserve routing and are stripped before MCP dispatch", async () => {
    const { daemon, server, transport } = await harness();
    daemon.testHooks.httpIngress.setMcpRequestServerFactory((req) => {
      expect(req.headers.authorization).toBeUndefined();
      expect(server.lastRequest?.rawHeaders).not.toContain(`Bearer ${HTTP_TOKEN}`);
      return new FakeMcpServer();
    });
    expect((await dispatchMcp(server, { host: `localhost:${port}` })).statusCode).toBe(200);
    expect(transport.handled).toBe(1);
    expect((await server.dispatch({ host: `localhost:${port}` }, "OPTIONS")).statusCode).toBe(200);
    expect(
      (await server.dispatch({ host: `localhost:${port}` }, "GET", "/heartbeat")).statusCode,
    ).toBe(405);
    expect(
      (await server.dispatch({ host: `localhost:${port}` }, "GET", "/unknown")).statusCode,
    ).toBe(404);
  });

  test("refuses to bind without a configured token", async () => {
    const server = new FakeHttpServer();
    const daemon = new Daemon({}, { httpServerFactory: () => server });
    await expect(daemon.testHooks.httpIngress.start()).rejects.toThrow(
      "Daemon HTTP token is not configured",
    );
    expect(server.listenerCount("request")).toBe(0);
  });
});
