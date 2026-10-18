import type { AsyncResource } from "node:async_hooks";
import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServer,
  parseJSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
import type { ExecutionCancellationReason } from "../../src/server/executionTracker";
import { LoopbackMcpClient } from "../../src/daemon/socketServer/loopbackMcpClient";
import {
  currentLoopbackSessionKey,
  type McpClientFactory,
} from "../../src/daemon/socketServer/loopbackMcpClientPool";
import type { StatelessMcpRequestScope } from "../../src/daemon/statelessMcpHttpEndpoint";
import {
  buildMcpRequestContext,
  type McpRequestSessionContext,
} from "../../src/daemon/statelessMcpServerFactory";
import type { IdGenerator } from "../../src/utils/IdGenerator";

/**
 * The in-memory side of the loopback byte-parity characterization (#11820): a control-socket
 * forward reaches a fresh stateless MCP server over an `InMemoryTransport` pair instead of the
 * HTTP endpoint. Every message crosses a JSON boundary (stringify, parse, schema-parse: what the
 * HTTP transports do), and the server side is entered from `root` so the forward's own
 * AsyncLocalStorage stores do not reach the handler. `root: undefined` is the naive pairing the
 * context-leak probe must catch.
 */
export interface InMemoryMcpForwardOptions {
  readonly idGenerator: IdGenerator;
  readonly root: AsyncResource | undefined;
  createServer(context: McpRequestSessionContext, scope: StatelessMcpRequestScope): McpServer;
  cancelScopeExecutions(scope: string, reason: ExecutionCancellationReason): Promise<number>;
  forgetScopeBindings(scope: string): void;
  closeReason(): ExecutionCancellationReason;
}

function acrossJsonBoundary(message: JSONRPCMessage): JSONRPCMessage {
  return parseJSONRPCMessage(JSON.parse(JSON.stringify(message)));
}

/** Delegates to `inner`, sending a JSON copy of every message, entered through `enter`. */
class JsonBoundaryTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly enter: <T>(fn: () => T) => T,
  ) {}

  get onclose(): Transport["onclose"] {
    return this.inner.onclose;
  }
  set onclose(handler: Transport["onclose"]) {
    this.inner.onclose = handler;
  }
  get onerror(): Transport["onerror"] {
    return this.inner.onerror;
  }
  set onerror(handler: Transport["onerror"]) {
    this.inner.onerror = handler;
  }
  get onmessage(): Transport["onmessage"] {
    return this.inner.onmessage;
  }
  set onmessage(handler: Transport["onmessage"]) {
    this.inner.onmessage = handler;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const copy = acrossJsonBoundary(message);
    return this.enter(() => this.inner.send(copy, options));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export function inMemoryMcpClientFactory(options: InMemoryMcpForwardOptions): McpClientFactory {
  const enterRoot = <T>(fn: () => T): T => (options.root ? options.root.runInAsyncScope(fn) : fn());
  return async (boundSessionUuid, toolSelectionProfileUuid, releasedSessionUuid) => {
    const requestMcpSessionId = currentLoopbackSessionKey();
    const scope: StatelessMcpRequestScope = {
      requestScopeId: options.idGenerator.next(),
      requestMcpSessionId,
    };
    const context = buildMcpRequestContext({
      boundSessionUuid,
      toolSelectionProfileUuid,
      releasedSessionUuid,
    });
    const server = enterRoot(() => options.createServer(context, scope));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await enterRoot(() => server.connect(new JsonBoundaryTransport(serverSide, (fn) => fn())));
    const client = new LoopbackMcpClient(
      { name: "auto-mobile-daemon-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const closeClient = client.close.bind(client);
    client.close = async () => {
      try {
        await options.cancelScopeExecutions(scope.requestScopeId, options.closeReason());
        await closeClient();
      } finally {
        await server.close();
        if (requestMcpSessionId === undefined) {
          options.forgetScopeBindings(scope.requestScopeId);
        }
      }
    };
    await client.connect(new JsonBoundaryTransport(clientSide, enterRoot));
    return client;
  };
}
