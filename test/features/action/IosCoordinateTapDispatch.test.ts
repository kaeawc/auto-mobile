import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  dispatchIosCoordinateTap,
  dispatchIosDoubleTap,
  type IosCoordinateTapClient,
} from "../../../src/features/action/coordinateTapDispatch";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { CtrlProxyGestures } from "../../../src/features/observe/ios/CtrlProxyGestures";
import { CtrlProxyVoiceOver } from "../../../src/features/observe/ios/CtrlProxyVoiceOver";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import { FakeWindow } from "../../fakes/FakeWindow";
import { createIosDelegateHarness } from "../../helpers/iosDelegateHarness";
import { observation, setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";

type TapReply = Awaited<ReturnType<IosCoordinateTapClient["requestTapCoordinates"]>>;

const INDETERMINATE = "Tap outcome is indeterminate";

// CommandError.gestureBoundExceeded / queryBoundExceeded text as the runner sends it (pinned by
// runnerErrorCodes.contract.test.ts).
const STILL_EXECUTING =
  "Command request_tap exceeded execution bound 4497ms in phase xcuitestGesture after 4499ms; XCUITest call is still executing and the runner stays busy until it returns";
const QUERY_BOUND =
  "Command request_hierarchy exceeded execution bound 10000ms after 10000ms waiting on a live XCUITest query; XCUITest call is still executing and the runner stays busy until it returns";
const ACKED = { success: false, dispatched: true, acknowledged: true } as const;

/** A client whose request marks dispatch (when asked to) and then settles as scripted. */
function scriptedClient(options: {
  dispatch: boolean;
  reply?: TapReply;
  rejectWith?: Error;
}): IosCoordinateTapClient & { signals: Array<AbortSignal | undefined> } {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    signals,
    requestDoubleTapCoordinates: async (_x, _y, _t, _frame, signal, onDispatch) => {
      signals.push(signal);
      if (options.dispatch) {
        onDispatch?.();
      }
      if (options.rejectWith) {
        throw options.rejectWith;
      }
      return options.reply ?? { success: true };
    },
    requestTapCoordinates: async (_x, _y, _d, _t, _p, _frame, signal, onDispatch) => {
      signals.push(signal);
      if (options.dispatch) {
        onDispatch?.();
      }
      if (options.rejectWith) {
        throw options.rejectWith;
      }
      return options.reply ?? { success: true };
    },
  };
}

describe("dispatchIosCoordinateTap (#9971)", () => {
  test("a dispatched tap that timed out is indeterminate, not a plain failure", async () => {
    const client = scriptedClient({
      dispatch: true,
      reply: {
        success: false,
        error: "Tap timed out after 5000ms",
        dispatched: true,
        acknowledged: false,
      },
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(
      `${INDETERMINATE}: the request was dispatched but no result was confirmed (Tap timed out after 5000ms). Do not retry automatically.`,
    );
  });

  test("an onDispatch marker alone, with an unspecific failure reply, is indeterminate", async () => {
    const client = scriptedClient({
      dispatch: true,
      reply: { success: false, error: "Tap timed out after 5000ms" },
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(INDETERMINATE);
  });

  test("a socket close after the write is indeterminate", async () => {
    const client = scriptedClient({
      dispatch: true,
      rejectWith: new Error("WebSocket connection closed"),
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(
      `${INDETERMINATE}: the request was dispatched but no result was confirmed (WebSocket connection closed)`,
    );
  });

  test("a tap that was never sent stays a plain failure", async () => {
    const client = scriptedClient({
      dispatch: false,
      reply: { success: false, error: "Not connected", dispatched: false, acknowledged: false },
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(
      "CtrlProxy iOS tap failed: Not connected",
    );
  });

  test("a runner refusal after dispatch stays a plain failure", async () => {
    const client = scriptedClient({
      dispatch: true,
      reply: { success: false, error: "Element gone", dispatched: true, acknowledged: true },
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50, "frame")).rejects.toThrow(
      "CtrlProxy iOS tap failed: Element gone",
    );
  });

  test("an acknowledged reply with the gesture-bound code is indeterminate (#10016)", async () => {
    const client = scriptedClient({
      dispatch: true,
      reply: { ...ACKED, error: "runner said something else", errorCode: "gesture_bound_exceeded" },
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(INDETERMINATE);
  });

  test("an older runner's gesture-bound wording is indeterminate (#10016)", async () => {
    const client = scriptedClient({ dispatch: true, reply: { ...ACKED, error: STILL_EXECUTING } });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(INDETERMINATE);
  });

  test("the query-bound error stays a plain failure (#10016)", async () => {
    const client = scriptedClient({ dispatch: true, reply: { ...ACKED, error: QUERY_BOUND } });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toThrow(
      `CtrlProxy iOS tap failed: ${QUERY_BOUND}`,
    );
  });

  test("a stale-frame refusal stays plain even from a client that does not report acknowledged", async () => {
    const client = scriptedClient({
      dispatch: true,
      reply: { success: false, error: "Stale frame context for input/tap; observe again" },
    });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50, "frame")).rejects.toThrow(
      "CtrlProxy iOS tap failed: Stale frame context",
    );
  });

  test("a dispatched runner ActionableError keeps its original throw", async () => {
    const refusal = new ActionableError("runner_busy: retry shortly");
    const client = scriptedClient({ dispatch: true, rejectWith: refusal });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toBe(refusal);
  });

  test("the caller's abort reason after dispatch is not rewritten", async () => {
    const reason = new Error("cancelled");
    const controller = new AbortController();
    const client = scriptedClient({ dispatch: true, rejectWith: reason });
    controller.abort(reason);
    await expect(
      dispatchIosCoordinateTap(client, 1, 2, 50, undefined, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  test("a pre-dispatch transport throw is not reported as indeterminate", async () => {
    const failure = new Error("connect failed");
    const client = scriptedClient({ dispatch: false, rejectWith: failure });
    await expect(dispatchIosCoordinateTap(client, 1, 2, 50)).rejects.toBe(failure);
  });

  test("forwards the signal, frame context and an explicit timeout", async () => {
    const controller = new AbortController();
    const seen: unknown[][] = [];
    const client: IosCoordinateTapClient = {
      requestTapCoordinates: async (...args) => {
        seen.push(args);
        return { success: true };
      },
    };
    await dispatchIosCoordinateTap(client, 3, 4, 50, "epoch:1", {
      signal: controller.signal,
      timeoutMs: 7777,
    });
    expect(seen[0]?.slice(0, 4)).toEqual([3, 4, 50, 7777]);
    expect(seen[0]?.[5]).toBe("epoch:1");
    expect(seen[0]?.[6]).toBe(controller.signal);
    expect(typeof seen[0]?.[7]).toBe("function");
  });

  test("an unanswered atomic double tap does not claim a partial count", async () => {
    const error = await dispatchIosDoubleTap(
      scriptedClient({
        dispatch: true,
        reply: { success: false, error: "Tap timed out", dispatched: true, acknowledged: false },
      }),
      1,
      2,
    ).catch((error: unknown) => error);
    expect((error as Error).message).toContain(INDETERMINATE);
    expect((error as Error).message).not.toContain("one tap was delivered");
  });
});

describe.each([false, true])("iOS CtrlProxy tap transport (doubleTap=%s)", (doubleTap) => {
  const tap = (
    h: ReturnType<typeof createIosDelegateHarness>,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ) =>
    doubleTap
      ? new CtrlProxyGestures(h.context).requestDoubleTapCoordinates(
          1,
          2,
          50,
          undefined,
          signal,
          onDispatch,
        )
      : new CtrlProxyGestures(h.context).requestTapCoordinates(
          1,
          2,
          50,
          50,
          undefined,
          undefined,
          signal,
          onDispatch,
        );

  test("a timeout after the write is dispatched and unacknowledged", async () => {
    const h = createIosDelegateHarness();
    let dispatches = 0;
    const pending = tap(h, undefined, () => dispatches++);
    await Promise.resolve();
    h.advanceTime(50);
    expect(await pending).toMatchObject({
      success: false,
      error: "Tap timed out after 50ms",
      dispatched: true,
      acknowledged: false,
      retryable: false,
    });
    expect(dispatches).toBe(1);
    expect(h.sentMessages).toHaveLength(1);
  });

  test("a socket close after the write is dispatched and unacknowledged", async () => {
    const h = createIosDelegateHarness();
    const pending = tap(h);
    await Promise.resolve();
    h.requestManager.cancelAll(new Error("WebSocket connection closed"));
    expect(await pending).toMatchObject({
      success: false,
      error: "WebSocket connection closed",
      dispatched: true,
      acknowledged: false,
      retryable: false,
    });
  });

  test("a runner reply, even a refusal, is acknowledged and stays retryable", async () => {
    const h = createIosDelegateHarness();
    const pending = tap(h);
    await Promise.resolve();
    h.resolveLast({ success: false, totalTimeMs: 3, error: "Stale frame context" });
    const result = await pending;
    expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: true });
    expect(result.retryable).toBeUndefined();
  });

  test("not connected is a plain, undispatched failure", async () => {
    const h = createIosDelegateHarness({ connected: false });
    expect(await tap(h)).toMatchObject({
      success: false,
      error: "Not connected",
      dispatched: false,
    });
    expect(h.sentMessages).toHaveLength(0);
  });

  test("a call aborted before dispatch sends nothing", async () => {
    const h = createIosDelegateHarness();
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    await expect(tap(h, controller.signal)).rejects.toBe(reason);
    expect(h.sentMessages).toHaveLength(0);
  });

  test("the client forwards the signal and dispatch marker to the delegate", async () => {
    const h = createIosDelegateHarness();
    const forward = spyOn(CtrlProxyGestures.prototype, "requestTapCoordinates").mockResolvedValue({
      success: true,
      totalTimeMs: 1,
    });
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "tap-forward", platform: "ios", name: "iPhone" },
      8765,
      (url) => new FakeWebSocket(url, "none", 0, h.timer),
      h.timer,
    );
    const signal = new AbortController().signal;
    const onDispatch = () => {};
    try {
      await client.requestTapCoordinates(1, 2, 50, 60, undefined, "frame", signal, onDispatch);
      expect(forward).toHaveBeenCalledWith(1, 2, 50, 60, undefined, "frame", signal, onDispatch);
    } finally {
      forward.mockRestore();
    }
  });
});

describe("iOS requestAction dispatch tracking (#9971)", () => {
  const act = (h: ReturnType<typeof createIosDelegateHarness>, onDispatch: () => void) =>
    new CtrlProxyVoiceOver(h.context).requestAction(
      "activate",
      "com.app:id/go",
      undefined,
      50,
      undefined,
      { onDispatch },
    );

  test("a timeout after the write is dispatched, unacknowledged and not retryable", async () => {
    const h = createIosDelegateHarness();
    let dispatches = 0;
    const pending = act(h, () => dispatches++);
    await Promise.resolve();
    h.advanceTime(50);
    expect(await pending).toMatchObject({
      success: false,
      error: "Timeout waiting for action_result",
      dispatched: true,
      acknowledged: false,
      retryable: false,
    });
    expect(dispatches).toBe(1);
  });

  test("a reply is acknowledged", async () => {
    const h = createIosDelegateHarness();
    const pending = act(h, () => {});
    await Promise.resolve();
    h.resolveLast({ success: false, error: "Element not found" });
    const result = await pending;
    expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: true });
    expect(result.retryable).toBeUndefined();
  });

  test("a socket close after the write still rejects, with the marker already fired", async () => {
    const h = createIosDelegateHarness();
    let dispatches = 0;
    const pending = act(h, () => dispatches++);
    await Promise.resolve();
    h.requestManager.cancelAll(new Error("WebSocket connection closed"));
    await expect(pending).rejects.toThrow("WebSocket connection closed");
    expect(dispatches).toBe(1);
  });

  test("not connected carries no dispatch metadata", async () => {
    const h = createIosDelegateHarness({ connected: false });
    const result = await act(h, () => {});
    expect(result).toEqual({ success: false, error: "Not connected to CtrlProxy" });
  });
});

const IOS_DEVICE: BootedDevice = {
  deviceId: "ios-9971-device",
  platform: "ios",
  name: "iPhone",
} as BootedDevice;

describe("tapAt on iOS (#9971)", () => {
  function createIosTapAt(client: IosCoordinateTapClient) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observe = new FakeObserveScreen();
    observe.setObserveResult({
      ...observation(100, 200, "epoch:1"),
      display: { key: "0", role: "unknown", generation: 0 },
    });
    const unusedAndroid = { requestTapCoordinates: async () => ({ success: true }) };
    const tapAt = new TapAtCoordinate(IOS_DEVICE, new FakeAdbExecutor(), {
      timer,
      androidClient: unusedAndroid,
      iosClient: client,
      invalidateIosCache: () => {},
      lastRenderedObservation: () => ({ display: { key: "0" }, displayRevision: 0 }),
    });
    setFakeTapAtWindow(tapAt);
    tapAt.observeScreen = observe;
    return tapAt;
  }

  test.each([undefined, "active"])(
    "atomic double tap on display %s sends once without a gap",
    async (display) => {
      const client = new FakeIOSCtrlProxy();
      const single = spyOn(client, "requestTapCoordinates");
      const double = spyOn(client, "requestDoubleTapCoordinates");
      const tapAt = createIosTapAt(client);
      const timer = tapAt["timer"] as FakeTimer;
      const controller = new AbortController();
      const result = await tapAt.execute(
        { x: 10, y: 20, action: "doubleTap", display },
        { signal: controller.signal },
      );
      expect(result.success).toBe(true);
      expect(double).toHaveBeenCalledTimes(1);
      expect(single).toHaveBeenCalledTimes(0);
      expect(double).toHaveBeenCalledWith(
        10,
        20,
        undefined,
        "epoch:1",
        controller.signal,
        expect.any(Function),
      );
      // Explicit-display settling may sleep after delivery; there is no double-tap gap.
      expect(timer.getSleepHistory()).not.toContain(200);
    },
  );

  test.each([undefined, "active"])(
    "confirmed atomic double tap counts both taps before late cancellation on display %s",
    async (display) => {
      const client = new FakeIOSCtrlProxy();
      const controller = new AbortController();
      spyOn(client, "requestDoubleTapCoordinates").mockImplementation(async () => {
        controller.abort();
        return { success: true, totalTimeMs: 1 };
      });
      const tapAt = createIosTapAt(client);
      const result = await tapAt.execute(
        { x: 10, y: 20, action: "doubleTap", display },
        { signal: controller.signal },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("cancel");
      expect(result.error).not.toContain("one tap was delivered");
    },
  );

  afterEach(() => {
    displayTransitions.reset(IOS_DEVICE.deviceId);
  });

  test("an unconfirmed tap is reported as indeterminate", async () => {
    const tapAt = createIosTapAt(
      scriptedClient({
        dispatch: true,
        reply: {
          success: false,
          error: "Tap timed out after 5000ms",
          dispatched: true,
          acknowledged: false,
        },
      }),
    );
    const result = await tapAt.execute({ x: 10, y: 20 });
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`Failed to tap at coordinates: ${INDETERMINATE}`);
    expect(result.error).toContain("Do not retry automatically");
  });

  test("tapAt reports a gesture still executing past the bound as indeterminate (#10016)", async () => {
    for (const reply of [
      { ...ACKED, error: "x", errorCode: "gesture_bound_exceeded" },
      { ...ACKED, error: STILL_EXECUTING },
    ]) {
      const result = await createIosTapAt(scriptedClient({ dispatch: true, reply })).execute({
        x: 10,
        y: 20,
      });
      expect(result.error).toStartWith(`Failed to tap at coordinates: ${INDETERMINATE}`);
      expect(result.error).toContain("Do not retry automatically");
    }
  });

  test("tapAt keeps the query-bound error a plain failure (#10016)", async () => {
    const tapAt = createIosTapAt(
      scriptedClient({ dispatch: true, reply: { ...ACKED, error: QUERY_BOUND } }),
    );
    const result = await tapAt.execute({ x: 10, y: 20 });
    expect(result.error).toBe(
      `Failed to tap at coordinates: CtrlProxy iOS tap failed: ${QUERY_BOUND}`,
    );
  });

  test("a runner refusal is a plain failure", async () => {
    const tapAt = createIosTapAt(
      scriptedClient({
        dispatch: true,
        reply: { success: false, error: "Element gone", dispatched: true, acknowledged: true },
      }),
    );
    const result = await tapAt.execute({ x: 10, y: 20 });
    expect(result.error).toBe(
      "Failed to tap at coordinates: CtrlProxy iOS tap failed: Element gone",
    );
  });

  test("the request's signal reaches the atomic double tap", async () => {
    const client = scriptedClient({ dispatch: true });
    const tapAt = createIosTapAt(client);
    const controller = new AbortController();
    const result = await tapAt.execute(
      { x: 10, y: 20, action: "doubleTap" },
      { signal: controller.signal },
    );
    expect(result.success).toBe(true);
    expect(client.signals).toEqual([controller.signal]);
  });

  test("an unconfirmed atomic double tap makes no partial delivery claim", async () => {
    const client = scriptedClient({
      dispatch: true,
      reply: {
        success: false,
        error: "Tap timed out",
        dispatched: true,
        acknowledged: false,
      },
    });
    const result = await createIosTapAt(client).execute({ x: 10, y: 20, action: "doubleTap" });
    expect(result.success).toBe(false);
    expect(result.error).toContain(INDETERMINATE);
    expect(result.error).not.toContain("one tap was delivered");
  });
});

describe("tapOn on iOS (#9971)", () => {
  afterEach(() => {
    displayTransitions.reset(IOS_DEVICE.deviceId);
    resetObserveCacheStore();
  });

  function createTapOn(client: FakeIOSCtrlProxy) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const tapOn = new TapOnElement(IOS_DEVICE, new FakeAdbClient(), {
      timer,
      tapStrategy: new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    });
    tapOn.window = new FakeWindow();
    tapOn.awaitIdle = new FakeAwaitIdle();
    return { tapOn, instance };
  }

  const point = { x: 50, y: 60 };

  test("passes its signal to the coordinate tap", async () => {
    const client = new FakeIOSCtrlProxy();
    const { tapOn, instance } = createTapOn(client);
    const tap = spyOn(client, "requestTapCoordinates");
    const controller = new AbortController();
    try {
      await tapOn["executeiOSTapWithCoordinates"]("tap", point.x, point.y, 1000, {
        signal: controller.signal,
      });
      expect(tap.mock.calls[0]?.[6]).toBe(controller.signal);
    } finally {
      instance.mockRestore();
    }
  });

  test("a dispatched, unconfirmed tap is indeterminate", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setTapResult({
      success: false,
      totalTimeMs: 5000,
      error: "Tap timed out after 5000ms",
      dispatched: true,
      acknowledged: false,
    });
    const { tapOn, instance } = createTapOn(client);
    try {
      await expect(
        tapOn["executeiOSTapWithCoordinates"]("tap", point.x, point.y, 1000),
      ).rejects.toThrow(INDETERMINATE);
    } finally {
      instance.mockRestore();
    }
  });

  test("tapOn reports a gesture still executing past the bound as indeterminate (#10016)", async () => {
    for (const reply of [
      { error: "x", errorCode: "gesture_bound_exceeded" },
      { error: STILL_EXECUTING },
    ]) {
      const client = new FakeIOSCtrlProxy();
      client.setTapResult({ ...ACKED, totalTimeMs: 4500, ...reply });
      const { tapOn, instance } = createTapOn(client);
      try {
        await expect(
          tapOn["executeiOSTapWithCoordinates"]("tap", point.x, point.y, 1000),
        ).rejects.toThrow(INDETERMINATE);
      } finally {
        instance.mockRestore();
      }
    }
  });

  test("tapOn keeps the query-bound error a plain failure (#10016)", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setTapResult({ ...ACKED, totalTimeMs: 100, error: QUERY_BOUND });
    const { tapOn, instance } = createTapOn(client);
    try {
      await expect(
        tapOn["executeiOSTapWithCoordinates"]("tap", point.x, point.y, 1000),
      ).rejects.toThrow(`CtrlProxy iOS tap failed: ${QUERY_BOUND}`);
    } finally {
      instance.mockRestore();
    }
  });

  test("an unanswered double tap has an indeterminate outcome without a partial count", async () => {
    const client = new FakeIOSCtrlProxy();
    const { tapOn, instance } = createTapOn(client);
    client.setTapResult({
      success: false,
      totalTimeMs: 5000,
      error: "Tap timed out",
      dispatched: true,
      acknowledged: false,
    });
    try {
      await expect(
        tapOn["executeiOSTapWithCoordinates"]("doubleTap", point.x, point.y, 1000),
      ).rejects.toThrow(INDETERMINATE);
      expect(client.doubleTapHistory).toEqual([point]);
      expect(client.getTapHistory()).toEqual([]);
    } finally {
      instance.mockRestore();
    }
  });
});
