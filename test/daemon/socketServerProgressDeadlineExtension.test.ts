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
import { PROGRESS_NOTIFICATION_METHOD, type DaemonRequest } from "../../src/daemon/types";

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
  signal?: AbortSignal;
  onprogress?: (notification: { progress: number; total?: number; message?: string }) => void;
}

function callHandleIdeRequest(
  server: UnixSocketServer,
  mcpClient: unknown,
  request: DaemonRequest,
  timeoutMs: number,
  socketSessionId: string,
  deadline: ProgressExtendableDeadline,
  originalTimeoutMs: number = timeoutMs,
): Promise<unknown> {
  return (
    server as unknown as {
      handleIdeRequest: (
        c: unknown,
        r: DaemonRequest,
        t: number,
        s: string,
        d: ProgressExtendableDeadline,
        o: number,
      ) => Promise<unknown>;
    }
  ).handleIdeRequest(mcpClient, request, timeoutMs, socketSessionId, deadline, originalTimeoutMs);
}

describe("UnixSocketServer.handleIdeRequest extends the deadline on progress (#6222)", () => {
  test("a progress-emitting tools/call is given an abort signal and a bounded backstop timeout", async () => {
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
    // Progress-driven extension is now driven by this daemon's own abort
    // controller (the SDK's `resetTimeoutOnProgress` cannot express an
    // asymmetric initial-vs-reset window -- see the reconciliation note in
    // `handleIdeRequest`), not the SDK's built-in reset mechanism.
    expect(capturedOptions?.resetTimeoutOnProgress).toBeUndefined();
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
    // The SDK-side timeout/maxTotalTimeout are only a generous backstop
    // pinned to the ceiling -- never the authority for the actual schedule.
    expect(typeof capturedOptions?.maxTotalTimeout).toBe("number");
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

  /**
   * A fake `Client` that behaves like the real MCP SDK with respect to
   * `signal`: it registers an abort listener and rejects exactly as
   * `Protocol.request`'s `cancel()` does, so these tests exercise the REAL
   * race between "does the abort timer fire before the next progress tick"
   * -- not just which options were passed.
   */
  function createAbortAwareFakeMcpClient(
    work: (options: CapturedCallToolOptions) => void | Promise<void>,
  ): {
    callTool: (...args: unknown[]) => Promise<unknown>;
    captured: () => CapturedCallToolOptions;
  } {
    let captured: CapturedCallToolOptions | undefined;
    return {
      callTool: async (
        _params: unknown,
        _resultSchema: unknown,
        options: CapturedCallToolOptions,
      ) => {
        captured = options;
        return await new Promise((resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error(String(options.signal.reason)));
            return;
          }
          options.signal?.addEventListener("abort", () => {
            reject(new Error(String(options.signal?.reason)));
          });
          Promise.resolve(work(options))
            .then(() => resolve({ content: [] }))
            .catch(reject);
        });
      },
      captured: () => captured!,
    };
  }

  test("a queued-start request still gets FULL-WINDOW extensions per tick, not the queue-depleted remainder (#6222 review, P1)", async () => {
    // A 30s setUIState that waited 29s behind another request in the
    // per-session queue arrives at handleIdeRequest with only ~1s of
    // REMAINING budget (`timeoutMs`) -- but its ORIGINAL per-request window
    // (`originalTimeoutMs`, unaffected by queue wait) is still the full 30s.
    // A quick first tick lands within that ~1s window (ordinary setup work),
    // and every extension AFTER it must use the full 30s, not the depleted
    // ~1s remnant, or ordinary device work between later ticks would still
    // time out despite "surviving" the first one.
    const fakeTimer = new FakeTimer();
    const server = createServer(fakeTimer);
    const originalTimeoutMs = 30_000;
    const queueWaitMs = 29_000;
    const remainingTimeoutMs = originalTimeoutMs - queueWaitMs; // 1_000ms left when forwarding starts
    const deadline = new ProgressExtendableDeadline(fakeTimer.now(), originalTimeoutMs);
    // Simulate the queue wait already having elapsed before this forward
    // attempt starts, exactly like `handleRequest` would have.
    fakeTimer.advanceTime(queueWaitMs);

    const fakeMcpClient = createAbortAwareFakeMcpClient(async (options) => {
      // First tick arrives quickly -- well within the ~1s remaining budget.
      fakeTimer.advanceTime(500);
      options.onprogress?.({ progress: 1, total: 5 });
      // Ordinary device work from here on: 20s between ticks, comfortably
      // within a FULL 30s window but far beyond the queue-depleted ~1s
      // remainder that was in effect before the first tick.
      for (let i = 2; i <= 5; i++) {
        fakeTimer.advanceTime(20_000);
        options.onprogress?.({ progress: i, total: 5 });
      }
    });

    const request: DaemonRequest = {
      id: "4",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "setUIState", arguments: {} },
      progressToken: "tok-queued",
    };

    const beforeMs = fakeTimer.now();
    const result = await callHandleIdeRequest(
      server,
      fakeMcpClient,
      request,
      remainingTimeoutMs,
      "socket-1",
      deadline,
      originalTimeoutMs,
    );

    expect(result).toEqual({ content: [] });
    // 80.5s of simulated device work elapsed here -- far more than either
    // the queue-depleted ~1s OR even a single full 30s window -- and the
    // shared deadline was pushed out by each FULL-WINDOW tick to reflect it.
    expect(fakeTimer.now() - beforeMs).toBe(80_500);
    expect(deadline.value).toBeGreaterThan(fakeTimer.now());
  });

  test("a queued-start request that emits NO progress before the first tick times out on the REMAINING budget, not a fresh full window (#6222 reconciliation)", async () => {
    // Same queued-start setup as above (~1s remaining out of a 30s original
    // window) -- but this time NO progress tick arrives before ordinary
    // device work already exceeds that ~1s remainder. It must time out on
    // the remaining budget exactly like a non-progressing call would, NOT
    // survive because a fresh full 30s window was granted up front.
    const fakeTimer = new FakeTimer();
    const server = createServer(fakeTimer);
    const originalTimeoutMs = 30_000;
    const queueWaitMs = 29_000;
    const remainingTimeoutMs = originalTimeoutMs - queueWaitMs; // 1_000ms left
    const deadline = new ProgressExtendableDeadline(fakeTimer.now(), originalTimeoutMs);
    fakeTimer.advanceTime(queueWaitMs);

    const fakeMcpClient = createAbortAwareFakeMcpClient(async () => {
      // 5s of work with NO progress tick at all -- more than 4x the ~1s
      // remaining budget, comfortably within the 30s full window this
      // request would get AFTER a real tick, which never arrives.
      fakeTimer.advanceTime(5_000);
    });

    const request: DaemonRequest = {
      id: "5",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "setUIState", arguments: {} },
      progressToken: "tok-no-initial-progress",
    };

    await expect(
      callHandleIdeRequest(
        server,
        fakeMcpClient,
        request,
        remainingTimeoutMs,
        "socket-1",
        deadline,
        originalTimeoutMs,
      ),
      // Confirms this is genuinely our abort timer firing at the ~1s
      // remaining budget, not some unrelated failure -- the message embeds
      // the exact delay it was armed for.
    ).rejects.toThrow(`Request timed out after ${remainingTimeoutMs}ms`);
  });
});

/**
 * Regression for issue #6222 review, P2: progress delivery to a specific
 * in-flight request must not depend on that socket session's OPTIONAL
 * general-notification subscription. `DaemonMcpProxy.doConnect` deliberately
 * continues, best-effort, when `subscribeToNotifications()` fails or was
 * never sent -- gating progress on that same flag would silently strand a
 * long-running progress-emitting call in exactly that (common, documented)
 * degraded mode: the daemon keeps working under its own extended deadline
 * while the client's local timer -- which only extends on a tick it actually
 * receives -- fires anyway, a split-brain where the daemon succeeds but the
 * client reports failure.
 */
describe("pushProgressNotification is independent of the general notification subscription (#6222 review, P2)", () => {
  function createServerWithFakeSocket(): {
    server: UnixSocketServer;
    sessionId: string;
    writes: string[];
  } {
    const server = new UnixSocketServer(
      join(tmpdir(), `progress-subscription-${randomUUID()}.sock`),
      "http://localhost:0/mcp",
      { isInitialized: () => false },
      new FakeTimer(),
    );
    const sessionId = "socket-unsubscribed";
    const writes: string[] = [];
    const fakeSocket = {
      destroyed: false,
      write: (data: string) => {
        writes.push(data);
        return true;
      },
    };
    (server as unknown as { clientSockets: Map<string, unknown> }).clientSockets.set(
      sessionId,
      fakeSocket,
    );
    return { server, sessionId, writes };
  }

  function push(
    server: UnixSocketServer,
    sessionId: string,
    progressToken: string | number,
    progress: number,
  ): void {
    (
      server as unknown as {
        pushProgressNotification: (s: string, t: string | number, p: number) => void;
      }
    ).pushProgressNotification(sessionId, progressToken, progress);
  }

  test("delivers a progress tick to a session that never subscribed to general notifications", () => {
    const { server, sessionId, writes } = createServerWithFakeSocket();

    // Deliberately never send DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD for this
    // session -- it is not in `notificationSubscribers` at all.
    push(server, sessionId, "tok-1", 1);

    expect(writes.length).toBe(1);
    const frame = JSON.parse(writes[0]);
    expect(frame.method).toBe(PROGRESS_NOTIFICATION_METHOD);
    expect(frame.progressToken).toBe("tok-1");
    expect(frame.progress).toBe(1);
  });

  test("still skips a torn-down (destroyed) socket, subscribed or not", () => {
    const { server, sessionId, writes } = createServerWithFakeSocket();
    const destroyedSocket = (
      server as unknown as { clientSockets: Map<string, { destroyed: boolean }> }
    ).clientSockets.get(sessionId)!;
    destroyedSocket.destroyed = true;

    push(server, sessionId, "tok-2", 1);

    expect(writes.length).toBe(0);
  });

  test("still skips a session with no known socket at all", () => {
    const { server, writes } = createServerWithFakeSocket();

    push(server, "no-such-session", "tok-3", 1);

    expect(writes.length).toBe(0);
  });
});
