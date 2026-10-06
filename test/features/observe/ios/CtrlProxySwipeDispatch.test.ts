import { describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import { ActionableError } from "../../../../src/models/ActionableError";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

/** Issue #9972: a single-finger iOS swipe must report a sent-but-unanswered request. */
function requestSwipe(
  h: ReturnType<typeof createIosDelegateHarness>,
  signal: AbortSignal,
  onDispatch: () => void,
) {
  return new CtrlProxyGestures(h.context).requestSwipe(
    1,
    2,
    3,
    4,
    300,
    50,
    undefined,
    undefined,
    onDispatch,
    signal,
  );
}

describe("iOS single-finger swipe dispatch contract", () => {
  test.each([
    ["timeout", "Swipe timed out after 50ms"],
    ["socket close", "WebSocket connection closed"],
    ["abort", "cancelled"],
  ] as const)("%s after dispatch is unconfirmed with one send", async (failure, message) => {
    const h = createIosDelegateHarness();
    const controller = new AbortController();
    let dispatchCount = 0;
    const pending = requestSwipe(h, controller.signal, () => dispatchCount++);
    await Promise.resolve();
    expect(h.sentMessages).toHaveLength(1);
    if (failure === "socket close") {
      h.requestManager.cancelAll(new Error("WebSocket connection closed"));
    } else if (failure === "abort") {
      controller.abort(new Error("cancelled"));
    }
    h.advanceTime(50);
    const result = await pending;
    expect(result).toMatchObject({
      success: false,
      dispatched: true,
      acknowledged: false,
      retryable: false,
    });
    expect(result.error).toContain(message);
    expect(dispatchCount).toBe(1);
    expect(h.sentMessages).toHaveLength(1);
    expect(h.requestManager.getPendingCount()).toBe(0);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test.each(["success", "failure"] as const)("a runner %s reply is acknowledged", async (reply) => {
    const h = createIosDelegateHarness();
    const pending = requestSwipe(h, new AbortController().signal, () => {});
    await Promise.resolve();
    h.resolveLast({
      success: reply === "success",
      totalTimeMs: 7,
      gestureTimeMs: 5,
      error: reply === "failure" ? "runner refused" : undefined,
    });
    const result = await pending;
    expect(result).toMatchObject({
      success: reply === "success",
      totalTimeMs: 7,
      dispatched: true,
      acknowledged: true,
    });
    expect(result.error).toBe(reply === "failure" ? "runner refused" : undefined);
    expect(result.retryable).toBeUndefined();
  });

  test("sends the unchanged request_swipe wire message", async () => {
    const h = createIosDelegateHarness();
    const pending = requestSwipe(h, new AbortController().signal, () => {});
    await Promise.resolve();
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]).toMatchObject({
      type: "request_swipe",
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      duration: 300,
      timeoutMs: 50,
    });
    h.resolveLast({ success: true, totalTimeMs: 1 });
    await pending;
  });

  test("a caller abort before connecting sends nothing and rejects with the reason", async () => {
    const h = createIosDelegateHarness();
    const controller = new AbortController();
    const cancellation = new ActionableError("cancelled while connecting");
    h.context.ensureConnected = async () => {
      controller.abort(cancellation);
      return true;
    };
    let dispatchCount = 0;
    const outcome = requestSwipe(h, controller.signal, () => dispatchCount++).then(
      (value) => value,
      (reason: unknown) => reason,
    );
    await Promise.resolve();
    h.advanceTime(50);
    expect(await outcome).toBe(cancellation);
    expect(dispatchCount).toBe(0);
    expect(h.sentMessages).toHaveLength(0);
    expect(h.requestManager.getPendingCount()).toBe(0);
  });

  test("a runner_busy refusal is rethrown unchanged", async () => {
    const h = createIosDelegateHarness();
    const pending = requestSwipe(h, new AbortController().signal, () => {});
    await Promise.resolve();
    const error = new ActionableError("runner_busy: retry shortly");
    h.requestManager.reject(h.lastRequestId()!, error);
    await expect(pending).rejects.toBe(error);
  });

  test("not connected is a plain failure that permits a retry", async () => {
    const h = createIosDelegateHarness({ connected: false });
    const result = await requestSwipe(h, new AbortController().signal, () => {});
    expect(result).toMatchObject({
      success: false,
      error: "Not connected",
      dispatched: false,
      acknowledged: false,
    });
    expect(result.retryable).toBeUndefined();
    expect(h.sentMessages).toHaveLength(0);
  });
});

describe("IOSCtrlProxyClient.requestSwipe option forwarding", () => {
  test("forwards the signal and dispatch callback into the delegate's own slots", async () => {
    const h = createIosDelegateHarness();
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    const result = { success: false, totalTimeMs: 50, dispatched: true, acknowledged: false };
    const swipe = spyOn(CtrlProxyGestures.prototype, "requestSwipe").mockResolvedValue(result);
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "physical-iphone", platform: "ios", name: "iPhone" },
      8765,
      (url) => new FakeWebSocket(url, "none", 0, h.timer),
      h.timer,
    );
    try {
      expect(
        await client.requestSwipe(1, 2, 3, 4, 300, 50, undefined, "frame", signal, onDispatch),
      ).toBe(result);
      expect(swipe).toHaveBeenCalledWith(
        1,
        2,
        3,
        4,
        300,
        50,
        undefined,
        "frame",
        onDispatch,
        signal,
      );
    } finally {
      swipe.mockRestore();
      await client.close();
    }
  });
});
