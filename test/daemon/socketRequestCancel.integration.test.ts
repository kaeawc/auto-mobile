import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, Socket, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { provisionCancellationOutcomes } from "../../src/server/provisionCancellationOutcomes";
import { DAEMON_RESPONSE_GRACE_MS, DaemonClient } from "../../src/daemon/client";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

// Issue #6384: a client that abandons a request must tell the daemon, so the
// daemon stops holding the per-socket FIFO for work nobody awaits.

const CLIENT_TIMEOUT_MS = 1_000;
/** Real-time ceiling for loopback socket I/O; well inside bun's 5s test timeout. */
const IO_DEADLINE_MS = 2_000;

/** Resolve when `predicate` holds, re-checked on every `notify()`; bounded by a real deadline. */
class Condition {
  private waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  async until(predicate: () => boolean, what: string): Promise<void> {
    const deadlineAt = Date.now() + IO_DEADLINE_MS;
    while (!predicate()) {
      if (Date.now() > deadlineAt) {
        throw new Error(`Timed out waiting for ${what}`);
      }
      await new Promise<void>((resolve) => {
        const handle = defaultTimer.setTimeout(resolve, 5);
        this.waiters.push(() => {
          defaultTimer.clearTimeout(handle);
          resolve();
        });
      });
    }
  }
}

function tempSocketPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomUUID()}.sock`);
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (existsSync(socketPath)) {
    await unlink(socketPath);
  }
}

describe("DaemonClient cancel frame (issue #6384)", () => {
  let socketPath: string;
  let server: Server;
  let frames: DaemonRequest[];
  let serverSockets: Socket[];
  let arrived: Condition;

  beforeEach(async () => {
    socketPath = tempSocketPath("client-cancel");
    frames = [];
    serverSockets = [];
    arrived = new Condition();
    server = createServer((socket) => {
      serverSockets.push(socket);
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter((l) => l.trim())) {
          frames.push(JSON.parse(line));
        }
        arrived.notify();
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    for (const socket of serverSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeSocketFile(socketPath);
  });

  test("a timed-out tools/call writes a cancel frame naming its request id", async () => {
    const timer = new FakeTimer();
    const client = new DaemonClient(socketPath, CLIENT_TIMEOUT_MS, timer, {}, null);
    await client.connect();
    try {
      const call = client.callTool("installApp", {});
      await arrived.until(() => frames.length === 1, "the tools/call frame");
      expect(frames.map((frame) => frame.method)).toEqual(["tools/call"]);

      timer.advanceTime(timer.getPendingTimeouts().reduce((max, ms) => Math.max(max, ms), 0));
      await expect(call).rejects.toBeInstanceOf(McpTimeoutError);

      await arrived.until(() => frames.length === 2, "the cancel frame");
      const [request, cancel] = frames;
      expect(cancel.type).toBe("daemon_request");
      expect(cancel.method).toBe(DAEMON_CANCEL_REQUEST_METHOD);
      expect(cancel.params).toEqual({ requestId: request.id });
      expect(cancel.id).not.toBe(request.id);
    } finally {
      await client.close();
    }
  });

  test("a timed-out daemon method call also writes a cancel frame", async () => {
    const timer = new FakeTimer();
    const client = new DaemonClient(socketPath, CLIENT_TIMEOUT_MS, timer, {}, null);
    await client.connect();
    try {
      const call = client.callDaemonMethod("daemon/availableDevices", {}, { timeoutMs: 50 });
      await arrived.until(() => frames.length === 1, "the daemon request frame");

      timer.advanceTime(50 + DAEMON_RESPONSE_GRACE_MS);
      await expect(call).rejects.toBeInstanceOf(McpTimeoutError);

      await arrived.until(() => frames.length === 2, "the cancel frame");
      expect(frames[1].method).toBe(DAEMON_CANCEL_REQUEST_METHOD);
      expect(frames[1].params).toEqual({ requestId: frames[0].id });
    } finally {
      await client.close();
    }
  });

  test("late answers to the cancelled request and its cancel frame are dropped without an unknown-id warning", async () => {
    const warnSpy = spyOn(logger, "warn");
    const timer = new FakeTimer();
    const client = new DaemonClient(socketPath, CLIENT_TIMEOUT_MS, timer, {}, null);
    await client.connect();
    try {
      const abandoned = client.callDaemonMethod("daemon/availableDevices", {}, { timeoutMs: 50 });
      await arrived.until(() => frames.length === 1, "the daemon request frame");
      timer.advanceTime(50 + DAEMON_RESPONSE_GRACE_MS);
      await expect(abandoned).rejects.toBeInstanceOf(McpTimeoutError);
      await arrived.until(() => frames.length === 2, "the cancel frame");

      const next = client.callDaemonMethod("daemon/availableDevices", {}, { timeoutMs: 50 });
      await arrived.until(() => frames.length === 3, "the follow-up request");
      const answer = (id: string, success: boolean): string =>
        JSON.stringify({ id, type: "mcp_response", success, result: {} } satisfies DaemonResponse) +
        "\n";
      // Same socket, in order: both late answers are processed before the follow-up's.
      serverSockets[0].write(
        answer(frames[0].id, false) + answer(frames[1].id, true) + answer(frames[2].id, true),
      );
      await next;

      const unknownIdWarnings = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("unknown request ID"),
      );
      expect(unknownIdWarnings).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      await client.close();
    }
  });
});

interface FakeToolCall {
  name: string;
  signal: AbortSignal | undefined;
  settle: (value: unknown) => void;
  arguments?: Record<string, unknown>;
}

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
      recordHeartbeat: () => {},
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
      releaseMcpSessionBindings: () => {},
    }),
  };
}

describe("UnixSocketServer cancel frame (issue #6384)", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let calls: FakeToolCall[];
  let callsChanged: Condition;

  beforeEach(async () => {
    socketPath = tempSocketPath("daemon-cancel");
    calls = [];
    callsChanged = new Condition();
    const serverTimer = new FakeTimer();
    serverTimer.enableAutoAdvance();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      serverTimer,
    );
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      // Settles only when the test says so, or rejects on abort like the MCP SDK client.
      callTool: (params: { name: string }, _schema: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const signal = options?.signal;
          calls.push({ name: params.name, signal, settle: resolve });
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
            callsChanged.notify();
          });
          callsChanged.notify();
        }),
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });
    await server.start();
  });

  afterEach(async () => {
    for (const call of calls) {
      call.settle({ content: [] });
    }
    await server.close();
    await removeSocketFile(socketPath);
  });

  test("a client timeout aborts the in-flight forward and the next call on the socket runs", async () => {
    const clientTimer = new FakeTimer();
    const warnSpy = spyOn(logger, "warn");
    const client = new DaemonClient(socketPath, CLIENT_TIMEOUT_MS, clientTimer, {}, null);
    try {
      const slow = client.callTool("installApp", { deviceId: "device-1" });
      await callsChanged.until(() => calls.length === 1, "the slow forward to start");

      clientTimer.advanceTime(
        clientTimer.getPendingTimeouts().reduce((max, ms) => Math.max(max, ms), 0),
      );
      await expect(slow).rejects.toBeInstanceOf(McpTimeoutError);
      await callsChanged.until(() => calls[0].signal?.aborted === true, "the forward to abort");

      // The abandoned forward is abandoned; the next call is forwarded and answered.
      const next = client.callTool("observe", { deviceId: "device-1" });
      await callsChanged.until(() => calls.length === 2, "the next forward to start");
      expect(calls.map((call) => call.name)).toEqual(["installApp", "observe"]);
      calls[1].settle({ content: [{ type: "text", text: "ok" }] });
      expect(await next).toEqual({ content: [{ type: "text", text: "ok" }] });

      const unknownIdWarnings = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("unknown request ID"),
      );
      expect(unknownIdWarnings).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      await client.close();
    }
  });

  test("a cancelled request still waiting in the socket queue is never forwarded", async () => {
    const socket = new Socket();
    const responses = new Map<string, DaemonResponse>();
    const responded = new Condition();
    await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim())) {
        const response: DaemonResponse = JSON.parse(line);
        responses.set(response.id, response);
      }
      responded.notify();
    });
    const send = (request: DaemonRequest): void => {
      socket.write(JSON.stringify(request) + "\n");
    };
    const toolCall = (id: string, name: string): DaemonRequest => ({
      id,
      type: "mcp_request",
      method: "tools/call",
      params: { name, arguments: { deviceId: "device-1" } },
    });
    const cancel = (id: string, requestId: string): DaemonRequest => ({
      id,
      type: "daemon_request",
      method: DAEMON_CANCEL_REQUEST_METHOD,
      params: { requestId },
    });

    try {
      send(toolCall("a", "installApp"));
      await callsChanged.until(() => calls.length === 1, "request a to start");
      send(toolCall("b", "launchApp"));
      send(cancel("cancel-b", "b"));
      // Answered out-of-band while a still holds the queue.
      await responded.until(() => responses.has("cancel-b"), "the cancel-b ack");
      expect(responses.get("cancel-b")?.result).toEqual({ cancelled: true });

      send(toolCall("c", "observe"));
      send(cancel("cancel-a", "a"));
      await callsChanged.until(() => calls.length === 2, "request c to start");

      expect(calls.map((call) => call.name)).toEqual(["installApp", "observe"]);
      expect(calls[0].signal?.aborted).toBe(true);
      await responded.until(() => responses.has("a") && responses.has("b"), "a and b answers");
      expect(responses.get("a")?.success).toBe(false);
      expect(responses.get("b")?.success).toBe(false);
      expect(responses.get("b")?.error).toContain("cancelled by its client");

      calls[1].settle({ content: [] });
      await responded.until(() => responses.has("c"), "the c answer");
      expect(responses.get("c")?.success).toBe(true);

      send(cancel("cancel-done", "c"));
      await responded.until(() => responses.has("cancel-done"), "the late cancel ack");
      expect(responses.get("cancel-done")?.result).toEqual({ cancelled: false });
    } finally {
      socket.destroy();
    }
  });

  test("a cancel frame without a request id is rejected", async () => {
    const client = new DaemonClient(socketPath, CLIENT_TIMEOUT_MS, new FakeTimer(), {}, null);
    try {
      await expect(client.callDaemonMethod(DAEMON_CANCEL_REQUEST_METHOD, {})).rejects.toThrow(
        "requires a non-empty string params.requestId",
      );
    } finally {
      await client.close();
    }
  });
});

describe("UnixSocketServer provisionDevice cancel reply (issue #11074)", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let serverTimer: FakeTimer;
  let calls: FakeToolCall[];
  let callsChanged: Condition;

  beforeEach(async () => {
    socketPath = tempSocketPath("daemon-provision-cancel");
    calls = [];
    callsChanged = new Condition();
    serverTimer = new FakeTimer();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      serverTimer,
    );
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: (
        params: { name: string; arguments?: Record<string, unknown> },
        _schema: unknown,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((resolve, reject) => {
          const signal = options?.signal;
          calls.push({ name: params.name, signal, settle: resolve, arguments: params.arguments });
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
            callsChanged.notify();
          });
          callsChanged.notify();
        }),
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    await removeSocketFile(socketPath);
  });

  async function cancelProvision(): Promise<DaemonResponse> {
    const socket = new Socket();
    const responses = new Map<string, DaemonResponse>();
    const responded = new Condition();
    await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim())) {
        const response: DaemonResponse = JSON.parse(line);
        responses.set(response.id, response);
      }
      responded.notify();
    });
    try {
      socket.write(
        JSON.stringify({
          id: "prov",
          type: "mcp_request",
          method: "tools/call",
          params: { name: "provisionDevice", arguments: {} },
        } satisfies DaemonRequest) + "\n",
      );
      await callsChanged.until(() => calls.length === 1, "the provision forward to start");
      socket.write(
        JSON.stringify({
          id: "cancel-prov",
          type: "daemon_request",
          method: DAEMON_CANCEL_REQUEST_METHOD,
          params: { requestId: "prov" },
        } satisfies DaemonRequest) + "\n",
      );
      await callsChanged.until(() => calls[0].signal?.aborted === true, "the forward to abort");
      // The handler finishes its rollback after the daemon abandoned the request, and publishes
      // under the per-call key the daemon forwarded with it (#11065: no operationId).
      const callKey = calls[0].arguments?.__mcpLiveDeadlineKey;
      expect(typeof callKey).toBe("string");
      await callsChanged.until(
        () => provisionCancellationOutcomes.isAwaiting(callKey as string),
        "the daemon to await the handler result",
      );
      provisionCancellationOutcomes.publish(callKey as string, {
        isError: true,
        content: [{ type: "text", text: '{"error":{"code":"request_cancelled"},"recovery":{}}' }],
      });
      await responded.until(() => responses.has("prov"), "the provision answer");
      return responses.get("prov")!;
    } finally {
      socket.destroy();
    }
  }

  test("the reply to a cancelled provisionDevice carries the handler's request_cancelled result", async () => {
    const response = await cancelProvision();

    expect(response.success).toBe(true);
    expect(response.result.content[0].text).toContain("request_cancelled");
  });

  test("without a handler result the reply stays the generic abandonment error", async () => {
    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
    let received = "";
    const responded = new Condition();
    socket.on("data", (data) => {
      received += data.toString();
      responded.notify();
    });
    try {
      socket.write(
        JSON.stringify({
          id: "prov2",
          type: "mcp_request",
          method: "tools/call",
          params: { name: "provisionDevice", arguments: {} },
        }) + "\n",
      );
      await callsChanged.until(() => calls.length === 1, "the provision forward to start");
      socket.write(
        JSON.stringify({
          id: "cancel-prov2",
          type: "daemon_request",
          method: DAEMON_CANCEL_REQUEST_METHOD,
          params: { requestId: "prov2" },
        }) + "\n",
      );
      await callsChanged.until(() => calls[0].signal?.aborted === true, "the forward to abort");
      await responded.until(() => received.includes("cancel-prov2"), "the cancel ack");
      serverTimer.advanceTime(60_000);
      await responded.until(() => received.includes('"id":"prov2"'), "the provision answer");
      expect(received).toContain("cancelled by its client");
    } finally {
      socket.destroy();
    }
  });
});
