import { AsyncResource } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import type { ExecutionCancellationReason } from "./executionTracker";
import { describeUnknownError } from "../utils/describeUnknownError";
import type { IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import {
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
  DaemonHandoffInterruptionError,
} from "./daemonHandoffInterruption";
import { JsonBoundaryTransport } from "./jsonBoundaryTransport";
import { LoopbackMcpClient } from "./socketServer/loopbackMcpClient";
import type { StatelessMcpRequestScope } from "./statelessMcpHttpEndpoint";
import { forgetDaemonSessionBindingScope } from "./daemonSessionBindingScopes";
import { executionTracker } from "./executionTracker";
import { defaultIdGenerator } from "../utils/IdGenerator";
import {
  buildMcpRequestContext,
  createStatelessMcpServer,
  refreshMcpResourceList,
  type McpForwardRequestContext,
  type McpRequestSessionContext,
  type StatelessMcpServerBase,
} from "./statelessMcpServerFactory";

/**
 * Runs a control-socket forward against the daemon's MCP server in process (#11820), instead of
 * over the loopback HTTP endpoint.
 *
 * Each forward gets its own client and its own stateless server, linked by an `InMemoryTransport`
 * pair. What the HTTP hop used to give the forward is kept:
 * - wire bytes: every message crosses a JSON boundary (stringify, parse, schema-parse), so a
 *   result or error reaches the socket exactly as it would have over HTTP;
 * - async context: the server side is entered from a root `AsyncResource` captured when the
 *   dispatcher is built, so the forward's AsyncLocalStorage stores (abort signal, request
 *   context, tool selection, acquisition receipt, ...) never reach the handler;
 * - per-request cancellation: the forward's executions run under their own request scope, which
 *   is cancelled before the server closes, and shutdown closes every forward still running.
 *
 * Because the pair is private to one forward, an aborted call's `notifications/cancelled` reaches
 * the server that is running it.
 */
export interface InProcessMcpDispatcherDeps {
  readonly idGenerator: IdGenerator;
  createServer(context: McpRequestSessionContext, scope: StatelessMcpRequestScope): McpServer;
  /** Cancel the executions keyed on a request scope (`executionTracker.cancelSessionExecutions`). */
  cancelScopeExecutions(
    requestScopeId: string,
    reason: ExecutionCancellationReason,
  ): Promise<number>;
  /** Forget the bindings a keyless forward recorded under its one-off scope id. */
  forgetScopeBindings(requestScopeId: string): void;
  /** Why a forward that closes now is cancelled: the handoff error during shutdown. */
  closeReason(): ExecutionCancellationReason;
  /**
   * Where the server side runs. Defaults to a root `AsyncResource` captured when the dispatcher
   * is built; the context-leak probe passes a pass-through to show what it guards against.
   */
  readonly serverScope?: AsyncScope;
  /** Resource discovery must refresh external rosters even when its validated answer is cached. */
  readonly refreshResources?: () => Promise<void>;
}

/** Runs a function inside some async context. */
export interface AsyncScope {
  run<T>(fn: () => T): T;
}

/** An `AsyncResource` captured now: everything run in it sees this moment's async context. */
export function rootAsyncScope(name: string): AsyncScope {
  const resource = new AsyncResource(name);
  return { run: (fn) => resource.runInAsyncScope(fn) };
}

/** A forward's context, plus the socket session key that names its caller. */
export interface InProcessMcpForward extends McpForwardRequestContext {
  readonly sessionKey?: string;
  /** The stdio proxy that owns the forward's MCP tasks (#4668), when it relays the extension. */
  readonly taskOwnerKey?: string;
}

interface InFlightForward {
  readonly requestScopeId: string;
  close(reason?: ExecutionCancellationReason): Promise<void>;
}

export class InProcessMcpDispatcher {
  /** Captured at construction (daemon start), outside any request's async context. */
  private readonly root: AsyncScope;
  private readonly inFlight = new Map<string, InFlightForward>();
  private accepting = true;

  constructor(private readonly deps: InProcessMcpDispatcherDeps) {
    this.root = deps.serverScope ?? rootAsyncScope("auto-mobile-mcp-forward-root");
    const refresh = deps.refreshResources;
    if (refresh) {
      this.refreshResources = () => this.root.run(refresh);
    }
  }

  /** Present only when the factory supplies the MCP handler's resource freshness hook. */
  readonly refreshResources?: () => Promise<void>;

  /** Forwards whose client is still open. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Refuse every later forward (#11820): with no HTTP hop there is no 503, so this is the gate a
   * forward admitted just before shutdown meets when it tries to reach the server.
   */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** Close callbacks for every forward still running, for the shutdown stage. */
  inFlightForwards(): Array<{ requestScopeId: string; close: () => Promise<void> }> {
    return Array.from(this.inFlight.values(), (forward) => ({
      requestScopeId: forward.requestScopeId,
      close: () => forward.close(),
    }));
  }

  /** Open a client for one forward, connected to its own server. Close the client when done. */
  async connect(forward: InProcessMcpForward): Promise<Client> {
    if (!this.accepting) {
      throw new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE);
    }
    const scope: StatelessMcpRequestScope = {
      requestScopeId: this.deps.idGenerator.next(),
      requestMcpSessionId: forward.sessionKey,
      trustedForwarder: true,
      ...(forward.taskOwnerKey !== undefined && { taskOwnerKey: forward.taskOwnerKey }),
    };
    const enterRoot = <T>(fn: () => T): T => this.root.run(fn);
    const server = enterRoot(() => this.deps.createServer(buildMcpRequestContext(forward), scope));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new LoopbackMcpClient(
      { name: "auto-mobile-daemon-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const closeClient = client.close.bind(client);
    let closing: Promise<void> | undefined;
    const tracked: InFlightForward = {
      requestScopeId: scope.requestScopeId,
      close: (reason) => {
        closing ??= this.closeForward(tracked, scope, server, closeClient, reason);
        return closing;
      },
    };
    client.close = () => tracked.close();
    this.inFlight.set(scope.requestScopeId, tracked);
    try {
      await enterRoot(() => server.connect(new JsonBoundaryTransport(serverSide, (fn) => fn())));
      await client.connect(new JsonBoundaryTransport(clientSide, enterRoot));
    } catch (error) {
      await tracked.close();
      throw error;
    }
    return client;
  }

  private async closeForward(
    forward: InFlightForward,
    scope: StatelessMcpRequestScope,
    server: McpServer,
    closeClient: () => Promise<void>,
    reason: ExecutionCancellationReason | undefined,
  ): Promise<void> {
    try {
      // Cancel first, so a still-running execution sees the real reason (the handoff error
      // during shutdown) rather than the SDK's "Connection closed" abort from the close below.
      await this.deps.cancelScopeExecutions(
        scope.requestScopeId,
        reason ?? this.deps.closeReason(),
      );
    } finally {
      if (this.inFlight.get(scope.requestScopeId) === forward) {
        this.inFlight.delete(scope.requestScopeId);
      }
      const results = await Promise.allSettled([closeClient(), server.close()]);
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn(
            `In-process MCP forward ${scope.requestScopeId} teardown failed: ${describeUnknownError(result.reason)}`,
          );
        }
      }
      if (scope.requestMcpSessionId === undefined) {
        // A keyless forward binds under its one-off scope id, which nothing presents again.
        this.deps.forgetScopeBindings(scope.requestScopeId);
      }
    }
  }
}

/** Why a forward that closes outside shutdown is cancelled: its caller is done with it. */
export const MCP_FORWARD_CLOSED_REASON = "mcp_forward_closed";

/**
 * The daemon's dispatcher: request servers from the shared stateless factory, scope executions
 * cancelled through the execution tracker, keyless bindings forgotten in the daemon-scoped store.
 */
export function createDaemonMcpDispatcher(options: {
  /** Read per forward, so daemon state set after construction (iOS dependencies) applies. */
  base: () => StatelessMcpServerBase;
  idGenerator?: IdGenerator;
  closeReason?: () => ExecutionCancellationReason;
}): InProcessMcpDispatcher {
  return new InProcessMcpDispatcher({
    idGenerator: options.idGenerator ?? defaultIdGenerator,
    refreshResources: refreshMcpResourceList,
    createServer: (context, scope) => createStatelessMcpServer(options.base(), context, scope),
    cancelScopeExecutions: (requestScopeId, reason) =>
      executionTracker.cancelSessionExecutions(requestScopeId, reason),
    forgetScopeBindings: (requestScopeId) => forgetDaemonSessionBindingScope(requestScopeId),
    closeReason: options.closeReason ?? (() => MCP_FORWARD_CLOSED_REASON),
  });
}
