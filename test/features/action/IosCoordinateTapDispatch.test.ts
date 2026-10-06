import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  dispatchIosCoordinateTap,
  withPartialIosDoubleTapNote,
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

/** A client whose request marks dispatch (when asked to) and then settles as scripted. */
function scriptedClient(options: {
  dispatch: boolean;
  reply?: TapReply;
  rejectWith?: Error;
}): IosCoordinateTapClient & { signals: Array<AbortSignal | undefined> } {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    signals,
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

  test("a partially applied double tap keeps the one-tap-delivered note only when unconfirmed", async () => {
    const unconfirmed = await dispatchIosCoordinateTap(
      scriptedClient({
        dispatch: true,
        reply: { success: false, error: "Tap timed out", dispatched: true, acknowledged: false },
      }),
      1,
      2,
      50,
    ).catch((error: unknown) => withPartialIosDoubleTapNote(error));
    expect((unconfirmed as Error).message).toContain(INDETERMINATE);
    expect((unconfirmed as Error).message).toContain(
      "Double tap partially applied: one tap was delivered; the second tap was not confirmed.",
    );
    const plain = new ActionableError("CtrlProxy iOS second tap failed: Element gone");
    expect(withPartialIosDoubleTapNote(plain)).toBe(plain);
  });
});

describe("iOS CtrlProxy tap transport (#9971)", () => {
  const tap = (
    h: ReturnType<typeof createIosDelegateHarness>,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ) =>
    new CtrlProxyGestures(h.context).requestTapCoordinates(
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
    observe.setObserveResult(observation(100, 200, "epoch:1"));
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

  test("the request's signal reaches the first and the second tap", async () => {
    const client = scriptedClient({ dispatch: true });
    const tapAt = createIosTapAt(client);
    const controller = new AbortController();
    const result = await tapAt.execute(
      { x: 10, y: 20, action: "doubleTap" },
      undefined,
      controller.signal,
    );
    expect(result.success).toBe(true);
    expect(client.signals).toEqual([controller.signal, controller.signal]);
  });

  test("an unconfirmed second tap keeps the one-tap-delivered note", async () => {
    let calls = 0;
    const client: IosCoordinateTapClient = {
      requestTapCoordinates: async (_x, _y, _d, _t, _p, _frame, _signal, onDispatch) => {
        onDispatch?.();
        calls++;
        return calls === 1
          ? { success: true }
          : { success: false, error: "Tap timed out", dispatched: true, acknowledged: false };
      },
    };
    const result = await createIosTapAt(client).execute({ x: 10, y: 20, action: "doubleTap" });
    expect(result.success).toBe(false);
    expect(result.error).toContain(INDETERMINATE);
    expect(result.error).toContain("one tap was delivered");
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

  test("an unconfirmed second tap of a double tap notes that one tap was delivered", async () => {
    const client = new FakeIOSCtrlProxy();
    const { tapOn, instance } = createTapOn(client);
    let calls = 0;
    spyOn(client, "requestTapCoordinates").mockImplementation(async () => {
      calls++;
      return calls === 1
        ? { success: true, totalTimeMs: 1 }
        : {
            success: false,
            totalTimeMs: 5000,
            error: "Tap timed out after 5000ms",
            dispatched: true,
            acknowledged: false,
          };
    });
    try {
      await expect(
        tapOn["executeiOSTapWithCoordinates"]("doubleTap", point.x, point.y, 1000),
      ).rejects.toThrow("Double tap partially applied: one tap was delivered");
    } finally {
      instance.mockRestore();
    }
  });
});
