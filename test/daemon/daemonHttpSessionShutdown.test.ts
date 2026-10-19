import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonHandoffInterruptionError } from "../../src/daemon/daemonHandoffInterruption";
import { DaemonState } from "../../src/daemon/daemonState";
import { type ActiveExecution, executionTracker } from "../../src/daemon/executionTracker";
import type {
  StatelessMcpHttpEndpoint,
  StatelessMcpRequestScope,
} from "../../src/daemon/statelessMcpHttpEndpoint";

interface ClosableTransport {
  close(): Promise<void>;
}

interface DaemonHttpIngressInternals {
  acceptingHttpSessions: boolean;
  startupCompleted: boolean;
  mcpHttpEndpoint: StatelessMcpHttpEndpoint<FakeMcpRequest, FakeResponse, BlockingTransport>;
  mcpHttpTransportFactory: () => BlockingTransport;
  mcpRequestServerFactory: (req: FakeMcpRequest, scope: StatelessMcpRequestScope) => FakeMcpServer;
  handleMcpHttpRequest(req: FakeMcpRequest, res: FakeResponse): Promise<void>;
  readHttpBody(
    req: IncomingMessage,
  ): Promise<{ ok: true; body: string } | { ok: false; status: number; error: string }>;
}

interface DaemonHttpSessionInternals {
  httpIngress: DaemonHttpIngressInternals;
  socketServer: { quiesce(): Promise<void> } | null;
  quiesceProvisioningIngress(): Promise<void>;
  interruptProvisioningForShutdown(): Promise<void>;
}

class FakeRequest extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

class FakeMcpRequest extends EventEmitter {
  readonly method = "POST";
  readonly headers = {};
}

class FakeResponse extends EventEmitter {
  statusCode = 0;
  body = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(): boolean {
    return true;
  }

  end(body?: string): this {
    this.body = body ?? "";
    this.writableEnded = true;
    return this;
  }
}

/** One request's transport: its response stays open until the transport closes. */
class BlockingTransport implements ClosableTransport {
  closeCalls = 0;
  private markStarted!: () => void;
  private markClosed!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly closed = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  async handleRequest(): Promise<void> {
    this.markStarted();
    await this.closed;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.markClosed();
  }
}

class FakeMcpServer {
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
}

/** A daemon whose MCP requests each start one tracked execution keyed on their request scope. */
function statelessDaemon(): {
  daemon: Daemon;
  internals: DaemonHttpSessionInternals;
  transport: BlockingTransport;
  executions: ActiveExecution[];
} {
  const daemon = new Daemon({}, { timer: new FakeTimer() });
  const internals = daemon as unknown as DaemonHttpSessionInternals;
  const transport = new BlockingTransport();
  const executions: ActiveExecution[] = [];
  internals.httpIngress.mcpHttpTransportFactory = () => transport;
  internals.httpIngress.mcpRequestServerFactory = (_req, scope) => {
    const execution = executionTracker.startExecution("observe", scope.requestScopeId);
    execution.abortController.signal.addEventListener(
      "abort",
      () => executionTracker.endExecution(execution.id),
      { once: true },
    );
    executions.push(execution);
    return new FakeMcpServer();
  };
  return { daemon, internals, transport, executions };
}

const TOOLS_CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "observe" } };

describe("Daemon HTTP session shutdown", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("a request whose body arrives after HTTP admission is quiesced answers 503 without a server", async () => {
    const { internals, executions } = statelessDaemon();
    internals.httpIngress.acceptingHttpSessions = true;
    internals.httpIngress.startupCompleted = true;
    const req = new FakeMcpRequest();
    const res = new FakeResponse();
    const handled = internals.httpIngress.handleMcpHttpRequest(req, res);
    // Startup admission is awaited first; the body is read on a later turn.
    for (let turn = 0; turn < 20 && req.listenerCount("end") === 0; turn++) {
      await Promise.resolve();
    }
    internals.httpIngress.acceptingHttpSessions = false;
    req.emit("data", Buffer.from(JSON.stringify(TOOLS_CALL)));
    req.emit("end");
    await handled;

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "Daemon is shutting down" });
    expect(executions).toEqual([]);
    expect(internals.httpIngress.mcpHttpEndpoint.inFlightCount).toBe(0);
  });

  test("shutdown closes an in-flight request and cancels its work with the handoff reason", async () => {
    const { daemon, internals, transport, executions } = statelessDaemon();
    const handled = internals.httpIngress.mcpHttpEndpoint.handle(
      new FakeMcpRequest(),
      new FakeResponse(),
      TOOLS_CALL,
      () => {},
    );
    await transport.started;
    daemon.testHooks.markShutdownInProgress();

    const inFlight = internals.httpIngress.mcpHttpEndpoint.inFlightRequests();
    expect(inFlight).toHaveLength(1);
    await Promise.all(inFlight.map((request) => request.close()));
    await handled;

    expect(executions[0]!.abortController.signal.reason).toBeInstanceOf(
      DaemonHandoffInterruptionError,
    );
    expect(transport.closeCalls).toBe(1);
    expect(internals.httpIngress.mcpHttpEndpoint.inFlightCount).toBe(0);
  });

  test("a response that closes early cancels only that request's work", async () => {
    const { internals, transport, executions } = statelessDaemon();
    const res = new FakeResponse();
    const handled = internals.httpIngress.mcpHttpEndpoint.handle(
      new FakeMcpRequest(),
      res,
      TOOLS_CALL,
      () => {},
    );
    await transport.started;
    const sibling = executionTracker.startExecution("observe", "another-request-scope");
    try {
      res.emit("close");
      await handled;

      // A string reason aborts without a signal reason; only this request's scope is hit.
      expect(executions[0]!.abortController.signal.aborted).toBeTrue();
      expect(executions[0]!.abortController.signal.reason).not.toBeInstanceOf(
        DaemonHandoffInterruptionError,
      );
      expect(sibling.abortController.signal.aborted).toBeFalse();
      expect(internals.httpIngress.mcpHttpEndpoint.inFlightCount).toBe(0);
    } finally {
      executionTracker.endExecution(sibling.id);
    }
  });

  test("HTTP body read preserves UTF-8 split across data events", async () => {
    const daemon = new Daemon({}, { timer: new FakeTimer() });
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.httpIngress.readHttpBody(req as unknown as IncomingMessage);
    const body = Buffer.from('{"text":"日"}');
    const split = body.indexOf(Buffer.from("日")) + 1;
    req.emit("data", body.subarray(0, split));
    req.emit("data", body.subarray(split));
    req.emit("end");
    expect(await read).toEqual({ ok: true, body: '{"text":"日"}' });
  });

  test("HTTP body read settles when upload closes without end", async () => {
    const daemon = new Daemon({}, { timer: new FakeTimer() });
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.httpIngress.readHttpBody(req as unknown as IncomingMessage);
    req.emit("data", Buffer.from("partial"));
    req.emit("close");
    expect(await read).toEqual({ ok: false, status: 400, error: "Request closed" });
  });

  test.each(["aborted", "error"])("HTTP body read settles on %s", async (event) => {
    const daemon = new Daemon({}, { timer: new FakeTimer() });
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.httpIngress.readHttpBody(req as unknown as IncomingMessage);
    req.emit(event, event === "error" ? new Error("connection reset") : undefined);
    const result = await read;
    expect(result.ok).toBeFalse();
    expect(req.listenerCount("data")).toBe(0);
  });

  test("HTTP body read times out a stalled upload", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon({}, { timer });
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.httpIngress.readHttpBody(req as unknown as IncomingMessage);
    timer.advanceTime(60_000);
    expect(await read).toEqual({ ok: false, status: 408, error: "Request body timed out" });
    expect(req.destroyed).toBeTrue();
  });

  test("interrupts and drains provisioning before the sequential shutdown stages", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const execution = executionTracker.startExecution("provisionDevice", "provision-session");
    execution.abortController.signal.addEventListener(
      "abort",
      () => executionTracker.endExecution(execution.id),
      { once: true },
    );

    await internals.interruptProvisioningForShutdown();

    expect(execution.abortController.signal.reason).toBeInstanceOf(DaemonHandoffInterruptionError);
    expect(
      executionTracker.hasActiveToolExecution("provisionDevice", { scope: "global" }),
    ).toBeFalse();
  });

  test("closes HTTP and control-socket provisioning ingress before cancellation", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    let quiesced = false;
    internals.httpIngress.acceptingHttpSessions = true;
    internals.socketServer = {
      async quiesce() {
        quiesced = true;
      },
    };

    await internals.quiesceProvisioningIngress();

    expect(internals.httpIngress.acceptingHttpSessions).toBeFalse();
    expect(quiesced).toBeTrue();
  });
});
