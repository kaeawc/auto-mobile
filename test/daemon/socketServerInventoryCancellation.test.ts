import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, expect, spyOn, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

class InventorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) {
      throw Object.assign(new Error("peer closed"), { code: "EPIPE" });
    }
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close", false);
    return this;
  }
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  clientSockets: Map<string, Socket>;
  activeRequestHandlers: Set<Promise<void>>;
  forwardMcpRequestWithRecovery(options: {
    request: DaemonRequest;
    signal: AbortSignal;
  }): Promise<unknown>;
}
function harness() {
  const state = { isInitialized: () => false } as DaemonStateAccess;
  const server = new UnixSocketServer("unused", "http://localhost:0/mcp", state, new FakeTimer());
  const internal = server as unknown as Internals;
  internal.acceptingRequests = true;
  const connect = () => {
    const socket = new InventorySocket();
    internal.handleConnection(socket as unknown as Socket);
    return socket;
  };
  return { internal, connect };
}
const request = (id: string): DaemonRequest => ({
  id,
  type: "mcp_request",
  method: "resources/read",
  params: { uri: `automobile:devices/${id === "A" ? "booted/android" : "images/android"}` },
});

// Only the socket server's own error logs matter: in the shared-process unit lane an earlier
// file's late async work can log through the same spied logger while a test here runs.
function socketErrorLogs(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(([message]) => String(message).startsWith("Socket error for"));
}

afterEach(() => {
  spyOn(logger, "error").mockRestore();
  spyOn(logger, "debug").mockRestore();
});

test.each(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ECONNABORTED"])(
  "peer-close %s releases the socket with debug logging",
  async (code) => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const { internal, connect } = harness();
    const socket = connect();
    socket.emit("error", Object.assign(new Error("peer closed"), { code }));
    await Promise.all([...internal.activeRequestHandlers]);
    expect(socket.destroyed).toBe(true);
    expect(internal.clientSockets.size).toBe(0);
    expect(socketErrorLogs(error)).toEqual([]);
    expect(debug.mock.calls.some(([message]) => String(message).includes("Socket"))).toBe(true);
  },
);

test("unexpected socket errors retain error logging", async () => {
  const error = spyOn(logger, "error").mockImplementation(() => {});
  const { internal, connect } = harness();
  const socket = connect();
  socket.emit("error", Object.assign(new Error("bad handle"), { code: "EBADF" }));
  await Promise.all([...internal.activeRequestHandlers]);
  expect(socket.destroyed).toBe(true);
  expect(socketErrorLogs(error)).toHaveLength(1);
});

test.each([true, false])(
  "closing A only aborts A, B answers and A's late completion is quiet (honors abort: %s)",
  async (honorsAbort) => {
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const { internal, connect } = harness();
    const a = connect();
    const b = connect();
    const started = Promise.withResolvers<void>();
    const signals = new Map<string, AbortSignal>();
    const results = new Map([
      ["A", Promise.withResolvers<unknown>()],
      ["B", Promise.withResolvers<unknown>()],
    ]);
    internal.forwardMcpRequestWithRecovery = async ({ request: frame, signal }) => {
      signals.set(frame.id, signal);
      if (signals.size === 2) {
        started.resolve();
      }
      const result = results.get(frame.id)!;
      if (honorsAbort) {
        signal.addEventListener("abort", () => result.reject(signal.reason), { once: true });
      }
      return result.promise;
    };
    a.send(request("A"));
    b.send(request("B"));
    await started.promise;
    const handlers = [...internal.activeRequestHandlers];
    a.destroy();
    expect(signals.get("A")?.aborted).toBe(true);
    expect(signals.get("B")?.aborted).toBe(false);
    results.get("B")!.resolve({ contents: [] });
    results.get("A")!.resolve({ contents: [] });
    await Promise.all(handlers);
    expect(b.responses).toEqual([expect.objectContaining({ id: "B", success: true })]);
    expect(a.responses).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    if (honorsAbort) {
      expect(
        debug.mock.calls.filter(([message]) => String(message).includes("MCP forward abandoned")),
      ).toHaveLength(1);
    }
    b.destroy();
    await Promise.all([...internal.activeRequestHandlers]);
  },
);

test("a live client cancel keeps the error response shape and emits no error-level cascade", async () => {
  const errors = spyOn(logger, "error").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  const { internal, connect } = harness();
  const socket = connect();
  const started = Promise.withResolvers<void>();
  internal.forwardMcpRequestWithRecovery = async ({ signal }) => {
    started.resolve();
    return new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  };
  socket.send(request("A"));
  await started.promise;
  socket.send({
    id: "cancel",
    type: "daemon_request",
    method: "daemon/cancelRequest",
    params: { requestId: "A" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all([...internal.activeRequestHandlers]);
  expect(socket.responses.find((frame) => frame.id === "A")).toMatchObject({
    type: "mcp_response",
    success: false,
    error: expect.stringContaining("cancelled by its client"),
  });
  expect(errors).not.toHaveBeenCalled();
  expect(
    debug.mock.calls.filter(([message]) => String(message).includes("MCP forward abandoned")),
  ).toHaveLength(1);
  socket.destroy();
  await Promise.all([...internal.activeRequestHandlers]);
});
