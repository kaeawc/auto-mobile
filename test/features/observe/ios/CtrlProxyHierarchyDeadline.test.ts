import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";
import { ActionableError } from "../../../../src/models/ActionableError";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

function context(
  timer: FakeTimer,
  ensureConnected: () => Promise<boolean>,
  send: (data: string) => void,
  socketReadyState: number | null = WebSocket.OPEN,
): { context: HierarchyDelegateContext; requestManager: RequestManager } {
  const requestManager = new RequestManager(timer);
  return {
    context: {
      getWebSocket: () =>
        socketReadyState === null ? null : ({ readyState: socketReadyState, send } as never),
      requestManager,
      timer,
      ensureConnected,
      cancelScreenshotBackoff: () => {},
      cacheFreshTtlMs: 1_000,
      getCachedHierarchy: () => null,
      setCachedHierarchy: () => {},
    },
    requestManager,
  };
}

describe("CtrlProxyHierarchy synchronous deadline", () => {
  test("reports connection_lost during a runner reconnect cooldown", async () => {
    const timer = new FakeTimer();
    const harness = context(
      timer,
      async () => false,
      () => {},
    );
    harness.context.getReconnectStatus = () => ({
      state: "cooldown",
      retryAfterMs: 1000,
      retryAfterSeconds: 1,
      connectionAttempts: 3,
      maxConnectionAttempts: 3,
    });

    const response = await new CtrlProxyHierarchy(harness.context).getLatestHierarchy(false, 100);

    expect(response.unavailableReason).toBe("connection_lost");
    expect(response.reconnectStatus?.state).toBe("cooldown");
  });

  test.each([
    ["simulator_not_booted", undefined],
    ["auto_setup_failed", "runner install failed"],
  ] as const)(
    "propagates connection failure %s to the hierarchy response",
    async (reason, detail) => {
      const timer = new FakeTimer();
      const harness = context(
        timer,
        async () => false,
        () => {},
      );
      harness.context.getLastConnectFailure = () => ({ reason, detail });
      const response = await new CtrlProxyHierarchy(harness.context).getLatestHierarchy(false, 100);
      expect(response.unavailableReason).toBe(reason);
      expect(response.unavailableDetail).toBe(detail);
    },
  );

  test("spends setup time from the hierarchy request budget before dispatch", async () => {
    const timer = new FakeTimer();
    let sends = 0;
    const harness = context(
      timer,
      async () => {
        timer.advanceTime(50);
        return true;
      },
      () => {
        sends += 1;
      },
    );

    const result = await new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      50,
    );

    expect(result).toBeNull();
    expect(sends).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("returns at its deadline while connection setup is still pending", async () => {
    const timer = new FakeTimer();
    let sends = 0;
    const harness = context(
      timer,
      async () => await new Promise<boolean>(() => {}),
      () => {
        sends += 1;
      },
    );

    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      50,
    );
    timer.advanceTime(50);

    await expect(request).resolves.toBeNull();
    expect(sends).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("cancels a registered hierarchy request when the caller aborts", async () => {
    const timer = new FakeTimer();
    const harness = context(
      timer,
      async () => true,
      () => {},
    );
    const controller = new AbortController();
    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      controller.signal,
      100,
    );

    await Promise.resolve();
    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toThrow("caller cancelled");
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("rejects immediately when the CtrlProxy socket is closed", async () => {
    const timer = new FakeTimer();
    const harness = context(
      timer,
      async () => true,
      () => {},
      WebSocket.CLOSED,
    );

    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      5_000,
    );

    await expect(request).rejects.toBeInstanceOf(ActionableError);
    await expect(request).rejects.toThrow("CtrlProxy socket is not connected");
    expect(timer.now()).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("rejects immediately when the CtrlProxy socket is null", async () => {
    const timer = new FakeTimer();
    const harness = context(
      timer,
      async () => true,
      () => {},
      null,
    );

    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      5_000,
    );

    await expect(request).rejects.toBeInstanceOf(ActionableError);
    await expect(request).rejects.toThrow("CtrlProxy socket is not connected");
    expect(timer.now()).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("rejects immediately and clears the waiter when socket send throws", async () => {
    const timer = new FakeTimer();
    const harness = context(
      timer,
      async () => true,
      () => {
        throw new Error("socket write failed");
      },
    );

    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      5_000,
    );

    await expect(request).rejects.toBeInstanceOf(ActionableError);
    await expect(request).rejects.toThrow("CtrlProxy socket is not connected");
    expect(timer.now()).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("preserves a request-scoped runner error instead of reporting a timeout", async () => {
    const timer = new FakeTimer();
    let sent!: (requestId: string) => void;
    const dispatched = new Promise<string>((resolve) => {
      sent = resolve;
    });
    const harness = context(
      timer,
      async () => true,
      (data) => {
        sent((JSON.parse(data) as { requestId: string }).requestId);
      },
    );
    const request = new CtrlProxyHierarchy(harness.context).getLatestHierarchy(false, 100);

    const requestId = await dispatched;
    harness.requestManager.resolveError(requestId, "runner hierarchy failed", 5);

    const response = await request;
    expect(response.unavailableReason).toBe("unknown");
    expect(response.unavailableDetail).toBe("runner hierarchy failed");
  });

  test("reports a genuine hierarchy request timeout", async () => {
    const timer = new FakeTimer();
    let sent!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const harness = context(
      timer,
      async () => true,
      () => sent(),
    );
    const request = new CtrlProxyHierarchy(harness.context).getLatestHierarchy(false, 100);

    await dispatched;
    timer.advanceTime(100);

    const response = await request;
    expect(response.unavailableReason).toBe("request_timed_out");
    expect(response.unavailableDetail).toBeUndefined();
  });

  test("keeps concurrent hierarchy failures attached to their own requests", async () => {
    const timer = new FakeTimer();
    const requestIds: string[] = [];
    let bothSent!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      bothSent = resolve;
    });
    const harness = context(
      timer,
      async () => true,
      (data) => {
        requestIds.push((JSON.parse(data) as { requestId: string }).requestId);
        if (requestIds.length === 2) {
          bothSent();
        }
      },
    );
    const hierarchy = new CtrlProxyHierarchy(harness.context);
    const first = hierarchy.getLatestHierarchy(false, 100);
    const second = hierarchy.getLatestHierarchy(false, 100);

    await dispatched;
    harness.requestManager.resolveError(requestIds[0]!, "first runner failure", 5);
    timer.advanceTime(100);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.unavailableReason).toBe("unknown");
    expect(firstResponse.unavailableDetail).toBe("first runner failure");
    expect(secondResponse.unavailableReason).toBe("request_timed_out");
    expect(secondResponse.unavailableDetail).toBeUndefined();
  });
});
