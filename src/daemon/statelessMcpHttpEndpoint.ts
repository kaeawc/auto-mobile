import { AsyncLocalStorage } from "node:async_hooks";
import {
  classifyInboundRequest,
  createMcpHandler,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type McpServerFactory,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { ENV, readEnvBool } from "../config/env";
import { ActionableError } from "../models/ActionableError";
import { rootAsyncScope } from "./inProcessMcpDispatcher";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { readMcpSessionKey } from "./mcpSessionKey";
import type { ExecutionCancellationReason } from "./executionTracker";
import { describeUnknownError, errorMessage } from "../utils/describeUnknownError";
import type { IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { INTERNAL_MCP_SESSION_PARAM, MCP_STREAMABLE_PATH } from "./wire/constants";

/**
 * The daemon's internal MCP HTTP endpoint, stateless (#4678, owner decision 2026-10-17).
 *
 * Every POST gets its own MCP server and transport, closed when its response closes.
 * There is no transport map, no idle reaper and no transport session header: the caller's
 * session key ({@link readMcpSessionKey}; only without a header, the in-band `__mcpSessionId`) is the
 * only thing that links one request to the next. GET and DELETE answer 405 because
 * there is no session stream to open or terminate.
 *
 * What the per-session transport used to provide is kept per request:
 * - cancellation: each request runs under its own `requestScopeId` (the one-shot
 *   server's per-request scope id), so a response that closes early cancels
 *   exactly the executions that request started, and shutdown cancels them with the
 *   daemon's handoff reason;
 * - `notifications/cancelled`: it arrives on a different POST, which reaches a fresh
 *   server that never saw the request. The endpoint therefore resolves it in process
 *   against its in-flight index (session key + JSON-RPC id) and cancels the matching
 *   request itself.
 */

/** The request fields the endpoint reads. `IncomingMessage` satisfies it. */
export interface McpHttpRequestLike {
  readonly method?: string;
  readonly headers: IncomingHttpHeaders;
  /** Watched for a client disconnect: Bun's node:http emits no response `close` for it. */
  readonly socket?: {
    once(event: "close", listener: () => void): unknown;
    off(event: "close", listener: () => void): unknown;
  } | null;
}

/** The response surface the endpoint drives. `ServerResponse` satisfies it. */
export interface McpHttpResponseLike {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(body?: string): unknown;
  once(event: "close" | "finish", listener: () => void): unknown;
}

/** One request's transport: it handles exactly one POST, then closes. */
export interface StatelessMcpTransport<Req, Res> {
  handleRequest(req: Req, res: Res, parsedBody?: unknown): Promise<void>;
  close(): Promise<void>;
}

/** One request's MCP server. */
export interface StatelessMcpServer<T> {
  connect(transport: T): Promise<void>;
  close(): Promise<void>;
}

/** What a request's one-shot server is built with. */
export interface StatelessMcpRequestScope {
  readonly era?: "legacy" | "modern";
  /** Unique per POST: keys the executions this request starts so they cancel on their own. */
  readonly requestScopeId: string;
  /** The caller's session key: the header, else the in-band `__mcpSessionId` argument. */
  readonly requestMcpSessionId: string | undefined;
  /**
   * True only for the daemon's own in-process forward (stdio proxy / socket-forwarded tool
   * calls, #13315): its in-band `__mcpSessionId` names the originating client and outranks
   * `requestMcpSessionId` (the connection key). The HTTP endpoint never sets it, so a direct
   * client's in-band id can never override its session-key header.
   */
  readonly trustedForwarder?: boolean;
  /**
   * Who owns the request's MCP tasks (#4668), when not its session key: a control-socket forward
   * from the stdio proxy names the proxy. The HTTP endpoint never sets it.
   */
  readonly taskOwnerKey?: string;
}

export interface StatelessMcpHttpEndpointDeps<
  Req extends McpHttpRequestLike,
  Res extends McpHttpResponseLike,
  T extends StatelessMcpTransport<Req, Res>,
> {
  readonly timer: Pick<Timer, "setInterval" | "clearInterval">;
  readonly idGenerator: IdGenerator;
  readonly keepaliveIntervalMs: number;
  /** Injectable SDK boundary; disabled requests never classify or construct a handler. */
  readonly modern?: {
    enabled(): boolean;
    classify: typeof classifyInboundRequest;
    createHandler(
      factory: McpServerFactory,
      options: CreateMcpHandlerOptions,
    ): Pick<McpHttpHandler, "fetch" | "close">;
  };
  createTransport(): T;
  createServer(req: Req, scope: StatelessMcpRequestScope): StatelessMcpServer<T>;
  /** Cancel the executions keyed on a request scope (`executionTracker.cancelSessionExecutions`). */
  cancelScopeExecutions(
    requestScopeId: string,
    reason: ExecutionCancellationReason,
  ): Promise<number>;
  /**
   * Forget the bindings a keyless request recorded under its one-off scope id
   * (`forgetDaemonSessionBindingScope`): nothing will present that id again.
   */
  forgetScopeBindings(requestScopeId: string): void;
  /** Why a request that closes now is cancelled: the handoff error during shutdown. */
  closeReason(): ExecutionCancellationReason;
}

interface InFlightRequest {
  readonly requestScopeId: string;
  /** The request carried no session key, so its bindings live under its scope id. */
  readonly keyless: boolean;
  readonly cancelKeys: readonly string[];
  /** Cancel this request's executions, then close its server and transport. Idempotent. */
  close(reason?: ExecutionCancellationReason): Promise<void>;
}

const METHOD_NOT_ALLOWED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
});

const SHUTTING_DOWN_BODY = JSON.stringify({ error: "Daemon is shutting down" });

type JsonRpcId = string | number;

function jsonRpcMessages(parsedBody: unknown): readonly Record<string, unknown>[] {
  const messages: unknown[] = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.filter(
    (message): message is Record<string, unknown> =>
      !!message && typeof message === "object" && !Array.isArray(message),
  );
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function recordField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

/** The in-band `__mcpSessionId` of the first `tools/call` in the body, if any. */
export function readInBandMcpSessionId(parsedBody: unknown): string | undefined {
  for (const message of jsonRpcMessages(parsedBody)) {
    const value = recordField(recordField(message.params, "arguments"), INTERNAL_MCP_SESSION_PARAM);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function cancelKeySuffix(id: JsonRpcId): string {
  return `\u0000${typeof id}:${String(id)}`;
}

function cancelKey(sessionKey: string, id: JsonRpcId): string {
  return `${sessionKey}${cancelKeySuffix(id)}`;
}

/** Adapt the already-read node request without reading or serializing its body again. */
function modernWebRequest(req: McpHttpRequestLike, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const part of values) {
      headers.append(name, part);
    }
  }
  return new Request(new URL(MCP_STREAMABLE_PATH, "http://localhost"), {
    method: "POST",
    headers,
    signal,
  });
}

/** Preserve SSE chunks, including UTF-8 characters split across chunks. */
async function writeModernResponse(response: Response, res: McpHttpResponseLike): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    await response.body?.cancel();
    return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  const decoder = new TextDecoder();
  if (response.body) {
    for await (const chunk of response.body) {
      if (res.destroyed || res.writableEnded) {
        break;
      }
      res.write(decoder.decode(chunk, { stream: true }));
    }
  }
  if (!res.destroyed && !res.writableEnded) {
    res.end(decoder.decode());
  }
}

const MODERN_ERA_PROTOCOL_VERSION = "2026-07-28";

/** Whether a request names a 2026-era protocol version in its header or per-request envelope. */
function claimsModernEra(protocolVersionHeader: string | undefined, body: unknown): boolean {
  const params = (body as { params?: { _meta?: Record<string, unknown> } } | null)?.params;
  const envelope = params?._meta?.[PROTOCOL_VERSION_META_KEY];
  return [protocolVersionHeader, envelope].some(
    (version) => typeof version === "string" && version >= MODERN_ERA_PROTOCOL_VERSION,
  );
}

export class StatelessMcpHttpEndpoint<
  Req extends McpHttpRequestLike = IncomingMessage,
  Res extends McpHttpResponseLike = ServerResponse,
  T extends StatelessMcpTransport<Req, Res> = StatelessMcpTransport<Req, Res>,
> {
  private readonly inFlight = new Map<string, InFlightRequest>();
  /** session key + JSON-RPC id → request scope, for `notifications/cancelled`. */
  // Scope ids per cancel key, oldest first: keyless requests may share a JSON-RPC id.
  private readonly byCancelKey = new Map<string, string[]>();
  private accepting = true;
  /** Handed to the handler's factory once; cleared there so a long-lived task does not pin `req`. */
  private readonly modernScope = new AsyncLocalStorage<{
    req?: Req;
    scope?: StatelessMcpRequestScope;
  }>();
  private readonly root = rootAsyncScope("auto-mobile-mcp-http-root");

  constructor(private readonly deps: StatelessMcpHttpEndpointDeps<Req, Res, T>) {}

  /** Requests whose response is still open. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Close callbacks for every in-flight request, for the shutdown stage. */
  inFlightRequests(): Array<{ requestScopeId: string; close: () => Promise<void> }> {
    return Array.from(this.inFlight.values(), (request) => ({
      requestScopeId: request.requestScopeId,
      close: () => request.close(),
    }));
  }

  /** Test seam: track a closable double as an in-flight request. */
  trackForTesting(requestScopeId: string, close: () => Promise<void>): void {
    this.inFlight.set(requestScopeId, {
      requestScopeId,
      keyless: false,
      cancelKeys: [],
      close: async () => {
        this.inFlight.delete(requestScopeId);
        await close();
      },
    });
  }

  /**
   * Serve nothing more (#13049): shutdown calls this when it stops admitting HTTP requests. A
   * request admitted earlier that is still awaiting a cancellation it carried is answered 503
   * instead of building a server after the shutdown snapshot.
   */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** Drop all tracking after shutdown closed the requests (or gave up on them). */
  clear(): void {
    this.accepting = false;
    this.inFlight.clear();
    this.byCancelKey.clear();
  }

  /**
   * Serve one MCP HTTP request. The caller has already admitted it and parsed a
   * POST body; `sendJsonRpcError` answers a failure before the transport wrote.
   */
  async handle(
    req: Req,
    res: Res,
    parsedBody: unknown,
    sendJsonRpcError: (message: string, error?: unknown) => void,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(METHOD_NOT_ALLOWED_BODY);
      return;
    }
    const headerSessionKey = readMcpSessionKey(req.headers);
    await this.cancelNotifiedRequests(headerSessionKey, parsedBody);
    if (!this.accepting) {
      // Shutdown began while this request's cancellation was closing its target (#13049).
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(SHUTTING_DOWN_BODY);
      return;
    }
    const scope: StatelessMcpRequestScope = {
      requestScopeId: this.deps.idGenerator.next(),
      requestMcpSessionId: headerSessionKey ?? readInBandMcpSessionId(parsedBody),
    };

    if (this.isModernRequest(req, parsedBody)) {
      await this.handleModern(req, res, parsedBody, scope, headerSessionKey, sendJsonRpcError);
      return;
    }

    let server: StatelessMcpServer<T>;
    try {
      server = this.deps.createServer(req, scope);
    } catch (error) {
      logger.error("Failed to create MCP server:", error);
      sendJsonRpcError("Server error", error);
      return;
    }
    const transport = this.deps.createTransport();
    const request = this.track(scope, headerSessionKey, parsedBody, server, transport);
    // The response ends (finish), the response is torn down (close), or the client
    // drops the connection (socket close; on a keep-alive socket the listener is
    // removed once the response ends, so reused connections do not accumulate it).
    const socket = req.socket ?? undefined;
    const closeOnResponseEnd = () => {
      socket?.off("close", closeOnResponseEnd);
      request.close().catch((error) => {
        logger.warn(`Stateless MCP request close failed: ${errorMessage(error)}`, error);
      });
    };
    res.once("close", closeOnResponseEnd);
    res.once("finish", closeOnResponseEnd);
    socket?.once("close", closeOnResponseEnd);

    try {
      await server.connect(transport);
    } catch (error) {
      logger.error("MCP server connect failed:", error);
      sendJsonRpcError("Server error", error);
      await request.close();
      return;
    }
    await this.dispatch(req, res, transport, parsedBody, sendJsonRpcError);
  }

  private isModernRequest(req: Req, parsedBody: unknown): boolean {
    if (!(this.deps.modern?.enabled() ?? readEnvBool(ENV.MCP_MODERN_ERA))) {
      return false;
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const protocolVersionHeader = header("mcp-protocol-version");
    const outcome = (this.deps.modern?.classify ?? classifyInboundRequest)({
      httpMethod: req.method ?? "POST",
      protocolVersionHeader,
      mcpMethodHeader: header("mcp-method"),
      mcpNameHeader: header("mcp-name"),
      body: parsedBody,
    });
    // A rejection of a request that claims the modern era belongs to the modern handler, which
    // owns those error answers; a malformed 2025 body keeps today's answer.
    return (
      outcome.kind === "modern" ||
      (outcome.kind === "reject" && claimsModernEra(protocolVersionHeader, parsedBody))
    );
  }

  /** The SDK owns modern protocol serving; this endpoint still owns request lifetime. */
  private async handleModern(
    req: Req,
    res: Res,
    parsedBody: unknown,
    scope: StatelessMcpRequestScope,
    headerSessionKey: string | undefined,
    sendJsonRpcError: (message: string, error?: unknown) => void,
  ): Promise<void> {
    const controller = new AbortController();
    const handler = (this.deps.modern?.createHandler ?? createMcpHandler)(
      (ctx) => {
        const current = this.modernScope.getStore();
        const { req: scopedReq, scope: scopedScope } = current ?? {};
        if (!current || !scopedReq || !scopedScope) {
          throw new ActionableError("Modern MCP request scope is missing");
        }
        current.req = undefined;
        current.scope = undefined;
        const server = this.deps.createServer(scopedReq, { ...scopedScope, era: ctx.era });
        if (!(server instanceof McpServer)) {
          throw new ActionableError("Modern MCP serving requires an SDK McpServer");
        }
        return server;
      },
      { legacy: "reject", responseMode: "sse", keepAliveMs: 0 },
    );
    const request = this.track(scope, headerSessionKey, parsedBody, handler, {
      close: async () => {
        controller.abort();
      },
    });
    const socket = req.socket ?? undefined;
    const close = () => {
      socket?.off("close", close);
      request.close().catch((error) => {
        logger.warn(`Modern MCP request close failed: ${errorMessage(error)}`, error);
      });
    };
    res.once("close", close);
    res.once("finish", close);
    socket?.once("close", close);
    const clearKeepalive = this.startKeepalive(res);
    try {
      const response = await this.root.run(() =>
        this.modernScope.run({ req, scope }, () =>
          handler.fetch(modernWebRequest(req, controller.signal), { parsedBody }),
        ),
      );
      await writeModernResponse(response, res);
    } catch (error) {
      logger.error("Modern MCP HTTP request handling failed:", error);
      sendJsonRpcError("Server error", error);
    } finally {
      clearKeepalive();
      socket?.off("close", close);
      await request.close();
    }
  }

  private track(
    scope: StatelessMcpRequestScope,
    headerSessionKey: string | undefined,
    parsedBody: unknown,
    server: Pick<StatelessMcpServer<T>, "close">,
    transport: Pick<T, "close">,
  ): InFlightRequest {
    const { requestScopeId } = scope;
    // A `notifications/cancelled` carries no in-band arguments, so the header key indexes
    // cancellation; a keyless request is indexed under the empty key, which only the id-alone
    // fallback reaches (JSON-RPC ids are unique only within one client).
    const cancelKeys = jsonRpcMessages(parsedBody)
      .map((message) => message.id)
      .filter(isJsonRpcId)
      .map((id) => cancelKey(headerSessionKey ?? "", id));
    let closing: Promise<void> | undefined;
    const request: InFlightRequest = {
      requestScopeId,
      keyless: scope.requestMcpSessionId === undefined,
      cancelKeys,
      close: (reason?: ExecutionCancellationReason) => {
        closing ??= this.closeRequest(request, server, transport, reason);
        return closing;
      },
    };
    this.inFlight.set(requestScopeId, request);
    for (const key of cancelKeys) {
      this.byCancelKey.set(key, [...(this.byCancelKey.get(key) ?? []), requestScopeId]);
    }
    return request;
  }

  private async closeRequest(
    request: InFlightRequest,
    server: Pick<StatelessMcpServer<T>, "close">,
    transport: Pick<T, "close">,
    reason: ExecutionCancellationReason | undefined,
  ): Promise<void> {
    try {
      // Cancel first, so the execution sees the real reason (the handoff error during
      // shutdown) rather than the SDK's "Connection closed" abort from the close below.
      // A request that already answered has no executions left; this is a no-op.
      const cancelled = await this.deps.cancelScopeExecutions(
        request.requestScopeId,
        reason ?? this.deps.closeReason(),
      );
      if (cancelled > 0) {
        logger.info(
          `Stateless MCP request ${request.requestScopeId} closed (cancelled ${cancelled} executions)`,
        );
      }
    } finally {
      this.untrack(request);
      const results = await Promise.allSettled([transport.close(), server.close()]);
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn(
            `Stateless MCP request ${request.requestScopeId} teardown failed: ${describeUnknownError(result.reason)}`,
          );
        }
      }
      if (request.keyless) {
        // A keyless request binds under its one-off scope id (#4678), which no later request
        // presents: forget it once the server that recorded it is closed.
        this.deps.forgetScopeBindings(request.requestScopeId);
      }
    }
  }

  private untrack(request: InFlightRequest): void {
    if (this.inFlight.get(request.requestScopeId) === request) {
      this.inFlight.delete(request.requestScopeId);
    }
    for (const key of request.cancelKeys) {
      const remaining = (this.byCancelKey.get(key) ?? []).filter(
        (scopeId) => scopeId !== request.requestScopeId,
      );
      if (remaining.length === 0) {
        this.byCancelKey.delete(key);
      } else {
        this.byCancelKey.set(key, remaining);
      }
    }
  }

  /**
   * In-process fallback for `notifications/cancelled` (plan open question 1): the
   * notification's POST reaches a fresh server, which cannot see the original
   * request, so cancel that request's executions here and close its server, which
   * aborts the handler signal the SDK passed it.
   */
  private async cancelNotifiedRequests(
    headerSessionKey: string | undefined,
    parsedBody: unknown,
  ): Promise<void> {
    const cancellations = jsonRpcMessages(parsedBody).filter(
      (message) => message.method === "notifications/cancelled",
    );
    await Promise.all(
      cancellations.map(async (message) => {
        const requestId = recordField(message.params, "requestId");
        if (!isJsonRpcId(requestId)) {
          return;
        }
        const scopeId = this.cancelledScopeId(headerSessionKey, requestId);
        const request = scopeId === undefined ? undefined : this.inFlight.get(scopeId);
        if (!request) {
          // The request already answered (or never reached this daemon): nothing to cancel.
          logger.debug(`notifications/cancelled for unknown request ${String(requestId)}`);
          return;
        }
        const reason = recordField(message.params, "reason");
        await request.close(typeof reason === "string" ? reason : "notifications/cancelled");
      }),
    );
  }

  /**
   * The in-flight request a cancellation names. With the session-key header it is the request
   * that key sent under that id. Without it (#13067), the id alone decides, and only when exactly
   * one in-flight request carries it: JSON-RPC ids are unique only within one client.
   */
  private cancelledScopeId(
    headerSessionKey: string | undefined,
    requestId: JsonRpcId,
  ): string | undefined {
    if (headerSessionKey !== undefined) {
      return this.byCancelKey.get(cancelKey(headerSessionKey, requestId))?.at(-1);
    }
    const suffix = cancelKeySuffix(requestId);
    const matches = Array.from(this.byCancelKey.entries())
      .filter(([key]) => key.endsWith(suffix))
      .flatMap(([, scopeIds]) => scopeIds);
    if (matches.length > 1) {
      logger.warn(
        `Ignoring header-less notifications/cancelled for ambiguous request id ${String(requestId)}: ${matches.length} in-flight requests share it`,
      );
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  private startKeepalive(res: Res): () => void {
    // SSE keepalive: prevent the fetch() response stream from going idle
    // during long-running tool calls (e.g. executePlan at ~6-10 min).
    // Without traffic the client-side stream silently dies; the server
    // writes the result to a dead pipe and the client eventually times out.
    // SSE comment lines (`:`) are ignored by EventSourceParserStream.
    const keepaliveTimer = this.deps.timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, this.deps.keepaliveIntervalMs);
    let keepaliveCleared = false;
    const clearKeepalive = () => {
      if (!keepaliveCleared) {
        keepaliveCleared = true;
        this.deps.timer.clearInterval(keepaliveTimer);
      }
    };
    res.once("close", clearKeepalive);
    res.once("finish", clearKeepalive);
    return clearKeepalive;
  }

  private async dispatch(
    req: Req,
    res: Res,
    transport: T,
    parsedBody: unknown,
    sendJsonRpcError: (message: string, error?: unknown) => void,
  ): Promise<void> {
    const clearKeepalive = this.startKeepalive(res);
    try {
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      logger.error("Streamable HTTP request handling failed:", error);
      sendJsonRpcError("Server error", error);
    } finally {
      clearKeepalive();
    }
  }
}
