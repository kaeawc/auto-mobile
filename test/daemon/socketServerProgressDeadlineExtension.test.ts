import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  ProgressExtendableDeadline,
  MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
} from "../../src/daemon/mcpRequestTimeout";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest } from "../../src/daemon/types";

/**
 * Transport-level regression for issue #6222 (P1 review): `handleIdeRequest`
 * must actually make progress extend the deadline it hands to the inner MCP
 * SDK call, bounded, and the daemon's own pre-flight budget check
 * (`ProgressExtendableDeadline`, threaded via `deadline`) must see that same
 * extension live -- while a request that never emits progress is completely
 * untouched by any of this.
 *
 * `handleIdeRequest` only needs a `Client`-shaped object with the methods it
 * actually calls, so these tests inject a minimal fake instead of a real MCP
 * HTTP server -- no socket, no queue, no session state beyond what
 * `withSocketSessionAutolockKey`'s session-released check reads.
 */
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

function createServer(fakeTimer: FakeTimer): UnixSocketServer {
  return new UnixSocketServer(
    join(tmpdir(), `progress-deadline-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    createFakeDaemonState(),
    fakeTimer,
  );
}

interface CapturedCallToolOptions {
  timeout?: number;
  resetTimeoutOnProgress?: boolean;
  maxTotalTimeout?: number;
  onprogress?: (notification: { progress: number; total?: number; message?: string }) => void;
}

function callHandleIdeRequest(
  server: UnixSocketServer,
  mcpClient: unknown,
  request: DaemonRequest,
  timeoutMs: number,
  socketSessionId: string,
  deadline: ProgressExtendableDeadline,
): Promise<unknown> {
  return (
    server as unknown as {
      handleIdeRequest: (
        c: unknown,
        r: DaemonRequest,
        t: number,
        s: string,
        d: ProgressExtendableDeadline,
      ) => Promise<unknown>;
    }
  ).handleIdeRequest(mcpClient, request, timeoutMs, socketSessionId, deadline);
}

describe("UnixSocketServer.handleIdeRequest extends the deadline on progress (#6222)", () => {
  test("a progress-emitting tools/call gets resetTimeoutOnProgress + a bounded maxTotalTimeout", async () => {
    const fakeTimer = new FakeTimer();
    const server = createServer(fakeTimer);
    const initialTimeoutMs = 30_000;
    const deadline = new ProgressExtendableDeadline(fakeTimer.now(), initialTimeoutMs);

    let capturedOptions: CapturedCallToolOptions | undefined;
    const fakeMcpClient = {
      callTool: async (
        _params: unknown,
        _resultSchema: unknown,
        options: CapturedCallToolOptions,
      ) => {
        capturedOptions = options;
        return { content: [] };
      },
    };

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "setUIState", arguments: {} },
      progressToken: "tok-1",
    };

    const result = await callHandleIdeRequest(
      server,
      fakeMcpClient,
      request,
      initialTimeoutMs,
      "socket-1",
      deadline,
    );

    expect(result).toEqual({ content: [] });
    expect(capturedOptions?.resetTimeoutOnProgress).toBe(true);
    expect(typeof capturedOptions?.maxTotalTimeout).toBe("number");
    // The ceiling is measured from when the request was first received (now,
    // since no time has passed), not from this individual forward attempt.
    expect(capturedOptions?.maxTotalTimeout).toBeGreaterThanOrEqual(
      MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS - 1,
    );
  });

  test("each progress tick extends the shared deadline, surviving well past the original timeout", async () => {
    const fakeTimer = new FakeTimer();
    const server = createServer(fakeTimer);
    const initialTimeoutMs = 30_000;
    const deadline = new ProgressExtendableDeadline(fakeTimer.now(), initialTimeoutMs);

    const fakeMcpClient = {
      callTool: async (
        _params: unknown,
        _resultSchema: unknown,
        options: CapturedCallToolOptions,
      ) => {
        // Simulate slow device work: tick progress every 20s, well past what
        // the ORIGINAL 30s deadline would have allowed, for 100s total.
        for (let i = 0; i < 5; i++) {
          fakeTimer.advanceTime(20_000);
          options.onprogress?.({ progress: i + 1, total: 5 });
        }
        return { content: [] };
      },
    };

    const request: DaemonRequest = {
      id: "2",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "setUIState", arguments: {} },
      progressToken: "tok-2",
    };

    const beforeMs = fakeTimer.now();
    const result = await callHandleIdeRequest(
      server,
      fakeMcpClient,
      request,
      initialTimeoutMs,
      "socket-1",
      deadline,
    );

    expect(result).toEqual({ content: [] });
    // 100s elapsed -- more than 3x the original 30s deadline -- and the
    // shared deadline was pushed out to reflect it (the daemon's own
    // pre-flight budget check, `requireRemainingMcpForwardBudget`, reads
    // this SAME object live).
    expect(fakeTimer.now() - beforeMs).toBe(100_000);
    expect(deadline.value).toBeGreaterThan(fakeTimer.now());
  });

  test("a tools/call with no progressToken never touches resetTimeoutOnProgress/maxTotalTimeout or the deadline", async () => {
    const fakeTimer = new FakeTimer();
    const server = createServer(fakeTimer);
    const initialTimeoutMs = 30_000;
    const deadline = new ProgressExtendableDeadline(fakeTimer.now(), initialTimeoutMs);
    const originalDeadlineValue = deadline.value;

    let capturedOptions: CapturedCallToolOptions | undefined;
    const fakeMcpClient = {
      callTool: async (
        _params: unknown,
        _resultSchema: unknown,
        options: CapturedCallToolOptions,
      ) => {
        capturedOptions = options;
        return { content: [] };
      },
    };

    const request: DaemonRequest = {
      id: "3",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: {} },
      // No progressToken -- this is the vast majority of tool calls.
    };

    await callHandleIdeRequest(
      server,
      fakeMcpClient,
      request,
      initialTimeoutMs,
      "socket-1",
      deadline,
    );

    expect(capturedOptions?.resetTimeoutOnProgress).toBeUndefined();
    expect(capturedOptions?.maxTotalTimeout).toBeUndefined();
    expect(capturedOptions?.onprogress).toBeUndefined();
    // The deadline this request shares is completely untouched.
    expect(deadline.value).toBe(originalDeadlineValue);
  });
});
