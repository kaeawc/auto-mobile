import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { getEventListeners } from "node:events";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";
import { describe, expect, spyOn, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import { CtrlProxyNavigation } from "../../../../src/features/observe/ios/CtrlProxyNavigation";
import { CtrlProxyKeyboard } from "../../../../src/features/observe/ios/CtrlProxyKeyboard";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import {
  createIosDelegateHarness,
  type IosDelegateHarness,
} from "../../../helpers/iosDelegateHarness";
import type { BaseResult } from "../../../../src/features/observe/shared/types";
import type { IOSDispatchResult } from "../../../../src/features/observe/ios/CtrlProxyDispatch";

interface PressCase {
  name: string;
  home?: boolean;
  request(
    h: IosDelegateHarness,
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<IOSDispatchResult<BaseResult>>;
}

const cases: PressCase[] = [
  {
    name: "coordinate tap",
    request: (h, s, d) =>
      new CtrlProxyGestures(h.context).requestTapCoordinates(
        1,
        2,
        50,
        50,
        undefined,
        undefined,
        s,
        d,
      ),
  },
  {
    name: "home",
    home: true,
    request: (h, s, d) =>
      new CtrlProxyNavigation(h.context).requestPressHome(50, undefined, undefined, s, d),
  },
  {
    name: "back",
    request: (h, s, d) =>
      new CtrlProxyNavigation(h.context).requestPressBack(50, undefined, undefined, s, d),
  },
  {
    name: "recent",
    request: (h, s, d) =>
      new CtrlProxyNavigation(h.context).requestRecentApps(50, undefined, undefined, s, d),
  },
  ...["volume_up", "volume_down", "power", "home"].map((button): PressCase => ({
    name: `button ${button}`,
    home: button === "home",
    request: (h, s, d) =>
      new CtrlProxyNavigation(h.context).requestPressButton(button, 50, undefined, undefined, s, d),
  })),
  {
    name: "input/key",
    request: (h, s, d) =>
      new CtrlProxyKeyboard(h.context).requestPressKey("enter", [], 50, undefined, s, d),
  },
  {
    name: "multi-finger swipe",
    request: (h, s, d) =>
      new CtrlProxyGestures(h.context).requestMultiFingerSwipe(
        1,
        2,
        3,
        4,
        2,
        300,
        50,
        undefined,
        10,
        s,
        d,
      ),
  },
];

for (const action of cases) {
  describe(`${action.name} dispatch contract`, () => {
    test.each(["never resolves", "resolves after abort"] as const)(
      "abort during connect that %s rejects without dispatch or resources",
      async (connection) => {
        const h = createIosDelegateHarness();
        const connecting = Promise.withResolvers<boolean>();
        h.context.ensureConnected = () => connecting.promise;
        const controller = new AbortController();
        const cancellation = new ActionableError("cancelled while connecting");
        let dispatchCount = 0;
        let settled = false;
        let rejection: unknown;
        const outcome = action
          .request(h, controller.signal, () => dispatchCount++)
          .then(
            () => {
              settled = true;
            },
            (error: unknown) => {
              settled = true;
              rejection = error;
            },
          );
        controller.abort(cancellation);
        // Drain promise continuations without advancing time or completing connection.
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }
        const settledBeforeConnection = settled;
        const listenersAfterAbort = getEventListeners(controller.signal, "abort").length;
        if (connection === "resolves after abort") {
          connecting.resolve(true);
          for (let i = 0; i < 20; i++) {
            await Promise.resolve();
          }
        }
        expect(settledBeforeConnection).toBe(true);
        await outcome;
        expect(rejection).toBe(cancellation);
        expect(dispatchCount).toBe(0);
        expect(h.sentMessages).toHaveLength(0);
        expect(h.requestManager.getPendingCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        expect(h.timer.getPendingIntervalCount()).toBe(0);
        expect(listenersAfterAbort).toBe(0);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      },
    );

    test.each(["timeout", "socket close", "abort", "ActionableError abort"] as const)(
      "%s after dispatch is unconfirmed with one send",
      async (failure) => {
        const h = createIosDelegateHarness();
        const controller = new AbortController();
        let dispatchCount = 0;
        const pending = action.request(h, controller.signal, () => dispatchCount++);
        await Promise.resolve();
        expect(h.sentMessages).toHaveLength(1);
        if (failure === "socket close") {
          h.requestManager.cancelAll(new Error("WebSocket connection closed"));
        } else if (failure.includes("abort")) {
          controller.abort(
            failure === "abort" ? new Error("cancelled") : new ActionableError("cancelled"),
          );
        }
        // Also bounds the pre-fix abort repro: ignored signals time out deterministically.
        h.advanceTime(50);
        expect(await pending).toMatchObject({
          success: false,
          dispatched: true,
          acknowledged: false,
        });
        expect((await pending).retryable).toBe(action.home ? undefined : false);
        expect(dispatchCount).toBe(1);
        expect(h.sentMessages).toHaveLength(1);
        expect(h.requestManager.getPendingCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      },
    );

    test.each(["success", "failure"] as const)("a %s reply is acknowledged", async (reply) => {
      const h = createIosDelegateHarness();
      const pending = action.request(h, new AbortController().signal, () => {});
      await Promise.resolve();
      const result = {
        success: reply === "success",
        totalTimeMs: 7,
        error: reply === "failure" ? "runner refused" : undefined,
      };
      h.resolveLast(result);
      expect(await pending).toMatchObject({ ...result, dispatched: true, acknowledged: true });
      expect((await pending).retryable).toBeUndefined();
      expect(h.sentMessages).toHaveLength(1);
    });

    test("runner_busy is rethrown unchanged", async () => {
      const h = createIosDelegateHarness();
      const pending = action.request(h, new AbortController().signal, () => {});
      await Promise.resolve();
      const error = new ActionableError("runner_busy: retry shortly");
      h.requestManager.reject(h.lastRequestId()!, error);
      await expect(pending).rejects.toBe(error);
      expect(h.sentMessages).toHaveLength(1);
    });

    test.each(["connected", "not connected", "ensureConnected throws"] as const)(
      "abort before dispatch on %s sends nothing",
      async (connection) => {
        const h = createIosDelegateHarness();
        const controller = new AbortController();
        const error = new ActionableError("cancelled while connecting");
        h.context.ensureConnected = async () => {
          controller.abort(error);
          if (connection === "ensureConnected throws") {
            throw error;
          }
          return connection === "connected";
        };
        const pending = action.request(h, controller.signal, () => {});
        const outcome = pending.then(
          (value) => value,
          (reason) => reason,
        );
        await Promise.resolve();
        h.advanceTime(50);
        expect(await outcome).toBe(error);
        expect(h.sentMessages).toHaveLength(0);
        expect(h.requestManager.getPendingCount()).toBe(0);
      },
    );

    test.each(["not connected", "ensureConnected throws", "send throws", "unsupported"] as const)(
      "%s before dispatch permits retry",
      async (failure) => {
        const h = createIosDelegateHarness({ connected: failure !== "not connected" });
        if (failure === "ensureConnected throws") {
          h.context.ensureConnected = async () => {
            throw new Error("connect failed");
          };
        }
        if (failure === "send throws") {
          h.context.getWebSocket()!.send = () => {
            throw new ActionableError("send failed");
          };
        }
        if (failure === "unsupported") {
          h.setSupportedCommands([]);
        }
        const result = await action.request(h, new AbortController().signal, () => {});
        expect(result).toMatchObject({ success: false, dispatched: false, acknowledged: false });
        expect(result.retryable).toBeUndefined();
        expect(h.sentMessages).toHaveLength(0);
      },
    );
  });
}

describe("IOSCtrlProxyClient press option forwarding", () => {
  test("delegates retain signal, dispatch callback, and result metadata", async () => {
    const h = createIosDelegateHarness();
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    const result = {
      success: false,
      totalTimeMs: 50,
      dispatched: true,
      acknowledged: false,
      retryable: false,
    };
    const home = spyOn(CtrlProxyNavigation.prototype, "requestPressHome").mockResolvedValue(result);
    const back = spyOn(CtrlProxyNavigation.prototype, "requestPressBack").mockResolvedValue(result);
    const recent = spyOn(CtrlProxyNavigation.prototype, "requestRecentApps").mockResolvedValue(
      result,
    );
    const button = spyOn(CtrlProxyNavigation.prototype, "requestPressButton").mockResolvedValue(
      result,
    );
    const key = spyOn(CtrlProxyKeyboard.prototype, "requestPressKey").mockResolvedValue(result);
    const swipe = spyOn(CtrlProxyGestures.prototype, "requestMultiFingerSwipe").mockResolvedValue(
      result,
    );
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "physical-iphone", platform: "ios", name: "iPhone" },
      8765,
      (url) => new FakeWebSocket(url, "none", 0, h.timer),
      h.timer,
    );
    try {
      expect(await client.requestPressHome(50, undefined, "frame", signal, onDispatch)).toBe(
        result,
      );
      expect(home).toHaveBeenCalledWith(50, undefined, "frame", signal, onDispatch);
      expect(await client.requestPressBack(50, undefined, "frame", signal, onDispatch)).toBe(
        result,
      );
      expect(back).toHaveBeenCalledWith(50, undefined, "frame", signal, onDispatch);
      expect(await client.requestRecentApps(50, undefined, "frame", signal, onDispatch)).toBe(
        result,
      );
      expect(recent).toHaveBeenCalledWith(50, undefined, "frame", signal, onDispatch);
      expect(
        await client.requestPressButton("power", 50, undefined, "frame", signal, onDispatch),
      ).toBe(result);
      expect(button).toHaveBeenCalledWith("power", 50, undefined, "frame", signal, onDispatch);
      expect(await client.requestPressKey("enter", [], 50, undefined, signal, onDispatch)).toBe(
        result,
      );
      expect(key).toHaveBeenCalledWith("enter", [], 50, undefined, signal, onDispatch);
      expect(
        await client.requestMultiFingerSwipe(
          1,
          2,
          3,
          4,
          2,
          300,
          50,
          undefined,
          10,
          signal,
          onDispatch,
        ),
      ).toBe(result);
      expect(swipe).toHaveBeenCalledWith(1, 2, 3, 4, 2, 300, 50, undefined, 10, signal, onDispatch);
    } finally {
      home.mockRestore();
      back.mockRestore();
      recent.mockRestore();
      button.mockRestore();
      key.mockRestore();
      swipe.mockRestore();
      await client.close();
    }
  });
});
