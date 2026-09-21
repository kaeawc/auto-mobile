import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOverloadError, McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import { MCP_FORWARD_START_HEADROOM_MS, UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

function createServer(timer: FakeTimer): UnixSocketServer {
  return new UnixSocketServer(
    join(tmpdir(), `forward-budget-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    createFakeDaemonState(),
    timer,
  );
}

function requireBudget(
  server: UnixSocketServer,
  request: DaemonRequest,
  totalTimeoutMs: number,
  deadline: ProgressExtendableDeadline,
  phase: string,
): number {
  return (
    server as unknown as {
      requireRemainingMcpForwardBudget: (
        request: DaemonRequest,
        totalTimeoutMs: number,
        deadline: ProgressExtendableDeadline,
        phase: string,
      ) => number;
    }
  ).requireRemainingMcpForwardBudget(request, totalTimeoutMs, deadline, phase);
}

const request: DaemonRequest = {
  id: "budget-test",
  type: "mcp_request",
  method: "tools/call",
  params: { name: "observe", arguments: {} },
};

describe("UnixSocketServer MCP forward budget classification", () => {
  test("classifies an already-expired deadline as MCP timeout", () => {
    const timer = new FakeTimer();
    timer.advanceTime(1_000);
    const server = createServer(timer);
    const deadline = new ProgressExtendableDeadline(0, 1_000);

    expect(() => requireBudget(server, request, 1_000, deadline, "queueing")).toThrow(
      McpTimeoutError,
    );
    expect(() => requireBudget(server, request, 1_000, deadline, "queueing")).not.toThrow(
      McpOverloadError,
    );
  });

  test("keeps positive but insufficient forward budget as overload", () => {
    const timer = new FakeTimer();
    const server = createServer(timer);
    const totalTimeoutMs = 1_000;
    const remainingTimeoutMs = MCP_FORWARD_START_HEADROOM_MS;
    const deadline = new ProgressExtendableDeadline(timer.now(), totalTimeoutMs);
    timer.advanceTime(totalTimeoutMs - remainingTimeoutMs);

    try {
      requireBudget(server, request, totalTimeoutMs, deadline, "queueing");
      expect.unreachable("insufficient forward budget should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpOverloadError);
      expect((error as McpOverloadError).failure).toMatchObject({
        code: "daemon_overloaded",
        retryable: true,
        reason: "insufficient_forward_budget",
        queueWaitMs: totalTimeoutMs - remainingTimeoutMs,
        remainingTimeoutMs,
      });
    }
  });
});
