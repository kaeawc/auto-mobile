import { describe, expect, test, spyOn } from "bun:test";
import type WebSocket from "ws";
import {
  sendCommand,
  type SendCommandOptions,
} from "../../../src/features/observe/DeviceServiceUtils";
import type { BaseResult, DelegateContext } from "../../../src/features/observe/shared/types";
import { RequestManager } from "../../../src/utils/RequestManager";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../fakes/FakeWebSocket";

function harness(overrides: Partial<DelegateContext> = {}) {
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  socket.readyState = WebSocketState.OPEN;
  const order: string[] = [];
  const requestManager = new RequestManager(timer, { next: () => "id" });
  const sent: string[] = [];
  socket.send = (data) => {
    order.push("send");
    sent.push(String(data));
  };
  const context: DelegateContext = {
    timer,
    requestManager,
    getWebSocket: () => socket as unknown as WebSocket,
    ensureConnected: async () => {
      order.push("connect");
      return true;
    },
    cancelScreenshotBackoff: () => {
      order.push("cancel");
    },
    ...overrides,
  };
  const options: SendCommandOptions<BaseResult> = {
    idPrefix: "tap",
    responseType: "tap_result",
    messageType: "request_tap",
    timeoutMs: 50,
  };
  return { context, options, timer, socket, sent, order };
}

async function flushDispatch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("sendCommand lifecycle", () => {
  test("preserves cancellation, connection, serialization, fence, send and dispatch order", async () => {
    const h = harness();
    const controller = new AbortController();
    h.context.serializeRequest = (message) => {
      h.order.push("serialize");
      return JSON.stringify(message);
    };
    const remove = spyOn(controller.signal, "removeEventListener");
    const pending = sendCommand(h.context, {
      ...h.options,
      params: { x: 2 },
      abortSignal: controller.signal,
      perf: new NoOpPerformanceTracker(),
      beforeSend: () => {
        h.order.push("fence");
      },
      onDispatch: (id) => {
        h.order.push(`dispatch:${id}`);
      },
    });
    await flushDispatch();
    expect(h.order).toEqual(["cancel", "connect", "serialize", "fence", "send", "dispatch:tap_id"]);
    expect(JSON.parse(h.sent[0])).toEqual({ type: "request_tap", requestId: "tap_id", x: 2 });
    h.context.requestManager.resolve("tap_id", { success: true, totalTimeMs: 3 });
    expect(await pending).toEqual({ success: true, totalTimeMs: 3 });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(h.context.requestManager.getPendingCount()).toBe(0);
    remove.mockRestore();
  });

  for (const custom of [false, true]) {
    test(`returns the ${custom ? "custom" : "default"} disconnected result without registering`, async () => {
      const h = harness({ ensureConnected: async () => false });
      const result = await sendCommand(h.context, {
        ...h.options,
        notConnectedMessage: "offline",
        ...(custom
          ? { notConnectedError: () => ({ success: false, totalTimeMs: 9, error: "custom" }) }
          : {}),
      });
      expect(result).toEqual({
        success: false,
        totalTimeMs: custom ? 9 : 0,
        error: custom ? "custom" : "offline",
      });
      expect(h.context.requestManager.getPendingCount()).toBe(0);
      expect(h.sent).toEqual([]);
    });

    test(`returns the ${custom ? "custom" : "default"} unsupported-command result`, async () => {
      const h = harness({
        isCommandSupported: () => false,
        unsupportedCommandError: () => "unsupported",
      });
      const result = await sendCommand(h.context, {
        ...h.options,
        ...(custom
          ? {
              unsupportedCommandError: (type: string, error: string) => ({
                success: false,
                totalTimeMs: 9,
                error: `${type}:${error}`,
              }),
            }
          : {}),
      });
      expect(result.error).toBe(custom ? "request_tap:unsupported" : "unsupported");
      expect(h.context.requestManager.getPendingCount()).toBe(0);
      expect(h.sent).toEqual([]);
    });

    test(`settles the ${custom ? "custom" : "default"} timeout result`, async () => {
      const h = harness();
      const pending = sendCommand(h.context, {
        ...h.options,
        errorLabel: "Tap",
        ...(custom
          ? {
              timeoutError: (timeout: number) => ({
                success: false,
                totalTimeMs: timeout,
                error: "custom timeout",
              }),
            }
          : {}),
      });
      await flushDispatch();
      h.timer.advanceTime(50);
      expect(await pending).toEqual({
        success: false,
        totalTimeMs: 50,
        error: custom ? "custom timeout" : "Tap timed out after 50ms",
      });
      expect(h.context.requestManager.getPendingCount()).toBe(0);
    });

    test(`uses the ${custom ? "custom" : "default"} response-error factory`, async () => {
      const h = harness();
      const pending = sendCommand(h.context, {
        ...h.options,
        ...(custom
          ? {
              unsupportedCommandError: (type: string, error: string) => ({
                success: false,
                totalTimeMs: 9,
                error: `${type}:${error}`,
              }),
            }
          : {}),
      });
      await flushDispatch();
      h.context.requestManager.resolveError("tap_id", "remote failure", 7);
      expect(await pending).toEqual({
        success: false,
        totalTimeMs: custom ? 9 : 7,
        error: custom ? "request_tap:remote failure" : "remote failure",
      });
    });
  }

  test("uses an existing connection without reconnect or backoff cancellation", async () => {
    const h = harness();
    const pending = sendCommand(h.context, {
      ...h.options,
      requireExistingConnection: true,
      cancelScreenshotBackoff: false,
    });
    h.context.requestManager.resolve("tap_id", { success: true, totalTimeMs: 0 });
    expect(await pending).toEqual({ success: true, totalTimeMs: 0 });
    expect(h.order).toEqual(["send"]);
  });

  test("returns the generic unsupported message without a context builder", async () => {
    const h = harness({ isCommandSupported: () => false });
    expect((await sendCommand(h.context, h.options)).error).toBe(
      "request_tap is not supported by the connected device service",
    );
  });

  test("rechecks the required capability immediately before the fence and send", async () => {
    const h = harness({ isCommandSupported: (type) => type !== "atomic" });
    const pending = sendCommand(h.context, {
      ...h.options,
      requiredCapability: "atomic",
      beforeSend: () => {
        h.order.push("fence");
      },
    });
    expect(await pending).toEqual({
      success: false,
      totalTimeMs: 0,
      error: "atomic is not confirmed by the connected device service",
      unsupportedCapability: "atomic",
    });
    expect(h.sent).toEqual([]);
    expect(h.order).toEqual(["cancel", "connect"]);
  });

  for (const custom of [false, true]) {
    test(`handles a pre-dispatch abort with ${custom ? "custom" : "default"} result`, async () => {
      const h = harness();
      const controller = new AbortController();
      controller.abort();
      expect(
        await sendCommand(h.context, {
          ...h.options,
          abortSignal: controller.signal,
          ...(custom
            ? {
                notConnectedError: () => ({
                  success: false,
                  totalTimeMs: 9,
                  error: "custom abort",
                }),
              }
            : {}),
        }),
      ).toEqual({
        success: false,
        totalTimeMs: custom ? 9 : 0,
        error: custom ? "custom abort" : "Request aborted before dispatch",
      });
      expect(h.sent).toEqual([]);
      expect(h.context.requestManager.getPendingCount()).toBe(0);
    });
  }

  for (const reason of [new Error("deadline"), "deadline"]) {
    test(`rejects an in-flight abort with ${typeof reason} reason and removes its listener`, async () => {
      const h = harness();
      const controller = new AbortController();
      const remove = spyOn(controller.signal, "removeEventListener");
      const pending = sendCommand(h.context, { ...h.options, abortSignal: controller.signal });
      await flushDispatch();
      controller.abort(reason);
      await expect(pending).rejects.toThrow(
        reason instanceof Error ? "deadline" : "Operation cancelled",
      );
      expect(h.context.requestManager.getPendingCount()).toBe(0);
      expect(remove).toHaveBeenCalledTimes(1);
      remove.mockRestore();
    });
  }

  test("rejects a connection lost before send and cleans up the registered request", async () => {
    let reads = 0;
    const h = harness({
      getWebSocket: () => {
        reads++;
        return null;
      },
    });
    await expect(sendCommand(h.context, h.options)).rejects.toThrow("WebSocket not connected");
    expect(reads).toBe(1);
    expect(h.context.requestManager.getPendingCount()).toBe(0);
  });

  test("rejects an abort during registration before attaching its listener", async () => {
    const h = harness();
    const controller = new AbortController();
    const register = h.context.requestManager.register.bind(h.context.requestManager);
    spyOn(h.context.requestManager, "register").mockImplementation(
      (...args: Parameters<RequestManager["register"]>) => {
        const pending = register(...args);
        controller.abort(new Error("registration abort"));
        return pending;
      },
    );
    const remove = spyOn(controller.signal, "removeEventListener");
    await expect(
      sendCommand(h.context, { ...h.options, abortSignal: controller.signal }),
    ).rejects.toThrow("registration abort");
    expect(h.sent).toEqual([]);
    expect(h.context.requestManager.getPendingCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  test("rejects a fence-triggered abort before sending", async () => {
    const h = harness();
    const controller = new AbortController();
    await expect(
      sendCommand(h.context, {
        ...h.options,
        abortSignal: controller.signal,
        beforeSend: () => {
          controller.abort(new Error("fence abort"));
        },
      }),
    ).rejects.toThrow("fence abort");
    expect(h.sent).toEqual([]);
    expect(h.context.requestManager.getPendingCount()).toBe(0);
  });

  test("normalizes a thrown send value without dispatching", async () => {
    const h = harness();
    h.socket.send = () => {
      throw "send failed";
    };
    await expect(
      sendCommand(h.context, {
        ...h.options,
        onDispatch: () => {
          h.order.push("dispatch");
        },
      }),
    ).rejects.toThrow("send failed");
    expect(h.order).toEqual(["cancel", "connect"]);
    expect(h.context.requestManager.getPendingCount()).toBe(0);
  });
});
