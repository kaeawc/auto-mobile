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
        proxy.requestTapCoordinates({ x: 1, y: 2, duration: 0, timeoutMs: 5000, onDispatch }),
    },
    {
      name: "swipe",
      setResult: (proxy, result) => proxy.setSwipeResult(result),
      send: (proxy, onDispatch) =>
        proxy.requestSwipe({
          x1: 1,
          y1: 2,
          x2: 3,
          y2: 4,
          duration: 300,
          timeoutMs: 5000,
          onDispatch,
        }),
    },
    {
      name: "pinch",
      setResult: (proxy, result) => proxy.setPinchResult(result),
      send: (proxy, onDispatch) =>
        proxy.requestPinch(
          {
            centerX: 1,
            centerY: 2,
            distanceStart: 3,
            distanceEnd: 4,
            rotationDegrees: 0,
            duration: 300,
            timeoutMs: 5000,
            perf: undefined,
            signal: undefined,
          },
          onDispatch,
        ),
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
        proxy.requestTapCoordinates({
          x: 1,
          y: 2,
          duration: 0,
          timeoutMs: 5000,
          signal: aborted(),
          onDispatch: () => {
            dispatches++;
          },
        }),
      ).rejects.toBe(reason);

      expect(dispatches).toBe(0);
      expect(proxy.getTapHistory()).toEqual([]);
    });

    test("swipe", async () => {
      const proxy = new FakeIOSCtrlProxy();
      let dispatches = 0;

      await expect(
        proxy.requestSwipe({
          x1: 1,
          y1: 2,
          x2: 3,
          y2: 4,
          duration: 300,
          timeoutMs: 5000,
          signal: aborted(),
          onDispatch: () => {
            dispatches++;
          },
        }),
      ).rejects.toBe(reason);

      expect(dispatches).toBe(0);
      expect(proxy.getSwipeHistory()).toEqual([]);
    });

    test("pinch", async () => {
      const proxy = new FakeIOSCtrlProxy();
      let dispatches = 0;

      await expect(
        proxy.requestPinch(
          {
            centerX: 1,
            centerY: 2,
            distanceStart: 10,
            distanceEnd: 20,
            rotationDegrees: 0,
            duration: 300,
            timeoutMs: 5000,
            perf: undefined,
            signal: aborted(),
          },
          () => {
            dispatches++;
          },
        ),
      ).rejects.toBe(reason);

      expect(dispatches).toBe(0);
      expect(proxy.getPinchHistory()).toEqual([]);
    });

    test("a never-sent result under an aborted signal also throws the reason", async () => {
      const proxy = new FakeIOSCtrlProxy();
      const controller = new AbortController();
      proxy.setSwipeResult({
        success: false,
        error: "not connected",
        dispatched: false,
        totalTimeMs: 0,
      });
      const pending = proxy.requestSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        duration: 300,
        timeoutMs: 5000,
        signal: controller.signal,
      });
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    });

    test("a live signal leaves the dispatch contract unchanged", async () => {
      const proxy = new FakeIOSCtrlProxy();
      const signal = new AbortController().signal;

      const result = await proxy.requestSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        duration: 300,
        timeoutMs: 5000,
        signal,
      });

      expect(result).toMatchObject({ success: true, dispatched: true, acknowledged: true });
    });
  });
});

describe("FakeIOSCtrlProxy multi-finger swipe dispatch", () => {
  const swipe = (
    proxy: FakeIOSCtrlProxy,
    signal?: AbortSignal,
    onDispatch?: () => void,
    beforeSend?: () => void,
  ) =>
    proxy.requestMultiFingerSwipe({
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      fingerCount: 3,
      duration: 300,
      fingerSpacing: 10,
      signal,
      onDispatch,
      beforeSend,
    });

  test("runs the display fence before recording the gesture and reports onDispatch", async () => {
    const proxy = new FakeIOSCtrlProxy();
    const order: string[] = [];
    const result = await swipe(
      proxy,
      undefined,
      () => order.push("dispatch"),
      () => order.push(`fence:${proxy.getMultiFingerSwipeHistory().length}`),
    );
    expect(order).toEqual(["fence:0", "dispatch"]);
    expect(result).toMatchObject({ success: true, dispatched: true, acknowledged: true });
  });

  test("a throwing fence stops the gesture before it is recorded or dispatched", async () => {
    const proxy = new FakeIOSCtrlProxy();
    let dispatched = false;
    const fence = new Error("display changed");
    await expect(
      swipe(
        proxy,
        undefined,
        () => {
          dispatched = true;
        },
        () => {
          throw fence;
        },
      ),
    ).rejects.toBe(fence);
    expect(dispatched).toBe(false);
    expect(proxy.getMultiFingerSwipeHistory()).toHaveLength(0);
  });

  test("an already-aborted signal throws the abort reason without recording", async () => {
    const proxy = new FakeIOSCtrlProxy();
    const controller = new AbortController();
    const reason = new Error("deadline");
    controller.abort(reason);
    await expect(swipe(proxy, controller.signal)).rejects.toBe(reason);
    expect(proxy.getMultiFingerSwipeHistory()).toHaveLength(0);
  });
});
