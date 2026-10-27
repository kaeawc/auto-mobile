import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOverloadError, McpTimeoutError } from "../../src/daemon/wire/McpTimeoutError";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import { MCP_FORWARD_START_HEADROOM_MS } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { overloadRefusalError } from "../helpers/refusalWireFixtures";

function createServer(timer: FakeTimer): UnixSocketServerHarness {
  return createHarnessServer(
    join(tmpdir(), `forward-budget-${randomUUID()}.sock`),
    createFakeDaemonState(),
    timer,
  );
}

function requireBudget(
  server: UnixSocketServerHarness,
  request: DaemonRequest,
  totalTimeoutMs: number,
  deadline: ProgressExtendableDeadline,
  phase: string,
): number {
  return server.requireForwardBudget(request, totalTimeoutMs, deadline, phase);
}

const request: DaemonRequest = {
  id: "budget-test",
  type: "mcp_request",
  method: "tools/call",
  params: { name: "observe", arguments: {} },
};

describe("UnixSocketServer MCP forward budget classification", () => {
  test("pins the overload fixture to the real forward-budget refusal", () => {
    const timer = new FakeTimer();
    const server = createServer(timer);
    const deadline = new ProgressExtendableDeadline(timer.now(), 1_000);
    timer.advanceTime(950);

    try {
      requireBudget(server, request, 1_000, deadline, "waiting in queue");
      expect.unreachable("insufficient forward budget should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpOverloadError);
      if (!(error instanceof McpOverloadError)) {
        throw error;
      }
      const fixtureError = overloadRefusalError();
      expect(error.message).toBe(fixtureError.message);
      expect(error.failure).toEqual(fixtureError.failure);
    }
  });

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
      if (!(error instanceof McpOverloadError)) {
        throw error;
      }
      expect(error.failure).toMatchObject({
        code: "daemon_overloaded",
        retryable: true,
        reason: "insufficient_forward_budget",
        queueWaitMs: totalTimeoutMs - remainingTimeoutMs,
        remainingTimeoutMs,
      });
    }
  });
});

test.each(["waiting in queue", "waiting in queues and reconnecting the MCP client"])(
  "expired forward budget marks only an undispatched queue wait: %s",
  (phase) => {
    const timer = new FakeTimer();
    const server = createServer(timer);
    const deadline = new ProgressExtendableDeadline(0, 1000);
    timer.advanceTime(1000);
    try {
      requireBudget(server, request, 1000, deadline, phase);
      expect.unreachable("expired budget should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpTimeoutError);
      if (phase === "waiting in queue") {
        expect(error).toMatchObject({ code: "daemon_queue_timeout" });
      } else {
        expect(error).not.toMatchObject({ code: "daemon_queue_timeout" });
      }
    }
  },
);
