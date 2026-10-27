import type { DaemonHttpTokenLifecycle } from "./daemonCore/DaemonHttpTokenLifecycle";
import { verifyBearerToken } from "./daemonHttpToken";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Transport } from "@modelcontextprotocol/server";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import type { IdGenerator } from "../utils/IdGenerator";
import { executionTracker } from "./executionTracker";
import { forgetDaemonSessionBindingScope } from "./daemonSessionBindingScopes";
import type { ObserverSessionRegistry } from "./observerSessionRegistry";
import { HEARTBEAT_PATH, MCP_STREAMABLE_PATH } from "./wire/constants";
import {
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
  DaemonHandoffInterruptionError,
} from "./daemonHandoffInterruption";
import {
  handleHttpHeartbeat,
  parseHttpHeartbeatBody,
  type HttpHeartbeatManager,
} from "./httpHeartbeat";
import {
  StatelessMcpHttpEndpoint,
  type McpHttpRequestLike,
  type McpHttpResponseLike,
  type StatelessMcpRequestScope,
  type StatelessMcpServer,
  type StatelessMcpTransport,
} from "./statelessMcpHttpEndpoint";

const HTTP_BODY_TIMEOUT_MS = 60_000;
const HTTP_BODY_MAX_BYTES = 256 * 1024 * 1024;
// The HTTP listener binds before device discovery (<=5 s) and session rehydration
// (<=15 s). A direct HTTP MCP request waits this long for startup to finish so it
// cannot take a device whose persisted session is about to be rehydrated (#11156);
// past it the client gets 503 with Retry-After instead of an unbounded hang.
const HTTP_STARTUP_ADMISSION_TIMEOUT_MS = 30_000;
const HTTP_STARTUP_RETRY_AFTER_SECONDS = 1;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

/** The request surface the body reader drives. `IncomingMessage` satisfies it. */
export interface HttpBodyRequest {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end" | "aborted" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "end" | "aborted" | "close", listener: () => void): unknown;
  destroy(): unknown;
}

/** One MCP POST as the ingress sees it. `IncomingMessage` satisfies it. */
export type McpIngressRequest = McpHttpRequestLike & HttpBodyRequest;
/** One MCP POST's transport. The SDK's streamable transport satisfies it. */
export type McpIngressTransport = StatelessMcpTransport<McpIngressRequest, McpHttpResponseLike> &
  Transport;

type HttpBodyResult = { ok: true; body: string } | { ok: false; status: number; error: string };

/** The listener surface ingress uses. `node:http`'s `Server` satisfies it. */
export interface HttpListener {
  readonly listening: boolean;
  requestTimeout: number;
  headersTimeout: number;
  timeout: number;
  listen(port: number, host: string, callback: () => void): unknown;
  close(callback: (error?: Error) => void): unknown;
  on(event: "request", listener: (req: IncomingMessage, res: ServerResponse) => void): unknown;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/** What the daemon's HTTP listener needs from the daemon; everything is read lazily. */
export interface DaemonHttpIngressDeps {
  httpToken: () => Pick<DaemonHttpTokenLifecycle, "value" | "isPublished">;
  httpServerFactory: () => HttpListener;
  timer: () => Timer;
  idGenerator: () => IdGenerator;
  /** Current bind address; the port is only final after port selection. */
  address: () => { host: string; port: number };
  /** Refuse to fall back to another port when the canonical one is taken (#6260). */
  strictPort: () => boolean;
  startupCompletion: () => Promise<void>;
  sessionManager: () => HttpHeartbeatManager;
  observerSessionRegistry: () => ObserverSessionRegistry;
  /** Builds one request's MCP server from its headers (#4678 stateless, #11820). */
  createRequestMcpServer: (
    req: McpHttpRequestLike,
    scope: StatelessMcpRequestScope,
  ) => StatelessMcpServer<McpIngressTransport>;
  isShutdownInProgress: () => boolean;
}

/**
 * The daemon's internal HTTP MCP listener: binding, request routing, startup
 * admission, body reading and the stateless per-request MCP endpoint.
 */
export class DaemonHttpIngress {
  private httpServer: HttpListener | null = null;
  private httpServerClosePromise: Promise<void> | null = null;
  /**
   * Aborted when shutdown closes ingress, so an HTTP MCP request still waiting
   * on startup answers 503 instead of holding the HTTP server
   * close (and every later shutdown stage) open (#11189).
   */
  private readonly shutdownIngressAbort = new AbortController();
  /** Host headers the HTTP listener admits; set when it starts. */
  private httpAllowedHosts: string[] = [];
  /** Builds one MCP request's transport (stateless: no transport session id, #4678); tests replace it with a double. */
  private mcpHttpTransportFactory = (allowedHosts: string[]): McpIngressTransport =>
    new StreamableHTTPServerTransport({
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
  /** Builds one MCP request's server; tests replace it with a double. */
  private mcpRequestServerFactory = (
    req: McpIngressRequest,
    scope: StatelessMcpRequestScope,
  ): StatelessMcpServer<McpIngressTransport> => this.deps.createRequestMcpServer(req, scope);
  /** One server and transport per MCP POST, closed with its response (#4678). */
  private readonly mcpHttpEndpoint = new StatelessMcpHttpEndpoint<
    McpIngressRequest,
    McpHttpResponseLike,
    McpIngressTransport
  >({
    timer: {
      setInterval: (callback, ms) => this.deps.timer().setInterval(callback, ms),
      clearInterval: (handle) => this.deps.timer().clearInterval(handle),
    },
    idGenerator: { next: () => this.deps.idGenerator().next() },
    keepaliveIntervalMs: SSE_KEEPALIVE_INTERVAL_MS,
    createTransport: () => this.mcpHttpTransportFactory(this.httpAllowedHosts),
    createServer: (req, scope) => this.mcpRequestServerFactory(req, scope),
    cancelScopeExecutions: (requestScopeId, reason) =>
      executionTracker.cancelSessionExecutions(requestScopeId, reason),
    forgetScopeBindings: (requestScopeId) => forgetDaemonSessionBindingScope(requestScopeId),
    closeReason: () =>
      this.deps.isShutdownInProgress()
        ? new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE)
        : "streamable_http_onclose",
  });
  /** Admitted HTTP requests whose response is still open (SSE streams included). */
  private openHttpRequests = 0;
  /** Admitted HTTP requests ever received. */
  private httpRequestsSeen = 0;
  private acceptingHttpSessions = false;
  /** Set once start() finished, so admitted HTTP requests skip the startup wait. */
  private startupCompleted = false;

  constructor(private readonly deps: DaemonHttpIngressDeps) {}

  /** The listener, once started; the health check reads `listening` off it. */
  get server(): HttpListener | null {
    return this.httpServer;
  }

  /** Open admitted request count, for the orphaned private-daemon watchdog (#10497). */
  get openRequestCount(): number {
    return this.openHttpRequests;
  }

  /** Admitted requests ever received, for the orphaned private-daemon watchdog. */
  get requestsSeenCount(): number {
    return this.httpRequestsSeen;
  }

  markStartupCompleted(): void {
    this.startupCompleted = true;
  }

  /** @internal Typed view of private state for unit tests; not part of the public API. */
  get testHooks() {
    return {
      openRequestCount: (): number => this.openRequestCount,
      requestsSeenCount: (): number => this.requestsSeenCount,
      setHttpServer: (server: HttpListener | null): void => {
        this.httpServer = server;
      },
      start: (): Promise<void> => this.start(),
      closeListener: (): Promise<void> => this.closeListener(),
      markStartupCompleted: (): void => this.markStartupCompleted(),
      isAcceptingHttpSessions: (): boolean => this.acceptingHttpSessions,
      setAcceptingHttpSessions: (accepting: boolean): void => {
        this.acceptingHttpSessions = accepting;
      },
      setMcpTransportFactory: (factory: () => McpIngressTransport): void => {
        this.mcpHttpTransportFactory = factory;
      },
      setMcpRequestServerFactory: (
        factory: (
          req: McpIngressRequest,
          scope: StatelessMcpRequestScope,
        ) => StatelessMcpServer<McpIngressTransport>,
      ): void => {
        this.mcpRequestServerFactory = factory;
      },
      mcpHttpEndpoint: this.mcpHttpEndpoint,
      handleMcpHttpRequest: (req: McpIngressRequest, res: McpHttpResponseLike): Promise<void> =>
        this.handleMcpHttpRequest(req, res),
      readHttpBody: (req: HttpBodyRequest): Promise<HttpBodyResult> => this.readHttpBody(req),
    };
  }

  /** Test seam: register an in-flight HTTP request double that shutdown must close. */
  trackTransportForTesting(requestScopeId: string, close: () => Promise<void>): void {
    this.mcpHttpEndpoint.trackForTesting(requestScopeId, close);
  }

  /** In-flight MCP requests that shutdown must close. */
  inFlightRequests(): ReturnType<typeof this.mcpHttpEndpoint.inFlightRequests> {
    return this.mcpHttpEndpoint.inFlightRequests();
  }

  clearSessions(): void {
    this.mcpHttpEndpoint.clear();
  }

  /** Stop admitting new MCP requests (shutdown step one). */
  stopAccepting(): void {
    this.acceptingHttpSessions = false;
    this.mcpHttpEndpoint.stopAccepting();
  }

  /** Answer 503 to requests still waiting on startup, so listener close is not held open. */
  abortPendingAdmissions(): void {
    this.shutdownIngressAbort.abort();
  }

  /**
   * Start the HTTP MCP server (internal daemon transport, not exposed publicly)
   */
  async start(): Promise<void> {
    if (!this.deps.httpToken().value) {
      throw new ActionableError("Daemon HTTP token is not configured");
    }
    const { host, port } = this.deps.address();
    const server = this.deps.httpServerFactory();
    this.httpServer = server;
    this.httpServerClosePromise = null;
    this.acceptingHttpSessions = true;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    this.httpAllowedHosts = allowedHosts;

    // Disable default timeouts on this loopback-only server. Node.js 18+ sets
    // requestTimeout to 300 000 ms (5 min), which kills Streamable HTTP
    // connections for long-running tool calls like executePlan. With the timeout
    // active the HTTP response is silently dropped after ~5 min, the
    // request's transport closes, and the MCP client never
    // receives the result — even when the tool completed successfully.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;

    const handleRequest = (req: IncomingMessage, res: ServerResponse): Promise<void> =>
      this.handleHttpRequest(req, res, allowedHosts);
    server.on("request", (req, res) => {
      handleRequest(req, res).catch((error) => {
        logger.warn(`HTTP request callback failed: ${errorMessage(error)}`, error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end();
      });
    });

    // Start HTTP server
    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        logger.info(`automobile:${host}:${port}${MCP_STREAMABLE_PATH}`);
        resolve();
      });

      server.on("error", (error: NodeJS.ErrnoException) => {
        if (this.deps.strictPort() && error.code === "EADDRINUSE") {
          // The authoritative guard (issue #6260): this listen() call is the
          // one atomic bind attempt in strict-port mode, so a genuine
          // EADDRINUSE here means another process holds the canonical port
          // RIGHT NOW — not a stale probe result. Fail loudly instead of the
          // caller (start()) ever falling back to a different port.
          reject(
            new ActionableError(
              `Port ${port} on ${host} is required for this daemon start but is ` +
                `already in use by another process. Refusing to fall back to a different port ` +
                `and risk a split-brain daemon (issue #6260) — find and stop whatever holds ` +
                `port ${port} and retry.`,
            ),
          );
          return;
        }
        logger.error(`HTTP server error: ${error}`);
        reject(error);
      });
    });
  }

  closeListener(): Promise<void> {
    const server = this.httpServer;
    if (!server) {
      return Promise.resolve();
    }
    this.httpServerClosePromise ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        logger.info("HTTP server stopped");
        resolve();
      });
    });
    return this.httpServerClosePromise;
  }

  private admitHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    allowedHosts: string[],
  ): boolean {
    // Check every path before parsing the URL or handling preflight requests.
    if (!req.headers.host || !allowedHosts.includes(req.headers.host) || req.headers.origin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return false;
    }

    return true;
  }

  /**
   * Hold a request that reaches the listener before this daemon publishes its token
   * on the bounded startup wait, instead of refusing it outright: the port is
   * discoverable from the early owner record well before publication, longer than
   * the clients' own 503 retry budgets (#14424). A client holding a predecessor's
   * token then gets 401, and every client re-reads the published token once on 401.
   */
  private async awaitHttpTokenPublication(res: McpHttpResponseLike): Promise<boolean> {
    if (this.deps.httpToken().isPublished) {
      return true;
    }
    if (this.acceptingHttpSessions && !this.startupCompleted) {
      if (!(await this.awaitStartupAdmission(res))) {
        return false;
      }
      if (this.deps.httpToken().isPublished) {
        return true;
      }
    }
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: "Service unavailable" }));
    return false;
  }

  private authenticateHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const authorization = req.headers.authorization;
    // Drop credentials from both Node header views before any downstream code runs.
    delete req.headers.authorization;
    for (let index = req.rawHeaders.length - 2; index >= 0; index -= 2) {
      if (req.rawHeaders[index]?.toLowerCase() === "authorization") {
        req.rawHeaders.splice(index, 2);
      }
    }
    const expected = this.deps.httpToken().value;
    if (!expected || !verifyBearerToken(authorization, expected)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return false;
    }

    return true;
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    allowedHosts: string[],
  ): Promise<void> {
    if (
      !this.admitHttpRequest(req, res, allowedHosts) ||
      // No microtask hop when the token is already published, so admission counting stays
      // synchronous with the request event on the common path.
      !(this.deps.httpToken().isPublished || (await this.awaitHttpTokenPublication(res))) ||
      !this.authenticateHttpRequest(req, res)
    ) {
      return;
    }

    // Only admitted requests count as clients for the orphaned private-daemon watchdog.
    this.openHttpRequests++;
    this.httpRequestsSeen++;
    res.once("close", () => {
      this.openHttpRequests--;
    });

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname === HEARTBEAT_PATH) {
      return this.handleHeartbeatHttpRequest(req, res);
    }

    if (url.pathname === MCP_STREAMABLE_PATH) {
      return this.handleMcpHttpRequest(req, res);
    } else {
      // 404 for unknown paths
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private async handleHeartbeatHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const bodyResult = await this.readHttpBody(req);
    if (!bodyResult.ok) {
      this.respondToBodyReadFailure(res, bodyResult);
      return;
    }

    const body = parseHttpHeartbeatBody(bodyResult.body);
    if (!body.ok) {
      res.writeHead(body.response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body.response.body));
      return;
    }
    const result = await handleHttpHeartbeat(
      this.deps.sessionManager(),
      this.deps.observerSessionRegistry(),
      body.sessionId,
      body.livenessOwnerToken,
    );
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  }

  /**
   * Refuse a direct HTTP MCP request during shutdown, and hold it until startup
   * (device discovery and session rehydration) completes, as the Unix socket
   * path already does (#11156). Returns false after answering 503 when shutting
   * down, or when startup is still running past the admission bound or failed.
   */
  private async admitHttpMcpRequest(res: McpHttpResponseLike): Promise<boolean> {
    if (!this.acceptingHttpSessions) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Daemon is shutting down" }));
      return false;
    }
    return this.awaitStartupAdmission(res);
  }

  /**
   * Wait (bounded) for startup to finish. Returns false after answering 503 when
   * shutdown began during the wait, or startup outlived the bound or failed.
   */
  private async awaitStartupAdmission(res: McpHttpResponseLike): Promise<boolean> {
    if (this.startupCompleted) {
      return true;
    }
    const timedOut = Symbol("HTTP startup admission timeout");
    const signal = this.shutdownIngressAbort.signal;
    try {
      await raceWithDeadline(this.deps.startupCompletion(), {
        timer: this.deps.timer(),
        timeoutMs: HTTP_STARTUP_ADMISSION_TIMEOUT_MS,
        signal,
        label: "HTTP MCP startup admission",
        timeoutError: () => timedOut,
      });
      return true;
    } catch (error) {
      if (signal.aborted) {
        // Shutdown began while this request waited on startup; the HTTP server
        // close waits for it, so answer now rather than after startup (#11189).
        logger.info("HTTP MCP request refused: daemon shut down during startup admission");
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Daemon is shutting down" }));
        return false;
      }
      if (error === timedOut) {
        logger.warn(
          `HTTP MCP request refused: daemon still starting after ${HTTP_STARTUP_ADMISSION_TIMEOUT_MS}ms`,
        );
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": String(HTTP_STARTUP_RETRY_AFTER_SECONDS),
        });
        res.end(JSON.stringify({ error: "Daemon is still starting" }));
        return false;
      }
      logger.warn(`HTTP MCP request refused: daemon startup failed: ${errorMessage(error)}`);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Daemon startup failed" }));
      return false;
    }
  }

  private async handleMcpHttpRequest(
    req: McpIngressRequest,
    res: McpHttpResponseLike,
  ): Promise<void> {
    if (!(await this.admitHttpMcpRequest(res))) {
      return;
    }

    let parsedBody: unknown;

    // Parse body for POST requests
    if (req.method === "POST") {
      const bodyResult = await this.readHttpBody(req);
      if (!bodyResult.ok) {
        this.respondToBodyReadFailure(res, bodyResult);
        return;
      }

      try {
        parsedBody = JSON.parse(bodyResult.body);
      } catch (error) {
        // Invalid client JSON is expected; the 400 response fully describes the failure.
        logger.debug(`Invalid MCP JSON: ${error}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }

    const sendJsonRpcError = (message: string, error?: unknown) =>
      this.sendHttpJsonRpcError(res, parsedBody, message, error);

    // A request may have begun reading its body just before shutdown
    // quiesced the listener. Recheck admission before it can create a
    // server after the shutdown in-flight snapshot is taken.
    if (!this.acceptingHttpSessions) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Daemon is shutting down" }));
      return;
    }

    return this.mcpHttpEndpoint.handle(req, res, parsedBody, sendJsonRpcError);
  }

  private sendHttpJsonRpcError(
    res: McpHttpResponseLike,
    parsedBody: unknown,
    message: string,
    error?: unknown,
  ): void {
    if (res.headersSent) {
      return;
    }
    const id =
      parsedBody && typeof parsedBody === "object" && "id" in parsedBody ? parsedBody.id : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message,
          data: error instanceof Error ? error.message : undefined,
        },
      }),
    );
  }

  private readHttpBody(req: HttpBodyRequest): Promise<HttpBodyResult> {
    const timer = this.deps.timer();
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (result: HttpBodyResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        timer.clearTimeout(timeout);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        req.off("close", onClose);
        resolve(result);
      };
      const onData = (chunk: Buffer | string): void => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > HTTP_BODY_MAX_BYTES) {
          finish({ ok: false, status: 413, error: "Request body too large" });
          req.destroy();
          return;
        }
        chunks.push(data);
      };
      const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
      const onError = (error: Error): void => {
        logger.warn("HTTP request body read failed", error);
        finish({ ok: false, status: 400, error: "Request body read failed" });
      };
      const onAborted = (): void => finish({ ok: false, status: 400, error: "Request aborted" });
      const onClose = (): void => finish({ ok: false, status: 400, error: "Request closed" });
      const timeout = timer.setTimeout(() => {
        finish({ ok: false, status: 408, error: "Request body timed out" });
        req.destroy();
      }, HTTP_BODY_TIMEOUT_MS);
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      req.on("close", onClose);
    });
  }

  private respondToBodyReadFailure(
    res: McpHttpResponseLike,
    result: Extract<HttpBodyResult, { ok: false }>,
  ): void {
    if (!res.destroyed) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
    }
  }
}
