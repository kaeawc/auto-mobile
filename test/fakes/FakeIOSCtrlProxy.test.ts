import { describe, expect, test } from "bun:test";
import { FakeIOSCtrlProxy } from "./FakeIOSCtrlProxy";
import { FakeTimer } from "./FakeTimer";

describe("FakeIOSCtrlProxy operation delays", () => {
  test("connectWithoutSetup derives its default result from the connection state", async () => {
    const proxy = new FakeIOSCtrlProxy();

    proxy.setConnected(false);
    expect(await proxy.connectWithoutSetup()).toBe(false);

    proxy.setConnected(true);
    expect(await proxy.connectWithoutSetup()).toBe(true);
  });

  test("connectWithoutSetup records calls, returns configured results, and rejects cancellations", async () => {
    const proxy = new FakeIOSCtrlProxy();
    proxy.setConnectWithoutSetupResult(false);
    expect(await proxy.connectWithoutSetup()).toBe(false);

    const failure = new Error("connection failed");
    proxy.setFailureMode("connectWithoutSetup", failure);
    await expect(proxy.connectWithoutSetup()).rejects.toBe(failure);

    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort(cancellation);
    await expect(proxy.connectWithoutSetup(controller.signal)).rejects.toBe(cancellation);
    expect(proxy.getConnectWithoutSetupHistory()).toEqual([
      { signalProvided: false },
      { signalProvided: false },
      { signalProvided: true },
    ]);
  });

  test("pressKey waits for the injected virtual clock before recording success", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    proxy.setOperationDelay("pressKey", 500);
    let settled = false;
    const result = proxy.requestPressKey("tab", []).then((value) => {
      settled = true;
      return value;
    });

    expect(timer.getSleepHistory()).toEqual([500]);
    timer.advanceTime(499);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(proxy.getPressKeyHistory()).toEqual([]);
    timer.advanceTime(1);
    expect((await result).success).toBe(true);
    expect(proxy.getPressKeyHistory()).toEqual([{ key: "tab", modifiers: [] }]);
  });

  test("other operations use the same injected clock", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    proxy.setOperationDelay("pressHome", 250);
    const result = proxy.requestPressHome();
    expect(timer.getSleepHistory()).toEqual([250]);
    timer.advanceTime(250);
    expect((await result).success).toBe(true);
    expect(proxy.getPressHomeRequestCount()).toBe(1);
  });

  test("zero delays and the no-argument constructor remain compatible", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    expect((await proxy.requestPressKey("tab", [])).success).toBe(true);
    expect(timer.getSleepHistory()).toEqual([]);
    expect((await new FakeIOSCtrlProxy().requestPressHome()).success).toBe(true);
  });

  test("configured failures reject after virtual delay without recording success", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    const failure = new Error("configured failure");
    proxy.setOperationDelay("pressKey", 500);
    proxy.setFailureMode("pressKey", failure);
    const result = proxy.requestPressKey("tab", []).catch((error: unknown) => error);
    expect(timer.getSleepHistory()).toEqual([500]);
    timer.advanceTime(500);
    expect(await result).toBe(failure);
    expect(proxy.getPressKeyHistory()).toEqual([]);
    proxy.setFailureMode("pressKey", null);
    proxy.setOperationDelay("pressKey", 0);
    expect((await proxy.requestPressKey("tab", [])).success).toBe(true);
  });
});

describe("FakeIOSCtrlProxy dispatch contract for tap, swipe and pinch", () => {
  type GestureResult = Parameters<FakeIOSCtrlProxy["setTapResult"]>[0];
  const gestures: Array<{
    name: string;
    setResult: (proxy: FakeIOSCtrlProxy, result: GestureResult) => void;
    send: (
      proxy: FakeIOSCtrlProxy,
      onDispatch: () => void,
    ) => ReturnType<FakeIOSCtrlProxy["requestTapCoordinates"]>;
  }> = [
    {
      name: "tap",
      setResult: (proxy, result) => proxy.setTapResult(result),
      send: (proxy, onDispatch) =>
        proxy.requestTapCoordinates(1, 2, 0, 5000, undefined, undefined, undefined, onDispatch),
    },
    {
      name: "swipe",
      setResult: (proxy, result) => proxy.setSwipeResult(result),
      send: (proxy, onDispatch) =>
        proxy.requestSwipe(1, 2, 3, 4, 300, 5000, undefined, undefined, undefined, onDispatch),
    },
    {
      name: "pinch",
      setResult: (proxy, result) => proxy.setPinchResult(result),
      send: (proxy, onDispatch) =>
        proxy.requestPinch(1, 2, 3, 4, 0, 300, 5000, undefined, undefined, onDispatch),
    },
  ];

  for (const gesture of gestures) {
    describe(gesture.name, () => {
      test("defaults to dispatched and acknowledged", async () => {
        const proxy = new FakeIOSCtrlProxy();
        let dispatches = 0;

        const result = await gesture.send(proxy, () => dispatches++);

        expect(result).toMatchObject({ success: true, dispatched: true, acknowledged: true });
        expect(dispatches).toBe(1);
      });

      test("a failure result is a runner refusal: dispatched and acknowledged", async () => {
        const proxy = new FakeIOSCtrlProxy();
        gesture.setResult(proxy, { success: false, error: "refused", totalTimeMs: 1 });
        let dispatches = 0;

        const result = await gesture.send(proxy, () => dispatches++);

        expect(result).toMatchObject({
          success: false,
          error: "refused",
          dispatched: true,
          acknowledged: true,
        });
        expect(dispatches).toBe(1);
      });

      test("dispatched without a reply is unacknowledged", async () => {
        const proxy = new FakeIOSCtrlProxy();
        gesture.setResult(proxy, {
          success: false,
          error: "timed out",
          totalTimeMs: 5000,
          dispatched: true,
          acknowledged: false,
        });
        let dispatches = 0;

        const result = await gesture.send(proxy, () => dispatches++);

        expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: false });
        expect(dispatches).toBe(1);
      });

      test("never dispatched fires no dispatch marker and is unacknowledged", async () => {
        const proxy = new FakeIOSCtrlProxy();
        gesture.setResult(proxy, {
          success: false,
          error: "not connected",
          totalTimeMs: 0,
          dispatched: false,
        });
        let dispatches = 0;

        const result = await gesture.send(proxy, () => dispatches++);

        expect(result).toMatchObject({ success: false, dispatched: false, acknowledged: false });
        expect(dispatches).toBe(0);
      });
    });
  }

  describe("a request aborted before dispatch throws the abort reason, as sendIOSPressCommand does", () => {
    const reason = new Error("deadline expired");
    const aborted = () => {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    };

    test("tap", async () => {
      const proxy = new FakeIOSCtrlProxy();
      let dispatches = 0;

      await expect(
        proxy.requestTapCoordinates(1, 2, 0, 5000, undefined, undefined, aborted(), () => {
          dispatches++;
        }),
      ).rejects.toBe(reason);

      expect(dispatches).toBe(0);
      expect(proxy.getTapHistory()).toEqual([]);
    });

    test("swipe", async () => {
      const proxy = new FakeIOSCtrlProxy();
      let dispatches = 0;

      await expect(
        proxy.requestSwipe(1, 2, 3, 4, 300, 5000, undefined, undefined, aborted(), () => {
          dispatches++;
        }),
      ).rejects.toBe(reason);

      expect(dispatches).toBe(0);
      expect(proxy.getSwipeHistory()).toEqual([]);
    });

    test("pinch", async () => {
      const proxy = new FakeIOSCtrlProxy();
      let dispatches = 0;

      await expect(
        proxy.requestPinch(1, 2, 10, 20, 0, 300, 5000, undefined, aborted(), () => {
          dispatches++;
        }),
      ).rejects.toBe(reason);

      expect(dispatches).toBe(0);
      expect(proxy.getPinchHistory()).toEqual([]);
    });

    test("a never-sent result under an aborted signal also throws the reason", async () => {
      const proxy = new FakeIOSCtrlProxy();
      const controller = new AbortController();
      proxy.setSwipeResult({ success: false, error: "not connected", dispatched: false });
      const pending = proxy.requestSwipe(
        1,
        2,
        3,
        4,
        300,
        5000,
        undefined,
        undefined,
        controller.signal,
      );
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    });

    test("a live signal leaves the dispatch contract unchanged", async () => {
      const proxy = new FakeIOSCtrlProxy();
      const signal = new AbortController().signal;

      const result = await proxy.requestSwipe(1, 2, 3, 4, 300, 5000, undefined, undefined, signal);

      expect(result).toMatchObject({ success: true, dispatched: true, acknowledged: true });
    });
  });
});
