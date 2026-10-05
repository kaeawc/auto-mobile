import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import {
  DaemonClient,
  DaemonUnavailableError,
  DAEMON_RESPONSE_GRACE_MS,
} from "../../src/daemon/client";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { DaemonDisconnectError } from "../../src/daemon/DaemonDisconnectError";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
  MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
  MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
  resolveMcpRequestTimeoutMs,
  clampCallerMcpRequestTimeoutMs,
  MAX_SETTIMEOUT_DELAY_MS,
} from "../../src/daemon/mcpRequestTimeout";
import {
  DEFAULT_START_DEVICE_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../../src/utils/deviceTimeouts";
import { PROGRESS_NOTIFICATION_METHOD } from "../../src/daemon/types";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";

function createBlackHoleSocket(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function createConnectedClient(fakeTimer: FakeTimer, connectionTimeout = 1000): DaemonClient {
  const client = new DaemonClient("/fake/socket", connectionTimeout, fakeTimer);
  client.attachSocketForTesting(createBlackHoleSocket());
  return client;
}

function createDeferredConnectClient(
  fakeTimer: FakeTimer,
  onConnected?: () => void,
  connectionTimeout = 1000,
): {
  client: DaemonClient;
  connectStarted: Promise<void>;
  releaseConnect: () => void;
  connectTimeouts: number[];
  requests: Array<Record<string, any>>;
} {
  let markConnectStarted = () => {};
  const connectStarted = new Promise<void>((resolve) => {
    markConnectStarted = resolve;
  });
  let releaseConnect = () => {};
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  const connectTimeouts: number[] = [];
  const requests: Array<Record<string, any>> = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      requests.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const client = new DaemonClient("/fake/socket", connectionTimeout, fakeTimer);
  client.connect = async (timeoutMs = 1000) => {
    connectTimeouts.push(timeoutMs);
    markConnectStarted();
    await connectGate;
    client.attachSocketForTesting(socket);
    onConnected?.();
  };
  return {
    client,
    connectStarted,
    releaseConnect,
    connectTimeouts,
    requests,
  };
}

describe("DaemonClient per-request timeout", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
  });

  test("startDevice allows the full default acquisition budget plus response overhead", async () => {
    const client = createConnectedClient(fakeTimer);
    const timeoutMs = DEFAULT_START_DEVICE_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

    const promise = client.callTool("startDevice", {});
    fakeTimer.advanceTime(timeoutMs + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("startDevice");
      expect(timeoutErr.timeoutMs).toBe(timeoutMs);
      expect(timeoutErr.origin).toBe("DaemonClient.sendRequest");
    } finally {
      await client.close();
    }
  });

  test("uninstallApp uses MIN_UNINSTALL_APP_MCP_TIMEOUT_MS", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("uninstallApp", { appId: "com.example.app" });
    fakeTimer.advanceTime(MIN_UNINSTALL_APP_MCP_TIMEOUT_MS + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("uninstallApp");
      expect(timeoutErr.timeoutMs).toBe(MIN_UNINSTALL_APP_MCP_TIMEOUT_MS);
      expect(timeoutErr.origin).toBe("DaemonClient.sendRequest");
    } finally {
      await client.close();
    }
  });

  test("regular tool uses DEFAULT_MCP_REQUEST_TIMEOUT_MS", async () => {
    const client = createConnectedClient(fakeTimer);

    // tapOn has no per-tool floor, so it uses the standard default (unlike observe,
    // launchApp, etc. which carry generous CtrlProxy cold-start floors — #2834).
    const promise = client.callTool("tapOn", {});
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("tapOn");
      expect(timeoutErr.timeoutMs).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      expect(timeoutErr.origin).toBe("DaemonClient.sendRequest");
    } finally {
      await client.close();
    }
  });

  test("startDevice does NOT time out at the old connectionTimeout", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("startDevice", {});
    fakeTimer.advanceTime(1000);

    let resolved = false;
    promise
      .then(() => {
        resolved = true;
      })
      .catch(() => {
        resolved = true;
      });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    await client.close();
  });

  test("callDaemonMethod uses McpTimeoutError", async () => {
    const client = createConnectedClient(fakeTimer, 5000);

    const promise = client.callDaemonMethod("daemon/status");
    fakeTimer.advanceTime(5000 + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("daemon/status");
      expect(timeoutErr.timeoutMs).toBe(5000);
      expect(timeoutErr.origin).toBe("DaemonClient.callDaemonMethod");
    } finally {
      await client.close();
    }
  });

  // Issue #6385: the daemon used to fall back to its 30s default because
  // sendRequest never put timeoutMs on the wire.
  async function sendToolAndCaptureTimeout(
    connectionTimeout: number,
    toolName: string,
  ): Promise<{ wireTimeoutMs: unknown; pendingTimeouts: number[] }> {
    const harness = createDeferredConnectClient(fakeTimer, undefined, connectionTimeout);
    const promise = harness.client.callTool(toolName, {}).catch(() => {});
    await harness.connectStarted;
    harness.releaseConnect();
    await new Promise((resolve) => setImmediate(resolve));
    const result = {
      wireTimeoutMs: harness.requests[0]?.timeoutMs,
      pendingTimeouts: fakeTimer.getPendingTimeouts(),
    };
    await harness.client.close();
    await promise;
    return result;
  }

  test("sendRequest sends the client's own timeout to the daemon", async () => {
    const { wireTimeoutMs, pendingTimeouts } = await sendToolAndCaptureTimeout(120_000, "tapOn");
    expect(wireTimeoutMs).toBe(120_000);
    expect(pendingTimeouts).toEqual([120_000 + DAEMON_RESPONSE_GRACE_MS]);
  });

  test("sendRequest sends a per-tool floor that exceeds the client timeout", async () => {
    const { wireTimeoutMs } = await sendToolAndCaptureTimeout(120_000, "executePlan");
    expect(wireTimeoutMs).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("sendRequest clamps an oversized client timeout before sending it", async () => {
    const { wireTimeoutMs, pendingTimeouts } = await sendToolAndCaptureTimeout(
      MAX_CALLER_MCP_REQUEST_TIMEOUT_MS * 10,
      "tapOn",
    );
    expect(wireTimeoutMs).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
    expect(pendingTimeouts).toEqual([MAX_CALLER_MCP_REQUEST_TIMEOUT_MS + DAEMON_RESPONSE_GRACE_MS]);
  });

  test("callDaemonMethod bounds deferred connect and request to one timeout", async () => {
    const harness = createDeferredConnectClient(fakeTimer);
    const promise = harness.client.callDaemonMethod("daemon/status", {}, { timeoutMs: 1000 });
    await harness.connectStarted;

    fakeTimer.advanceTime(750);
    harness.releaseConnect();
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.connectTimeouts).toEqual([1000]);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.timeoutMs).toBe(250);
    expect(fakeTimer.getPendingTimeouts()).toEqual([250 + DAEMON_RESPONSE_GRACE_MS]);

    fakeTimer.advanceTime(250 + DAEMON_RESPONSE_GRACE_MS);
    try {
      await promise;
      expect.unreachable("connect and request should share the original timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      expect((err as McpTimeoutError).timeoutMs).toBe(1000);
      expect(fakeTimer.now()).toBe(1000 + DAEMON_RESPONSE_GRACE_MS);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await harness.client.close();
    }
  });

  test("callDaemonMethod observes abort after deferred connect before sending", async () => {
    const controller = new AbortController();
    const harness = createDeferredConnectClient(fakeTimer, () => controller.abort());
    const promise = harness.client.callDaemonMethod(
      "daemon/status",
      {},
      { timeoutMs: 1000, signal: controller.signal },
    );
    await harness.connectStarted;

    harness.releaseConnect();

    try {
      await promise;
      expect.unreachable("abort during the connect handoff should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonUnavailableError);
      expect((err as Error).message).toContain("aborted");
      expect(harness.requests).toHaveLength(0);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await harness.client.close();
    }
  });

  test("callDaemonMethod sends and schedules only the budget remaining after connect", async () => {
    const harness = createDeferredConnectClient(fakeTimer);
    const promise = harness.client.callDaemonMethod("daemon/status", {}, { timeoutMs: 1000 });
    await harness.connectStarted;

    fakeTimer.advanceTime(400);
    harness.releaseConnect();
    await new Promise((resolve) => setImmediate(resolve));

    const request = harness.requests[0];
    expect(request?.timeoutMs).toBe(600);
    expect(fakeTimer.getPendingTimeouts()).toEqual([600 + DAEMON_RESPONSE_GRACE_MS]);

    harness.client.simulateIncomingDataForTesting(
      Buffer.from(
        `${JSON.stringify({
          id: request?.id,
          type: "mcp_response",
          success: true,
          result: { ok: true },
        })}\n`,
      ),
    );

    try {
      await expect(promise).resolves.toEqual({ ok: true });
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await harness.client.close();
    }
  });

  test("connectionTimeout overrides per-tool floor when larger", async () => {
    const timeoutMs =
      DEFAULT_START_DEVICE_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS + 60_000;
    const client = createConnectedClient(fakeTimer, timeoutMs);

    const promise = client.callTool("startDevice", {});
    fakeTimer.advanceTime(timeoutMs + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("startDevice");
      expect(timeoutErr.timeoutMs).toBe(timeoutMs);
    } finally {
      await client.close();
    }
  });

  test("surfaces a disconnect cause on each pending request when the client closes", async () => {
    const client = createConnectedClient(fakeTimer);
    const tool = client.callTool("tapOn", {}).catch((error: unknown) => error);
    const resource = client
      .readResource("automobile:devices/booted/android")
      .catch((error: unknown) => error);
    await client.close();

    const [toolError, resourceError] = (await Promise.all([tool, resource])) as Error[];
    expect(toolError).toBeInstanceOf(DaemonUnavailableError);
    expect(resourceError).toBeInstanceOf(DaemonUnavailableError);
    expect(toolError.cause).toBeInstanceOf(DaemonDisconnectError);
    expect(resourceError.cause).toBeInstanceOf(DaemonDisconnectError);
    expect((toolError.cause as DaemonDisconnectError).toolName).toBe("tapOn");
    expect((resourceError.cause as DaemonDisconnectError).toolName).toBe("resources/read");
  });
});

/**
 * Transport-level regression for issue #6222 (P1 review): progress must
 * actually keep this client's OWN local pending-request timer alive past a
 * tool's normal deadline, bounded by MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS
 * -- and a request that stops progressing, or never progressed at all, must
 * still time out at the deadline plus response grace. This is independent of, and in addition
 * to, the daemon's own internal deadline/SDK-call extension (socketServer.ts).
 */
describe("DaemonClient per-request timeout is extended by progress, bounded (#6222)", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
  });

  function deliverProgress(
    client: DaemonClient,
    progressToken: string | number,
    requestId = client.findPendingRequestIdByProgressTokenForTesting(progressToken),
  ): void {
    const frame =
      JSON.stringify({
        type: "daemon_notification",
        method: PROGRESS_NOTIFICATION_METHOD,
        progressToken,
        requestId,
        progress: 1,
        total: 1,
      }) + "\n";
    client.simulateIncomingDataForTesting(Buffer.from(frame));
  }

  test("a request that emits periodic progress survives past its default 30s deadline", async () => {
    const client = createConnectedClient(fakeTimer);
    const progressToken = "progress-survives";

    const promise = client.callTool("setUIState", { fields: [] }, progressToken);
    let settled = false;
    promise.catch(() => {
      settled = true;
    });

    // Advance well past DEFAULT_MCP_REQUEST_TIMEOUT_MS (30s) in steps, feeding
    // a progress tick before each step would otherwise exceed the deadline.
    // Total elapsed: 100s, more than 3x the default.
    for (let i = 0; i < 5; i++) {
      deliverProgress(client, progressToken);
      fakeTimer.advanceTime(20_000);
      await Promise.resolve();
    }

    expect(settled).toBe(false);

    await client.close();
  });

  test("a request that emits progress forever is still killed at the bounded ceiling", async () => {
    const client = createConnectedClient(fakeTimer);
    const progressToken = "progress-forever";

    const promise = client.callTool("setUIState", { fields: [] }, progressToken);

    // Keep progressing indefinitely, well past the ceiling
    // (MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS), advancing in steps
    // smaller than the reset window so the timer keeps getting pushed out --
    // but the hard ceiling must still cut it off.
    const stepMs = 20_000;
    const steps = Math.ceil((MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS + 120_000) / stepMs);
    for (let i = 0; i < steps; i++) {
      deliverProgress(client, progressToken);
      fakeTimer.advanceTime(stepMs);
      await Promise.resolve();
    }

    try {
      await promise;
      expect.unreachable("a request that never stops progressing must still hit the ceiling");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
    } finally {
      await client.close();
    }
  });

  test("a non-progressing request times out at the default plus response grace", async () => {
    const client = createConnectedClient(fakeTimer);

    // No progressToken at all: this call never registers a deadline/progress
    // listener, so it retains its fixed budget plus response grace.
    const promise = client.callTool("tapOn", {});
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.timeoutMs).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    } finally {
      await client.close();
    }
  });

  test("a progress tick for a DIFFERENT token does not extend an unrelated pending request", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("tapOn", {}, "this-calls-own-token");
    deliverProgress(client, "some-other-request-token");
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS + DAEMON_RESPONSE_GRACE_MS);

    try {
      await promise;
      expect.unreachable("should have timed out -- the progress tick was for a different call");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
    } finally {
      await client.close();
    }
  });

  test("two requests reusing a token extend only the matching request id", async () => {
    const client = createConnectedClient(fakeTimer);
    let firstId = "";
    let secondId = "";
    const first = client.callTool("tapOn", {}, "reused", (id) => {
      firstId = id;
    });
    const second = client.callTool("tapOn", {}, "reused", (id) => {
      secondId = id;
    });
    const firstResult = first.catch((error: unknown) => error);
    const secondResult = second.catch((error: unknown) => error);

    expect(firstId).not.toBe(secondId);
    fakeTimer.advanceTime(20_000);
    deliverProgress(client, "reused", secondId);
    deliverProgress(client, "wrong-token", firstId);
    fakeTimer.advanceTime(10_000 + DAEMON_RESPONSE_GRACE_MS);

    expect(await firstResult).toBeInstanceOf(McpTimeoutError);
    expect(client.hasPendingRequestForTesting(secondId)).toBe(true);
    await client.close();
    expect(await secondResult).toBeInstanceOf(DaemonUnavailableError);
  });
});

const responseGraceMs = DAEMON_RESPONSE_GRACE_MS;
const queueTimeoutCode = "daemon_queue_timeout";

describe("DaemonClient daemon deadline response precedes the backstop", () => {
  function setup() {
    const timer = new FakeTimer();
    const socket = new FakeSocket();
    const client = new DaemonClient("/fake/socket", 1000, timer, {}, null);
    client.attachSocketForTesting(socket);
    const respond = (response: DaemonResponse) =>
      client.simulateIncomingDataForTesting(Buffer.from(JSON.stringify(response) + "\n"));
    return { client, timer, socket, respond };
  }

  for (const kind of ["tool", "resource", "control"] as const) {
    function send(client: DaemonClient) {
      return kind === "tool"
        ? client.callTool("tapOn", {})
        : kind === "resource"
          ? client.readResource("automobile:devices/booted")
          : client.callDaemonMethod("daemon/status", {}, { timeoutMs: 5000 });
    }

    test(`${kind}: preserves a structured daemon error exactly at its deadline without cancel`, async () => {
      const { client, timer, socket, respond } = setup();
      const outcome = send(client).catch((error: unknown) => error);
      const request = socket.getWrittenMessages<DaemonRequest>()[0];
      const message =
        "MCP timeout: tapOn exceeded its deadline (timed out in queue before admission)";
      try {
        timer.advanceTime(request.timeoutMs!);
        respond({
          id: request.id,
          type: "mcp_response",
          success: false,
          error: message,
          code: queueTimeoutCode,
        });
        expect(await outcome).toMatchObject({ message, code: queueTimeoutCode });
        timer.advanceTime(responseGraceMs);
        expect(socket.getWrittenMessages()).toHaveLength(1);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        await client.close();
        await outcome;
      }
    });

    test(`${kind}: preserves a successful result exactly at the daemon deadline`, async () => {
      const { client, timer, socket, respond } = setup();
      const outcome = send(client).catch((error: unknown) => error);
      const request = socket.getWrittenMessages<DaemonRequest>()[0];
      const result = { content: [{ type: "text", text: "terminal answer" }], isError: true };
      try {
        timer.advanceTime(request.timeoutMs!);
        respond({ id: request.id, type: "mcp_response", success: true, result });
        expect(await outcome).toEqual(result);
        timer.advanceTime(responseGraceMs);
        expect(socket.getWrittenMessages()).toHaveLength(1);
      } finally {
        await client.close();
        await outcome;
      }
    });

    test(`${kind}: cancels exactly once only at budget plus grace and ignores a late answer`, async () => {
      const { client, timer, socket, respond } = setup();
      const outcome = send(client).catch((error: unknown) => error);
      const request = socket.getWrittenMessages<DaemonRequest>()[0];
      try {
        timer.advanceTime(request.timeoutMs! + responseGraceMs - 1);
        expect(client.hasPendingRequestForTesting(request.id)).toBe(true);
        expect(socket.getWrittenMessages()).toHaveLength(1);
        timer.advanceTime(1);
        const error = await outcome;
        expect(error).toBeInstanceOf(McpTimeoutError);
        expect(error).toMatchObject({ timeoutMs: request.timeoutMs });
        expect((error as Error).message).toContain(
          "no response from the daemon within budget + grace",
        );
        const frames = socket.getWrittenMessages<DaemonRequest>();
        expect(frames).toHaveLength(2);
        expect(frames[1]).toMatchObject({
          method: DAEMON_CANCEL_REQUEST_METHOD,
          params: { requestId: request.id },
        });
        expect(() =>
          respond({ id: request.id, type: "mcp_response", success: true, result: {} }),
        ).not.toThrow();
        respond({
          id: frames[1].id,
          type: "mcp_response",
          success: true,
          result: { cancelled: true },
        });
        timer.advanceTime(responseGraceMs);
        expect(socket.getWrittenMessages()).toHaveLength(2);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        await client.close();
        await outcome;
      }
    });
  }

  for (const callerBudget of [
    clampCallerMcpRequestTimeoutMs(1)!,
    DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
  ]) {
    test(`daemon deadline precedes client timer for caller budget ${callerBudget}`, async () => {
      const { client, timer, socket } = setup();
      const outcome = client
        .callDaemonMethod("daemon/status", {}, { timeoutMs: callerBudget })
        .catch((error: unknown) => error);
      try {
        const request = socket.getWrittenMessages<DaemonRequest>()[0];
        const daemonBudget = resolveMcpRequestTimeoutMs(request);
        expect(request.timeoutMs).toBe(callerBudget);
        expect(timer.getPendingTimeouts()).toEqual([daemonBudget + responseGraceMs]);
        expect(timer.getPendingTimeouts()[0]).toBeGreaterThan(daemonBudget);
      } finally {
        await client.close();
        await outcome;
      }
    });
  }

  test("progress re-arms the daemon budget plus grace, including at its ceiling", async () => {
    const { client, timer, socket, respond } = setup();
    let requestId = "";
    const outcome = client
      .callTool("tapOn", {}, "progress", (id) => {
        requestId = id;
      })
      .catch((error: unknown) => error);
    const progress = () =>
      client.simulateIncomingDataForTesting(
        Buffer.from(
          JSON.stringify({
            type: "daemon_notification",
            method: PROGRESS_NOTIFICATION_METHOD,
            progressToken: "progress",
            requestId,
            progress: 1,
          }) + "\n",
        ),
      );
    try {
      timer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS - 1);
      progress();
      expect(timer.getPendingTimeouts()).toEqual([
        DEFAULT_MCP_REQUEST_TIMEOUT_MS + responseGraceMs,
      ]);
      while (
        timer.now() <
        MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS - DEFAULT_MCP_REQUEST_TIMEOUT_MS
      ) {
        timer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS - 1);
        progress();
      }
      const remaining = MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS - timer.now();
      expect(timer.getPendingTimeouts()).toEqual([remaining + responseGraceMs]);
      timer.advanceTime(remaining);
      respond({
        id: requestId,
        type: "mcp_response",
        success: false,
        error: "daemon progress ceiling reached",
        code: "started_timeout",
      });
      expect(await outcome).toMatchObject({
        message: "daemon progress ceiling reached",
        code: "started_timeout",
      });
      expect(socket.getWrittenMessages()).toHaveLength(1);
    } finally {
      await client.close();
      await outcome;
    }
  });
});

test.each(["timeout", "reply", "abort"])(
  "native timer limit preserves response grace and cleanup on %s",
  async (terminal) => {
    const timer = new FakeTimer();
    const scheduleFakeTimeout = timer.setTimeout.bind(timer);
    // Model the documented Node/Bun overflow rule without a real timer.
    timer.setTimeout = (callback, ms) =>
      scheduleFakeTimeout(callback, ms > MAX_SETTIMEOUT_DELAY_MS ? 1 : ms);
    const socket = new FakeSocket();
    const client = new DaemonClient("/fake/socket", 1000, timer, {}, null);
    client.attachSocketForTesting(socket);
    const controller = new AbortController();
    const outcome = client
      .callTool(
        "tapOn",
        { action: "longPress", duration: Number.MAX_SAFE_INTEGER },
        undefined,
        undefined,
        controller.signal,
      )
      .catch((error: unknown) => error);
    const request = socket.getWrittenMessages<DaemonRequest>()[0];
    try {
      expect(request.timeoutMs).toBe(MAX_SETTIMEOUT_DELAY_MS);
      timer.advanceTime(MAX_SETTIMEOUT_DELAY_MS);
      expect(client.hasPendingRequestForTesting(request.id)).toBe(true);
      expect(socket.getWrittenMessages()).toHaveLength(1);
      expect(timer.getPendingTimeouts()).toEqual([DAEMON_RESPONSE_GRACE_MS]);
      if (terminal === "reply") {
        client.simulateIncomingDataForTesting(
          Buffer.from(
            JSON.stringify({
              id: request.id,
              type: "mcp_response",
              success: true,
              result: { ok: true },
            }) + "\n",
          ),
        );
        expect(await outcome).toEqual({ ok: true });
      } else if (terminal === "abort") {
        controller.abort(new Error("cancel long wait"));
        expect(await outcome).toBe(controller.signal.reason);
      }
      timer.advanceTime(DAEMON_RESPONSE_GRACE_MS);
      if (terminal === "timeout") {
        expect(await outcome).toBeInstanceOf(McpTimeoutError);
      }
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(socket.getWrittenMessages()).toHaveLength(terminal === "reply" ? 1 : 2);
    } finally {
      await client.close();
      await outcome;
    }
  },
);
