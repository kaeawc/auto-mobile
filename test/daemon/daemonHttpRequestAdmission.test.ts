import { EventEmitter } from "node:events";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { MCP_STREAMABLE_PATH } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";

const port = 41321;

interface DaemonHttpInternals {
  startHttpServer(): Promise<void>;
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

  end(): this {
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

async function harness(): Promise<{ server: FakeHttpServer; transport: FakeTransport }> {
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
