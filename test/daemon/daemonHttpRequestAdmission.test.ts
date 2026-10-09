import { SessionManager } from "../../src/daemon/sessionManager";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { releasingSessionHarness, releasingSessionId } from "../helpers/releasingSessionHarness";
import { EventEmitter } from "node:events";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { logger } from "../../src/utils/logger";
import { describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { MCP_STREAMABLE_PATH } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";

const port = 41321;

interface DaemonHttpInternals {
  startHttpServer(): Promise<void>;
  sessionManager: SessionManager;
  observerSessionRegistry: ObserverSessionRegistry;
  transports: Map<string, FakeTransport>;
}

class FakeRequest extends EventEmitter {
  method = "GET";
  url = MCP_STREAMABLE_PATH;

  constructor(readonly headers: IncomingHttpHeaders) {
    super();
  }
}

class FakeResponse extends EventEmitter {
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

  end(body?: string): this {
    this.body = body ?? "";
    this.writableEnded = true;
    this.emit("finish");
    this.finishResponse();
    return this;
  }
}

class FakeHttpServer extends EventEmitter {
  requestTimeout = 0;
  headersTimeout = 0;
  timeout = 0;

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
    const request = new FakeRequest(headers);
    request.method = method;
    request.url = path;
    const response = new FakeResponse();
    this.emit(
      "request",
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    if (body !== undefined) {
      queueMicrotask(() => {
        request.emit("data", Buffer.from(body));
        request.emit("end");
      });
    }
    return response.finished.then(() => response);
  }
}

class FakeTransport {
  readonly sessionId = "known-session";
  handled = 0;
  parsedBodies: unknown[] = [];

  async handleRequest(
    _req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    this.handled += 1;
    this.parsedBodies.push(parsedBody);
    res.writeHead(200);
    res.end();
  }
}

async function harness(
  sessionManager?: SessionManager,
  observers?: ObserverSessionRegistry,
): Promise<{ server: FakeHttpServer; transport: FakeTransport }> {
  const server = new FakeHttpServer();
  const daemon = new Daemon(
    { port, host: "127.0.0.1" },
    undefined,
    new FakeTimer(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => server as unknown as HttpServer,
  );
  const transport = new FakeTransport();
  const internals = daemon as unknown as DaemonHttpInternals;
  if (sessionManager) {
    internals.sessionManager = sessionManager;
  }
  if (observers) {
    internals.observerSessionRegistry = observers;
  }
  internals.transports.set(transport.sessionId, transport);
  await internals.startHttpServer();
  return { server, transport };
}

describe("Daemon HTTP request admission", () => {
  test.each(["evil.com:41321", "127.0.0.1:41322", undefined])(
    "rejects a non-loopback or mismatched Host header %s before MCP transport",
    async (host) => {
      const { server, transport } = await harness();
      const response = await server.dispatch({ host, "mcp-session-id": transport.sessionId });
      expect(response.statusCode).toBe(403);
      expect(transport.handled).toBe(0);
    },
  );

  test("rejects a non-empty Origin header before MCP transport", async () => {
    const { server, transport } = await harness();
    const response = await server.dispatch({
      host: `127.0.0.1:${port}`,
      origin: "https://evil.com",
      "mcp-session-id": transport.sessionId,
    });
    expect(response.statusCode).toBe(403);
    expect(transport.handled).toBe(0);
  });

  test.each([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])(
    "forwards loopback Host %s without Origin to the existing MCP transport",
    async (host) => {
      const { server, transport } = await harness();
      const response = await server.dispatch({ host, "mcp-session-id": transport.sessionId });
      expect(response.statusCode).toBe(200);
      expect(transport.handled).toBe(1);
      expect(response.headers.has("access-control-allow-origin")).toBeFalse();
    },
  );

  test("forwards a loopback MCP POST without Origin and preserves its body", async () => {
    const { server, transport } = await harness();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const response = await server.dispatch(
      { host: `127.0.0.1:${port}`, "mcp-session-id": transport.sessionId },
      "POST",
      MCP_STREAMABLE_PATH,
      JSON.stringify(body),
    );
    expect(response.statusCode).toBe(200);
    expect(transport.handled).toBe(1);
    expect(transport.parsedBodies).toEqual([body]);
  });

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
          JSON.stringify({ error: `Session not found: ${releasingSessionId}` }),
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
